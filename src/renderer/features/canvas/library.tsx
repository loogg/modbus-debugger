import React from 'react';
import { Circle20Filled, CircleMultipleConcentric20Regular, CursorClick20Regular, DataLine20Regular, Gauge20Regular, Gauge20Filled, Group20Regular, NumberRow20Regular, Textbox20Regular, TextFont20Regular, ToggleLeft20Regular, ChevronUpDown20Regular, Options20Regular, TextBulletList20Regular, Drop20Regular, ArrowBidirectionalLeftRight20Regular, Ruler20Regular, type FluentIcon } from '@fluentui/react-icons';
import { WIDGET_LABELS } from './widget';
import { GAUGE_STYLES, INPUT_MODES, type WidgetPreset } from './presets';

interface LibraryItem extends WidgetPreset { icon: FluentIcon; label: string }
const sections: { title: string; items: LibraryItem[] }[] = [
  { title: '基础', items: [
    { kind: 'text', icon: TextFont20Regular, label: WIDGET_LABELS.text },
    { kind: 'value', icon: NumberRow20Regular, label: WIDGET_LABELS.value },
    { kind: 'lamp', icon: Circle20Filled, label: WIDGET_LABELS.lamp },
    { kind: 'lamp', lampMode: 'states', icon: CircleMultipleConcentric20Regular, label: '多状态灯' },
    { kind: 'button', icon: CursorClick20Regular, label: WIDGET_LABELS.button },
    { kind: 'switch', icon: ToggleLeft20Regular, label: WIDGET_LABELS.switch },
    { kind: 'trend', icon: DataLine20Regular, label: WIDGET_LABELS.trend },
    { kind: 'container', icon: Group20Regular, label: WIDGET_LABELS.container },
  ] },
  { title: '仪表', items: [
    { kind: 'gauge', gaugeStyle: 'arc', icon: Gauge20Regular, label: GAUGE_STYLES.arc },
    { kind: 'gauge', gaugeStyle: 'dial', icon: Gauge20Filled, label: GAUGE_STYLES.dial },
    { kind: 'gauge', gaugeStyle: 'bar', icon: ArrowBidirectionalLeftRight20Regular, label: GAUGE_STYLES.bar },
    { kind: 'gauge', gaugeStyle: 'vertical', icon: Ruler20Regular, label: GAUGE_STYLES.vertical },
    { kind: 'gauge', gaugeStyle: 'tank', icon: Drop20Regular, label: GAUGE_STYLES.tank },
  ] },
  { title: '输入', items: [
    { kind: 'input', inputMode: 'number', icon: Textbox20Regular, label: INPUT_MODES.number },
    { kind: 'input', inputMode: 'text', icon: TextFont20Regular, label: INPUT_MODES.text },
    { kind: 'input', inputMode: 'select', icon: TextBulletList20Regular, label: INPUT_MODES.select },
    { kind: 'input', inputMode: 'stepper', icon: ChevronUpDown20Regular, label: INPUT_MODES.stepper },
    { kind: 'input', inputMode: 'slider', icon: Options20Regular, label: INPUT_MODES.slider },
  ] },
];

export function CanvasLibraryControls({ disabled, onAdd }: { disabled: boolean; onAdd: (preset: WidgetPreset) => void }) {
  return <div className="mt-3 space-y-3">{sections.map(section => <section key={section.title} aria-label={`${section.title}控件`}>
    <h2 className="mb-1 text-[11px] font-medium text-ink2">{section.title}</h2>
    <div className="grid grid-cols-3 gap-1">{section.items.map(item => {
      const Icon = item.icon;
      const preset: WidgetPreset = { kind: item.kind, gaugeStyle: item.gaugeStyle, inputMode: item.inputMode, lampMode: item.lampMode };
      return <button key={item.label} title={item.label} aria-label={item.label} draggable={!disabled} disabled={disabled}
        className="canvas-library-tool focus-ring" onClick={() => onAdd(preset)}
        onDragStart={event => { event.dataTransfer.setData('application/x-modbus-widget', JSON.stringify(preset)); event.dataTransfer.effectAllowed = 'copy'; }}>
        <Icon aria-hidden="true" className={item.kind === 'lamp' ? 'text-ok' : ''} /><span>{item.label}</span>
      </button>;
    })}</div>
  </section>)}</div>;
}
