import type { MasterScript, ScriptBlock } from '../../src/domain/master-script';

export function parallelScript(id: string, name: string, period: number, seed: number): MasterScript {
  const point = JSON.stringify(['slave-1', 'pt-temp']);
  const chain = (...steps: ScriptBlock[]) => steps.reduceRight<ScriptBlock | undefined>(
    (next, step) => next ? { ...step, next: { block: next } } : step, undefined)!;
  return { id, name, revision: 0, graph: { blocks: { languageVersion: 0, blocks: [
    chain({ id: 'start', type: 'mb_start', x: 25, y: 25 },
      { id: 'seed', type: 'mb_set_var', fields: { VARIABLE: 'ticks', OPERAND: seed } },
      { id: 'arm', type: 'mb_timer_start', fields: { TIMER: '0', PERIOD: 2 * period, MODE: 'loop' } }),
    chain({ id: 'cycle', type: 'mb_on_run', x: 25, y: 220, fields: { PERIOD: period } },
      { id: 'tick', type: 'mb_change_var', fields: { VARIABLE: 'ticks', OPERAND: 1 } }),
    chain({ id: 'timer', type: 'mb_on_timer', x: 25, y: 360, fields: { TIMER: '0' } },
      { id: 'sample', type: 'mb_read', fields: { POINT: point, TIMEOUT: 3000 } },
      { id: 'log', type: 'mb_log', fields: { TEXT: name }, inputs: {
        OPERAND: { block: { id: 'temperature', type: 'mb_point_value', fields: { POINT: point } } },
      } }),
  ] } } };
}
