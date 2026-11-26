import * as Blockly from 'blockly/core';
import { displayLuaScalar, luaNumericLiteral } from '../../../domain/script-lua-operators';
import { fieldText, isScriptCall, isScriptDefinition, MAX_SCRIPT_BLOCKS, normalizeScriptGraph, scriptBlocks, scriptGraphBlocks, scriptNumberSlots, splitParameters, type ScriptBlock, type ScriptGraph } from '../../../domain/master-script';
import { synchronizeScriptFunctions } from './function-blocks';

export class BooleanSwitch extends Blockly.Field<string> {
  override SERIALIZABLE = true;
  private thumb?: SVGCircleElement;
  private caption?: SVGTextElement;
  constructor(value = 'FALSE') {
    super(value);
    this.setTooltip(() => this.getValue() === 'UNSET' ? '条件尚未设置。点击选择真或假，或拖入条件积木。' : '点击切换真或假，或拖入条件积木。');
  }
  protected override getText_(): string {
    const value = this.getValue();
    return value === 'TRUE' ? '真' : value === 'FALSE' ? '假' : '未设置';
  }
  protected override showEditor_(): void {
    this.getSvgRoot()?.focus({ preventScroll: true });
    this.setValue(this.getValue() === 'TRUE' ? 'FALSE' : 'TRUE');
  }
  protected override initView(): void {
    const root = this.getSvgRoot()!;
    const block = this.getSourceBlock();
    if (block instanceof Blockly.BlockSvg) block.getSvgRoot().classList.add('script-bool-literal');
    root.classList.add('blocklyField', 'script-switch');
    root.setAttribute('tabindex', block?.isInFlyout ? '-1' : '0');
    const svg = Blockly.utils.dom.createSvgElement;
    // Give the switch its own viewport; Zelos styles direct field children as text boxes.
    const face = svg('svg', { width: 48, height: 26, 'aria-hidden': 'true', focusable: 'false' }, root);
    svg('rect', { width: 48, height: 26, fill: 'transparent' }, face);
    svg('rect', { class: 'script-switch-track', x: 1, y: 2, width: 46, height: 22, rx: 11 }, face);
    this.thumb = svg('circle', { class: 'script-switch-thumb', cy: 13, r: 8 }, face);
    this.caption = svg('text', { class: 'script-switch-label', y: 13, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, face);
    root.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.showEditor(event);
    });
  }
  protected override render_(): void {
    this.size_ = new Blockly.utils.Size(48, 26);
    const root = this.getSvgRoot();
    if (!root || !this.thumb || !this.caption) return;
    const value = this.getValue();
    const on = value === 'TRUE';
    const unset = !on && value !== 'FALSE';
    root.setAttribute('data-script-bool', value ?? 'UNSET');
    root.setAttribute('role', unset ? 'checkbox' : 'switch');
    root.setAttribute('aria-label', unset ? '布尔条件，未设置' : '布尔条件');
    root.setAttribute('aria-checked', unset ? 'mixed' : String(on));
    this.thumb.setAttribute('cx', unset ? '24' : on ? '36' : '12');
    this.caption.setAttribute('x', unset ? '24' : on ? '14' : '34');
    this.caption.textContent = unset ? '−' : on ? '真' : '假';
  }
  protected override doClassValidation_(value: string): string | null {
    return ['TRUE', 'FALSE', 'UNSET'].includes(value) ? value : null;
  }
}

export function conditionInput(block: Blockly.Block, name: string, label?: string) {
  const input = block.appendValueInput(name).setCheck(['Boolean', 'ConditionValue']);
  if (label) input.appendField(label);
  input.connection!.setShadowState({ type: scriptBlocks.boolean, fields: { BOOL: 'FALSE' } });
  return input;
}

export function numberSlot(block: Blockly.Block, name: string, numericOnly: boolean) {
  const input = block.appendValueInput(name).setCheck(numericOnly ? 'ScriptNumber' : ['ScriptValue', 'Boolean']);
  const initial = scriptNumberSlots[block.type as ScriptBlock['type']]![name]!;
  input.connection!.setShadowState({ type: scriptBlocks.number, fields: { NUM: initial } });
  return input;
}

export class LogValueControl extends Blockly.Field<string> {
  override SERIALIZABLE = true;
  constructor() {
    super('OFF');
    this.setTooltip(() => this.connected() ? '移出附加值后可收起值槽' : this.getValue() === 'ON' ? '收起空值槽' : '附加变量、点位值或计算结果');
  }
  private connected() { return !!this.getSourceBlock()?.getInputTargetBlock('OPERAND'); }
  protected override getText_() { return this.getValue() === 'ON' ? (this.connected() ? '值' : '−值') : '＋值'; }
  protected override doClassValidation_(value: string) {
    return value === 'ON' || (value === 'OFF' && !this.connected()) ? value : null;
  }
  protected override doValueUpdate_(value: string) {
    super.doValueUpdate_(value);
    const block = this.getSourceBlock();
    if (!block) return;
    if (value === 'ON' && !block.getInput('OPERAND')) block.appendValueInput('OPERAND').setCheck(['ScriptValue', 'Boolean']);
    if (value === 'OFF' && block.getInput('OPERAND')) block.removeInput('OPERAND');
  }
  protected override showEditor_() {
    if (!this.connected() && !this.getSourceBlock()?.isInFlyout) this.setValue(this.getValue() === 'ON' ? 'OFF' : 'ON');
  }
  protected override initView() {
    super.initView();
    const root = this.getSvgRoot()!;
    root.classList.add('script-log-toggle');
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', this.getSourceBlock()?.isInFlyout ? '-1' : '0');
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) this.showEditor(event);
    });
  }
  protected override render_() {
    super.render_();
    const root = this.getSvgRoot();
    const on = this.getValue() === 'ON';
    root?.setAttribute('aria-expanded', String(on));
    root?.setAttribute('aria-disabled', String(this.connected()));
    root?.setAttribute('aria-label', this.connected() ? '日志已连接附加值' : on ? '收起日志附加值' : '展开日志附加值');
  }
}

export const literalShadow = 'mb_slot_literal';
type Slot = { shadow?: { type: string; fields?: Record<string, string | number> }; block?: unknown };

// Blockly shadows give a literal and a connected reporter the same socket.
// The portable graph keeps literal defaults in fields, including while a reporter is connected.
export function loadScriptGraph(graph: ScriptGraph, workspace: Blockly.Workspace) {
  const native = normalizeScriptGraph(graph);
  const functions = new Map(native.blocks?.blocks.filter(root => isScriptDefinition(root.type)).map(root => [root.id, splitParameters(fieldText(root, 'PARAMS'))]));
  for (const block of scriptGraphBlocks(native)) {
    const inputs = block.inputs ??= {};
    const addShadow = (input: string, type: string, field: string, value: string | number) => {
      const entry: Slot = inputs[input] ??= {};
      entry.shadow = { type, fields: { [field]: value } };
    };
    if (block.type === scriptBlocks.log && inputs.OPERAND?.block) (block.fields ??= {}).WITH_VALUE = 'ON';
    const numbers = { ...scriptNumberSlots[block.type] };
    if (isScriptCall(block.type)) {
      const parameters = block.extraState?.parameters ?? functions.get(fieldText(block, 'FUNCTION')) ?? [];
      block.extraState = { parameters };
      parameters.forEach((_, i) => { numbers['ARG' + i] = 0; });
    }
    for (const [socket, initial] of Object.entries(numbers)) {
      addShadow(socket, scriptBlocks.number, 'NUM', fieldText(block, socket) || initial);
      delete block.fields?.[socket];
    }
    if (block.type === scriptBlocks.write || block.type === scriptBlocks.compare) {
      addShadow('OPERAND', literalShadow, 'TEXT', fieldText(block, 'VALUE'));
      delete block.fields?.VALUE;
    }
    // Older files omit an unconfigured condition. Keep it unconfigured on load.
    let conditionSlots: string[] = [];
    if (block.type === scriptBlocks.and || block.type === scriptBlocks.or) conditionSlots = ['A', 'B'];
    else if (block.type === scriptBlocks.branch) {
      conditionSlots = ['CONDITION', ...Array.from({ length: block.extraState?.elseIfCount ?? 0 }, (_, i) => 'COND' + (i + 1))];
    } else if ([scriptBlocks.wait, scriptBlocks.assert, scriptBlocks.not, scriptBlocks.repeatUntil].some(type => type === block.type)) {
      conditionSlots = ['CONDITION'];
    }
    for (const name of conditionSlots) {
      addShadow(name, scriptBlocks.boolean, 'BOOL', fieldText(block, 'BOOL_' + name) || 'UNSET');
      delete block.fields?.['BOOL_' + name];
    }
  }
  Blockly.serialization.workspaces.load(native, workspace);
  synchronizeScriptFunctions(workspace);
  if (workspace instanceof Blockly.WorkspaceSvg) {
    const roots = native.blocks?.blocks ?? [];
    if (roots.every(root => Number.isFinite(root.x) && Number.isFinite(root.y))) return;
    Blockly.renderManagement.triggerQueuedRenders(workspace);
    const positioned = roots.filter(root => Number.isFinite(root.x) && Number.isFinite(root.y));
    const occupied = positioned.map(root => workspace.getBlockById(root.id)!.getBoundingRectangle());
    for (const root of roots) {
      if (Number.isFinite(root.x) && Number.isFinite(root.y)) continue;
      const block = workspace.getBlockById(root.id)!;
      const rect = block.getBoundingRectangle();
      const x = root.x ?? 30;
      let y = root.y ?? 30;
      const width = rect.right - rect.left, height = rect.bottom - rect.top;
      for (const other of occupied.sort((a, b) => a.top - b.top)) {
        if (x < other.right + 28 && x + width + 28 > other.left && y < other.bottom + 28 && y + height + 28 > other.top) y = other.bottom + 28;
      }
      block.moveBy(x - rect.left, y - rect.top);
      occupied.push(block.getBoundingRectangle());
    }
  }
}

export function saveScriptGraph(workspace: Blockly.Workspace): ScriptGraph {
  const graph = JSON.parse(JSON.stringify(Blockly.serialization.workspaces.save(workspace))) as ScriptGraph;
  for (const block of scriptGraphBlocks(graph)) {
    if (block.type === scriptBlocks.number && block.fields?.NUM !== undefined) {
      block.fields.NUM = displayLuaScalar(luaNumericLiteral(String(block.fields.NUM)));
    }
    if (block.type === scriptBlocks.log && (block.fields?.WITH_VALUE === 'OFF' || block.inputs?.OPERAND?.block)) delete block.fields?.WITH_VALUE;
    for (const [name, slot] of Object.entries(block.inputs ?? {}) as [string, Slot][]) {
      const shadow = slot.shadow;
      if (!shadow) continue;
      if (shadow.type === literalShadow) (block.fields ??= {}).VALUE = shadow.fields?.TEXT ?? '0';
      else if (shadow.type === scriptBlocks.number) (block.fields ??= {})[name] = displayLuaScalar(luaNumericLiteral(String(shadow.fields?.NUM ?? 0)));
      else if (shadow.type === scriptBlocks.boolean && shadow.fields?.BOOL && shadow.fields.BOOL !== 'UNSET') {
        (block.fields ??= {})['BOOL_' + name] = shadow.fields.BOOL;
      }
      delete slot.shadow;
      if (!slot.block) delete block.inputs![name];
    }
    if (block.inputs && !Object.keys(block.inputs).length) delete block.inputs;
  }
  return graph;
}

type BranchShape = { elseIfCount: number; hasElse: boolean; removedConstant?: string };
interface BranchBlock extends Blockly.Block {
  branchShape: BranchShape;
  loadExtraState(state: BranchShape): void;
}

function applyShape(block: BranchBlock, shape: BranchShape) {
  const count = shape.elseIfCount;
  if (!Number.isInteger(count) || count < 0 || count > MAX_SCRIPT_BLOCKS || typeof shape.hasElse !== 'boolean') {
    throw new Error('无效的分支配置');
  }
  for (let i = block.branchShape.elseIfCount; i > count; i--) {
    block.removeInput('COND' + i);
    block.removeInput('YES' + i);
  }
  if (!shape.hasElse && block.getInput('NO')) block.removeInput('NO');
  for (let i = block.branchShape.elseIfCount + 1; i <= count; i++) {
    conditionInput(block, 'COND' + i, '否则如果');
    block.appendStatementInput('YES' + i);
    if (block.getInput('NO')) {
      block.moveInputBefore('COND' + i, 'NO');
      block.moveInputBefore('YES' + i, 'NO');
    }
  }
  if (shape.hasElse && !block.getInput('NO')) block.appendStatementInput('NO').appendField('否则');
  if (shape.removedConstant && count) {
    block.getInputTargetBlock('COND' + count)?.getField('BOOL')?.setValue(shape.removedConstant);
  }
  block.branchShape = { elseIfCount:count, hasElse:shape.hasElse };
}

export function initBranch(block: Blockly.Block) {
  const branch = block as BranchBlock;
  branch.branchShape = { elseIfCount: 0, hasElse: false };
  branch.saveExtraState = () => ({ ...branch.branchShape });
  branch.loadExtraState = state => applyShape(branch, state);
  const menu = new Blockly.FieldDropdown(() => {
    const { elseIfCount, hasElse } = branch.branchShape;
    const options: [string, string][] = [['分支', 'menu']];
    if (elseIfCount < MAX_SCRIPT_BLOCKS) options.push(['添加「否则如果」', 'add-if']);
    if (!hasElse) options.push(['添加「否则」', 'add-else']);
    if (hasElse && !branch.getInputTargetBlock('NO')) options.push(['移除空的「否则」', 'remove-else']);
    const lastCondition = branch.getInputTargetBlock('COND' + elseIfCount);
    if (elseIfCount && (!lastCondition || lastCondition.isShadow()) && !branch.getInputTargetBlock('YES' + elseIfCount)) {
      options.push(['移除最后一个空条件分支', 'remove-if']);
    }
    return options;
  });
  menu.SERIALIZABLE = false;
  menu.setTooltip('添加或移除「否则如果」和「否则」');
  menu.setValidator(choice => {
    if (choice === 'menu' || block.isInFlyout) return null;
    const old = { ...branch.branchShape };
    if (choice === 'remove-if') old.removedConstant = branch.getInputTargetBlock('COND' + old.elseIfCount)?.getFieldValue('BOOL');
    const next = { elseIfCount: old.elseIfCount + (choice === 'add-if' ? 1 : choice === 'remove-if' ? -1 : 0),
      hasElse: choice === 'add-else' || (old.hasElse && choice !== 'remove-else') };
    Blockly.Events.disable();
    try { applyShape(branch, next); } finally { Blockly.Events.enable(); }
    Blockly.Events.fire(new Blockly.Events.BlockChange(branch, 'mutation', null, JSON.stringify(old), JSON.stringify(next)));
    return null;
  });
  branch.setInputsInline(true);
  branch.appendDummyInput('BRANCH_OPTIONS').appendField(menu);
  branch.appendStatementInput('YES');
}
