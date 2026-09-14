import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { ForgeMakeResult } from '@electron-forge/shared-types';
import { isOldReleaseArtifact, makerArtifacts, releaseBase } from '../../tools/release';
import { executionDirectory } from '../../src/main/services/execution-directory';

describe('release inputs', () => {
  it('retires only older generated release artifacts and preserves the current version and user files', () => {
    for (const suffix of ['', '.zip', '-Portable.exe', '-Setup.exe']) {
      expect(isOldReleaseArtifact(`modbus-debugger-0.5.0-win-x64${suffix}`, '0.7.1')).toBe(true);
      expect(isOldReleaseArtifact(`modbus-debugger-0.7.1-win-x64${suffix}`, '0.7.1')).toBe(false);
      expect(isOldReleaseArtifact(`modbus-debugger-0.7.1-win-arm64${suffix}`, '0.7.1')).toBe(false);
    }
    for (const name of ['logs', 'data', 'notes.zip', 'project.workspace.json', 'modbus-debugger-0.5.0-win-x64.zip.backup', '../modbus-debugger-0.5.0-win-x64']) {
      expect(isOldReleaseArtifact(name, '0.7.1')).toBe(false);
    }
    expect(isOldReleaseArtifact('modbus-debugger-0.7.1-beta.1-win-x64.zip', '0.7.1')).toBe(true);
  });
  it('uses version and target architecture and rejects escaping paths', () => {
    expect(releaseBase('0.5.0', 'x64')).toBe('modbus-debugger-0.5.0-win-x64');
    expect(releaseBase('1.0.0-beta.1', 'arm64')).toBe('modbus-debugger-1.0.0-beta.1-win-arm64');
    expect(() => releaseBase('../../other', 'x64')).toThrow();
    expect(() => releaseBase('0.5.0', '../other')).toThrow();
  });
  it('requires the current Windows ZIP maker output for the selected architecture', () => {
    const results: ForgeMakeResult[] = [
      { platform: 'win32', arch: 'x64', packageJSON: {}, artifacts: ['current.zip', 'current-Setup.exe'] },
      { platform: 'win32', arch: 'arm64', packageJSON: {}, artifacts: ['arm.zip', 'arm-Setup.exe'] },
    ];
    expect(makerArtifacts(results, 'x64')).toEqual({ zip: 'current.zip' });
    expect(() => makerArtifacts(results, 'ia32')).toThrow();
    expect(() => makerArtifacts([{ ...results[0]!, artifacts: ['current-Setup.exe'] }], 'x64')).toThrow();
    expect(() => makerArtifacts([...results, results[0]!], 'x64')).toThrow();
  });
});

describe('Portable persistence directory', () => {
  const outer = path.resolve('portable location');
  const inner = path.resolve('temp', 'unpacked', 'modbus-debugger.exe');
  it('keeps data beside the launcher rather than in the temporary executable directory', () => {
    expect(executionDirectory(true, inner, process.cwd(), outer)).toBe(outer);
  });
  it('preserves normal packaged and development behavior; ignores invalid relative portable paths', () => {
    expect(executionDirectory(true, inner, process.cwd())).toBe(path.dirname(inner));
    expect(executionDirectory(true, inner, process.cwd(), '../relative')).toBe(path.dirname(inner));
    expect(executionDirectory(false, inner, process.cwd(), outer)).toBe(process.cwd());
  });
});
