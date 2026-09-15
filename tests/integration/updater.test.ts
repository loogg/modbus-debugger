import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createScratch } from '../../tools/test-paths.mjs';
import { UpdateService, parseRelease, isNewerRelease, detectPackageKind, LATEST_RELEASE_API } from '../../src/main/services/updater';
import { UPDATE_RELEASES, type UpdatePackageKind, type UpdateState } from '../../src/shared/update';
import { commandSchema } from '../../src/shared/commands';

const bytes = Buffer.from('PK\x03\x04 verified test payload');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const kinds: UpdatePackageKind[] = ['zip','portable','setup'];
const release = (version = '1.2.0') => ({ tag_name: `v${version}`, draft:false, prerelease:false, body:'更新说明\n下一行', published_at:'2026-09-15T00:00:00Z', assets:kinds.map(kind => {
  const name = `modbus-debugger-${version}-win-x64${kind==='zip'?'.zip':kind==='portable'?'-Portable.exe':'-Setup.exe'}`;
  return { name, size:bytes.length, state:'uploaded', digest, browser_download_url:`${UPDATE_RELEASES}/download/v${version}/${name}` };
}) });
function harness(fetcher?: (url:string, init:RequestInit) => Promise<Response>, extra = {}) {
  const directory = createScratch('update-');
  const fetch = vi.fn(fetcher ?? (async url => url===LATEST_RELEASE_API ? Response.json(release()) : new Response(bytes)));
  const reveal = vi.fn(); const openExternal = vi.fn(async () => {});
  const service = new UpdateService({ currentVersion:'1.1.0', packageKind:'zip', platform:'win32', arch:'x64', dataDirectory:directory, tempDirectory:path.join(directory,'temp'), fetch, reveal, openExternal, ...extra });
  return { service, fetch, directory, reveal, openExternal };
}

describe('GitHub Release selection',()=>{
  it.each([['0.10.0','0.9.9',true],['1.2.0','1.2.0',false],['1.1.0','1.2.0',false],['1.2.0','1.2.0-beta.2',true],['1.2.0+build','1.2.0',false]])('compares %s with %s', (remote,current,expected)=>expect(isNewerRelease(remote,current)).toBe(expected));
  it.each(kinds)('selects the exact %s asset, never source archives or other architecture', kind=>{
    const selected=parseRelease(release(),'x64',kind); expect(selected.asset?.name).toContain(kind==='zip'?'.zip':kind==='portable'?'-Portable.exe':'-Setup.exe');
    expect(parseRelease(release(),'arm64',kind).asset).toBeNull();
  });
  it('rejects draft, prerelease, unexpected URL, missing digest and path-like versions',()=>{
    for(const patch of [{draft:true},{prerelease:true},{tag_name:'v../outside'},{tag_name:'v1.2.0-beta'}]) expect(()=>parseRelease({...release(),...patch},'x64','zip')).toThrow();
    for(const patch of [{browser_download_url:'https://evil.example/file.zip'},{digest:null},{size:0},{size:3*1024**3}]) {
      const value=release(); Object.assign(value.assets[0]!,patch); expect(()=>parseRelease(value,'x64','zip')).toThrow();
    }
  });
  it('detects portable first, installed Setup by its uninstaller, and otherwise ZIP',()=>{
    const dir=createScratch('update-kind-'); expect(detectPackageKind(dir,false)).toBe('zip');
    fs.writeFileSync(path.join(dir,'Uninstall modbus-debugger.exe'),''); expect(detectPackageKind(dir,false)).toBe('setup'); expect(detectPackageKind(dir,true)).toBe('portable');
  });
  it('never accepts caller-supplied update URLs or file paths through IPC',()=>{
    expect(commandSchema.safeParse({type:'update.openLink',target:'https://evil.example'}).success).toBe(false);
    expect(commandSchema.parse({type:'update.download',url:'https://evil.example',path:'C:/other.exe'})).toEqual({type:'update.download'});
  });
});

describe('Main update workflow',()=>{
  it('revalidates bytes before installing and does not hand corrupted files to the helper',async()=>{
    const install=vi.fn(async()=>{});const h=harness(undefined,{canInstall:true,install});await h.service.check();const downloaded=await h.service.download();
    await fsp.writeFile(downloaded.downloadPath!,Buffer.alloc(bytes.length));
    expect((await h.service.install()).phase).toBe('error');expect(install).not.toHaveBeenCalled();
  });
  it('hands the verified release to the installer and blocks duplicate installation',async()=>{
    let done!:()=>void; const install=vi.fn(async (_release:unknown,_file:string,_manifest:unknown,_signal:AbortSignal,installing:()=>void)=>{installing();await new Promise<void>(r=>{done=r})});
    const h=harness(undefined,{canInstall:true,install});await h.service.check();await h.service.download();const pending=h.service.install();
    await vi.waitFor(()=>expect(install).toHaveBeenCalledOnce());h.service.cancel();expect(h.service.snapshot().phase).toBe('installing');
    await expect(h.service.install()).rejects.toThrow('尚未结束');done();await pending;
  });
  it('refuses Setup installation without the matching verified manifest',async()=>{
    const install=vi.fn(async()=>{});const h=harness(undefined,{canInstall:true,packageKind:'setup',install});await h.service.check();await h.service.download();
    expect((await h.service.install()).error).toContain('缺少升级文件清单');expect(install).not.toHaveBeenCalled();
  });
  it('acknowledges boot only once when requested by Main',async()=>{
    const confirmBoot=vi.fn(async()=> '已升级');const h=harness(undefined,{bootPending:true,confirmBoot});await h.service.confirmBoot();await h.service.confirmBoot();expect(confirmBoot).toHaveBeenCalledOnce();expect(h.service.snapshot().installMessage).toBe('已升级');
  });
  it('starts without network activity and checks only the fixed public Releases endpoint',async()=>{
    const h=harness(); expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.service.check()).phase).toBe('available');
    expect(h.fetch.mock.calls[0]?.[0]).toBe(LATEST_RELEASE_API); expect(h.fetch.mock.calls[0]?.[1].credentials).toBe('omit');
    await h.service.openLink('releases'); expect(h.openExternal).toHaveBeenCalledWith(`${UPDATE_RELEASES}/tag/v1.2.0`);
  });
  it('never downgrades and distinguishes absence of a Release from a network failure',async()=>{
    expect((await harness(undefined,{currentVersion:'9.0.0'}).service.check()).phase).toBe('current');
    const absent=await harness(async()=>new Response(null,{status:404})).service.check(); expect(absent.phase).toBe('current'); expect(absent.latest).toBeNull();
    const unavailable=await harness(undefined,{arch:'arm64'}).service.check(); expect(unavailable.available).toBe(true); expect(unavailable.latest?.asset).toBeNull();
  });
  it.each([403,429,500])('reports HTTP %i and allows a later check to recover',async status=>{
    const h=harness(); h.fetch.mockResolvedValueOnce(new Response(null,{status}));
    expect((await h.service.check()).phase).toBe('error'); expect((await h.service.check()).phase).toBe('available');
  });
  it('reports invalid JSON and oversized metadata without offering downloads',async()=>{
    for(const text of ['invalid','x'.repeat(1024*1024+1)]) {
      const h=harness(async()=>new Response(text)); const result=await h.service.check(); expect(result.phase).toBe('error'); expect(result.available).toBe(false);
    }
  });
  it('times out checking and rejects duplicate requests; cancellation is not a stale success',async()=>{
    const fetcher=async (_url:string,init:RequestInit) => new Promise<Response>((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    const h=harness(fetcher,{requestTimeoutMs:20}); const first=h.service.check();
    await expect(h.service.check()).rejects.toThrow('尚未结束'); expect((await first).error).toContain('超时');
    const checking=h.service.check(); h.service.cancel(); expect((await checking).phase).toBe('idle');
  });
  it('downloads verified bytes to data/updates and reuses a verified download',async()=>{
    const h=harness(); const states:UpdateState[]=[]; h.service.onChange=s=>states.push(s);
    await h.service.check(); const result=await h.service.download();
    expect(result.phase).toBe('downloaded'); expect(await fsp.readFile(result.downloadPath!)).toEqual(bytes);
    expect(path.dirname(result.downloadPath!)).toBe(path.join(h.directory,'updates'));
    expect(states.some(s=>s.phase==='verifying')).toBe(true); expect(states.at(-1)?.receivedBytes).toBe(bytes.length);
    await h.service.download(); expect(h.fetch).toHaveBeenCalledTimes(2);
    await h.service.revealDownload(); expect(h.reveal).toHaveBeenCalledWith(result.downloadPath);
    await fsp.writeFile(result.downloadPath!,Buffer.alloc(bytes.length)); await h.service.revealDownload(); expect(h.reveal).toHaveBeenCalledTimes(1); expect(h.service.snapshot().phase).toBe('error');
  });
  it.each(['digest','length','overflow'])('removes partial files after %s failure and permits retry',async mode=>{
    const h=harness(); await h.service.check();
    h.fetch.mockResolvedValueOnce(mode==='length' ? new Response(bytes,{headers:{'content-length':'1'}}) : new Response(Buffer.alloc(mode==='overflow'?bytes.length+1:bytes.length)));
    expect((await h.service.download()).phase).toBe('error'); expect(await fsp.readdir(path.join(h.directory,'updates'))).toEqual([]); expect(await fsp.readdir(path.join(h.directory,'temp','updates'))).toEqual([]);
    expect((await h.service.download()).phase).toBe('downloaded');
  });
  it('accepts GitHub asset redirects but rejects an external redirect',async()=>{
    const h=harness(); await h.service.check(); h.fetch.mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset'}}));
    expect((await h.service.download()).phase).toBe('downloaded');
    const bad=harness(); await bad.service.check(); bad.fetch.mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://evil.example/file'}}));
    expect((await bad.service.download()).error).toContain('非 GitHub'); expect(bad.fetch).toHaveBeenCalledTimes(2);
  });
  it('cancels an in-flight download and cleans its private part file, without touching user files',async()=>{
    const h=harness(); await h.service.check();
    fs.mkdirSync(path.join(h.directory,'updates')); fs.writeFileSync(path.join(h.directory,'updates','keep.txt'),'keep');
    h.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0,4)); } })));
    h.service.onChange=state=>{ if(state.phase==='downloading' && state.receivedBytes>0) h.service.cancel(); };
    const result=await h.service.download(); expect(result.phase).toBe('available'); expect(result.downloadPath).toBeNull();
    expect(await fsp.readdir(path.join(h.directory,'updates'))).toEqual(['keep.txt']);
    expect(await fsp.readdir(path.join(h.directory,'temp','updates'))).toEqual([]);
  });
  it('does not download before a successful newer Release check',async()=>{
    const h=harness(); expect((await h.service.download()).phase).toBe('error'); expect(h.fetch).not.toHaveBeenCalled();
  });
});


it('rejects an unexpected final response URL after native redirect following', async()=>{
  const h=harness(); await h.service.check();
  const response=new Response(bytes); Object.defineProperty(response,'url',{value:'https://evil.example/file'});
  h.fetch.mockResolvedValueOnce(response);
  expect((await h.service.download()).error).toContain('非 GitHub');
});
