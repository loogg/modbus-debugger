import { useEffect, useState } from 'react';
import type { DiagnosticsPage, DiagnosticsRead } from '../../../shared/diagnostics';
import type { ParseEventRecord, TransactionRecord } from '../../../shared/contracts';
import { useApp, useParseEvents, useTransactions } from '../../store/app';
import { useViewActive } from '../../workbench/view-context';

interface Records { connectionId: string | null; transactions: TransactionRecord[]; parseEvents: ParseEventRecord[]; error: string | null; overwritten: boolean }

export function useDiagnostics(connectionId: string | null, enabled = true) {
  const api = useApp(state => state.api);
  const revision = useApp(state => state.snapshot?.diagRev ?? 0);
  const epoch = useApp(state => state.dataEpoch);
  const active = useViewActive();
  const fallbackTransactions = useTransactions();
  const fallbackEvents = useParseEvents();
  const [records, setRecords] = useState<Records>({ connectionId, transactions: [], parseEvents: [], error: null, overwritten: false });
  useEffect(() => {
    if (!api || !connectionId || !active || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: Omit<DiagnosticsRead, 'type' | 'connectionId' | 'limit'> = {};
    setRecords({ connectionId, transactions: [], parseEvents: [], error: null, overwritten: false });
    const load = async () => {
      let delay = 250;
      try {
        const result = await api.command<DiagnosticsPage>({ type: 'diagnostics.read', connectionId, limit: 500, ...cursor });
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error);
        const page = result.value;
        cursor = { generation: page.generation, afterTransactions: page.transactionCursor, afterEvents: page.eventCursor,
          ...(page.hasMore ? { throughTransactions: page.throughTransactions, throughEvents: page.throughEvents } : {}) };
        setRecords(previous => ({ connectionId,
          transactions: [...(page.reset ? [] : previous.transactions), ...page.transactions].slice(-500),
          parseEvents: [...(page.reset ? [] : previous.parseEvents), ...page.parseEvents].slice(-200),
          error: null, overwritten: page.overwritten || !page.reset && previous.overwritten }));
        delay = page.hasMore ? 4 : 250;
      } catch (error) {
        if (cancelled) return;
        setRecords(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        delay = 1000;
      }
      if (!cancelled) timer = setTimeout(() => void load(), delay);
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, connectionId, enabled, active, revision, epoch]);
  if (!api) return { transactions: fallbackTransactions, parseEvents: fallbackEvents, error: null, overwritten: false };
  return records.connectionId === connectionId ? records : { transactions: [], parseEvents: [], error: null, overwritten: false };
}
