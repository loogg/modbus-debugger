import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';
import { ValueCell } from '../../../src/renderer/components/value-cell';
import { useApp } from '../../../src/renderer/store/app';
import type { PointDef } from '../../../src/domain/model';
import type { PointViewState } from '../../../src/shared/snapshot';
import type { ModbusApi } from '../../../src/shared/preload-api';
import type { PointWriteResult } from '../../../src/shared/contracts';

const point: PointDef = {
  id: 'p1',
  blockId: 'b1',
  name: '目标转速',
  mapping: { rawType: 'Int16', offset: 6, registerCount: 1, wordOrder: 'ABCD', byteSelector: 'low', bitOffset: 0, bitWidth: 16, stringLength: 0, stringEncoding: 'ascii' },
  scale: 1,
  offset: 0,
  unit: 'rpm',
  access: 'rw',
  displayFormat: 'auto',
  enumMap: {},
  highRisk: false,
  description: '',
};

const view = (over: Partial<PointViewState> = {}): PointViewState => ({
  pointId: 'p1',
  rawText: '1500',
  engText: '1500',
  finite: true,
  rawNumber: 1500,
  engNumber: 1500,
  boolValue: null,
  stringValue: null,
  enumLabel: null,
  hasValue: true,
  ...over,
});

beforeEach(() => {
  useApp.setState({ writeStates: {}, selectedPoints: {}, snapshot: null, api: null, overlay: null, toasts: [] });
});

afterEach(() => {
  cleanup();
});

describe('ValueCell write semantics', () => {
  it('does not mark the old displayed value confirmed before the Main read-back delta arrives',async()=>{
    let resolveResult!: (value:{ok:true;value:PointWriteResult})=>void;
    const response=new Promise<{ok:true;value:PointWriteResult}>(resolve=>{resolveResult=resolve;});
    const api:ModbusApi={command:async<T,>()=>await response as {ok:true;value:T},getSnapshot:async()=>{throw new Error('unexpected snapshot');},onDelta:()=>()=>{},versions:async()=>({app:'test',electron:'test',node:'test'})};
    useApp.setState({api});render(<ValueCell point={point} view={view({slaveId:'s1'})}/>);
    fireEvent.doubleClick(screen.getByText('1500'));const input=screen.getByDisplayValue('1500');fireEvent.change(input,{target:{value:'1600'}});fireEvent.keyDown(input,{key:'Enter'});
    await act(async()=>{resolveResult({ok:true,value:{phase:'confirmed',result:'ok',exceptionCode:null}});await response;});
    expect(screen.queryByText('✓')).toBeNull();expect(document.querySelector('.spin')).not.toBeNull();
  });
  it.each(['exception','timeout','transport'] as const)('ends the pending state when the pre-read returns %s without a write',async result=>{
    const response: PointWriteResult={phase:'not-sent',result,exceptionCode:result==='exception'?2:null};
    const api:ModbusApi={command:async<T,>()=>({ok:true as const,value:response as T}),getSnapshot:async()=>{throw new Error('unexpected snapshot request');},onDelta:()=>()=>{},versions:async()=>({app:'test',electron:'test',node:'test'})};
    useApp.setState({api});
    render(<ValueCell point={{...point,unit:'',mapping:{...point.mapping,rawType:'Bool'}}} view={view({slaveId:'s1',engText:'ON',boolValue:true})}/>);
    fireEvent.doubleClick(screen.getByText('ON'));
    const input=screen.getByDisplayValue('ON');fireEvent.change(input,{target:{value:'OFF'}});fireEvent.keyDown(input,{key:'Enter'});
    await waitFor(()=>expect(useApp.getState().writeStates['s1::p1']?.phase).toBe('not-sent'));
    expect(screen.getByRole('status')).toHaveTextContent('未发送');
    expect(screen.getByRole('status')).toHaveAccessibleName(/未发送写请求/);
    if(result==='exception') expect(screen.getByRole('status')).toHaveAccessibleName(/0x02/);
    expect(screen.getByText('ON')).toBeVisible();
    expect(document.querySelector('.spin')).toBeNull();
    // A new double click must allow a corrected attempt after the failure.
    fireEvent.doubleClick(screen.getByText('ON'));expect(screen.getByDisplayValue('ON')).toBeVisible();
  });
  it('shows only the confirmed device value', () => {
    render(<ValueCell point={point} view={view()} />);
    expect(screen.getByText('1500')).toBeTruthy();
    expect(screen.getByText('rpm')).toBeTruthy();
  });

  it('opens the Raw Inspector from a visible button without entering write mode', () => {
    render(<ValueCell point={point} view={view()} />);
    fireEvent.click(screen.getByRole('button', { name: '原始数据' }));
    expect(useApp.getState().overlay).toEqual({ kind: 'drawer', id: 'inspector', pointId: point.id });
    expect(screen.queryByDisplayValue('1500')).toBeNull();
  });

  it('double click enters editing mode without touching the confirmed value', () => {
    render(<ValueCell point={point} view={view()} />);
    fireEvent.doubleClick(screen.getByText('1500'));
    const input = screen.getByDisplayValue('1500') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByDisplayValue('1500')).toBeNull();
  });

  it('writing state shows confirmed -> pending with spinner', () => {
    useApp.setState({ writeStates: { p1: { phase: 'writing', attempted: '1600', at: Date.now(), exceptionCode: null } } });
    render(<ValueCell point={point} view={view()} />);
    expect(screen.getByText(/1500 → 1600/)).toBeTruthy();
  });

  it('rejected write keeps old value and warns', () => {
    useApp.setState({ writeStates: { p1: { phase: 'rejected', attempted: '1600', at: Date.now(), exceptionCode: 2 } } });
    render(<ValueCell point={point} view={view()} />);
    expect(screen.getByText('1500')).toBeTruthy();
    expect(screen.getByText('⚠')).toBeTruthy();
  });

  it('unknown result shows ? marker', () => {
    useApp.setState({ writeStates: { p1: { phase: 'unknown', attempted: '1600', at: Date.now(), exceptionCode: null } } });
    render(<ValueCell point={point} view={view()} />);
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('read-only points cannot enter editing', () => {
    render(<ValueCell point={{ ...point, access: 'ro' }} view={view()} />);
    fireEvent.doubleClick(screen.getByText('1500'));
    expect(screen.queryByDisplayValue('1500')).toBeNull();
  });

  it('non-finite decoded values are displayed as 非有限数值', () => {
    render(<ValueCell point={point} view={view({ engText: '非有限数值', finite: false })} />);
    expect(screen.getByText('非有限数值')).toBeTruthy();
  });
});
