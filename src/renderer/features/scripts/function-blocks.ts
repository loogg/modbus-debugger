import * as Blockly from 'blockly/core';
import { isScriptCall, isScriptDefinition, MAX_SCRIPT_BLOCKS, scriptBlocks, splitParameters } from '../../../domain/master-script';

type Option = [string, string];
type CallBlock = Blockly.Block & { argumentNames: string[] };
const field = (block: Blockly.Block, key: string) => String(block.getFieldValue(key) ?? '');
const params = (block: Blockly.Block) => splitParameters(field(block, 'PARAMS')).slice(0, MAX_SCRIPT_BLOCKS);
const owner = (block: Blockly.Block) => block.workspace instanceof Blockly.WorkspaceSvg ? block.workspace.targetWorkspace ?? block.workspace : block.workspace;

// An imported or copied reference can precede its definition during deserialization.
// Keep its stable ID and resolve its display name from the live workspace.
export class ScriptReferenceField extends Blockly.FieldDropdown {
  protected override doClassValidation_(value?: string) { return typeof value === 'string' ? value : null; }
  protected override getText_(): string {
    const match = this.getOptions(false).find(([, id]) => id === this.getValue())?.[0];
    return typeof match === 'string' ? match : '引用失效';
  }
}

export class ParameterListField extends Blockly.FieldTextInput {
  constructor() {
    super('');
    this.setTooltip('输入英文参数名，多个名字用逗号分隔，例如 temperature, threshold。');
  }
  protected override getText_() { return this.getValue() || '无'; }
}

export function parameterField(block: Blockly.Block) {
  return new ScriptReferenceField(function (this: Blockly.FieldDropdown) {
    const root = block.getRootBlock();
    const options: Option[] = [['选择参数', '']];
    if (isScriptDefinition(root.type)) params(root).forEach((name, i) => options.push([name || '未命名参数', String(i)]));
    const selected = this.getValue();
    if (selected && !options.some(([, id]) => id === selected)) options.push(['参数已失效', selected]);
    return options;
  });
}

function shapeArguments(block: CallBlock, parameters: string[]) {
  const old = block.argumentNames;
  let count = parameters.length;
  // A changed declaration must not discard a connected expression or an edited literal.
  for (let i = count; i < old.length; i++) {
    const child = block.getInputTargetBlock('ARG' + i);
    if (child && (!child.isShadow() || Number(child.getFieldValue('NUM')) !== 0)) count = i + 1;
  }
  for (let i = old.length - 1; i >= count; i--) block.removeInput('ARG' + i);
  for (let i = 0; i < count; i++) {
    const name = parameters[i] ?? old[i] ?? '';
    const label = i < parameters.length ? name || '参数 ' + (i + 1) : '多余·' + name;
    const key = 'ARG_LABEL' + i;
    if (!block.getInput('ARG' + i)) {
      const socket = block.appendValueInput('ARG' + i).setCheck(['ScriptValue', 'Boolean']).appendField(new Blockly.FieldLabel(label), key);
      socket.connection!.setShadowState({ type: scriptBlocks.number, fields: { NUM: 0 } });
    } else if (block.getFieldValue(key) !== label) block.setFieldValue(label, key);
  }
  block.argumentNames = [...parameters, ...old.slice(parameters.length, count)];
}

export function initFunctionCall(block: Blockly.Block, header: Blockly.Input) {
  const call = block as CallBlock;
  call.argumentNames = [];
  const definitionType = block.type === scriptBlocks.callValue ? scriptBlocks.calculation : scriptBlocks.procedure;
  const reference = new ScriptReferenceField(function (this: Blockly.FieldDropdown) {
    const options: Option[] = [['选择函数', '']];
    for (const fn of owner(block).getBlocksByType(definitionType, false)) {
      if (fn.isEnabled()) options.push([field(fn, 'NAME').trim() || '未命名函数', fn.id]);
    }
    const selected = this.getValue();
    if (selected && !options.some(([, id]) => id === selected)) options.push(['函数已失效', selected]);
    return options;
  });
  reference.setValidator(value => {
    const fn = owner(block).getBlockById(value);
    if (fn?.type === definitionType && Blockly.Events.isEnabled()) shapeArguments(call, params(fn));
    return value;
  });
  header.appendField<string>(reference, 'FUNCTION');
  block.saveExtraState = () => ({ parameters: [...call.argumentNames] });
  block.loadExtraState = (state: { parameters: string[] }) => shapeArguments(call, state.parameters);
  // Each external input keeps its label beside the connected value. Long
  // signatures would otherwise push a surrounding branch beyond the canvas.
  block.getInputsInline = () => {
    if (call.argumentNames.length <= 1) return true;
    if (call.argumentNames.length > 2) return false;
    return call.argumentNames.every((name, i) => {
      const value = block.getInputTargetBlock('ARG' + i);
      return name.length <= 8 && (!value || value.type === scriptBlocks.number);
    });
  };
}

const visibleNames = new WeakMap<Blockly.Field, string>();
function refreshName(reference: Blockly.Field | null) {
  if (!reference) return;
  const text = reference.getText();
  if (visibleNames.get(reference) !== text) {
    visibleNames.set(reference, text);
    reference.forceRerender();
  }
}

export function synchronizeScriptFunctions(workspace: Blockly.Workspace) {
  for (const block of workspace.getAllBlocks(false)) {
    if (isScriptCall(block.type)) {
      const fn = workspace.getBlockById(field(block, 'FUNCTION'));
      if (fn && isScriptDefinition(fn.type)) shapeArguments(block as CallBlock, params(fn));
      refreshName(block.getField('FUNCTION'));
    } else if (block.type === scriptBlocks.parameter) refreshName(block.getField('PARAM'));
  }
}
