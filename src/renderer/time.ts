/**
 * Display-time formatting.
 *
 * Every timestamp in this app is stored as UTC (ISO-8601). All rendering must go through
 * this module so the sidebar, page headers, message tables and chart axes agree on ONE
 * timezone, which the user can override in 设置 → 显示 (default: follow the OS).
 * Mixing raw UTC slices with Date#toTimeString() (OS local) is exactly the bug this prevents.
 */
let displayTimeZone: string | undefined;

export function setDisplayTimeZone(pref: string | null | undefined): void {
  if (!pref || pref === 'local') {
    displayTimeZone = undefined;
    return;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: pref });
    displayTimeZone = pref;
  } catch {
    displayTimeZone = undefined;
  }
}

export function getDisplayTimeZone(): string | undefined {
  return displayTimeZone;
}

export const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'local', label: '跟随系统' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai（UTC+8）' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo（UTC+9）' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore（UTC+8）' },
  { value: 'Asia/Seoul', label: 'Asia/Seoul（UTC+9）' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin（UTC+1/+2）' },
  { value: 'Europe/London', label: 'Europe/London（UTC+0/+1）' },
  { value: 'Europe/Moscow', label: 'Europe/Moscow（UTC+3）' },
  { value: 'America/New_York', label: 'America/New_York（UTC-5/-4）' },
  { value: 'America/Chicago', label: 'America/Chicago（UTC-6/-5）' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles（UTC-8/-7）' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney（UTC+10/+11）' },
];

interface Parts {
  y: string;
  mo: string;
  d: string;
  h: string;
  mi: string;
  s: string;
  ms: string;
}

function parts(input: Date): Parts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: displayTimeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(input)) map[p.type] = p.value;
  return {
    y: map.year ?? '0000',
    mo: map.month ?? '01',
    d: map.day ?? '01',
    h: map.hour ?? '00',
    mi: map.minute ?? '00',
    s: map.second ?? '00',
    ms: map.fractionalSecond ?? '000',
  };
}

/** 'YYYY-MM-DD HH:mm:ss' in the display timezone. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parts(new Date(iso));
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
}

/** 'HH:mm:ss' in the display timezone. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parts(new Date(iso));
  return `${p.h}:${p.mi}:${p.s}`;
}

/** 'HH:mm:ss.mmm' in the display timezone (message tables). */
export function fmtTimeMs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parts(new Date(iso));
  return `${p.h}:${p.mi}:${p.s}.${p.ms}`;
}

/** 'HH:mm:ss' for epoch-ms values (chart axes). */
export function fmtEpoch(ms: number): string {
  const p = parts(new Date(ms));
  return `${p.h}:${p.mi}:${p.s}`;
}

/** 'YYYY-MM-DD HH:mm:ss' for epoch-ms values (chart tooltips). */
export function fmtEpochDateTime(ms: number): string {
  const p = parts(new Date(ms));
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
}

/** 'YYYY-MM-DD' in the display timezone; used for 今天/昨天 grouping. */
export function dayKey(iso: string): string {
  const p = parts(new Date(iso));
  return `${p.y}-${p.mo}-${p.d}`;
}

/** 'HH:mm:ss' for a duration in ms; replay axes are session-relative, not wall clock. */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/** 'HH:mm:ss.mmm' for a duration in ms. */
export function fmtDurationMs(ms: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fmtDuration(ms)}.${p(Math.floor(ms) % 1000).padStart(3, '0')}`;
}

/** The display-timezone date key for "now" shifted by whole days. */
export function todayKey(offsetDays = 0): string {
  return dayKey(new Date(Date.now() - offsetDays * 86400000).toISOString());
}
