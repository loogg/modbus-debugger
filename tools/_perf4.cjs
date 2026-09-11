const fs = require('fs');
function patch(file, pairs) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let t = raw.replace(/\r\n/g, '\n');
  let miss = 0;
  for (const [from, to] of pairs) {
    const f = from.replace(/\r\n/g, '\n');
    if (!t.includes(f)) { console.log('MISS ' + file + ' :: ' + JSON.stringify(f.slice(0, 90))); miss++; continue; }
    t = t.replace(f, to.replace(/\r\n/g, '\n'));
  }
  fs.writeFileSync(file, t.split('\n').join(eol));
  console.log((miss ? 'PARTIAL ' : 'ok ') + file);
}

patch('src/shared/snapshot.ts', [
[`    transactions: TransactionRecord[];
    parseEvents: ParseEventRecord[];`,
 `    transactions: TransactionRecord[];
    parseEvents: ParseEventRecord[];
    /** Bumped by diagnostics.clear so the renderer can drop its local ring copies. */
    diagRev: number;`],
[`    transactions?: TransactionRecord[];
    parseEvents?: ParseEventRecord[];`,
 `    transactions?: TransactionRecord[];
    parseEvents?: ParseEventRecord[];
    diagRev?: number;`],
]);

patch('src/main/runtime/manager.ts', [
[`  private sentTxTotal = 0;
  private sentEventTotal = 0;`,
 `  private sentTxTotal = 0;
  private sentEventTotal = 0;
  private diagRev = 0;
  private sentDiagRev = 0;`],

[`      transactions: this.diagnostics.recentTransactions(500),
      parseEvents: this.diagnostics.recentParseEvents(200),`,
 `      transactions: this.diagnostics.recentTransactions(500),
      parseEvents: this.diagnostics.recentParseEvents(200),
      diagRev: this.diagRev,`],

[`      case 'diagnostics.clear':
        this.diagnostics.clear();
        this.sentTxCount = 0;
        this.sentEventCount = 0;
        return { ok: true, value: null };`,
 `      case 'diagnostics.clear':
        this.diagnostics.clear();
        // Totals stay monotonic across clear(); park the cursors so only new records stream.
        this.sentTxTotal = this.diagnostics.transactionTotal;
        this.sentEventTotal = this.diagnostics.parseEventTotal;
        this.diagRev += 1;
        return { ok: true, value: null };`],

[`    if (this.recordingViewChanged) {`,
 `    if (this.diagRev !== this.sentDiagRev) {
      delta.diagRev = this.diagRev;
      this.sentDiagRev = this.diagRev;
      changed = true;
    }
    if (this.recordingViewChanged) {`],
]);

patch('src/renderer/store/app.ts', [
[`      transactions: d.transactions ? [...prev.transactions, ...d.transactions].slice(-500) : prev.transactions,
      parseEvents: d.parseEvents ? [...prev.parseEvents, ...d.parseEvents].slice(-200) : prev.parseEvents,`,
 `      diagRev: d.diagRev ?? prev.diagRev,
      transactions: cleared
        ? (d.transactions ?? []).slice(-500)
        : d.transactions
          ? [...prev.transactions, ...d.transactions].slice(-500)
          : prev.transactions,
      parseEvents: cleared
        ? (d.parseEvents ?? []).slice(-200)
        : d.parseEvents
          ? [...prev.parseEvents, ...d.parseEvents].slice(-200)
          : prev.parseEvents,`],
[`  applyDelta: (d) => {
    const prev = get().snapshot;
    if (!prev) return;
    const next: AppSnapshot = {`,
 `  applyDelta: (d) => {
    const prev = get().snapshot;
    if (!prev) return;
    // diagnostics.clear bumps diagRev: the local ring copies must be dropped, not appended to.
    const cleared = d.diagRev !== undefined && d.diagRev !== prev.diagRev;
    const next: AppSnapshot = {`],
]);
