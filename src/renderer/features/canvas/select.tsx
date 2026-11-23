import React, { useMemo } from 'react';
import * as Select from '@radix-ui/react-select';
import { Checkmark16Regular, ChevronDown16Regular, ChevronUp16Regular } from '@fluentui/react-icons';
import { usePortalRoot, useViewDocument } from '../../workbench/view-context';
import { uid } from '../../uid';
import { canvasTheme } from './style';
import type { CanvasWidget } from '../../../domain/canvas';

export interface CanvasSelectOption { value: string; label: string; disabled?: boolean }
interface Props { label: string; value: string; options: CanvasSelectOption[]; disabled?: boolean; tabIndex?: number; widget?: CanvasWidget; onChange: (value: string) => void }

export function CanvasSelect(props: Props) {
  const portalRoot = usePortalRoot();
  const viewDocument = useViewDocument();
  // Rebind the positioning and keyboard listeners when the retained view changes documents.
  const documentKey = useMemo(() => viewDocument === document ? 'main' : uid('select'), [viewDocument]);
  const selectedIndex = props.options.findIndex(option => option.value === props.value);
  return <Select.Root key={documentKey} value={selectedIndex < 0 ? '' : String(selectedIndex)} disabled={props.disabled}
    onValueChange={index => { const option = props.options[Number(index)]; if (option) props.onChange(option.value); }}>
    <Select.Trigger aria-label={props.label} tabIndex={props.tabIndex} className="canvas-input-field focus-ring flex items-center justify-between gap-1 text-left" data-canvas-select>
      <span className="min-w-0 flex-1 truncate"><Select.Value placeholder="选择…" /></span>
      <Select.Icon className="shrink-0 opacity-60"><ChevronDown16Regular /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={portalRoot}>
      <Select.Content position="popper" side="bottom" align="start" sideOffset={4} collisionPadding={8}
        className="canvas-select-panel" data-canvas-select-menu
        style={{ ...canvasTheme(props.widget, true), width: 'var(--radix-select-trigger-width)', maxHeight: 'min(240px, var(--radix-select-content-available-height))' }}>
        <Select.ScrollUpButton className="flex h-5 items-center justify-center text-ink2"><ChevronUp16Regular /></Select.ScrollUpButton>
        <Select.Viewport>
          {props.options.map((option, index) => <Select.Item key={option.value} value={String(index)} disabled={option.disabled}
            className="canvas-select-option outline-none">
            <Select.ItemText><span className="block truncate" title={option.label}>{option.label}</span></Select.ItemText>
            <Select.ItemIndicator className="shrink-0"><Checkmark16Regular /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="flex h-5 items-center justify-center text-ink2"><ChevronDown16Regular /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
