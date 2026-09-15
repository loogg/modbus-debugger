import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { programManifestSchema } from '../../shared/install-manifest';
import type { UpdateAsset, UpdatePackageKind } from '../../shared/update';
const execFileAsync=promisify(execFile);
const powershell=path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export interface InstallOutcome {phase:'success'|'rolled-back'|'failed';message:string;version:string;previousVersion:string;at:string;backupDirectory:string;jobDirectory:string}
const outcomeSchema=z.object({phase:z.enum(['success','rolled-back','failed']),message:z.string().max(4000),version:z.string(),previousVersion:z.string(),at:z.string(),backupDirectory:z.string(),jobDirectory:z.string()});
export interface InstallContext {
  packaged:boolean; kind:UpdatePackageKind; currentVersion:string; executionDir:string; currentExe:string; portableExe?:string;
  dataRoot:string; helperSource:string; processId?:number; parentId?:number; protectedPaths:string[]; restartArgs:string[];
}
export async function readInstallOutcome(dataRoot:string):Promise<InstallOutcome|null> {
  try{return outcomeSchema.parse(JSON.parse(await fs.readFile(path.join(dataRoot,'data','updates','last-install.json'),'utf8')))}catch{return null}
}
export async function inspectPortableParent(parentId:number):Promise<{path:string;product:string}> {
  if(!Number.isSafeInteger(parentId)||parentId<=0)throw new Error('Invalid Portable parent process');
  const {stdout}=await execFileAsync(powershell,['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-Process -Id ${parentId} -ErrorAction Stop; [pscustomobject]@{path=$p.Path;product=$p.MainModule.FileVersionInfo.ProductName}|ConvertTo-Json -Compress`],{windowsHide:true});
  return z.object({path:z.string(),product:z.string()}).parse(JSON.parse(stdout));
}
export async function prepareInstall(context:InstallContext, asset:UpdateAsset, assetPath:string, version:string, manifest:{path:string;sha256:string}|null,signal:AbortSignal) {
  if(!context.packaged || process.platform!=='win32') throw new Error('自升级仅用于 Windows 打包版；开发模式请通过源码更新。');
  const installDir=path.resolve(context.executionDir);
  if(samePath(installDir,path.parse(installDir).root)) throw new Error('程序位于磁盘根目录，无法安全自升级，请先移到独立文件夹。');
  let targetExe=path.join(installDir,'modbus-debugger.exe');
  const waitProcesses=[{id:context.processId??process.pid,path:context.currentExe}];
  if(context.kind==='portable') {
    const parentId=context.parentId??process.ppid;
    const parent=await inspectPortableParent(parentId);
    if(!samePath(path.dirname(parent.path),installDir) || parent.product!=='Modbus Debugger' || (context.portableExe && !samePath(context.portableExe,parent.path))) throw new Error('无法确认 Portable 外层程序，请从 Portable.exe 正常启动后再升级。');
    targetExe=parent.path; waitProcesses.push({id:parentId,path:parent.path});
  } else {
    if(!samePath(targetExe,context.currentExe)) throw new Error('无法确认当前程序安装位置。');
    const old=programManifestSchema.parse(JSON.parse(await fs.readFile(path.join(installDir,'resources','app-files.json'),'utf8')));
    if(old.version!==context.currentVersion) throw new Error('本地程序文件清单与版本不一致，无法安全升级。');
  }
  if(context.kind==='setup' && !manifest) throw new Error('此 Release 缺少自升级文件清单，请等待发布完成后重试。');
  const root=path.join(context.dataRoot,'temp','self-update'); await fs.mkdir(root,{recursive:true});
  const jobDirectory=path.join(root,`install-${randomUUID()}`); await fs.mkdir(jobDirectory);
  const nonce=randomBytes(16).toString('hex');
  const plan={schemaVersion:1,nonce,kind:context.kind,currentVersion:context.currentVersion,version,installDir,targetExe,dataRoot:path.resolve(context.dataRoot),assetPath,sha256:asset.sha256,size:asset.size,
    manifestPath:manifest?.path??null,manifestSha256:manifest?.sha256??null,waitProcesses,protectedPaths:context.protectedPaths,restartArgs:context.restartArgs,bootTimeoutMs:60000};
  const planPath=path.join(jobDirectory,'plan.json'); const script=path.join(jobDirectory,'update-helper.ps1');
  await fs.writeFile(planPath,JSON.stringify(plan)); await fs.copyFile(context.helperSource,script);
  signal.throwIfAborted();
  // Detached PowerShell skips execution on Windows; an ordinary child is killed with Electron.
  // Use a detached, hidden cmd bootstrap. Its command is constant: paths enter PowerShell as
  // environment-variable values, never interpolated shell code or forwarded user arguments.
  const output=await fs.open(path.join(jobDirectory,'helper.log'),'a');
  const bootstrap=String.raw`""%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& $env:MODBUS_UPDATE_SCRIPT -PlanPath $env:MODBUS_UPDATE_PLAN""`;
  const child=spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','cmd.exe'),['/d','/s','/c',bootstrap],{
    detached:true,windowsVerbatimArguments:true,stdio:['ignore',output.fd,output.fd],windowsHide:true,
    env:{...process.env,MODBUS_UPDATE_SCRIPT:script,MODBUS_UPDATE_PLAN:planPath},
  });
  let spawnError:Error|null=null; child.on('error',error=>{spawnError=error}); child.unref();
  await output.close();
  const abort=async()=>{await fs.writeFile(path.join(jobDirectory,'abort'),'cancelled').catch(()=>{})};
  try {
    const deadline=Date.now()+120000;
    while(Date.now()<deadline) {
      if(signal.aborted){await abort();signal.throwIfAborted()}
      if(spawnError)throw spawnError;
      const status=await fs.readFile(path.join(jobDirectory,'status.json'),'utf8').then(text=>JSON.parse(text) as {phase:string;message:string;nonce:string}).catch(()=>null);
      if(status?.nonce===nonce && status.phase==='failed')throw new Error(`准备更新失败：${status.message}`);
      if(status?.nonce===nonce && status.phase==='ready') return {
        jobDirectory,targetExe,abort,
        commit:async()=>{signal.throwIfAborted(); await fs.writeFile(path.join(jobDirectory,'commit.json'),JSON.stringify({nonce}),{flag:'wx'})},
      };
      if(child.exitCode!==null)throw new Error(`更新助手提前退出（${child.exitCode}），请检查系统权限。`);
      await delay(100);
    }
    throw new Error('准备更新超时，请重试。');
  } catch(error){await abort(); throw error}
}

/** CLI handshake accepts only our own session under the configured data root. No arbitrary write paths. */
export async function confirmUpdatedBoot(dataRoot:string,session:string,token:string,version:string):Promise<boolean> {
  if(!session || !/^[a-f0-9]{32}$/.test(token))return false;
  const directory=path.resolve(session); const root=path.join(path.resolve(dataRoot),'temp','self-update');
  if(!samePath(path.dirname(directory),root) || !/^install-[a-f0-9-]{36}$/.test(path.basename(directory)))return false;
  const plan=JSON.parse(await fs.readFile(path.join(directory,'plan.json'),'utf8')) as {nonce:string;version:string;dataRoot:string};
  if(plan.nonce!==token || plan.version!==version || !samePath(plan.dataRoot,dataRoot))return false;
  await fs.writeFile(path.join(directory,'boot-ok.json'),JSON.stringify({nonce:token,version,pid:process.pid}),{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error});
  return true;
}
