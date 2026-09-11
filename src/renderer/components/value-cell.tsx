import React, { useEffect, useRef, useState } from 'react';
import type { PointDef } from '../../domain/model';
import type { PointViewState } from '../../shared/snapshot';
import { useApp } from '../store/app';
import { Select } from './ui';

function Spinner() {
  return (
    <svg className="spin inline-block h-3 w-3" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Value cell: always renders the last confirmed device value. Editing input,
 * pending value, rejection / unknown / confirmed markers are transient overlays.
 */
export function ValueCell(props: { point: PointDef; view: PointViewState | undefined }) {
  const writeState = useApp((s) => s.writeStates[props.point.id]);
  const command = useApp((s) => s.command);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const writable = props.point.access === 'rw';
  const view = props.view;
  const isEnum = Object.keys(props.point.enumMap).length > 0;
  const isBool = props.point.mapping.rawType === 'Bool';
  const isString = props.point.mapping.rawType === 'String';

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = async () => {
    setEditing(false);
    const text = draft.trim();
    if (!text) return;
    let engineering: number | null = null;
    let boolValue: boolean | null = null;
    let stringValue: string | null = null;
    if (isBool) boolValue = text === '1' || text.toLowerCase() === 'on' || text.toLowerCase() === 'true';
    else if (isString) stringValue = text;
    else if (isEnum) {
      const entry = Object.entries(props.point.enumMap).find(([k, v]) => v === text || k === text);
      engineering = entry ? Number(entry[0]) : Number(text);
      if (Number.isNaN(engineering)) {
        toast({ kind: 'error', title: '无效枚举值', message: text });
        return;
      }
    } else {
      engineering = Number(text);
      if (Number.isNaN(engineering)) {
        toast({ kind: 'error', title: '无效数值', message: text });
        return;
      }
    }
    useApp.setState((s) => ({
      writeStates: { ...s.writeStates, [props.point.id]: { phase: 'writing', attempted: text, at: Date.now(), exceptionCode: null } },
    }));
    const slaveId = useApp.getState().selection.slaveId;
    const res = await command({ type: 'point.write', slaveId: slaveId ?? '', pointId: props.point.id, engineering, boolValue, stringValue });
    if (!res.ok) {
      useApp.setState((s) => {
        const ws = { ...s.writeStates };
        delete ws[props.point.id];
        return { writeStates: ws };
      });
    }
  };

  const confirmedText = view?.hasValue ? view.engText : '—';
  const unit = props.point.unit;

  let marker: React.ReactNode = null;
  let valueNode: React.ReactNode = <span className={writable ? 'text-accent font-medium' : ''}>{confirmedText}</span>;
  if (writeState?.phase === 'writing') {
    valueNode = (
      <span className="text-accent font-medium">
        {confirmedText} → {writeState.attempted} <Spinner />
      </span>
    );
  } else if (writeState?.phase === 'rejected') {
    marker = <span title={`设备拒绝（异常码 ${writeState.exceptionCode ?? '?'}），保留旧值`} className="text-warn">⚠</span>;
  } else if (writeState?.phase === 'unknown') {
    marker = <span title="写结果未知，正在回读确认" className="text-ink2">?</span>;
  } else if (writeState?.phase === 'confirmed') {
    marker = <span className="text-ok">✓</span>;
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          ref={inputRef}
          className="focus-ring h-7 w-24 rounded border border-accent bg-surface px-2 text-sm outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <span className="text-xs text-ink2">{unit}</span>
      </span>
    );
  }

  if (isEnum && view?.enumLabel) {
    valueNode = writable ? (
      <button
        className="focus-ring cursor-pointer text-accent font-medium"
        onDoubleClick={() => {
          setDraft(view.enumLabel ?? '');
          setEditing(true);
        }}
      >
        {view.enumLabel} ▾
      </button>
    ) : (
      <span>{view.enumLabel}</span>
    );
    if (writeState?.phase === 'writing') valueNode = <span className="text-accent">{confirmedText} → {writeState.attempted} <Spinner /></span>;
  }

  return (
    <span
      className="inline-flex w-full items-center gap-1.5"
      onDoubleClick={() => {
        if (!writable) return;
        setDraft(isBool ? (view?.boolValue ? 'ON' : 'OFF') : confirmedText);
        setEditing(true);
      }}
      title={writable ? '双击编辑' : undefined}
    >
      {valueNode}
      {unit && view?.hasValue ? <span className="text-xs text-ink2">{unit}</span> : null}
      {marker}
    </span>
  );
}

export function EnumEditSelect(props: { point: PointDef; onCommit: (v: number) => void }) {
  const options = Object.entries(props.point.enumMap).map(([k, v]) => ({ value: k, label: v }));
  return <Select value={options[0]?.value ?? ''} onChange={(v) => props.onCommit(Number(v))} options={options} />;
}