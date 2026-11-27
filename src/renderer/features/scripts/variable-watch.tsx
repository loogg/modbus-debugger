import React from 'react';
import type { ScriptVariableGroup } from '../../../domain/master-script';
import type { ScriptRunView } from '../../../shared/script-run';

const runStatus: Record<ScriptRunView['state'], string> = {
  running: '运行中', waiting: '等待事件', pausing: '等待暂停', paused: '已暂停', stopping: '停止中',
  passed: '已完成', stopped: '已停止', failed: '运行失败',
};

export function VariableWatch({ groups, run, onSelect, published, onPublish }: {
  groups: ScriptVariableGroup[]; run: ScriptRunView | null; onSelect(id: string): void;
  published?: readonly string[]; onPublish?(name: string): void;
}) {
  if (!groups.length) return <p className="script-watch-empty">还没有变量。拖入「变量」分类的赋值积木即可开始观察。</p>;
  return <div className="script-watch">{groups.flatMap(group => {
    const scopes = run?.variableScopes.filter(item => item.functionId === group.functionId) ?? [];
    return (scopes.length ? scopes : [undefined]).map(scope => {
      const values = new Map(scope?.values.map(row => [row.name, row]));
      const status = group.functionId === null ? (run ? runStatus[run.state] : '未运行')
        : scope ? (scope.inCall ? '本次调用' : '上次调用') : '未调用';
      return <section key={JSON.stringify([group.functionId, scope?.source])} aria-label={group.label}>
        <header><strong title={group.label}>{group.label}{group.functionId !== null && '()'}</strong>
          <span data-active={scope?.inCall || undefined}>{scope?.source && `${scope.source} · `}{status}</span></header>
        <dl>{Array.from(group.names, ([name, blockId]) => {
          const row = values.get(name);
          const value = row?.value;
          return <div key={name} data-variable={name}><dt><button type="button" className="focus-ring"
            title={'定位积木 · ' + name} onClick={() => onSelect(blockId)}>{name}</button></dt>
            <dd data-assigned={value !== undefined || undefined} title={row?.kind === 'integer64' ? 'Lua 64 位整数' : undefined}>
              {value === undefined ? '未赋值' : typeof value === 'string' && row?.kind !== 'integer64' ? JSON.stringify(value) : String(value)}
            </dd>
            {group.functionId === null && onPublish && <label className="script-share-variable" title="保存流程后画布可读取此变量">
              <input type="checkbox" aria-label={`公开 ${name} 到画布`} checked={published?.includes(name) ?? false} onChange={() => onPublish(name)} />公开</label>}
          </div>;
        })}</dl>
      </section>;
    });
  })}</div>;
}
