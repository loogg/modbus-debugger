import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeMakeResult } from '@electron-forge/shared-types';
import { extractFile } from '@electron/asar';

export function releaseBase(version: string, arch: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!['x64', 'arm64', 'ia32'].includes(arch)) throw new Error(`Unsupported Windows architecture: ${arch}`);
  return `modbus-debugger-${version}-win-${arch}`;
}

/** Recognize only our four generated formats, never user files such as logs or workspaces. */
export function isOldReleaseArtifact(name: string, currentVersion: string): boolean {
  const match = /^modbus-debugger-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-win-(?:x64|arm64|ia32)(?:\.zip|-Portable\.exe|-Setup\.exe)?$/.exec(name);
  return Boolean(match && match[1] !== currentVersion);
}

/** Only use this invocation's maker results, never scan out/ for possibly stale installers. */
export function makerArtifacts(results: ForgeMakeResult[], arch: string): { zip: string; setup: string } {
  const artifacts = results.filter(r => r.platform === 'win32' && r.arch === arch).flatMap(r => r.artifacts);
  const one = (suffix: string): string => {
    const matches = artifacts.filter(p => p.toLowerCase().endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} for ${arch}, found ${matches.length}`);
    return matches[0] as string;
  };
  return { zip: one('.zip'), setup: one('setup.exe') };
}

export async function assembleRelease(root: string, results: ForgeMakeResult[]): Promise<void> {
  const windows = results.filter(r => r.platform === 'win32');
  if (!windows.length) return;
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string; productName: string };
  const { build, Platform, Arch } = await import('electron-builder');
  const output = path.resolve(root, 'out');
  const release = path.resolve(root, 'release');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(release, { recursive: true });

  for (const arch of new Set(windows.map(r => r.arch))) {
    const base = releaseBase(pkg.version, arch);
    const artifacts = makerArtifacts(results, arch);
    const packaged = path.join(output, `${pkg.productName}-win32-${arch}`);
    const packedMetadata = JSON.parse(extractFile(path.join(packaged, 'resources', 'app.asar'), 'package.json').toString()) as { version: string };
    if (packedMetadata.version !== pkg.version || windows.some(r => r.arch === arch && r.packageJSON.version !== pkg.version)) {
      throw new Error('Packaged application version differs from package.json; run a fresh npm run make.');
    }
    await fs.access(path.join(packaged, 'modbus-debugger.exe'));
    const staging = await fs.mkdtemp(path.join(output, 'release-stage-'));
    if (path.dirname(path.resolve(staging)) !== output) throw new Error('Unsafe staging cleanup path');
    let keepStaging = false;
    try {
      await build({
        projectDir: root,
        prepackaged: packaged,
        targets: Platform.WINDOWS.createTarget('portable', Arch[arch as 'x64' | 'arm64' | 'ia32']),
        publish: 'never',
        config: {
          appId: 'com.modbus-debugger.desktop',
          productName: pkg.productName,
          directories: { output: path.join(staging, 'builder'), buildResources: path.join(root, 'build') },
          npmRebuild: false,
          win: { executableName: 'modbus-debugger', icon: path.join(root, 'build', 'icon.ico'), signAndEditExecutable: false },
          portable: { artifactName: `${base}-Portable.exe`, requestExecutionLevel: 'user', unpackDirName: false, useZip: true },
        },
      });
      await fs.cp(packaged, path.join(staging, base), { recursive: true });
      await fs.copyFile(artifacts.zip, path.join(staging, `${base}.zip`));
      await fs.copyFile(artifacts.setup, path.join(staging, `${base}-Setup.exe`));
      await fs.copyFile(path.join(staging, 'builder', `${base}-Portable.exe`), path.join(staging, `${base}-Portable.exe`));
      const names = [base, `${base}.zip`, `${base}-Portable.exe`, `${base}-Setup.exe`];
      for (const name of names.slice(1)) {
        if ((await fs.stat(path.join(staging, name))).size === 0) throw new Error(`Empty release artifact: ${name}`);
      }
      // Keep old outputs until all four replacements are ready. Roll back a failed promotion.
      const backup = path.join(staging, 'previous');
      await fs.mkdir(backup);
      const saved: string[] = [];
      const promoted: string[] = [];
      try {
        for (const name of names) {
          const destination = path.resolve(release, name);
          if (path.dirname(destination) !== release) throw new Error('Release path escapes release/');
          try {
            await fs.rename(destination, path.join(backup, name));
            saved.push(name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await fs.rename(path.join(staging, name), destination);
          promoted.push(name);
        }
        // Retire older generated versions only after the new four outputs are in place.
        // Moving them into the same backup keeps rollback possible if promotion fails.
        for (const name of await fs.readdir(release)) {
          if (!isOldReleaseArtifact(name, pkg.version)) continue;
          const source = path.resolve(release, name);
          if (path.dirname(source) !== release) throw new Error('Cleanup path escapes release/');
          await fs.rename(source, path.join(backup, name));
          saved.push(name);
        }
      } catch (error) {
        // If restoring itself fails (for example a file becomes locked), preserve the backup for recovery.
        keepStaging = true;
        for (const name of promoted.reverse()) await fs.rename(path.join(release, name), path.join(staging, name));
        for (const name of saved) await fs.rename(path.join(backup, name), path.join(release, name));
        keepStaging = false;
        throw error;
      }
    } finally {
      if (!keepStaging) await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
