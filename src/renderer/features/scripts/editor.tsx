import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useViewDocument } from '../../workbench/view-context';
import { mountScriptEditor, type ScriptEditorApi, type ScriptEditorInput, type ScriptEditorWindow } from './editor-host';

export type { ScriptEditorApi } from './editor-host';

export const ScriptEditor = forwardRef<ScriptEditorApi, ScriptEditorInput & { onReady(): void }>(function ScriptEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const installed = useRef<ReturnType<typeof mountScriptEditor> | null>(null);
  const current = useRef(props);
  current.current = props;
  const viewDocument = useViewDocument();
  const [problem, setProblem] = useState('');

  useImperativeHandle(ref, () => ({
    lua: () => {
      if (!installed.current) throw new Error('积木编辑器尚未就绪');
      return installed.current.lua();
    },
    highlight: (id, center) => installed.current?.highlight(id, center),
  }), []);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let mounted: ReturnType<typeof mountScriptEditor> | null = null;
    const input = () => current.current;
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
  const breakpointKey = JSON.stringify(props.breakpoints ?? []);
  useLayoutEffect(() => installed.current?.updateBreakpoints(), [breakpointKey]);

  return <>
    <div ref={host} className="script-editor absolute inset-0" aria-label="Blockly 积木工作区" />
    {problem && <p className="absolute left-4 top-4 rounded bg-surface p-3 text-sm text-err" role="alert">{problem}</p>}
  </>;
});
