import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prepareStorage, storagePaths } from '../../src/main/services/storage-paths';
import { createScratch, testRoot } from '../../tools/test-paths.mjs';

describe('application storage layout', () => {
  it('keeps defaults under the executable root and supports an explicit absolute override', () => {
    const executableRoot = path.resolve('example-app');
    const custom = path.resolve('custom-data');
    expect(storagePaths(executableRoot).data).toBe(path.join(executableRoot, 'data'));
    const selected = storagePaths(executableRoot, custom);
    for (const [key, directory] of Object.entries(selected)) {
      if (key !== 'root') expect(directory.startsWith(custom + path.sep)).toBe(true);
    }
    expect(() => storagePaths(executableRoot, '../relative')).toThrow('绝对路径');
  });
  it('creates writable directories without replacing existing preferences or database files', () => {
    const root = createScratch('storage-');
    const layout = prepareStorage(root);
    const prefs = path.join(layout.data, 'prefs.json');
    fs.writeFileSync(prefs, '{"language":"zh-CN"}');
    prepareStorage(root);
    expect(fs.readFileSync(prefs, 'utf8')).toContain('zh-CN');
    expect(fs.readdirSync(layout.data)).toEqual(['prefs.json', 'workspaces']);
    expect(root.startsWith(testRoot + path.sep)).toBe(true);
  });
  it('fails instead of silently falling back when the selected data path cannot be used', () => {
    const root = createScratch('storage-invalid-');
    fs.writeFileSync(path.join(root, 'data'), 'blocking file');
    expect(() => prepareStorage(root)).toThrow();
    expect(fs.readFileSync(path.join(root, 'data'), 'utf8')).toBe('blocking file');
  });
});
