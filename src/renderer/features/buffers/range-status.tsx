import React from 'react';
import type { DataPointRef } from '../../../shared/point-data';
import { pointKey } from '../../../shared/point-key';
import type { LiveSeries } from '../../store/app';
import { fmtEpochDateTimeMs } from '../../time';

export function BufferRangeStatus({ points, live, paused, startMs, endMs }: { points: DataPointRef[]; live: Record<string, LiveSeries>; paused: boolean; startMs: number; endMs: number }) {
  const affected = points.map(point => {
    const state = live[pointKey(point.slaveId, point.pointId)];
    let range = state?.rangeStatus;
    if (range !== undefined && state?.firstTimeMs != null) range = endMs < state.firstTimeMs ? 'expired' : (state.firstSeq ?? 1) > 1 && startMs < state.firstTimeMs ? 'partial' : 'available';
    return { point, state, range };
  }).filter(item => item.state?.gap || item.range === 'partial' || item.range === 'expired');
  if (!affected.length) return null;
  const expired = affected.some(item => item.range === 'expired');
  const gap = affected.some(item => item.state?.gap);
  const description = affected.map(({ point, state }) => `${point.pointId} · ${state?.firstTimeMs == null || state.lastTimeMs == null ? '暂无可用样本' : `${fmtEpochDateTimeMs(state.firstTimeMs)}～${fmtEpochDateTimeMs(state.lastTimeMs)}`}`).join('\n');
  return <div role="status" className="shrink-0 truncate px-1 py-1 text-[11px] leading-4 text-warn" title={description}>
    {paused ? '当前显示暂停快照 · ' : ''}{expired ? '所选时段已超出后台缓存范围' : gap ? '曾发生采样覆盖缺口' : '部分时间已超出后台缓存范围'} · {affected.length} 个信号
  </div>;
}
