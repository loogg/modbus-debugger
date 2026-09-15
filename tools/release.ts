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
  const match = /^modbus-debugger-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-win-(?:x64|arm64|ia32)(?:\.zip|-Portable\.exe|-Setup\.exe|-manifest\.json)?$/.exec(name);
  return Boolean(match && match[1] !== currentVersion);
}

/** Only use this invocation's maker results, never scan out/ for possibly stale installers. */
export function makerArtifacts(results: ForgeMakeResult[], arch: string): { zip: string } {
  const artifacts = results.filter(r => r.platform === 'win32' && r.arch === arch).flatMap(r => r.artifacts);
  const one = (suffix: string): string => {
    const matches = artifacts.filter(p => p.toLowerCase().endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} for ${arch}, found ${matches.length}`);
    return matches[0] as string;
  };
  return { zip: one('.zip') };
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
      const builderResources = path.join(staging, 'resources');
      await fs.mkdir(builderResources);
      await fs.copyFile(path.join(root, 'build', 'icon.ico'), path.join(builderResources, 'icon.ico'));
      await fs.copyFile(path.join(root, 'build', 'installer.nsh'), path.join(builderResources, 'installer.nsh'));
      const escapeNsis = (value: string) => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
      const entries = await fs.readdir(packaged, { withFileTypes: true });
      const manifest = JSON.parse(await fs.readFile(path.join(packaged, 'resources', 'app-files.json'), 'utf8')) as { files: Array<{ path: string }> };
      const shippedFiles = [...manifest.files.map(file => file.path), 'resources/app-files.json'];
      const shippedDirs = new Set<string>();
      for (const file of shippedFiles) { let parent = path.posix.dirname(file); while (parent !== '.') { shippedDirs.add(parent); parent = path.posix.dirname(parent); } }
      const removal = [...shippedFiles.map(file => `Delete "$INSTDIR\\${escapeNsis(file.replaceAll('/', '\\'))}"`),
        ...[...shippedDirs].sort((a,b) => b.length-a.length).map(dir => `RMDir "$INSTDIR\\${escapeNsis(dir.replaceAll('/', '\\'))}"`)];
      // Stock NSIS's APP_BUILD_DIR branch installs directly and skips the AppData updater cache.
      await fs.writeFile(path.join(builderResources, 'app-files.nsh'), `!define APP_BUILD_DIR "${escapeNsis(packaged)}"\n!macro removePackagedFiles\n${removal.join('\n')}\n!macroend\n`);
      const launcher = (await fs.readFile(path.join(root, 'build', 'portable-launcher.nsi'), 'utf8')).replace('@@APP_DIRECTORY@@', escapeNsis(packaged));
      const launcherPath = path.join(staging, 'portable.nsi');
      await fs.writeFile(launcherPath, launcher);
      const buildOptions = {
        projectDir: root,
        prepackaged: packaged,
        targets: Platform.WINDOWS.createTarget('nsis', Arch[arch as 'x64' | 'arm64' | 'ia32']),
        publish: 'never' as const,
      };
      const sharedConfig = {
        appId: 'com.modbus-debugger.desktop', productName: pkg.productName,
        directories: { output: path.join(staging, 'builder'), buildResources: builderResources },
        npmRebuild: false,
        win: { executableName: 'modbus-debugger', icon: path.join(root, 'build', 'icon.ico'), signAndEditExecutable: false },
      };
      await build({
        ...buildOptions,
        config: {
          ...sharedConfig,
          nsis: { artifactName: `${base}-Setup.exe`, oneClick: false, allowToChangeInstallationDirectory: true,
            allowElevation: false, perMachine: false, runAfterFinish: false, deleteAppDataOnUninstall: false, useZip: true, differentialPackage: false, packElevateHelper: false },
        },
      });
      await build({ ...buildOptions, config: { ...sharedConfig, nsis: {
        artifactName: `${base}-Portable.exe`, script: launcherPath, useZip: true, packElevateHelper: false,
      } } });
      await fs.cp(packaged, path.join(staging, base), { recursive: true });
      await fs.copyFile(artifacts.zip, path.join(staging, `${base}.zip`));
      await fs.copyFile(path.join(staging, 'builder', `${base}-Setup.exe`), path.join(staging, `${base}-Setup.exe`));
      await fs.copyFile(path.join(staging, 'builder', `${base}-Portable.exe`), path.join(staging, `${base}-Portable.exe`));
      await fs.copyFile(path.join(packaged, 'resources', 'app-files.json'), path.join(staging, `${base}-manifest.json`));
      const names = [base, `${base}.zip`, `${base}-Portable.exe`, `${base}-Setup.exe`, `${base}-manifest.json`];
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
        // Preserve runtime/user files before removing an older generated program directory.
        // These backups are outside versioned artifact directories and survive future make runs.
        const shippedNames = new Set(entries.map(entry => entry.name));
        for (const name of saved) {
          const previous = path.join(backup, name);
          if (!(await fs.lstat(previous)).isDirectory()) continue;
          for (const entry of await fs.readdir(previous)) {
            if (shippedNames.has(entry)) continue;
            const destination = path.join(release, 'data', 'backups', `${name}-${Date.now()}`, entry);
            await fs.cp(path.join(previous, entry), destination, { recursive: true });
          }
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
