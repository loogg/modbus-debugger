import { z } from 'zod';
import type { BlockViewState, PointViewState } from './snapshot';

export const DEFAULT_BUFFER_CAPACITY = 10000;
export const MAX_BUFFER_CAPACITY = 100000;
export const MAX_TOTAL_BUFFER_CAPACITY = 2000000;
export const MAX_READ_SAMPLES = 10000;
/** Budget for encoded sample columns. Latest values and control metadata have separate count limits. */
export const MAX_READ_SAMPLE_BYTES = 256 * 1024;
export const pointRefSchema = z.object({ slaveId: z.string().min(1), pointId: z.string().min(1) });
export type DataPointRef = z.infer<typeof pointRefSchema>;
export const bufferConfigSchema = pointRefSchema.extend({ capacity: z.number().int().min(10).max(MAX_BUFFER_CAPACITY) });
export type BufferConfig = z.infer<typeof bufferConfigSchema>;
export const seriesReadSchema = pointRefSchema.extend({
  queryId: z.string().min(1).max(200).optional(),
  generation: z.string().optional(), afterSeq: z.number().int().min(0).optional(),
  throughSeq: z.number().int().min(0).optional(), startMs: z.number().finite().optional(),
  endMs: z.number().finite().optional(), limit: z.number().int().min(1).max(MAX_READ_SAMPLES).default(2000),
  metadataVersion: z.string().optional(),
});
export type SeriesRead = z.infer<typeof seriesReadSchema>;
export const dataReadSchema = z.object({
  type: z.literal('data.read'),
  format: z.literal('columns-v1').optional(),
  sampleBytes: z.number().int().min(4096).max(MAX_READ_SAMPLE_BYTES).optional(),
  points: z.array(pointRefSchema).max(10000).default([]),
  blocks: z.array(z.object({ slaveId: z.string(), blockId: z.string() })).max(2000).default([]),
  series: z.array(seriesReadSchema).max(1000).default([]),
  buffers: z.array(pointRefSchema.extend({ metadataVersion: z.string().optional() })).max(2000).default([]),
});
export type DataReadRequest = z.infer<typeof dataReadSchema>;
export interface PointSample { seq: number; timeMs: number; monoMs: number; value: number | boolean | string }
export interface BufferInfo {
  generation: string; capacity: number; count: number;
  firstSeq: number; lastSeq: number; firstTimeMs: number | null; lastTimeMs: number | null;
  references: string[]; error?: string;
}
export interface SeriesPage extends BufferInfo {
  rangeStatus?: 'available' | 'partial' | 'expired';
  samples: PointSample[]; nextSeq: number; throughSeq: number; hasMore: boolean; gap: boolean; reset: boolean;
}
export interface DataReadResult {
  checkedAtMs: number;
  points: Record<string, PointViewState>;
  blocks: Record<string, BlockViewState>;
  series: Record<string, SeriesPage>;
  buffers: Record<string, BufferInfo>;
}

/** Frontend projection. Main retains the original monotonic timestamp for export. */
export type SampleColumns = {
  times: Float64Array;
  sequences: Float64Array;
} & (
  | { kind: 'number'; values: Float64Array }
  | { kind: 'boolean'; values: Uint8Array }
  | { kind: 'string'; values: string[] }
);
export type BufferMetadata = Pick<BufferInfo, 'capacity' | 'references' | 'error'>;
export interface ColumnBufferInfo extends Omit<BufferInfo, keyof BufferMetadata> {
  metadataVersion: string;
  metadata?: BufferMetadata;
}
export interface ColumnSeriesPage extends ColumnBufferInfo {
  rangeStatus?: SeriesPage['rangeStatus'];
  columns: SampleColumns;
  nextSeq: number; throughSeq: number; hasMore: boolean; gap: boolean; reset: boolean;
}
export interface ColumnDataReadResult extends Omit<DataReadResult, 'series' | 'buffers'> {
  format: 'columns-v1';
  series: Record<string, ColumnSeriesPage>;
  buffers: Record<string, ColumnBufferInfo>;
  sampleBytes: number;
}
export interface BufferExportResult { path: string; count: number; firstTimeMs: number | null; lastTimeMs: number | null }
