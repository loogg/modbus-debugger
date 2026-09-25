import type { AppTransport, TransportState, TransportStatus } from './types';
import type { AppDelta, AppSnapshot } from '../../shared/snapshot';
import type { Command, CommandResult } from '../../shared/commands';
import type { AppVersions, BridgeClientMessage, BridgeServerMessage } from '../../shared/preload-api';

export interface BridgeTransportOptions {
  url?: string;
  timeoutMs?: number;
  autoReconnect?: boolean;
}

export class WebSocketBridgeTransport implements AppTransport {
  readonly transportType = 'bridge' as const;
  private ws: WebSocket | null = null;
  private seq = 1;
  private pending = new Map<
    string,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private deltaListeners = new Set<(delta: AppDelta) => void>();
  private statusListeners = new Set<(state: TransportState) => void>();
  private state: TransportState;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  readonly url: string;
  readonly timeoutMs: number;
  readonly autoReconnect: boolean;

  constructor(options?: BridgeTransportOptions) {
    this.url = options?.url ?? 'ws://127.0.0.1:5174';
    this.timeoutMs = options?.timeoutMs ?? 10000;
    this.autoReconnect = options?.autoReconnect ?? true;
    this.state = {
      type: 'bridge',
      status: 'connecting',
      message: `Connecting to Dev Bridge at ${this.url}...`,
    };
    this.connect();
  }

  getStatus(): TransportState {
    return this.state;
  }

  onStatusChange(cb: (state: TransportState) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.state);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private updateStatus(status: TransportStatus, message?: string): void {
    this.state = { type: 'bridge', status, message };
    for (const cb of this.statusListeners) {
      cb(this.state);
    }
  }

  private connect(): void {
    if (this.disposed) return;
    try {
      this.updateStatus('connecting', `Connecting to Dev Bridge at ${this.url}...`);
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.updateStatus('connected', `Connected to Dev Bridge (${this.url})`);
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        this.handleMessage(event.data);
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.updateStatus('error', `Bridge connection error at ${this.url}`);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.rejectAllPending('Bridge connection closed');
        this.updateStatus('disconnected', `Disconnected from Dev Bridge (${this.url})`);
        if (this.autoReconnect && !this.disposed) {
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
      };
    } catch (err) {
      this.updateStatus('error', `Failed to open bridge: ${String(err)}`);
      if (this.autoReconnect && !this.disposed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: BridgeServerMessage;
    try {
      msg = JSON.parse(data) as BridgeServerMessage;
    } catch {
      return;
    }

    if (msg.type === 'delta') {
      for (const listener of this.deltaListeners) {
        try {
          listener(msg.delta);
        } catch {
          // ignore listener errors
        }
      }
      return;
    }

    if (msg.type === 'response') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.ok) {
          entry.resolve(msg.value);
        } else {
          entry.reject(new Error(msg.error));
        }
      }
      return;
    }

    if (msg.type === 'hello') {
      this.updateStatus('connected', `Connected (App v${msg.versions.app})`);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private async waitForOpen(timeoutMs = 5000): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }

    const start = Date.now();
    while (!this.disposed) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return this.ws;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout waiting for Dev Bridge connection (${this.url})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Dev Bridge transport disposed');
  }

  private async sendRequest<T>(msg: BridgeClientMessage, customTimeoutMs?: number): Promise<T> {
    const timeout = customTimeoutMs ?? this.timeoutMs;
    const ws = await this.waitForOpen(this.timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Bridge request timeout after ${timeout}ms (${msg.type})`));
      }, timeout);

      this.pending.set(msg.id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });

      ws.send(JSON.stringify(msg));
    });
  }

  async getSnapshot(): Promise<AppSnapshot> {
    const id = `snap_${this.seq++}`;
    return this.sendRequest<AppSnapshot>({ type: 'snapshot', id });
  }

  async versions(): Promise<AppVersions> {
    const id = `ver_${this.seq++}`;
    return this.sendRequest<AppVersions>({ type: 'versions', id });
  }

  async command<T = unknown>(cmd: Command): Promise<CommandResult<T>> {
    const id = `cmd_${this.seq++}`;
    try {
      const isLongRunning = cmd.type === 'device.scan';
      const timeoutMs = isLongRunning ? 300000 : this.timeoutMs;
      const value = await this.sendRequest<T>({ type: 'command', id, command: cmd }, timeoutMs);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  onDelta(cb: (delta: AppDelta) => void): () => void {
    this.deltaListeners.add(cb);
    return () => {
      this.deltaListeners.delete(cb);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending('Transport disposed');
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
