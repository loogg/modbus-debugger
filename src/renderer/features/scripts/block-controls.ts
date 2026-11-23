import * as Blockly from 'blockly/core';
import { fieldText, MAX_SCRIPT_BLOCKS, scriptBlocks, scriptGraphBlocks, type ScriptGraph } from '../../../domain/master-script';

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
  const input = block.appendValueInput(name).setCheck(['Boolean', 'ScriptValue']);
  if (label) input.appendField(label);
  input.connection!.setShadowState({ type: scriptBlocks.boolean, fields: { BOOL: 'FALSE' } });
  return input;
}

export const literalShadow = 'mb_slot_literal';
type Slot = { shadow?: { type: string; fields?: Record<string, string> }; block?: unknown };

// Blockly shadows give a literal and a connected reporter the same socket.
// The portable graph keeps literal defaults in fields, including while a reporter is connected.
export function loadScriptGraph(graph: ScriptGraph, workspace: Blockly.Workspace) {
  const native = structuredClone(graph);
  for (const block of scriptGraphBlocks(native)) {
    const inputs = block.inputs ??= {};
    const addShadow = (input: string, type: string, field: string, value: string) => {
      const entry: Slot = inputs[input] ??= {};
      entry.shadow = { type, fields: { [field]: value } };
    };
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
}

export function saveScriptGraph(workspace: Blockly.Workspace): ScriptGraph {
  const graph = JSON.parse(JSON.stringify(Blockly.serialization.workspaces.save(workspace))) as ScriptGraph;
  for (const block of scriptGraphBlocks(graph)) {
    for (const [name, slot] of Object.entries(block.inputs ?? {}) as [string, Slot][]) {
      const shadow = slot.shadow;
      if (!shadow) continue;
      if (shadow.type === literalShadow) (block.fields ??= {}).VALUE = shadow.fields?.TEXT ?? '0';
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
    block.appendStatementInput('YES' + i).appendField('成立时');
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
  branch.appendStatementInput('YES').appendField('成立时');
}
