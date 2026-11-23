import * as Blockly from 'blockly/core';
import { isScriptStatement, MAX_SCRIPT_BLOCKS, type ScriptGraph } from '../../../domain/master-script';
import type { Workspace } from '../../../domain/model';
import { bindings, generateScriptLua, graphOf, makeFieldOptions, scriptToolbox } from './blocks';
import { loadScriptGraph } from './block-controls';
import { ScriptToolbox, type PaletteState } from './palette';

export interface ScriptEditorApi {
  lua(): string;
  highlight(blockId: string | null, center?: boolean | 'if-hidden'): void;
}

export interface ScriptEditorInput {
  graph: ScriptGraph;
  equipment: Workspace | null;
  palette?: PaletteState;
  breakpoints?: readonly string[];
  onBreakpoint?(id: string): void;
  onChange(graph: ScriptGraph): void;
  onSelect?(id: string | null): void;
  onFindPoint?(key: string): void;
}

interface EditorHost extends ScriptEditorApi {
  updateBindings(): void;
  updateBreakpoints(): void;
  dispose(): void;
}

export type MountScriptEditor = (element: HTMLElement, input: () => ScriptEditorInput) => EditorHost;
export interface ScriptEditorWindow extends Window {
  mountMasterScriptEditor?: (element: HTMLElement, input: () => ScriptEditorInput) => Promise<EditorHost | null>;
}

const scriptTheme = Blockly.Theme.defineTheme('modbus', {
  name: 'modbus', base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: '#f9fbfd', toolboxBackgroundColour: '#f3f6f9', toolboxForegroundColour: '#233446',
    flyoutBackgroundColour: '#ffffff', flyoutOpacity: 1, scrollbarColour: '#93a3b2', scrollbarOpacity: 0.65,
    selectedGlowColour: '#126cc7', selectedGlowOpacity: 0.55, insertionMarkerColour: '#1764ad', replacementGlowColour: '#1976bd',
  },
  fontStyle: { family: '"Microsoft YaHei", "Segoe UI", sans-serif', size: 10, weight: '500' },
});

const editorInputs = new WeakMap<Blockly.Workspace, () => ScriptEditorInput>();
if (Blockly.ContextMenuRegistry.registry.getItem('modbusBreakpoint')) Blockly.ContextMenuRegistry.registry.unregister('modbusBreakpoint');
Blockly.ContextMenuRegistry.registry.register({
  id: 'modbusBreakpoint', weight: 0, scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
  displayText: ({ block }) => block && editorInputs.get(block.workspace)?.().breakpoints?.includes(block.id) ? '移除断点' : '设置断点',
  preconditionFn: ({ block }) => block && !block.isInFlyout && isScriptStatement(block.type) && editorInputs.has(block.workspace) ? 'enabled' : 'hidden',
  callback: ({ block }) => { if (block) editorInputs.get(block.workspace)?.().onBreakpoint?.(block.id); },
});
if (Blockly.ContextMenuRegistry.registry.getItem('modbusFindPoint')) Blockly.ContextMenuRegistry.registry.unregister('modbusFindPoint');
Blockly.ContextMenuRegistry.registry.register({
  id: 'modbusFindPoint', weight: 1, scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
  displayText: '查找此点位的读写',
  preconditionFn: ({ block }) => block && !block.isInFlyout && block.getFieldValue('POINT') && editorInputs.has(block.workspace) ? 'enabled' : 'hidden',
  callback: ({ block }) => {
    if (block) editorInputs.get(block.workspace)?.().onFindPoint?.(String(block.getFieldValue('POINT')));
  },
});

export const mountScriptEditor: MountScriptEditor = (element, input) => {
  const workspace = Blockly.inject(element, {
    toolbox: scriptToolbox,
    plugins: { toolbox: ScriptToolbox },
    renderer: 'zelos', theme: scriptTheme, disable: true,
    rendererOverrides: { MIN_BLOCK_HEIGHT: 36, DUMMY_INPUT_MIN_HEIGHT: 26, EMPTY_INLINE_INPUT_HEIGHT: 26,
      FIELD_BORDER_RECT_HEIGHT: 26, FIELD_DROPDOWN_BORDER_RECT_HEIGHT: 26, BOTTOM_ROW_AFTER_STATEMENT_MIN_HEIGHT: 16 },
    grid: { spacing: 24, length: 1, colour: '#d1dce6', snap: false },
    maxBlocks: MAX_SCRIPT_BLOCKS,
    trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.95, minScale: 0.35, maxScale: 2 },
    media: new URL('./blockly-media/', document.baseURI).href,
    sounds: false,
    scrollbars: true,
  });
  editorInputs.set(workspace, input);
  const updateBindings = () => {
    const { graph, equipment } = input();
    bindings.set(workspace, makeFieldOptions(equipment, graph));
    for (const block of workspace.getAllBlocks(false)) {
      block.getField('POINT')?.forceRerender();
      block.getField('SLAVE')?.forceRerender();
    }
  };
  updateBindings();
  Blockly.Events.disable();
  try { loadScriptGraph(input().graph, workspace); }
  catch (error) { workspace.dispose(); throw error; }
  finally { Blockly.Events.enable(); }
  const updateBreakpoints = () => {
    const ids = new Set(input().breakpoints);
    for (const block of workspace.getAllBlocks(false)) {
      const root = block.getSvgRoot();
      const dot = root.querySelector(':scope > .script-breakpoint-dot');
      if (ids.has(block.id) && !dot) {
        Blockly.utils.dom.createSvgElement('circle', { class: 'script-breakpoint-dot', cx: -7, cy: 10, r: 5, 'aria-label': '断点' }, root);
      } else if (!ids.has(block.id)) dot?.remove();
    }
  };
  updateBreakpoints();
  const toolbox = workspace.getToolbox();
  if (toolbox instanceof ScriptToolbox) toolbox.start(input().palette, scriptToolbox.contents.map(category => category.colour));
  const changed = (event: Blockly.Events.Abstract) => {
    if (event.workspaceId !== workspace.id) return;
    if (event.type === Blockly.Events.SELECTED) input().onSelect?.((event as Blockly.Events.Selected).newElementId ?? null);
    if (event.type === Blockly.Events.CLICK && (event as Blockly.Events.Click).targetType === 'block') input().onSelect?.((event as Blockly.Events.Click).blockId ?? null);
    if (!event.isUiEvent && event.type !== Blockly.Events.FINISHED_LOADING) input().onChange(graphOf(workspace));
  };
  workspace.addChangeListener(changed);
  let highlighted: Blockly.BlockSvg | null = null;
  const reveal = (block: Blockly.BlockSvg, onlyIfHidden: boolean) => {
    const shape = block.getSvgRoot()?.querySelector(':scope > .blocklyPath')?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    if (!shape || !bounds.width || !bounds.height) return;
    const palette = element.querySelector('.blocklyToolboxFlyout .blocklyFlyoutBackground')?.getBoundingClientRect();
    const rail = element.querySelector('.blocklyToolbox')?.getBoundingClientRect();
    const left = Math.max(palette?.right ?? 0, rail?.right ?? 0, bounds.left) + 22;
    const top = bounds.top + 8;
    const width = Math.max(0, bounds.right - 16 - left);
    const height = Math.max(0, bounds.bottom - 16 - top);
    if (onlyIfHidden && shape.left >= left && shape.top >= top &&
      shape.left + Math.min(shape.width, width) <= left + width + 1 &&
      shape.top + Math.min(shape.height, height) <= top + height + 1) return;
    // Center the selected step itself. A long C-block keeps its header in view.
    workspace.scroll(workspace.scrollX + left + Math.max(0, width - shape.width) / 2 - shape.left,
      workspace.scrollY + top + Math.max(0, height - shape.height) / 2 - shape.top);
  };
  const layout = new ResizeObserver(() => {
    Blockly.svgResize(workspace);
    if (highlighted) reveal(highlighted, true);
  });
  layout.observe(element);
  Blockly.svgResize(workspace);

  return {
    updateBindings,
    updateBreakpoints,
    lua: () => generateScriptLua(workspace, graphOf(workspace)),
    highlight: (id, center) => {
      const block = id ? workspace.getBlockById(id) : null;
      if (block !== highlighted) {
        const previous = highlighted?.getSvgRoot();
        previous?.classList.remove('script-highlight');
        previous?.querySelector(':scope > .script-location-arrow')?.remove();
        highlighted = block;
        workspace.highlightBlock(block?.id ?? null);
        if (block) {
          const root = block.getSvgRoot();
          root.classList.add('script-highlight');
          Blockly.utils.dom.createSvgElement('path', { class: 'script-location-arrow', d: 'M -21 3 L -11 10 L -21 17 Z', 'aria-hidden': 'true' }, root);
        }
      }
      if (center && block) reveal(block, center === 'if-hidden');
    },
    dispose: () => {
      layout.disconnect();
      workspace.removeChangeListener(changed);
      bindings.delete(workspace);
      editorInputs.delete(workspace);
      workspace.dispose();
    },
  };
};
