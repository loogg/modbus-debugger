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
[`  private sentTxCount = 0;
  private sentEventCount = 0;`,
 `  private sentTxTotal = 0;
  private sentEventTotal = 0;`],

[`  private lastConnStates = new Map<string, ConnectionStateView>();`,
 `  private lastConnStates = new Map<string, ConnectionStateView>();
  private pointIndexCache: { rev: number; map: Map<string, PointRef> } | null = null;`],

[`  pointIndex(): Map<string, PointRef> {
    const ws = this.workspaceService.current;
    const map = new Map<string, PointRef>();
    for (const slave of ws.slaves) {
      const connection = ws.connections.find((c) => c.id === slave.connectionId);
      const template = ws.templates.find((t) => t.id === slave.templateId);
      if (!connection || !template) continue;
      for (const block of template.blocks) {
        for (const point of template.points.filter((p) => p.blockId === block.id)) {
          map.set(point.id, { slave, block, point, template, connection });
        }
      }
    }
    return map;
  }`,
 `  /**
   * Every addressable point, keyed by point id. The workspace object is replaced (never
   * mutated in place) on each edit, so the map is cached against WorkspaceService.revision
   * rather than rebuilt ten times a second by the scheduler tick.
   */
  pointIndex(): Map<string, PointRef> {
    const rev = this.workspaceService.revision;
    const hit = this.pointIndexCache;
    if (hit && hit.rev === rev) return hit.map;
    const ws = this.workspaceService.current;
    const connById = new Map(ws.connections.map((c) => [c.id, c]));
    const tplById = new Map(ws.templates.map((t) => [t.id, t]));
    const map = new Map<string, PointRef>();
    for (const slave of ws.slaves) {
      const connection = connById.get(slave.connectionId);
      const template = tplById.get(slave.templateId);
      if (!connection || !template) continue;
      const byBlock = new Map<string, PointDef[]>();
      for (const point of template.points) {
        const list = byBlock.get(point.blockId);
        if (list) list.push(point);
        else byBlock.set(point.blockId, [point]);
      }
      for (const block of template.blocks) {
        for (const point of byBlock.get(block.id) ?? []) {
          map.set(point.id, { slave, block, point, template, connection });
        }
      }
    }
    this.pointIndexCache = { rev, map };
    return map;
  }`],

[`      const lastResp = this.diagnostics
        .transactionsForConnection(conn.id, 50)
        .filter((t) => t.result === 'ok')
        .slice(-1)[0];
      out[conn.id] = {
        state: rt?.state ?? 'offline',
        detail: rt?.state === 'error' ? '连接异常' : null,
        lastResponseUtc: lastResp?.startUtc ?? null,
      };`,
 `      out[conn.id] = {
        state: rt?.state ?? 'offline',
        detail: rt?.state === 'error' ? '连接异常' : null,
        lastResponseUtc: this.diagnostics.lastOkUtcFor(conn.id),
      };`],

[`      transactions: this.diagnostics.recentTransactions(500),
      parseEvents: this.diagnostics.recentParseEvents(200),`,
 `      transactions: this.diagnostics.recentTransactions(500),
      parseEvents: this.diagnostics.recentParseEvents(200),`],

[`    const txs = this.diagnostics.recentTransactions(5000);
    if (txs.length !== this.sentTxCount) {
      delta.transactions = txs.slice(this.sentTxCount);
      this.sentTxCount = txs.length;
      changed = true;
    }
    const evs = this.diagnostics.recentParseEvents(2000);
    if (evs.length !== this.sentEventCount) {
      delta.parseEvents = evs.slice(this.sentEventCount);
      this.sentEventCount = evs.length;
      changed = true;
    }`,
 `    // Absolute cursors: the ring buffer trims at 5000 entries, so comparing lengths
    // would silently stop streaming once the ring is full.
    const txTotal = this.diagnostics.transactionTotal;
    if (txTotal !== this.sentTxTotal) {
      const txs = this.diagnostics.transactionsSince(this.sentTxTotal);
      this.sentTxTotal = txTotal;
      if (txs.length) {
        delta.transactions = txs;
        changed = true;
      }
    }
    const evTotal = this.diagnostics.parseEventTotal;
    if (evTotal !== this.sentEventTotal) {
      const evs = this.diagnostics.parseEventsSince(this.sentEventTotal);
      this.sentEventTotal = evTotal;
      if (evs.length) {
        delta.parseEvents = evs;
        changed = true;
      }
    }`],
]);
