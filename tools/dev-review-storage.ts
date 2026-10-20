import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareStorage } from '../src/main/services/storage-paths';
import { WorkspaceService } from '../src/main/services/workspace';
import { isReviewPathAllowed } from '../src/main/services/dev-bridge-access';

export function prepareReviewStorage(args: string[], env: NodeJS.ProcessEnv, projectRoot: string) {
  let dataDirectory: string | undefined;
  let workspaceSource: string | undefined;
  for (let index=0;index<args.length;index++) {
    const argument=args[index]!;
    if (argument==='--') continue;
    const flag=argument.split('=')[0];
    if (flag!=='--data-dir' && flag!=='--workspace') throw new Error(`未知审查参数：${flag}`);
    const value=argument.includes('=') ? argument.slice(argument.indexOf('=')+1) : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要路径`);
    if (flag==='--data-dir') dataDirectory=value;
    else workspaceSource=path.resolve(projectRoot,value);
  }
  let selected=dataDirectory ?? env.MODBUS_DATA_DIR;
  if (!selected) {
    const testRoot=path.join(projectRoot,'out','test-temp');
    fs.mkdirSync(testRoot,{recursive:true});
    selected=fs.mkdtempSync(path.join(testRoot,'review-'));
  }
  if (!path.isAbsolute(selected)) throw new Error('数据目录必须是绝对路径');
  const root=path.resolve(selected);
  const marker=path.join(root,'data','.dev-review-root');
  if (!fs.existsSync(marker) && ['prefs.json','history.db'].some(file=>fs.existsSync(path.join(root,'data',file)))) {
    throw new Error('此目录已有程序数据，请为审查选择独立数据目录');
  }
  const storage=prepareStorage(projectRoot,root);
  fs.writeFileSync(marker,'Modbus Debugger isolated development review\n');
  return {storage,workspaceSource};
}

export function loadReviewWorkspace(workspace: WorkspaceService, storage: ReturnType<typeof prepareStorage>, source?: string): void {
  // A prefs file in a review root must not redirect the history store or autosave outside it.
  const history=workspace.getPrefs().historyDbPath;
  if (history && !isReviewPathAllowed(history,[storage.root])) throw new Error('审查历史库必须位于审查数据目录内');
  if (source) {
    const text=fs.readFileSync(source,'utf8');
    const imported=workspace.importFromBuffer(text);
    if (!imported.ok || !imported.workspace) throw new Error(imported.error ?? '工作区无效');
    const copy=path.join(storage.workspaces,`review-${randomUUID()}.workspace.json`);
    fs.writeFileSync(copy,JSON.stringify(imported.workspace,null,2),'utf8');
    const loaded=workspace.loadFrom(copy);
    if (!loaded.ok) throw new Error(loaded.error);
  } else {
    const previous=workspace.getPrefs().lastWorkspacePath;
    if (previous && isReviewPathAllowed(previous,[storage.root])) {
      const loaded=workspace.loadFrom(previous);
      if (!loaded.ok) throw new Error(loaded.error);
    }
    // Otherwise stay empty: no implicit daily workspace, repository fixture or COM probing.
  }
  if (!workspace.currentPath) {
    const saved=workspace.saveManaged();
    if (!saved.ok) throw new Error(saved.error ?? '无法创建审查工作区');
  }
}
