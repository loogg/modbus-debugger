import { z } from 'zod';

/** A scan only probes one item. Write function codes and arbitrary quantities are not accepted. */
export const scanOptionsSchema = z.object({
  fc: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  start: z.number().int().min(0).max(65535).default(0),
  timeoutMs: z.number().int().min(10).max(10000).default(150),
  retries: z.number().int().min(0).max(5).optional(),
}).strict();

export type ScanOverrides = z.input<typeof scanOptionsSchema>;
export type ScanOptions = z.output<typeof scanOptionsSchema> & { retries: number };
