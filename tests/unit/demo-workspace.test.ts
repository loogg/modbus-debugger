import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { migrateWorkspace } from '../../src/domain/model';

describe('demo workspace fixture', () => {
  it('parses against the workspace schema', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'e2e', 'demo.workspace.json'), 'utf-8')) as unknown;
    const ws = migrateWorkspace(raw);
    expect(ws.connections.length).toBe(1);
    expect(ws.templates[0]?.points.length).toBe(9);
  });
});