import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Add20Regular, Copy20Regular, Dismiss16Regular, Open20Regular, ArrowLeft20Regular } from '@fluentui/react-icons';
import { appStore, AppStoreContext, createViewStore, useApp, type AppStore } from '../store/app';
import type { ModuleId, WorkbenchLayout, WorkbenchView } from '../../shared/workbench';
import { ViewEnvironmentContext, type ViewEnvironment } from './view-context';
import { uid } from '../uid';
import { useConfirm } from './use-confirm';
import { ViewErrorBoundary } from './view-error-boundary';

export const MODULE_LABELS: Record<ModuleId, string> = { devices: '设备连接', realtime: '实时监控', trend: '趋势', history: '历史', comm: '通信诊断', templates: '模板', canvas: '组态画布', scripts: '主站脚本', settings: '设置', about: '关于' };
export interface NavigationProps { module: ModuleId; onActivate: (module: ModuleId) => void; onNew: (module: ModuleId) => void }
interface View {
  id: string;
  store: AppStore;
  dispose: () => void;
  connect: () => void;
  mount: HTMLDivElement;
  guards: ViewEnvironment['guards'];
  popup: Window | null;
  opening: boolean;
  mounted: boolean;
  stopWaiting?: () => void;
}

function makeView(saved: WorkbenchView): View {
  const { store, connect, dispose } = createViewStore(saved);
  const mount = document.createElement('div');
  mount.className = 'workbench-view';
  mount.id = `pane-${saved.id}`;
  mount.setAttribute('role', 'tabpanel');
  mount.dataset.viewId = saved.id;
  return { id: saved.id, store, connect, dispose, mount, guards: new Map(), popup: null, opening: false, mounted: false };
}
function isDirty(view: View) { return Boolean(view.store.getState().overlay) || [...view.guards.values()].some(test => test()); }
function title(view: View) {
  const { module, selection, snapshot } = view.store.getState();
  const ws = snapshot?.workspace;
  const name = module === 'canvas' ? ws?.canvases?.find(c => c.id === selection.canvasId)?.name
    : module === 'scripts' ? ws?.masterScripts?.find(script => script.id === selection.scriptId)?.name
    : module === 'realtime' || module === 'devices' ? ws?.slaves.find(s => s.id === selection.slaveId)?.name
    : module === 'trend' ? ws?.trendGroups.find(g => g.id === selection.groupId)?.name
    : module === 'templates' ? ws?.templates.find(t => t.id === selection.templateId)?.name : null;
  return `${MODULE_LABELS[module]}${name ? ` · ${name}` : ''}`;
}
function moveMount(view: View, target: HTMLElement) {
  const scroll = [...view.mount.querySelectorAll<HTMLElement>('*')].filter(n => n.scrollTop || n.scrollLeft).map(n => ({ n, top: n.scrollTop, left: n.scrollLeft }));
  target.appendChild(view.mount);
  for (const { n, top, left } of scroll) { n.scrollTop = top; n.scrollLeft = left; }
}

export function Workbench(props: { navigation: React.ComponentType<NavigationProps>; header: React.ComponentType; page: React.ComponentType }) {
  const confirm = useConfirm();
  const initial = useRef(appStore.getState().snapshot?.workspace.workbench);
  const [views, setViews] = useState<View[]>(() => (initial.current?.views.length ? initial.current.views : [{ id: uid('view'), module: appStore.getState().module, selection: { ...appStore.getState().selection } }]).map(makeView));
  const [activeId, setActiveId] = useState(initial.current?.activeId ?? views[0]?.id ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [, refresh] = useState(0);
  const parking = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = useRef({ views, activeId });
  current.current = { views, activeId };
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const toast = useApp(s => s.toast);

  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const { views: list, activeId: active } = current.current;
      const layout: WorkbenchLayout = { activeId: active, views: list.map(v => ({ id: v.id, module: v.store.getState().module, selection: { ...v.store.getState().selection } })) };
      void appStore.getState().command({ type: 'workbench.saveLayout', layout });
    }, 300);
  }, []);

  const dock = useCallback((view: View, closeWindow = true) => {
    view.stopWaiting?.();
    const popup = view.popup;
    view.popup = null;
    view.opening = false;
    if (parking.current) moveMount(view, parking.current);
    view.mount.style.display = 'flex';
    if (alive.current) { setActiveId(view.id); refresh(x => x + 1); }
    if (closeWindow && popup && !popup.closed) {
      const native = appStore.getState().api?.windows;
      if (native) void native.close(view.id);
      else popup.close();
    }
    persist();
  }, [persist]);

  const detach = useCallback((view: View) => {
    if (view.popup && !view.popup.closed) { view.popup.focus(); return; }
    if (view.opening) return;
    const url = new URL(window.location.href);
    url.search = `?viewHost=${encodeURIComponent(view.id)}`;
    url.hash = '';
    const popup = window.open(url.toString(), `modbus-${view.id}`, 'popup,width=1280,height=860');
    if (!popup) { toast({ kind: 'error', title: '无法打开窗口', message: '请允许此页面打开独立窗口后重试。' }); return; }
    view.opening = true;
    view.popup = popup;
    refresh(x => x + 1);
    const started = Date.now();
    const wait = setInterval(() => {
      if (popup.closed || Date.now() - started > 15000) {
        clearInterval(wait);
        dock(view);
        toast({ kind: 'error', title: '独立窗口未就绪，页面已保留在主窗口' });
        return;
      }
      try {
        if (!popup.document.documentElement.dataset.viewHost) return;
        const root = popup.document.getElementById('root');
        if (!root) return;
        clearInterval(wait);
        view.opening = false;
        popup.document.title = `${title(view)} — Modbus Debugger`;
        moveMount(view, root);
        view.mount.style.display = 'flex';
        popup.addEventListener('beforeunload', () => { if (view.popup === popup && alive.current) dock(view); });
        refresh(x => x + 1);
        popup.focus();
        persist();
      } catch { /* Same-origin host is still navigating. */ }
    }, 50);
    view.stopWaiting = () => clearInterval(wait);
  }, [dock, persist, toast]);

  const add = (module: ModuleId, source?: View, selection?: WorkbenchView['selection']) => {
    if (views.length >= 40) { toast({ kind: 'warning', title: '最多同时打开 40 个页面，请先关闭不需要的页面' }); return; }
    const view = makeView({ id: uid('view'), module, selection: selection ?? (source ? { ...source.store.getState().selection } : {}) });
    if (source) {
      const from = source.store.getState();
      view.store.setState({ sidebarWidth: from.sidebarWidth, commSlaveFilter: { ...from.commSlaveFilter }, commResultFilter: { ...from.commResultFilter } });
    }
    setViews(list => [...list, view]); setActiveId(view.id); setMenuOpen(false);
  };
  const activate = (module: ModuleId) => {
    const existing = [...views].reverse().find(v => v.store.getState().module === module);
    if (!existing) add(module);
    else { setActiveId(existing.id); existing.popup?.focus(); }
  };
  const openTarget: NonNullable<ViewEnvironment['openTarget']> = (module, selection) => {
    const key = module === 'canvas' ? 'canvasId' : 'scriptId';
    const existing = views.find(v => {
      const state = v.store.getState();
      if (state.module !== module) return false;
      const workspace = state.snapshot?.workspace;
      const displayed = state.selection[key] ?? (module === 'canvas' ? workspace?.canvases?.[0]?.id : workspace?.masterScripts?.[0]?.id);
      return displayed === selection[key];
    });
    if (!existing) { add(module, undefined, selection); return; }
    existing.store.getState().select(selection); setActiveId(existing.id);
    if (existing.popup) existing.popup.focus(); else window.focus();
  };
  const close = async (view: View) => {
    if (isDirty(view) && !(await confirm('此页面有未提交的编辑。关闭页面将丢弃草稿，是否继续？', '丢弃并关闭'))) return;
    const latest = current.current;
    if (!latest.views.includes(view)) return;
    if (view.popup) dock(view);
    view.stopWaiting?.(); view.dispose(); view.mount.remove();
    setViews(list => list.filter(v => v !== view));
    setActiveId(latest.activeId === view.id ? latest.views.find(v => v !== view && !v.popup)?.id ?? null : latest.activeId);
  };

  useLayoutEffect(() => {
    let addedContent = false;
    document.getElementById(`tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    for (const view of views) {
      view.mount.setAttribute('aria-label', title(view));
      if (!view.popup || view.opening) {
        if (parking.current && view.mount.parentElement !== parking.current) moveMount(view, parking.current);
        view.mount.style.display = view.id === activeId ? 'flex' : 'none';
        // Geometry consumers (resizers/virtualizers/charts) must first mount inside a
        // connected, visible container. Thereafter retain them while switching/docking.
        if (view.id === activeId && !view.mounted) { view.mounted = true; addedContent = true; }
      }
    }
    if (addedContent) refresh(value => value + 1);
    persist();
  }, [views, activeId, persist]);
  useEffect(() => {
    views.forEach(v => v.connect());
    const subscriptions = views.map(v => v.store.subscribe((next, previous) => {
      if (next.module !== previous.module || next.selection !== previous.selection || next.snapshot?.workspace !== previous.snapshot?.workspace) {
        v.mount.setAttribute('aria-label', title(v));
        if (v.popup && !v.popup.closed && !v.opening) v.popup.document.title = `${title(v)} — Modbus Debugger`;
        refresh(x => x + 1);
        if (next.module !== previous.module || next.selection !== previous.selection) persist();
      }
    }));
    return () => { subscriptions.forEach(stop => stop()); views.forEach(v => v.dispose()); };
  }, [views, persist]);
  useEffect(() => {
    alive.current = true;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current.views.some(isDirty)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const off = appStore.getState().api?.windows?.onCloseRequest(id => {
      const view = current.current.views.find(v => v.id === id);
      if (view) dock(view);
    });
    return () => { alive.current = false; window.removeEventListener('beforeunload', onBeforeUnload); off?.(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dock]);

  const active = views.find(v => v.id === activeId);
  const moveTabFocus = (event: React.KeyboardEvent, index: number) => {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const next = views[key === 'Home' ? 0 : key === 'End' ? views.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
    if (!next) return;
    setActiveId(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [menuOpen]);
  const Navigation = props.navigation;
  const Header = props.header;
  const Page = props.page;
  return <div className="flex h-full flex-col">
    <Header />
    <div className="flex min-h-0 flex-1">
      <Navigation module={active?.store.getState().module ?? 'devices'} onActivate={activate} onNew={module => add(module)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="workbench-tabs" aria-label="工作页面">
          <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist">
            {views.map((view, index) => <div key={view.id} className={`workbench-tab ${activeId === view.id ? 'is-active' : ''}`}>
              <button id={`tab-${view.id}`} role="tab" aria-selected={activeId === view.id} aria-controls={view.popup && !view.opening ? undefined : `pane-${view.id}`} tabIndex={activeId === view.id ? 0 : -1} title={title(view)} className="focus-ring min-w-0 truncate px-3 py-2" onKeyDown={event => moveTabFocus(event, index)} onClick={() => { setActiveId(view.id); view.popup?.focus(); }}>{view.popup && !view.opening ? '↗ ' : ''}{title(view)}</button>
              <button className="focus-ring mr-1 shrink-0 rounded p-1 hover:bg-surface2" aria-label={`关闭 ${title(view)}`} onClick={() => close(view)}><Dismiss16Regular /></button>
            </div>)}
          </div>
          <div ref={menu} className="relative flex shrink-0 items-center gap-1 px-2">
            <button className="workbench-tool" title="新建页面" aria-label="新建页面" onClick={() => setMenuOpen(!menuOpen)}><Add20Regular /></button>
            <button className="workbench-tool" title="打开当前页面副本" aria-label="打开当前页面副本" disabled={!active} onClick={() => active && add(active.store.getState().module, active)}><Copy20Regular /></button>
            <button className="workbench-tool" title={active?.popup ? '回入主窗口' : '弹出当前页面'} aria-label={active?.popup ? '回入主窗口' : '弹出当前页面'} disabled={!active || active.opening} onClick={() => active && (active.popup ? dock(active) : detach(active))}>{active?.popup ? <ArrowLeft20Regular /> : <Open20Regular />}</button>
            {menuOpen && <div className="absolute right-2 top-full z-30 w-44 rounded-ctl border border-line bg-surface p-1 shadow-lg" onKeyDown={e => e.key === 'Escape' && setMenuOpen(false)}>{Object.entries(MODULE_LABELS).map(([module, label]) => <button className="focus-ring block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface2" key={module} onClick={() => add(module as ModuleId)}>{label}</button>)}</div>}
          </div>
        </div>
        <div className="relative min-h-0 flex-1" ref={parking}>
          {!active && <div className="flex h-full items-center justify-center text-sm text-ink2">从左侧打开页面，或使用上方“新建页面”。</div>}
          {active?.popup && !active.opening && <div className="flex h-full flex-col items-center justify-center gap-4 text-sm text-ink2"><span>{title(active)} 已在独立窗口打开</span><div className="flex gap-4"><button className="text-accent focus-ring" onClick={() => active.popup?.focus()}>定位窗口</button><button className="text-accent focus-ring" onClick={() => dock(active)}>回入主窗口</button></div></div>}
        </div>
      </div>
    </div>
    {views.filter(view => view.mounted).map(view => createPortal(<AppStoreContext.Provider value={view.store}>
      <ViewEnvironmentContext.Provider value={{ document: view.mount.ownerDocument, portalRoot: view.mount, active: Boolean(view.popup) || view.id === activeId, guards: view.guards, openTarget }}>
        {view.popup && !view.opening && <div className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface px-4 text-sm"><span className="truncate">{title(view)}</span><button className="focus-ring ml-4 flex shrink-0 items-center gap-1 text-accent" onClick={() => dock(view)}><ArrowLeft20Regular />回入主窗口</button></div>}
        <ViewErrorBoundary><Page /></ViewErrorBoundary>
      </ViewEnvironmentContext.Provider>
    </AppStoreContext.Provider>, view.mount, view.id))}
  </div>;
}
