import type { Block } from 'blockly/core';
import { LuaGenerator } from 'blockly/lua';
import { LuaNames } from './lua-names';
import type { ScriptHandlers, ScriptStep } from '../../../domain/master-script';

export interface LuaSource {
  text: string;
  lines: { text: string; blockId: string | null }[];
  ranges: Map<string, { first: number; last: number }>;
}

export interface ScriptPreview {
  source: LuaSource | null;
  issue: { message: string; blockId?: string } | null;
}

/** Keep source boundaries through Blockly's indentation, value substitution and next-block chaining. */
export class ScriptLuaGenerator extends LuaGenerator {
  private ids: string[] = [];
  private marker = '';
  names!: LuaNames;
  eventDriven = false;

  preview(start: Block | null, definitions: Block[], workspace: Block['workspace'], handlers?: ScriptHandlers<ScriptStep>): LuaSource {
    this.ids = [];
    // Numeric markers never contain user-supplied block IDs. The per-pass prefix also
    // keeps arbitrary Blockly comments distinct from the annotations.
    this.marker = '\x00' + crypto.randomUUID() + ':';
    this.init(workspace);
    this.eventDriven = !!handlers;
    const cycle = handlers?.onRun ? workspace.getBlockById(handlers.onRun.blockId)! : null;
    const timers = handlers?.timers.map(handler => workspace.getBlockById(handler.blockId)!) ?? [];
    const events = [...(cycle ? [cycle] : []), ...timers];
    this.names = new LuaNames(start, definitions, handlers ? events : undefined);
    const parts = this.names.definitionIds.map(id => this.blockToCode(workspace.getBlockById(id)) as string);
    if (handlers) {
      const declarations = this.names.preamble(start ?? events[0]!);
      if (declarations) parts.unshift(declarations);
      const body = (root: Block, indent: string) => this.prefixLines(String(this.blockToCode(root.getNextBlock())), indent);
      const exports: string[] = [];
      for (const [name, root] of [['on_start', start], ['on_run', cycle]] as const) {
        if (!root) continue;
        parts.push(this.annotate(root.id, `local function ${name}()\n${body(root, '  ')}end\n`));
        exports.push(`${name} = ${name}`);
      }
      if (handlers.onRun) exports.push(`run_period_ms = ${handlers.onRun.periodMs}`);
      if (timers.length) {
        const arms = timers.map((timer, i) => this.annotate(timer.id,
          `  ${i ? 'elseif' : 'if'} _timer_id == ${handlers.timers[i]!.channel} then\n${body(timer, '    ')}`));
        parts.push(`local function on_timer(_timer_id)\n${arms.join('')}  end\nend\n`);
        exports.push('on_timer = on_timer');
      }
      parts.push(`return { ${exports.join(', ')} }`);
    } else if (start) {
      const main = this.names.preamble(start) + this.blockToCode(start);
      parts.push(this.annotate(start.id, this.names.wrapMain
        ? 'local function _run_main()\n' + this.prefixLines(main, '  ') + 'end\n_run_main()\n' : main));
    }
    const annotated = this.finish(parts.join('\n')).trim();
    const ranges: LuaSource['ranges'] = new Map();
    const stack: string[] = [];
    const lines = annotated ? annotated.split('\n').map((line, index) => {
      let text = '';
      let blockId: string | null = null;
      const append = (part: string) => {
        if (blockId === null && part.trim()) blockId = stack.at(-1) ?? null;
        text += part;
      };
      const [head, ...spans] = line.split(this.marker);
      append(head!);
      for (const span of spans) {
        const end = span.indexOf('\x00');
        const token = span.slice(0, end);
        if (token === '/') {
          const closed = stack.pop()!;
          ranges.get(closed)!.last = index;
        } else {
          const opened = this.ids[Number(token)]!;
          stack.push(opened);
          ranges.set(opened, { first: index, last: index });
        }
        append(span.slice(end + 1));
      }
      return { text, blockId };
    }) : [];
    return { text: lines.map(line => line.text).join('\n'), lines, ranges };
  }

  private annotate(id: string, code: string): string {
    const index = this.ids.push(id) - 1;
    const newline = code.endsWith('\n');
    return this.marker + index + '\x00' + (newline ? code.slice(0, -1) : code)
      + this.marker + '/\x00' + (newline ? '\n' : '');
  }

  override scrub_(block: Block, code: string, thisOnly = false): string {
    let own = super.scrub_(block, code, true);
    if (own && !block.isShadow()) own = this.annotate(block.id, own);
    return thisOnly ? own : own + this.blockToCode(block.getNextBlock());
  }
}
