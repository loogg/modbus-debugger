import { LuaNames } from './script-lua-names';
import { lowerLuaExpression, luaBinaryCall, luaLiteral } from './script-lua-operators';
import { scriptBlocks, scriptGraphBlocks, type ScriptCondition, type ScriptGraph, type ScriptOperand, type ScriptPointRef,
  type ScriptProgram, type ScriptStep } from './master-script';

export interface LuaSource {
  text: string;
  lines: { text: string; blockId: string | null }[];
  ranges: Map<string, { first: number; last: number }>;
}

function quote(value: string): string {
  return '"' + Array.from(value, c => {
    if (c === '"' || c === '\\') return '\\' + c;
    const code = c.charCodeAt(0);
    return code < 32 || code === 127 ? '\\' + String(code).padStart(3, '0') : c;
  }).join('') + '"';
}
const target = (ref: ScriptPointRef) => `${quote(ref.slaveId)}, ${quote(ref.pointId)}`;
const indent = (text: string) => text.replace(/^(?=.)/gm, '  ');
const thunk = (value: string) => value.includes('\n') ? `function()\n${indent('return ' + value)}\nend` : `function() return ${value} end`;

// Mark validated IR nodes, not line contents: repeated statements and nested
// operands on the same line must retain independent block identities.
class SourceMapWriter {
  private readonly ids: string[] = [];
  constructor(private readonly known: ReadonlySet<string>) {}
  mark(id: string | undefined, code: string) {
    if (!id || !this.known.has(id) || !code) return code;
    const n = this.ids.push(id) - 1;
    const end = code.endsWith('\n');
    return `\x00${n};` + (end ? code.slice(0, -1) : code) + '\x00/;' + (end ? '\n' : '');
  }
  finish(code: string): LuaSource {
    const stack: string[] = [];
    const ranges: LuaSource['ranges'] = new Map();
    const lines = code.trim().split('\n').map((line, index) => {
      let blockId: string | null = null, text = '';
      const append = (part: string) => { if (blockId === null && part.trim()) blockId = stack.at(-1) ?? null; text += part; };
      const [head, ...spans] = line.split('\x00');
      append(head!);
      for (const span of spans) {
        const end = span.indexOf(';'), token = span.slice(0, end);
        if (token === '/') ranges.get(stack.pop()!)!.last = index;
        else {
          const id = this.ids[Number(token)]!;
          stack.push(id); if (!ranges.has(id)) ranges.set(id, { first: index, last: index });
        }
        append(span.slice(end + 1));
      }
      return { text, blockId };
    });
    return { text: lines.map(l => l.text).join('\n'), lines, ranges };
  }
}

function crossesProtectedLoop(steps: ScriptStep[], protectedBody = false): boolean {
  return steps.some(step => {
    if (step.kind === 'break') return protectedBody;
    if (step.kind === 'attempt') return crossesProtectedLoop(step.steps, true) || crossesProtectedLoop(step.handler, true);
    return step.kind === 'branch' && (step.arms.some(a => crossesProtectedLoop(a.steps, protectedBody)) || crossesProtectedLoop(step.no, protectedBody));
  });
}

export function renderScriptLua(graph: ScriptGraph, program: ScriptProgram): LuaSource {
  const blocks = new Map(Array.from(scriptGraphBlocks(graph), b => [b.id, b]));
  const writer = new SourceMapWriter(new Set(blocks.keys()));
  const mark = (id: string | undefined, code: string) => writer.mark(id, code);
  const functions = new Map(program.functions.map(f => [f.id, f]));
  const start = graph.blocks?.blocks.find(b => b.type === scriptBlocks.start && b.enabled !== false && !b.disabledReasons?.length);
  const events = program.handlers;
  const entries = [...(events?.onRun ? [events.onRun] : []), ...events?.timers ?? [], ...events?.inputs ?? []];
  const names = new LuaNames(start, program.functions.map(f => blocks.get(f.id)!), events ? entries.map(e => blocks.get(e.blockId)!) : undefined);
  const read = (root: string, name: string) => `_ops.read(${names.variable(root, name)}, ${quote(name)})`;

  function localValue(o: ScriptOperand): boolean {
    switch (o.kind) {
      case 'point': return false;
      case 'arithmetic': return localValue(o.left) && localValue(o.right);
      case 'condition': return nativeCondition(o.condition);
      case 'callValue': {
        const fn = functions.get(o.functionId)!;
        return fn.kind === 'calculation' && localValue(fn.result) && o.args.every(localValue);
      }
      default: return true;
    }
  }
  function nativeCondition(c: ScriptCondition): boolean {
    if (c.kind === 'truth') return localValue(c.operand);
    if (c.kind === 'error') return true;
    if (c.kind === 'compareValues') return localValue(c.left) && localValue(c.right);
    if (c.kind === 'and' || c.kind === 'or') return nativeCondition(c.left) && nativeCondition(c.right);
    return c.kind === 'not' && nativeCondition(c.operand);
  }
  function knownBoolean(value: ScriptOperand): boolean {
    if (value.kind === 'boolean' || value.kind === 'timerRunning' || value.kind === 'condition') return true;
    if (value.kind !== 'callValue') return false;
    const fn = functions.get(value.functionId)!;
    return fn.kind === 'calculation' && knownBoolean(fn.result);
  }
  function call(root: string, id: string, args: ScriptOperand[]): string {
    const values = args.map(a => operand(root, a)).join(', ');
    return `${names.functions.get(id)}(${args.length > 50 ? `table.unpack({${values}}, 1, ${args.length})` : values})`;
  }
  function operand(root: string, o: ScriptOperand): string {
    let code: string;
    switch (o.kind) {
      case 'number': code = luaLiteral(o.integerText ?? String(o.value)); break;
      case 'boolean': code = String(o.value); break;
      case 'literal': code = quote(o.text); break;
      case 'variable': code = read(root, o.name); break;
      case 'arithmetic': return lowerLuaExpression(o, leaf => operand(root, leaf), luaBinaryCall, (node, text) => mark(node.blockId, text));
      case 'point': code = `modbus.value(${target(o.ref)})`; break;
      case 'workspaceValue': code = `rt.get_workspace_variable(${quote(o.variableId)})`; break;
      case 'eventValue': code = 'rt.event_value()'; break;
      case 'timerElapsed': code = `rt.get_timer_value(${o.channel})`; break;
      case 'timerRunning': code = `rt.is_timer_running(${o.channel})`; break;
      case 'callValue': code = call(root, o.functionId, o.args); break;
      case 'condition': return condition(root, o.condition);
    }
    return mark(o.blockId, code);
  }
  function condition(root: string, c: ScriptCondition, outer = 0): string {
    let code: string, precedence = 4;
    switch (c.kind) {
      case 'truth': {
        const value = operand(root, c.operand);
        code = knownBoolean(c.operand) ? value : `_ops.truth(${value})`;
        break;
      }
      case 'compareValues': code = luaBinaryCall(c.relation, operand(root, c.left), operand(root, c.right)); break;
      case 'compare': code = `modbus.compare(${target(c.ref)}, ${quote(c.relation)}, ${operand(root, c.operand)})`; break;
      case 'range': code = `modbus.in_range(${target(c.ref)}, ${c.min}, ${c.max})`; break;
      case 'state': code = `modbus.state(${quote(c.slaveId)}, ${quote(c.state)})`; break;
      case 'error': code = `_ops.error_is(${quote(c.code)})`; break;
      case 'not':
        if (nativeCondition(c)) { precedence = 3; code = `not ${condition(root, c.operand, precedence)}`; }
        else code = `modbus.negate(${thunk(condition(root, c.operand))})`;
        break;
      case 'or': case 'and':
        if (nativeCondition(c)) {
          precedence = c.kind === 'or' ? 1 : 2;
          code = `${condition(root, c.left, precedence)} ${c.kind} ${condition(root, c.right, precedence)}`;
        } else {
          const predicates = [c.left, c.right].map(v => thunk(condition(root, v))).join(',\n');
          code = `modbus.${c.kind === 'and' ? 'all' : 'any'}(\n${indent(predicates)}\n)`;
        }
        break;
    }
    return mark(c.blockId, precedence < outer ? `(${code})` : code);
  }
  function test(root: string, c: ScriptCondition, outer = 0) {
    return nativeCondition(c) ? condition(root, c, outer) : `modbus.check(${thunk(condition(root, c))})`;
  }
  function sequence(root: string, steps: ScriptStep[], signalBreak = false): string {
    return steps.map(s => mark(s.blockId, statement(root, s, signalBreak))).join('');
  }
  function statement(root: string, s: ScriptStep, signalBreak: boolean): string {
    const val = (o: ScriptOperand) => operand(root, o);
    const body = (steps: ScriptStep[]) => indent(sequence(root, steps, signalBreak));
    switch (s.kind) {
      case 'setVariable': return `${names.assignment(root, s.blockId, s.variable)} = ${val(s.operand)}\n`;
      case 'setWorkspaceValue': return `rt.set_workspace_variable(${quote(s.variableId)}, ${val(s.operand)})\n`;
      case 'changeVariable': return `${names.variable(root, s.variable)} = ${luaBinaryCall('add', read(root, s.variable), val(s.operand))}\n`;
      case 'call': return call(root, s.functionId, s.args) + '\n';
      case 'capture': return `${names.assignment(root, s.blockId, s.variable)} = modbus.value(${target(s.ref)})\n`;
      case 'read': return `modbus.read(${target(s.ref)}, ${s.timeoutMs})\n`;
      case 'write': return `modbus.write(${target(s.ref)}, ${val(s.operand)})\n`;
      case 'log': {
        const args = [s.message && quote(s.message), s.operand && `_ops.observe(${thunk(val(s.operand))})`].filter(Boolean);
        return `print(${args.join(', ')})\n`;
      }
      case 'runPeriod': return `rt.set_run_period(${val(s.period)})\n`;
      case 'runControl': return `rt.${s.enabled ? 'start' : 'stop'}_run()\n`;
      case 'timerStart': return `rt.start_timer(${s.channel}, ${val(s.period)}, ${s.count})\n`;
      case 'timerStop': return `rt.stop_timer(${s.channel})\n`;
      case 'delay': return `${events ? 'sleep_ms' : 'modbus.delay'}(${s.ms})\n`;
      case 'stop': return 'modbus.stop()\n';
      case 'break': return signalBreak ? '_ops.break_loop()\n' : 'break\n';
      case 'assert': return `modbus.assert(${thunk(condition(root, s.condition))})\n`;
      case 'wait': return `modbus.wait(${thunk(condition(root, s.condition))}, ${s.timeoutMs})\n`;
      case 'attempt': return `_ops.attempt(function()\n${body(s.steps)}end${s.handler.length ? ', function()\n' + body(s.handler) + 'end' : ''})\n`;
      case 'branch': {
        const arms = s.arms.map((arm, i) => `${i ? 'elseif' : 'if'} ${test(root, arm.condition)} then\n${body(arm.steps)}`).join('');
        return arms + (blocks.get(s.blockId)?.extraState?.hasElse || s.no.length ? 'else\n' + body(s.no) : '') + 'end\n';
      }
      case 'repeat': case 'repeatUntil': case 'forever': {
        const header = s.kind === 'repeat' ? `for _step = 1, ${s.count} do` :
          s.kind === 'forever' ? 'while true do' : `while not ${test(root, s.condition, 3)} do`;
        const crossing = crossesProtectedLoop(s.steps);
        let inner = sequence(root, s.steps, crossing);
        if (crossing) inner = 'if not _ops.loop_step(function()\n' + indent(inner) + 'end) then break end\n';
        if (events && root === start?.id) inner += 'coroutine.yield()\n';
        else if (events && functions.has(root)) inner += 'if coroutine.isyieldable() then coroutine.yield() end\n';
        return header + '\n' + indent(inner) + 'end\n';
      }
    }
  }
  const parts = names.definitionIds.map(id => {
    const f = functions.get(id)!;
    const body = names.preamble(id) + (f.kind === 'calculation' ? `return ${operand(id, f.result)}\n` : sequence(id, f.steps));
    return mark(id, `local function ${names.functions.get(id)}(${names.parameters(id)})\n${indent(body)}end\n`);
  });
  if (events) {
    const declarations = names.preamble(start?.id ?? entries[0]!.blockId);
    if (declarations) parts.unshift(declarations);
    const published: string[] = [];
    const callback = (name: string, id: string, steps: ScriptStep[]) => {
      parts.push(mark(id, `local function ${name}()\n${indent(sequence(id, steps))}end\n`));
      published.push(`${name} = ${name}`);
    };
    if (start) callback('on_start', start.id, program.steps);
    if (events.onRun) {
      callback('on_run', events.onRun.blockId, events.onRun.steps);
      published.push(`run_period_ms = ${events.onRun.periodMs}`);
    }
    if (events.timers.length) {
      const arms = events.timers.map((t, i) => mark(t.blockId, `  ${i ? 'elseif' : 'if'} _timer_id == ${t.channel} then\n${indent(indent(sequence(t.blockId, t.steps)))}`));
      parts.push(`local function on_timer(_timer_id)\n${arms.join('')}  end\nend\n`);
      published.push('on_timer = on_timer');
    }
    if (events.inputs?.length) {
      const inputs = events.inputs.map(({ binding, blockId, steps }) => {
        const fields = binding.kind === 'widget'
          ? `canvas = ${quote(binding.canvasId)}, widget = ${quote(binding.widgetId)}, event = ${quote(binding.event)}`
          : `variable = ${quote(binding.variableId)}`;
        return mark(blockId, `{ ${fields}, handle = function()\n${indent(sequence(blockId, steps))}end }`);
      });
      published.push(`inputs = {\n${indent(inputs.join(',\n'))}\n}`);
    }
    parts.push(`return { ${published.join(', ')} }`);
  } else if (start) {
    const main = names.preamble(start.id) + sequence(start.id, program.steps);
    parts.push(mark(start.id, names.wrapMain ? `local function _run_main()\n${indent(main)}end\n_run_main()\n` : main));
  }
  let code = parts.join('\n').trim();
  if (program.lua.source) code = `local function _script_main(_ops)\n${indent(code)}\nend\n\n${program.lua.source}\n\nreturn _script_main(_ops)`;
  return writer.finish(code);
}
