import React, { useRef, useState } from 'react';
import { Resizable } from 're-resizable';
import type { CanvasGrid, CanvasWidget } from '../../../domain/canvas';
import { resizeCanvasRect, snapCanvasCoordinate, type CanvasPoint, type CanvasRect } from '../../../domain/canvas-grid';

interface Props {
  widget: CanvasWidget;
  editing: boolean;
  selected: boolean;
  zoom: number;
  grid: CanvasGrid;
  origin: CanvasPoint;
  frame: { width: number; height: number };
  minimum: { width: number; height: number };
  onSelect: (widget: CanvasWidget, shift: boolean) => void;
  onDragStart: (widget: CanvasWidget) => void;
  onDrag: (widget: CanvasWidget, x: number, y: number) => void;
  onDragStop: (widget: CanvasWidget, x: number, y: number) => void;
  onResize: (widget: CanvasWidget, x: number, y: number, width: number, height: number) => void;
  children: React.ReactNode;
}

// Resize starts on mouse/touch down. Keep the preceding pointer event inside the child.
const resizeHandle = <div className="h-full w-full" onPointerDown={event => event.stopPropagation()} />;
const resizeHandles = { top: resizeHandle, right: resizeHandle, bottom: resizeHandle, left: resizeHandle,
  topRight: resizeHandle, bottomRight: resizeHandle, bottomLeft: resizeHandle, topLeft: resizeHandle };

/** Pointer capture works on adopted DOM nodes without cross-window instanceof checks. */
export function CanvasItem(props: Props) {
  const { widget, frame, minimum } = props;
  const drag = useRef<{ widget: CanvasWidget; pointerId: number; clientX: number; clientY: number; moved: boolean } | null>(null);
  const resizeStart = useRef<CanvasWidget | null>(null);
  const [resizePreview, setResizePreview] = useState<CanvasRect | null>(null);
  const rect = resizePreview ?? widget;
  const dragPosition = (event: React.PointerEvent) => {
    const start = drag.current!;
    return {
      x: snapCanvasCoordinate(start.widget.x + (event.clientX - start.clientX) / props.zoom, props.origin.x, props.grid, event.altKey),
      y: snapCanvasCoordinate(start.widget.y + (event.clientY - start.clientY) / props.zoom, props.origin.y, props.grid, event.altKey),
    };
  };
  const finishDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const position = cancelled || !start.moved ? start.widget : dragPosition(event);
    drag.current = null;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    props.onDragStop(start.widget, position.x, position.y);
  };
  return <Resizable size={{ width: rect.width, height: rect.height }} bounds="parent" scale={props.zoom}
    handleComponent={resizeHandles}
    minWidth={minimum.width} minHeight={minimum.height} maxWidth={frame.width} maxHeight={frame.height}
    enable={props.editing && props.selected ? undefined : false}
    handleClasses={{ right: 'canvas-resize-right', bottomRight: 'canvas-resize-bottom-right' }}
    className={`canvas-item ${props.editing && props.selected ? 'canvas-selected' : ''}`}
    style={{ position: 'absolute', top: 0, left: 0, transform: `translate(${rect.x}px, ${rect.y}px)` }}
    onResizeStart={() => { resizeStart.current = widget; }}
    onResize={(event, direction, _element, delta) => setResizePreview(resizeCanvasRect(resizeStart.current ?? widget, direction, delta, frame, minimum, props.origin, props.grid, event.altKey))}
    onResizeStop={(event, direction, _element, delta) => {
      const base = resizeStart.current ?? widget;
      const next = resizeCanvasRect(base, direction, delta, frame, minimum, props.origin, props.grid, event.altKey);
      resizeStart.current = null;
      setResizePreview(null);
      props.onResize(base, next.x, next.y, next.width, next.height);
    }}>
    <div className="h-full w-full" data-canvas-interaction={props.editing ? 'edit' : 'run'}
      onPointerDown={event => {
        if (!props.editing || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(widget, event.shiftKey);
        if (event.shiftKey) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { widget, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false };
        props.onDragStart(widget);
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        if (!drag.current.moved && Math.hypot(event.clientX - drag.current.clientX, event.clientY - drag.current.clientY) < 3) return;
        drag.current.moved = true;
        event.stopPropagation();
        const position = dragPosition(event);
        props.onDrag(drag.current.widget, position.x, position.y);
      }}
      onPointerUp={event => finishDrag(event)}
      onPointerCancel={event => finishDrag(event, true)}
      onLostPointerCapture={event => finishDrag(event, true)}>{props.children}</div>
  </Resizable>;
}
