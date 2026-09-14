export const testRoot: string;
export function setupTestEnvironment(): void;
export function createScratch(prefix: string): string;
export function removeScratch(directory: string): void;
export function cleanupScratch(): void;
export function snapshotLegacyPreferences(): Array<{ file: string; contents: string | null }>;
export function assertLegacyPreferencesUnchanged(snapshot: Array<{ file: string; contents: string | null }>): void;
