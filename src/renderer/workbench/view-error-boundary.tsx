import React from 'react';

/** A failed page must not unmount other windows or the shared data subscription. */
export class ViewErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { console.error('[Workbench view]', error); }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="text-lg font-semibold">此页面暂时无法显示</div><p className="text-sm text-ink2">其他页面和后台设备通信仍可继续使用。</p>
      <button className="focus-ring rounded-ctl bg-accent px-4 py-2 text-sm text-white" onClick={() => this.setState({ failed: false })}>重新加载此页</button>
    </div>;
  }
}
