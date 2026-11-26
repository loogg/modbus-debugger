import type { ScriptFunction, ScriptHandlers, ScriptStep } from './master-script';

export interface LuaControlProgram { source: string; groups: Record<string, number> }

// Lower the same verified statement tree that is printed as structured Lua into
// resumable Lua basic blocks. A main-state callback returns at a host operation;
// its lexical continuations can survive an asynchronous receipt without a thread.
export function compileLuaControl(steps: ScriptStep[], functions: ScriptFunction[], events?: ScriptHandlers<ScriptStep>): LuaControlProgram {
  const groups: ScriptStep[][] = [[]];
  const ids = new Map<string, number>();
  const group = (seq: ScriptStep[]) => {
    if (!seq.length) return 0;
    const first = seq[0]!.blockId;
    let id = ids.get(first);
    if (id === undefined) { id = groups.length; ids.set(first, id); groups.push(seq); }
    return id;
  };
  group(steps);
  if (events?.onRun) group(events.onRun.steps);
  for (const timer of events?.timers ?? []) group(timer.steps);
  const procedures = new Map(functions.flatMap(f => f.kind === 'procedure' ? [[f.id, group(f.steps)] as const] : []));
  const definitions: string[] = [];
  // New nested groups are discovered while emitting the parent.
  for (let id = 1; id < groups.length; id++) {
    const seq = groups[id]!;
    const arms: string[] = [];
    seq.forEach((s, index) => {
      let body: string;
      switch (s.kind) {
        case 'branch': {
          const choices = [...s.arms.map(a => group(a.steps)), group(s.no)];
          body = `local targets = {${choices.join(', ')}}\n      return blocks[targets[choice]](f, next_step, fail, leave)()`;
          break;
        }
        case 'call': body = `return invoke(${procedures.get(s.functionId)}, f, next_step, fail, leave)`; break;
        case 'attempt': body = `return protected(${group(s.steps)}, ${group(s.handler)}, f, next_step, fail, leave)`; break;
        case 'forever': case 'repeatUntil': case 'repeat':
          body = `return loop(${group(s.steps)}, ${s.kind === 'repeat' ? s.count : -1}, ${s.kind === 'repeatUntil'}, ${id}, ${index + 1}, f, next_step, fail)`;
          break;
        case 'break': body = 'return leave()'; break;
        default: return;
      }
      arms.push(`${arms.length ? 'elseif' : 'if'} pc == ${index + 1} then\n      ${body}`);
    });
    definitions.push(`blocks[${id}] = function(f, done, fail, leave)
  local pc = 0
  local after_step
  local function next_step()
    pc = pc + 1
    if pc > ${seq.length} then return done() end
    f.resume = after_step
    return "step", ${id}, pc
  end
  after_step = function(reply, choice)
    if reply == "error" then return fail() end
    ${arms.length ? arms.join('\n    ') + ' end\n    ' : ''}return next_step()
  end
  return next_step
end`);
  }
  return { source: definitions.join('\n'), groups: Object.fromEntries(ids) };
}
