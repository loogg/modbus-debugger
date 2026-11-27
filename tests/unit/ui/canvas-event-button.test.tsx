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
