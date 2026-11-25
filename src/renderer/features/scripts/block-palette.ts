import type { utils } from 'blockly/core';
import { scriptBlocks } from '../../../domain/master-script';

export const blockColours = {
  device: '#25709f', entry: '#885a09', control: '#a35316', condition: '#435eae',
  variable: '#aa356d', math: '#347343', log: '#19706d', function: '#7350a0',
};

type Entry = [keyof typeof scriptBlocks, string];
interface Category { name: string; colour: string; blocks: Entry[] }
const categories: Category[] = [
  { name: '设备操作', colour: blockColours.device, blocks: [
    ['read', '等待新采样 读取 点位'], ['write', '写入点位 写为'], ['readVariable', '读取到变量 点位 采样'],
    ['pointValue', '点位值 确认值']] },
  { name: '流程', colour: blockColours.control, blocks: [
    ['start', '开始 启动 入口'], ['branch', '如果 否则 分支 判断'], ['repeat', '重复 次 计次循环'],
    ['repeatUntil', '重复直到 循环'], ['forever', '主循环 一直重复'], ['delay', '延时 等待 毫秒'],
    ['wait', '等待条件 超时'], ['assert', '断言'], ['attempt', '尝试执行 出错时 异常处理'],
    ['breakLoop', '跳出循环'], ['stop', '停止流程']] },
  { name: '条件', colour: blockColours.condition, blocks: [
    ['compareValues', '比较 两个值 等于 大于 小于'], ['state', '从站状态 在线 离线'],
    ['compare', '比较 点位确认值'], ['compareVariable', '比较 点位 变量'], ['range', '范围 区间'],
    ['and', '并且 全部 与'], ['or', '或者 任一 或'], ['not', '取反 非'], ['boolean', '真假 布尔'],
    ['error', '本次错误 错误类型']] },
  { name: '变量', colour: blockColours.variable, blocks: [
    ['setVariable', '赋值 把变量设为 设置'], ['changeVariable', '给变量加 递增 累加'],
    ['variable', '取变量 选择变量']] },
  { name: '运算', colour: blockColours.math, blocks: [
    ['arithmetic', '四则运算 加减乘除 + - × ÷'], ['number', '数值 数字 常数']] },
  { name: '日志', colour: blockColours.log, blocks: [['log', '记录日志 打印 输出 print']] },
  { name: '函数', colour: blockColours.function, blocks: [
    ['procedure', '定义流程函数'], ['calculation', '定义计算函数 返回值'], ['call', '调用流程函数'],
    ['callValue', '调用计算函数 返回值'], ['parameter', '参数 入参 形参']] },
];

const blockItem = ([key]: Entry) => ({ kind: 'block', type: scriptBlocks[key], gap: 14 });
const variableCategory = categories.find(category => category.name === '变量')!;
export const variableCategoryKey = 'SCRIPT_VARIABLES';
export const scriptToolbox = {
  kind: 'categoryToolbox',
  contents: categories.map(category => ({ kind: 'category', name: category.name, colour: category.colour,
    ...(category === variableCategory ? { custom: variableCategoryKey } : { contents: category.blocks.map(blockItem) }) })),
};

function namedVariables(names: readonly string[]) {
  return names.map(name => ({ kind: 'block', type: scriptBlocks.variable, fields: { VARIABLE: name }, gap: 10 }));
}

export function variablePalette(names: readonly string[]): utils.toolbox.FlyoutItemInfoArray {
  return [...variableCategory.blocks.map(blockItem), ...(names.length ? [
    { kind: 'label', text: '主流程变量', id: undefined }, ...namedVariables(names),
  ] : [])];
}

export function searchPalette(query: string, names: readonly string[]): utils.toolbox.FlyoutItemInfoArray {
  const terms = query.toLowerCase().trim().split(/\s+/);
  const matches = (candidate: string) => terms.every(term => candidate.toLowerCase().includes(term));
  const items = categories.flatMap(category => category.blocks.filter(([key, words]) =>
    matches([category.name, words, key, scriptBlocks[key]].join(' '))).map(blockItem));
  const named = namedVariables(names.filter(name => matches('变量 ' + name)));
  return items.length || named.length ? [...named, ...items] : [{ kind: 'label', text: '没有匹配的积木', id: undefined }];
}
