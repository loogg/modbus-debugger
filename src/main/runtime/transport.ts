import net from 'node:net';
import type { RtuSettings, TcpSettings } from '../../domain/model';

export interface TransportHandlers {
  onData(chunk: Uint8Array): void;
  onOpen(): void;
  onError(error: Error): void;
  onClose(): void;
}

export interface Transport {
  readonly kind: 'rtu' | 'tcp';
  readonly connected: boolean;
  connect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  setHandlers(handlers: TransportHandlers): void;
}

export class TcpTransport implements Transport {
  readonly kind = 'tcp' as const;
  private socket: net.Socket | null = null;
  private handlers: TransportHandlers | null = null;
  private open = false;

  constructor(private readonly settings: TcpSettings, private readonly connectTimeoutMs = 3000) {}

  get connected(): boolean {
    return this.open;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.settings.host, port: this.settings.port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`TCP connect timeout to ${this.settings.host}:${this.settings.port}`));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.open = true;
        socket.on('data', (buf) => this.handlers?.onData(new Uint8Array(buf)));
        socket.on('error', (err) => this.handlers?.onError(err));
        socket.on('close', () => {
          this.open = false;
          this.handlers?.onClose();
        });
        this.handlers?.onOpen();
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
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
    return new Promise((resolve) => {
      const socket = this.socket;
      this.socket = null;
      if (!socket) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      socket.destroy();
      this.open = false;
    });
  }
}

export interface SerialPortLike {
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

  constructor(
    private readonly settings: RtuSettings,
    private readonly factory: SerialPortFactory = loadSerialFactory(),
  ) {}

  get connected(): boolean {
    return this.port?.isOpen === true;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.factory(this.settings);
      port.on('data', (chunk: unknown) => {
        const buf = chunk as Buffer;
        this.handlers?.onData(new Uint8Array(buf));
      });
      port.on('error', (err: unknown) => this.handlers?.onError(err as Error));
      port.on('close', () => this.handlers?.onClose());
      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.port = port;
        this.handlers?.onOpen();
        resolve();
      });
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = this.port;
      if (!port || !port.isOpen) {
        reject(new Error('serial port not open'));
        return;
      }
      port.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const port = this.port;
      this.port = null;
      if (!port) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
  }
}