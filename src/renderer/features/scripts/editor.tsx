import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Add16Regular, ArrowRedo16Regular, ArrowUndo16Regular, Subtract16Regular, Target16Regular } from '@fluentui/react-icons';
import { useViewDocument } from '../../workbench/view-context';
import { mountScriptEditor, type ScriptCanvasView, type ScriptEditorApi, type ScriptEditorInput, type ScriptEditorWindow } from './editor-host';

export type { ScriptEditorApi } from './editor-host';

export const ScriptEditor = forwardRef<ScriptEditorApi, ScriptEditorInput & { onReady(): void }>(function ScriptEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const installed = useRef<ReturnType<typeof mountScriptEditor> | null>(null);
  const current = useRef(props);
  current.current = props;
  const viewDocument = useViewDocument();
  const [problem, setProblem] = useState('');
  const [canvasView, setCanvasView] = useState<ScriptCanvasView>({ percent: 95, undo: false, redo: false });

  useImperativeHandle(ref, () => ({
    preview: () => {
      if (!installed.current) throw new Error('积木编辑器尚未就绪');
      return installed.current.preview();
    },
    inspect: (id, center) => installed.current?.inspect(id, center),
    markExecution: (id, paused) => installed.current?.markExecution(id, paused),
  }), []);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let mounted: ReturnType<typeof mountScriptEditor> | null = null;
    const input = () => ({ ...current.current, onViewChange: setCanvasView });
    const load = async () => {
      // Blockly owns document-scoped drag handlers, menus and styles. A detached
      // editor is mounted by the renderer in that window's own document.
      const target = viewDocument.defaultView as ScriptEditorWindow | null;
      const instance = viewDocument === document ? mountScriptEditor(element, input) : await target?.mountMasterScriptEditor?.(element, input);
      if (disposed) { instance?.dispose(); return; }
      if (!instance) throw new Error('窗口中的积木编辑器尚未就绪');
      mounted = instance;
      installed.current = instance;
      setProblem('');
      current.current.onReady();
    };
    void load().catch(error => { if (!disposed) setProblem(error instanceof Error ? error.message : String(error)); });
    return () => {
      disposed = true;
      mounted?.dispose();
      if (installed.current === mounted) installed.current = null;
    };
  }, [viewDocument]);

  useLayoutEffect(() => installed.current?.updateBindings(), [props.equipment]);
  useLayoutEffect(() => installed.current?.updatePalette(), [props.search, props.variableNames]);
  const breakpointKey = JSON.stringify(props.breakpoints ?? []);
  useLayoutEffect(() => installed.current?.updateBreakpoints(), [breakpointKey]);

  return <>
    <div ref={host} className="script-editor absolute inset-0" aria-label="Blockly 积木工作区" />
    {!problem && <div role="group" className="script-canvas-controls" aria-label="画布工具">
      <button type="button" aria-label="撤销" title="撤销" disabled={!canvasView.undo} onClick={() => installed.current?.undo(false)}><ArrowUndo16Regular /></button>
      <button type="button" aria-label="重做" title="重做" disabled={!canvasView.redo} onClick={() => installed.current?.undo(true)}><ArrowRedo16Regular /></button>
      <i aria-hidden="true" />
      <button type="button" aria-label="缩小积木" title="缩小" disabled={canvasView.percent <= 35} onClick={() => installed.current?.zoom(-1)}><Subtract16Regular /></button>
      <output aria-label="画布缩放">{canvasView.percent}%</output>
      <button type="button" aria-label="放大积木" title="放大" disabled={canvasView.percent >= 200} onClick={() => installed.current?.zoom(1)}><Add16Regular /></button>
      <button type="button" aria-label="居中积木" title="居中积木" onClick={() => installed.current?.center()}><Target16Regular />居中</button>
    </div>}
    {problem && <p className="absolute left-4 top-4 rounded bg-surface p-3 text-sm text-err" role="alert">{problem}</p>}
  </>;
});
