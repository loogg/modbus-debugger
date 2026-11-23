import net from 'node:net';
import type { RtuSettings, TcpSettings } from '../../domain/model';
import { DEFAULT_CONNECT_TIMEOUT_MS } from '../../domain/model';

export interface TransportHandlers {
  onData(chunk: Uint8Array): void;
  onOpen(): void;
  onError(error: Error): void;
  onClose(): void;
}

export interface Transport {
  readonly kind: 'rtu' | 'tcp';
  readonly connected: boolean;
  connect(timeoutMs?: number): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  setHandlers(handlers: TransportHandlers): void;
}

export class TcpTransport implements Transport {
  readonly kind = 'tcp' as const;
  private socket: net.Socket | null = null;
  private handlers: TransportHandlers | null = null;
  private open = false;
  private opening: Promise<void> | null = null;
  private cancelOpening: (() => void) | null = null;

  constructor(private readonly settings: TcpSettings, private readonly connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {}

  get connected(): boolean {
    return this.open;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  connect(timeoutMs = this.connectTimeoutMs): Promise<void> {
    if (this.opening) return this.opening;
    if (this.open) return Promise.resolve();
    this.socket?.destroy();
    const opening = new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: this.settings.host, port: this.settings.port });
      this.socket = socket;
      socket.setNoDelay(true);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelOpening = null;
        if (error) {
          if (this.socket === socket) this.socket = null;
          this.open = false;
          socket.destroy();
          reject(error);
        } else {
          this.open = true;
          this.handlers?.onOpen();
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error(`TCP connect timeout (${timeoutMs} ms) to ${this.settings.host}:${this.settings.port}`)), timeoutMs);
      this.cancelOpening = () => finish(new Error('TCP connection cancelled'));
      socket.once('connect', () => {
        if (settled || this.socket !== socket) { socket.destroy(); return; }
        finish();
      });
      socket.on('data', bytes => {
        if (this.socket === socket && this.open) this.handlers?.onData(new Uint8Array(bytes));
      });
      socket.on('error', error => {
        if (!settled) finish(error);
        else if (this.socket === socket) this.handlers?.onError(error);
      });
      socket.on('close', () => {
        if (!settled) { finish(new Error('TCP connection closed while connecting')); return; }
        if (this.socket !== socket) return;
        this.socket = null;
        this.open = false;
        this.handlers?.onClose();
      });
    });
    this.opening = opening;
    const clear = () => { if (this.opening === opening) this.opening = null; };
    void opening.then(clear, clear);
    return opening;
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || !this.open) {
        reject(new Error('transport not connected'));
        return;
      }
      socket.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    const closed = !socket || socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', () => resolve()));
    this.cancelOpening?.();
    socket?.destroy();
    return closed;
  }
}

export interface SerialPortLike {
  flush?(cb: (err?: Error | null) => void): void;
  set?(options: { rts: boolean }, cb: (err?: Error | null) => void): void;
  drain?(cb: (err?: Error | null) => void): void;
  open(cb: (err: Error | null) => void): void;
  write(data: Buffer, cb?: (err: Error | null) => void): boolean;
  close(cb?: (err: Error | null) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  isOpen: boolean;
}

export type SerialPortFactory = (settings: RtuSettings) => SerialPortLike;

let defaultSerialFactory: SerialPortFactory | null = null;
export function setSerialPortFactory(factory: SerialPortFactory): void {
  defaultSerialFactory = factory;
}

function loadSerialFactory(): SerialPortFactory {
  if (defaultSerialFactory) return defaultSerialFactory;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('serialport') as { SerialPort: new (opts: Record<string, unknown>) => SerialPortLike };
  return (settings) =>
    new mod.SerialPort({
      path: settings.port,
      baudRate: settings.baudRate,
      dataBits: settings.dataBits,
      parity: settings.parity,
      stopBits: settings.stopBits,
      autoOpen: false,
    });
}

export class SerialTransport implements Transport {
  readonly kind = 'rtu' as const;
  private port: SerialPortLike | null = null;
  private handlers: TransportHandlers | null = null;
  private opening: Promise<void> | null = null;
  private pendingPort: SerialPortLike | null = null;
  private cancelOpening: (() => void) | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly settings: RtuSettings,
    private readonly factory: SerialPortFactory = loadSerialFactory(),
    private readonly rtsControl: 'none' | 'toggle' = 'none',
  ) {}

  get connected(): boolean {
    return this.port?.isOpen === true;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.opening) return this.opening;
    if (this.pendingPort || this.closing) return Promise.reject(new Error('Previous serial open/close is still completing'));
    if (this.connected) return Promise.resolve();
    const opening = new Promise<void>((resolve, reject) => {
      const port = this.factory(this.settings);
      this.pendingPort = port;
      let settled = false;
      let openCompleted = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelOpening = null;
        if (error) {
          if (port.isOpen) void this.closePort(port);
          else if (openCompleted && this.pendingPort === port) this.pendingPort = null;
          reject(error);
        } else {
          this.pendingPort = null;
          this.port = port;
          this.handlers?.onOpen();
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error(`Serial open timeout (${timeoutMs} ms) for ${this.settings.port}`)), timeoutMs);
      this.cancelOpening = () => finish(new Error('Serial connection cancelled'));
      port.on('data', (chunk: unknown) => {
        if (this.port !== port) return;
        const buf = chunk as Buffer;
        this.handlers?.onData(new Uint8Array(buf));
      });
      port.on('error', (error: unknown) => {
        if (!settled) finish(error as Error);
        else if (this.port === port) this.handlers?.onError(error as Error);
      });
      port.on('close', () => {
        if (!settled) finish(new Error('Serial port closed while opening'));
        if (this.port !== port) return;
        this.port = null;
        this.handlers?.onClose();
      });
      port.open((err) => {
        openCompleted = true;
        if (settled) {
          if (port.isOpen) void this.closePort(port);
          else if (this.pendingPort === port) this.pendingPort = null;
          return;
        }
        if (err) { finish(err); return; }
        const ready = (error?: Error | null) => {
          if (settled) { if (port.isOpen) void this.closePort(port); return; }
          finish(error);
        };
        // Discard bytes retained by the driver before this connection was opened.
        if (port.flush) port.flush(ready); else ready();
      });
    });
    this.opening = opening;
    const clear = () => { if (this.opening === opening) this.opening = null; };
    void opening.then(clear, clear);
    return opening;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) throw new Error('serial port not open');
    const control = (rts: boolean) => new Promise<void>((resolve, reject) => {
      if (!port.set) { reject(new Error('RTS control is not supported by this serial driver')); return; }
      port.set({ rts }, error => error ? reject(error) : resolve());
    });
    if (this.rtsControl === 'toggle') await control(true);
    try {
      await new Promise<void>((resolve, reject) => port.write(Buffer.from(bytes), error => error ? reject(error) : resolve()));
      if (this.rtsControl === 'toggle') await new Promise<void>((resolve, reject) => {
        if (!port.drain) { reject(new Error('Serial drain is unavailable')); return; }
        port.drain(error => error ? reject(error) : resolve());
      });
    } finally { if (this.rtsControl === 'toggle') await control(false); }
  }

  private closePort(port: SerialPortLike): Promise<void> {
    if (this.closing) return this.closing;
    if (this.port === port) this.port = null;
    const closing = new Promise<void>(resolve => {
      // Windows virtual/USB drivers can release a cancelled overlapped read just after
      // CloseHandle's callback. Keep the shutdown barrier through that completion turn.
      port.close(() => { if (process.platform === 'win32') setTimeout(resolve, 20); else resolve(); });
    });
    this.closing = closing;
    void closing.then(() => {
      if (this.pendingPort === port) this.pendingPort = null;
      if (this.closing === closing) this.closing = null;
    });
    return closing;
  }

  close(): Promise<void> {
    this.cancelOpening?.();
    if (this.closing) return this.closing;
    const port = this.port ?? this.pendingPort;
    if (!port?.isOpen) return Promise.resolve();
    return this.closePort(port);
  }
}
