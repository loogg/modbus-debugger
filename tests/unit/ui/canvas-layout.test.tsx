import React, { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { canvasGridSchema, canvasWidgetSchema } from '../../../src/domain/canvas';
import { CanvasGridSettings, CanvasArrangeTools } from '../../../src/renderer/features/canvas/layout-tools';
import { CanvasItem } from '../../../src/renderer/features/canvas/item';

vi.mock('re-resizable', () => ({ Resizable: ({ children, handleComponent }: { children: React.ReactNode; handleComponent?: { bottomRight: React.ReactNode } }) => <div>{children}<span data-testid="resize-handle">{handleComponent?.bottomRight}</span></div> }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('configures visibility and snapping independently and bounds custom spacing', () => {
  function Controls() {
    const [grid, setGrid] = useState(canvasGridSchema.parse({}));
    return <><output data-testid="grid">{JSON.stringify(grid)}</output><CanvasGridSettings value={grid} onChange={setGrid} /></>;
  }
  render(<Controls />);
  fireEvent.click(screen.getByRole('button', { name: '网格设置' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '显示网格' }));
  expect(JSON.parse(screen.getByTestId('grid').textContent!)).toEqual({ visible: false, snap: true, size: 8 });
  fireEvent.click(screen.getByRole('button', { name: '网格间距 16 像素' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '吸附网格' }));
  const field = screen.getByRole('spinbutton', { name: '网格间距（px）' });
  fireEvent.change(field, { target: { value: '1000' } }); fireEvent.blur(field);
  expect(JSON.parse(screen.getByTestId('grid').textContent!)).toEqual({ visible: false, snap: false, size: 128 });
  fireEvent.change(field, { target: { value: '' } }); fireEvent.blur(field);
  expect(field).toHaveValue(128);
});

it('exposes six alignments and spacing actions with selection requirements and scoped keyboard events', () => {
  const align = vi.fn(); const distribute = vi.fn(); const keydown = vi.fn();
  window.addEventListener('keydown', keydown);
  try {
    const { rerender } = render(<CanvasArrangeTools count={1} sameParent onAlign={align} onDistribute={distribute} />);
    const open = () => fireEvent.pointerDown(screen.getByRole('button', { name: '对齐与分布' }), { button: 0, ctrlKey: false });
    open();
    expect(screen.getByRole('menuitem', { name: '垂直居中' })).toHaveAttribute('data-disabled');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(keydown).not.toHaveBeenCalled();
    rerender(<CanvasArrangeTools count={3} sameParent onAlign={align} onDistribute={distribute} />);
    fireEvent.click(screen.getByRole('menuitem', { name: '垂直居中' }));
    expect(align).toHaveBeenCalledWith('centerY');
    open(); fireEvent.click(screen.getByRole('menuitem', { name: '水平等间距' }));
    expect(distribute).toHaveBeenCalledWith('horizontal');
    rerender(<CanvasArrangeTools count={3} sameParent={false} onAlign={align} onDistribute={distribute} />);
    open();
    expect(screen.getByRole('menuitem', { name: '左对齐' })).toHaveAttribute('data-disabled');
    expect(screen.getByText('请在同一容器内选择控件')).toBeInTheDocument();
  } finally { window.removeEventListener('keydown', keydown); }
});

function item(snap = true, zoom = .75) {
  const widget = canvasWidgetSchema.parse({ id: 'lamp', kind: 'lamp', label: '', x: 41, y: 59, width: 24, height: 24 });
  const onDrag = vi.fn(); const onDragStop = vi.fn(); const onSelect = vi.fn();
  const result = render(<CanvasItem widget={widget} editing selected zoom={zoom} grid={canvasGridSchema.parse({ size: 16, snap })} origin={{ x: 7, y: 11 }}
    frame={{ width: 800, height: 600 }} minimum={{ width: 16, height: 16 }} onSelect={onSelect} onDragStart={vi.fn()} onDrag={onDrag} onDragStop={onDragStop} onResize={vi.fn()}><span>lamp</span></CanvasItem>);
  const target = result.container.querySelector('[data-canvas-interaction]')!;
  return { target, widget, onDrag, onDragStop, onSelect };
}

it('snaps real pointer deltas through zoom and a nested container origin', () => {
  const h = item();
  fireEvent.pointerDown(h.target, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(h.target, { clientX: 115, clientY: 109, pointerId: 1 });
  expect(h.onDrag).toHaveBeenLastCalledWith(h.widget, 57, 69);
  fireEvent.pointerUp(h.target, { clientX: 115, clientY: 109, pointerId: 1 });
  expect(h.onDragStop).toHaveBeenCalledTimes(1);
  expect(h.onDragStop).toHaveBeenLastCalledWith(h.widget, 57, 69);
});

it.each([false, true])('supports free movement when snapping is disabled or Alt is held (%s)', alt => {
  const h = item(alt);
  fireEvent.pointerDown(h.target, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(h.target, { clientX: 115, clientY: 109, pointerId: 1, altKey: alt });
  fireEvent.pointerUp(h.target, { clientX: 115, clientY: 109, pointerId: 1, altKey: alt });
  expect(h.onDragStop).toHaveBeenCalledTimes(1);
  expect(h.onDragStop).toHaveBeenLastCalledWith(h.widget, 61, 71);
});

it('selects an off-grid control without moving it and restores a cancelled gesture', () => {
  const h = item();
  fireEvent.pointerDown(h.target, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(h.target, { clientX: 100, clientY: 100, pointerId: 1 });
  expect(h.onDrag).not.toHaveBeenCalled();
  expect(h.onDragStop).toHaveBeenLastCalledWith(h.widget, 41, 59);
  fireEvent.pointerDown(h.target, { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
  fireEvent.pointerMove(h.target, { clientX: 115, clientY: 109, pointerId: 2 });
  fireEvent.pointerCancel(h.target, { pointerId: 2 });
  expect(h.onDragStop).toHaveBeenLastCalledWith(h.widget, 41, 59);
  fireEvent.lostPointerCapture(h.target, { pointerId: 2 });
  expect(h.onDragStop).toHaveBeenCalledTimes(2);
});

it('keeps resize-handle pointer events from starting an ancestor container drag', () => {
  const parentDrag = vi.fn();
  const widget = canvasWidgetSchema.parse({ id: 'lamp', kind: 'lamp', label: '', x: 41, y: 59, width: 24, height: 24 });
  render(<div onPointerDown={parentDrag}><CanvasItem widget={widget} editing selected zoom={1} grid={canvasGridSchema.parse({})} origin={{ x: 0, y: 0 }} frame={{ width: 800, height: 600 }} minimum={{ width: 16, height: 16 }} onSelect={vi.fn()} onDragStart={vi.fn()} onDrag={vi.fn()} onDragStop={vi.fn()} onResize={vi.fn()}><span>lamp</span></CanvasItem></div>);
  fireEvent.pointerDown(screen.getByTestId('resize-handle').firstElementChild!, { button: 0, pointerId: 1 });
  expect(parentDrag).not.toHaveBeenCalled();
});
