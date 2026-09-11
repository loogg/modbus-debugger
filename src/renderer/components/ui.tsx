import React, { useEffect, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixCheckbox from '@radix-ui/react-checkbox';
import * as RadixSelect from '@radix-ui/react-select';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { CheckmarkSquare20Regular, ChevronDown20Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useApp } from '../store/app';

/* ------------------------------- buttons ------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'link';

export function Button(props: {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const { variant = 'secondary', size = 'md' } = props;
  const base = 'focus-ring inline-flex items-center justify-center gap-1.5 rounded-ctl font-medium transition-colors select-none';
  const h = size === 'md' ? 'h-10 px-4 text-sm' : 'h-8 px-3 text-[13px]';
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-white hover:bg-[#106ebe] active:bg-[#005a9e]',
    secondary: 'bg-surface border border-line text-ink hover:bg-surface2',
    quiet: 'bg-accentsoft text-accent hover:bg-[#d5e7f7]',
    danger: 'bg-surface border border-err text-err hover:bg-[#fdecea]',
    link: 'text-accent hover:underline px-0',
  };
  return (
    <button
      type={props.type ?? 'button'}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`${base} ${h} ${styles[variant]} ${props.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

/* ------------------------------- inputs ------------------------------- */

export function Field(props: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <div className="text-xs text-ink2 mb-1.5">{props.label}</div>
      {props.children}
      {props.hint ? <div className="text-xs text-ink2 mt-1">{props.hint}</div> : null}
    </label>
  );
}

export const inputClass =
  'focus-ring h-10 w-full rounded-ctl border border-line bg-surface2 px-3 text-sm text-ink placeholder:text-ink2/70 outline-none focus:border-accent';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} className={`${inputClass} ${className ?? ''}`} />;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select(props: { value: string; onChange: (v: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean }) {
  return (
    <RadixSelect.Root value={props.value} onValueChange={props.onChange} disabled={props.disabled}>
      <RadixSelect.Trigger className={`${inputClass} flex items-center justify-between text-left`}>
        <RadixSelect.Value placeholder={props.placeholder} />
        <RadixSelect.Icon>
          <ChevronDown20Regular className="text-ink2" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="z-50 overflow-hidden rounded-ctl border border-line bg-surface shadow-lg" position="popper" sideOffset={4}>
          <RadixSelect.Viewport className="p-1">
            {props.options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                className="focus-ring relative flex cursor-pointer items-center rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-accentsoft data-[state=checked]:text-accent"
              >
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export function Checkbox(props: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <RadixCheckbox.Root
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(v) => props.onCheckedChange(v === true)}
        className="focus-ring flex h-4 w-4 items-center justify-center rounded-[3px] border border-line bg-surface data-[state=checked]:bg-accent data-[state=checked]:border-accent"
      >
        <RadixCheckbox.Indicator className="text-white">
          <CheckmarkSquare20Regular className="hidden" />
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" />
          </svg>
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {props.label ? <span className="text-sm">{props.label}</span> : null}
    </label>
  );
}

/* ------------------------------- status ------------------------------- */

export type StatusTone = 'ok' | 'warn' | 'err' | 'idle' | 'accent';

const toneColor: Record<StatusTone, string> = {
  ok: '#178A4D',
  warn: '#C76C00',
  err: '#C42B1C',
  idle: '#62666F',
  accent: '#0078D4',
};

export function StatusDot(props: { tone: StatusTone; label?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${props.className ?? ''}`} style={{ color: toneColor[props.tone] }}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: toneColor[props.tone] }} />
      {props.label}
    </span>
  );
}

/* ------------------------------- surfaces ------------------------------- */

export function Card(props: { children: React.ReactNode; className?: string; padded?: boolean }) {
  return <div className={`rounded-card border border-line bg-surface ${props.padded === false ? '' : 'p-5'} ${props.className ?? ''}`}>{props.children}</div>;
}

export function InfoBand(props: { tone?: 'gray' | 'blue'; children: React.ReactNode; className?: string }) {
  const bg = props.tone === 'blue' ? 'bg-accentsoft' : 'bg-surface2';
  return <div className={`rounded-card ${bg} px-5 py-4 ${props.className ?? ''}`}>{props.children}</div>;
}

export function InfoColumns(props: { items: Array<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> }) {
  return (
    <InfoBand>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
        {props.items.map((it, i) => (
          <div key={i}>
            <div className="text-xs text-ink2 mb-1">{it.label}</div>
            <div className="text-sm">{it.value}</div>
            {it.sub ? <div className="text-xs mt-1">{it.sub}</div> : null}
          </div>
        ))}
      </div>
    </InfoBand>
  );
}

export function PageHeader(props: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-9 font-bold text-ink truncate">{props.title}</h1>
        {props.subtitle ? <div className="text-xs text-ink2 mt-1.5 truncate">{props.subtitle}</div> : null}
      </div>
      {props.actions ? <div className="flex items-center gap-3 shrink-0">{props.actions}</div> : null}
    </div>
  );
}

export function SectionTitle(props: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3 mt-6">
      <h2 className="text-xl font-bold text-ink">{props.children}</h2>
      {props.right}
    </div>
  );
}

export function Tabs(props: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-6 border-b border-line mb-4">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          className={`focus-ring -mb-px cursor-pointer border-b-2 px-1 pb-2 text-sm ${props.active === t.id ? 'border-accent text-accent font-medium' : 'border-transparent text-ink2 hover:text-ink'}`}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState(props: { title: string; message?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-xl font-bold mb-2">{props.title}</div>
      {props.message ? <div className="text-sm text-ink2 max-w-md mb-6">{props.message}</div> : null}
      {props.actions ? <div className="flex items-center gap-3">{props.actions}</div> : null}
    </div>
  );
}

/* ------------------------------- overlays ------------------------------- */

export function Dialog(props: { title: string; subtitle?: string; width?: number; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && props.onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RadixDialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-surface shadow-2xl outline-none"
          style={{ width: props.width ?? 640 }}
        >
          <div className="px-7 pt-6 pb-4 shrink-0">
            <RadixDialog.Title className="text-xl font-bold">{props.title}</RadixDialog.Title>
            {props.subtitle ? <RadixDialog.Description className="text-xs text-ink2 mt-1.5">{props.subtitle}</RadixDialog.Description> : null}
          </div>
          <div className="overflow-y-auto px-7 pb-2">{props.children}</div>
          {props.footer ? <div className="flex justify-end gap-3 px-7 py-5 shrink-0">{props.footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Drawer(props: { title: string; subtitle?: string; width?: number; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/20" onClick={props.onClose} />
      <div className="absolute right-0 top-0 bottom-0 flex flex-col bg-surface shadow-2xl border-l border-line" style={{ width: props.width ?? 500 }}>
        <div className="flex items-start justify-between px-6 pt-6 pb-4 shrink-0">
          <div>
            <div className="text-xl font-bold">{props.title}</div>
            {props.subtitle ? <div className="text-xs text-ink2 mt-1.5">{props.subtitle}</div> : null}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-4">{props.children}</div>
        {props.footer ? <div className="flex justify-end gap-3 px-6 py-4 border-t border-line shrink-0">{props.footer}</div> : null}
      </div>
    </div>
  );
}

export function OverflowMenu(props: { items: Array<{ label: string; onSelect: () => void; danger?: boolean }> }) {
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>
        <button className="focus-ring cursor-pointer rounded p-1 hover:bg-surface2" aria-label="更多操作">
          <MoreHorizontal20Regular />
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content className="z-50 min-w-[160px] rounded-ctl border border-line bg-surface p-1 shadow-lg">
          {props.items.map((it) => (
            <RadixDropdown.Item
              key={it.label}
              onSelect={it.onSelect}
              className={`focus-ring cursor-pointer rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface2 ${it.danger ? 'text-err' : ''}`}
            >
              {it.label}
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const tone: Record<string, string> = { info: 'border-accent', success: 'border-ok', warning: 'border-warn', error: 'border-err' };
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[360px]">
      {toasts.map((t) => (
        <div key={t.id} className={`rounded-ctl border-l-4 ${tone[t.kind]} bg-surface shadow-lg px-4 py-3`} onClick={() => dismiss(t.id)}>
          <div className="text-sm font-medium">{t.title}</div>
          {t.message ? <div className="text-xs text-ink2 mt-1 break-words">{t.message}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- misc ------------------------------- */

export function useCompact(): boolean {
  const [compact, setCompact] = useState(window.innerWidth < 1280);
  const ref = useRef(compact);
  useEffect(() => {
    const onResize = () => {
      const v = window.innerWidth < 1280;
      if (v !== ref.current) {
        ref.current = v;
        setCompact(v);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return compact;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return `${ms.toFixed(1)} ms`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/* ------------------------------- editable combo ------------------------------- */

/**
 * Input + dropdown hybrid: the list can be refreshed every time it opens
 * (e.g. re-enumerate serial ports) while still accepting free-form values
 * (e.g. custom baud rates).
 */
export function ComboInput(props: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  onOpen?: () => void;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div ref={ref} className="relative">
      <input
        className={inputClass}
        data-testid={props.testId}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={() => {
          props.onOpen?.();
          setOpen(true);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="展开选项"
        className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-ink2"
        onClick={() => {
          props.onOpen?.();
          setOpen(!open);
        }}
      >
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && props.options.length > 0 ? (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-ctl border border-line bg-surface py-1 shadow-lg">
          {props.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`focus-ring block w-full cursor-pointer px-3 py-1.5 text-left text-sm hover:bg-surface2 ${o.value === props.value ? 'text-accent font-medium' : ''}`}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}