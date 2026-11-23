import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useConfirm } from '../../../src/renderer/workbench/use-confirm';
import { Overlays } from '../../../src/renderer/screens/overlays';
import { appStore } from '../../../src/renderer/store/app';
import { ViewErrorBoundary } from '../../../src/renderer/workbench/view-error-boundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); appStore.setState({ overlay: null }); });
it('resolves cancel and accept in the owning view without a blocking native confirm', async () => {
  function Probe() {
    const confirm = useConfirm();
    const [result, setResult] = useState('pending');
    return <><button onClick={async () => setResult(await confirm('丢弃当前草稿？') ? 'accepted' : 'cancelled')}>Check</button><output>{result}</output></>;
  }
  render(<><Probe /><Overlays /></>);
  fireEvent.click(screen.getByText('Check'));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('cancelled'));
  fireEvent.click(screen.getByText('Check'));
  fireEvent.click(screen.getByRole('button', { name: '丢弃并继续' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('accepted'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('contains a failed page and permits a local retry without unmounting its sibling', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  function Unstable() { if (fail) throw new Error('View failed'); return <div>Recovered</div>; }
  render(<><ViewErrorBoundary><Unstable /></ViewErrorBoundary><div>Another live view</div></>);
  expect(screen.getByRole('alert')).toHaveTextContent('此页面暂时无法显示');
  expect(screen.getByText('Another live view')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重新加载此页' }));
  expect(screen.getByText('Recovered')).toBeInTheDocument();
});
