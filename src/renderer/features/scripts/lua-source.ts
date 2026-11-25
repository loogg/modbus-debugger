import type { Block } from 'blockly/core';
import { LuaGenerator } from 'blockly/lua';
import { LuaNames } from './lua-names';

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

  preview(start: Block, definitions: Block[]): LuaSource {
    this.ids = [];
    // Numeric markers never contain user-supplied block IDs. The per-pass prefix also
    // keeps arbitrary Blockly comments distinct from the annotations.
    this.marker = '\x00' + crypto.randomUUID() + ':';
    this.init(start.workspace);
    this.names = new LuaNames(start, definitions);
    const parts = this.names.definitionIds.map(id => this.blockToCode(start.workspace.getBlockById(id)) as string);
    const main = this.names.preamble(start) + this.blockToCode(start);
    parts.push(this.annotate(start.id, this.names.wrapMain
      ? 'local function _run_main()\n' + this.prefixLines(main, '  ') + 'end\n_run_main()\n' : main));
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
