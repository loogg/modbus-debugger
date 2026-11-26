import { fieldText, isScriptCall, scriptBlocks, splitParameters, usesScriptVariable, type ScriptBlock } from './master-script';

export const luaKeywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const reserved = new Set([...luaKeywords, '_ENV', '_G', '_step', '_frame', '_run_main', '_script_main', '_ops', 'modbus', 'print', 'assert', 'error', 'math', 'table', 'type', 'tonumber', 'tostring']);
// Lua 5.4 has a 200-local limit and uses additional VM registers for loops and calls.
const directLocalBudget = 160;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;

interface SymbolRequest { key: string; name: string; fallback: string }

function allocate(requests: SymbolRequest[], blocked: ReadonlySet<string>): Map<string, string> {
  const used = new Set(blocked);
  const result = new Map<string, string>();
  // Reserve exact spellings first so an alias never steals an author's valid identifier.
  for (const { key, name } of requests) {
    if (identifier.test(name) && !used.has(name)) { result.set(key, name); used.add(name); }
  }
  for (const { key, name, fallback } of requests) {
    if (result.has(key)) continue;
    const ascii = name.normalize('NFKD').replace(/\p{Mark}/gu, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    let base = ascii || fallback;
    if (/^\d/.test(base)) base = '_' + base;
    if (reserved.has(base)) base += '_';
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) candidate = base + '_' + suffix;
    used.add(candidate); result.set(key, candidate);
  }
  return result;
}

function* activeBlocks(first?: ScriptBlock): Generator<ScriptBlock> {
  for (let block = first; block; block = block.next?.block) {
    if (block.enabled === false || block.disabledReasons?.length) continue;
    for (const input of Object.values(block.inputs ?? {})) yield* activeBlocks(input.block);
    yield block;
  }
}

interface Scope { symbols: Map<string, string>; hoisted: string[]; declarations: Set<string>; packed: boolean; parameters: string[] }

export class LuaNames {
  readonly definitionIds: string[] = [];
  readonly functions: Map<string, string>;
  readonly scopes = new Map<string, Scope>();
  wrapMain = false;

  constructor(start: ScriptBlock | undefined, definitions: ScriptBlock[], events?: ScriptBlock[]) {
    const blockedNames = new Set([...reserved, 'rt', 'coroutine', 'sleep_ms', 'on_start', 'on_run', 'on_timer', '_timer_id']);
    this.functions = allocate(definitions.map(b => ({ key: b.id, name: fieldText(b, 'NAME').trim(),
      fallback: b.type === scriptBlocks.calculation ? 'compute_value' : 'run_step' })), blockedNames);
    const blocked = new Set([...blockedNames, ...this.functions.values()]);
    const byId = new Map(definitions.map(b => [b.id, b]));
    const visited = new Set<string>();
    const visit = (b: ScriptBlock) => {
      if (visited.has(b.id)) return;
      visited.add(b.id);
      for (const item of activeBlocks(b)) {
        const callee = isScriptCall(item.type) && byId.get(fieldText(item, 'FUNCTION'));
        if (callee) visit(callee);
      }
      this.definitionIds.push(b.id);
    };
    for (const def of definitions) visit(def);

    const mainRoots = [...(start ? [start] : []), ...(events ?? [])];
    for (const roots of [...definitions.map(d => [d]), mainRoots]) {
      const root = roots[0];
      if (!root) continue;
      const shared = roots === mainRoots && !!events;
      const parameters = splitParameters(fieldText(root, 'PARAMS'));
      const requests = parameters.map((name, i) => ({ key: name, name, fallback: 'arg_' + (i + 1) }));
      const seen = new Set(parameters), declarations = new Set<string>(), top = new Set<string>();
      const hoisted: string[] = [];
      let loopLocals = 0;
      for (let b = root === start ? root.next?.block : root.inputs?.BODY?.block; b; b = b.next?.block) top.add(b.id);
      for (const entry of roots) for (const block of activeBlocks(entry)) {
        if (block.type === scriptBlocks.repeat) loopLocals += 4;
        if (!usesScriptVariable(block.type)) continue;
        const name = fieldText(block, 'VARIABLE').trim();
        if (seen.has(name)) continue;
        seen.add(name); requests.push({ key: name, name, fallback: 'value' });
        if (!shared && top.has(block.id) && (block.type === scriptBlocks.setVariable || block.type === scriptBlocks.readVariable)) declarations.add(block.id);
        else hoisted.push(name);
      }
      const symbols = allocate(requests, blocked);
      const pressure = seen.size + loopLocals;
      const packed = pressure + (shared ? definitions.length + 3 : 0) > directLocalBudget;
      if (root === start) this.wrapMain = definitions.length + pressure > directLocalBudget && definitions.length > 0;
      if (packed) {
        for (const [name, symbol] of symbols) symbols.set(name, '_frame.' + symbol);
        parameters.forEach((name, i) => symbols.set(name, `_frame[${i + 1}]`));
        declarations.clear();
      }
      const scope = { symbols, hoisted: hoisted.map(name => symbols.get(name)!), declarations, packed, parameters };
      for (const entry of roots) this.scopes.set(entry.id, scope);
    }
  }
  variable(root: string, name: string) { return this.scopes.get(root)!.symbols.get(name)!; }
  assignment(root: string, step: string, name: string) {
    return (this.scopes.get(root)!.declarations.has(step) ? 'local ' : '') + this.variable(root, name);
  }
  parameters(root: string) {
    const scope = this.scopes.get(root)!;
    return scope.packed && scope.parameters.length ? '...' : scope.parameters.map(p => scope.symbols.get(p)!).join(', ');
  }
  preamble(root: string) {
    const scope = this.scopes.get(root)!;
    if (scope.packed) return `local _frame = {${scope.parameters.length ? '...' : ''}}\n`;
    return scope.hoisted.length ? 'local ' + scope.hoisted.join(', ') + '\n' : '';
  }
}
