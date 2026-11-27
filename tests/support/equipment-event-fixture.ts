import { scriptBlocks as b, scriptPointKey, type MasterScript, type ScriptBlock } from '../../src/domain/master-script';

function transitionValues(prefix: string): { block: ScriptBlock } {
  return { block: { type: b.log, id: `${prefix}-old`, fields: { TEXT: '上次' },
    inputs: { OPERAND: { block: { type: b.previousEventValue, id: `${prefix}-read-old` } } },
    next: { block: { type: b.log, id: `${prefix}-new`, fields: { TEXT: '本次' },
      inputs: { OPERAND: { block: { type: b.eventValue, id: `${prefix}-read-new` } } } } } } };
}

export function pointChangeScript(slaveId = 'slave-1', pointId = 'pt-speed'): MasterScript {
  return { id: 'point-events', name: '点位变化记录', revision: 0, graph: { blocks: { languageVersion: 0, blocks: [{
    type: b.onPointChange, id: 'point-event', x: 28, y: 36, fields: { POINT: scriptPointKey({ slaveId, pointId }) }, next: transitionValues('point'),
  }] } } };
}
