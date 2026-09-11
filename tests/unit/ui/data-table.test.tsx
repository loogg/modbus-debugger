import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React, { useMemo, useState } from 'react';
import { DataTable, type Column } from '../../../src/renderer/components/table';

interface Row {
  id: string;
  name: string;
  value: number;
}

const renders: Record<string, number> = {};

function Harness(props: { rows: Row[]; extra?: number; selectedKey?: string | null; onRowClick?: (r: Row) => void }) {
  // A caller-side useMemo is what keeps the column identity stable; DataTable rows can only
  // bail out of re-rendering when both the row object and the columns array are unchanged.
  const cols = useMemo<Array<Column<Row>>>(
    () => [
      {
        id: 'name',
        header: '名称',
        width: 120,
        render: (r) => {
          renders[r.id] = (renders[r.id] ?? 0) + 1;
          return <span>{r.name}</span>;
        },
      },
      { id: 'value', header: '值', width: 80, render: (r) => <span>{r.value}</span> },
    ],
    [],
  );
  return (
    <DataTable
      columns={cols}
      rows={props.rows}
      rowKey={(r) => r.id}
      maxHeight={props.extra}
      selectedKey={props.selectedKey}
      onRowClick={props.onRowClick}
    />
  );
}

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `row ${i}`, value: i }));

afterEach(() => {
  cleanup();
  for (const k of Object.keys(renders)) delete renders[k];
});

describe('DataTable row memoisation', () => {
  it('renders every row once on mount and keeps them stable across unrelated prop changes', () => {
    const base = rows(4);
    const { rerender } = render(<Harness rows={base} />);
    expect(renders).toEqual({ r0: 1, r1: 1, r2: 1, r3: 1 });
    // an unrelated parent prop change must not repaint any row (same row identities)
    rerender(<Harness rows={base} extra={500} />);
    expect(renders).toEqual({ r0: 1, r1: 1, r2: 1, r3: 1 });
    // replacing the row objects does repaint them: identity is the contract
    rerender(<Harness rows={rows(4)} extra={500} />);
    expect(renders).toEqual({ r0: 2, r1: 2, r2: 2, r3: 2 });
    void screen;
  });

  it('only paints rows that are actually new when the list grows (live comm log case)', () => {
    const base = rows(3);
    const { rerender } = render(<Harness rows={base} />);
    expect(renders).toEqual({ r0: 1, r1: 1, r2: 1 });
    // a new snapshot object with the same row identities plus one appended record
    rerender(<Harness rows={[...base, { id: 'r3', name: 'row 3', value: 3 }]} />);
    expect(renders).toEqual({ r0: 1, r1: 1, r2: 1, r3: 1 });
  });

  it('repaints only the two rows involved in a selection change', () => {
    const base = rows(4);
    const { rerender } = render(<Harness rows={base} selectedKey="r1" />);
    expect(renders).toEqual({ r0: 1, r1: 1, r2: 1, r3: 1 });
    rerender(<Harness rows={base} selectedKey="r2" />);
    expect(renders).toEqual({ r0: 1, r1: 2, r2: 2, r3: 1 });
  });

  it('repaints a row whose data object was replaced with a changed value', () => {
    const base = rows(2);
    const { rerender } = render(<Harness rows={base} />);
    rerender(<Harness rows={[{ ...base[0]!, value: 99 }, base[1]!]} />);
    expect(renders).toEqual({ r0: 2, r1: 1 });
    expect(screen.getByText('99')).toBeTruthy();
  });

  it('keeps row clicks working through the stable internal handler', () => {
    let clicked: string | null = null;
    const Stable = () => {
      const [n, setN] = useState(0);
      const base = useMemo(() => rows(2), []);
      return (
        <>
          <button onClick={() => setN(n + 1)}>bump {n}</button>
          <Harness rows={base} onRowClick={(r) => { clicked = r.id; }} />
        </>
      );
    };
    render(<Stable />);
    // the caller passes an inline arrow, so DataTable must not rely on its identity
    fireEvent.click(screen.getByText('bump 0'));
    fireEvent.click(screen.getByText('row 1'));
    expect(clicked).toBe('r1');
  });
});
