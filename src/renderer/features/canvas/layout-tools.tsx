import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlignBottom20Regular, AlignCenterHorizontal20Regular, AlignCenterVertical20Regular, AlignLeft20Regular, AlignRight20Regular, AlignSpaceEvenlyHorizontal20Regular, AlignSpaceEvenlyVertical20Regular, AlignTop20Regular, Grid20Regular } from '@fluentui/react-icons';
import type { CanvasGrid } from '../../../domain/canvas';
import type { WidgetAlignment } from './editing';
import { CanvasNumberField } from './number-field';
import { usePortalRoot } from '../../workbench/view-context';

export function CanvasGridSettings({ value, onChange }: { value: CanvasGrid; onChange: (grid: CanvasGrid) => void }) {
  const portalRoot = usePortalRoot();
  return <Popover.Root>
    <Popover.Trigger asChild><button className="canvas-text-tool flex items-center gap-1.5" aria-label="网格设置" title="网格显示与吸附设置"><Grid20Regular />网格 <span className="text-ink2">{value.size} px</span></button></Popover.Trigger>
    <Popover.Portal container={portalRoot}>
      <Popover.Content aria-label="网格设置" align="start" sideOffset={6} collisionPadding={8} onKeyDown={event => event.stopPropagation()} className="z-50 w-64 rounded-ctl border border-line bg-surface p-3 shadow-lg">
        <div className="space-y-3 text-xs text-ink">
          <label className="flex items-center gap-2"><input type="checkbox" className="focus-ring h-4 w-4 accent-accent" checked={value.visible} onChange={event => onChange({ ...value, visible: event.target.checked })} />显示网格</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="focus-ring h-4 w-4 accent-accent" checked={value.snap} onChange={event => onChange({ ...value, snap: event.target.checked })} />吸附网格</label>
          <CanvasNumberField label="网格间距（px）" value={value.size} min={2} max={128} onChange={size => onChange({ ...value, size: Math.round(size) })} />
          <div className="grid grid-cols-5 gap-1">{[4, 8, 16, 24, 32].map(size => <button key={size} aria-label={`网格间距 ${size} 像素`} aria-pressed={value.size === size}
            className={`focus-ring rounded border px-1 py-1.5 ${value.size === size ? 'border-accent bg-accentsoft text-accent' : 'border-line hover:bg-surface2'}`} onClick={() => onChange({ ...value, size })}>{size}</button>)}</div>
          <p className="leading-5 text-ink2">Alt 拖动或缩放可临时自由调整。<br />方向键微调 1 px，Shift+方向键按网格间距移动。</p>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

const alignments = [
  { value: 'left', label: '左对齐', Icon: AlignLeft20Regular },
  { value: 'centerX', label: '水平居中', Icon: AlignCenterHorizontal20Regular },
  { value: 'right', label: '右对齐', Icon: AlignRight20Regular },
  { value: 'top', label: '顶对齐', Icon: AlignTop20Regular },
  { value: 'centerY', label: '垂直居中', Icon: AlignCenterVertical20Regular },
  { value: 'bottom', label: '底对齐', Icon: AlignBottom20Regular },
] as const;

export function CanvasArrangeTools({ count, sameParent, onAlign, onDistribute }: { count: number; sameParent: boolean; onAlign: (alignment: WidgetAlignment) => void; onDistribute: (axis: 'horizontal' | 'vertical') => void }) {
  const portalRoot = usePortalRoot();
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button className="canvas-text-tool flex items-center gap-1.5" aria-label="对齐与分布"><AlignLeft20Regular />对齐</button></DropdownMenu.Trigger>
    <DropdownMenu.Portal container={portalRoot}>
      <DropdownMenu.Content aria-label="对齐与分布" align="start" sideOffset={6} collisionPadding={8} onKeyDown={event => event.stopPropagation()} className="z-50 min-w-[220px] rounded-ctl border border-line bg-surface p-1 shadow-lg">
        <DropdownMenu.Label className="px-2 py-2 text-[11px] text-ink2">{!sameParent ? '请在同一容器内选择控件' : count < 2 ? '选择至少两个控件' : '相对于所选控件范围对齐'}</DropdownMenu.Label>
        {alignments.map(({ value, label, Icon }) => <DropdownMenu.Item key={value} disabled={count < 2 || !sameParent} className="canvas-arrange-item" onSelect={() => onAlign(value)}><Icon />{label}</DropdownMenu.Item>)}
        <DropdownMenu.Separator className="my-1 h-px bg-line" />
        <DropdownMenu.Label className="px-2 py-2 text-[11px] text-ink2">等间距 · 选择至少三个控件 · 首尾固定</DropdownMenu.Label>
        <DropdownMenu.Item disabled={count < 3 || !sameParent} className="canvas-arrange-item" onSelect={() => onDistribute('horizontal')}><AlignSpaceEvenlyHorizontal20Regular />水平等间距</DropdownMenu.Item>
        <DropdownMenu.Item disabled={count < 3 || !sameParent} className="canvas-arrange-item" onSelect={() => onDistribute('vertical')}><AlignSpaceEvenlyVertical20Regular />垂直等间距</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
