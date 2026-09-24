import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { AppBackendService } from './backend-service';
import type { BridgeClientMessage, BridgeServerMessage } from '../../shared/preload-api';
import type { AppDelta } from '../../shared/snapshot';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface DevBridgeOptions {
  port?: number;
  host?: string;
}

export class DevBridgeServer {
  private server: http.Server | null = null;
  private clients = new Set<Socket>();
  private unsubscribeDelta: (() => void) | null = null;
  readonly host: string;
  readonly port: number;

  constructor(
    private readonly backend: AppBackendService,
    options?: DevBridgeOptions,
  ) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 5174;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        // Simple health/info check for dev review
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            status: 'ok',
            bridge: 'Modbus Debugger Dev Bridge',
            clients: this.clients.size,
            versions: this.backend.getVersions(),
          }),
        );
      });

      server.on('upgrade', (req, socket: Socket) => {
        this.handleUpgrade(req, socket);
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        this.server = server;
        this.unsubscribeDelta = this.backend.subscribeDelta((delta) => {
          this.broadcastDelta(delta);
        });
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(actualPort);
      });
    });
  }

  close(): Promise<void> {
    if (this.unsubscribeDelta) {
      this.unsubscribeDelta();
      this.unsubscribeDelta = null;
    }
    for (const socket of this.clients) {
      try {
        this.sendFrame(socket, 0x8, Buffer.alloc(0)); // close frame
        socket.destroy();
      } catch {
        // ignore error on close
      }
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n');

    socket.write(headers);
    this.clients.add(socket);

    // Send initial greeting with versions
    const helloMsg: BridgeServerMessage = {
      type: 'hello',
      versions: this.backend.getVersions(),
    };
    this.sendJson(socket, helloMsg);

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = this.processFrames(socket, buffer);
    });

    const cleanup = () => {
      this.clients.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('end', cleanup);
  }

  private processFrames(socket: Socket, buffer: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    while (buffer.length >= 2) {
      const firstByte = buffer[0]!;
      const secondByte = buffer[1]!;

      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return buffer;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return buffer;
        // Read 64-bit integer
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          socket.destroy();
          return Buffer.alloc(0);
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;

      if (buffer.length < totalLen) {
        return buffer; // Wait for full frame
      }

      let payload = buffer.subarray(offset + maskLen, totalLen);

      if (isMasked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i]! ^ mask[i % 4]!;
        }
        payload = unmasked;
      }

      // Handle Opcode
      if (opcode === 0x1) {
        // Text frame
        const text = payload.toString('utf8');
        void this.handleClientText(socket, text);
      } else if (opcode === 0x8) {
        // Connection close
        this.sendFrame(socket, 0x8, Buffer.alloc(0));
        socket.destroy();
        return Buffer.alloc(0);
      } else if (opcode === 0x9) {
        // Ping -> reply Pong
        this.sendFrame(socket, 0xa, payload);
      }

      buffer = buffer.subarray(totalLen);
    }
    return buffer;
  }

  private async handleClientText(socket: Socket, text: string): Promise<void> {
    let msg: BridgeClientMessage;
    try {
      msg = JSON.parse(text) as BridgeClientMessage;
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object' || !msg.id) return;

    if (msg.type === 'snapshot') {
      try {
        const snapshot = this.backend.getSnapshot();
        this.sendJson(socket, {
          type: 'response',
          id: msg.id,
          ok: true,
          value: snapshot,
        });
      } catch (err) {
        this.sendJson(socket, {
          type: 'response',
          id: msg.id,
          ok: false,
          error: String(err),
        });
      }
      return;
    }

    if (msg.type === 'versions') {
      this.sendJson(socket, {
        type: 'response',
        id: msg.id,
        ok: true,
        value: this.backend.getVersions(),
      });
      return;
    }

    if (msg.type === 'command') {
      try {
        const result = await this.backend.handleCommand(msg.command);
        if (result.ok) {
          this.sendJson(socket, {
            type: 'response',
            id: msg.id,
            ok: true,
            value: result.value,
          });
        } else {
          this.sendJson(socket, {
            type: 'response',
            id: msg.id,
            ok: false,
            error: result.error,
          });
        }
      } catch (err) {
        this.sendJson(socket, {
          type: 'response',
          id: msg.id,
          ok: false,
          error: String(err),
        });
      }
      return;
    }

    // Whitelist rejection
    const fallback = msg as { id?: string; type?: string };
    this.sendJson(socket, {
      type: 'response',
      id: fallback.id ?? 'unknown',
      ok: false,
      error: `Unknown or disallowed message type: ${fallback.type}`,
    });
  }

  private broadcastDelta(delta: AppDelta): void {
    const msg: BridgeServerMessage = {
      type: 'delta',
      delta,
    };
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, 'utf8');
    for (const client of this.clients) {
      if (!client.destroyed && client.writable) {
        this.sendFrame(client, 0x1, payload);
      }
    }
  }

  private sendJson(socket: Socket, obj: BridgeServerMessage): void {
    if (socket.destroyed || !socket.writable) return;
    const json = JSON.stringify(obj);
    this.sendFrame(socket, 0x1, Buffer.from(json, 'utf8'));
  }

  private sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;

    if (len <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
      header[1] = len; // unmasked
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    socket.write(Buffer.concat([header, payload]));
  }
}
