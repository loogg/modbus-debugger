import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { UPDATE_RELEASES, UPDATE_REPOSITORY, type UpdateAsset, type UpdatePackageKind, type UpdateRelease, type UpdateState } from '../../shared/update';

export const LATEST_RELEASE_API = 'https://api.github.com/repos/loogg/modbus-debugger/releases/latest';
const MAX_PACKAGE_SIZE = 2 * 1024 * 1024 * 1024;
const releaseSchema = z.object({
  tag_name: z.string().max(100), draft: z.boolean(), prerelease: z.boolean(),
  body: z.string().nullable().optional(), published_at: z.string().nullable().optional(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), size: z.number().int(), state: z.string(), digest: z.string().nullable().optional() })).max(1000),
});
function versionParts(version: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error('版本号格式无效');
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('版本号超出有效范围');
  return { parts, prerelease: Boolean(match[4]) };
}
export function isNewerRelease(remote: string, current: string): boolean {
  const a = versionParts(remote); const b = versionParts(current);
  if (a.prerelease) return false;
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  return b.prerelease;
}
export function detectPackageKind(executionDir: string, portable: boolean): UpdatePackageKind {
  if (portable) return 'portable';
  return fs.existsSync(path.join(executionDir, 'Uninstall modbus-debugger.exe')) ? 'setup' : 'zip';
}
export function parseRelease(raw: unknown, arch: string, kind: UpdatePackageKind): UpdateRelease {
  const release = releaseSchema.parse(raw);
  if (release.draft || release.prerelease || !release.tag_name.startsWith('v')) throw new Error('仅支持 GitHub Releases 中的正式版本');
  const version = release.tag_name.slice(1);
  if (versionParts(version).prerelease) throw new Error('忽略预发布版本');
  const suffix = kind === 'zip' ? '.zip' : kind === 'portable' ? '-Portable.exe' : '-Setup.exe';
  const name = `modbus-debugger-${version}-win-${arch}${suffix}`;
  const expectedUrl = `${UPDATE_RELEASES}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
  const matches = release.assets.filter(asset => asset.name === name && asset.state === 'uploaded');
  const asset = matches.length === 1 ? matches[0]! : null;
  if (asset && (asset.browser_download_url !== expectedUrl || asset.size <= 0 || asset.size > MAX_PACKAGE_SIZE)) throw new Error('发布附件的地址或大小无效');
  if (asset && !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) throw new Error('发布附件缺少 SHA-256 校验信息，请在 GitHub 发布页确认');
  const manifestName = `modbus-debugger-${version}-win-${arch}-manifest.json`;
  const manifests = release.assets.filter(item => item.name === manifestName && item.state === 'uploaded');
  const manifest = manifests.length === 1 ? manifests[0]! : null;
  const manifestUrl = `${UPDATE_RELEASES}/download/${encodeURIComponent(release.tag_name)}/${manifestName}`;
  if (manifest && (manifest.browser_download_url !== manifestUrl || manifest.size <= 0 || manifest.size > 2 * 1024 * 1024 || !/^sha256:[a-f\d]{64}$/i.test(manifest.digest ?? ''))) throw new Error('升级文件清单无效');
  return {
    version, url: `${UPDATE_RELEASES}/tag/${encodeURIComponent(release.tag_name)}`,
    notes: (release.body ?? '').slice(0, 100000), publishedAt: release.published_at ?? null,
    asset: asset ? { name, url: expectedUrl, size: asset.size, sha256: asset.digest!.slice(7).toLowerCase() } : null,
    manifest: manifest ? { name: manifestName, url: manifestUrl, size: manifest.size, sha256: manifest.digest!.slice(7).toLowerCase() } : null,
  };
}
interface UpdateOptions {
  currentVersion: string; packageKind: UpdatePackageKind; platform: string; arch: string;
  dataDirectory: string; tempDirectory: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  reveal: (file: string) => void;
  openExternal: (url: string) => Promise<void>;
  requestTimeoutMs?: number; downloadTimeoutMs?: number;
  canInstall?: boolean; bootPending?: boolean; installMessage?: string | null;
  install?: (release: UpdateRelease, file: string, manifest: {path:string;sha256:string}|null, signal: AbortSignal, installing: () => void) => Promise<void>;
  confirmBoot?: () => Promise<string | null>;
}

/** Main owns update discovery, download bytes, verification and file paths. No background checks. */
export class UpdateService {
  private value: UpdateState;
  private active: AbortController | null = null;
  private task: Promise<void> | null = null;
  private readonly directory: string;
  private readonly partialDirectory: string;
  onChange: ((state: UpdateState) => void) | null = null;
  constructor(private readonly options: UpdateOptions) {
    this.directory = path.join(options.dataDirectory, 'updates');
    this.partialDirectory = path.join(options.tempDirectory, 'updates');
    this.value = { currentVersion: options.currentVersion, packageKind: options.packageKind, platform: options.platform, arch: options.arch,
      phase: 'idle', latest: null, available: false, checkedAt: null, receivedBytes: 0, totalBytes: 0, downloadPath: null, error: null,
      canInstall: options.canInstall ?? false, bootPending: options.bootPending ?? false, installMessage: options.installMessage ?? null };
  }
  snapshot(): UpdateState { return structuredClone(this.value); }
  private set(patch: Partial<UpdateState>) { this.value = { ...this.value, ...patch }; this.onChange?.(this.snapshot()); }
  private async run(work: (signal: AbortSignal) => Promise<void>, timeoutMs: number): Promise<UpdateState> {
    if (this.active) throw new Error('当前更新操作尚未结束');
    const controller = new AbortController(); this.active = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const task = (async () => {
      try { await work(controller.signal); }
      catch (error) {
        if (controller.signal.aborted && !timedOut) this.set({ phase: this.value.available ? 'available' : 'idle', error: null, receivedBytes: 0 });
        else this.set({ phase: 'error', downloadPath: null, error: timedOut ? '连接或下载超时，请重试。' : error instanceof Error ? error.message : String(error) });
      } finally { clearTimeout(timer); this.active = null; this.task = null; }
    })();
    this.task = task; await task; return this.snapshot();
  }
  private fetch(url: string, signal: AbortSignal, json: boolean) {
    return this.options.fetch(url, { signal, redirect: json ? 'error' : 'follow', credentials: 'omit', cache: 'no-store', headers: json ? {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `modbus-debugger/${this.options.currentVersion}`,
    } : { Accept: 'application/octet-stream' } });
  }
  async check(): Promise<UpdateState> {
    return this.run(async signal => {
      this.set({ phase: 'checking', latest: null, available: false, error: null, downloadPath: null, receivedBytes: 0, totalBytes: 0 });
      if (this.options.platform !== 'win32') throw new Error('目前仅提供 Windows 更新包，可在 GitHub 查看发布说明。');
      const response = await this.fetch(LATEST_RELEASE_API, signal, true);
      if (response.status === 404) { await response.body?.cancel(); this.set({ phase: 'current', checkedAt: new Date().toISOString() }); return; }
      if (response.status === 403 || response.status === 429) { await response.body?.cancel(); throw new Error('GitHub 请求受限，请稍后重试或打开发布页。'); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`检查更新失败（HTTP ${response.status}），请检查网络连接。`); }
      if (!response.body) throw new Error('GitHub 未返回发布信息');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('发布信息过大'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      signal.throwIfAborted();
      const latest = parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.options.arch, this.options.packageKind);
      const available = isNewerRelease(latest.version, this.options.currentVersion);
      this.set({ phase: available ? 'available' : 'current', latest, available, checkedAt: new Date().toISOString() });
    }, this.options.requestTimeoutMs ?? 20000);
  }
  private async assetResponse(asset: UpdateAsset, signal: AbortSignal): Promise<Response> {
    let url = asset.url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          (parsed.hostname !== 'release-assets.githubusercontent.com' && parsed.hostname !== 'objects.githubusercontent.com' && url !== asset.url)) throw new Error('更新下载被重定向到非 GitHub 地址');
      // Electron 33 rejects manual redirects; native fetch follows GitHub's asset CDN redirect.
      const response = await this.fetch(url, signal, false);
      if (response.url) {
        const final = new URL(response.url);
        if (final.protocol !== 'https:' || final.username || final.password || final.port ||
            (final.hostname !== 'release-assets.githubusercontent.com' && final.hostname !== 'objects.githubusercontent.com' && response.url !== asset.url)) {
          await response.body?.cancel(); throw new Error('更新下载返回了非 GitHub 地址');
        }
      }
      if ([301,302,303,307,308].includes(response.status)) {
        const target = response.headers.get('location'); await response.body?.cancel();
        if (!target) throw new Error('更新下载重定向无效'); url = new URL(target, url).href; continue;
      }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`下载更新失败（HTTP ${response.status}）`); }
      return response;
    }
    throw new Error('更新下载重定向次数过多');
  }
  private async verify(file: string, asset: UpdateAsset, signal?: AbortSignal): Promise<boolean> {
    const info = await fsp.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  }
  async download(): Promise<UpdateState> {
    return this.run(async signal => {
      const asset = this.value.available ? this.value.latest?.asset : null;
      if (!asset) throw new Error('请先检查更新，并确认发布中存在对应架构的附件。');
      this.set({ phase: 'downloading', receivedBytes: 0, totalBytes: asset.size, error: null, downloadPath: null });
      await fsp.mkdir(this.directory, { recursive: true });
      const destination = path.join(this.directory, asset.name);
      if (await this.verify(destination, asset, signal).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) {
        this.set({ phase: 'downloaded', downloadPath: destination, receivedBytes: asset.size }); return;
      }
      await fsp.mkdir(this.partialDirectory, { recursive: true });
      const partial = path.join(this.partialDirectory, `${asset.name}.${randomUUID()}.part`);
      try {
        const response = await this.assetResponse(asset, signal);
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) !== asset.size) { await response.body!.cancel(); throw new Error('附件大小与发布信息不一致'); }
        const hash = createHash('sha256'); let received = 0; let lastPublished = 0;
        const progress = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          if (received > asset.size) { callback(new Error('下载数据超出附件大小')); return; }
          hash.update(chunk);
          if (Date.now() - lastPublished >= 150) { lastPublished = Date.now(); this.set({ receivedBytes: received }); }
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body! as import('node:stream/web').ReadableStream<Uint8Array>), progress, fs.createWriteStream(partial, { flags: 'wx' }), { signal });
        this.set({ phase: 'verifying', receivedBytes: received });
        signal.throwIfAborted();
        if (received !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('更新包校验失败，请重新下载。');
        // Only this managed versioned filename is replaced; application/user files are never overwritten.
        await fsp.rename(partial, destination);
        this.set({ phase: 'downloaded', downloadPath: destination });
      } finally { await fsp.rm(partial, { force: true }); }
    }, this.options.downloadTimeoutMs ?? 15 * 60 * 1000);
  }
  async install(): Promise<UpdateState> {
    if (!this.value.canInstall || !this.options.install) throw new Error('请在 Windows 打包版中安装更新。');
    const release = this.value.latest; const file = this.value.downloadPath;
    if (!release?.asset || !file || !this.value.available) throw new Error('请先下载更新包。');
    return this.run(async signal => {
      this.set({phase:'preparing',error:null});
      if (!await this.verify(file, release.asset!, signal)) throw new Error('更新包已被修改，请重新下载。');
      let manifest: {path:string;sha256:string}|null = null;
      if (this.options.packageKind === 'setup') {
        const asset = release.manifest;
        if (!asset) throw new Error('此 Release 缺少升级文件清单，请等待发布完成后重试。');
        const response = await this.assetResponse(asset, signal);
        const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > asset.size) throw new Error('升级清单大小不匹配'); chunks.push(chunk.value); } }
        finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        if (size !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('升级清单校验失败');
        const manifestPath = path.join(this.directory, asset.name);
        await fsp.writeFile(manifestPath, bytes); manifest = {path:manifestPath,sha256:asset.sha256};
      }
      await this.options.install!(release, file, manifest, signal, () => this.set({phase:'installing'}));
    }, 5 * 60 * 1000);
  }
  async confirmBoot(): Promise<void> {
    if (!this.value.bootPending) return;
    this.set({bootPending:false});
    const message = await this.options.confirmBoot?.();
    if (message) this.set({installMessage:message});
  }
  cancel(): void { if (this.value.phase !== 'installing') this.active?.abort(); }
  async dispose(): Promise<void> { this.cancel(); await this.task; }
  async revealDownload(): Promise<void> {
    if (this.active) throw new Error('请等待当前更新操作结束');
    const asset = this.value.latest?.asset; const file = this.value.downloadPath;
    if (!asset || !file || !await this.verify(file, asset).catch(() => false)) { this.set({ phase: 'error', downloadPath: null, error: '下载文件不存在或已被修改，请重新下载。' }); return; }
    this.options.reveal(file);
  }
  async openLink(target: 'repository' | 'releases'): Promise<void> {
    await this.options.openExternal(target === 'repository' ? UPDATE_REPOSITORY : this.value.latest?.url ?? UPDATE_RELEASES);
  }
}
