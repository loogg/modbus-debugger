import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ValueCell } from '../../../src/renderer/components/value-cell';
import { useApp } from '../../../src/renderer/store/app';
import type { PointDef } from '../../../src/domain/model';
import type { PointViewState } from '../../../src/shared/snapshot';

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
  useApp.setState({ writeStates: {}, selectedPoints: {}, snapshot: null, api: null });
});

afterEach(() => {
  cleanup();
});

describe('ValueCell write semantics', () => {
  it('shows only the confirmed device value', () => {
    render(<ValueCell point={point} view={view()} />);
    expect(screen.getByText('1500')).toBeTruthy();
    expect(screen.getByText('rpm')).toBeTruthy();
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