import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckmarkCircle16Regular, Code16Regular, Copy16Regular, ErrorCircle16Regular, Eye16Regular } from '@fluentui/react-icons';
import * as Tabs from '@radix-ui/react-tabs';
import type { ScriptPreview } from './lua-source';
import { luaKeywords } from './lua-names';
import { VariableWatch } from './variable-watch';
import type { ScriptVariableGroup } from '../../../domain/master-script';
import type { ScriptRunView } from '../../../shared/script-run';

export interface ScriptSelection { blockId: string | null; line?: number }
export type LuaTab = 'code' | 'variables' | 'validation';

function colorLua(text: string) {
  const parts = text.split(/(--.*|"(?:\\.|[^"\\])*"|\b[A-Za-z_]\w*\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g);
  return parts.map((part, index) => {
    if (index % 2 === 0) return part;
    const style = part.startsWith('--') ? 'comment' : part.startsWith('"') ? 'string' : /^\d/.test(part) ? 'number'
      : luaKeywords.has(part) ? 'keyword' : part === 'modbus' || parts[index + 1]?.trimStart().startsWith('(') ? 'api' : null;
    return style ? <span key={index} className={'lua-' + style}>{part}</span> : part;
  });
}

export function LuaPane({ preview, tab, onTab, selection, executing, pauseToken, groups, run, onSelect, onCopy }: {
  preview: ScriptPreview | null; tab: LuaTab; onTab(tab: LuaTab): void;
  groups: ScriptVariableGroup[]; run: ScriptRunView | null;
  selection: ScriptSelection; executing: string | null; pauseToken?: string;
  onSelect(blockId: string, line?: number): void; onCopy(): void;
}) {
  const source = preview?.source;
  const issue = preview?.issue;
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const viewportLine = useRef<number>();
  const prefix = useId();
  const range = selection.blockId ? source?.ranges.get(selection.blockId) : undefined;
  const activeLine = range && selection.line !== undefined && selection.line >= range.first && selection.line <= range.last
    ? selection.line : range?.first;
  const executionLine = executing ? source?.ranges.get(executing)?.first : undefined;
  const colors = useMemo(() => source?.lines.map(line => colorLua(line.text)), [source]);
  const reveal = useCallback((index: number | undefined) => {
    viewportLine.current = index;
    if (!list || index === undefined || !list.clientHeight) return;
    const row = list.firstElementChild?.children[index] as HTMLElement | undefined;
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (bounds.top < top) list.scrollTop += Math.floor(bounds.top - top) - 2;
    else if (bounds.bottom > bottom) list.scrollTop += Math.ceil(bounds.bottom - bottom) + 2;
    const code = row.querySelector('code');
    const gutter = row.firstElementChild;
    if (list.scrollLeft && code && gutter && code.getBoundingClientRect().right <= gutter.getBoundingClientRect().right)
      list.scrollLeft = 0;
  }, [list]);
  useLayoutEffect(() => { reveal(activeLine); }, [selection, activeLine, source, reveal]);
  useLayoutEffect(() => { if (pauseToken) reveal(executionLine); }, [pauseToken, executionLine, source, reveal]);
  useLayoutEffect(() => {
    // The tab content can mount after its parent. Observe the actual scrollport.
    if (!list) return;
    const observer = new ResizeObserver(() => reveal(viewportLine.current));
    observer.observe(list);
    return () => observer.disconnect();
  }, [list, reveal]);
  const pick = (index: number, direction = 0) => {
    while (direction && source && index >= 0 && index < source.lines.length && !source.lines[index]?.blockId) index += direction;
    const id = source?.lines[index]?.blockId;
    if (id) onSelect(id, index);
  };
  const diagnostic = issue && <div className="script-validation is-issue" role="status">
    <ErrorCircle16Regular aria-hidden="true" /><div><strong>静态校验未通过</strong><p>{issue.message}</p>
      {issue.blockId && <button className="focus-ring" onClick={() => onSelect(issue.blockId!)}>定位积木</button>}
    </div>
  </div>;
  return <Tabs.Root asChild value={tab} onValueChange={value => onTab(value as LuaTab)}>
    <section className="script-lua-pane" aria-label="脚本检查器">
    <header className="script-lua-heading">
      <Tabs.List className="script-lua-tabs" aria-label="检查内容">
        <Tabs.Trigger value="code" className="focus-ring"><Code16Regular aria-hidden="true" />Lua <small>只读</small></Tabs.Trigger>
        <Tabs.Trigger value="variables" className="focus-ring"><Eye16Regular aria-hidden="true" />变量
          <small className="script-watch-count">{groups.reduce((sum, group) => sum + group.names.size, 0)}</small>
        </Tabs.Trigger>
        <Tabs.Trigger value="validation" className="focus-ring">校验
          {preview && <small className={issue ? 'has-issue' : 'is-valid'}>{issue ? '待修正' : '通过'}</small>}
        </Tabs.Trigger>
      </Tabs.List>
      {tab === 'code' && <button className="focus-ring script-lua-copy" aria-label="复制 Lua" title="复制 Lua" disabled={!source?.text} onClick={onCopy}>
        <Copy16Regular aria-hidden="true" />
      </button>}
    </header>
    <Tabs.Content value="variables" className="script-watch-body">
      <VariableWatch groups={groups} run={run} onSelect={onSelect} />
    </Tabs.Content>
    <Tabs.Content value="validation" className="script-validation-body">
      {diagnostic || (preview && <div className="script-validation is-valid" role="status"><CheckmarkCircle16Regular aria-hidden="true" />
        <div><strong>静态校验通过</strong><p>已检查流程入口、积木连接、参数和工作区绑定。</p></div></div>)}
    </Tabs.Content>
    <Tabs.Content value="code" className="script-code-body">
    {!source && diagnostic}
    {source && <div className="script-lua-lines" ref={setList} role="listbox" aria-label="生成的 Lua" tabIndex={0}
      aria-activedescendant={source.lines.length ? prefix + '-' + (activeLine ?? 0) : undefined}
      onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const last = source.lines.length - 1;
        const line = activeLine ?? -1;
        const keys: Record<string, number> = { ArrowDown: Math.min(last, line + 1), ArrowUp: Math.max(0, line - 1),
          Home: 0, End: last, Enter: Math.max(0, line), ' ': Math.max(0, line) };
        if (Object.hasOwn(keys, event.key)) {
          event.preventDefault();
          const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
          pick(keys[event.key]!, direction);
        }
      }}>
      <div className="script-lua-sheet" role="presentation">{source.lines.map((line, index) => <div key={index} id={prefix + '-' + index} role="option"
        aria-label={`第 ${index + 1} 行，${index === executionLine ? '当前步骤，' : ''}${line.text.trim()}`}
        aria-selected={index === activeLine} data-block-id={line.blockId} data-current={index === executionLine || undefined}
        data-selected={range && index >= range.first && index <= range.last || undefined}
        data-range-start={index === range?.first || undefined} data-range-end={index === range?.last || undefined}
        className="script-lua-line" onClick={event => {
          if (event.currentTarget.ownerDocument.getSelection()?.isCollapsed !== false) pick(index);
        }}>
        <span className="script-lua-gutter" aria-hidden="true" data-number={index + 1}><i className="script-range-bracket" /></span>
        <code>{colors?.[index]}</code>
      </div>)}</div>
    </div>}
    {(range || executionLine !== undefined) && <div className="script-code-status">
      {range && <span className="script-range-label">选中第 {range.first + 1}{range.last !== range.first && '–' + (range.last + 1)} 行</span>}
      {executionLine !== undefined && <span className="script-lua-position">{pauseToken ? '停在' : '执行'}第 {executionLine + 1} 行</span>}
    </div>}
    </Tabs.Content>
    </section></Tabs.Root>;
}

export function LuaDivider({ width, min, max, onChange }: {
  width: number; min: number; max: number; onChange(width: number): void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onChange(Math.min(max, Math.max(min, Math.round(value))));
  return <div className="script-lua-divider" role="separator" tabIndex={0} aria-label="检查器宽度" aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={width + ' 像素'}
    onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const sizes: Record<string, number> = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: min, End: max };
      if (Object.hasOwn(sizes, event.key)) { event.preventDefault(); resize(sizes[event.key]!); }
    }} />;
}
