import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasDef, CanvasWidget } from '../../../domain/canvas';
import { parentFrame, widgetMinimum, widgetWorldPosition } from '../../../domain/canvas-geometry';
import { useViewDocument } from '../../workbench/view-context';
import { CanvasWidgetView, WIDGET_LABELS } from './widget';
import { CanvasItem } from './item';
import { canvasTheme } from './style';
import type { WidgetPreview } from './preview';

interface Host { element: HTMLDivElement; ready: boolean }
interface Props {
  canvas: CanvasDef;
  stage: React.RefObject<HTMLDivElement>;
  selected: string[];
  editing: boolean;
  previews?: Record<string, WidgetPreview>;
  active: boolean;
  zoom: number;
  onSelect: (widget: CanvasWidget, shift: boolean) => void;
  onDragStart: (widget: CanvasWidget) => void;
  onDrag: (widget: CanvasWidget, x: number, y: number) => void;
  onDragStop: (widget: CanvasWidget, x: number, y: number) => void;
  onResize: (widget: CanvasWidget, x: number, y: number, width: number, height: number) => void;
}

/** Stable per-widget portals retain control drafts while changing containers/windows. */
export function CanvasScene(props: Props) {
  const viewDocument = useViewDocument();
  const hosts = useRef(new Map<string, Host>());
  const containers = useRef(new Map<string, HTMLDivElement>());
  const [epoch, setEpoch] = useState(0);
  useLayoutEffect(() => {
    let changed = false;
    const valid = new Set(props.canvas.widgets.map(w => w.id));
    for (const [id, host] of hosts.current) {
      if (!valid.has(id)) { host.element.remove(); hosts.current.delete(id); containers.current.delete(id); changed = true; }
    }
    if (props.active) {
      props.canvas.widgets.forEach((w, index) => {
        let host = hosts.current.get(w.id);
        if (!host) {
          const element = viewDocument.createElement('div');
          element.className = 'canvas-widget-host';
          host = { element, ready: false }; hosts.current.set(w.id, host); changed = true;
        }
        const parent = w.parentId ? containers.current.get(w.parentId) : props.stage.current;
        if (parent?.isConnected && host.element.parentElement !== parent) { parent.appendChild(host.element); changed = true; }
        host.element.style.zIndex = String(index + 1);
        if (parent?.isConnected && !host.ready) { host.ready = true; changed = true; }
      });
    }
    if (changed) setEpoch(value => value + 1);
  }, [props.canvas.widgets, props.active, props.stage, viewDocument, epoch]);

  return <>{props.canvas.widgets.map(w => {
    const host = hosts.current.get(w.id);
    if (!host?.ready) return null;
    const min = widgetMinimum(w);
    const children = props.canvas.widgets.filter(child => child.parentId === w.id);
    const minWidth = Math.max(min.width, ...children.map(child => child.x + child.width));
    const minHeight = Math.max(min.height, ...children.map(child => child.y + child.height));
    const frame = parentFrame(props.canvas, w);
    const world = widgetWorldPosition(props.canvas, w);
    return createPortal(<CanvasItem widget={w} frame={frame} minimum={{ width: minWidth, height: minHeight }} zoom={props.zoom}
      grid={props.canvas.grid} origin={{ x: world.x - w.x, y: world.y - w.y }}
      editing={props.editing} selected={props.selected.includes(w.id)}
      onSelect={(widget, shift) => { props.stage.current?.focus({ preventScroll: true }); props.onSelect(widget, shift); }}
      onDragStart={props.onDragStart} onDrag={props.onDrag} onDragStop={props.onDragStop} onResize={props.onResize}>
      <div data-widget-id={w.id} className="h-full w-full" aria-label={`${WIDGET_LABELS[w.kind]}：${w.label}`}>
        {w.kind === 'container' ? <div className={`canvas-container ${props.editing ? 'is-editing' : ''}`} style={{ ...canvasTheme(w), background: w.showBackground ? w.background : undefined, borderRadius: w.borderRadius, outline: w.showBorder || props.editing ? `${w.borderWidth}px ${props.editing ? 'dashed' : 'solid'} ${w.borderColor ?? w.color}` : undefined }}>
          {(props.editing || w.showLabel) && <div className={props.editing ? 'canvas-container-handle' : 'canvas-container-caption'}>{w.label || '容器'}</div>}
          <div className="canvas-container-body" data-container-id={w.id} ref={node => { if (node) containers.current.set(w.id, node); else containers.current.delete(w.id); }} />
        </div> : <CanvasWidgetView widget={w} editing={props.editing} preview={props.editing ? props.previews?.[w.id] : undefined} />}
      </div>
    </CanvasItem>, host.element, w.id);
  })}</>;
}
