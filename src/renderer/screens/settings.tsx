import React from 'react';
import { useApp, useHistoryDbPath, usePrefs, useSnapshotReady, useWorkspace, useWorkspacePath } from '../store/app';
import { Button, Checkbox, InfoBand, PageHeader, SectionTitle, StatusDot, TextInput } from '../components/ui';

export function SettingsScreen() {
  const ready = useSnapshotReady();
  const workspace = useWorkspace();
  const prefsSlice = usePrefs();
  const workspacePath = useWorkspacePath();
  const historyDbPath = useHistoryDbPath();
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const openOverlay = useApp((s) => s.openOverlay);
  if (!ready || !workspace || !prefsSlice) return null;
  const prefs = prefsSlice;

  return (
    <>
      <PageHeader title="工作区设置" subtitle="控制配置文件、导入兼容、历史存储和写入安全。" />
      <SectionTitle>工作区文件</SectionTitle>
      <InfoBand className="flex items-center justify-between">
        <div>
          <div className="text-xs text-ink2 mb-1">当前工作区</div>
          <div className="text-sm">{workspacePath ? workspacePath.split(/[\\/]/).slice(-1)[0] : `${workspace.name}（未保存）`}</div>
        </div>
        <StatusDot tone="ok" label="自动保存已开启" />
        <Button size="sm" onClick={async () => {
          const res = await command<string>({ type: 'dialog.saveFile', defaultName: 'workspace.workspace.json' });
          if (res.ok) await command({ type: 'workspace.saveAs', path: res.value });
        }}>另存为</Button>
      </InfoBand>
      <SectionTitle>导入 / 导出</SectionTitle>
      <div className="flex gap-3">
        <Button onClick={async () => {
          const res = await command<string>({ type: 'dialog.openFile', accept: ['json'] });
          if (!res.ok) return;
          const text = await (await fetch(`file:///${res.value.replace(/\\/g, '/')}`)).text().catch(() => '');
          void text;
          await command({ type: 'workspace.open', path: res.value });
        }}>导入工作区</Button>
        <Button onClick={async () => {
          const res = await command<string>({ type: 'workspace.export' });
          if (res.ok) {
            await navigator.clipboard.writeText(res.value);
            toast({ kind: 'success', title: '工作区 JSON 已复制到剪贴板' });
          }
        }}>导出工作区</Button>
      </div>
      <div className="text-xs text-ink2 mt-3">设备模板也可单独导入 / 导出；工作区包含连接、从站绑定、趋势组和界面布局。</div>

      <SectionTitle>地址规则</SectionTitle>
      <InfoBand tone="blue">
        <div className="text-sm font-bold text-accent mb-1">协议地址固定为 0-based（不可切换）</div>
        <div className="text-sm">数据块已明确地址区，因此核心 UI 不使用 40001 / 30001。通信请求直接显示 Start / Quantity。</div>
        <div className="text-xs mt-1"><Checkbox checked onCheckedChange={() => undefined} disabled label="导入兼容：自动识别 PLC 风格 40001 / 30001 / 10001 / 00001 并转换为协议地址" /></div>
      </InfoBand>

      <SectionTitle>记录与历史</SectionTitle>
      <InfoBand>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div>
            <div className="text-xs text-ink2 mb-1">历史数据库</div>
            <div className="text-sm mono break-all">{historyDbPath}</div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1">记录方式</div>
            <div className="text-sm">仅趋势组主动“开始记录”后写入历史</div>
            <div className="mt-2"><Checkbox checked={prefs.persistRawComm} onCheckedChange={(v) => void command({ type: 'prefs.set', patch: { persistRawComm: v } })} label="记录会话时保存相关原始通信（增加存储占用）" /></div>
          </div>
          <div>
            <div className="text-xs text-ink2 mb-1">保留策略</div>
            <div className="text-sm">按会话保存 · 超过 10 GB 提醒</div>
          </div>
        </div>
      </InfoBand>

      <SectionTitle>写入安全</SectionTitle>
      <InfoBand className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-2">
          <Checkbox checked onCheckedChange={() => undefined} disabled label="部分寄存器写入限制“先读 → 修改 → 再写”" />
          <Checkbox checked onCheckedChange={() => undefined} disabled label="写入成功后立即读取确认最终值" />
        </div>
        <div className="text-xs text-ink2 max-w-md">高风险点位可在模板中配置二次确认；普通数值直接写入，避免调试流程过重。</div>
      </InfoBand>

      <SectionTitle>显示</SectionTitle>
      <InfoBand>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3 text-sm">
          <div><div className="text-xs text-ink2 mb-1">Context Sidebar 宽度</div>{prefs.sidebarWidth} px（220–320，双击分隔条恢复 244）</div>
          <div><div className="text-xs text-ink2 mb-1">窗口模式</div>标准 ≥ 1280 px · 紧凑 1024–1279 px</div>
          <div><div className="text-xs text-ink2 mb-1">缩放</div>不整体缩放 UI；窄窗口使用重排与内部滚动</div>
        </div>
      </InfoBand>

      <SectionTitle>日志</SectionTitle>
      <InfoBand>
        <div className="text-sm">electron-log 写入 userData/logs；通信诊断在应用内“通信”模块查看，不依赖日志文件。</div>
        <Button size="sm" className="mt-3" onClick={() => openOverlay({ kind: 'dialog', id: 'confirm', title: '清空通信诊断', message: '将清空当前内存中的事务与帧错误记录。', confirmLabel: '清空', danger: true, onConfirm: () => void command({ type: 'diagnostics.clear' }) })}>清空通信诊断</Button>
      </InfoBand>
      <div className="mt-6">
        <TextInput readOnly value={`workspace schemaVersion=${workspace.schemaVersion}`} className="mono text-xs" />
      </div>
    </>
  );
}