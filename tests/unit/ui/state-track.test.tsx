import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StateTrack } from '../../../src/renderer/components/state-track';
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(340);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const base = { kind: 'string' as const, label: '固件版本', initialValue: 'V2.4.0', startMs: 0, endMs: 60000, xMode: 'duration' as const };
describe('string change labels', () => {
  it('does not draw the initial value again for the first equal recorded event', () => {
    const { container } = render(<StateTrack {...base} events={[{tMs: 100, value: 'V2.4.0'}]} />);
    expect(container.querySelectorAll('[data-string-label]')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('[data-string-label]')?.textContent).toBe('V2.4.0');
  });
  it('keeps all dense change markers and full values while avoiding colliding labels', () => {
    const events = Array.from({length: 10}, (_, i) => ({tMs: 100 + i * 10, value: `很长的固件说明-${i}-abcdefghijklmnopqrstuvwxyz`}));
    const { container } = render(<StateTrack {...base} events={events} />);
    expect(container.querySelectorAll('circle')).toHaveLength(11);
    expect(container.querySelectorAll('[data-string-label]')).toHaveLength(1);
    expect(container.querySelector('[data-string-label]')?.textContent).toContain('…');
    expect([...container.querySelectorAll('title')].map(t => t.textContent).at(-1)).toContain(events[9]!.value);
  });
  it('supports changes at both ends of a window without out-of-window events', () => {
    const { container } = render(<StateTrack {...base} events={[{tMs:-1,value:'outside'},{tMs:60000,value:'end'},{tMs:60001,value:'later'}]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.textContent).not.toContain('outside'); expect(container.textContent).not.toContain('later');
  });
  it('keeps source context accessible and clips long captions before the plot', () => {
    const label = '相同名字的字符串点位和很长的后缀';
    const sublabel = 'TCP 从站 / Unit 1 / 很长的数据块名称';
    const { container } = render(<StateTrack {...base} label={label} sublabel={sublabel} events={[]} />);
    expect(container.querySelector('[data-state-track]')).toHaveAttribute('aria-label', `${label} · ${sublabel}`);
    expect(container.querySelector('[data-state-track]')).toHaveAttribute('title', `${label} · ${sublabel}`);
    expect(container.querySelector('svg text')?.textContent).toContain('…');
  });
});
