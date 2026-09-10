import type { BlockDef } from './model';

export interface OverlapIssue {
  blockA: string;
  blockB: string;
  area: number;
  rangeA: [number, number];
  rangeB: [number, number];
}

export function blocksOverlap(a: BlockDef, b: BlockDef): boolean {
  if (a.area !== b.area) return false;
  return a.start < b.start + b.length && b.start < a.start + a.length;
}

/** Blocks of the same template and same address area must not overlap. */
export function findBlockOverlaps(blocks: BlockDef[]): OverlapIssue[] {
  const issues: OverlapIssue[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i] as BlockDef;
      const b = blocks[j] as BlockDef;
      if (blocksOverlap(a, b)) {
        issues.push({
          blockA: a.name,
          blockB: b.name,
          area: a.area,
          rangeA: [a.start, a.start + a.length - 1],
          rangeB: [b.start, b.start + b.length - 1],
        });
      }
    }
  }
  return issues;
}

/** Points may overlap freely; this helper reports shared registers for UI hints. */
export function pointSharesRegister(a: { offset: number; registerCount: number }, b: { offset: number; registerCount: number }): boolean {
  return a.offset < b.offset + b.registerCount && b.offset < a.offset + a.registerCount;
}