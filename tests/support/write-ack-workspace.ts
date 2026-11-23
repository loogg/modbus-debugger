import { workspaceSchema } from '../../src/domain/model';
import { canvasWidgetSchema } from '../../src/domain/canvas';

/** Independent simulator endpoints provide normal, exception and dropped acknowledgements. */
export function writeAckWorkspace(ports = [50525, 50526, 50527]) {
  const mapping = { wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 1, stringLength: 0, stringEncoding: 'ascii', registerCount: 1 };
  const binding = (pointId: string, index = 0) => ({ slaveId: `device-${index}`, pointId });
  const widget = (value: unknown) => canvasWidgetSchema.parse(value);
  return workspaceSchema.parse({
    name: '写应答与只写点位',
    connections: ports.map((port, index) => ({ id: `tcp-${index}`, name: ['正常应答', '异常应答', '应答超时'][index], transport: 'tcp', tcp: { host: '127.0.0.1', port }, timeoutMs: 400, retries: 0, reconnect: 'manual', interFrameMs: 0 })),
    templates: [{ id: 'commands', name: '命令与反馈', blocks: [{ id: 'mixed', name: '混合寄存器块', area: 3, start: 0, length: 12, periodMs: 500 }], points: [
      { id: 'speed', blockId: 'mixed', name: '转速反馈', access: 'rw', unit: 'rpm', mapping: { ...mapping, offset: 6, rawType: 'UInt16' } },
      { id: 'command', blockId: 'mixed', name: '启动命令', access: 'wo', mapping: { ...mapping, offset: 3, rawType: 'UInt16' } },
      { id: 'flag', blockId: 'mixed', name: '使能命令', access: 'wo', mapping: { ...mapping, offset: 4, rawType: 'Bool', bitOffset: 3 } },
    ] }],
    slaves: ports.map((_port, index) => ({ id: `device-${index}`, connectionId: `tcp-${index}`, templateId: 'commands', unitId: 1, name: ['正常设备', '拒绝设备', '超时设备'][index], enabled: true })),
    trendGroups: [{ id: 'feedback', name: '采集反馈', signals: [{ id: 'speed-signal', pointRef: { ...binding('speed'), connectionId: 'tcp-0' } }] }],
    canvases: [{ id: 'commands-canvas', name: '命令操作台', width: 860, height: 580, background: '#FFFFFF', widgets: [
      widget({ id: 'heading', kind: 'text', label: '标题', text: '写应答与设备反馈', x: 24, y: 20, width: 400, height: 36, fontSize: 24, color: '#1A1C21' }),
      ...ports.flatMap((_port, index) => [
        widget({ id: `group-${index}`, kind: 'container', label: ['正常应答', '设备拒绝', '应答超时'][index], showLabel: true, showBorder: true, borderColor: '#D5DBE3', x: 24 + index * 272, y: 80, width: 248, height: 200 }),
        widget({ id: `send-${index}`, kind: 'button', parentId: `group-${index}`, label: ['正常启动', '拒绝启动', '超时启动'][index], text: '发送启动命令', onValue: '1', binding: binding('command', index), x: 16, y: 44, width: 184, height: 36 }),
        widget({ id: `input-${index}`, kind: 'input', parentId: `group-${index}`, label: ['正常命令值', '拒绝命令值', '超时命令值'][index], binding: binding('command', index), x: 16, y: 104, width: 208, height: 64 }),
      ]),
      widget({ id: 'enable', kind: 'switch', label: '使能命令', showLabel: true, showStateText: true, binding: binding('flag'), x: 24, y: 320, width: 160, height: 64 }),
      widget({ id: 'speed-input', kind: 'input', label: '设置转速', showLabel: true, binding: binding('speed'), x: 224, y: 320, width: 240, height: 84 }),
      widget({ id: 'speed-value', kind: 'value', label: '采集确认转速', showLabel: true, binding: binding('speed'), x: 512, y: 320, width: 176, height: 84, fontSize: 32 }),
    ] }],
    workbench: { activeId: 'commands-view', views: [{ id: 'commands-view', module: 'canvas', selection: { canvasId: 'commands-canvas' } }] },
  });
}
