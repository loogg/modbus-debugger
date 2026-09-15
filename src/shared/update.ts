export type UpdatePackageKind = 'zip' | 'portable' | 'setup';
export interface UpdateAsset { name: string; url: string; size: number; sha256: string }
export interface UpdateRelease { version: string; url: string; notes: string; publishedAt: string | null; asset: UpdateAsset | null; manifest?: UpdateAsset | null }
export interface UpdateState {
  currentVersion: string;
  packageKind: UpdatePackageKind;
  platform: string;
  arch: string;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'downloaded' | 'preparing' | 'installing' | 'error';
  canInstall?: boolean;
  bootPending?: boolean;
  installMessage?: string | null;
  latest: UpdateRelease | null;
  available: boolean;
  checkedAt: string | null;
  receivedBytes: number;
  totalBytes: number;
  downloadPath: string | null;
  error: string | null;
}
export const UPDATE_REPOSITORY = 'https://github.com/loogg/modbus-debugger';
export const UPDATE_RELEASES = `${UPDATE_REPOSITORY}/releases`;
