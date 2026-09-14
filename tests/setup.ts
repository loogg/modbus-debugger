// Vitest global setup: keep console noise minimal and provide DOM matchers for UI tests.
import '@testing-library/jest-dom/vitest';
import { afterAll } from 'vitest';
import { cleanupScratch, setupTestEnvironment } from '../tools/test-paths.mjs';

setupTestEnvironment();
afterAll(cleanupScratch);
