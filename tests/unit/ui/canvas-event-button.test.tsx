import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasEventButton } from '../../../src/renderer/features/canvas/script-signal';

afterEach(cleanup);
it('delivers a held keyboard activation once and balances cancellation on blur, disabling and unmount', () => {
  const send = vi.fn();
  const view = render(<CanvasEventButton text="采样" disabled={false} send={send} />);
  const button = screen.getByRole('button', { name:'采样' });
  const events = () => send.mock.calls.map(([event]) => event);
  fireEvent.keyDown(button, { key:' ' }); fireEvent.keyDown(button, { key:' ', repeat:true }); fireEvent.keyUp(button, { key:' ' });
  expect(events()).toEqual(['press','release','click']);
  const id = send.mock.calls[0]![1];
  expect(typeof id).toBe('string');
  expect(send.mock.calls[1]![1]).toBe(id);
  expect(send.mock.calls[2]![1]).toBe(id);
  fireEvent.click(button, { detail: 1 });
  expect(events()).toEqual(['press','release','click']);
  fireEvent.click(button, { detail: 0 });
  expect(events()).toEqual(['press','release','click','click']);
  send.mockClear();
  fireEvent.keyDown(button, { key:'Enter' }); fireEvent.blur(window); fireEvent.blur(button); fireEvent.keyUp(button, { key:'Enter' });
  expect(events()).toEqual(['press','cancel']);
  send.mockClear();
  fireEvent.keyDown(button, { key:' ' });
  view.rerender(<CanvasEventButton text="采样" disabled={true} send={send} />);
  expect(events()).toEqual(['press','cancel']);
  view.rerender(<CanvasEventButton text="采样" disabled={false} send={send} />);
  send.mockClear(); fireEvent.keyDown(button, { key:'Enter' }); view.unmount();
  expect(events()).toEqual(['press','cancel']);
});

it('finishes the original press once across a rerender and a window close', () => {
  const oldSend = vi.fn(), newSend = vi.fn();
  const view = render(<CanvasEventButton text="采样" disabled={false} send={oldSend} />);
  const button = screen.getByRole('button', {name:'采样'});
  fireEvent.keyDown(button, {key:'Enter'});
  view.rerender(<CanvasEventButton text="已改名" disabled={false} send={newSend} />);
  window.dispatchEvent(new Event('pagehide'));
  fireEvent.blur(window);
  fireEvent.keyUp(button, {key:'Enter'});
  expect(oldSend.mock.calls).toEqual([['press',expect.any(String)],['cancel',oldSend.mock.calls[0]![1]]]);
  expect(newSend).not.toHaveBeenCalled();
});
