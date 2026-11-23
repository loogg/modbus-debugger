import { z } from 'zod';
import type { ParseEventRecord, TransactionRecord } from './contracts';

export const diagnosticsReadSchema = z.object({
  type: z.literal('diagnostics.read'),
  connectionId: z.string().optional(),
  generation: z.string().optional(),
  afterTransactions: z.number().int().min(0).optional(),
  afterEvents: z.number().int().min(0).optional(),
  throughTransactions: z.number().int().min(0).optional(),
  throughEvents: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type DiagnosticsRead = z.infer<typeof diagnosticsReadSchema>;
export interface DiagnosticsPage {
  generation: string;
  transactions: TransactionRecord[];
  parseEvents: ParseEventRecord[];
  transactionCursor: number;
  eventCursor: number;
  throughTransactions: number;
  throughEvents: number;
  hasMore: boolean;
  overwritten: boolean;
  reset: boolean;
}
