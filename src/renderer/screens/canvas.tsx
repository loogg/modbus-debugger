import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Add20Regular, ArrowUndo20Regular, ArrowRedo20Regular, Copy20Regular, Delete20Regular, Save20Regular, Play20Regular, Edit20Regular } from '@fluentui/react-icons';
import { canvasPointBinding, canvasSchema, canvasSignals, diffCanvas, type CanvasDef, type CanvasWidget } from '../../domain/canvas';
import { useApp, useWorkspace } from '../store/app';
import { Button, EmptyState } from '../components/ui';
import { useDirtyGuard, useViewActive, useViewEnvironment, useViewWindow } from '../workbench/view-context';
import { WIDGET_LABELS } from '../features/canvas/widget';
import { CanvasScene } from '../features/canvas/scene';
import { CanvasInspector } from '../features/canvas/inspector';
import { CanvasPreviewInspector } from '../features/canvas/preview-inspector';
import type { WidgetPreview } from '../features/canvas/preview';
import { CanvasNumberField } from '../features/canvas/number-field';
import { CanvasLibraryControls } from '../features/canvas/library';
import { CanvasBackground } from '../features/canvas/background';
import { GAUGE_STYLES, INPUT_MODES, parseWidgetPreset, type WidgetPreset } from '../features/canvas/presets';
import { alignWidgets, copyWidgets, dissolveContainers, distributeWidgets, fitWidgets, groupWidgets, moveWidgets, newWidget, pasteWidgets, reparentWidget } from '../features/canvas/editing';
import { descendantIds, parentFrame, selectionRoots, widgetDepth, widgetWorldPosition } from '../../domain/canvas-geometry';
import { uid } from '../uid';
import { useConfirm } from '../workbench/use-confirm';
import { HostDataStatus, HostRefreshControl, useHostData } from '../workbench/host-data';
import { CurveWindowContext, type CurveWindow } from '../features/canvas/curve-window';
import { CanvasArrangeTools, CanvasGridSettings } from '../features/canvas/layout-tools';
import { canvasGridStyle } from '../features/canvas/style';

let clipboard: CanvasWidget[] = [];

export function CanvasScreen() {
  const confirm = useConfirm();
  const workspace = useWorkspace();
  const selectedId = useApp(s => s.selection.canvasId);
  const select = useApp(s => s.select);
  const command = useApp(s => s.command);
  const [dirty, setDirty] = useState(false);
  const viewWindow = useViewWindow();
  const environment = useViewEnvironment();
  const lastKnown = useRef(new Map<string, CanvasDef>());
  const canvases = workspace?.canvases ?? [];
  for (const canvas of canvases) lastKnown.current.set(canvas.id, canvas);
  const id = selectedId ?? canvases[0]?.id;
  const selected = canvases.find(c => c.id === id) ?? (id ? lastKnown.current.get(id) : undefined);
  const canLeave = async () => !(dirty || [...(environment?.guards.values() ?? [])].some(test => test())) || await confirm('当前画布有未提交的编辑。离开将丢弃这些草稿，是否继续？');
  const create = async (copy?: CanvasDef) => {
    if (!(await canLeave())) return;
    const ids = new Map(copy?.widgets.map(w => [w.id, uid('widget')]) ?? []);
    const canvas = canvasSchema.parse(copy ? { ...copy, id: uid('canvas'), name: `${copy.name.slice(0, 197)} 副本`, revision: 0, widgets: copy.widgets.map(w => ({ ...w, id: ids.get(w.id)!, parentId: w.parentId ? ids.get(w.parentId)! : null })) } : { id: uid('canvas'), name: `画布 ${canvases.length + 1}` });
    const result = await command<CanvasDef[]>({ type: 'canvas.create', canvas });
    if (result.ok) { lastKnown.current.set(canvas.id, canvas); select({ canvasId: canvas.id }); setDirty(false); }
  };
  const remove = async () => {
    if (!selected || !(await confirm(`删除画布“${selected.name}”？其他页面的设备通信会继续运行。`, '删除画布', '删除画布'))) return;
    const result = await command({ type: 'canvas.delete', canvasId: selected.id, expectedRevision: selected.revision });
    if (result.ok) { lastKnown.current.delete(selected.id); select({ canvasId: canvases.find(c => c.id !== selected.id)?.id ?? null }); setDirty(false); }
  };
  return <main className="flex min-w-0 flex-1">
    <aside className="canvas-library">
      <div className="mb-4 flex items-center justify-between"><h1 className="text-lg font-bold">组态画布</h1><button className="workbench-tool" aria-label="新建画布" title="新建画布" onClick={() => void create()}><Add20Regular /></button></div>
      <div className="space-y-1" aria-label="画布列表">{canvases.map(c => <button key={c.id} className={`focus-ring w-full truncate rounded-ctl px-3 py-2 text-left text-sm ${c.id === id ? 'bg-accentsoft font-medium text-accent' : 'hover:bg-surface'}`} onClick={async () => { if (c.id !== id && await canLeave()) { select({ canvasId: c.id }); setDirty(false); } }} title={c.name}>{c.name}</button>)}</div>
      {selected && <div className="mt-3 flex gap-3"><button className="focus-ring text-xs text-accent" onClick={() => void create(selected)}>复制画布</button><button className="focus-ring text-xs text-ink2" onClick={() => void remove()}>删除画布</button></div>}
      <div className="mt-6 border-t border-line pt-4 text-xs text-ink2">控件库</div><p className="mt-2 text-xs leading-5 text-ink2">编辑模式下拖到画布，或单击添加。</p>
      <CanvasLibraryControls disabled={!selected} onAdd={preset => viewWindow.dispatchEvent(new CustomEvent('canvas-add-widget', { detail: { preset, canvasId: id, viewId: environment?.portalRoot.dataset.viewId } }))} />
      <p className="mt-6 text-[11px] leading-5 text-ink2">框选或 Shift+单击多选<br />方向键微调 · Delete 删除<br />Ctrl+Z 撤销 · Ctrl+S 保存</p>
    </aside>
    {selected ? <CanvasEditor key={selected.id} source={selected} removed={!canvases.some(c => c.id === selected.id)} onDirty={setDirty} onCopy={draft => void create(draft)} /> : <div className="min-w-0 flex-1"><EmptyState title="创建你的设备操作面板" message="拖入显示与控制组件，绑定工作区中的设备点位。画布可独立弹出到其他显示器。" actions={<Button variant="primary" onClick={() => void create()}><Add20Regular />新建画布</Button>} /></div>}
  </main>;
}

function CanvasEditor({ source, removed, onDirty, onCopy }: { source: CanvasDef; removed: boolean; onDirty: (dirty: boolean) => void; onCopy: (draft: CanvasDef) => void }) {
  const confirm = useConfirm();
  const [base, setBase] = useState(source);
  const [draft, setDraft] = useState(source);
  const [editing, setEditing] = useState(source.widgets.length === 0);
  const [previews, setPreviews] = useState<Record<string, WidgetPreview>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [past, setPast] = useState<CanvasDef[]>([]);
  const [future, setFuture] = useState<CanvasDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState<{ ids: string[]; dx: number; dy: number } | null>(null);
  const dragStart = useRef({ x: 0, y: 0, ids: [] as string[] });
  const [marquee, setMarquee] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const command = useApp(s => s.command);
  const toast = useApp(s => s.toast);
  const viewWindow = useViewWindow();
  const environment = useViewEnvironment();
  const active = useViewActive();
  const [curveWindows, setCurveWindows] = useState<Record<string, CurveWindow>>({});
  const reportCurveWindow = useCallback((id: string, window: CurveWindow | undefined) => {
    setCurveWindows(current => {
      if (JSON.stringify(current[id]) === JSON.stringify(window)) return current;
      const next = { ...current };
      if (window) next[id] = window;
      else delete next[id];
      return next;
    });
  }, []);
  const curveRefs = draft.widgets.filter(widget => widget.kind === 'trend').flatMap(widget => {
    const window = curveWindows[widget.id] ?? { windowMs: widget.windowSec * 1000 };
    return canvasSignals(widget).map(ref => ({ ...ref, ...window }));
  });
  const pointRefs = draft.widgets.flatMap(widget => {
    const binding = canvasPointBinding(widget.binding);
    return binding ? [binding] : [];
  });
  useHostData({ points: [...pointRefs, ...curveRefs], series: curveRefs });
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  useDirtyGuard(dirty);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    const localInput = [...(environment?.guards.values() ?? [])].some(test => test());
    if (active && !dirty && !localInput && source.revision > base.revision) { setBase(source); setDraft(source); setPast([]); setFuture([]); }
  }, [source, base.revision, dirty, active, environment?.guards]);
  const change = useCallback((next: CanvasDef) => {
    if (JSON.stringify(next) === JSON.stringify(draft)) return;
    setPast(list => [...list.slice(-99), draft]); setFuture([]); setDraft(next); setError('');
  }, [draft]);
  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast(past.slice(0, -1)); setFuture([draft, ...future]); setDraft(previous); setError('');
  }, [draft, past, future]);
  const redo = useCallback(() => {
    const next = future[0]; if (!next) return;
    setFuture(future.slice(1)); setPast([...past, draft]); setDraft(next); setError('');
  }, [draft, past, future]);
  const transform = useCallback((edit: () => CanvasDef) => {
    try { const next = canvasSchema.parse(edit()); change(next); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
  }, [change]);
  const addWidget = useCallback((preset: WidgetPreset, x?: number, y?: number, targetParent?: string | null) => {
    const { kind } = preset;
    if (!editing) { toast({ kind: 'info', title: '请先切换到编辑模式' }); return; }
    const chosen = selected.length === 1 ? draft.widgets.find(w => w.id === selected[0]) : undefined;
    const parentId = targetParent !== undefined ? targetParent : chosen?.kind === 'container' ? chosen.id : chosen?.parentId ?? null;
    const parent = draft.widgets.find(w => w.id === parentId);
    const origin = parent ? widgetWorldPosition(draft, parent) : { x: 0, y: 0 };
    const placementStep = draft.grid.snap ? Math.max(16, draft.grid.size) : 16;
    const placementOffset = placementStep * (1 + draft.widgets.filter(widget => widget.parentId === parentId).length % 6);
    try {
      const widget = newWidget(kind, uid('widget'), draft, x === undefined ? placementOffset : x - origin.x, y === undefined ? placementOffset : y - origin.y, parentId, preset);
      widget.label = kind === 'gauge' ? GAUGE_STYLES[widget.gaugeStyle] : kind === 'input' ? INPUT_MODES[widget.inputMode] : kind === 'lamp' && widget.lamp.mode === 'states' ? '多状态灯' : WIDGET_LABELS[kind];
      if (transform(() => ({ ...draft, widgets: [...draft.widgets, widget] }))) setSelected([widget.id]);
    } catch (failure) { toast({ kind: 'error', title: failure instanceof Error ? failure.message : String(failure) }); }
  }, [draft, editing, selected, toast, transform]);
  const duplicate = useCallback((items = copyWidgets(draft, selected)) => {
    if (!items.length) return;
    const copied = pasteWidgets(draft, items, () => uid('widget'));
    if (transform(() => copied.canvas)) setSelected(copied.selected);
  }, [draft, selected, transform]);
  const remove = useCallback(() => { const removed = descendantIds(draft, selected); change({ ...draft, widgets: draft.widgets.filter(w => !removed.has(w.id)) }); setSelected([]); }, [change, draft, selected]);
  const group = useCallback(() => { const id = uid('widget'); if (transform(() => groupWidgets(draft, selected, id))) setSelected([id]); }, [draft, selected, transform]);
  const ungroup = useCallback(() => { if (transform(() => dissolveContainers(draft, selected))) setSelected([]); }, [draft, selected, transform]);
  const fit = useCallback(() => {
    const context = viewWindow.document.createElement('canvas').getContext('2d');
    const family = stage.current ? viewWindow.getComputedStyle(stage.current).fontFamily : 'sans-serif';
    transform(() => fitWidgets(draft, [...descendantIds(draft, selected)], (text, fontSize) => { if (!context) return text.length * fontSize; context.font = `${fontSize}px ${family}`; return context.measureText(text).width; }));
  }, [draft, selected, transform, viewWindow]);
  const save = useCallback(async () => {
    const checked = canvasSchema.safeParse(draft);
    if (!checked.success) { setError(checked.error.issues.map(i => i.message).slice(0, 3).join('；')); return; }
    if (saving) return;
    setSaving(true); setError('');
    const result = await command<CanvasDef[]>({ type: 'canvas.edit', canvasId: base.id, expectedRevision: base.revision, changes: diffCanvas(base, checked.data) });
    setSaving(false);
    if (!result.ok) { setError(result.error); return; }
    const committed = result.value.find(c => c.id === base.id)!;
    setBase(committed); setDraft(committed); setPast([]); setFuture([]);
    toast({ kind: 'success', title: '画布已保存' });
  }, [base, command, draft, saving, toast]);
  const reload = async () => {
    if (dirty && !(await confirm('重新载入会丢弃当前画布草稿，是否继续？'))) return;
    setBase(source); setDraft(source); setPast([]); setFuture([]); setSelected([]); setError('');
  };

  useEffect(() => {
    const handleAdd = (event: Event) => {
      const data = (event as CustomEvent<{ preset: WidgetPreset; canvasId: string; viewId?: string }>).detail;
      if (data.canvasId === source.id && data.viewId === environment?.portalRoot.dataset.viewId && active) addWidget(data.preset);
    };
    viewWindow.addEventListener('canvas-add-widget', handleAdd);
    return () => viewWindow.removeEventListener('canvas-add-widget', handleAdd);
  }, [source.id, environment?.portalRoot, active, addWidget, viewWindow]);
  useEffect(() => {
    if (!active) return;
    const keydown = (e: KeyboardEvent) => {
      if (!editing || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || Boolean(target.closest?.('[role="combobox"], [role="listbox"], [role="option"]'));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (input) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
        if (e.key.toLowerCase() === 'c') { e.preventDefault(); clipboard = copyWidgets(draft, selected); }
        if (e.key.toLowerCase() === 'v') { e.preventDefault(); duplicate(clipboard); }
        if (e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(selectionRoots(draft, draft.widgets.map(w => w.id)).map(w => w.id)); }
        if (e.key.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) ungroup(); else group(); }
      } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
      else if (e.key === 'Escape') setSelected([]);
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); const step = e.shiftKey ? draft.grid.size : 1;
        change(moveWidgets(draft, selected, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
      }
    };
    viewWindow.addEventListener('keydown', keydown);
    return () => viewWindow.removeEventListener('keydown', keydown);
  }, [active, change, draft, duplicate, editing, redo, remove, save, selected, undo, viewWindow, group, ungroup]);

  const displayed = drag ? moveWidgets(draft, drag.ids, drag.dx, drag.dy) : draft;
  const selectedWidget = selected.length === 1 ? draft.widgets.find(w => w.id === selected[0]) : undefined;
  const selectedRoots = selectionRoots(draft, selected);
  useLayoutEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [selectedWidget?.id]);
  const previewCount = draft.widgets.filter(w => previews[w.id]).length;
  const patchWidget = (patch: Partial<CanvasWidget>) => { if (selectedWidget) change({ ...draft, widgets: draft.widgets.map(w => w.id === selectedWidget.id ? { ...w, ...patch } : w) }); };
  const layer = (front: boolean) => {
    const picked = draft.widgets.filter(w => selected.includes(w.id)); const rest = draft.widgets.filter(w => !selected.includes(w.id));
    change({ ...draft, widgets: front ? [...rest, ...picked] : [...picked, ...rest] });
  };
  const localPoint = (e: React.PointerEvent | React.DragEvent) => {
    const rect = stage.current!.getBoundingClientRect(); return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="canvas-header">
      <div className="flex min-w-0 items-center gap-2"><h2 className="truncate text-lg font-bold" title={draft.name}>{draft.name}</h2>{dirty && <span className="shrink-0 text-xs text-warn">未保存</span>}<span className="shrink-0 rounded bg-surface2 px-2 py-1 text-[11px] text-ink2">{editing ? '编辑' : '运行'}</span></div>
      <div className="flex shrink-0 items-center gap-2">{editing && previewCount > 0 && <button className="canvas-text-tool" onClick={() => setPreviews({})}>清除预览 ({previewCount})</button>}<Button size="sm" disabled={saving || (editing && dirty)} title={editing && dirty ? '请先保存或撤销修改再运行' : undefined} onClick={() => { setEditing(!editing); setSelected([]); setPreviews({}); }}>{editing ? <Play20Regular /> : <Edit20Regular />}{editing ? '运行' : '编辑'}</Button>{editing && <Button size="sm" variant="primary" disabled={saving || removed} onClick={() => void save()}><Save20Regular />{saving ? '保存中…' : '保存画布'}</Button>}</div>
    </div>
    {(error || removed || source.revision > base.revision) && <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-line bg-[#FFF4CE] px-4 py-2 text-xs text-ink"><span className="min-w-0 flex-1 break-words">{error || (removed ? '画布已被其他页面删除。当前内容保留，可另存为新画布。' : '画布已有更新。当前草稿保留，请重新载入后编辑。')}</span>{removed ? <button className="focus-ring text-accent" onClick={() => onCopy(draft)}>另存为新画布</button> : <button className="focus-ring text-accent" onClick={reload}>重新载入</button>}</div>}
    <div className="canvas-toolbar">
      {editing && <><button className="workbench-tool" aria-label="撤销" title="撤销 Ctrl+Z" disabled={!past.length} onClick={undo}><ArrowUndo20Regular /></button><button className="workbench-tool" aria-label="重做" title="重做 Ctrl+Y" disabled={!future.length} onClick={redo}><ArrowRedo20Regular /></button><span className="canvas-tool-divider" /><button className="workbench-tool" aria-label="复制所选控件" title="复制所选控件" disabled={!selected.length} onClick={() => duplicate()}><Copy20Regular /></button><button className="workbench-tool" aria-label="删除所选控件" title="删除所选控件" disabled={!selected.length} onClick={remove}><Delete20Regular /></button><button className="canvas-text-tool" disabled={!selected.length} onClick={fit}>适合内容</button><button className="canvas-text-tool" disabled={!selected.length} onClick={group}>建容器</button><button className="canvas-text-tool" disabled={!selected.some(id => draft.widgets.find(w => w.id === id)?.kind === 'container')} onClick={ungroup}>解除容器</button>
        <CanvasArrangeTools count={selectedRoots.length} sameParent={new Set(selectedRoots.map(widget => widget.parentId)).size <= 1} onAlign={alignment => { transform(() => alignWidgets(draft, selected, alignment)); }} onDistribute={axis => { transform(() => distributeWidgets(draft, selected, axis)); }} />
        <button className="canvas-text-tool" disabled={!selected.length} onClick={() => layer(true)}>置顶</button><button className="canvas-text-tool" disabled={!selected.length} onClick={() => layer(false)}>置底</button><CanvasGridSettings value={draft.grid} onChange={grid => change({ ...draft, grid })} /></>}
      <div className="flex-1" /><HostRefreshControl /><CanvasBackground value={draft.background} disabled={!editing} onChange={background => change({ ...draft, background })} /><label className="flex shrink-0 items-center gap-2 text-xs text-ink2">画布缩放<select aria-label="画布缩放" className="focus-ring rounded border border-line bg-surface p-1" value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
    </div>
    <HostDataStatus />
    <div className="flex min-h-0 flex-1">
      <div className="canvas-viewport" data-testid="canvas-viewport">
        <div style={{ width: draft.width * zoom, height: draft.height * zoom, position: 'relative', margin: 24 }}>
          <div ref={stage} tabIndex={0} className={`canvas-stage focus-ring ${editing ? 'is-editing' : ''} ${editing && draft.grid.visible ? 'has-grid' : ''}`} aria-label="组态画布" data-testid="canvas-stage" style={{ width: draft.width, height: draft.height, backgroundColor: draft.background, ...canvasGridStyle(draft), transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            onDragOver={e => { if (editing) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
            onDrop={e => { e.preventDefault(); if (!editing) return; const preset = parseWidgetPreset(e.dataTransfer.getData('application/x-modbus-widget')); if (preset) { const point = localPoint(e); const targetId = (e.target as Element).closest?.('[data-widget-id]')?.getAttribute('data-widget-id'); const target = draft.widgets.find(w => w.id === targetId); addWidget(preset, point.x, point.y, target?.kind === 'container' ? target.id : target?.parentId ?? null); } }}
            onPointerDown={e => { if (!editing || e.target !== stage.current) return; stage.current?.focus({ preventScroll: true }); const point = localPoint(e); if (!e.shiftKey) setSelected([]); setMarquee({ ...point, endX: point.x, endY: point.y }); e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={e => { if (!marquee) return; const end = localPoint(e); const next = { ...marquee, endX: end.x, endY: end.y }; setMarquee(next); const left = Math.min(next.x, next.endX); const top = Math.min(next.y, next.endY); const right = Math.max(next.x, next.endX); const bottom = Math.max(next.y, next.endY); setSelected(selectionRoots(draft, draft.widgets.filter(w => { const p = widgetWorldPosition(draft, w); return w.kind === 'container' ? p.x >= left && p.y >= top && p.x + w.width <= right && p.y + w.height <= bottom : p.x < right && p.x + w.width > left && p.y < bottom && p.y + w.height > top; }).map(w => w.id)).map(w => w.id)); }}
            onPointerUp={() => setMarquee(null)} onPointerCancel={() => setMarquee(null)}>
            {!draft.widgets.length && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink2"><span className="text-lg">从左侧拖入第一个控件</span><span className="text-xs">自由布局 · 绑定设备点位 · 保存后运行</span></div>}
            <CurveWindowContext.Provider value={reportCurveWindow}><CanvasScene canvas={displayed} stage={stage} selected={selected} editing={editing} previews={previews} active={active} zoom={zoom}
              onSelect={(w, shift) => { if (shift) setSelected(list => selectionRoots(draft, list.includes(w.id) ? list.filter(id => id !== w.id) : [...list, w.id]).map(item => item.id)); else if (!selected.includes(w.id)) setSelected([w.id]); }}
              onDragStart={w => { let ids = selectionRoots(draft, selected.includes(w.id) ? selected : [w.id]).map(item => item.id); if (!ids.includes(w.id)) ids = [w.id]; dragStart.current = { x: w.x, y: w.y, ids }; setSelected(ids); }}
              onDrag={(_w, x, y) => setDrag({ ids: dragStart.current.ids, dx: x - dragStart.current.x, dy: y - dragStart.current.y })}
              onDragStop={(_w, x, y) => { change(moveWidgets(draft, dragStart.current.ids, x - dragStart.current.x, y - dragStart.current.y)); setDrag(null); }}
              onResize={(w, x, y, width, height) => { const frame = parentFrame(draft, w); change({ ...draft, widgets: draft.widgets.map(item => item.id === w.id ? { ...item, x: Math.max(0, x), y: Math.max(0, y), width: Math.min(frame.width - Math.max(0, x), width), height: Math.min(frame.height - Math.max(0, y), height) } : item) }); }} /></CurveWindowContext.Provider>
            {marquee && <div className="pointer-events-none absolute z-[501] border border-accent bg-accent/10" style={{ left: Math.min(marquee.x, marquee.endX), top: Math.min(marquee.y, marquee.endY), width: Math.abs(marquee.endX - marquee.x), height: Math.abs(marquee.endY - marquee.y) }} />}
          </div>
        </div>
      </div>
      {editing && <aside ref={inspector} className="canvas-inspector">
        {selectedWidget && <CanvasPreviewInspector widget={selectedWidget} preview={previews[selectedWidget.id]} onChange={preview => setPreviews(current => { const next = { ...current }; if (preview) next[selectedWidget.id] = preview; else delete next[selectedWidget.id]; return next; })} />}
        {selectedWidget ? <CanvasInspector widget={selectedWidget} canvas={draft} onChange={patchWidget} onFit={fit} onReparent={parentId => transform(() => reparentWidget(draft, selectedWidget.id, parentId))} /> : <div className="space-y-4"><div className="text-sm font-semibold">{selected.length > 1 ? `已选择 ${selected.length} 个控件` : '画布属性'}</div>{selected.length > 1 && <p className="text-xs leading-5 text-ink2">可一起移动、对齐、复制或调整图层。</p>}<label className="canvas-field">画布名称<input aria-label="画布名称" value={draft.name} maxLength={200} onChange={e => change({ ...draft, name: e.target.value })} /></label><div className="grid grid-cols-2 gap-3"><CanvasNumberField label="画布宽度" min={320} max={8192} value={draft.width} onChange={value => change({ ...draft, width: Math.round(value) })} /><CanvasNumberField label="画布高度" min={240} max={8192} value={draft.height} onChange={value => change({ ...draft, height: Math.round(value) })} /></div><label className="canvas-field">背景<input aria-label="画布背景色" type="color" value={draft.background} onChange={e => change({ ...draft, background: e.target.value })} /></label><div className="text-xs text-ink2">{draft.widgets.length} 个控件 · {draft.width} × {draft.height}</div></div>}
        <div className="mt-6 border-t border-line pt-4"><div className="mb-2 text-xs font-semibold text-ink2">图层 · 从上到下</div>{[...draft.widgets].reverse().map(w => <button key={w.id} className={`focus-ring mb-1 w-full truncate rounded px-2 py-1.5 text-left text-xs ${selected.includes(w.id) ? 'bg-accentsoft text-accent' : 'hover:bg-surface2'}`} style={{ paddingLeft: 8 + widgetDepth(draft, w) * 12 }} title={w.parentId ? `所属容器：${draft.widgets.find(parent => parent.id === w.parentId)?.label ?? ''}` : undefined} onClick={e => setSelected(selectionRoots(draft, e.shiftKey ? [...new Set([...selected, w.id])] : [w.id]).map(item => item.id))}>{w.label || WIDGET_LABELS[w.kind]}</button>)}</div>
      </aside>}
    </div>
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-surface px-4 text-[11px] text-ink2"><span>{editing ? '编辑模式：设备写入已锁定' : '运行模式：显示设备确认值'}{editing && previewCount > 0 ? ` · 本地预览 ${previewCount} 项` : ''}{selected.length ? ` · 已选 ${selected.length} 项` : ''}</span><span>共享点位数据 · {draft.widgets.length} 个控件</span></div>
  </div>;
}
