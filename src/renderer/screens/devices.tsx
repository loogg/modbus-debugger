import React from 'react';
import { useApp } from '../store/app';
import { Button, EmptyState, InfoColumns, PageHeader, SectionTitle, StatusDot, formatClock } from '../components/ui';
import { AREAS } from '../../domain/address';

export function DevicesScreen() {
  const snapshot = useApp((s) => s.snapshot);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const openOverlay = useApp((s) => s.openOverlay);
  const setModule = useApp((s) => s.setModule);
  const slave = snapshot?.workspace.slaves.find((s) => s.id === selection.slaveId) ?? snapshot?.workspace.slaves[0];
  const connection = snapshot?.workspace.connections.find((c) => c.id === slave?.connectionId);
  const template = snapshot?.workspace.templates.find((t) => t.id === slave?.templateId);
  const connState = slave ? snapshot?.connections[slave.connectionId] : undefined;

  if (!snapshot || snapshot.workspace.connections.length === 0) {
    return (
      <EmptyState
        title="开始配置 Modbus 调试环境"
        message="先建立连接和从站，或导入已有工作区 / 设备模板。随后在“实时”中查看数据，并按需加入趋势。"
        actions={
          <>
            <Button variant="primary" onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>＋ 添加第一个连接</Button>
            <Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-connection' })}>导入工作区</Button>
            <Button onClick={() => setModule('templates')}>导入设备模板</Button>
          </>
        }
      />
    );
  }

  if (!slave) {
    return <EmptyState title="还没有从站" message="在左侧连接上添加从站并绑定设备模板。" actions={<Button variant="primary" onClick={() => connection && openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: connection.id })}>＋ 添加从站</Button>} />;
  }

  return (
    <>
      <PageHeader
        title={slave.name}
        subtitle={`从站 ${slave.unitId} · ${connection?.name ?? ''} · ${template?.name ?? '未绑定模板'}`}
        actions={<Button onClick={() => openOverlay({ kind: 'dialog', id: 'add-slave', connectionId: slave.connectionId, slaveId: slave.id })}>编辑从站</Button>}
      />
      <InfoColumns
        items={[
          { label: '连接', value: connection?.name ?? '—', sub: connection?.transport === 'rtu' ? <span className="text-ok text-xs">总线负载 {Math.round(snapshot.health[connection.id]?.busLoadPercent ?? 0)}%</span> : undefined },
          { label: '从站地址', value: String(slave.unitId) },
          { label: '设备模板', value: template ? <button className="focus-ring cursor-pointer text-accent hover:underline" onClick={() => { select({ templateId: template.id }); setModule('templates'); }}>{template.name} · v{template.version}</button> : '未绑定' },
          {
            label: '设备状态',
            value: <StatusDot tone={connState?.state === 'online' ? 'ok' : connState?.state === 'error' ? 'err' : 'idle'} label={connState?.state === 'online' ? `在线 · 最后响应 ${formatClock(connState.lastResponseUtc)}` : connState?.state === 'connecting' ? '连接中' : '离线'} />,
          },
        ]}
      />
      <SectionTitle>模板数据块</SectionTitle>
      <div className="text-xs text-ink2 -mt-1 mb-4">设备模板：{template?.name ?? '—'} · v{template?.version ?? '—'}</div>
      {!template || template.blocks.length === 0 ? (
        <EmptyState title="模板还没有数据块" message="在模板编辑中添加数据块与点位。" />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" style={{ gridAutoRows: 'min-content' }}>
          {template.blocks.map((b) => (
            <div key={b.id} className="rounded-card border border-line bg-surface p-5 min-w-[280px]">
              <div className="text-sm font-bold">{b.name}</div>
              <div className="text-xs text-accent mt-1">{AREAS[b.area]}</div>
              <div className="mt-4 flex flex-col gap-2 text-xs">
                <div className="flex"><span className="w-20 text-ink2">范围</span><span className="mono">地址 {b.start}–{b.start + b.length - 1}</span></div>
                <div className="flex"><span className="w-20 text-ink2">长度</span><span>{b.length} 个寄存器</span></div>
                <div className="flex"><span className="w-20 text-ink2">模板周期</span><span>默认周期 {b.periodMs} ms</span></div>
              </div>
              <Button
                variant="quiet"
                size="sm"
                className="mt-4"
                onClick={() => {
                  select({ slaveId: slave.id, connectionId: slave.connectionId, blockId: b.id, realtimeScope: 'block' });
                  setModule('realtime');
                }}
              >
                查看数据
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}