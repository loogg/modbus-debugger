import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { TcpTransport, SerialTransport } from '../../src/main/runtime/transport';
import { BlockCache } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import type { ConnectionDef } from '../../src/domain/model';
import type { ModbusRequest } from '../../src/domain/protocol';
import { decodeRaw } from '../../src/domain/mapping';

const masterPort = process.env.MODBUS_RTU_MASTER_PORT;
const slavePort = process.env.MODBUS_RTU_SLAVE_PORT;
async function availableTcpPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('TCP port probe returned no port');
  return address.port;
}
async function harness(transport: 'tcp' | 'rtu', extra: string[] = [], dynamic = false) {
  const port = transport === 'tcp' ? await availableTcpPort() : 5020;
  const server = spawn('python', [path.resolve('tools/simulator/modbus_sim.py'), '--transport', transport, ...(dynamic ? [] : ['--static']), '--trace', '--units', '1,3',
    ...(transport === 'tcp' ? ['--port', String(port)] : ['--serial-port', slavePort!]), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Simulator did not start: ${output}`)), 15000);
    server.stdout.on('data', chunk => { output += String(chunk); if (output.includes('"event": "ready"')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-10000); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Simulator exited ${code}: ${output}`)); });
  }).catch(error => { server.kill(); throw error; });
  const config: ConnectionDef = { id: 'wire', name: transport, transport, timeoutMs: 150, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
    tcp: { host: '127.0.0.1', port }, rtu: { port: masterPort ?? '', baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 } };
  const diagnostics = new DiagnosticsStore();
  const cache = new BlockCache();
  const runtime = new ConnectionRuntime({ config, diagnostics, cache, transport: transport === 'tcp' ? new TcpTransport(config.tcp!) : new SerialTransport(config.rtu!), hooks: { onState: () => undefined, onChange: () => undefined } });
  await runtime.start();
  const request = (req: ModbusRequest, unit = 1) => runtime.executeRequest(unit, req, { sourceKind: 'temporary-read', sourceId: null });
  const close = async () => { await runtime.stop(); server.kill(); await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); };
  return { runtime, request, cache, diagnostics, close, output: () => output };
}

for (const transport of ['tcp', 'rtu'] as const) {
  describe.skipIf(transport === 'rtu' && (!masterPort || !slavePort))(`${transport.toUpperCase()} independent slave, real wire transport`, () => {
    it('supports all eight project function codes, maximum quantities, unit isolation and missing/invalid addresses', async () => {
      const h = await harness(transport);
      try {
        expect(h.runtime.state).toBe('online');
        for (const fc of [1, 2, 3, 4] as const) {
          const result = await h.request({ kind: 'read', fc, address: 0, quantity: fc <= 2 ? 2000 : 125 });
          expect(result.result, `FC${fc}`).toBe('ok');
        }
        expect((await h.request({ kind: 'writeCoil', fc: 5, address: 10, value: true })).result).toBe('ok');
        let read = await h.request({ kind: 'read', fc: 1, address: 10, quantity: 1 });
        expect(read.response?.kind === 'bits' && read.response.bits[0]).toBe(true);
        const values = Array.from({ length: 1968 }, (_, i) => i % 3 === 0);
        expect((await h.request({ kind: 'writeCoils', fc: 15, address: 0, values })).result).toBe('ok');
        read = await h.request({ kind: 'read', fc: 1, address: 0, quantity: values.length });
        expect(read.response?.kind === 'bits' && read.response.bits.slice(0, values.length)).toEqual(values);
        expect((await h.request({ kind: 'writeRegister', fc: 6, address: 6, value: 0 })).result).toBe('ok');
        read = await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 });
        expect(read.response?.kind === 'registers' && read.response.registers).toEqual([0]);
        const registers = Array.from({ length: 123 }, (_, i) => i * 17);
        expect((await h.request({ kind: 'writeRegisters', fc: 16, address: 0, values: registers })).result).toBe('ok');
        read = await h.request({ kind: 'read', fc: 3, address: 0, quantity: 123 });
        expect(read.response?.kind === 'registers' && read.response.registers).toEqual(registers);
        read = await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 }, 3);
        expect(read.response?.kind === 'registers' && read.response.registers).toEqual([1500]);
        expect((await h.request({ kind: 'read', fc: 3, address: 128, quantity: 1 })).exceptionCode).toBe(2);
        expect((await h.request({ kind: 'read', fc: 3, address: 0, quantity: 1 }, 2)).result).toBe('timeout');
        expect((await h.runtime.scanUnits({ from: 1, to: 3 }, { timeoutMs: 150, retries: 0 })).map(row => row.unitId)).toEqual([1, 3]);
        const temporary = await h.runtime.temporaryRead(1, 4, 0, 4);
        expect(temporary.response?.kind === 'registers' && temporary.response.registers).toHaveLength(4);
        expect(h.diagnostics.recentTransactions(20).some(tx => tx.sourceKind === 'temporary-read')).toBe(true);
      } finally { await h.close(); }
    }, 30000);

    it('recovers after one corrupt response and records the framing failure', async () => {
      const h = await harness(transport, ['--fault', transport === 'rtu' ? 'bad-crc' : 'malformed', '--fault-count', '1']);
      try {
        const first = await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 });
        expect(first.result).not.toBe('ok');
        const next = await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 });
        expect(next.response?.kind === 'registers' && next.response.registers, JSON.stringify({ first, next, trace: h.output() })).toEqual([1500]);
      } finally { await h.close(); }
    });
    it('supports delayed responses within the configured timeout', async () => {
      const h = await harness(transport, ['--fault', 'delay', '--delay-ms', '40', '--fault-count', '1']);
      try {
        const before = performance.now();
        expect((await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 })).result).toBe('ok');
        expect(performance.now() - before, h.output()).toBeGreaterThanOrEqual(35);
      } finally { await h.close(); }
    });

    it('injects a write exception without modifying the register', async () => {
      const h = await harness(transport, ['--fault', 'exception', '--fault-fc', '6', '--exception-code', '2']);
      try {
        expect((await h.request({ kind: 'writeRegister', fc: 6, address: 6, value: 99 })).exceptionCode).toBe(2);
        const read = await h.request({ kind: 'read', fc: 3, address: 6, quantity: 1 });
        expect(read.response?.kind === 'registers' && read.response.registers).toEqual([1500]);
      } finally { await h.close(); }
    });
    it('can apply a write but drop its response, exposing the true value on read-back', async () => {
      const h = await harness(transport, ['--fault', 'timeout', '--fault-fc', '6', '--fault-count', '1']);
      try {
        expect((await h.request({ kind: 'writeRegister', fc: 6, address: 6, value: 99 })).result).toBe('timeout');
        const read = await h.runtime.temporaryRead(1, 3, 6, 1);
        expect(read.response?.kind === 'registers' && read.response.registers).toEqual([99]);
      } finally { await h.close(); }
    });

    it('reads seeded Enum and String values, then performs latest-register RMW and String write/read-back', async () => {
      const h = await harness(transport);
      try {
        const block = { id: 'holding', name: 'Holding', area: 3 as const, start: 0, length: 12, periodMs: 1000 };
        const slave = { id: 'unit-1', connectionId: 'wire', unitId: 1, name: 'Unit 1', templateId: 'template', enabled: true };
        h.cache.ensure(slave, block); // starts at zero; RMW must read the simulator's actual 0x0011.
        const common = { wordOrder: 'ABCD' as const, byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16,
          stringLength: 0, stringEncoding: 'ascii' as const };
        const control = await h.request({ kind: 'read', fc: 3, address: 4, quantity: 1 });
        expect(control.response?.kind === 'registers' && control.response.registers).toEqual([0x0011]);
        const enumMapping = { ...common, rawType: 'BitField' as const, offset: 4, registerCount: 1, bitOffset: 4, bitWidth: 3 };
        expect(decodeRaw({ kind: 'registers', registers: Uint16Array.from([0, 0, 0, 0, 0x0011]) }, enumMapping)).toBe(1);
        const seededString = await h.request({ kind: 'read', fc: 3, address: 8, quantity: 4 });
        expect(seededString.response?.kind).toBe('registers');
        if (seededString.response?.kind !== 'registers') throw new Error('missing seeded string registers');
        const stringMapping = { ...common, rawType: 'String' as const, offset: 8, registerCount: 4, stringLength: 8 };
        const seededMemory = new Uint16Array(12);
        seededMemory.set(seededString.response.registers, 8);
        expect(decodeRaw({ kind: 'registers', registers: seededMemory }, stringMapping)).toBe('V2.4.0');

        const enumWrite = await h.runtime.writePoint({ slave, block, mapping: enumMapping, rawValue: 3, pointId: 'mode', readBackRange: { start: 0, length: 12 } });
        expect(enumWrite.result).toBe('ok');
        expect(enumWrite.readBack?.result).toBe('ok');
        const afterEnum = h.cache.get('unit-1::holding')?.memory;
        expect(afterEnum?.kind === 'registers' && afterEnum.registers[4]).toBe(0x0031); // enable bit 0 preserved.
        expect(afterEnum && decodeRaw(afterEnum, enumMapping)).toBe(3);
        expect(h.diagnostics.recentTransactions(20).filter(tx => tx.sourceId === 'mode').map(tx => tx.sourceKind)).toEqual(['rmw-read', 'write', 'readback']);

        const stringWrite = await h.runtime.writePoint({ slave, block, mapping: stringMapping, rawValue: 'V3.1.0', pointId: 'firmware', readBackRange: { start: 0, length: 12 } });
        expect(stringWrite.result).toBe('ok');
        const afterString = h.cache.get('unit-1::holding')?.memory;
        expect(afterString && decodeRaw(afterString, stringMapping)).toBe('V3.1.0');
        expect(h.diagnostics.recentTransactions(20).filter(tx => tx.sourceId === 'firmware').map(tx => tx.sourceKind)).toEqual(['rmw-read', 'write', 'readback']);
      } finally { await h.close(); }
    }, 30000);

    it('observes changing Float32 telemetry and a Bool edge from the independent dynamic simulator', async () => {
      const h = await harness(transport, [], true);
      try {
        const volts = { rawType: 'Float32' as const, offset: 0, registerCount: 2, wordOrder: 'ABCD' as const,
          byteSelector: 'low' as const, bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' as const };
        const numeric = new Set<string>();
        const bool = new Set<boolean>();
        const deadline = Date.now() + 3200;
        while (Date.now() < deadline && (numeric.size < 2 || bool.size < 2)) {
          const holding = await h.runtime.temporaryRead(1, 3, 0, 2);
          const discrete = await h.runtime.temporaryRead(1, 2, 0, 1);
          if (holding.response?.kind === 'registers') numeric.add(Number(decodeRaw({ kind: 'registers', registers: Uint16Array.from(holding.response.registers) }, volts)).toFixed(3));
          if (discrete.response?.kind === 'bits') bool.add(discrete.response.bits[0] === true);
          if (numeric.size < 2 || bool.size < 2) await new Promise(resolve => setTimeout(resolve, 150));
        }
        expect(numeric.size, `Float32 values: ${[...numeric].join(', ')}`).toBeGreaterThan(1);
        expect(bool).toEqual(new Set([true, false]));
      } finally { await h.close(); }
    }, 30000);
  });
}
