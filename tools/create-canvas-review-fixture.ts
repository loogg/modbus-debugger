import fs from 'node:fs';
import path from 'node:path';
import { migrateWorkspace } from '../src/domain/model';
import { canvasSchema, canvasWidgetSchema } from '../src/domain/canvas';
import { newWidget } from '../src/renderer/features/canvas/editing';
import { GAUGE_STYLES, INPUT_MODES } from '../src/renderer/features/canvas/presets';
import { lampRuleSchema } from '../src/domain/canvas-lamp';

const workspace = migrateWorkspace(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json', 'utf8')));
workspace.name = '紧凑组态与曲线验证';
workspace.connections = workspace.connections.filter(c => c.transport === 'tcp');
workspace.slaves = workspace.slaves.filter(s => workspace.connections.some(c => c.id === s.connectionId));
workspace.trendGroups = workspace.trendGroups.map(g => ({ ...g, signals: g.signals.filter(s => workspace.slaves.some(device => device.id === s.pointRef.slaveId)) }));
const widget = (value: unknown) => canvasWidgetSchema.parse(value);
const binding = (pointId: string) => ({ slaveId: 'slave-1', pointId });
workspace.canvases = [canvasSchema.parse({ id: 'review-canvas', name: '设备操作台', width: 960, height: 680, widgets: [
  widget({ id: 'heading', kind: 'text', label: '标题', text: '设备操作台', x: 24, y: 24, width: 240, height: 32, fontSize: 24, color: '#1A1C21' }),
  widget({ id: 'control-group', kind: 'container', label: '设备控制', showLabel: true, showBorder: true, color: '#A8B1BE', x: 24, y: 80, width: 520, height: 168 }),
  widget({ id: 'speed-label', kind: 'text', label: '转速标签', text: '目标转速', parentId: 'control-group', x: 16, y: 32, width: 80, height: 24, fontSize: 16, color: '#1A1C21' }),
  widget({ id: 'speed', kind: 'value', label: '转速反馈', parentId: 'control-group', binding: binding('pt-speed'), x: 112, y: 28, width: 144, height: 32, fontSize: 24, color: '#1A1C21' }),
  widget({ id: 'enable-label', kind: 'text', label: '使能标签', text: '使能', parentId: 'control-group', x: 288, y: 32, width: 48, height: 24, fontSize: 16, color: '#1A1C21' }),
  widget({ id: 'enable-led', kind: 'lamp', label: '使能反馈', parentId: 'control-group', binding: binding('pt-enable'), x: 344, y: 32, width: 24, height: 24, color: '#178A4D' }),
  widget({ id: 'enable', kind: 'switch', label: '使能开关', parentId: 'control-group', binding: binding('pt-enable'), x: 400, y: 30, width: 56, height: 28 }),
  widget({ id: 'input-label', kind: 'text', label: '输入标签', text: '设置转速', parentId: 'control-group', x: 16, y: 88, width: 80, height: 24, fontSize: 16, color: '#1A1C21' }),
  widget({ id: 'input', kind: 'input', label: '设置转速', parentId: 'control-group', binding: binding('pt-speed'), x: 112, y: 80, width: 176, height: 56 }),
  widget({ id: 'preset', kind: 'button', label: '转速预设', text: '写入 100', onValue: '100', parentId: 'control-group', binding: binding('pt-speed'), x: 320, y: 80, width: 96, height: 32 }),
  widget({ id: 'gauge', kind: 'gauge', label: '转速', showLabel: true, binding: binding('pt-speed'), min: 0, max: 3000, x: 568, y: 80, width: 160, height: 152 }),
  widget({ id: 'curve', kind: 'trend', label: '电压 / 电流', showLabel: true, signals: [{ ...binding('pt-volt'), color: '#0078D4' }, { ...binding('pt-cur'), color: '#D97706' }], x: 24, y: 280, width: 704, height: 320 }),
] })];
workspace.workbench = { activeId: 'canvas-review', views: [{ id: 'canvas-review', module: 'canvas', selection: { canvasId: 'review-canvas' } }] };
const variants = process.argv.includes('--variants');
const lamps = process.argv.includes('--lamps');
const preview = process.argv.includes('--preview');
const buffers = process.argv.includes('--buffers');
if (buffers) {
  workspace.name = 'Host 读取与采样缓冲验证';
  workspace.templates[0]!.blocks.forEach(block => { block.periodMs = block.id === 'blk-ctrl' ? 20 : 80; });
  workspace.trendGroups = [{ id: 'buffer-group', name: '转速与温度', description: '', windowSec: 60, signals: ['pt-speed', 'pt-temp'].map((pointId, index) => ({ id: `buffer-signal-${index}`, visible: true, pointRef: { ...binding(pointId), connectionId: workspace.slaves[0]!.connectionId } })) }];
  workspace.sampleBuffers = ['pt-speed', 'pt-temp'].map(pointId => ({ ...binding(pointId), capacity: 1000 }));
  workspace.canvases[0]!.name = '采样控制台';
  workspace.canvases[0]!.background = '#FFFFFF';
  workspace.canvases[0]!.widgets = workspace.canvases[0]!.widgets.map(item => item.kind === 'trend' ? { ...item, label: '转速 / 温度', signals: [{ ...binding('pt-speed'), color: '#0078D4' }, { ...binding('pt-temp'), color: '#D97706' }] } : item);
}
if (preview) {
  workspace.name = '控件预览验证';
  workspace.canvases[0]!.name = '控件状态预览';
  workspace.canvases[0]!.background = '#FFFFFF';
  workspace.canvases[0]!.widgets.push(widget({ id: 'states', kind: 'lamp', label: '运行模式', showLabel: true, showStateText: true, x: 768, y: 80, width: 168, height: 56, binding: binding('pt-mode'), lamp: { mode: 'states', rules: Object.entries(workspace.templates[0]!.points.find(point => point.id === 'pt-mode')!.enumMap).map(([value, label], index) => lampRuleSchema.parse({ id: `mode-${value}`, value: Number(value), label, color: ['#0078D4', '#178A4D', '#7A5AF8'][index], fill: { type: 'radial' } })) } }));
}
if (variants) {
  workspace.name = '仪表与输入验证';
  const text = workspace.templates[0]!.points.find(point => point.id === 'pt-fw')!;
  text.access = 'rw'; text.name = '设备文本';
  const canvas = canvasSchema.parse({ id: 'review-canvas', name: '仪表与输入', width: 1000, height: 640, background: '#FFFFFF' });
  canvas.widgets = [widget({ id: 'heading', kind: 'text', label: '标题', text: '仪表与输入', x: 24, y: 16, width: 300, height: 32, fontSize: 24, color: '#1A1C21' })];
  const positions = [24, 208, 408, 640, 768];
  (Object.keys(GAUGE_STYLES) as (keyof typeof GAUGE_STYLES)[]).forEach((gaugeStyle, index) => {
    const item = newWidget('gauge', `gauge-${gaugeStyle}`, canvas, positions[index], 72, null, { kind: 'gauge', gaugeStyle });
    canvas.widgets.push({ ...item, label: GAUGE_STYLES[gaugeStyle], showLabel: true, height: item.height + 18, binding: binding('pt-speed'), min: 0, max: 3000 });
  });
  canvas.widgets.push(widget({ id: 'inputs-heading', kind: 'text', label: '输入标题', text: '设定与操作', x: 24, y: 304, width: 300, height: 28, fontSize: 18, color: '#1A1C21' }));
  (Object.keys(INPUT_MODES) as (keyof typeof INPUT_MODES)[]).forEach((inputMode, index) => {
    const item = newWidget('input', `input-${inputMode}`, canvas, 24 + (index % 3) * 280, index < 3 ? 360 : 472, null, { kind: 'input', inputMode });
    const pointId = inputMode === 'text' ? 'pt-fw' : inputMode === 'select' ? 'pt-mode' : 'pt-speed';
    canvas.widgets.push({ ...item, label: INPUT_MODES[inputMode], showLabel: true, width: 240, height: 74, binding: binding(pointId), min: 0, max: 3000, step: inputMode === 'slider' ? 50 : 100, limitInput: inputMode === 'stepper' });
  });
  workspace.canvases = [canvasSchema.parse(canvas)];
}
if (lamps) {
  workspace.name = '指示灯状态验证';
  const canvas = canvasSchema.parse({ id: 'review-canvas', name: '设备状态', width: 1100, height: 600, background: '#FFFFFF' });
  const light = (id: string, label: string, pointId: string, x: number, lamp: unknown) => widget({ id, kind: 'lamp', label, binding: binding(pointId), x, y: 112, width: 176, height: 50, showLabel: true, showStateText: true, color: '#178A4D', lamp });
  canvas.widgets = [
    widget({ id: 'heading', kind: 'text', label: '标题', text: '设备状态', x: 24, y: 16, width: 320, height: 32, fontSize: 24, color: '#1A1C21' }),
    widget({ id: 'lights-heading', kind: 'text', label: '灯组标题', text: '双色与多状态', x: 24, y: 64, width: 320, height: 28, fontSize: 18, color: '#1A1C21' }),
    light('binary', '运行使能', 'pt-enable', 24, { on: { label: '已使能', color: '#178A4D', fill: { type: 'radial' } }, off: { label: '未使能', color: '#D97706', fill: { type: 'linear' } } }),
    light('enum-binary', '枚举二态', 'pt-mode', 232, { on: { label: '非零模式', color: '#0078D4', fill: { type: 'linear', secondary: '#B9DFFF', angle: 135 } }, off: { label: '零模式', color: '#64748B' } }),
    light('enum-states', '运行模式', 'pt-mode', 440, { mode: 'states', rules: Object.entries(workspace.templates[0]!.points.find(point => point.id === 'pt-mode')!.enumMap).map(([value, label], index) => lampRuleSchema.parse({ id: `mode-${value}`, value: Number(value), label, color: ['#0078D4', '#178A4D', '#7A5AF8'][index], fill: { type: 'radial' } })) }),
    light('range', '速度状态', 'pt-speed', 648, { mode: 'states', rules: [
      lampRuleSchema.parse({ id: 'low', match: 'range', upper: 1000, label: '低速', color: '#0078D4', fill: { type: 'linear', secondary: '#B9DFFF' } }),
      lampRuleSchema.parse({ id: 'normal', match: 'range', lower: 1000, upper: 2000, label: '正常', color: '#178A4D', fill: { type: 'radial' } }),
      lampRuleSchema.parse({ id: 'high', match: 'range', lower: 2000, label: '高速', color: '#C42B1C' }),
    ] }),
    light('fallback', '未匹配默认状态', 'pt-speed', 856, { mode: 'states', rules: [lampRuleSchema.parse({ id: 'zero', value: 0, label: '零速', color: '#94A3B8' })], fallback: { label: '未定义', color: '#D97706', fill: { type: 'linear' } } }),
    widget({ id: 'controls-heading', kind: 'text', label: '控制标题', text: '状态测试', x: 24, y: 272, width: 320, height: 28, fontSize: 18, color: '#1A1C21' }),
    widget({ id: 'enable', kind: 'switch', label: '运行使能', binding: binding('pt-enable'), x: 24, y: 336, width: 104, height: 50, showLabel: true, showStateText: true }),
    widget({ id: 'mode', kind: 'input', inputMode: 'select', label: '运行模式', binding: binding('pt-mode'), x: 192, y: 336, width: 208, height: 74, showLabel: true }),
    widget({ id: 'speed', kind: 'input', label: '速度设置', binding: binding('pt-speed'), x: 448, y: 336, width: 208, height: 74, showLabel: true, min: 0, max: 3000, limitInput: true }),
    widget({ id: 'slider', kind: 'input', inputMode: 'slider', label: '速度滑块', binding: binding('pt-speed'), x: 24, y: 448, width: 288, height: 74, showLabel: true, min: 0, max: 3000, step: 500 }),
  ];
  workspace.canvases = [canvasSchema.parse(canvas)];
}
const root = path.resolve(`out/test-temp/${buffers ? 'host-buffer-review' : preview ? 'canvas-preview-review' : lamps ? 'canvas-lamp-review' : variants ? 'canvas-variants-review' : 'canvas-compact-review'}`);
fs.mkdirSync(root, { recursive: true });
const output = path.join(root, 'source.workspace.json');
fs.writeFileSync(output, JSON.stringify(workspace, null, 2));
process.stdout.write(`${output}\n`);
