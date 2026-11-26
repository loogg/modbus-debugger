import type { ScriptOperand } from './master-script';
import type { LuaControlProgram } from './script-lua-control';

// These are Lua 5.4 functions. The workbench embeds the same definitions in
// copied source and in the per-script executable loaded by the desktop VM.
export const luaOperators = {
  add: '+', subtract: '-', multiply: '*', divide: '/',
  eq: '==', ne: '~=', gt: '>', ge: '>=', lt: '<', le: '<=',
} as const;
export type LuaOperator = keyof typeof luaOperators;
export type LuaScalar = number | bigint | boolean | string;
export type LuaHelper = 'read' | 'observe' | 'truth' | 'protected';
export interface ScriptLuaKernel { operators: LuaOperator[]; source: string; executable: string; expressionCount: number; observe: boolean; truth: boolean; control: LuaControlProgram }

export function luaBinaryCall(op: LuaOperator, left: string, right: string): string {
  return `_ops.${op}(${left}, ${right})`;
}

// Closure conversion at a resumable host boundary. Only live inputs cross
// the bridge; literals, evaluation order and nested operations stay in Lua.
export function lowerLuaExpression(node: ScriptOperand, input: (leaf: ScriptOperand) => string,
  binary = luaBinaryCall, mark = (_node: ScriptOperand, code: string) => code): string {
  if (node.kind === 'number') return mark(node, luaLiteral(node.integerText ?? String(node.value)));
  if (node.kind !== 'arithmetic') return input(node);
  return mark(node, binary(node.operator, lowerLuaExpression(node.left, input, binary, mark), lowerLuaExpression(node.right, input, binary, mark)));
}

export function luaLiteral(decimal: string): string {
  // Lua parses a leading minus after the literal; use the standard integer
  // constant at the one signed boundary whose positive magnitude is a float.
  return decimal === '-9223372036854775808' ? 'math.mininteger' : decimal;
}

export function compileLuaKernel(used: ReadonlySet<LuaOperator>, expressions: string[], helpers: ReadonlySet<LuaHelper>, control: LuaControlProgram): ScriptLuaKernel {
  const operators = (Object.keys(luaOperators) as LuaOperator[]).filter(op => used.has(op));
  const definitions = [luaOperatorDefinitions(new Set(operators)) || (helpers.size ? 'local _ops = {}' : '')];
  if (helpers.has('read')) definitions.push([
    'function _ops.read(value, name)',
    '  if value == nil then error("变量「" .. name .. "」尚未赋值", 0) end',
    '  return value', 'end',
  ].join('\n'));
  if (helpers.has('truth')) definitions.push([
    'function _ops.truth(value)',
    '  if value ~= nil and type(value) ~= "boolean" then error("条件需要布尔值", 0) end',
    '  return value', 'end',
  ].join('\n'));
  if (helpers.has('observe')) definitions.push([
    'function _ops.observe(read)',
    '  local ok, value = pcall(read)',
    '  if not ok then return tostring(value) end',
    '  if value == "" then return \'""\' end',
    '  if type(value) == "number" then value = math.tointeger(value) or value end',
    '  return tostring(value)', 'end',
  ].join('\n'));
  if (helpers.has('protected')) definitions.push(`local loop_exit = {}
local errors = setmetatable({}, { __mode = "k" })
function _ops.break_loop()
  error(loop_exit, 0)
end
function _ops.loop_step(body)
  local ok, reason = pcall(body)
  if ok then return true end
  if reason == loop_exit then return false end
  error(reason, 0)
end
function _ops.attempt(body, handler)
  local ok, reason = pcall(body)
  if ok then return end
  if not handler or reason == loop_exit or (type(reason) == "table" and reason.fatal) then error(reason, 0) end
  local thread = coroutine.running()
  local previous = errors[thread]
  errors[thread] = reason
  local handled, failure = pcall(handler)
  errors[thread] = previous
  if not handled then error(failure, 0) end
end
function _ops.error_is(code)
  local reason = errors[coroutine.running()]
  if reason == nil then error("「本次错误」需要放在「出错时」执行", 0) end
  if type(reason) == "table" and reason.kinds then
    for _, kind in ipairs(reason.kinds) do if kind == code then return true end end
    return false
  end
  return code == "evaluation"
end`);
  const source = definitions.join('\n');
  const closures = expressions.map(code => `function(input)\n  return ${code}\nend`);
  const executable = [control.source, source, source ? `return _ops, {\n${closures.join(',\n')}\n}` : ''].filter(Boolean).join('\n');
  return { operators, source, executable, expressionCount: expressions.length, observe: helpers.has('observe'), truth: helpers.has('truth'), control };
}

function luaOperatorDefinitions(used: ReadonlySet<LuaOperator>): string {
  if (!used.size) return '';
  const functions = ['local _ops = {}'];
  if (['add', 'subtract', 'multiply', 'divide'].some(op => used.has(op as LuaOperator))) functions.push([
    'local function finite(n)',
    '  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge',
    'end',
  ].join('\n'));
  for (const op of Object.keys(luaOperators) as LuaOperator[]) {
    if (!used.has(op)) continue;
    const numeric = op === 'add' || op === 'subtract' || op === 'multiply' || op === 'divide';
    const lines = [`function _ops.${op}(a, b)`];
    if (numeric) {
      lines.push('  if not finite(a) or not finite(b) then error("运算需要两个有限数值", 0) end');
      if (op === 'divide') lines.push('  if b == 0 then error("除数不能为零", 0) end');
      lines.push(`  local result = a ${luaOperators[op]} b`,
        '  if not finite(result) then error("运算结果超出有限数值范围", 0) end',
        '  return result');
    } else {
      lines.push('  if type(a) ~= type(b) then error("比较两侧的值类型不一致", 0) end');
      if (op !== 'eq' && op !== 'ne') lines.push('  if type(a) ~= "number" then error("大小比较需要两个数值", 0) end');
      lines.push(`  return a ${luaOperators[op]} b`);
    }
    functions.push([...lines, 'end'].join('\n'));
  }
  return functions.join('\n');
}

// Match Lua's decimal integer literal before converting anything to a JS double.
export function luaNumericLiteral(text: string): number | bigint {
  if (/^-?\d+$/.test(text)) {
    const integer = BigInt(text);
    if (integer === BigInt.asIntN(64, integer)) return integer;
  }
  return Number(text);
}

export function displayLuaScalar(value: LuaScalar): number | string | boolean {
  if (typeof value !== 'bigint') return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}
