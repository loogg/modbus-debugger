import path from 'node:path';

/** Portable's actual Electron executable is temporary; persistent files belong beside its launcher. */
export function executionDirectory(packaged: boolean, executable: string, cwd: string, portableDirectory?: string): string {
  if (!packaged) return cwd;
  return portableDirectory && path.isAbsolute(portableDirectory)
    ? path.normalize(portableDirectory)
    : path.dirname(executable);
}
