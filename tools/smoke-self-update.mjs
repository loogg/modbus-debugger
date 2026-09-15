/** Real packaged-app version transitions; only GitHub HTTP responses use local release fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { extractAll, createPackageWithOptions, uncache } from '@electron/asar';
import { zip } from 'cross-zip';
import puppeteer from 'puppeteer-core';
import initSqlJs from 'sql.js';
import { assembleRelease } from './release.ts';
import { writeUpdateManifest } from './update-manifest.mjs';
import { root, pkg, base, release, waitFor, delay, run } from './smoke-app.mjs';
import { createScratch, removeScratch, snapshotLegacyPreferences, assertLegacyPreferencesUnchanged, testRoot } from './test-paths.mjs';
const scratch=process.env.SELF_UPDATE_FIXTURE ? path.resolve(process.env.SELF_UPDATE_FIXTURE) : createScratch('self-update-app-');
assert.equal(path.dirname(scratch),testRoot,'Fixture must be isolated in out/test-temp');
console.log('[self-update] isolated fixture:',scratch);
let passed=false;
const runRoot=path.join(scratch,`run-${Date.now()}`);
const SQL=await initSqlJs({locateFile:file=>path.join(root,'node_modules/sql.js/dist',file)});
const legacy=snapshotLegacyPreferences();
const futureVersion=pkg.version.split('.').map((n,i)=>String(Number(n)+(i===2?1:0))).join('.');
const futureBase=`modbus-debugger-${futureVersion}-win-x64`;
const futureRoot=path.join(scratch,'future');
const kinds=process.env.SELF_UPDATE_KINDS?.split(',') ?? ['zip','portable','setup'];
assert(kinds.length && kinds.every(kind=>['zip','portable','setup'].includes(kind)),'Invalid test runtime forms');
const futureApp=path.join(futureRoot,'out',`${pkg.productName}-win32-x64`);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const freePort=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port};
const exists=file=>fs.access(file).then(()=>true,()=>false);
async function cdpEval(port,expression) {
  const endpoints=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket=new WebSocket(endpoints[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Main inspector timeout')),10000);
    socket.onmessage=event=>{const item=JSON.parse(event.data);if(item.id!==1)return;clearTimeout(timer);if(item.error||item.result?.exceptionDetails)reject(new Error(JSON.stringify(item)));else resolve(item.result.result.value)};
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
  })}finally{socket.close()}
}
async function click(page,label) {await page.waitForFunction(text=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()===text && !button.disabled),{timeout:20000},label);const buttons=await page.$$('button');for(const button of buttons){if((await button.evaluate(el=>el.textContent)).trim()===label){await button.click();return}}throw new Error(`Button missing: ${label}`)}
async function attach(port) {
  await waitFor(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(700)})).ok}catch{return false}},90000);
  const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
  const page=await waitFor(async()=>(await browser.pages()).find(p=>p.url().startsWith('app://')));
  await page.waitForFunction(()=>window.modbus && document.body.innerText.includes('设备'),{timeout:30000});return {browser,page};
}
let installedDir=null;
async function transition(kind) {
  const failure=kind==='setup' && process.env.SELF_UPDATE_FAILURE==='setup';
  const label=failure?'setup-rollback':kind;
  const install=path.join(runRoot,`当前 ${kind}`);await fs.mkdir(install,{recursive:true});
  let executable=path.join(install,'modbus-debugger.exe');
  if(kind==='portable'){executable=path.join(install,'My Modbus Portable.exe');await fs.copyFile(path.join(release,`${base}-Portable.exe`),executable)}
  else if(kind==='setup'){installedDir=install;await run(process.env.SELF_UPDATE_SETUP ?? path.join(release,`${base}-Setup.exe`),['/S',`/D=${install}`],240000)}
  else await fs.cp(process.env.SELF_UPDATE_DIRECTORY ?? path.join(release,base),install,{recursive:true});
  const dataRoot=kind==='zip'?path.join(runRoot,'自选 数据目录'):install;
  await fs.mkdir(path.join(dataRoot,'data'),{recursive:true});
  const workspace=path.join(dataRoot,'data','original.workspace.json');
  const fixture=JSON.parse(await fs.readFile(path.join(root,'tools/e2e/demo.workspace.json'),'utf8'));
  await fs.writeFile(workspace,JSON.stringify({...fixture,name:`Self update ${kind}`,connections:[],slaves:[],templates:[],trendGroups:[]}));
  await fs.writeFile(path.join(dataRoot,'data','prefs.json'),JSON.stringify({lastWorkspacePath:workspace,timezone:'UTC',window:{width:1200,height:800}}));
  await fs.writeFile(path.join(dataRoot,'data','keep.txt'),'keep user data');
  const historyFile=path.join(dataRoot,'data','history.db');const database=new SQL.Database();database.run("CREATE TABLE update_sentinel(value TEXT); INSERT INTO update_sentinel VALUES ('history survives')");await fs.writeFile(historyFile,database.export());database.close();
  if(kind!=='portable')await fs.writeFile(path.join(install,'resources','user-file.txt'),'keep nested user file');
  const oldAsar=kind==='setup'?sha(await fs.readFile(path.join(install,'resources','app.asar'))):null;
  let browserPort=0;const inspectorPort=await freePort();
  const debugPort=async()=>Number((await fs.readFile(path.join(dataRoot,'cache','DevToolsActivePort'),'utf8')).split('\n')[0]);
  const child=spawn(executable,['--remote-debugging-port=0',`--inspect=${inspectorPort}`,`--data-dir=${dataRoot}`],{cwd:install,windowsHide:true,stdio:'ignore',env:{...process.env,MODBUS_DATA_DIR:'',MODBUS_E2E:'0',MODBUS_E2E_WORKSPACE:''}});
  let connection;let candidate;let initialEndpoint='';
  try {
    browserPort=await waitFor(()=>debugPort().catch(()=>0));initialEndpoint=await fs.readFile(path.join(dataRoot,'cache','DevToolsActivePort'),'utf8');connection=await attach(browserPort);
    assert.equal((await connection.page.evaluate(()=>window.modbus.versions())).app,pkg.version);
    const suffix=kind==='zip'?'.zip':kind==='portable'?'-Portable.exe':'-Setup.exe';
    const files=[path.join(futureRoot,'release',futureBase+suffix),path.join(futureRoot,'release',futureBase+'-manifest.json')];
    if(failure){
      // Controlled failing installer changes a program file and registration before exiting 23.
      // The running application, backup, helper, rollback and restarted application remain real.
      const badDir=path.join(runRoot,'fault-installer');await fs.mkdir(badDir);
      const code=String.raw`using System;using System.IO;using Microsoft.Win32;public class Installer{public static void Main(){string cmd=Environment.CommandLine;string root=cmd.Substring(cmd.IndexOf("/D=")+3).Trim('"');File.WriteAllText(Path.Combine(root,"resources","app.asar"),"partial failed installation");foreach(var view in new[]{RegistryView.Registry32,RegistryView.Registry64})using(var parent=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,view).OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall",true)){foreach(string name in parent.GetSubKeyNames()){using(var key=parent.OpenSubKey(name,true)){var uninstall=key.GetValue("UninstallString") as string;if(uninstall!=null&&uninstall.IndexOf(@"\out\test-temp\self-update-app-",StringComparison.OrdinalIgnoreCase)>=0){key.SetValue("DisplayVersion","broken");File.WriteAllText(Path.Combine(root,"data","fault-key.txt"),name);}}}}Environment.Exit(23);}}`;
      const source=path.join(badDir,'fault.cs');const compiler=path.join(badDir,'compile.ps1');files[0]=path.join(badDir,futureBase+'-Setup.exe');
      await fs.writeFile(source,code);await fs.writeFile(compiler,'param($SourcePath,$OutputPath)\n$ErrorActionPreference="Stop"\nAdd-Type -Path $SourcePath -OutputAssembly $OutputPath -OutputType ConsoleApplication\n');
      await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',compiler,'-SourcePath',source,'-OutputPath',files[0]]);
    }
    const assets=[];const sources={};
    for(const file of files){const bytes=await fs.readFile(file);const name=path.basename(file);const url=`https://github.com/loogg/modbus-debugger/releases/download/v${futureVersion}/${name}`;assets.push({name,state:'uploaded',size:bytes.length,digest:'sha256:'+sha(bytes),browser_download_url:url});sources[url]=file;}
    const metadata={tag_name:'v'+futureVersion,draft:false,prerelease:false,body:'自升级验收：自动安装和重启。',published_at:new Date().toISOString(),assets};
    await cdpEval(inspectorPort,`(()=>{const require=process.mainModule.require.bind(process.mainModule);const electron=require('electron');const fs=require('node:fs');const {Readable}=require('node:stream');const original=electron.net.fetch;const metadata=${JSON.stringify(metadata)};const sources=${JSON.stringify(sources)};electron.net.fetch=(url,init)=>{if(String(url)==='https://api.github.com/repos/loogg/modbus-debugger/releases/latest')return Promise.resolve(Response.json(metadata));if(sources[String(url)])return Promise.resolve(new Response(Readable.toWeb(fs.createReadStream(sources[String(url)])),{headers:{'content-length':String(fs.statSync(sources[String(url)]).size)}}));return original(url,init)};return true})()`);
    await click(connection.page,'关于');await click(connection.page,'检查更新');
    await connection.page.waitForFunction(()=>document.body.innerText.includes('下载 v'),{timeout:20000});await click(connection.page,`下载 v${futureVersion}`);
    await connection.page.waitForFunction(()=>document.body.innerText.includes('安装更新并重启'),{timeout:120000});
    await waitFor(async()=>(await connection.page.evaluate(()=>window.modbus.getSnapshot())).update.phase==='downloaded',120000);
    await click(connection.page,'安装更新并重启');
    assert(await connection.page.$('[role="alertdialog"]'));
    await fs.mkdir(path.join(root,'out/audit/self-update-shots'),{recursive:true});
    await connection.page.screenshot({path:path.join(root,`out/audit/self-update-shots/${kind}-confirm.png`)});
    await click(connection.page,'确认安装并重启');
    await waitFor(async()=>{
      if(child.exitCode!==null)return true;
      const update=await connection.page.evaluate(()=>window.modbus.getSnapshot()).then(s=>s.update).catch(()=>null);
      if(update?.phase==='error')throw new Error(`${kind}: ${update.error}`);
      return false;
    },180000);
    await connection.browser.disconnect();connection=null;
    const resultPath=path.join(dataRoot,'data','updates','last-install.json');
    const outcome=await waitFor(async()=>fs.readFile(resultPath,'utf8').then(JSON.parse).catch(()=>null),180000);
    assert.equal(outcome.phase,failure?'rolled-back':'success',JSON.stringify(outcome));
    browserPort=await waitFor(async()=>{const endpoint=await fs.readFile(path.join(dataRoot,'cache','DevToolsActivePort'),'utf8').catch(()=>'');return endpoint && endpoint!==initialEndpoint ? Number(endpoint.split('\n')[0]) : false;});candidate=await attach(browserPort);
    assert.equal((await candidate.page.evaluate(()=>window.modbus.versions())).app,failure?pkg.version:futureVersion);
    const state=await candidate.page.evaluate(()=>window.modbus.getSnapshot());assert.equal(state.workspace.name,`Self update ${kind}`);assert.equal(state.workspacePath,workspace);assert.equal(state.prefs.timezone,'UTC');
    if(failure){
      assert(outcome.message.includes('23'),'Did not exercise the failing installer');
      assert.equal(sha(await fs.readFile(path.join(install,'resources','app.asar'))),oldAsar);
      const key=(await fs.readFile(path.join(install,'data','fault-key.txt'),'utf8')).trim();assert(/^[a-f0-9-]+$/i.test(key));
      const registry=spawnSync('powershell.exe',['-NoProfile','-Command',`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}').DisplayVersion`],{encoding:'utf8',windowsHide:true});
      assert.equal(registry.stdout.trim(),pkg.version,'Setup registration was not restored');
    }
    assert.equal(await fs.readFile(path.join(dataRoot,'data','keep.txt'),'utf8'),'keep user data');
    if(kind!=='portable')assert.equal(await fs.readFile(path.join(install,'resources','user-file.txt'),'utf8'),'keep nested user file');
    assert(await exists(path.join(outcome.backupDirectory,kind==='portable'?'My Modbus Portable.exe':'modbus-debugger.exe')));
    await click(candidate.page,'关于');await candidate.page.screenshot({path:path.join(root,`out/audit/self-update-shots/${label}-updated.png`)});
    await candidate.browser.close();candidate=null;
    await delay(2000);
    const reopened=new SQL.Database(await fs.readFile(historyFile));assert.equal(reopened.exec('SELECT value FROM update_sentinel')[0].values[0][0],'history survives');reopened.close();
    await fs.writeFile(path.join(root,`out/audit/self-update-${label}-result.json`),JSON.stringify({outcome,currentVersion:pkg.version,observedVersion:state.update.currentVersion,workspacePreserved:true,historySentinelPreserved:true,unknownFilesPreserved:true},null,2));
    console.log(`[self-update] PASS ${label}: ${pkg.version} -> ${failure?pkg.version:futureVersion}, real download/verification/helper/install/restart, workspace and user data preserved`);
  } finally {
    if(connection)await connection.browser.close().catch(()=>{});
    if(candidate)await candidate.browser.close().catch(()=>{});
    if(child.exitCode===null && child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    try { if((await fetch(`http://127.0.0.1:${browserPort}/json/version`,{signal:AbortSignal.timeout(700)})).ok){const remaining=await puppeteer.connect({browserURL:`http://127.0.0.1:${browserPort}`});await remaining.close();} }catch{}
    await delay(1000);
  }
}
try {
  const existing=spawnSync('powershell.exe',['-NoProfile','-Command',"Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Modbus Debugger*' } | Select-Object -ExpandProperty UninstallString"],{encoding:'utf8',windowsHide:true});
  assert(!existing.error && !existing.stdout.trim(),'Existing user installation found; cannot run Setup update test');
  if(!await exists(path.join(futureRoot,'out',futureBase+'.zip'))) {
  await fs.cp(path.join(release,base),futureApp,{recursive:true});
  const unpacked=path.join(scratch,'asar-source');extractAll(path.join(futureApp,'resources/app.asar'),unpacked);
  const packageFile=path.join(unpacked,'package.json');const futurePkg=JSON.parse(await fs.readFile(packageFile,'utf8'));futurePkg.version=futureVersion;await fs.writeFile(packageFile,JSON.stringify(futurePkg));
  await createPackageWithOptions(unpacked,path.join(futureApp,'resources/app.asar'),{unpack:'**/*.node'});
  uncache(path.join(futureApp,'resources/app.asar'));
  await writeUpdateManifest(futureApp,futureVersion);
  await fs.cp(path.join(root,'build'),path.join(futureRoot,'build'),{recursive:true});
  const archive=path.join(futureRoot,'out',futureBase+'.zip');await new Promise((resolve,reject)=>zip(futureApp,archive,error=>error?reject(error):resolve()));
  }
  const electronVersion=JSON.parse(await fs.readFile(path.join(root,'node_modules/electron/package.json'),'utf8')).version;
  await fs.writeFile(path.join(futureRoot,'package.json'),JSON.stringify({...pkg,version:futureVersion,devDependencies:{...pkg.devDependencies,electron:electronVersion}}));
  if(!await exists(path.join(futureRoot,'release',futureBase+'-Setup.exe')))await assembleRelease(futureRoot,[{platform:'win32',arch:'x64',artifacts:[path.join(futureRoot,'out',futureBase+'.zip')],packageJSON:{...pkg,version:futureVersion}}]);
  for(const kind of kinds)await transition(kind);
  console.log('[self-update] PASS selected runtime forms:',kinds.join(', '));
  passed=true;
} finally {
  if(installedDir && await exists(path.join(installedDir,'Uninstall modbus-debugger.exe'))){await run(path.join(installedDir,'Uninstall modbus-debugger.exe'),['/S',`_?=${installedDir}`]);assert(await exists(path.join(installedDir,'resources','user-file.txt')),'Uninstaller removed an unknown nested file');}
  assertLegacyPreferencesUnchanged(legacy);
  // Preserve failed-run evidence; this directory is isolated beneath out/test-temp.
  if(passed && kinds.length===3) { try { removeScratch(scratch) } catch(error){console.error('Scratch retained:',scratch,String(error));} }
}
