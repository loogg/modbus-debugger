import { expect, it } from 'vitest';
import path from 'node:path';
import { createScratch } from '../../tools/test-paths.mjs';
import { templateWorkspace } from '../support/template-workspace';
import { WorkspaceService } from '../../src/main/services/workspace';
import { HistoryStore } from '../../src/main/services/history';
import { RuntimeManager } from '../../src/main/runtime/manager';
import { FakeTransport } from '../support/fake';

it('maps a confirmed register bit field through the Enum table without changing its raw code', async () => {
  // Enum is a numeric/BitField mapping plus point enumMap, not a separate RawType.
  const ws = templateWorkspace();
  const template = ws.templates.find((item) => item.id === 't1')!;
  const mode = template.points.find((item) => item.id === 'Mode')!;
  template.points = template.points.map((point) => point.id === 'Mode'
    ? { ...point, enumMap: { '0': 'Standby', '3': 'Alarm' } }
    : point);
  expect(mode.mapping).toMatchObject({ rawType: 'BitField', offset: 4, bitOffset: 4, bitWidth: 3 });

  const root = createScratch('mapping-enum-golden-');
  const service = new WorkspaceService(path.join(root, 'data'));
  service.adopt(ws, null);
  const history = await HistoryStore.open(path.join(root, 'history.db'));
  const manager = new RuntimeManager(service, history, { transportFactory: () => new FakeTransport('tcp') });
  manager.start();
  try {
    // At block offset 4, 0x0030 selects bits 4..6 => raw code 3 => Alarm.
    manager.cache.applyReadResult('s1::b1', { kind: 'registers', fc: 3, registers: [0, 0, 0, 0, 0x0030] }, 1);
    expect(manager.buildSnapshot().points['s1::Mode']).toMatchObject({
      rawNumber: 3, rawText: '3', enumLabel: 'Alarm', engText: 'Alarm', hasValue: true,
    });
    manager.cache.applyReadResult('s1::b1', { kind: 'registers', fc: 3, registers: [0, 0, 0, 0, 0x0040] }, 1);
    expect(manager.buildSnapshot().points['s1::Mode']).toMatchObject({ rawNumber: 4, enumLabel: null });
  } finally { await manager.stop(); }
});
