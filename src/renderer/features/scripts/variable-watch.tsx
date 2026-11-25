import React from 'react';
import type { ScriptVariableGroup } from '../../../domain/master-script';
import type { ScriptRunView } from '../../../shared/script-run';

const runStatus: Record<ScriptRunView['state'], string> = {
  running: '运行中', waiting: '等待事件', pausing: '等待暂停', paused: '已暂停', stopping: '停止中',
  passed: '已完成', stopped: '已停止', failed: '运行失败',
};

export function VariableWatch({ groups, run, onSelect }: {
  groups: ScriptVariableGroup[]; run: ScriptRunView | null; onSelect(id: string): void;
}) {
  if (!groups.length) return <p className="script-watch-empty">还没有变量。拖入「变量」分类的赋值积木即可开始观察。</p>;
  return <div className="script-watch">{groups.flatMap(group => {
    const scopes = run?.variableScopes.filter(item => item.functionId === group.functionId) ?? [];
    return (scopes.length ? scopes : [undefined]).map(scope => {
      const values = new Map(scope?.values.map(({ name, value }) => [name, value]));
      const status = group.functionId === null ? (run ? runStatus[run.state] : '未运行')
        : scope ? (scope.inCall ? '本次调用' : '上次调用') : '未调用';
      return <section key={JSON.stringify([group.functionId, scope?.source])} aria-label={group.label}>
        <header><strong title={group.label}>{group.label}{group.functionId !== null && '()'}</strong>
          <span data-active={scope?.inCall || undefined}>{scope?.source && `${scope.source} · `}{status}</span></header>
        <dl>{Array.from(group.names, ([name, blockId]) => {
          const value = values.get(name);
          return <div key={name} data-variable={name}><dt><button type="button" className="focus-ring"
            title={'定位积木 · ' + name} onClick={() => onSelect(blockId)}>{name}</button></dt>
            <dd data-assigned={value !== undefined || undefined}>{value === undefined ? '未赋值' : typeof value === 'string' ? JSON.stringify(value) : String(value)}</dd>
          </div>;
        })}</dl>
      </section>;
    });
  })}</div>;
}
