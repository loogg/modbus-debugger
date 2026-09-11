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
patch('src/main/runtime/manager.ts', [
[`    const health: Record<string, ConnectionHealth> = {};
    for (const conn of ws.connections) health[conn.id] = this.healthFor(conn.id);
    return {`,
 `    const health: Record<string, ConnectionHealth> = {};
    for (const conn of ws.connections) health[conn.id] = this.healthFor(conn.id);
    // The snapshot already carries the tail of both rings, so align the delta cursors:
    // the next tick must only stream records the renderer does not have yet.
    this.sentTxTotal = this.diagnostics.transactionTotal;
    this.sentEventTotal = this.diagnostics.parseEventTotal;
    for (const entry of this.cache.all()) this.sentCacheRev.set(entry.key, entry.revision);
    return {`],
]);
