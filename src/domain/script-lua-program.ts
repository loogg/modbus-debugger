import { compileScriptModel, type ScriptGraph } from './master-script';
import { renderScriptLua } from './script-lua-source';

// Both entry points compile the saved graph with the same field normalization,
// scopes, numeric operations and control flow. The host needs a return point
// for asynchronous effects; the portable view uses structured Lua statements.
export function compileScriptLua(input: ScriptGraph) {
  const { graph, program, pointUses } = compileScriptModel(input);
  const source = renderScriptLua(graph, program);
  return { program, source, pointUses, identity: JSON.stringify([program.steps, program.handlers, program.functions, source.text]) };
}
