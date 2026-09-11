const fs = require('fs');
function patch(file, pairs) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let t = raw.replace(/\r\n/g, '\n');
  let miss = 0;
  for (const [from, to] of pairs) {
    const f = from.replace(/\r\n/g, '\n');
    if (!t.includes(f)) { console.log('MISS :: ' + JSON.stringify(f.slice(0, 90))); miss++; continue; }
    t = t.replace(f, to.replace(/\r\n/g, '\n'));
  }
  fs.writeFileSync(file, t.split('\n').join(eol));
  console.log((miss ? 'PARTIAL ' : 'ok ') + file);
}
patch('src/shared/snapshot.ts', [
[`  transactions: TransactionRecord[];
  parseEvents: ParseEventRecord[];`,
 `  transactions: TransactionRecord[];
  parseEvents: ParseEventRecord[];
  /** Bumped by diagnostics.clear so the renderer drops its local ring copies. */
  diagRev: number;`],
[`  transactions?: TransactionRecord[];
  parseEvents?: ParseEventRecord[];`,
 `  transactions?: TransactionRecord[];
  parseEvents?: ParseEventRecord[];
  diagRev?: number;`],
]);
