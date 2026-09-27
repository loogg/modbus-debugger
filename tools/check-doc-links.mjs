import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve('.');
const files = new Set(execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md',
], { encoding: 'utf8' }).split('\0').filter(Boolean));
const problems = [];
const localTargets = [];
let checked = 0;

for (const relative of files) {
  const source = path.resolve(root, relative);
  if (!fs.existsSync(source)) continue; // A tracked file may be moving in this worktree.
  const text = fs.readFileSync(source, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim();
    const destination = raw?.startsWith('<')
      ? raw.slice(1, raw.indexOf('>'))
      : raw?.match(/^(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/)?.[1];
    if (!destination || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(destination)) continue;
    const pathname = destination.split(/[?#]/, 1)[0];
    if (!pathname) continue;
    const target = path.resolve(path.dirname(source), decodeURIComponent(pathname));
    const local = path.relative(root, target).split(path.sep).join('/');
    checked++;
    if (local.startsWith('../') || local === '..') {
      problems.push(`${relative}: target escapes repository: ${destination}`);
    } else if (!fs.existsSync(target)) {
      problems.push(`${relative}: missing target: ${destination}`);
    } else {
      localTargets.push({ relative, destination, local });
    }
  }
}

const candidates = [...new Set(localTargets.map(item => item.local))];
const ignoredResult = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
  cwd: root, encoding: 'utf8', input: `${candidates.join('\0')}\0`,
});
if (![0, 1].includes(ignoredResult.status)) throw new Error(ignoredResult.stderr || 'git check-ignore failed');
const ignored = new Set(ignoredResult.stdout.split('\0').filter(Boolean).map(item => item.replaceAll('\\', '/')));
for (const item of localTargets) {
  if (ignored.has(item.local)) problems.push(`${item.relative}: link targets ignored output: ${item.destination}`);
}

for (const problem of problems) process.stderr.write(`${problem}\n`);
process.stdout.write(`Checked ${files.size} Markdown files and ${checked} local links; ${problems.length} problems.\n`);
if (problems.length) process.exitCode = 1;
