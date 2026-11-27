import React, { useEffect, useState } from 'react';
import { workspaceVariableSchema, type WorkspaceVariable } from '../../../domain/canvas-script';
import { Button } from '../../components/ui';
import { useApp, useWorkspace } from '../../store/app';
import { uid } from '../../uid';
import { useConfirm } from '../../workbench/use-confirm';

const typeNames = { number: '数值', boolean: '布尔', string: '文本' };
export function WorkspaceVariables({ create, consumed }: { create?: boolean; consumed?(): void }) {
  const definitions = useWorkspace()?.variables ?? [];
  const values = useApp(s => s.snapshot?.canvasSignals?.variables);
  const command = useApp(s => s.command);
  const confirm = useConfirm();
  const [form, setForm] = useState<{ previous: WorkspaceVariable | null; name: string; type: WorkspaceVariable['type']; initial: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (previous: WorkspaceVariable | null) => {
    setError('');
    setForm({ previous, name: previous?.name ?? '', type: previous?.type ?? 'number', initial: String(previous?.initial ?? 0) });
  };
  useEffect(() => { if (create) { open(null); consumed?.(); } }, [create, consumed]);
  const save = async () => {
    if (!form || busy) return;
    if (!form.name.trim()) { setError('请输入变量名'); return; }
    const initial = form.type === 'number' ? (form.initial.trim() ? Number(form.initial) : NaN) : form.type === 'boolean' ? form.initial === 'true' : form.initial;
    const parsed = workspaceVariableSchema.safeParse({ id: form.previous?.id ?? uid('var'), name: form.name, type: form.type, initial });
    if (!parsed.success) { setError('请检查变量名和初值'); return; }
    setBusy(true);
    try {
      const result = await command({ type: 'variable.save', variable: parsed.data, expected: form.previous });
      if (result.ok) { setForm(null); setError(''); } else setError(result.error);
    } finally { setBusy(false); }
  };
  return <section className="workspace-variable-list" aria-label="工作区变量">
    <header><strong>工作区变量</strong><button type="button" className="focus-ring text-accent" onClick={() => open(null)}>＋ 新建变量</button></header>
    {definitions.map(v => <div className="workspace-variable-row" key={v.id}>
      <button type="button" className="focus-ring text-left" title={`编辑 ${v.name}`} onClick={() => open(v)}>{v.name}</button>
      <span>{typeNames[v.type]}</span><output>{String(values && Object.hasOwn(values, v.id) ? values[v.id] : v.initial)}</output>
    </div>)}
    {form && <form className="workspace-variable-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>变量名<input aria-label="工作区变量名" value={form.name} maxLength={120} autoFocus onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label>类型<select aria-label="工作区变量类型" value={form.type} disabled={!!form.previous} onChange={e => {
        const type = e.target.value as WorkspaceVariable['type']; setForm({ ...form, type, initial: type === 'boolean' ? 'false' : type === 'number' ? '0' : '' });
      }}>{Object.entries(typeNames).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
      <label>初值{form.type === 'boolean' ? <select aria-label="变量初值" value={form.initial} onChange={e => setForm({ ...form, initial: e.target.value })}>
        <option value="false">假</option><option value="true">真</option></select> : <input aria-label="变量初值" type={form.type === 'number' ? 'number' : 'text'} step="any"
        value={form.initial} maxLength={4000} onChange={e => setForm({ ...form, initial: e.target.value })} />}</label>
      <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" variant="primary" disabled={busy}>保存变量</Button>
        <Button size="sm" onClick={() => { setForm(null); setError(''); }}>取消</Button>
        {form.previous && <Button size="sm" variant="quiet" disabled={busy} onClick={async () => {
          const expected = form.previous!;
          if (!await confirm(`删除工作区变量「${expected.name}」？`)) return;
          const reply = await command({ type: 'variable.delete', expected });
          if (reply.ok) { setForm(null); setError(''); } else setError(reply.error);
        }}>删除变量</Button>}</div>
    </form>}
    {error && <p role="alert" className="text-xs text-err">{error}</p>}
  </section>;
}
