import type { Block } from 'blockly/core';
import { isScriptCall, scriptBlocks, splitParameters, usesScriptVariable } from '../../../domain/master-script';

export const luaKeywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const reserved = new Set([...luaKeywords, '_ENV', '_G', '_step', '_frame', '_run_main', 'modbus', 'print', 'assert', 'error', 'math', 'table', 'type', 'tonumber', 'tostring']);
// Lua 5.4 has a 200-local limit and uses additional VM registers for loops and calls.
const directLocalBudget = 160;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const field = (block: Block, name: string) => String(block.getFieldValue(name) ?? '').trim();

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

// Visit operands before the statement that consumes them, and skip disabled bodies.
function* activeBlocks(first: Block | null): Generator<Block> {
  for (let block = first; block; block = block.getNextBlock()) {
    if (!block.isEnabled()) continue;
    for (const input of block.inputList) yield* activeBlocks(input.connection?.targetBlock() ?? null);
    yield block;
  }
}

interface Scope { symbols: Map<string, string>; hoisted: string[]; declarations: Set<string>; packed: boolean; parameters: string[] }

export class LuaNames {
  readonly definitionIds: string[] = [];
  wrapMain = false;
  private readonly functions: Map<string, string>;
  private readonly scopes = new Map<string, Scope>();
  private readonly checked = new Set<string>();

  constructor(start: Block | null, definitions: Block[], events?: Block[]) {
    const reservedNames = events ? new Set([...reserved, 'rt', 'coroutine', 'on_start', 'on_run', 'on_timer', '_timer_id']) : reserved;
    this.functions = allocate(definitions.map(block => ({ key: block.id, name: field(block, 'NAME'),
      fallback: block.type === scriptBlocks.calculation ? 'compute_value' : 'run_step' })), reservedNames);
    const blocked = new Set([...reservedNames, ...this.functions.values()]);
    const byId = new Map(definitions.map(block => [block.id, block]));
    const visited = new Set<string>();
    const visit = (block: Block) => {
      if (visited.has(block.id)) return;
      visited.add(block.id);
      for (const item of activeBlocks(block)) {
        if (isScriptCall(item.type)) { const target = byId.get(field(item, 'FUNCTION')); if (target) visit(target); }
      }
      this.definitionIds.push(block.id);
    };
    // Local functions only capture names that have already been declared.
    for (const def of definitions) visit(def);
    // Expressions in a recovery path, a wait or a device write must retain the
    // host's checked arithmetic and unavailable-value semantics, also through calls.
    const protect = (first: Block | null) => {
      for (const block of activeBlocks(first)) {
        if (this.checked.has(block.id)) continue;
        this.checked.add(block.id);
        if (isScriptCall(block.type)) protect(byId.get(field(block, 'FUNCTION')) ?? null);
      }
    };
    const mainRoots = [...(start ? [start] : []), ...events ?? []];
    for (const roots of [...definitions.map(def => [def]), mainRoots]) {
      const root = roots[0]!;
      const shared = roots === mainRoots && !!events;
      const parameters = splitParameters(field(root, 'PARAMS'));
      const requests = parameters.map((name, i) => ({ key: name, name, fallback: 'arg_' + (i + 1) }));
      const seen = new Set(parameters);
      const hoisted: string[] = [];
      const declarations = new Set<string>();
      let loopLocals = 0;
      const top = new Set<Block>();
      for (let b = root === start ? root.getNextBlock() : root.getInputTargetBlock('BODY'); b; b = b.getNextBlock()) top.add(b);
      for (const block of roots.flatMap(entry => [...activeBlocks(entry)])) {
        if (block.type === scriptBlocks.attempt || block.type === scriptBlocks.wait || block.type === scriptBlocks.write)
          for (const input of block.inputList) protect(input.connection?.targetBlock() ?? null);
        if (block.type === scriptBlocks.repeat) loopLocals += 4;
        if (!usesScriptVariable(block.type)) continue;
        const name = field(block, 'VARIABLE');
        if (seen.has(name)) continue;
        seen.add(name);
        requests.push({ key: name, name, fallback: 'value' });
        if (!shared && top.has(block) && (block.type === scriptBlocks.setVariable || block.type === scriptBlocks.readVariable)) declarations.add(block.id);
        else hoisted.push(name);
      }
      const symbols = allocate(requests, blocked);
      const pressure = seen.size + loopLocals;
      const packed = pressure + (shared ? definitions.length + 3 : 0) > directLocalBudget;
      if (root === start) this.wrapMain = definitions.length + pressure > directLocalBudget && definitions.length > 0;
      if (packed) {
        for (const [name, symbol] of symbols) symbols.set(name, '_frame.' + symbol);
        parameters.forEach((name, index) => symbols.set(name, `_frame[${index + 1}]`));
        declarations.clear();
      }
      const scope = { symbols, hoisted: hoisted.map(name => symbols.get(name)!), declarations, packed, parameters };
      for (const entry of roots) this.scopes.set(entry.id, scope);
    }
  }

  functionName(id: string): string { return this.functions.get(id)!; }
  needsHostCheck(block: Block): boolean { return this.checked.has(block.id); }
  parameters(root: Block): string {
    const scope = this.scopes.get(root.id)!;
    return scope.packed && scope.parameters.length ? '...' : scope.parameters.map(name => scope.symbols.get(name)!).join(', ');
  }
  variable(block: Block, name: string): string { return this.scopes.get(block.getRootBlock().id)!.symbols.get(name)!; }
  assignment(block: Block): string {
    const declaration = this.scopes.get(block.getRootBlock().id)!.declarations.has(block.id);
    return (declaration ? 'local ' : '') + this.variable(block, field(block, 'VARIABLE'));
  }
  preamble(root: Block, indent = ''): string {
    const scope = this.scopes.get(root.id)!;
    if (scope.packed) return `${indent}local _frame = {${scope.parameters.length ? '...' : ''}}\n`;
    const locals = scope.hoisted;
    return locals.length ? indent + 'local ' + locals.join(', ') + '\n' : '';
  }
}
