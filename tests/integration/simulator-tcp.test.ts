import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { ConnectionRuntime } from '../../src/main/runtime/connection-runtime';
import { BlockCache, blockKey } from '../../src/main/runtime/block-cache';
import { DiagnosticsStore } from '../../src/main/runtime/diagnostics';
import { TcpTransport } from '../../src/main/runtime/transport';
import { decodeRaw } from '../../src/domain/mapping';
import type { BlockDef, ConnectionDef, SlaveDef } from '../../src/domain/model';

const PORT = 50505;

function waitForPort(port: number, ms = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > ms) reject(new Error('simulator port never opened'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

describe('interop with the standalone PyModbus simulator', () => {
  it('polls live values, writes with read-back and performs a temporary read', async () => {
    const sim: ChildProcess = spawn('python', [path.join(__dirname, '..', '..', 'tools', 'simulator', 'modbus_sim.py'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let startupError = '';
    sim.stderr?.on('data', (chunk) => { startupError += String(chunk); });
    try {
      await waitForPort(PORT).catch((error: unknown) => {
        throw new Error(`${String(error)}; simulator exit=${sim.exitCode ?? 'running'}; stderr=${startupError.slice(-1000)}`);
      });
      const cache = new BlockCache();
      const diag = new DiagnosticsStore();
      const config: ConnectionDef = {
        id: 'sim',
        name: 'SIM',
        transport: 'tcp',
        tcp: { host: '127.0.0.1', port: PORT },
        timeoutMs: 800,
        retries: 1,
        reconnect: 'manual',
        interFrameMs: 0,
        rtsControl: 'none',
        logLevel: 'info',
      };
      const block: BlockDef = { id: 'hb', name: 'holding', area: 3, start: 0, length: 12, periodMs: 100 };
      const slave: SlaveDef = { id: 's1', connectionId: 'sim', unitId: 1, name: 'sim-slave', templateId: 't', enabled: true };
      const runtime = new ConnectionRuntime({ config, transport: new TcpTransport(config.tcp as { host: string; port: number }), cache, diagnostics: diag, hooks: { onChange: () => undefined, onState: () => undefined } });
      runtime.configure([{ slave, block }]);
      await runtime.start();

      const key = blockKey('s1', 'hb');
      const floatMapping = { rawType: 'Float32', offset: 0, registerCount: 2, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' } as const;
      const start = Date.now();
      let volts = 0;
      while (Date.now() - start < 10000) {
        const memory = cache.get(key)?.memory;
        if (memory?.kind === 'registers') volts = Number(decodeRaw(memory, floatMapping));
        if (cache.get(key)?.status === 'ok' && volts > 40 && volts < 56) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cache.get(key)?.status).toBe('ok');
      expect(volts).toBeGreaterThan(40);
      expect(volts).toBeLessThan(56);

      // write target speed (holding 6, Int16) and confirm via read-back
      const res = await runtime.writePoint({
        slave,
        block,
        mapping: { rawType: 'Int16', offset: 6, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' },
        rawValue: 1800,
        pointId: 'speed',
        readBackRange: { start: 0, length: 12 },
      });
      expect(res.result).toBe('ok');
      const after = cache.get(key)?.memory;
      if (after?.kind === 'registers') expect(after.registers[6]).toBe(1800);

      // temporary read of input registers
      const tmp = await runtime.temporaryRead(1, 4, 0, 4);
      expect(tmp.result).toBe('ok');
      if (tmp.response?.kind === 'registers') expect(tmp.response.registers.length).toBe(4);

      // scanner sees the simulated units
      const found = await runtime.scanUnits({ from: 1, to: 3 }, { timeoutMs: 300 });
      expect(found.map((f) => f.unitId).sort()).toEqual([1, 2, 3]);
      for (const fc of [1, 2, 3, 4] as const) {
        const configured = await runtime.scanUnits({ from: 1, to: 1 }, { fc, start: 5, timeoutMs: 300, retries: 0 });
        expect(configured.map(row => row.unitId)).toEqual([1]);
        expect(configured[0]?.exceptionCode).toBeNull();
      }

      expect(diag.recentTransactions(50).length).toBeGreaterThan(3);
      await runtime.stop();
    } finally {
      sim.kill();
    }
  }, 30000);
});
