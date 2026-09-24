import React, { useEffect, useState } from 'react';
import type { AppTransport, TransportState } from '../transport/types';

interface DevReviewIndicatorProps {
  transport: AppTransport;
}

export function DevReviewIndicator({ transport }: DevReviewIndicatorProps): React.JSX.Element | null {
  const [state, setState] = useState<TransportState>(transport.getStatus());
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewport, setViewport] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  });

  useEffect(() => {
    const unsub = transport.onStatusChange((s) => setState(s));
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => {
      unsub();
      window.removeEventListener('resize', onResize);
    };
  }, [transport]);

  // Do not show in native Electron unless forced with ?transport=
  const isNativeElectron = state.type === 'electron' && typeof window !== 'undefined' && !window.location.search.includes('transport');
  if (isNativeElectron) return null;

  const breakpoint = viewport.width < 1280 ? 'Compact (<1280px)' : 'Standard (≥1280px)';

  const switchMode = (transportType: 'bridge' | 'mock', fixture?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('transport', transportType);
    if (fixture) {
      url.searchParams.set('fixture', fixture);
    } else {
      url.searchParams.delete('fixture');
    }
    window.location.href = url.toString();
  };

  const statusColor =
    state.status === 'connected'
      ? 'bg-emerald-500'
      : state.status === 'connecting'
        ? 'bg-amber-500 animate-ping'
        : 'bg-rose-500';

  if (collapsed) {
    return (
      <button
        type="button"
        title="展开 Browser Review 工具条"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-2 right-2 z-50 flex h-7 items-center gap-1.5 rounded-full border border-slate-300 bg-white/95 px-2.5 text-xs font-medium text-slate-700 shadow-md backdrop-blur transition hover:bg-slate-100"
      >
        <span className={`h-2 w-2 rounded-full ${statusColor}`} />
        <span>Review</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 select-none font-sans text-xs">
      <div className="flex items-center gap-2 rounded-lg border border-slate-300/80 bg-white/95 px-3 py-1.5 text-slate-700 shadow-lg backdrop-blur">
        <span className="relative flex h-2 w-2">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
        </span>

        <span className="font-semibold text-slate-900">
          {state.type === 'bridge' ? 'Bridge' : `Mock (${state.fixture ?? 'default'})`}
        </span>

        <span className="text-[11px] text-slate-500">
          {state.status === 'connected' ? '已连接' : state.status === 'connecting' ? '连接中…' : '未连接'}
        </span>

        <span className="text-slate-300">|</span>

        <span className="font-mono text-[11px] text-slate-600" title={`当前窗口断点：${breakpoint}`}>
          {viewport.width}×{viewport.height}
        </span>

        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="ml-1 rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-200"
          title="切换模式与预设"
        >
          {menuOpen ? '收起 ▲' : '切换 ▼'}
        </button>

        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="ml-0.5 text-slate-400 hover:text-slate-600"
          title="最小化"
        >
          ✕
        </button>
      </div>

      {menuOpen && (
        <div className="mt-1.5 w-64 rounded-lg border border-slate-200 bg-white p-2.5 text-slate-800 shadow-xl">
          <div className="mb-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
            Review 模式选择
          </div>

          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => switchMode('bridge')}
              className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-xs transition ${
                state.type === 'bridge' ? 'bg-blue-50 font-semibold text-blue-700' : 'hover:bg-slate-100'
              }`}
            >
              <span>真实 Dev Bridge (WS 5174)</span>
              {state.type === 'bridge' && <span className="text-blue-600">✓</span>}
            </button>

            <div className="my-1 border-t border-slate-100" />
            <div className="px-2 py-0.5 text-[10px] text-slate-400">Mock / Fixture 预设：</div>

            {[
              { id: 'default', label: '标准预设 (Default Workspace)' },
              { id: 'empty', label: '空状态 (Empty Workspace)' },
              { id: 'large-data', label: '大数据量 (300+ 点位高频)' },
              { id: 'error', label: '错误状态 (Operation Error)' },
              { id: 'timeout', label: '超时状态 (Timeout 5s)' },
            ].map((fix) => (
              <button
                key={fix.id}
                type="button"
                onClick={() => switchMode('mock', fix.id)}
                className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-xs transition ${
                  state.type === 'mock' && state.fixture === fix.id
                    ? 'bg-blue-50 font-semibold text-blue-700'
                    : 'hover:bg-slate-100'
                }`}
              >
                <span>{fix.label}</span>
                {state.type === 'mock' && state.fixture === fix.id && <span className="text-blue-600">✓</span>}
              </button>
            ))}
          </div>

          <div className="mt-2.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
            断点：<span className="font-medium text-slate-700">{breakpoint}</span>
          </div>
        </div>
      )}
    </div>
  );
}
