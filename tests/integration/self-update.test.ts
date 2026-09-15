import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createScratch } from '../../tools/test-paths.mjs';
import { writeUpdateManifest } from '../../tools/update-manifest.mjs';
import { programManifestSchema } from '../../src/shared/install-manifest';
import { confirmUpdatedBoot, inspectPortableParent } from '../../src/main/services/self-update';
const exec=promisify(execFile);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const psQuote=(s:string)=>`'${s.replaceAll("'","''")}'`;
let fixtureExe:string;
describe.skipIf(process.platform!=='win32')('native update helper',()=>{
  beforeAll(async()=>{
    const root=createScratch('helper-compiler-'); fixtureExe=path.join(root,'candidate.exe');
    const source=path.join(root,'app.cs');
    await fs.writeFile(source,'using System; using System.IO; [assembly:System.Reflection.AssemblyProduct("Modbus Debugger")] public class App { public static void Main(string[] args) { if(args.Length>0 && args[0]=="--hold"){System.Threading.Thread.Sleep(60000);return;} string s=null,t=null; foreach(string a in args){if(a.StartsWith("--update-session="))s=a.Substring(17);if(a.StartsWith("--update-token="))t=a.Substring(15);} if(s!=null){File.WriteAllText(Path.Combine(s,"boot-ok.json"),"{\\"nonce\\":\\""+t+"\\",\\"version\\":\\"1.1.0\\"}");} } }');
    await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -Path ${psQuote(source)} -OutputAssembly ${psQuote(fixtureExe)} -OutputType ConsoleApplication`],{windowsHide:true});
  },30000);
  it('reads a Portable parent with a Chinese filename without console-codepage corruption',async()=>{
    const directory=createScratch('portable-parent-');const executable=path.join(directory,'中文 便携.exe');await fs.copyFile(fixtureExe,executable);
    const child=spawn(executable,['--hold'],{windowsHide:true,stdio:'ignore'});const stopped=new Promise(resolve=>child.on('exit',resolve));
    try {await pause(250);expect(await inspectPortableParent(child.pid!)).toEqual({path:executable,product:'Modbus Debugger'});}
    finally {child.kill();await stopped;}
  });
  async function fixture(mode:'success'|'rollback'|'conflict'|'traversal'='success') {
    const root=createScratch('self-update-'); const install=path.join(root,'安装目录 App'); const incoming=path.join(root,'incoming');
    for(const directory of [install,incoming]){await fs.mkdir(path.join(directory,'resources'),{recursive:true});await fs.copyFile(fixtureExe,path.join(directory,'modbus-debugger.exe'));await fs.writeFile(path.join(directory,'resources','app.asar'),directory);}
    await writeUpdateManifest(install,'1.0.0');
    if(mode==='rollback') await fs.writeFile(path.join(incoming,'modbus-debugger.exe'),'not a Windows executable');
    if(mode==='conflict'){await fs.writeFile(path.join(incoming,'new-user.txt'),'new');await fs.writeFile(path.join(install,'new-user.txt'),'user content');}
    await writeUpdateManifest(incoming,'1.1.0');
    await fs.mkdir(path.join(install,'data'));await fs.writeFile(path.join(install,'data','history.db'),'user history');
    await fs.writeFile(path.join(install,'resources','user-extra.txt'),'extra user file');
    const assetPath=path.join(root,'update.zip');
    await exec('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(incoming)},${psQuote(assetPath)})`],{windowsHide:true});
    if(mode==='traversal') await exec('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open(${psQuote(assetPath)},'Update'); $null=$z.CreateEntry('../escape.txt'); $z.Dispose()`],{windowsHide:true});
    const asset=await fs.readFile(assetPath); const nonce='a'.repeat(32); const job=path.join(root,'temp','self-update',`install-${randomUUID()}`);await fs.mkdir(job,{recursive:true});
    const plan={schemaVersion:1,nonce,kind:'zip',currentVersion:'1.0.0',version:'1.1.0',installDir:install,targetExe:path.join(install,'modbus-debugger.exe'),dataRoot:root,assetPath,sha256:hash(asset),size:asset.length,manifestPath:null,manifestSha256:null,waitProcesses:[],protectedPaths:[],restartArgs:[],bootTimeoutMs:10000};
    const planPath=path.join(job,'plan.json');await fs.writeFile(planPath,JSON.stringify(plan));
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('build/update-helper.ps1'),'-PlanPath',planPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b});
    const done=new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)});
    let status:{phase:string;message:string}|null=null;
    try {
      const deadline=Date.now()+15000;
      while(Date.now()<deadline){status=await fs.readFile(path.join(job,'status.json'),'utf8').then(JSON.parse).catch(()=>null);if(status?.phase==='ready'||status?.phase==='failed'||child.exitCode!==null)break;await pause(100)}
      if(mode==='conflict'||mode==='traversal'){expect(status?.phase,output).toBe('failed');expect(status?.message).toMatch(mode==='conflict'?/conflicts with a user file/:/Unsafe program path/);}
      else {expect(status?.phase,`${output} ${JSON.stringify(status)}`).toBe('ready');await fs.writeFile(path.join(job,'commit.json'),JSON.stringify({nonce}));}
      const exit=await Promise.race([done,pause(35000).then(()=>{throw new Error('helper timeout')})]);
      const result=await fs.readFile(path.join(root,'data','updates','last-install.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(mode==='success'){expect(exit,JSON.stringify(result)).toBe(0);expect(result.phase).toBe('success');expect(await fs.readFile(path.join(install,'resources','app.asar'),'utf8')).toBe(incoming)}
      if(mode==='rollback'){expect(result.phase,output).toBe('rolled-back');expect(await fs.readFile(path.join(install,'resources','app.asar'),'utf8')).toBe(install)}
      expect(await fs.readFile(path.join(install,'data','history.db'),'utf8')).toBe('user history');expect(await fs.readFile(path.join(install,'resources','user-extra.txt'),'utf8')).toBe('extra user file');
      if(mode==='conflict')expect(await fs.readFile(path.join(install,'new-user.txt'),'utf8')).toBe('user content');
      expect(await fs.access(path.join(root,'escape.txt')).then(()=>true,()=>false)).toBe(false);
    } finally {if(child.exitCode===null)child.kill();await done;}
  }
  it('replaces known files, confirms the candidate and preserves user files',()=>fixture(),60000);
  it('restores previous files when the new executable cannot start',()=>fixture('rollback'),60000);
  it('rejects collisions with unknown user files before commit',()=>fixture('conflict'),30000);
  it('rejects ZIP traversal before touching the installation',()=>fixture('traversal'),30000);
});
it('rejects unsafe manifest paths and duplicate names',()=>{
  const files=[{path:'modbus-debugger.exe',sha256:'a'.repeat(64)},{path:'resources/app.asar',sha256:'b'.repeat(64)}];
  expect(programManifestSchema.safeParse({schemaVersion:1,version:'1.0.0',files}).success).toBe(true);
  for(const unsafe of ['../data/file','data/history.db','resources/CON.txt','resources/app.asar','RESOURCES/APP.ASAR','a\\b','a:stream'])expect(programManifestSchema.safeParse({schemaVersion:1,version:'1.0.0',files:[...files,{path:unsafe,sha256:'c'.repeat(64)}]}).success).toBe(false);
});
it('does not acknowledge arbitrary restart locations or incorrect versions',async()=>{
  const root=createScratch('boot-confirm-');expect(await confirmUpdatedBoot(root,root,'a'.repeat(32),'1.0.0')).toBe(false);
  const job=path.join(root,'temp','self-update',`install-${randomUUID()}`);await fs.mkdir(job,{recursive:true});await fs.writeFile(path.join(job,'plan.json'),JSON.stringify({nonce:'a'.repeat(32),version:'1.1.0',dataRoot:root}));
  expect(await confirmUpdatedBoot(root,job,'a'.repeat(32),'1.0.0')).toBe(false);expect(await confirmUpdatedBoot(root,job,'a'.repeat(32),'1.1.0')).toBe(true);
});
