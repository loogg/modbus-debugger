import { describe, expect, it } from 'vitest';
import {
  dayKey,
  fmtDateTime,
  fmtDuration,
  fmtDurationMs,
  fmtEpoch,
  fmtEpochDateTime,
  fmtTime,
  fmtTimeMs,
  getDisplayTimeZone,
  setDisplayTimeZone,
  todayKey,
} from '../../src/renderer/time';

const ISO = '2026-09-11T06:52:23.456Z';

describe('display timezone formatting', () => {
  it('renders the same instant differently per configured zone', () => {
    setDisplayTimeZone('UTC');
    expect(fmtDateTime(ISO)).toBe('2026-09-11 06:52:23');
    expect(fmtTime(ISO)).toBe('06:52:23');
    expect(fmtTimeMs(ISO)).toBe('06:52:23.456');
    setDisplayTimeZone('Asia/Shanghai');
    expect(fmtDateTime(ISO)).toBe('2026-09-11 14:52:23');
    expect(fmtTime(ISO)).toBe('14:52:23');
    setDisplayTimeZone('America/New_York');
    expect(fmtDateTime(ISO)).toBe('2026-09-11 02:52:23');
  });

  it('day keys follow the configured zone (the 8h sidebar/header mismatch class of bug)', () => {
    setDisplayTimeZone('Asia/Shanghai');
    expect(dayKey(ISO)).toBe('2026-09-11');
    setDisplayTimeZone('Pacific/Honolulu');
    expect(dayKey(ISO)).toBe('2026-09-10');
    setDisplayTimeZone('UTC');
    expect(dayKey(ISO)).toBe('2026-09-11');
  });

  it('epoch-ms formatters (chart axis/tooltip) honour the zone', () => {
    const ms = Date.parse(ISO);
    setDisplayTimeZone('Asia/Shanghai');
    expect(fmtEpoch(ms)).toBe('14:52:23');
    expect(fmtEpochDateTime(ms)).toBe('2026-09-11 14:52:23');
    setDisplayTimeZone('UTC');
    expect(fmtEpoch(ms)).toBe('06:52:23');
  });

  it("'local' and invalid tags fall back to the OS zone", () => {
    setDisplayTimeZone('local');
    expect(getDisplayTimeZone()).toBeUndefined();
    setDisplayTimeZone('Not/AZone');
    expect(getDisplayTimeZone()).toBeUndefined();
    setDisplayTimeZone(null);
    expect(getDisplayTimeZone()).toBeUndefined();
  });

  it('todayKey is consistent with dayKey of "now"', () => {
    setDisplayTimeZone('Asia/Shanghai');
    expect(todayKey(0)).toBe(dayKey(new Date().toISOString()));
    expect(todayKey(1)).toBe(dayKey(new Date(Date.now() - 86400000).toISOString()));
  });

  it('null-ish inputs render an em dash', () => {
    setDisplayTimeZone('UTC');
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtTime(undefined)).toBe('—');
    expect(fmtTimeMs(null)).toBe('—');
  });
});

describe('duration formatting (session-relative replay axes)', () => {
  it('formats ms offsets as HH:mm:ss and HH:mm:ss.mmm', () => {
    expect(fmtDuration(0)).toBe('00:00:00');
    expect(fmtDuration(1000)).toBe('00:00:01');
    expect(fmtDuration(61000)).toBe('00:01:01');
    expect(fmtDuration(3661000)).toBe('01:01:01');
    expect(fmtDurationMs(0)).toBe('00:00:00.000');
    expect(fmtDurationMs(1500)).toBe('00:00:01.500');
  });

  it('is timezone-independent because a duration has no zone', () => {
    setDisplayTimeZone('UTC');
    const a = fmtDuration(75000);
    setDisplayTimeZone('Asia/Shanghai');
    expect(fmtDuration(75000)).toBe(a);
    expect(a).toBe('00:01:15');
  });
});
