import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import type { Workspace } from '../../src/domain/model';
import { TcpStreamingFramer } from '../../src/domain/protocol';
import type { Command } from '../../src/shared/commands';
import type { BufferExportResult, DataReadResult } from '../../src/shared/point-data';
import type { ModbusApi } from '../../src/shared/preload-api';
import type { ScriptRunView } from '../../src/shared/script-run';

const example = path.resolve('docs/examples/pressure-bench.workspace.json');
const evidence = path.resolve('out/test-temp/pressure-bench-evidence');
const master = 'bench-master', field = 'bench-field';
const refs = [{ slaveId: 'pump', pointId: 'sp' }, { slaveId: 'sensor', pointId: 'pv' }];
const scope = () => $('.workbench-view:not([style*="display: none"])');
const widget = (id: string) => scope().$(`[data-widget-id="${id}"]`);
const rail = (name: string) => $(`//nav//button[normalize-space(.)="${name}"]`).click();
const snapshot = () => browser.execute(() => (window as unknown as { modbus: ModbusApi }).modbus.getSnapshot());
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2));
const shot = (name: string) => browser.saveScreenshot(path.join(evidence, name + '.png'));

async function command<T = unknown>(cmd: Command): Promise<T> {
  const result = await browser.execute(raw => (window as unknown as { modbus: ModbusApi }).modbus.command(raw), cmd);
  if (!result.ok) throw new Error(`${cmd.type}: ${result.error}`);
  return result.value as T;
}

async function servicePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function openBench(transport: 'tcp' | 'rtu', port = 0, masterPort = port) {
  const ws = JSON.parse(fs.readFileSync(example, 'utf8')) as Workspace;
  for (const conn of ws.connections) {
    conn.transport = transport;
    if (transport === 'tcp') conn.tcp!.port = conn.id === master ? masterPort : port;
    else {
      delete conn.tcp;
      conn.rtu = { port: conn.id === master ? 'COM1' : 'COM2', baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 };
    }
  }
  const file = path.join(process.env.MODBUS_TEST_RUN_DIR!, 'pressure-' + transport + '.workspace.json');
  fs.writeFileSync(file, JSON.stringify(ws));
  await command({ type: 'workspace.open', path: file });
  await command({ type: 'connection.connect', connectionId: field });
  await command({ type: 'connection.connect', connectionId: master });
  await browser.waitUntil(async () => {
    const state = await snapshot();
    return state.slaveStates?.pump?.state === 'online' && state.slaveStates?.sensor?.state === 'online' && state.points['pump::sp']?.engNumber === 0.3;
  }, { timeout: 12000, timeoutMsg: 'Waiting for both devices and the initial 0.30 MPa setpoint' });
  return file;
}

// A separate PyModbus connection observes the passive service without using its cache or script results.
function independent(port: number, includeSensor = true): { pump: boolean; alarm: boolean; sp: number; pv: number | null } {
  const source = [
    'import sys, json', 'from pymodbus.client import ModbusTcpClient',
    'with ModbusTcpClient("127.0.0.1", port=int(sys.argv[1]), timeout=1, retries=0) as c:',
    '    bits=c.read_coils(0,count=2,device_id=1).bits',
    '    sp=c.read_holding_registers(0,count=1,device_id=1).registers[0]',
    '    pv=c.read_holding_registers(100,count=1,device_id=2).registers[0] if sys.argv[2]=="1" else None',
    '    print(json.dumps(dict(pump=bits[0],alarm=bits[1],sp=sp,pv=pv)))',
  ].join('\n');
  return JSON.parse(execFileSync('python', ['-c', source, String(port), includeSensor ? '1' : '0'], { encoding: 'utf8', timeout: 6000 }));
}

async function setPressure(port?: number) {
  await rail('组态画布');
  const input = widget('setpoint-input').$('input');
  await input.setValue('0.36');
  const staged = await snapshot();
  expect(staged.points['pump::sp']?.engNumber).toBe(0.3);
  expect(staged.points['pump-field::sp']?.engNumber).toBe(0.3);
  if (port) expect(independent(port).sp).toBe(30);
  await widget('setpoint-input').$('button=写入').click();
  await browser.waitUntil(async () => (await snapshot()).points['pump::sp']?.engNumber === 0.36);
  await expect(widget('setpoint-input')).toHaveText(expect.stringContaining('0.36'));
  if (port) expect(independent(port).sp).toBe(36);
  const state = await snapshot();
  const req = state.transactions.find(tx => tx.connectionId === master && tx.sourceKind === 'write' && tx.requestPduHex === '0600000024');
  expect(req).toMatchObject({ result: 'ok', unitId: 1, responsePduHex: '0600000024' });
  expect(state.transactions.some(tx => tx.connectionId === field && tx.requestAduHex === req!.requestAduHex && tx.responseAduHex === req!.responseAduHex)).toBe(true);
  return req!;
}

async function startFlow(debug = false) {
  await rail('主站脚本');
  await scope().$('button=升压、达标与卸压').click();
  await scope().$('.blocklyWorkspace').waitForDisplayed();
  const previous = (await snapshot()).scriptRun?.id;
  await scope().$(debug ? 'button=调试' : 'button=运行').click();
  await browser.waitUntil(async () => {
    const run = (await snapshot()).scriptRun;
    return run?.scriptId === 'hydrotest' && run.id !== previous;
  });
  return (await snapshot()).scriptRun!.id;
}

async function completed(id: string, state: 'passed' | 'stopped') {
  await browser.waitUntil(async () => {
    const run = (await snapshot()).scriptRun;
    return run?.id === id && !['running', 'pausing', 'paused', 'stopping'].includes(run.state);
  }, { timeout: 18000, timeoutMsg: 'Pressure cycle did not settle' });
  const run = (await snapshot()).scriptRun!;
  expect({ state: run.state, detail: run.detail }).toMatchObject({ state });
  return run;
}

async function checkCycle(run: ScriptRunView, transport: string, startWrite: unknown) {
  const rows = run.entries.filter(row => row.log).map(row => row.detail);
  expect(rows).toEqual(['开始升压，目标 MPa 0.36', '压力达标 MPa 0.36', '卸压完成 MPa 0']);
  expect(run.entries.some(row => row.result === 'failed')).toBe(false);
  const startMs = run.startedAtMs - 250, endMs = run.finishedAtMs!;
  const data = await command<DataReadResult>({ type: 'data.read', points: refs, blocks: [], buffers: refs,
    series: refs.map(ref => ({ ...ref, startMs, endMs, limit: 2000 })) });
  const samples = data.series['sensor::pv']!.samples;
  const curve = samples.map(item => Number(item.value));
  const peak = curve.indexOf(0.36);
  expect(peak).toBeGreaterThan(1);
  expect(curve.slice(0, peak).some(n => n > 0 && n < 0.36)).toBe(true);
  expect(curve.slice(peak + 1).some(n => n > 0 && n < 0.36)).toBe(true);
  expect(curve.at(-1)).toBe(0);
  expect(samples.every((sample, i) => i === 0 || sample.seq > samples[i - 1]!.seq)).toBe(true);
  const output = path.join(evidence, transport + '-samples.csv');
  const csv = await command<BufferExportResult>({ type: 'buffer.export', points: refs, path: output, startMs, endMs });
  const decoded: { count: number; values: number[] } = JSON.parse(execFileSync('python', ['-c', [
    'import csv,json,sys',
    'with open(sys.argv[1],encoding="utf-8-sig",newline="") as f: rows=list(csv.reader(f))[1:]',
    'print(json.dumps(dict(count=len(rows),values=[float(row[10]) for row in rows if row[4]=="pv"])))',
  ].join('\n'), output], { encoding: 'utf8' }));
  expect(decoded.values).toEqual(curve);
  expect(csv.count).toBe(decoded.count);
  const state = await snapshot();
  const writes = state.transactions.filter(tx => tx.connectionId === master && tx.sourceKind === 'write' && Date.parse(tx.startUtc) >= run.startedAtMs);
  expect(writes.map(tx => tx.requestPduHex)).toEqual(['050000ff00', '0500000000']);
  for (const tx of writes) {
    expect(tx.responsePduHex).toBe(tx.requestPduHex);
    expect(state.transactions.some(peer => peer.connectionId === field && peer.requestAduHex === tx.requestAduHex && peer.responseAduHex === tx.responseAduHex)).toBe(true);
  }
  save(transport + '-normal', { run, startWrite, writes, curve, exportedRows: csv.count, samples: samples.length });
}

async function setSensorEnabled(enabled: boolean) {
  const slave = (await snapshot()).workspace.slaves.find(item => item.id === 'sensor-field')!;
  await command({ type: 'slave.upsert', slave: { ...slave, enabled }, expected: slave });
}

// Keep both production endpoints untouched while cutting only the transmitter's return path.
async function sensorFaultLink(fieldPort: number) {
  const sockets = new Set<net.Socket>();
  const link = { dropSensor: false, discarded: 0, connections: 0 };
  const server = net.createServer(masterSocket => {
    link.connections++;
    const fieldSocket = net.connect(fieldPort, '127.0.0.1');
    const framer = new TcpStreamingFramer();
    const close = () => { masterSocket.destroy(); fieldSocket.destroy(); };
    for (const socket of [masterSocket, fieldSocket]) {
      sockets.add(socket);
      socket.once('error', close);
      socket.once('close', () => { sockets.delete(socket); close(); });
    }
    masterSocket.pipe(fieldSocket);
    fieldSocket.on('data', bytes => {
      for (const frame of framer.push(bytes)) {
        if (frame.type !== 'adu') { close(); return; }
        if (link.dropSensor && frame.bytes[6] === 2) link.discarded++;
        else masterSocket.write(frame.bytes);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { link, port: (server.address() as net.AddressInfo).port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

describe('Pressure bench across the packaged HMI, native slave, canvas and Blockly', () => {
  let plant: ChildProcess | undefined;
  let plantPort = 0;
  let previous: string | null = null;
  before(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    await $('nav').waitForDisplayed({ timeout: 20000 });
    previous = (await snapshot()).workspacePath;
  });
  const startPlant = async () => {
    const child = spawn('python', ['-u', path.resolve('tools/simulator/pressure_bench.py'), '--port', String(plantPort)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    plant = child;
    let ready = false, diagnostic = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      if (text.includes('"pressure":')) ready = true;
      fs.appendFileSync(path.join(process.env.MODBUS_TEST_RUN_DIR!, 'process-model.log'), text);
    });
    child.stderr.on('data', chunk => { diagnostic = String(chunk).slice(-500); });
    await browser.waitUntil(async () => { if (child.exitCode !== null) throw new Error('Process model exited: ' + diagnostic); return ready; });
  };
  const stopPlant = async () => {
    const child = plant;
    plant = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
  };
  afterEach(async () => {
    await stopPlant();
    for (const id of [master, field]) await command({ type: 'connection.disconnect', connectionId: id });
    await command({ type: 'workspace.new' });
  });
  after(async () => { if (previous) await command({ type: 'workspace.open', path: previous }); });

  it('proves pressure tracking, stuck and missing feedback, exception responses, loss of the link and recovery on TCP', async () => {
    plantPort = await servicePort();
    const file = await openBench('tcp', plantPort);
    const startWrite = await setPressure(plantPort);
    await startPlant();
    const id = await startFlow(true);
    const pausedAt = [];
    for (const step of ['pressure-cycle', 'check-lockout', 'capture-sp', 'validate-sp', 'fresh-before-start', 'check-empty', 'enable-pump']) {
      await browser.waitUntil(async () => {
        const run = (await snapshot()).scriptRun;
        return run?.state === 'paused' && run.current?.blockId === step;
      }, { timeoutMsg: 'Expected to pause before ' + step });
      await expect(scope().$(`g[data-id="${step}"] > .script-location-arrow`)).toBeDisplayed();
      pausedAt.push(step);
      if (step === 'enable-pump') break;
      await scope().$('button=单步').click();
    }
    const beforeEnable = independent(plantPort);
    expect(beforeEnable).toEqual({ pump: false, alarm: false, sp: 36, pv: 0 });
    expect((await snapshot()).scriptRun!.pause?.writePreview).toBe('true');
    await shot('tcp-before-enable');
    await scope().$('button=单步').click();
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.current?.blockId === 'rise-log');
    await expect(scope().$('g[data-id="rise-log"] > .script-location-arrow')).toBeDisplayed();
    const afterEnable = independent(plantPort);
    expect(afterEnable.pump).toBe(true);
    await scope().$('button=继续').click();
    save('single-step', { pausedAt, beforeEnable, afterEnable });
    await browser.waitUntil(async () => (await snapshot()).points['sensor::pv']!.engNumber! > 0);
    await rail('组态画布');
    await expect(widget('pump-output').$('[role="img"]')).toHaveAttribute('aria-label', '已开启');
    await expect(widget('sensor-status').$('[role="img"]')).toHaveAttribute('aria-label', '在线');
    await expect(widget('pressure-gauge').$('[role="meter"]')).toBeDisplayed();
    await shot('tcp-rising');
    const normal = await completed(id, 'passed');
    await checkCycle(normal, 'tcp', startWrite);
    expect(independent(plantPort)).toEqual({ pump: false, alarm: false, sp: 36, pv: 0 });
    await expect(widget('measured-pressure')).toHaveText(expect.stringMatching(/^0(?:\.0+)?\s*MPa$/));
    await shot('tcp-canvas');
    await rail('趋势');
    await expect(scope()).toHaveText(expect.stringContaining('出口压力'));
    await scope().$('button=图表').click();
    await scope().$('canvas').waitForDisplayed();
    await shot('tcp-trend');
    await rail('主站脚本');
    await expect(scope().$('[aria-label="步骤结果"]')).toHaveText(expect.stringContaining('压力达标 MPa 0.36'));
    await scope().$('button=Lua 预览').click();
    const lua = await scope().$('textarea[aria-label="生成的 Lua"]').getValue();
    expect(lua).toContain('modbus.write("pump", "enable"');
    expect(lua).toContain('print("压力达标 MPa", modbus.value("sensor", "pv"))');
    fs.writeFileSync(path.join(evidence, 'cycle.lua'), lua);
    await scope().$('button=收起 Lua').click();

    const illegal = await command<{ result: string; exceptionCode: number }>({ type: 'device.temporaryRead', connectionId: master, unitId: 2, area: 3, start: 900, quantity: 1 });
    expect(illegal).toMatchObject({ result: 'exception', exceptionCode: 2 });
    expect((await snapshot()).slaveStates?.sensor?.state).toBe('online');
    save('illegal-address', illegal);

    await stopPlant();
    const frozen = await completed(await startFlow(), 'stopped');
    expect(frozen.entries).toContainEqual(expect.objectContaining({ blockId: 'wait-for-pressure', result: 'failed', handled: true, detail: expect.stringContaining('等待超时') }));
    expect(frozen.entries.filter(row => row.log).map(row => row.blockId)).toEqual(['rise-log', 'timeout-log', 'trip-confirmed']);
    expect(independent(plantPort)).toEqual({ pump: false, alarm: true, sp: 36, pv: 0 });
    await rail('组态画布');
    await expect(widget('alarm-lamp').$('[role="img"]')).toHaveAttribute('aria-label', '已锁存');
    expect((await snapshot()).slaveStates?.sensor?.state).toBe('online');
    save('frozen-feedback', frozen);
    const locked = await completed(await startFlow(), 'stopped');
    expect(locked.entries.filter(row => row.log).map(row => row.blockId)).toEqual(['locked-log']);
    expect(locked.entries.some(row => row.blockId === 'enable-pump')).toBe(false);
    expect(independent(plantPort)).toEqual({ pump: false, alarm: true, sp: 36, pv: 0 });
    save('latched-restart', locked);
    await rail('组态画布');
    await widget('alarm-reset').$('button=复位报警').click();
    await browser.waitUntil(async () => (await snapshot()).points['pump::alarm']?.boolValue === false);

    const disabledAt = Date.now();
    await setSensorEnabled(false);
    const transitions: { missed: number; sensor: string; pump: string }[] = [];
    await browser.waitUntil(async () => {
      const live = await snapshot();
      const missed = live.transactions.filter(tx => tx.connectionId === master && tx.unitId === 2 && tx.sourceKind === 'poll'
        && tx.result === 'timeout' && Date.parse(tx.startUtc) >= disabledAt).length;
      const sensor = live.slaveStates!.sensor!.state, pump = live.slaveStates!.pump!.state;
      if (transitions.at(-1)?.missed !== missed || transitions.at(-1)?.sensor !== sensor) transitions.push({ missed, sensor, pump });
      return sensor === 'offline';
    }, { timeout: 7000, interval: 25 });
    expect(transitions).toEqual(expect.arrayContaining([{ missed: 1, sensor: 'online', pump: 'online' },
      { missed: 2, sensor: 'online', pump: 'online' }, { missed: 3, sensor: 'offline', pump: 'online' }]));
    await expect(widget('sensor-status').$('[role="img"]')).toHaveAttribute('aria-label', '离线');
    await expect(widget('pump-status').$('[role="img"]')).toHaveAttribute('aria-label', '在线');
    await shot('tcp-one-device-offline');
    const absent = await completed(await startFlow(), 'stopped');
    expect(absent.entries).toContainEqual(expect.objectContaining({ blockId: 'fresh-before-start', result: 'failed', handled: true }));
    const state = await snapshot();
    const lostPolls = state.transactions.filter(tx => tx.connectionId === master && tx.unitId === 2 && tx.sourceKind === 'poll' && tx.result === 'timeout' && Date.parse(tx.startUtc) >= disabledAt);
    expect(lostPolls.length).toBeGreaterThanOrEqual(3);
    expect(state.connections[master]?.state).toBe('online');
    expect(state.transactions.some(tx => tx.connectionId === master && tx.sourceKind === 'write' && tx.requestPduHex === '050000ff00' && Date.parse(tx.startUtc) >= absent.startedAtMs)).toBe(false);
    expect(independent(plantPort, false).pump).toBe(false);
    save('one-device-offline', { run: absent, transitions, missedPolls: lostPolls.length, states: state.slaveStates, link: state.connections[master] });

    await setSensorEnabled(true);
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.sensor?.state === 'online');
    await rail('组态画布');
    await widget('alarm-reset').$('button=复位报警').click();
    await browser.waitUntil(async () => (await snapshot()).points['pump::alarm']?.boolValue === false);
    await startPlant();
    expect((await completed(await startFlow(), 'passed')).entries.at(-1)?.detail).toBe('卸压完成 MPa 0');
    await stopPlant();

    const interruptedId = await startFlow();
    await browser.waitUntil(async () => (await snapshot()).scriptRun?.current?.blockId === 'wait-for-pressure');
    expect(independent(plantPort).pump).toBe(true);
    await command({ type: 'connection.disconnect', connectionId: field });
    const interrupted = await completed(interruptedId, 'stopped');
    expect(interrupted.entries.filter(row => row.log).map(row => row.blockId)).toContain('trip-unknown');
    expect(interrupted.entries.some(row => row.blockId === 'trip-confirmed')).toBe(false);
    await command({ type: 'connection.connect', connectionId: field });
    await browser.waitUntil(async () => (await snapshot()).slaveStates?.pump?.state === 'online', { timeout: 9000 });
    const recovered = independent(plantPort);
    expect(recovered.pump).toBe(true);
    await rail('组态画布');
    await expect(widget('pump-output').$('[role="img"]')).toHaveAttribute('aria-label', '已开启');
    await widget('manual-stop').$('button=手动停泵').click();
    await browser.waitUntil(async () => (await snapshot()).points['pump::enable']?.boolValue === false);
    expect(independent(plantPort).pump).toBe(false);
    save('link-loss', { run: interrupted, outputAfterReconnect: recovered, afterOperatorStop: independent(plantPort) });

    await command({ type: 'workspace.save' });
    await command({ type: 'workspace.new' });
    await command({ type: 'workspace.open', path: file });
    const reloaded = (await snapshot()).workspace;
    expect(reloaded.canvases?.[0]?.widgets).toHaveLength(16);
    expect(reloaded.masterScripts?.[0]?.id).toBe('hydrotest');
    expect(reloaded.trendGroups[0]?.signals.map(item => item.pointRef)).toEqual(refs.map(ref => ({ connectionId: master, ...ref })));
    expect(reloaded.slaves.filter(slave => slave.connectionId === field && slave.enabled)).toHaveLength(2);
  });

  it('trips a running pump when only Unit 2 replies are lost, then recovers over the same TCP session', async () => {
    plantPort = await servicePort();
    const gate = await sensorFaultLink(plantPort);
    try {
      await openBench('tcp', plantPort, gate.port);
      await setPressure(plantPort);
      await startPlant();
      const id = await startFlow();
      await browser.waitUntil(async () => {
        const state = await snapshot();
        const pv = state.points['sensor::pv']?.engNumber ?? 0;
        return state.scriptRun?.current?.blockId === 'wait-for-pressure' && pv > 0 && pv < 0.30;
      }, { interval: 40 });
      const sessionsAtFault = gate.link.connections;
      gate.link.dropSensor = true;
      await browser.waitUntil(async () => (await snapshot()).slaveStates?.sensor?.state === 'offline', { timeout: 5000 });
      const during = await snapshot();
      expect(during.connections[master]?.state).toBe('online');
      expect(during.slaveStates?.pump?.state).toBe('online');
      expect(during.scriptRun?.current?.blockId).toBe('wait-for-pressure');
      expect(independent(plantPort).pump).toBe(true);
      await rail('组态画布');
      await expect(widget('sensor-status').$('[role="img"]')).toHaveAttribute('aria-label', '离线');
      await expect(widget('pump-output').$('[role="img"]')).toHaveAttribute('aria-label', '已开启');
      await shot('tcp-lost-sensor-running');
      const run = await completed(id, 'stopped');
      expect(run.entries.filter(row => row.log).map(row => row.blockId)).toEqual(['rise-log', 'timeout-log', 'trip-confirmed']);
      expect(run.entries.find(row => row.blockId === 'wait-for-pressure')).toMatchObject({ result: 'failed', handled: true });
      const actual = independent(plantPort);
      expect(actual).toMatchObject({ pump: false, alarm: true, sp: 36 });
      expect(gate.link.discarded).toBeGreaterThanOrEqual(3);
      expect(gate.link.connections).toBe(sessionsAtFault);
      gate.link.dropSensor = false;
      await browser.waitUntil(async () => (await snapshot()).slaveStates?.sensor?.state === 'online');
      await expect(widget('sensor-status').$('[role="img"]')).toHaveAttribute('aria-label', '在线');
      expect(gate.link.connections).toBe(sessionsAtFault);
      save('running-sensor-loss', { run, atLoss: during.slaveStates, lastMasterPressure: during.points['sensor::pv']?.engNumber,
        discardedReplies: gate.link.discarded, newConnectionsDuringFault: gate.link.connections - sessionsAtFault, fieldAfterTrip: actual });
    } finally {
      await command({ type: 'connection.disconnect', connectionId: master });
      await gate.close();
    }
  });

  const rtuTest = process.env.MODBUS_SELF_RTU === '1' ? it : it.skip;
  rtuTest('repeats the same pressure workflow through native serial I/O on a virtual COM pair', async () => {
    await openBench('rtu');
    const startWrite = await setPressure();
    const id = await startFlow();
    const pressure = async (raw: number) => {
      await command({ type: 'slave.setValues', slaveId: 'sensor-field', blockId: 'pt-holding', offset: 0, values: [raw] });
      await browser.waitUntil(async () => (await snapshot()).points['sensor::pv']?.engNumber === raw * 0.01);
    };
    await browser.waitUntil(async () => (await snapshot()).points['pump-field::enable']?.boolValue === true);
    for (const raw of [9, 18, 27, 36]) await pressure(raw);
    await browser.waitUntil(async () => (await snapshot()).points['pump-field::enable']?.boolValue === false);
    for (const raw of [24, 12, 0]) await pressure(raw);
    const run = await completed(id, 'passed');
    await checkCycle(run, 'rtu', startWrite);
    await rail('组态画布');
    await expect(widget('sensor-status').$('[role="img"]')).toHaveAttribute('aria-label', '在线');
    await shot('rtu-canvas');
  });
});
