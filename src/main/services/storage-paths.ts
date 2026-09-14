import fs from 'node:fs';
import path from 'node:path';

export function storagePaths(executionDir: string, override?: string) {
  if (override && !path.isAbsolute(override)) throw new Error('数据目录必须是绝对路径');
  const root = path.resolve(override || executionDir);
  return {
    root,
    data: path.join(root, 'data'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    temp: path.join(root, 'temp'),
    crashes: path.join(root, 'temp', 'crashes'),
    workspaces: path.join(root, 'data', 'workspaces'),
  };
}

export function prepareStorage(executionDir: string, override?: string): ReturnType<typeof storagePaths> {
  const paths = storagePaths(executionDir, override);
  for (const directory of [paths.data, paths.cache, paths.logs, paths.temp, paths.crashes, paths.workspaces]) {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-check-${process.pid}`);
    const fd = fs.openSync(probe, 'wx');
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  }
  return paths;
}
