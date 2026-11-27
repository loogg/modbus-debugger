import * as Blockly from 'blockly/core';
import { isEventHat, isScriptStatement, MAX_SCRIPT_BLOCKS, scriptBlocks, type ScriptGraph } from '../../../domain/master-script';
import type { Workspace } from '../../../domain/model';
import { bindings, inspectScriptDraft, graphOf, makeFieldOptions, updateCycleHints } from './blocks';
import { scriptToolbox } from './block-palette';
import type { ScriptPreview } from './lua-source';
import { synchronizeScriptFunctions } from './function-blocks';
import { loadScriptGraph } from './block-controls';
import { ScriptToolbox, type PaletteState } from './palette';

export interface ScriptEditorApi {
  preview(): ScriptPreview;
  inspect(blockId: string | null, reveal?: boolean): void;
  markExecution(blockId: string | null, paused: boolean): void;
}

export interface ScriptEditorInput {
  graph: ScriptGraph;
  equipment: Workspace | null;
  palette?: PaletteState;
  search: string;
  variableNames: readonly string[];
  onClearSearch(): void;
  onCreateVariable?(): void;
  onViewChange?(view: ScriptCanvasView): void;
  breakpoints?: readonly string[];
  onBreakpoint?(id: string): void;
  onChange(graph: ScriptGraph): void;
  onSelect?(id: string | null): void;
  onFindPoint?(key: string): void;
}

export interface ScriptCanvasView { percent: number; undo: boolean; redo: boolean }
interface EditorHost extends ScriptEditorApi {
  undo(redo: boolean): void;
  zoom(direction: number): void;
  center(): void;
  updateBindings(): void;
  updatePalette(): void;
  updateBreakpoints(): void;
  dispose(): void;
}

export type MountScriptEditor = (element: HTMLElement, input: () => ScriptEditorInput) => EditorHost;
export interface ScriptEditorWindow extends Window {
  mountMasterScriptEditor?: (element: HTMLElement, input: () => ScriptEditorInput) => Promise<EditorHost | null>;
}

// Follow the actual rendered shape when inputs resize or a C-block gains an arm.
function outlineBlock(block: Blockly.BlockSvg) {
  const root = block.getSvgRoot();
  const shape = root.querySelector(':scope > .blocklyPath:not(.blocklyPathSelected)');
  const group = Blockly.utils.dom.createSvgElement('g', { class: 'script-block-outline', 'aria-hidden': 'true' }, root);
  const layers = ['rim', 'band', 'core'].map(layer => Blockly.utils.dom.createSvgElement('path', { class: 'outline-' + layer }, group));
  const sync = () => layers.forEach(path => path.setAttribute('d', shape?.getAttribute('d') ?? ''));
  const observer = new MutationObserver(sync);
  if (shape) observer.observe(shape, { attributes: true, attributeFilter: ['d'] });
  sync();
  return () => { observer.disconnect(); group.remove(); };
}

const scriptTheme = Blockly.Theme.defineTheme('modbus', {
  name: 'modbus', base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: '#f5f7fa', toolboxBackgroundColour: '#ffffff', toolboxForegroundColour: '#233446',
    flyoutBackgroundColour: '#f8fafc', flyoutOpacity: 1, scrollbarColour: '#a9b6c5', scrollbarOpacity: 0.68,
    selectedGlowColour: '#126cc7', selectedGlowOpacity: 0.55, insertionMarkerColour: '#1764ad', replacementGlowColour: '#1976bd',
  },
  fontStyle: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', size: 12, weight: '600' },
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
    rendererOverrides: { MIN_BLOCK_HEIGHT: 32, DUMMY_INPUT_MIN_HEIGHT: 23, EMPTY_INLINE_INPUT_HEIGHT: 24,
      FIELD_BORDER_RECT_HEIGHT: 24, FIELD_DROPDOWN_BORDER_RECT_HEIGHT: 24, EMPTY_STATEMENT_INPUT_HEIGHT: 24,
      CORNER_RADIUS: 7, NOTCH_WIDTH: 24, NOTCH_HEIGHT: 4, NOTCH_OFFSET_LEFT: 15, FIELD_BORDER_RECT_RADIUS: 10,
      START_HAT_WIDTH: 86, START_HAT_HEIGHT: 15, TOP_ROW_MIN_HEIGHT: 5, BOTTOM_ROW_MIN_HEIGHT: 5,
      SMALL_PADDING: 4, MEDIUM_PADDING: 6, LARGE_PADDING: 10, BOTTOM_ROW_AFTER_STATEMENT_MIN_HEIGHT: 10 },
    grid: { spacing: 20, length: 1.5, colour: '#cbd6e2', snap: false },
    maxBlocks: MAX_SCRIPT_BLOCKS,
    trashcan: true,
    zoom: { controls: false, wheel: true, startScale: 0.95, minScale: 0.35, maxScale: 2, scaleSpeed: 1.15 },
    media: new URL('./blockly-media/', document.baseURI).href,
    sounds: false,
    scrollbars: true,
  });
  editorInputs.set(workspace, input);
  workspace.registerButtonCallback('CREATE_WORKSPACE_VARIABLE', () => input().onCreateVariable?.());
  const updateBindings = () => {
    const { graph, equipment } = input();
    bindings.set(workspace, makeFieldOptions(equipment, graph));
    for (const block of workspace.getAllBlocks(false)) {
      block.getField('POINT')?.forceRerender();
      block.getField('SLAVE')?.forceRerender();
      block.getField('WIDGET')?.forceRerender();
      block.getField('EVENT')?.forceRerender();
      block.getField('TAG')?.forceRerender();
    }
  };
  updateBindings();
  Blockly.Events.disable();
  try { loadScriptGraph(input().graph, workspace); }
  catch (error) { workspace.dispose(); throw error; }
  finally { Blockly.Events.enable(); }
  updateCycleHints(workspace);
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
  const updatePalette = () => {
    if (toolbox instanceof ScriptToolbox) toolbox.updatePalette(input().search, input().variableNames);
  };
  if (toolbox instanceof ScriptToolbox) toolbox.start(input().palette, () => input().onClearSearch());
  updatePalette();
  let canvasView: ScriptCanvasView | undefined;
  const updateCanvasView = () => {
    const percent = Math.round(workspace.scale * 100);
    const undo = workspace.getUndoStack().length > 0;
    const redo = workspace.getRedoStack().length > 0;
    if (canvasView?.percent === percent && canvasView.undo === undo && canvasView.redo === redo) return;
    canvasView = { percent, undo, redo };
    input().onViewChange?.(canvasView);
  };
  updateCanvasView();
  const changed = (event: Blockly.Events.Abstract) => {
    if (event.workspaceId !== workspace.id) return;
    updateCanvasView();
    const click = event.type === Blockly.Events.CLICK ? event as Blockly.Events.Click : null;
    const id = click?.blockId ?? (event.type === Blockly.Events.SELECTED ? (event as Blockly.Events.Selected).newElementId : null);
    const block = id ? workspace.getBlockById(id) : null;
    if (block) input().onSelect?.(block.isShadow() ? block.getParent()?.id ?? null : block.id);
    else if (click?.targetType === 'workspace') input().onSelect?.(null);
    if (!event.isUiEvent && event.type !== Blockly.Events.FINISHED_LOADING) {
      updateCycleHints(workspace);
      synchronizeScriptFunctions(workspace);
      input().onChange(graphOf(workspace));
    }
  };
  workspace.addChangeListener(changed);
  let selected: Blockly.BlockSvg | null = null;
  let executing: Blockly.BlockSvg | null = null;
  const outlines = new Map<Blockly.BlockSvg, () => void>();
  const updateOutline = (block: Blockly.BlockSvg | null) => {
    if (!block) return;
    if (block === selected || block === executing) {
      if (!outlines.has(block)) outlines.set(block, outlineBlock(block));
    } else {
      outlines.get(block)?.();
      outlines.delete(block);
    }
  };
  let viewportAnchor: Blockly.BlockSvg | null = null;
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
  const roots = workspace.getTopBlocks(true);
  let initialEvent = roots.some(block => block.type === scriptBlocks.start) ? undefined : roots.find(block => isEventHat(block.type));
  const layout = new ResizeObserver(() => {
    Blockly.svgResize(workspace);
    if (toolbox instanceof ScriptToolbox) toolbox.revealSelectedCategory();
    if (viewportAnchor && !viewportAnchor.isDisposed()) reveal(viewportAnchor, true);
    else if (initialEvent && element.clientWidth && element.clientHeight) {
      if (!initialEvent.isDisposed()) { Blockly.renderManagement.triggerQueuedRenders(workspace); reveal(initialEvent, true); }
      initialEvent = undefined;
    }
  });
  layout.observe(element);
  Blockly.svgResize(workspace);

  return {
    updateBindings,
    updatePalette,
    updateBreakpoints,
    undo: redo => { workspace.undo(redo); updateCanvasView(); },
    zoom: direction => { workspace.zoomCenter(direction); updateCanvasView(); },
    center: () => workspace.scrollCenter(),
    preview: () => inspectScriptDraft(workspace, input().graph),
    inspect: (id, center) => {
      const block = id ? workspace.getBlockById(id) : null;
      if (block !== selected) {
        const previous = selected;
        previous?.getSvgRoot()?.classList.remove('script-selected');
        selected = block;
        block?.getSvgRoot().classList.add('script-selected');
        updateOutline(previous); updateOutline(block);
      }
      if (center && block) { viewportAnchor = block; reveal(block, false); }
    },
    markExecution: (id, paused) => {
      const block = id ? workspace.getBlockById(id) : null;
      if (block !== executing) {
        const previous = executing;
        previous?.getSvgRoot()?.classList.remove('script-current');
        previous?.getSvgRoot()?.querySelector(':scope > .script-location-arrow')?.remove();
        executing = block;
        if (block) {
          const root = block.getSvgRoot();
          root.classList.add('script-current');
          // The margin of the entire stack stays clear of branch and function labels.
          const margin = block.getRootBlock().getRelativeToSurfaceXY().x - block.getRelativeToSurfaceXY().x;
          Blockly.utils.dom.createSvgElement('path', { class: 'script-location-arrow', d: 'M -21 3 L -11 10 L -21 17 Z',
            transform: `translate(${margin},0)`, 'aria-hidden': 'true' }, root);
        }
        updateOutline(previous); updateOutline(block);
      }
      if (paused && block) { viewportAnchor = block; reveal(block, true); }
    },
    dispose: () => {
      layout.disconnect();
      for (const remove of outlines.values()) remove();
      workspace.removeChangeListener(changed);
      bindings.delete(workspace);
      editorInputs.delete(workspace);
      workspace.dispose();
    },
  };
};
