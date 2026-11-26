import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppBackendService } from './backend-service';
import type { BridgeClientMessage, BridgeServerMessage } from '../../shared/preload-api';
import type { AppDelta } from '../../shared/snapshot';
import { validateBridgeCommand } from './dev-bridge-access';
import { encodeDataReadFrame } from '../../shared/data-read-frame';
import type { ColumnDataReadResult } from '../../shared/point-data';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface DevBridgeOptions {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  fileRoots?: string[];
}

export class DevBridgeServer {
  private server: http.Server | null = null;
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: protocols => protocols.has(this.sessionProtocol) ? this.sessionProtocol : false });
  private unsubscribeDelta: (() => void) | null = null;
  readonly host: string;
  readonly port: number;
  readonly sessionProtocol = `modbus-review.${crypto.randomBytes(32).toString('base64url')}`;
  private boundPort: number;
  private readonly allowedOrigins: Set<string>;
  private readonly fileRoots: string[];

  constructor(
    private readonly backend: AppBackendService,
    options?: DevBridgeOptions,
  ) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 5174;
    if (!['127.0.0.1','::1','localhost'].includes(this.host)) throw new Error('开发 Bridge 只能绑定回环地址');
    this.boundPort = this.port;
    this.allowedOrigins = new Set(options?.allowedOrigins ?? ['http://localhost:5173','http://127.0.0.1:5173']);
    this.fileRoots = options?.fileRoots ?? [];
  }

  writeSessionFile(file: string, rendererUrl = 'http://localhost:5173/'): void {
    const url = new URL(rendererUrl);
    if (!this.allowedOrigins.has(url.origin)) throw new Error('审查页面来源不在白名单内');
    url.searchParams.set('transport', 'bridge');
    const bridgeUrl = `ws://127.0.0.1:${this.boundPort}`;
    url.searchParams.set('bridgeUrl', bridgeUrl);
    url.hash = new URLSearchParams({bridgeToken:this.sessionProtocol.slice('modbus-review.'.length)}).toString();
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, JSON.stringify({reviewUrl:url.toString(),bridgeUrl}, null, 2), {mode:0o600});
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.headers.origin && !this.allowedOrigins.has(req.headers.origin)) { res.writeHead(403);res.end();return; }
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({status:'ok',bridge:'Modbus Debugger Dev Bridge'}));
      });

      server.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head);
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
        this.boundPort = actualPort;
        resolve(actualPort);
      });
    });
  }

  close(): Promise<void> {
    if (this.unsubscribeDelta) {
      this.unsubscribeDelta();
      this.unsubscribeDelta = null;
    }
    for (const socket of this.websocket.clients) socket.terminate();

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
    return this.websocket.clients.size;
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const origin = req.headers.origin;
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(value=>value.trim()) ?? [];
    const offered = protocols.find(value=>value.startsWith('modbus-review.'));
    const credential = Buffer.from(offered ?? '');
    const expected = Buffer.from(this.sessionProtocol);
    if (!origin || !this.allowedOrigins.has(origin) || credential.length !== expected.length || !crypto.timingSafeEqual(credential,expected)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.websocket.handleUpgrade(req, socket, head, client => {
      client.on('error', () => client.terminate());
      client.on('message', (data, binary) => {
        if (!binary) void this.handleClientText(client, data.toString());
      });
      this.sendJson(client, { type: 'hello', versions: this.backend.getVersions() });
    });
  }

  private async handleClientText(socket: WebSocket, text: string): Promise<void> {
    let msg: BridgeClientMessage;
    try {
      msg = JSON.parse(text) as BridgeClientMessage;
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object' || !msg.id) return;

    if (msg.type === 'snapshot') {
      try {
        const snapshot = this.backend.getSnapshot(msg.options);
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
        const command = validateBridgeCommand(msg.command,this.fileRoots,this.backend.manager);
        const result = await this.backend.handleCommand(command);
        if (result.ok) {
          if (command.type === 'data.read' && command.format === 'columns-v1') {
            if (socket.readyState === WebSocket.OPEN) socket.send(encodeDataReadFrame(msg.id, result.value as ColumnDataReadResult));
          } else this.sendJson(socket, {
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
    for (const client of this.websocket.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  private sendJson(socket: WebSocket, obj: BridgeServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  }
}
