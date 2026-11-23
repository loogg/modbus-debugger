import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Add20Regular } from '@fluentui/react-icons';
import { compileMasterScript, fieldText, isScriptStatement, newScriptGraph, scriptBlocks, scriptFileSchema, scriptGraphBlocks, ScriptBlockError, withScriptBreakpoints, type MasterScript, type ScriptGraph } from '../../domain/master-script';
import type { Workspace } from '../../domain/model';
import { scriptIsActive as ongoing, type ScriptApprovalView } from '../../shared/script-run';
import { Button, EmptyState, TextInput } from '../components/ui';
import { ScriptEditor, type ScriptEditorApi } from '../features/scripts/editor';
import type { PaletteState } from '../features/scripts/palette';
import { useApp, useWorkspace } from '../store/app';
import { uid } from '../uid';
import { createTimeMsFormatter, fmtEpochDateTimeMs, fmtTimeMs } from '../time';
import { useConfirm } from '../workbench/use-confirm';
import { useDirtyGuard, useViewDocument, useViewWindow } from '../workbench/view-context';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const runLabels = { running: '运行中', pausing: '等待当前步骤完成', paused: '已暂停', stopping: '停止中', passed: '通过', failed: '失败', stopped: '已停止' } as const;
const pauseLabels = { entry: '调试起点', breakpoint: '命中断点', step: '单步完成', pause: '手动暂停' } as const;

export function ScriptsScreen() {
  const palette = useRef<PaletteState>({ category: 0, open: true });
  const workspace = useWorkspace();
  const scripts = workspace?.masterScripts ?? [];
  const selectedId = useApp(state => state.selection.scriptId);
  const select = useApp(state => state.select);
  const command = useApp(state => state.command);
  const confirm = useConfirm();
  const importInput = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<{ scriptId: string; blockId: string } | null>(null);
  useDirtyGuard(dirty);
  const current = scripts.find(script => script.id === selectedId) ?? scripts[0];

  const allowSwitch = () => dirty ? confirm('当前流程有未保存的修改。', '丢弃并继续') : Promise.resolve(true);
  const choose = async (id: string) => {
    if (id === current?.id || !await allowSwitch()) return;
    setDirty(false);
    setFocus(null);
    select({ scriptId: id });
  };
  const add = async (file?: { name: string; graph: ScriptGraph }) => {
    setSaving(true);
    try {
      const script = { id: uid('script'), name: file?.name ?? `流程 ${scripts.length + 1}`, graph: file?.graph ?? newScriptGraph(uid('start')) };
      const result = await command<MasterScript>({ type: 'script.save', script, expectedRevision: null });
      if (result.ok) { setDirty(false); select({ scriptId: script.id }); setError(''); }
      else setError(result.error);
    } finally { setSaving(false); }
  };
  const importScript = async (file: File) => {
    try {
      if (file.size > 1000000) throw new Error('流程文件过大');
      const parsed = scriptFileSchema.safeParse(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '流程文件格式无效');
      await add(parsed.data);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  return <main className="flex min-h-0 min-w-0 flex-1 bg-app">
    <aside className="script-list shrink-0 overflow-y-auto border-r border-line bg-surface2 p-3" aria-label="脚本列表">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-base font-semibold">主站脚本</h1>
        <button className="workbench-tool" aria-label="新建脚本" title="新建脚本" disabled={saving} onClick={async () => { if (await allowSwitch()) await add(); }}><Add20Regular /></button>
      </div>
      <div className="space-y-1">
        {scripts.map(script => <button key={script.id} title={script.name} aria-current={current?.id === script.id} className={`focus-ring block w-full truncate rounded-ctl px-2 py-2 text-left text-sm ${current?.id === script.id ? 'bg-accentsoft text-accent' : 'hover:bg-surface'}`} onClick={() => void choose(script.id)}>{script.name}</button>)}
      </div>
      <button className="focus-ring mt-3 text-xs text-accent" disabled={saving} onClick={async () => { if (await allowSwitch()) importInput.current?.click(); }}>导入脚本</button>
      <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (file) void importScript(file);
      }} />
      {error && <p className="mt-3 break-words text-xs text-err" role="alert">{error}</p>}
    </aside>
    {current ? <ScriptDraft key={current.id} source={current} equipment={workspace} palette={palette.current} onDirty={setDirty} focus={focus}
      onJump={async (scriptId, blockId) => {
        if (scriptId !== current.id && !await allowSwitch()) return;
        if (scriptId !== current.id) { setDirty(false); select({ scriptId }); }
        setFocus({ scriptId, blockId });
      }} onRemove={() => { setDirty(false); select({ scriptId: null }); }} />
      : <div className="min-w-0 flex-1"><EmptyState title="创建主站测试流程" message="添加读写、等待和断言积木，编排设备测试。" actions={<Button variant="primary" disabled={saving} onClick={() => void add()}>新建流程</Button>} /></div>}
  </main>;
}

function ScriptDraft({ source, equipment, palette, onDirty, onRemove, focus, onJump }: {
  palette: PaletteState;
  source: MasterScript; equipment: Workspace | null; onDirty(dirty: boolean): void; onRemove(): void;
  focus: { scriptId: string; blockId: string } | null; onJump(scriptId: string, blockId: string): Promise<void>;
}) {
  const command = useApp(state => state.command);
  const toast = useApp(state => state.toast);
  const report = useApp(state => state.snapshot?.scriptRun);
  const confirm = useConfirm();
  const viewDocument = useViewDocument();
  const viewWindow = useViewWindow();
  const editor = useRef<ScriptEditorApi>(null);
  const [base, setBase] = useState(source);
  const [name, setName] = useState(source.name);
  const [graph, setGraph] = useState(source.graph);
  const [editorKey, setEditorKey] = useState(0);
  const [editorReady, setEditorReady] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [showLua, setShowLua] = useState(false);
  const [lua, setLua] = useState('');
  const [luaProblem, setLuaProblem] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const requestedLookup = useApp(state => state.selection.scriptPointLookup);
  const select = useApp(state => state.select);
  const [lookup, setLookup] = useState<string | null>(requestedLookup ?? null);
  useEffect(() => {
    if (requestedLookup) { setLookup(requestedLookup); select({ scriptPointLookup: null }); }
  }, [requestedLookup, select]);
  const [access, setAccess] = useState<'read' | 'write'>('write');
  const lookupName = useMemo(() => {
    if (!lookup) return '';
    try {
      const [slaveId, pointId] = JSON.parse(lookup) as [string, string];
      const slave = equipment?.slaves.find(item => item.id === slaveId);
      const point = equipment?.templates.find(item => item.id === slave?.templateId)?.points.find(item => item.id === pointId);
      return point && slave ? `${point.name} · ${slave.name}` : lookup;
    } catch { return lookup; }
  }, [equipment, lookup]);
  const dirty = name.trim() !== base.name || JSON.stringify(graph) !== JSON.stringify(base.graph);
  const conflict = source.revision !== base.revision;
  const run = report?.scriptId === source.id ? report : null;
  const logClock = run?.entries.some(entry => entry.log) ? createTimeMsFormatter() : undefined;
  const live = ongoing(run) ? run : null;
  // A draft can contain steps added after the current run was compiled.
  const breakpoints = live
    ? [...live.breakpoints, ...(graph.breakpoints ?? []).filter(id => !live.statementIds.includes(id))]
    : graph.breakpoints;
  const selectedBlock = useMemo(() => [...scriptGraphBlocks(graph)].find(block => block.id === selected), [graph, selected]);
  const selectedPoint = selectedBlock && fieldText(selectedBlock, 'POINT');
  const traces = run?.scriptRevision === base.revision && !dirty ? run.judgments : undefined;
  const traceId = selectedBlock && traces && [selectedBlock.id, selectedBlock.inputs?.CONDITION?.block?.id ?? selectedBlock.id + '/CONDITION']
    .find(id => Object.hasOwn(traces, id));
  const judgment = traceId ? traces?.[traceId] : undefined;
  const references = useMemo(() => {
    if (!lookup) return [];
    const hits: { scriptId: string; name: string; blockId: string; write: boolean; label: string }[] = [];
    for (const script of equipment?.masterScripts ?? []) {
      for (const block of scriptGraphBlocks(script.id === source.id ? graph : script.graph)) {
        if (fieldText(block, 'POINT') !== lookup) continue;
        const write = block.type === scriptBlocks.write;
        const operand = block.inputs?.OPERAND?.block;
        const writeValue = operand?.type === scriptBlocks.variable ? `变量「${fieldText(operand, 'VARIABLE')}」` : operand ? '表达式' : fieldText(block, 'VALUE');
        const label = write ? '写入 ' + writeValue : block.type === scriptBlocks.read ? '等待新采样' : block.type === scriptBlocks.readVariable ? '读取到变量' : '取确认值';
        hits.push({ scriptId: script.id, name: script.id === source.id ? name : script.name, blockId: block.id, write, label });
      }
    }
    return hits;
  }, [lookup, equipment, source.id, graph, name]);
  const findPoint = (key: string) => { setLookup(key); setShowLua(false); setAccess('write'); };

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (conflict && !dirty && !working) {
      setBase(source); setName(source.name); setGraph(source.graph); setEditorKey(key => key + 1);
    }
  }, [conflict, dirty, source, working]);
  useEffect(() => {
    const failed = run?.state === 'failed' ? run.entries.slice().reverse().find(row => row.result === 'failed') : undefined;
    editor.current?.highlight(run?.current?.blockId ?? failed?.blockId ?? null, run?.pause ? 'if-hidden' : false);
  }, [run, editorReady]);
  useEffect(() => {
    if (focus?.scriptId === source.id && editorReady) {
      setSelected(focus.blockId); editor.current?.highlight(focus.blockId, true);
    }
  }, [focus, source.id, editorReady]);
  useEffect(() => {
    if (!showLua) return;
    try { setLua(editor.current?.lua() ?? ''); setLuaProblem(''); }
    catch (reason) { setLua(''); setLuaProblem(errorMessage(reason)); }
  }, [showLua, graph, editorKey, editorReady]);

  const save = async (): Promise<MasterScript> => {
    if (conflict) throw new Error('流程已在其他页面修改，请重新载入后再保存');
    if (!dirty) return base;
    const nameToSave = name.trim();
    if (!nameToSave) throw new Error('请输入流程名称');
    const result = await command<MasterScript>({ type: 'script.save', expectedRevision: base.revision, script: { id: source.id, name: nameToSave, graph } });
    if (!result.ok) throw new Error(result.error);
    setBase(result.value);
    return result.value;
  };
  const perform = async (action: () => Promise<void>) => {
    setWorking(true);
    setError('');
    try { await action(); }
    catch (reason) {
      if (reason instanceof ScriptBlockError) editor.current?.highlight(reason.blockId ?? null, true);
      setError(errorMessage(reason));
    } finally { setWorking(false); }
  };
  const toggleBreakpoint = async (blockId: string) => {
    const enabled = !breakpoints?.includes(blockId);
    if (live?.statementIds.includes(blockId)) {
      const result = await command({ type: 'script.breakpoint', runId: live.id, blockId, enabled });
      if (!result.ok) throw new Error(result.error);
    }
    setGraph(current => {
      const ids = new Set(live ? breakpoints : current.breakpoints);
      if (enabled) ids.add(blockId); else ids.delete(blockId);
      return withScriptBreakpoints(current, [...ids]);
    });
  };
  const debugControl = async (mode: 'pause' | 'continue' | 'step') => {
    if (!run) return;
    const result = mode === 'pause' ? await command({ type: 'script.pause', runId: run.id })
      : run.pause && await command({ type: 'script.resume', runId: run.id, token: run.pause.token, mode });
    if (result && !result.ok) throw new Error(result.error);
  };
  const start = async (debug = false) => {
    compileMasterScript(graph);
    const saved = await save();
    const request = { scriptId: saved.id, revision: saved.revision };
    const plan = await command<ScriptApprovalView | null>({ type: 'script.plan', ...request });
    if (!plan.ok) throw new Error(plan.error);
    if (plan.value) {
      const values = plan.value.writes.map(write => `${write.target} → ${JSON.stringify(write.value)}`).join('\n');
      const approved = await confirm(`流程包含以下高风险写入。按流程运行时可能重复执行。\n\n${values}`, '确认并运行', '确认高风险写入');
      if (!approved) return;
    }
    const result = await command({ type: 'script.start', ...request, approval: plan.value?.key, debug });
    if (!result.ok) throw new Error(result.error);
    setShowLua(false);
  };
  const remove = async () => {
    if (!await confirm(`删除“${source.name}”？`, '删除脚本', '删除脚本')) return;
    const result = await command({ type: 'script.delete', scriptId: source.id, expectedRevision: base.revision });
    if (!result.ok) throw new Error(result.error);
    onRemove();
  };
  const exportScript = async () => {
    const saved = await save();
    const safeName = Array.from(saved.name, char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/[<>:"/\\|?*]/g, '_');
    const defaultName = `${safeName}.modbus-script.json`;
    if ('modbus' in window) {
      const dest = await command<string | null>({ type: 'dialog.saveFile', defaultName });
      if (!dest.ok && dest.error === 'cancelled') return;
      if (!dest.ok) throw new Error(dest.error);
      if (!dest.value) return;
      const result = await command({ type: 'script.exportFile', scriptId: saved.id, path: dest.value });
      if (!result.ok) throw new Error(result.error);
    } else {
      const file = JSON.stringify({ format: 'modbus-master-script', version: 1, name: saved.name, graph: saved.graph }, null, 2);
      const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
      const link = viewDocument.createElement('a');
      link.href = url; link.download = defaultName; viewDocument.body.appendChild(link);
      link.click(); link.remove();
      viewWindow.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast({ kind: 'success', title: '脚本已导出' });
  };

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="主站脚本编辑器">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface p-3">
      <div className="w-44"><TextInput aria-label="流程名称" value={name} maxLength={120} onChange={event => setName(event.target.value)} /></div>
      <Button size="sm" disabled={!dirty || working || conflict} onClick={() => void perform(async () => { await save(); toast({ kind: 'success', title: '流程已保存' }); })}>保存</Button>
      {!ongoing(report) && <>
        <Button size="sm" variant="primary" disabled={working || conflict} onClick={() => void perform(() => start())}>运行</Button>
        <Button size="sm" title="在第一步执行前暂停。右键积木可设置断点" disabled={working || conflict} onClick={() => void perform(() => start(true))}>调试</Button>
      </>}
      {run?.state === 'paused' && <>
        <Button size="sm" variant="primary" disabled={working} onClick={() => void perform(() => debugControl('continue'))}>继续</Button>
        <Button size="sm" disabled={working} onClick={() => void perform(() => debugControl('step'))}>单步</Button>
      </>}
      {(run?.state === 'running' || run?.state === 'pausing') && <Button size="sm" disabled={working || run.state === 'pausing'} title="完成当前积木后暂停" onClick={() => void perform(() => debugControl('pause'))}>暂停</Button>}
      {ongoing(report) && report && <Button size="sm" disabled={report.state === 'stopping'} onClick={() => void command({ type: 'script.stop', runId: report.id })}>停止</Button>}
      <Button size="sm" onClick={() => setShowLua(value => !value)}>{showLua ? '收起 Lua' : 'Lua 预览'}</Button>
      <Button size="sm" disabled={working || conflict} onClick={() => void perform(exportScript)}>导出</Button>
      <Button size="sm" variant="quiet" disabled={working || ongoing(run) || conflict} onClick={() => void perform(remove)}>删除</Button>
      {dirty && <span className="text-xs text-ink2">未保存</span>}
      {ongoing(report) && !run && <span className="text-xs text-ink2">{report?.scriptName} · {report && runLabels[report.state]}</span>}
    </header>
    {conflict && <div className="flex items-center gap-3 bg-accentsoft px-3 py-2 text-xs" role="status">此流程已在其他页面修改
      <button className="focus-ring text-accent" onClick={async () => {
        if (dirty && !await confirm('当前修改会被丢弃。')) return;
        setBase(source); setName(source.name); setGraph(source.graph); setError(''); setEditorKey(key => key + 1);
      }}>重新载入</button>
    </div>}
    {error && <p className="shrink-0 break-words px-3 py-2 text-sm text-err" role="alert">{error}</p>}
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ScriptEditor ref={editor} key={editorKey} graph={graph} equipment={equipment} palette={palette} breakpoints={breakpoints}
        onBreakpoint={id => void perform(() => toggleBreakpoint(id))} onChange={next => setGraph(current => withScriptBreakpoints(next, current.breakpoints ?? []))} onSelect={setSelected}
        onFindPoint={findPoint} onReady={() => setEditorReady(key => key + 1)} />
      {working && <div className="absolute inset-0 z-10 cursor-progress" aria-hidden="true" />}
    </div>
    {run?.pendingWrite && <section className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-surface px-3 py-2 text-sm" aria-label="待确认写入">
      <strong>高风险写入</strong><span className="break-all">{run.pendingWrite.target} → {run.pendingWrite.value}</span>
      <Button size="sm" variant="primary" onClick={() => void command({ type: 'script.confirmWrite', runId: run.id, token: run.pendingWrite!.token })}>确认下发</Button>
      <Button size="sm" onClick={() => void command({ type: 'script.stop', runId: run.id })}>停止流程</Button>
    </section>}
    {run?.pause && <section className="script-debug-pause" aria-label="调试暂停">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong>{pauseLabels[run.pause.reason]}</strong>
        <span>{run.current?.label}</span>{run.pause.writePreview !== undefined && <span>待写值 <b className="mono">{run.pause.writePreview}</b></span>}
        {run.pause.writeError && <span className="text-err">写值不可用 · {run.pause.writeError}</span>}</div>
      {run.pause.variables.length > 0 && <details><summary>运行变量（{run.pause.variables.length}）</summary>
        <dl>{run.pause.variables.map(variable => <div key={variable.name}><dt>{variable.name}</dt><dd>{variable.value}</dd></div>)}</dl></details>}
    </section>}
    {!lookup && (judgment || selectedPoint || (selectedBlock && isScriptStatement(selectedBlock.type))) && <section className="max-h-28 shrink-0 overflow-auto border-t border-line bg-surface px-3 py-2 text-xs" aria-label="积木检查">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{judgment && <><strong className={'script-verdict ' + (judgment.matched ? 'is-true' : '')}>上次判断 · {judgment.matched === null ? '待确认' : judgment.matched ? '真' : '假'}</strong>
        <span className="min-w-0 break-words">{judgment.detail}</span></>}
        {selectedBlock && isScriptStatement(selectedBlock.type) && <button className="script-breakpoint-control focus-ring" aria-pressed={!!breakpoints?.includes(selectedBlock.id)}
          onClick={() => void perform(() => toggleBreakpoint(selectedBlock.id))}>{breakpoints?.includes(selectedBlock.id) ? '移除断点' : '设置断点'}</button>}
        {selectedPoint && <button className="focus-ring ml-auto text-accent" onClick={() => findPoint(selectedPoint)}>查找此点位的读写</button>}</div>
      {judgment && <div className="mt-1 flex flex-wrap gap-x-4 text-ink2">
        <span title={fmtEpochDateTimeMs(judgment.evaluatedAtMs)}>判断 {fmtTimeMs(new Date(judgment.evaluatedAtMs).toISOString())}</span>
        {judgment.samples.map((sample, index) => <span key={index} title={sample.label + ' · ' + fmtEpochDateTimeMs(sample.timeMs)}>{sample.label.split(' / ').at(-1)}采样 {fmtTimeMs(new Date(sample.timeMs).toISOString())}</span>)}</div>}
    </section>}
    {lookup && <section className="max-h-36 shrink-0 overflow-auto border-t border-line bg-surface p-3 text-xs" aria-label="点位引用">
      <div className="mb-2 flex flex-wrap items-center gap-3"><strong>{lookupName}</strong>
        {(['write', 'read'] as const).map(kind => <button key={kind} className={'focus-ring ' + (kind === access ? 'font-semibold text-accent' : 'text-ink2')}
          aria-pressed={kind === access} onClick={() => setAccess(kind)}>{kind === 'write' ? '写入' : '读取'}（{references.filter(hit => hit.write === (kind === 'write')).length}）</button>)}
        <button className="focus-ring ml-auto text-ink2" onClick={() => setLookup(null)}>关闭</button></div>
      {references.filter(hit => hit.write === (access === 'write')).map(hit => <button className="focus-ring mr-3 text-accent" key={hit.scriptId + '/' + hit.blockId}
        onClick={() => void onJump(hit.scriptId, hit.blockId)}>{hit.name} · {hit.label}</button>)}
    </section>}
    {showLua && <section className="shrink-0 border-t border-line bg-surface p-3" aria-label="Lua 预览">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">生成的 Lua</h2>
        <Button size="sm" disabled={!lua} onClick={async () => {
          try { await viewWindow.navigator.clipboard.writeText(lua); toast({ kind: 'success', title: 'Lua 已复制' }); }
          catch { setLuaProblem('剪贴板不可用，可从文本框选择并复制。'); }
        }}>复制 Lua</Button>
      </div>
      {luaProblem && <p className="mb-2 text-xs text-err" role="status">{luaProblem}</p>}
      <textarea aria-label="生成的 Lua" className="h-24 w-full rounded border border-line bg-surface2 p-2 font-mono text-xs" readOnly value={lua} />
    </section>}
    {run && !showLua && !lookup && <section className="max-h-40 shrink-0 overflow-auto border-t border-line bg-surface p-3" aria-label="运行结果">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm" role="status">
        <span className="font-semibold">{runLabels[run.state]}</span>
        <span className="text-xs text-ink2">已结算 {run.completed} 步</span>
        {run.current && !run.pause && <span className="break-words text-xs">{run.current.label}</span>}
        {run.detail && <span className="break-words text-xs">{run.detail}</span>}
      </div>
      <ol className="space-y-1 text-xs" aria-label="步骤结果">
        {run.entries.slice().reverse().map((entry, index) => <li key={`${run.completed - index}-${entry.blockId}`}>
          <button className="focus-ring w-full break-words text-left hover:text-accent" onClick={() => { setSelected(entry.blockId); editor.current?.highlight(entry.blockId, true); }}>
            {entry.log && <time className="mono mr-2 text-ink2" dateTime={new Date(entry.atMs).toISOString()}>{logClock?.format(entry.atMs)}</time>}
            <span className={entry.log ? 'text-accent' : entry.result === 'ok' ? 'text-ok' : entry.result === 'failed' ? 'text-err' : 'text-ink2'}>{entry.log ? '日志' : entry.handled ? '已处理失败' : entry.result === 'ok' ? '通过' : entry.result === 'failed' ? '失败' : '停止'}</span>
            {!entry.log && <> · {entry.label}</>} · {entry.detail}
          </button>
        </li>)}
      </ol>
    </section>}
  </section>;
}
