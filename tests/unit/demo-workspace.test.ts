import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { migrateWorkspace } from '../../src/domain/model';

describe('demo workspace fixture', () => {
  it('parses against the workspace schema', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'e2e', 'demo.workspace.json'), 'utf-8')) as unknown;
    const ws = migrateWorkspace(raw);
    expect(ws.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'conn-tcp', transport: 'tcp' }),
      expect.objectContaining({ id: 'conn-rtu', transport: 'rtu' }),
    ]));
    expect(ws.connections).toHaveLength(2);
    expect(ws.templates.find((template) => template.id === 'tpl-servo')?.points).toHaveLength(9);
    expect(ws.templates.find((template) => template.id === 'tpl-flow')?.points).toHaveLength(5);
  });
});
