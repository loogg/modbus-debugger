import fs from 'node:fs';
import path from 'node:path';
import { commandSchema, type Command } from '../../shared/commands';
import type { RuntimeManager } from '../runtime/manager';

const ALLOWED_COMMANDS = new Set<Command['type']>([
  'data.read','data.demand','buffer.configure','buffer.export',
  'canvas.create','canvas.edit','canvas.delete','canvas.interact','variable.save','variable.delete','workbench.saveLayout',
  'script.save','script.delete','script.plan','script.start','script.pause','script.resume','script.breakpoint','script.stop','script.confirmWrite','script.exportFile',
  'workspace.new','workspace.open','workspace.save','workspace.saveAs','workspace.export','workspace.exportFile','workspace.importText',
  'connection.upsert','connection.connect','connection.disconnect','slave.upsert',
  'slave.setValues','slave.saveInitialValues',
  'template.add','template.copy','template.rename','template.deleteBlock','template.deletePoint','template.importFile','template.save',
  'template.upsertBlock','template.patchBlock','template.importContent','template.upsertPoint',
  'point.write','device.scan','device.stopScan','device.refresh','device.temporaryRead',
  'trend.upsertGroup','trend.deleteGroup','trend.addSignals','trend.removeSignal','trend.setSignalVisible','trend.setWindow',
  'history.sessions','history.session','history.sessionData','history.addNote',
  'prefs.set','diagnostics.clear','diagnostics.read','diagnostics.healthSeries','import.parse','serial.list','update.status','update.check','update.download','update.cancel',
]);

/** Resolve existing ancestors too: a junction must not turn an allowed output into an outside write. */
function resolvedFile(file: string): string {
  let existing = path.resolve(file);
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('文件路径没有可访问的父目录');
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...missing);
}

export function isReviewPathAllowed(file: string, roots: readonly string[]): boolean {
  if (!path.isAbsolute(file)) return false;
  try {
    const resolved = resolvedFile(file);
    return roots.some(root => {
      const relative = path.relative(resolvedFile(root), resolved);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
  } catch { return false; }
}

export function validateBridgeCommand(raw: unknown, roots: readonly string[], manager: RuntimeManager): Command {
  const command = commandSchema.parse(raw);
  if (!ALLOWED_COMMANDS.has(command.type)) throw new Error('此命令不可通过开发 Bridge 执行，请使用桌面入口');
  let file: string | null | undefined;
  if (command.type === 'workspace.open') file = command.path ?? manager.workspaceService.getPrefs().lastWorkspacePath;
  else if (command.type === 'workspace.saveAs' || command.type === 'workspace.exportFile' || command.type === 'template.importFile' || command.type === 'buffer.export' || command.type === 'script.exportFile') file = command.path;
  else if (command.type === 'import.parse' && command.source.kind === 'file') file = command.source.path;
  else if (command.type === 'prefs.set') file = command.patch.historyDbPath;
  else if (command.type === 'workspace.save' || command.type === 'template.save' || command.type === 'slave.saveInitialValues' || ['canvas.create','canvas.edit','canvas.delete','variable.save','variable.delete'].includes(command.type) || command.type === 'script.save' || command.type === 'script.delete' || command.type === 'workbench.saveLayout' || command.type === 'buffer.configure') file = manager.workspaceService.currentPath;
  if (file && !isReviewPathAllowed(file, roots)) throw new Error('文件必须位于当前审查数据目录内');
  return command;
}
