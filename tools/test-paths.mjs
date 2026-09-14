import fs from 'node:fs';
import path from 'node:path';

export const testRoot = path.resolve(import.meta.dirname, '..', 'out', 'test-temp');
const created = new Set();
export function setupTestEnvironment() {
  const system = path.join(testRoot, 'system');
  fs.mkdirSync(system, { recursive: true });
  process.env.TEMP = system;
  process.env.TMP = system;
  process.env.TMPDIR = system;
}
export function createScratch(prefix) {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error('Invalid scratch prefix');
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, prefix));
  created.add(directory);
  return directory;
}
export function removeScratch(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== testRoot) throw new Error('Refusing to remove a path outside out/test-temp');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  created.delete(resolved);
}
export function cleanupScratch() {
  for (const directory of created) removeScratch(directory);
}

export function snapshotLegacyPreferences() {
  if (!process.env.APPDATA) return [];
  return ['modbus-debugger', 'Modbus Debugger'].map(name => {
    const file = path.join(process.env.APPDATA, name, 'prefs.json');
    return { file, contents: fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null };
  });
}
export function assertLegacyPreferencesUnchanged(snapshot) {
  for (const { file, contents } of snapshot) {
    const current = fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null;
    if (current !== contents) throw new Error(`Test modified daily preferences: ${file}`);
  }
}
