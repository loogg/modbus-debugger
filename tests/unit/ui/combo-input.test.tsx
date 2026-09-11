import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { ComboInput, Dialog, hasOpenComboList } from '../../../src/renderer/components/ui';

const OPTIONS = [
  { value: '9600', label: '9600' },
  { value: '115200', label: '115200' },
  { value: '921600', label: '921600' },
];

function Harness(props: { onOpen?: () => void }) {
  const [value, setValue] = React.useState('115200');
  return (
    <div>
      <ComboInput testId="baud" value={value} onChange={setValue} options={OPTIONS} onOpen={props.onOpen} />
      <input data-testid="other" defaultValue="x" />
    </div>
  );
}

const input = () => screen.getByTestId('baud') as HTMLInputElement;
const listOpen = () => screen.queryAllByText('921600').length > 0;
const settle = async (ms = 200) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

afterEach(() => cleanup());

describe('ComboInput dropdown lifecycle', () => {
  it('opens on focus and re-enumerates through onOpen every time it opens', () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    expect(listOpen()).toBe(false);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // pick an option -> closes
    fireEvent.click(screen.getByText('9600'));
    expect(input().value).toBe('9600');
    expect(listOpen()).toBe(false);
    // clicking the already-focused field must reopen it (focus does not fire again)
    fireEvent.click(input());
    expect(listOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('keeps free-form custom values (baud rates outside the preset list)', () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '123456' } });
    expect(input().value).toBe('123456');
  });

  it('closes on Escape', () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(listOpen()).toBe(false);
  });

  it('closes on blur after the grace period so an option click still lands', async () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.blur(input());
    expect(listOpen()).toBe(true); // grace period: still open immediately after blur
    await settle(250);
    expect(listOpen()).toBe(false);
  });

  it('closes when the user clicks outside the combobox', () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(listOpen()).toBe(false);
  });

  it('does not close when the click lands inside the combobox', () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.mouseDown(input());
    expect(listOpen()).toBe(true);
  });

  it('layered Escape: an open list keeps the hosting Dialog open, the second Escape closes it', () => {
    let closed = false;
    function Host() {
      const [value, setValue] = React.useState('115200');
      return (
        <Dialog title="添加连接" onClose={() => { closed = true; }}>
          {/* Radix auto-focuses the first focusable element; keep it away from the combo */}
          <input data-testid="name" defaultValue="生产线 TCP" />
          <ComboInput testId="baud" value={value} onChange={setValue} options={OPTIONS} />
        </Dialog>
      );
    }
    render(<Host />);
    expect(screen.getByText('添加连接')).toBeTruthy();
    expect(hasOpenComboList()).toBe(false);

    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    expect(hasOpenComboList()).toBe(true);

    // first Escape: Radix sees the key in capture phase, but the Dialog must defer to the list
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(listOpen()).toBe(false);
    expect(hasOpenComboList()).toBe(false);
    expect(closed).toBe(false);
    expect(screen.getByText('添加连接')).toBeTruthy();

    // second Escape: nothing consumes it any more, so the Dialog closes
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('toggles closed from the chevron button', () => {
    render(<Harness />);
    const chevron = screen.getByLabelText('展开选项');
    fireEvent.click(chevron);
    expect(listOpen()).toBe(true);
    fireEvent.click(chevron);
    expect(listOpen()).toBe(false);
  });
});
