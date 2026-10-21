import { workspaceSchema, type ConnectionDef, type Workspace } from '../../src/domain/model';

export const serverConnection = (port = 15020): ConnectionDef => ({
  id: 'server', name: '本机 TCP 从站', role: 'slave', transport: 'tcp', tcp: { host: '127.0.0.1', port },
  timeoutMs: 500, retries: 0, reconnect: 'manual', interFrameMs: 0, rtsControl: 'none', logLevel: 'info',
});

export function slaveWorkspace(port?: number): Workspace {
  return workspaceSchema.parse({ schemaVersion: 1, name: '从站测试', connections: [serverConnection(port)],
    slaves: [1, 2].map(unitId => ({ id: `s${unitId}`, connectionId: 'server', unitId, name: `设备 ${unitId}`, templateId: 'memory', enabled: true })),
    templates: [{ id: 'memory', name: '四区内存', blocks: [1, 2, 3, 4].map(area => ({ id: `b${area}`, name: `区 ${area}`, area, start: 0, length: 16, periodMs: 20 })).concat([
      { id: 'tail', name: '连续块', area: 3, start: 16, length: 2, periodMs: 20 },
      { id: 'gap', name: '不连续块', area: 3, start: 20, length: 2, periodMs: 20 },
    ]), points: [1, 2, 3, 4].map(area => ({ id: `p${area}`, blockId: `b${area}`, name: `点 ${area}`,
      mapping: { rawType: area <= 2 ? 'Bool' : 'UInt16', offset: 0, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii' }, access: area === 1 || area === 3 ? 'rw' : 'ro' })) }],
    trendGroups: [{ id: 'trend', name: '从站趋势', windowSec: 60, signals: [{ id: 'sig', pointRef: { connectionId: 'server', slaveId: 's1', pointId: 'p3' }, visible: true }] }],
  });
}
