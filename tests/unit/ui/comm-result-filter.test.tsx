import React from 'react';
import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../../../src/renderer/shell';
import { useApp } from '../../../src/renderer/store/app';
import { workspaceSchema } from '../../../src/domain/model';
import { DEFAULT_PREFS } from '../../../src/main/services/workspace';
import type { ResultKind, TransactionRecord } from '../../../src/main/runtime/diagnostics';
afterEach(cleanup);
it('result checkboxes include exactly their own categories, with search and slave filters composed', () => {
  const results: ResultKind[] = ['ok','timeout','exception','crc','malformed','transport','unexpected'];
  const transactions: TransactionRecord[] = results.map((result, i) => ({ traceId: result, connectionId:'conn-tcp', unitId:1, functionCode:3, sourceKind:'poll', sourceId:'blk-ctrl', startUtc:'2026-09-14T00:00:00.000Z', startMono:i, durationMs:1, requestAduHex:'0103', responseAduHex:result === 'ok' ? '0103' : null, result, exceptionCode:result === 'exception' ? 2 : null, mbapTransactionId:i, summary:`result-${result}` }));
  useApp.setState({ module:'comm', toasts:[], commSlaveFilter:{}, commResultFilter:{ok:true,timeout:true,exception:true,other:true}, selection:{...useApp.getState().selection,connectionId:'conn-tcp',commView:'messages'}, snapshot:{ revision:1, workspace:workspaceSchema.parse(JSON.parse(fs.readFileSync('tools/e2e/demo.workspace.json','utf8'))), workspacePath:null,dirty:false,connections:{},blocks:{},points:{},transactions,parseEvents:[],diagRev:0,health:{},recording:null,sessions:[],warnings:[],prefs:DEFAULT_PREFS,historyDbPath:'' } });
  const {container} = render(<App />);
  const rows = () => [...container.querySelectorAll('tbody tr')].map(row => row.textContent ?? '');
  expect(rows()).toHaveLength(7);
  const names = ['成功','超时','Modbus 异常','其他错误'];
  for(const name of names) fireEvent.click(screen.getByRole('checkbox',{name}));
  expect(rows()).toHaveLength(0);
  for(const [i,name] of names.entries()) {
    fireEvent.click(screen.getByRole('checkbox',{name}));
    const expected = i === 3 ? results.slice(3) : [results[i]!];
    expect(rows()).toHaveLength(expected.length);
    for(const result of expected) expect(rows().some(row=>row.includes(`result-${result}`))).toBe(true);
    fireEvent.click(screen.getByRole('checkbox',{name}));
  }
  for(const name of names) fireEvent.click(screen.getByRole('checkbox',{name}));
  fireEvent.change(screen.getByPlaceholderText(/搜索地址/),{target:{value:'result-crc'}}); expect(rows()).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox',{name:/从站 1/})); expect(rows()).toHaveLength(0);
});
