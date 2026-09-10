import React from 'react';

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  width: number;
  pin?: 'left';
  align?: 'left' | 'right';
  render: (row: T) => React.ReactNode;
}

export const thClass = 'px-3 py-2 text-left text-xs font-normal text-ink2 whitespace-nowrap';
export const tdClass = 'px-3 text-sm whitespace-nowrap border-t border-[#E7EAEE]';

/**
 * Management table: sticky header, internal horizontal scrolling once column
 * minimum widths are reached, optional left-pinned first column.
 */
export function DataTable<T>(props: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  rowHeight?: number;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  maxHeight?: number;
  empty?: React.ReactNode;
}) {
  const total = props.columns.reduce((a, c) => a + c.width, 0);
  const h = props.rowHeight ?? 40;
  return (
    <div className="rounded-card border border-line bg-surface overflow-auto" style={{ maxHeight: props.maxHeight }}>
      <table className="w-full border-separate border-spacing-0" style={{ minWidth: total }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface">
            {props.columns.map((c, i) => (
              <th
                key={c.id}
                className={`${thClass} ${c.pin === 'left' ? 'sticky left-0 z-20 bg-surface' : ''} ${i === 0 ? 'rounded-tl-card' : ''}`}
                style={{ width: c.width, minWidth: c.width, textAlign: c.align ?? 'left' }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIdx) => {
            const key = props.rowKey(row, rowIdx);
            const selected = props.selectedKey === key;
            return (
              <tr
                key={key}
                onClick={() => props.onRowClick?.(row)}
                className={`${props.onRowClick ? 'cursor-pointer' : ''} ${selected ? 'bg-accentsoft' : 'hover:bg-surface2/60'}`}
                style={{ height: h }}
              >
                {props.columns.map((c) => (
                  <td
                    key={c.id}
                    className={`${tdClass} ${c.pin === 'left' ? `sticky left-0 z-[5] ${selected ? 'bg-accentsoft' : 'bg-surface'}` : ''}`}
                    style={{ width: c.width, minWidth: c.width, textAlign: c.align ?? 'left' }}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.rows.length === 0 && props.empty ? <div className="py-10 text-center text-sm text-ink2">{props.empty}</div> : null}
    </div>
  );
}

export function GroupHeaderRow(props: { colSpan: number; left: React.ReactNode; middle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <tr className="bg-accentsoft/70">
      <td colSpan={props.colSpan} className="px-3 py-2 border-t border-[#E7EAEE]">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm font-bold text-ink">{props.left}</div>
          <div className="flex items-center gap-6">
            {props.middle ? <div className="text-xs text-ink2 mono">{props.middle}</div> : null}
            {props.right}
          </div>
        </div>
      </td>
    </tr>
  );
}