import type { AppTransport, TransportState } from './types';
import type { AppDelta, AppSnapshot, BlockViewState, ConnectionStateView, PointViewState } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';
import type { AppVersions } from '../../shared/preload-api';
import { emptyWorkspace, connectionSchema, pointSchema, blockSchema, type Workspace, type BlockDef, type PointDef } from '../../domain/model';
import { pointKey } from '../../shared/point-key';
import type { ConnectionHealth } from '../../main/runtime/diagnostics';

export type MockFixtureName = 'default' | 'empty' | 'loading' | 'error' | 'timeout' | 'large-data';

function mkPoint(id: string, name: string, blockId: string, offset: number, rawType: 'Float32' | 'UInt16' | 'Bool', unit = ''): PointDef {
  return pointSchema.parse({
    id,
    name,
    blockId,
    access: 'rw',
    scale: 1,
    offset: 0,
    unit,
    mapping: {
      rawType,
      offset,
      registerCount: rawType === 'Float32' ? 2 : 1,
      wordOrder: 'ABCD',
      byteSelector: 'low',
      bitOffset: 0,
      bitWidth: 1,
      stringLength: 0,
      stringEncoding: 'ascii',
    },
  });
}

function createDefaultWorkspace(): Workspace {
  const bElec = blockSchema.parse({ id: 'b_elec', name: '电气测量量', area: 3, start: 0, length: 10, periodMs: 1000 });
  const bStatus = blockSchema.parse({ id: 'b_status', name: '设备运行状态', area: 1, start: 0, length: 8, periodMs: 2000 });

  return {
    ...emptyWorkspace('默认工作区'),
    connections: [
      connectionSchema.parse({
        id: 'c_tcp',
        name: '边缘网关 (TCP)',
        transport: 'tcp',
        tcp: { host: '127.0.0.1', port: 502 },
      }),
      connectionSchema.parse({
        id: 'c_rtu',
        name: '现场串口 (RTU)',
        transport: 'rtu',
        rtu: { port: 'COM3', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
      }),
    ],
    templates: [
      {
        id: 't_meter',
        name: '智能三相多功能电表',
        version: '1.0',
        description: '测量电压、电流、有功功率与频率',
        blocks: [bElec, bStatus],
        points: [
          mkPoint('p_u_a', 'A相电压 Ua', 'b_elec', 0, 'Float32', 'V'),
          mkPoint('p_i_a', 'A相电流 Ia', 'b_elec', 2, 'Float32', 'A'),
          mkPoint('p_p_total', '总有功功率 P', 'b_elec', 4, 'Float32', 'kW'),
          mkPoint('p_freq', '电网频率 Freq', 'b_elec', 6, 'UInt16', 'Hz'),
          mkPoint('p_run', '运行指示', 'b_status', 0, 'Bool'),
          mkPoint('p_alarm', '过流告警', 'b_status', 1, 'Bool'),
        ],
      },
    ],
    slaves: [
      {
        id: 's_meter1',
        connectionId: 'c_tcp',
        unitId: 1,
        name: '1#进线电表',
        templateId: 't_meter',
        enabled: true,
      },
      {
        id: 's_meter2',
        connectionId: 'c_tcp',
        unitId: 2,
        name: '2#馈线电表',
        templateId: 't_meter',
        enabled: true,
      },
      {
        id: 's_rtu1',
        connectionId: 'c_rtu',
        unitId: 1,
        name: '车间RTU电表',
        templateId: 't_meter',
        enabled: true,
      },
    ],
    trendGroups: [
      {
        id: 'g_main',
        name: '进线负荷趋势',
        description: '监测进线电压与电流',
        windowSec: 60,
        signals: [
          { id: 'sig1', visible: true, pointRef: { connectionId: 'c_tcp', slaveId: 's_meter1', pointId: 'p_u_a' } },
          { id: 'sig2', visible: true, pointRef: { connectionId: 'c_tcp', slaveId: 's_meter1', pointId: 'p_i_a' } },
        ],
      },
    ],
  };
}

function createLargeDataWorkspace(): Workspace {
  const ws = createDefaultWorkspace();
  const blocks: BlockDef[] = [];
  const points: PointDef[] = [];

  for (let b = 1; b <= 10; b++) {
    const blockId = `b_large_${b}`;
    blocks.push(
      blockSchema.parse({
        id: blockId,
        name: `批量数据区 ${b} (40001～)`,
        area: 3,
        start: (b - 1) * 30,
        length: 30,
        periodMs: 500,
      }),
    );

    for (let p = 1; p <= 30; p++) {
      const pointId = `p_l_${b}_${p}`;
      points.push(
        mkPoint(
          pointId,
          `通道_${b}_点位_${p}`,
          blockId,
          p - 1,
          p % 2 === 0 ? 'Float32' : 'UInt16',
          p % 2 === 0 ? 'kPa' : 'rpm',
        ),
      );
    }
  }

  ws.templates.push({
    id: 't_large',
    name: '300点高密度采集器',
    version: '2.0',
    description: '包含10个数据块、300个寄存器点位的大数据量测试模板',
    blocks,
    points,
  });

  ws.slaves.push({
    id: 's_large1',
    connectionId: 'c_tcp',
    unitId: 10,
    name: '高密度测试从站 10',
    templateId: 't_large',
    enabled: true,
  });

  return ws;
}

export class MockTransport implements AppTransport {
  readonly transportType = 'mock' as const;
  readonly fixture: MockFixtureName;
  private statusListeners = new Set<(state: TransportState) => void>();
  private deltaListeners = new Set<(delta: AppDelta) => void>();
  private snapshot: AppSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private revision = 1;

  constructor(fixture: MockFixtureName = 'default') {
    this.fixture = fixture;
    this.snapshot = this.createInitialSnapshot(fixture);
    if (this.fixture === 'default' || this.fixture === 'large-data') {
      this.startSimulatedDeltas();
    }
  }

  getStatus(): TransportState {
    return {
      type: 'mock',
      status: this.fixture === 'loading' ? 'connecting' : 'connected',
      fixture: this.fixture,
      message: `Mock Mode [${this.fixture}]`,
    };
  }

  onStatusChange(cb: (state: TransportState) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private createInitialSnapshot(fixture: MockFixtureName): AppSnapshot {
    let ws: Workspace;
    if (fixture === 'empty') {
      ws = emptyWorkspace();
    } else if (fixture === 'large-data') {
      ws = createLargeDataWorkspace();
    } else {
      ws = createDefaultWorkspace();
    }

    const connections: Record<string, ConnectionStateView> = {};
    for (const c of ws.connections) {
      connections[c.id] = { state: 'online', detail: null, lastResponseUtc: new Date().toISOString() };
    }

    const blocks: Record<string, BlockViewState> = {};
    const points: Record<string, PointViewState> = {};

    for (const slave of ws.slaves) {
      const t = ws.templates.find((tpl) => tpl.id === slave.templateId);
      if (!t) continue;
      for (const b of t.blocks) {
        const bKey = `${slave.id}:${b.id}`;
        blocks[bKey] = {
          key: bKey,
          slaveId: slave.id,
          blockId: b.id,
          blockName: b.name,
          area: b.area,
          start: b.start,
          length: b.length,
          periodMs: b.periodMs,
          status: 'ok',
          exceptionCode: null,
          lastUpdateUtc: new Date().toISOString(),
          lastDurationMs: 15,
          revision: 1,
          registers: Array.from({ length: b.length }, (_, i) => 100 + i * 5),
        };
      }
      for (const p of t.points) {
        const pKey = pointKey(slave.id, p.id);
        const isBool = p.mapping.rawType === 'Bool';
        points[pKey] = {
          slaveId: slave.id,
          pointId: p.id,
          rawText: isBool ? '1' : '220.5',
          engText: isBool ? 'ON' : '220.5 V',
          finite: true,
          hasValue: true,
          rawNumber: 220,
          engNumber: isBool ? null : 220.5,
          boolValue: isBool ? true : null,
          stringValue: null,
          enumLabel: null,
        };
      }
    }

    const health: Record<string, ConnectionHealth> = {
      c_tcp: {
        connectionId: 'c_tcp',
        busLoadPercent: 12,
        requestRatePerSec: 10,
        p50Ms: 8,
        p95Ms: 15,
        timeouts: 0,
        crcErrors: 0,
        exceptions: 0,
        unexpected: 0,
        windowSec: 60,
        blocks: [],
      },
    };

    return {
      revision: 1,
      workspace: ws,
      workspacePath: '/mock/workspace.json',
      dirty: false,
      connections,
      blocks,
      points,
      transactions: [],
      parseEvents: [],
      diagRev: 0,
      health,
      recording: null,
      sessions: [],
      warnings: [],
      prefs: {
        window: { x: 100, y: 100, width: 1440, height: 900 },
        sidebarWidth: 244,
        historyDbPath: null,
        persistRawComm: false,
        lastWorkspacePath: null,
        timezone: 'local',
        language: 'zh-CN',
      },
      historyDbPath: '',
    };
  }

  private startSimulatedDeltas(): void {
    let tick = 0;
    this.timer = setInterval(() => {
      tick++;
      this.revision++;
      const updatedPoints: Record<string, PointViewState> = {};

      for (const slave of this.snapshot.workspace.slaves) {
        const t = this.snapshot.workspace.templates.find((tpl) => tpl.id === slave.templateId);
        if (!t) continue;
        for (const p of t.points) {
          const pKey = pointKey(slave.id, p.id);
          const isBool = p.mapping.rawType === 'Bool';
          if (isBool) {
            const bVal = (tick + (p.id.charCodeAt(0) || 0)) % 4 === 0;
            updatedPoints[pKey] = {
              slaveId: slave.id,
              pointId: p.id,
              rawText: bVal ? '1' : '0',
              engText: bVal ? 'ON' : 'OFF',
              finite: true,
              hasValue: true,
              rawNumber: bVal ? 1 : 0,
              engNumber: null,
              boolValue: bVal,
              stringValue: null,
              enumLabel: null,
            };
          } else {
            const base = p.id.includes('u_') ? 220 : p.id.includes('i_') ? 15 : 50;
            const variance = Math.sin(tick * 0.2 + (p.id.length || 0)) * 5;
            const eng = Math.round((base + variance) * 100) / 100;
            updatedPoints[pKey] = {
              slaveId: slave.id,
              pointId: p.id,
              rawText: String(Math.round(eng * 10)),
              engText: `${eng} ${p.unit}`,
              finite: true,
              hasValue: true,
              rawNumber: Math.round(eng * 10),
              engNumber: eng,
              boolValue: null,
              stringValue: null,
              enumLabel: null,
            };
          }
        }
      }

      const delta: AppDelta = {
        revision: this.revision,
        points: updatedPoints,
      };

      // update internal snapshot
      this.snapshot = {
        ...this.snapshot,
        revision: this.revision,
        points: { ...this.snapshot.points, ...updatedPoints },
      };

      for (const listener of this.deltaListeners) {
        try {
          listener(delta);
        } catch {
          // ignore
        }
      }
    }, 1000);
  }

  async getSnapshot(): Promise<AppSnapshot> {
    if (this.fixture === 'loading') {
      return new Promise(() => {}); // never resolves to test loading skeleton
    }
    return JSON.parse(JSON.stringify(this.snapshot)) as AppSnapshot;
  }

  async versions(): Promise<AppVersions> {
    return {
      electron: 'mock',
      node: 'mock',
      app: '0.11.0-mock',
    };
  }

  async command<T = unknown>(cmd: Command): Promise<CommandResult<T>> {
    if (this.fixture === 'timeout') {
      await new Promise((r) => setTimeout(r, 1000));
      return { ok: false, error: 'Command timed out (Mock fixture: timeout)' };
    }
    if (this.fixture === 'error') {
      return { ok: false, error: 'Operation failed (Mock fixture: error)' };
    }

    if (cmd.type === 'workspace.apply') {
      this.snapshot = { ...this.snapshot, workspace: cmd.workspace, dirty: true };
      const delta: AppDelta = { revision: ++this.revision, workspace: cmd.workspace, dirty: true };
      for (const l of this.deltaListeners) l(delta);
      return { ok: true, value: null as T };
    }

    if (cmd.type === 'connection.connect') {
      const conn: ConnectionStateView = { state: 'online', detail: null, lastResponseUtc: new Date().toISOString() };
      this.snapshot = { ...this.snapshot, connections: { ...this.snapshot.connections, [cmd.connectionId]: conn } };
      for (const l of this.deltaListeners) l({ revision: ++this.revision, connections: { [cmd.connectionId]: conn } });
      return { ok: true, value: null as T };
    }

    if (cmd.type === 'connection.disconnect') {
      const conn: ConnectionStateView = { state: 'offline', detail: null, lastResponseUtc: null };
      this.snapshot = { ...this.snapshot, connections: { ...this.snapshot.connections, [cmd.connectionId]: conn } };
      for (const l of this.deltaListeners) l({ revision: ++this.revision, connections: { [cmd.connectionId]: conn } });
      return { ok: true, value: null as T };
    }

    if (cmd.type === 'serial.list') {
      return {
        ok: true,
        value: [
          { path: 'COM1', manufacturer: 'FTDI', serialNumber: 'FT12345' },
          { path: 'COM3', manufacturer: 'Silicon Labs', serialNumber: 'CP2102-01' },
        ] as T,
      };
    }

    return { ok: true, value: null as T };
  }

  onDelta(cb: (delta: AppDelta) => void): () => void {
    this.deltaListeners.add(cb);
    return () => {
      this.deltaListeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
