import { describe, expect, it } from 'vitest';
import { commandSchema } from '../../src/shared/commands';
import { scanOptionsSchema } from '../../src/shared/scan-options';

describe('scan probe validation', () => {
  it('keeps older scan commands valid and defaults to read-only FC03/address zero', () => {
    expect(commandSchema.safeParse({ type: 'device.scan', connectionId: 'c1', from: 1, to: 247 }).success).toBe(true);
    expect(scanOptionsSchema.parse({})).toEqual({ fc: 3, start: 0, timeoutMs: 150 });
  });
  it.each([
    { fc: 5 }, { fc: 6 }, { fc: 15 }, { fc: 16 },
    { start: -1 }, { start: 65536 }, { start: 1.5 },
    { timeoutMs: 0 }, { timeoutMs: 10001 }, { timeoutMs: NaN },
    { retries: -1 }, { retries: 6 }, { retries: 0.5 }, { quantity: 2 },
  ])('rejects unsafe or invalid IPC probe parameters %j', options => {
    expect(commandSchema.safeParse({ type: 'device.scan', connectionId: 'c1', from: 1, to: 247, options }).success).toBe(false);
  });
});
