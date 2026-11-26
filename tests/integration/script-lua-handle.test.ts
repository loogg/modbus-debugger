import { beforeAll, expect, it, vi } from 'vitest';
import { loadScriptLua, ScriptHandleFault, ScriptLuaHandle } from '../../src/main/runtime/script-lua-handle';
import { compileScriptProgram } from '../../src/domain/master-script';

// Exercise the instruction hook inside a single native call, away from any Blockly boundary.
vi.mock('../../src/main/runtime/script-handle.lua?raw', async importOriginal => {
  const { default: program } = await importOriginal<{ default: string }>();
  return { default: program + `
local next_step = advance_flow
function advance_flow(slot, ...)
  if slot == 0 or slot == 1 then
    local sum = 0
    for i = 1, 4000000 do sum = sum + i end
    assert(sum == 8000002000000)
  end
  return next_step(slot, ...)
end` };
});

beforeAll(loadScriptLua);

it('preempts a long startup Lua call and errors inside a long main-state call on its own handle', () => {
  const kernel = compileScriptProgram({ blocks: { languageVersion: 0, blocks: [{ id: 'root', type: 'mb_start',
    next: { block: { id: 'first', type: 'mb_log', fields: { TEXT: 'done' } } } }] } }).lua;
  const group = kernel.control.groups.first!;
  const startup = new ScriptLuaHandle(kernel), busy = new ScriptLuaHandle(kernel, 240);
  try {
    startup.open('on_start', group);
    let action = startup.advance('on_start', 'next');
    expect(action.kind).toBe('slice');
    busy.budget(100);
    busy.open('on_run', group);
    busy.budget(1);
    expect(() => busy.advance('on_run', 'next')).toThrowError(new ScriptHandleFault('主 L 看门狗超时（累计执行上限 240 ms）'));
    while (action.kind === 'slice') action = startup.advance('on_start', 'next');
    expect(action).toEqual({ kind: 'step', group, index: 1 });
  } finally { busy.close(); startup.close(); }
});
