const fs = require('fs');

function patch(file, pairs) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let t = raw.replace(/\r\n/g, '\n');
  let miss = 0;
  for (const [from, to] of pairs) {
    const f = from.replace(/\r\n/g, '\n');
    if (!t.includes(f)) { console.log('MISS ' + file + ' :: ' + JSON.stringify(f.slice(0, 80))); miss++; continue; }
    t = t.replace(f, to.replace(/\r\n/g, '\n'));
  }
  fs.writeFileSync(file, t.split('\n').join(eol));
  console.log((miss ? 'PARTIAL ' : 'ok ') + file);
}

/* ---------------- workspace.ts : monotonic revision ---------------- */
patch('src/main/services/workspace.ts', [
[`  private prefs: Prefs = { ...DEFAULT_PREFS };
  private prefsPath: string;`,
 `  private prefs: Prefs = { ...DEFAULT_PREFS };
  private prefsPath: string;
  /** Bumped whenever the in-memory workspace object is replaced. */
  private rev = 0;`],

[`  isDirty(): boolean {
    return this.dirty;
  }`,
 `  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Monotonic counter for the current workspace object. Derived indexes (point index,
   * runtime targets) cache against it instead of being rebuilt on every scheduler tick.
   */
  get revision(): number {
    return this.rev;
  }`],

[`  newWorkspace(): void {
    this.workspace = emptyWorkspace();
    this.filePath = null;
    this.dirty = true;
  }`,
 `  newWorkspace(): void {
    this.workspace = emptyWorkspace();
    this.filePath = null;
    this.dirty = true;
    this.rev += 1;
  }`],

[`      this.prefs = this.updatePrefs({ lastWorkspacePath: target });
      this.dirty = false;
      return { ok: true };`,
 `      this.prefs = this.updatePrefs({ lastWorkspacePath: target });
      this.dirty = false;
      this.rev += 1;
      return { ok: true };`],

[`  adopt(workspace: Workspace, filePath: string | null): void {
    this.workspace = workspaceSchema.parse(workspace);
    this.filePath = filePath;
    this.dirty = true;
  }`,
 `  adopt(workspace: Workspace, filePath: string | null): void {
    this.workspace = workspaceSchema.parse(workspace);
    this.filePath = filePath;
    this.dirty = true;
    this.rev += 1;
  }`],

[`  set(workspace: Workspace): Workspace {
    this.workspace = workspaceSchema.parse(workspace);
    this.dirty = true;
    this.scheduleAutosave();`,
 `  set(workspace: Workspace): Workspace {
    this.workspace = workspaceSchema.parse(workspace);
    this.dirty = true;
    this.rev += 1;
    this.scheduleAutosave();`],
]);

/* ---------------- diagnostics.ts : absolute cursors + O(1) last-ok ---------------- */
patch('src/main/runtime/diagnostics.ts', [
[`export class DiagnosticsStore {
  private transactions: TransactionRecord[] = [];
  private parseEvents: ParseEventRecord[] = [];
  private seq = 0;`,
 `export class DiagnosticsStore {
  private transactions: TransactionRecord[] = [];
  private parseEvents: ParseEventRecord[] = [];
  private seq = 0;
  // Absolute (never-trimmed) counters. The 100 ms delta loop compares these instead of
  // copying the whole ring buffer on every tick.
  private txTotal = 0;
  private evTotal = 0;
  private lastOkByConnection = new Map<string, string>();`],

[`  recordTransaction(rec: TransactionRecord): void {
    this.transactions.push(rec);
    if (this.transactions.length > RING) this.transactions.splice(0, this.transactions.length - RING);
  }`,
 `  recordTransaction(rec: TransactionRecord): void {
    this.transactions.push(rec);
    this.txTotal += 1;
    if (rec.result === 'ok') this.lastOkByConnection.set(rec.connectionId, rec.startUtc);
    if (this.transactions.length > RING) this.transactions.splice(0, this.transactions.length - RING);
  }`],

[`  recordParseEvent(rec: Omit<ParseEventRecord, 'id'>): void {
    this.seq += 1;`,
 `  recordParseEvent(rec: Omit<ParseEventRecord, 'id'>): void {
    this.seq += 1;
    this.evTotal += 1;`],

[`  recentParseEvents(limit = 200): ParseEventRecord[] {
    return this.parseEvents.slice(-limit);
  }`,
 `  recentParseEvents(limit = 200): ParseEventRecord[] {
    return this.parseEvents.slice(-limit);
  }

  /** Absolute index the next recorded transaction will occupy. */
  get transactionTotal(): number {
    return this.txTotal;
  }

  /** Absolute index the next recorded parse event will occupy. */
  get parseEventTotal(): number {
    return this.evTotal;
  }

  /** Transactions recorded after absolute index \`from\`; records already trimmed away are skipped. */
  transactionsSince(from: number): TransactionRecord[] {
    if (from >= this.txTotal) return [];
    const oldest = this.txTotal - this.transactions.length;
    return this.transactions.slice(Math.max(0, from - oldest));
  }

  /** Parse events recorded after absolute index \`from\`; events already trimmed away are skipped. */
  parseEventsSince(from: number): ParseEventRecord[] {
    if (from >= this.evTotal) return [];
    const oldest = this.evTotal - this.parseEvents.length;
    return this.parseEvents.slice(Math.max(0, from - oldest));
  }

  /** UTC of the latest successful response for a connection, tracked incrementally (O(1) read). */
  lastOkUtcFor(connectionId: string): string | null {
    return this.lastOkByConnection.get(connectionId) ?? null;
  }`],

[`  clear(): void {
    this.transactions = [];
    this.parseEvents = [];
  }`,
 `  clear(): void {
    this.transactions = [];
    this.parseEvents = [];
    this.lastOkByConnection.clear();
    // txTotal / evTotal stay monotonic so cursors held by the delta loop remain valid.
  }`],
]);
