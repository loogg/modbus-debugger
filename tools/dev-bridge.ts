/* eslint-disable no-console */
import path from 'node:path';
import { RuntimeManager } from '../src/main/runtime/manager';
import { WorkspaceService } from '../src/main/services/workspace';
import { HistoryStore } from '../src/main/services/history';
import { UpdateService } from '../src/main/services/updater';
import { AppBackendService } from '../src/main/services/backend-service';
import packageJson from '../package.json';
import { DevBridgeServer } from '../src/main/services/dev-bridge';
import { loadReviewWorkspace, prepareReviewStorage } from './dev-review-storage';

async function main() {
  const {storage,workspaceSource}=prepareReviewStorage(process.argv.slice(2),process.env,path.resolve(__dirname,'..'));
  process.env.TEMP=storage.temp;
  process.env.TMP=storage.temp;
  process.env.TMPDIR=storage.temp;
  const workspace=new WorkspaceService(storage.data);
  loadReviewWorkspace(workspace,storage,workspaceSource);
  const history=await HistoryStore.open(workspace.getPrefs().historyDbPath ?? path.join(storage.data,'history.db'));
  const manager=new RuntimeManager(workspace,history);
  const updater=new UpdateService({
    currentVersion:packageJson.version,packageKind:'zip',platform:process.platform,arch:process.arch,
    dataDirectory:storage.data,tempDirectory:storage.temp,
    fetch:(async (url:string|URL,init?:RequestInit)=>fetch(url,init)) as unknown as typeof import('electron').net.fetch,
    reveal:()=>{},openExternal:async()=>{},canInstall:false,bootPending:false,installMessage:null,confirmBoot:async()=>null,install:async()=>{},
  });
  const backend=new AppBackendService(manager,updater);
  const server=new DevBridgeServer(backend,{port:Number(process.env.MODBUS_DEV_BRIDGE_PORT ?? 5174),fileRoots:[storage.root]});
  try {
    const port=await server.start();
    const sessionFile=path.join(storage.temp,'dev-bridge-session.json');
    server.writeSessionFile(sessionFile);
    manager.start();
    console.log(`[DevBridge] ws://127.0.0.1:${port}; isolated root: ${storage.root}; session: ${sessionFile}`);
  } catch(error) { await server.close();await manager.stop();await updater.dispose();throw error; }
  const cleanup=async()=>{await server.close();await manager.stop();await updater.dispose();process.exit(0);};
  process.on('SIGINT',()=>void cleanup());
  process.on('SIGTERM',()=>void cleanup());
}
main().catch(error=>{console.error('[DevBridge] Fatal error:',error);process.exit(1);});
