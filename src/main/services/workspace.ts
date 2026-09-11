import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyWorkspace, migrateWorkspace, workspaceSchema, type Workspace } from '../../domain/model';

export interface Prefs {
  window: { x: number | null; y: number | null; width: number; height: number };
  sidebarWidth: number;
  historyDbPath: string | null;
  persistRawComm: boolean;
  lastWorkspacePath: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  window: { x: null, y: null, width: 1440, height: 960 },
  sidebarWidth: 244,
  historyDbPath: null,
  persistRawComm: false,
  lastWorkspacePath: null,
};

export class WorkspaceService {
  private workspace: Workspace = emptyWorkspace();
  private filePath: string | null = null;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private prefs: Prefs = { ...DEFAULT_PREFS };
  private prefsPath: string;
  /** Bumped whenever the in-memory workspace object is replaced. */
  private rev = 0;

  constructor(private readonly userDataDir: string) {
    this.prefsPath = path.join(userDataDir, 'prefs.json');
    fs.mkdirSync(userDataDir, { recursive: true });
    this.loadPrefs();
  }

  /* ---------------- prefs ---------------- */

  private loadPrefs(): void {
    try {
      if (fs.existsSync(this.prefsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.prefsPath, 'utf-8')) as Partial<Prefs>;
        this.prefs = {
          ...DEFAULT_PREFS,
          ...raw,
          window: { ...DEFAULT_PREFS.window, ...(raw.window ?? {}) },
        };
      }
    } catch {
      this.prefs = { ...DEFAULT_PREFS };
    }
  }

  getPrefs(): Prefs {
    return this.prefs;
  }

  updatePrefs(patch: Partial<Prefs>): Prefs {
    this.prefs = { ...this.prefs, ...patch, window: { ...this.prefs.window, ...(patch.window ?? {}) } };
    fs.writeFileSync(this.prefsPath, JSON.stringify(this.prefs, null, 2), 'utf-8');
    return this.prefs;
  }


  /* ---------------- workspace io ---------------- */

  get current(): Workspace {
    return this.workspace;
  }

  get currentPath(): string | null {
    return this.filePath;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Monotonic counter for the current workspace object. Derived indexes (point index,
   * runtime targets) cache against it instead of being rebuilt on every scheduler tick.
   */
  get revision(): number {
    return this.rev;
  }

  newWorkspace(): void {
    this.workspace = emptyWorkspace();
    this.filePath = null;
    this.dirty = true;
    this.rev += 1;
  }

  loadFrom(pathOrNull: string | null): { ok: boolean; error?: string } {
    const target = pathOrNull ?? this.prefs.lastWorkspacePath;
    if (!target || !fs.existsSync(target)) return { ok: false, error: 'workspace file not found' };
    try {
      const raw = JSON.parse(fs.readFileSync(target, 'utf-8')) as unknown;
      this.workspace = migrateWorkspace(raw);
      this.filePath = target;
      this.prefs = this.updatePrefs({ lastWorkspacePath: target });
      this.dirty = false;
      this.rev += 1;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  importFromBuffer(text: string): { ok: boolean; error?: string; workspace?: Workspace } {
    try {
      const parsed = migrateWorkspace(JSON.parse(text) as unknown);
      return { ok: true, workspace: parsed };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  adopt(workspace: Workspace, filePath: string | null): void {
    this.workspace = workspaceSchema.parse(workspace);
    this.filePath = filePath;
    this.dirty = true;
    this.rev += 1;
  }

  set(workspace: Workspace): Workspace {
    this.workspace = workspaceSchema.parse(workspace);
    this.dirty = true;
    this.rev += 1;
    this.scheduleAutosave();
    return this.workspace;
  }

  mutate(fn: (ws: Workspace) => Workspace): Workspace {
    return this.set(fn(this.workspace));
  }

  /** Atomic write: temp file + rename. Import failures never corrupt the current file. */
  saveTo(target?: string): { ok: boolean; error?: string; path?: string } {
    const dest = target ?? this.filePath;
    if (!dest) return { ok: false, error: 'no workspace path; use save-as first' };
    try {
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.workspace, null, 2), 'utf-8');
      fs.renameSync(tmp, dest);
      this.filePath = dest;
      this.dirty = false;
      this.prefs = this.updatePrefs({ lastWorkspacePath: dest });
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  scheduleAutosave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty && this.filePath) this.saveTo();
    }, 800);
  }

  flushAutosave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this.filePath) this.saveTo();
  }

  exportText(): string {
    return JSON.stringify(this.workspace, null, 2);
  }

  static defaultWorkspaceDir(): string {
    return path.join(os.homedir(), 'ModbusStudio');
  }
}