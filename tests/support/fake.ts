import type { Clock } from '../../src/domain/protocol';
import type { Transport, TransportHandlers } from '../../src/main/runtime/transport';

export class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
}

export interface FakeReply {
  /** full ADUs or raw chunk sequences to deliver for the Nth request */
  chunks?: Uint8Array[];
  delayMs?: number;
}

/**
 * Fake Modbus transport for unit/integration tests. Supports arbitrary chunk
 * boundaries, noise injection, delays, exceptions, disconnect and reconnect so the
 * streaming parser and runtime recovery can be exercised deterministically.
 */
export class FakeTransport implements Transport {
  readonly kind: 'rtu' | 'tcp';
  connected = false;
  sent: Uint8Array[] = [];
  private handlers: TransportHandlers | null = null;
  private replies: Array<(adu: Uint8Array, index: number) => Uint8Array[] | null> = [];
  private persistent: ((adu: Uint8Array, index: number) => Uint8Array[] | null) | null = null;
  private requestIndex = 0;
  private clock: FakeClock | null;

  constructor(kind: 'rtu' | 'tcp', clock: FakeClock | null = null) {
    this.kind = kind;
    this.clock = clock;
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }

  /** queue a responder for the next request (FIFO) */
  /** persistent responder used for every request until replaced */
  onResponse(fn: (adu: Uint8Array, index: number) => Uint8Array[] | null): void {
    this.persistent = fn;
  }

  respondWith(chunks: Uint8Array[]): void {
    this.replies.push(() => chunks);
  }

  respondNothing(): void {
    this.replies.push(() => null);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.handlers?.onOpen();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('not connected');
    this.sent.push(bytes);
    const responder = this.persistent ?? this.replies.shift();
    const chunks = responder ? responder(bytes, this.requestIndex++) : null;
    if (chunks) {
      for (const c of chunks) this.handlers?.onData(c);
    }
  }

  /** inject unsolicited bytes (noise / late frames) */
  inject(bytes: Uint8Array): void {
    this.handlers?.onData(bytes);
  }

  advanceClock(ms: number): void {
    this.clock?.advance(ms);
  }

  drop(): void {
    this.connected = false;
    this.handlers?.onClose();
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}