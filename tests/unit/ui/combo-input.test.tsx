import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { ComboInput, Dialog, Field, hasOpenComboList } from '../../../src/renderer/components/ui';

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
    // clicking the already-focused field must reopen it (focus does not fire again);
    // no browser-quirk suppression may swallow a deliberate click
    fireEvent.click(input());
    expect(listOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('clicking an option through its text span closes and stays closed', () => {
    // regression shape of the real-mouse bug: the click target is the option's <span>, not the
    // button. The list must close from the bubbled click and nothing may reopen it.
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.click(screen.getByText('9600')); // span inside the option button
    expect(listOpen()).toBe(false);
    fireEvent.click(input());
    expect(listOpen()).toBe(true);
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

  it('opening from the chevron while the input is focused survives the blur grace timer', async () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByText('9600')); // closes; input keeps focus
    expect(listOpen()).toBe(false);
    await settle(250); // past the reopen-suppression window

    // real chevron click: the input blurs towards the chevron first, then the click opens
    const chevron = screen.getByLabelText('展开选项');
    fireEvent.blur(input(), { relatedTarget: chevron });
    fireEvent.click(chevron);
    expect(listOpen()).toBe(true);
    // the old blur grace timer used to close this list ~120 ms later
    await settle(250);
    expect(listOpen()).toBe(true);
  });

  it('still closes on blur when focus leaves the combobox entirely', async () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(listOpen()).toBe(true);
    fireEvent.blur(input(), { relatedTarget: screen.getByTestId('other') });
    await settle(250);
    expect(listOpen()).toBe(false);
  });
});

describe('Field caption semantics', () => {
  it('stacks caption + control as a labelled group and never wraps them in a <label>', () => {
    // a <label> forwards clicks on non-interactive descendants (option text spans) to its
    // labelled control; for ComboInput that second trusted click reopened a closed list
    const { container } = render(
      <Field label={'串口'}>
        <input data-testid="x" />
      </Field>,
    );
    expect(container.querySelector('label')).toBeNull();
    const group = container.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    const id = group?.getAttribute('aria-labelledby') ?? '';
    expect(id).not.toBe('');
    const caption = container.querySelector('[id="' + id + '"]');
    expect(caption?.textContent).toBe('串口');
  });
});
