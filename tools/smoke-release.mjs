import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLegacyPreferencesUnchanged, createScratch, snapshotLegacyPreferences } from './test-paths.mjs';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { base, release, root, run, smokeApp, removeScratch } from './smoke-app.mjs';

const require = createRequire(import.meta.url);
const { unzip } = require('cross-zip');
const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
const scratch = createScratch('smoke-release-');
const legacyPreferences = snapshotLegacyPreferences();
async function verifyManifest(directory) {
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'resources','app-files.json'),'utf8'));
  const actual=[];
  const walk=async(relative='')=>{for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){const name=relative?`${relative}/${entry.name}`:entry.name;if(entry.isDirectory())await walk(name);else actual.push(name)}};
  await walk();
  assert.deepEqual(actual.sort(),[...manifest.files.map(file=>file.path),'resources/app-files.json'].sort(),'Packager changed program files after generating the update manifest');
  for(const file of manifest.files)assert.equal(createHash('sha256').update(await fs.readFile(path.join(directory,file.path))).digest('hex'),file.sha256,`Manifest checksum: ${file.path}`);
}
try {
  for (const suffix of ['', '.zip', '-Portable.exe', '-Setup.exe']) await fs.access(path.join(release, base + suffix));
  const directory = path.join(scratch, 'directory');
  await fs.cp(path.join(release, base), directory, { recursive: true });
  await verifyManifest(directory);
  assert.deepEqual(await fs.readFile(path.join(release,`${base}-manifest.json`)),await fs.readFile(path.join(directory,'resources','app-files.json')));
  await smokeApp(path.join(directory, 'modbus-debugger.exe'), 'directory', { screenshotDir: path.join(root, 'out', 'release-smoke-screenshots') });

  const extracted = path.join(scratch, 'zip');
  await fs.mkdir(extracted);
  await new Promise((resolve, reject) => unzip(path.join(release, `${base}.zip`), extracted, error => error ? reject(error) : resolve()));
  const findExe = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'modbus-debugger.exe') return full;
      if (entry.isDirectory()) { const found = await findExe(full); if (found) return found; }
    }
  };
  const zipExe = await findExe(extracted);
  assert(zipExe, 'ZIP has no executable');
  await verifyManifest(path.dirname(zipExe));
  await smokeApp(zipExe, 'ZIP extracted');
  assert.deepEqual(await fs.readFile(path.join(directory, 'resources', 'app.asar')),
    await fs.readFile(path.join(path.dirname(zipExe), 'resources', 'app.asar')), 'ZIP and directory application differ');

  const portableDir = path.join(scratch, 'Portable 独立运行');
  await fs.mkdir(portableDir);
  const portable = path.join(portableDir, `${base}-Portable.exe`);
  await fs.copyFile(path.join(release, `${base}-Portable.exe`), portable);
  await smokeApp(portable, 'Portable', { portable: true });
  await fs.access(path.join(portableDir, 'logs', 'main.log'));
  const dbPath = path.join(portableDir, 'data', 'history.db');
  const db = new SQL.Database(await fs.readFile(dbPath));
  db.run("CREATE TABLE release_smoke (value TEXT); INSERT INTO release_smoke VALUES ('survives restart')");
  await fs.writeFile(dbPath, db.export());
  db.close();
  await smokeApp(portable, 'Portable restart', { portable: true });
  const reopened = new SQL.Database(await fs.readFile(dbPath));
  assert.equal(reopened.exec('SELECT value FROM release_smoke')[0].values[0][0], 'survives restart');
  reopened.close();
  console.log('[smoke] Portable persistence survived extraction cleanup and restart');
  const overrideRoot = path.join(scratch, 'Custom data 数据');
  await smokeApp(path.join(directory, 'modbus-debugger.exe'), 'Explicit data directory', { dataRoot: overrideRoot });
  await run(process.execPath, [path.join(root, 'tools', 'smoke-installer.mjs')], 300000, 'inherit');
  console.log('[smoke] PASS: all four release formats, Portable restart, Setup install and uninstall');
} finally {
  assertLegacyPreferencesUnchanged(legacyPreferences);
  await removeScratch(scratch);
}
