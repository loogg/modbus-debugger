import fs from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
import {createScratch} from '../../tools/test-paths.mjs';
import {prepareReviewStorage,loadReviewWorkspace} from '../../tools/dev-review-storage';
import {WorkspaceService} from '../../src/main/services/workspace';

it('defaults to a new isolated root with an empty workspace and no repository or COM fixture',()=>{
  const project=createScratch('review-project-');
  const {storage}=prepareReviewStorage([],{},project);
  expect(storage.root.startsWith(path.join(project,'out','test-temp','review-'))).toBe(true);
  const workspace=new WorkspaceService(storage.data);loadReviewWorkspace(workspace,storage);
  expect(workspace.current.connections).toEqual([]);expect(workspace.currentPath?.startsWith(storage.workspaces+path.sep)).toBe(true);
});
it('honors CLI over environment and rejects relative, missing or unusable paths',()=>{
  const project=createScratch('review-options-'),cli=path.join(project,'cli'),env=path.join(project,'env');
  expect(prepareReviewStorage(['--data-dir',cli],{MODBUS_DATA_DIR:env},project).storage.root).toBe(cli);
  expect(prepareReviewStorage([],{MODBUS_DATA_DIR:env},project).storage.root).toBe(env);
  expect(()=>prepareReviewStorage(['--data-dir=relative'],{},project)).toThrow('绝对路径');
  expect(()=>prepareReviewStorage(['--data-dir'],{},project)).toThrow('需要路径');
  const blocked=path.join(project,'blocked');fs.writeFileSync(blocked,'file');
  expect(()=>prepareReviewStorage(['--data-dir',blocked],{},project)).toThrow();
});
it('copies an explicit workspace and only autosaves the isolated copy',()=>{
  const project=createScratch('review-copy-'),source=path.join(project,'source.workspace.json');
  const original=fs.readFileSync(path.resolve('docs/examples/demo.workspace.json'),'utf8');fs.writeFileSync(source,original);
  const {storage,workspaceSource}=prepareReviewStorage(['--data-dir',path.join(project,'review'),'--workspace',source],{},project);
  const workspace=new WorkspaceService(storage.data);loadReviewWorkspace(workspace,storage,workspaceSource);
  expect(workspace.currentPath?.startsWith(storage.workspaces+path.sep)).toBe(true);expect(workspace.currentPath).not.toBe(source);
  workspace.set({...workspace.current,name:'Edited in review'});workspace.flushAutosave();
  expect(JSON.parse(fs.readFileSync(workspace.currentPath!,'utf8')).name).toBe('Edited in review');expect(fs.readFileSync(source,'utf8')).toBe(original);
});
it('refuses a daily root and ignores external remembered workspace paths',()=>{
  const project=createScratch('review-daily-'),daily=path.join(project,'daily');fs.mkdirSync(path.join(daily,'data'),{recursive:true});
  const sentinel=JSON.stringify({lastWorkspacePath:'do-not-open'});fs.writeFileSync(path.join(daily,'data','prefs.json'),sentinel);
  expect(()=>prepareReviewStorage(['--data-dir',daily],{},project)).toThrow('独立数据目录');
  expect(fs.readFileSync(path.join(daily,'data','prefs.json'),'utf8')).toBe(sentinel);
  const {storage}=prepareReviewStorage(['--data-dir',path.join(project,'review')],{},project);
  fs.writeFileSync(path.join(storage.data,'prefs.json'),JSON.stringify({lastWorkspacePath:path.resolve('tools/e2e/demo.workspace.json')}));
  const workspace=new WorkspaceService(storage.data);loadReviewWorkspace(workspace,storage);
  expect(workspace.current.connections).toEqual([]);expect(workspace.currentPath?.startsWith(storage.workspaces+path.sep)).toBe(true);
});
