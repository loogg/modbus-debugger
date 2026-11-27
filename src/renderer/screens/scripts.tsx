import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Add20Regular, ArrowImport16Regular, Dismiss16Regular, Search16Regular } from '@fluentui/react-icons';
import { CALLBACK_TIMEOUT_MS, MAX_SCRIPT_FILE_BYTES, callbackTimeoutSchema, checkCallbackContexts, compileScriptProgram, fieldText, isScriptCall, isScriptStatement, newScriptGraph, scriptBlocks, scriptFileSchema, scriptGraphBlocks, scriptVariableGroups, serializeScriptFile, ScriptBlockError, withScriptBreakpoints, type MasterScript } from '../../domain/master-script';
import type { Workspace } from '../../domain/model';
import { compileScriptLua } from '../../domain/script-lua-program';
import { scriptIsActive as ongoing, scriptRunFor, type ScriptApprovalView } from '../../shared/script-run';
import { Button, EmptyState, TextInput } from '../components/ui';
import { ScriptEditor, type ScriptEditorApi } from '../features/scripts/editor';
import { LuaDivider, LuaPane, type LuaTab, type ScriptSelection } from '../features/scripts/lua-pane';
import type { ScriptPreview } from '../features/scripts/lua-source';
import type { PaletteState } from '../features/scripts/palette';
import { useApp, useWorkspace } from '../store/app';
import { uid } from '../uid';
import { createTimeMsFormatter, fmtEpochDateTimeMs, fmtTimeMs } from '../time';
import { useConfirm } from '../workbench/use-confirm';
import { useDirtyGuard, useViewDocument, useViewEnvironment, useViewWindow } from '../workbench/view-context';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const runLabels = { running: '运行中', waiting: '等待事件', pausing: '等待当前步骤完成', paused: '已暂停', stopping: '停止中', passed: '通过', failed: '失败', stopped: '已停止' } as const;
const pauseLabels = { entry: '调试起点', breakpoint: '命中断点', step: '单步完成', pause: '手动暂停' } as const;
const callbackTimeoutHelp = `每次 on_run、on_timer 回调的累计执行时限，范围 ${CALLBACK_TIMEOUT_MS.min}–${CALLBACK_TIMEOUT_MS.max} ms。设备等待和调试暂停不计时，保存后在下次运行生效。`;
interface PanePreferences { wide?: boolean; compact?: boolean; width?: number }

const tabStatus = { running: '运行中', waiting: '运行中', pausing: '暂停中', paused: '已暂停', stopping: '停止中', failed: '失败',
  passed: undefined, stopped: undefined } as const;

function ScriptFileTab({ script, selected, choose }: { script: MasterScript; selected: boolean; choose(id: string): Promise<void> }) {
  const button = useRef<HTMLButtonElement>(null);
  const status = useApp(state => {
    const report = scriptRunFor(state.snapshot, script.id);
    return report?.pendingWrite ? '待确认' : report && tabStatus[report.state];
  });
  useLayoutEffect(() => { if (selected) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected]);
  return <button ref={button} title={status ? `${script.name} · ${status}` : script.name}
    aria-label={script.name} aria-description={status ?? undefined} aria-current={selected}
    className="focus-ring script-file" onClick={() => void choose(script.id)}>
    <span className="script-file-name">{script.name}</span>{status && <span className="script-file-status" data-status={status}>{status}</span>}
  </button>;
}

export function ScriptsScreen() {
  const workspaceEpoch = useApp(state => state.snapshot?.canvasSignals?.epoch);
  const palette = useRef<PaletteState>({ category: 0, open: true });
  const [panes, setPanes] = useState<PanePreferences>({});
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
  const focusId = useApp(state => state.selection.scriptFocusId);
  useEffect(() => {
    if (focusId && selectedId) { setFocus({ scriptId: selectedId, blockId: focusId }); select({ scriptFocusId: null }); }
  }, [focusId, selectedId, select]);
  useDirtyGuard(dirty);
  const current = scripts.find(script => script.id === selectedId) ?? scripts[0];

  const allowSwitch = () => dirty ? confirm('当前流程有未保存的修改。', '丢弃并继续') : Promise.resolve(true);
  const choose = async (id: string) => {
    if (id === current?.id || !await allowSwitch()) return;
    setDirty(false);
    setFocus(null);
    select({ scriptId: id });
  };
  const add = async (file?: Pick<MasterScript, 'name' | 'graph' | 'callbackTimeoutMs' | 'publishedVariables'>) => {
    setSaving(true);
    try {
      const script = { id: uid('script'), name: file?.name ?? `流程 ${scripts.length + 1}`, graph: file?.graph ?? newScriptGraph(uid('start')),
        publishedVariables: file?.publishedVariables, callbackTimeoutMs: file?.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS.default };
      const result = await command<MasterScript>({ type: 'script.save', script, expectedRevision: null });
      if (result.ok) { setDirty(false); select({ scriptId: script.id }); setError(''); }
      else setError(result.error);
    } finally { setSaving(false); }
  };
  const importScript = async (file: File) => {
    try {
      if (file.size > MAX_SCRIPT_FILE_BYTES) throw new Error('流程文件超过支持的容量');
      const parsed = scriptFileSchema.safeParse(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '流程文件格式无效');
      await add(parsed.data);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
    <aside className="script-list" aria-label="脚本列表">
      <h1>主站脚本</h1>
      <div className="script-files">
        {scripts.map(script => <ScriptFileTab key={script.id} script={script} selected={current?.id === script.id} choose={choose} />)}
      </div>
      <button className="workbench-tool" aria-label="新建脚本" title="新建脚本" disabled={saving} onClick={async () => { if (await allowSwitch()) await add(); }}><Add20Regular /></button>
      <button className="focus-ring script-import" disabled={saving} onClick={async () => { if (await allowSwitch()) importInput.current?.click(); }}><ArrowImport16Regular />导入脚本</button>
      <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (file) void importScript(file);
      }} />
    </aside>
    {error && <p className="px-3 py-1 break-words text-xs text-err" role="alert">{error}</p>}
    {current ? <ScriptDraft key={JSON.stringify([workspaceEpoch, current.id])} source={current} equipment={workspace} palette={palette.current} panes={panes} setPanes={setPanes} onDirty={setDirty} focus={focus}
      onJump={async (scriptId, blockId) => {
        if (scriptId !== current.id && !await allowSwitch()) return;
        if (scriptId !== current.id) { setDirty(false); select({ scriptId }); }
        setFocus({ scriptId, blockId });
      }} onRemove={() => { setDirty(false); select({ scriptId: null }); }} />
      : <div className="min-w-0 flex-1"><EmptyState title="创建主站测试流程" message="添加读写、等待和断言积木，编排设备测试。" actions={<Button variant="primary" disabled={saving} onClick={() => void add()}>新建流程</Button>} /></div>}
  </main>;
}

function ScriptDraft({ source, equipment, palette, panes, setPanes, onDirty, onRemove, focus, onJump }: {
  palette: PaletteState;
  panes: PanePreferences; setPanes: React.Dispatch<React.SetStateAction<PanePreferences>>;
  source: MasterScript; equipment: Workspace | null; onDirty(dirty: boolean): void; onRemove(): void;
  focus: { scriptId: string; blockId: string } | null; onJump(scriptId: string, blockId: string): Promise<void>;
}) {
  const command = useApp(state => state.command);
  const toast = useApp(state => state.toast);
  const run = useApp(state => scriptRunFor(state.snapshot, source.id));
  const confirm = useConfirm();
  const viewDocument = useViewDocument();
  const environment = useViewEnvironment();
  const viewWindow = useViewWindow();
  const editor = useRef<ScriptEditorApi>(null);
  const split = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const element = split.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setAvailable(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const wide = available >= 1080;
  const size = wide ? 'wide' : 'compact';
  const showLua = panes[size] ?? wide;
  const setShowLua = (open: boolean) => setPanes(value => ({ ...value, [size]: open }));
  const minLuaWidth = 270;
  const maxLuaWidth = Math.max(minLuaWidth, Math.min(680, available - 640));
  const luaWidth = Math.max(minLuaWidth, Math.min(maxLuaWidth, panes.width ?? Math.round(available * 0.29)));
  const [base, setBase] = useState(source);
  const [name, setName] = useState(source.name);
  const [graph, setGraph] = useState(source.graph);
  const [published, setPublished] = useState(source.publishedVariables ?? []);
  const [timeoutText, setTimeoutText] = useState(String(source.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS.default));
  const timeout = useMemo(() => callbackTimeoutSchema.safeParse(Number(timeoutText)), [timeoutText]);
  const timeoutHelpId = React.useId();
  const groups = useMemo(() => scriptVariableGroups(graph), [graph]);
  const mainNames = useMemo(() => [...(groups.find(group => group.functionId === null)?.names.keys() ?? [])], [groups]);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [editorReady, setEditorReady] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ScriptPreview | null>(null);
  const [createVariable, setCreateVariable] = useState(false);
  const [luaTab, setLuaTab] = useState<LuaTab>('code');
  const [logsOnly, setLogsOnly] = useState(false);
  const [selection, setSelection] = useState<ScriptSelection>({ blockId: null });
  const selected = selection.blockId;
  const inspectBlock = useCallback((blockId: string | null, reveal = false, line?: number) => {
    setSelection({ blockId, line });
    editor.current?.inspect(blockId, reveal);
  }, []);
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
  const dirty = JSON.stringify(published) !== JSON.stringify(base.publishedVariables ?? []) || !timeout.success || timeout.data !== (base.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS.default)
    || name.trim() !== base.name || JSON.stringify(graph) !== JSON.stringify(base.graph);
  const conflict = source.revision !== base.revision;
  const runId = run?.id;
  const savedRun = !!run && run.scriptRevision === base.revision && graph === base.graph;
  const compareDraft = !!run && !savedRun;
  const program = useMemo(() => {
    if (!compareDraft) return null;
    try { return compileScriptLua(graph).identity; } catch { return null; }
  }, [graph, compareDraft]);
  const [fingerprint, setFingerprint] = useState<{ program: string; hash: string } | null>(null);
  useEffect(() => {
    if (!program) return;
    let active = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(program)).then(bytes => {
      const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
      if (active) setFingerprint({ program, hash });
    }).catch(() => { if (active) setFingerprint(null); });
    return () => { active = false; };
  }, [program]);
  const matchesRun = savedRun || (!!fingerprint && fingerprint.program === program && fingerprint.hash === run?.programHash);
  const shownEntries = run?.events && logsOnly ? run.eventLog ?? [] : run?.entries ?? [];
  const logClock = shownEntries.some(entry => entry.log) ? createTimeMsFormatter() : undefined;
  const live = ongoing(run) ? run : null;
  // A draft can contain steps added after the current run was compiled.
  const breakpoints = live
    ? [...live.breakpoints, ...(graph.breakpoints ?? []).filter(id => !live.statementIds.includes(id))]
    : graph.breakpoints;
  const draftBlocks = useMemo(() => new Map([...scriptGraphBlocks(graph)].map(block => [block.id, block])), [graph]);
  const selectedBlock = selected ? draftBlocks.get(selected) : undefined;
  const selectedFunction = selectedBlock && isScriptCall(selectedBlock.type) ? draftBlocks.get(fieldText(selectedBlock, 'FUNCTION')) : undefined;
  const selectedPoint = selectedBlock && fieldText(selectedBlock, 'POINT');
  const traces = matchesRun ? run?.judgments : undefined;
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
  const findPoint = (key: string) => { setLookup(key); setAccess('write'); };

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const reload = useCallback(() => {
    setBase(source); setName(source.name); setGraph(source.graph); setPublished(source.publishedVariables ?? []);
    setTimeoutText(String(source.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS.default));
    setError(''); setEditorKey(key => key + 1);
  }, [source]);
  useEffect(() => { if (conflict && !dirty && !working) reload(); }, [conflict, dirty, reload, working]);
  const executing = matchesRun ? run?.current?.blockId ?? null : null;
  const pauseToken = run?.pause?.token;
  useEffect(() => { editor.current?.markExecution(executing, !!pauseToken); }, [executing, pauseToken, editorReady]);
  const failure = matchesRun && run?.state === 'failed' ? run.entries.slice().reverse().find(row => row.result === 'failed' && !row.handled)?.blockId : null;
  useEffect(() => { if (failure) inspectBlock(failure, true); }, [failure, runId, editorReady, inspectBlock]);
  useEffect(() => {
    if (focus?.scriptId === source.id && editorReady) {
      inspectBlock(focus.blockId, true);
    }
  }, [focus, source.id, editorReady, inspectBlock]);
  useEffect(() => {
    if (!showLua || !editorReady) return;
    try { setPreview(editor.current?.preview() ?? null); }
    catch (reason) { setPreview({ source: null, issue: { message: errorMessage(reason) } }); }
  }, [showLua, graph, equipment, editorKey, editorReady]);

  const save = async (): Promise<MasterScript> => {
    if (conflict) throw new Error('流程已在其他页面修改，请重新载入后再保存');
    if (!timeout.success) throw new Error(timeout.error.issues[0]!.message);
    if (!dirty) return base;
    const nameToSave = name.trim();
    if (!nameToSave) throw new Error('请输入流程名称');
    const result = await command<MasterScript>({ type: 'script.save', expectedRevision: base.revision,
      script: { id: source.id, name: nameToSave, graph, callbackTimeoutMs: timeout.data, publishedVariables: published.filter(v => mainNames.includes(v)) } });
    if (!result.ok) throw new Error(result.error);
    setBase(result.value);
    setPublished(result.value.publishedVariables ?? []);
    return result.value;
  };
  const perform = async (action: () => Promise<void>) => {
    setWorking(true);
    setError('');
    try { await action(); }
    catch (reason) {
      if (reason instanceof ScriptBlockError) inspectBlock(reason.blockId ?? null, true);
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
    checkCallbackContexts(compileScriptProgram(graph));
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
    setLuaTab(current => current === 'variables' ? current : 'code');
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
      const file = serializeScriptFile(saved);
      const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
      const link = viewDocument.createElement('a');
      link.href = url; link.download = defaultName; viewDocument.body.appendChild(link);
      link.click(); link.remove();
      viewWindow.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast({ kind: 'success', title: '脚本已导出' });
  };

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="主站脚本编辑器">
    <header className="script-draft-toolbar">
      <div className="script-block-search"><Search16Regular aria-hidden="true" />
        <input ref={searchInput} type="text" role="searchbox" aria-label="搜索积木" placeholder="搜索积木或变量" autoComplete="off"
          value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); setSearch(''); } }} />
        {search && <button type="button" className="focus-ring" aria-label="清除积木搜索" onClick={() => { setSearch(''); searchInput.current?.focus(); }}><Dismiss16Regular /></button>}
      </div>
      <div className="script-draft-name">
        <TextInput aria-label="流程名称" className={dirty ? 'pr-14' : undefined} value={name} maxLength={120} onChange={event => setName(event.target.value)} />
        {dirty && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-ink2">未保存</span>}
      </div>
      <Button size="sm" disabled={!dirty || !timeout.success || working || conflict} onClick={() => void perform(async () => { await save(); toast({ kind: 'success', title: '流程已保存' }); })}>保存</Button>
      {live ? <>
        <Button size="sm" className="min-w-14" variant={live.state === 'paused' ? 'primary' : 'secondary'}
          disabled={working || live.state === 'pausing' || live.state === 'stopping'}
          title={live.state === 'paused' ? '继续执行此流程' : '暂停事件和脚本执行'}
          onClick={() => void perform(() => debugControl(live.state === 'paused' ? 'continue' : 'pause'))}>{live.state === 'paused' ? '继续' : '暂停'}</Button>
        <Button size="sm" disabled={live.state === 'stopping'} onClick={() => void command({ type: 'script.stop', runId: live.id })}>停止</Button>
        <Button size="sm" disabled={working || live.state !== 'paused'} title="暂停后执行下一步" onClick={() => void perform(() => debugControl('step'))}>单步</Button>
      </> : <>
        <Button size="sm" variant="primary" disabled={working || conflict || !timeout.success} onClick={() => void perform(() => start())}>运行</Button>
        <Button size="sm" title="在第一步执行前暂停。右键积木可设置断点" disabled={working || conflict || !timeout.success} onClick={() => void perform(() => start(true))}>调试</Button>
      </>}
      <label className="script-callback-timeout" title={callbackTimeoutHelp}>
        主回调超时
        <input className="focus-ring" type="number" required aria-label="主回调超时（毫秒）" aria-invalid={!timeout.success}
          aria-describedby={timeout.success ? timeoutHelpId : `${timeoutHelpId} ${timeoutHelpId}-error`}
          min={CALLBACK_TIMEOUT_MS.min} max={CALLBACK_TIMEOUT_MS.max} step={1}
          value={timeoutText} onChange={event => setTimeoutText(event.target.value)} />
        ms
      </label>
      <span id={timeoutHelpId} className="sr-only">{callbackTimeoutHelp}</span>
      <Button size="sm" aria-expanded={showLua} title="Lua 预览、变量观察与静态校验" onClick={() => setShowLua(!showLua)}>{showLua ? '收起检查器' : 'Lua / 变量'}</Button>
      <Button size="sm" disabled={working || conflict || !timeout.success} onClick={() => void perform(exportScript)}>导出</Button>
      <Button size="sm" variant="quiet" disabled={working || ongoing(run) || conflict} onClick={() => void perform(remove)}>删除</Button>
    </header>
    {conflict && <div className="flex items-center gap-3 bg-accentsoft px-3 py-2 text-xs" role="status">此流程已在其他页面修改
      <button className="focus-ring text-accent" onClick={async () => {
        if (dirty && !await confirm('当前修改会被丢弃。')) return;
        reload();
      }}>重新载入</button>
    </div>}
    {(!timeout.success || error) && <p id={timeoutHelpId + '-error'} className="shrink-0 break-words px-3 py-2 text-sm text-err" role="alert">
      {timeout.success ? error : timeout.error.issues[0]!.message}
    </p>}
    <div ref={split} className={`script-split ${wide ? 'is-wide' : 'is-compact'}`} style={{ '--lua-width': luaWidth + 'px' } as React.CSSProperties}>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScriptEditor ref={editor} key={editorKey} graph={graph} equipment={equipment} palette={palette} breakpoints={breakpoints}
          search={search} variableNames={mainNames} onCreateVariable={() => { setShowLua(true); setLuaTab('variables'); setCreateVariable(true); }} onClearSearch={() => setSearch('')}
          onBreakpoint={id => void perform(() => toggleBreakpoint(id))} onChange={next => setGraph(current => withScriptBreakpoints(next, current.breakpoints ?? []))} onSelect={inspectBlock}
          onFindPoint={findPoint} onReady={() => setEditorReady(key => key + 1)} />
        {working && <div className="absolute inset-0 z-10 cursor-progress" aria-hidden="true" />}
      </div>
      {showLua && <>
        {wide && <LuaDivider min={minLuaWidth} max={maxLuaWidth} width={luaWidth} onChange={width => setPanes(value => ({ ...value, width }))} />}
        <LuaPane preview={preview} tab={luaTab} onTab={setLuaTab} selection={selection} executing={executing} pauseToken={pauseToken}
          createVariable={createVariable} variableFormOpened={() => setCreateVariable(false)} groups={groups} run={matchesRun ? run : null} published={published}
          onPublish={value => setPublished(current => current.includes(value) ? current.filter(n => n !== value) : [...current, value])}
          onSelect={(id, line) => inspectBlock(id, true, line)} onCopy={async () => {
            const lua = preview?.source;
            if (!lua) return;
            try { await viewWindow.navigator.clipboard.writeText(lua.text); toast({ kind: 'success', title: 'Lua 已复制' }); }
            catch { toast({ kind: 'error', title: '剪贴板不可用，请选择并复制代码。' }); }
          }} />
      </>}
    </div>
    {run?.pendingWrite && <section className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-surface px-3 py-2 text-sm" aria-label="待确认写入">
      <strong>高风险写入</strong><span className="break-all">{run.pendingWrite.target} → {run.pendingWrite.value}</span>
      <Button size="sm" variant="primary" onClick={() => void command({ type: 'script.confirmWrite', runId: run.id, token: run.pendingWrite!.token })}>确认下发</Button>
      <Button size="sm" onClick={() => void command({ type: 'script.stop', runId: run.id })}>停止流程</Button>
    </section>}
    {run?.pause && <section className="script-debug-pause" aria-label="调试暂停">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong>{pauseLabels[run.pause.reason]}</strong>
        <span>{run.current?.source && `${run.current.triggerLabel ?? run.current.source} · `}{run.current?.label}</span>{run.pause.writePreview !== undefined && <span>待写值 <b className="mono">{run.pause.writePreview}</b></span>}
        {run.pause.writeError && <span className="text-err">写值不可用 · {run.pause.writeError}</span>}</div>
      {run.pause.variables.length > 0 && <details><summary>运行变量（{run.pause.variables.length}）</summary>
        <dl>{run.pause.variables.map(variable => <div key={variable.name}><dt>{variable.name}</dt><dd>{variable.value}</dd></div>)}</dl></details>}
    </section>}
    {!lookup && (judgment || selectedPoint || selectedFunction || (selectedBlock && isScriptStatement(selectedBlock.type))) && <section className="max-h-28 shrink-0 overflow-auto border-t border-line bg-surface px-3 py-2 text-xs" aria-label="积木检查">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{judgment && <><strong className={'script-verdict ' + (judgment.matched ? 'is-true' : '')}>上次判断 · {judgment.matched === null ? '待确认' : judgment.matched ? '真' : '假'}</strong>
        <span className="min-w-0 break-words">{judgment.detail}</span></>}
        {selectedBlock && isScriptStatement(selectedBlock.type) && <button className="script-breakpoint-control focus-ring" aria-pressed={!!breakpoints?.includes(selectedBlock.id)}
          onClick={() => void perform(() => toggleBreakpoint(selectedBlock.id))}>{breakpoints?.includes(selectedBlock.id) ? '移除断点' : '设置断点'}</button>}
        {selectedFunction && <button className="focus-ring text-accent" onClick={() => inspectBlock(selectedFunction.id, true)}>定位函数定义</button>}
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
    <section className="script-results" aria-label="运行结果">
      <div className="script-results-heading" role="status">
        <h2 className="font-semibold">运行日志</h2>
        {run ? <><span>{runLabels[run.state]}</span>
        <span className="text-xs text-ink2">已结算 {run.completed} 步</span>
        {live && run.callbackTimeoutMs !== undefined && (!timeout.success || timeout.data !== run.callbackTimeoutMs)
          && <span className="script-event-status">本次主回调超时 {run.callbackTimeoutMs} ms</span>}
        {ongoing(run) && Boolean(run.events?.inputs?.length) && <span className="script-event-status">监听 {run.events?.inputs?.length} 个事件</span>}
        {run.events?.onRun && <span className="script-event-status">on_run · {run.events.onRun.periodMs} ms · {run.events.onRun.calls} 次{ongoing(run) && !run.events.onRun.enabled && ' · 周期已暂停'}</span>}
        {run.events?.timers.map(timer => <span className="script-event-status" key={timer.channel}>T{timer.channel} · {timer.periodMs} ms · {timer.remaining === null ? '循环' : `剩余 ${timer.remaining} 次`}</span>)}
        {run.current && !run.pause && <span className="break-words text-xs">{run.current.label}</span>}
        {run.detail && <span className="break-words text-xs">{run.detail}</span>}
        {run.events && <button type="button" className="script-log-filter focus-ring" aria-pressed={logsOnly}
          onClick={() => setLogsOnly(!logsOnly)}>只看日志</button>}
        {!matchesRun && <span className="text-xs text-ink2">日志来自运行时的版本，点击可定位草稿中保留的积木。</span>}
        </> : <span className="text-xs text-ink2">暂无运行记录</span>}
      </div>
      {run && <ol className="script-result-rows space-y-1 text-xs" aria-label="步骤结果">
        {shownEntries.slice().reverse().map((entry, index) => <li className="flex items-baseline gap-2" key={`${entry.sequence ?? run.completed - index}-${entry.blockId}`}>
          <button disabled={!draftBlocks.has(entry.blockId)} title={!draftBlocks.has(entry.blockId) ? '此积木已移除' : undefined}
            className="focus-ring min-w-0 flex-1 break-words text-left enabled:hover:text-accent" onClick={() => {
            setLookup(null); setLuaTab('code'); setShowLua(true); inspectBlock(entry.blockId, true);
          }}>
            {entry.log && <time className="mono mr-2 text-ink2" dateTime={new Date(entry.atMs).toISOString()}>{logClock?.format(entry.atMs)}</time>}
            <span className={entry.log ? 'text-accent' : entry.result === 'ok' ? 'text-ok' : entry.result === 'failed' ? 'text-err' : 'text-ink2'}>{entry.log ? '日志' : entry.handled ? '已处理失败' : entry.result === 'ok' ? '通过' : entry.result === 'failed' ? '失败' : '停止'}</span>
            {entry.source && <span className="mono"> · {entry.trigger?.label ?? entry.source}</span>}
            {!entry.log && <> · {entry.label}</>} · {entry.detail}
          </button>
          {entry.trigger?.binding.kind === 'widget' && <button className="focus-ring shrink-0 text-accent" type="button" onClick={() => {
            const ref = entry.trigger?.binding;
            if (ref?.kind === 'widget') environment?.openTarget?.('canvas', { canvasId: ref.canvasId, canvasFocusId: ref.widgetId });
          }}>定位源控件</button>}
        </li>)}
      </ol>}
    </section>
  </section>;
}
