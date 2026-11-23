import React, { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { usePortalRoot } from '../../workbench/view-context';

const colors = [
  { name: '纯白', value: '#FFFFFF' },
  { name: '灰白', value: '#F6F7F9' },
  { name: '浅蓝', value: '#EDF5FF' },
  { name: '浅绿', value: '#F0F7F1' },
  { name: '米色', value: '#FFF7E6' },
  { name: '浅紫', value: '#F4F0FF' },
  { name: '淡青', value: '#EAF7F7' },
  { name: '浅粉', value: '#FFF1F3' },
];

export function CanvasBackground({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (color: string) => void }) {
  const portalRoot = usePortalRoot();
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button className="canvas-text-tool flex items-center gap-1.5" disabled={disabled} aria-label="画布背景颜色" title={disabled ? '编辑模式可更改画布背景颜色' : '画布背景颜色'}>
      <span className="h-4 w-4 rounded-sm border border-line" style={{ backgroundColor: value }} aria-hidden="true" />背景
    </button></Popover.Trigger>
    <Popover.Portal container={portalRoot}>
      <Popover.Content aria-label="画布背景颜色" align="end" sideOffset={6} className="z-50 w-56 rounded-ctl border border-line bg-surface p-3 shadow-lg">
        <div className="mb-2 text-xs font-medium text-ink">画布背景</div>
        <div className="grid grid-cols-4 gap-2">
          {colors.map(color => <button key={color.value} className="focus-ring h-8 rounded border border-line outline-offset-2" style={{ backgroundColor: color.value }}
            aria-label={color.name} aria-pressed={value.toUpperCase() === color.value} title={color.name}
            onClick={() => { onChange(color.value); setOpen(false); }}>
            {value.toUpperCase() === color.value && <span aria-hidden="true" className="text-accent">✓</span>}
          </button>)}
        </div>
        <label className="mt-3 flex items-center justify-between gap-2 text-xs text-ink2">自定义颜色<input type="color" aria-label="自定义画布背景色" className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0" value={value} onChange={event => onChange(event.target.value)} /></label>
        <div className="mt-1 font-mono text-[11px] text-ink2">{value.toUpperCase()}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
