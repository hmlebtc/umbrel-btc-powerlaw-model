/**
 * mempool.space — spot + coarse full historical price (spec sections 3.3/3.4).
 *
 * Spot:    api/v1/prices -> { USD }.
 * History: api/v1/historical-price?currency=USD -> { prices: [{ time(sec), USD }] }
 *          (coarse cadence; used as a cross-validation source).
 * Epochs:  api/v1/mining/difficulty-adjustments -> [[time(sec), height, difficulty,
 *          change], ...] newest first — one row per 2016-block retarget, used as an
 *          independent height-vs-time cross-check (v0.2.0).
 * Tip:     api/blocks/tip/height -> plain-text integer.
 * Lookup:  api/v1/mining/blocks/timestamp/<unix> -> { height, hash, timestamp }, the
 *          last block at or before that time; immutable once the time is past. Used
 *          to calibrate Coin Metrics' cumulative count to true chain height.
 */

import type { DailyObservation, HeightEpoch } from '../types.js';
import { MAX_BLOCK_VALUE, fetchJson, toBlockCount, toUsd, unixToUtcDate, type PriceSource } from './types.js';

interface PricesResponse {
  USD?: number;
}
interface HistoricalResponse {
  prices?: Array<{ time?: number; USD?: number }>;
}

const SPOT_URL = 'https://mempool.space/api/v1/prices';
const HISTORY_URL = 'https://mempool.space/api/v1/historical-price?currency=USD';

const EPOCHS_URL = 'https://mempool.space/api/v1/mining/difficulty-adjustments';
const TIP_URL = 'https://mempool.space/api/blocks/tip/height';
const LOOKUP_URL = 'https://mempool.space/api/v1/mining/blocks/timestamp';

/**
 * Parse difficulty-adjustments rows (`[time, height, difficulty, change]`; an
 * object form `{time, height}` is tolerated too) into `{time, height}`, oldest
 * first. Rows with a non-finite time/height, a time outside [genesis, now + 1 day]
 * or a height outside [0, 1e8] are dropped; duplicates by height keep
 * the first seen.
 */
const GENESIS_UNIX = Date.UTC(2009, 0, 3) / 1000;

export function parseEpochs(resp: unknown, nowMs: number = Date.now()): HeightEpoch[] {
  const maxTime = nowMs / 1000 + 86_400; // a timestamp more than a day ahead is garbage
  const rows = Array.isArray(resp) ? resp : [];
  const byHeight = new Map<number, HeightEpoch>();
  for (const row of rows) {
    let time: unknown;
    let height: unknown;
    if (Array.isArray(row)) {
      time = row[0];
      height = row[1];
    } else if (row && typeof row === 'object') {
      time = (row as { time?: unknown }).time;
      height = (row as { height?: unknown }).height;
    }
    const t = typeof time === 'string' ? Number(time) : time;
    const h = typeof height === 'string' ? Number(height) : height;
    if (typeof t !== 'number' || typeof h !== 'number') continue;
    if (!Number.isFinite(t) || !Number.isFinite(h) || t < GENESIS_UNIX || t > maxTime || h < 0 || h > MAX_BLOCK_VALUE) continue;
    if (!byHeight.has(h)) byHeight.set(h, { time: t, height: h });
  }
  return [...byHeight.values()].sort((a, b) => a.height - b.height);
}

/** Parse a blocks/timestamp response to its height (throws when absent/invalid). */
export function parseBlockLookup(resp: unknown): number {
  return toBlockCount((resp as { height?: unknown } | null)?.height);
}

export function createMempoolSpaceSource(): PriceSource {
  return {
    name: 'mempoolSpace',
    kinds: ['spot', 'history', 'height'],
    async fetchEpochs(): Promise<HeightEpoch[]> {
      return parseEpochs(await fetchJson<unknown>(EPOCHS_URL));
    },
    async fetchTipHeight(): Promise<number> {
      return toBlockCount(await fetchJson<unknown>(TIP_URL, { timeoutMs: 4000 }));
    },
    async fetchLastBlockHeightBefore(unixSec: number): Promise<number> {
      // The endpoint returns the last block at or before the timestamp; at 00:00:00Z
      // of D+1 that is the last block of day D (the verified calibration lookups).
      return parseBlockLookup(await fetchJson<unknown>(`${LOOKUP_URL}/${Math.floor(unixSec)}`, { timeoutMs: 4000 }));
    },
    async fetchSpot(): Promise<number> {
      const r = await fetchJson<PricesResponse>(SPOT_URL, { timeoutMs: 4000 });
      return toUsd(r.USD);
    },
    async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
      const r = await fetchJson<HistoricalResponse>(HISTORY_URL);
      const prices = Array.isArray(r.prices) ? r.prices : [];
      const byDate = new Map<string, number>();
      for (const p of prices) {
        const time = typeof p.time === 'number' ? p.time : NaN;
        const usd = typeof p.USD === 'number' ? p.USD : NaN;
        if (!Number.isFinite(time) || !(usd > 0)) continue;
        byDate.set(unixToUtcDate(time), usd);
      }
      const out: DailyObservation[] = [...byDate.entries()]
        .map(([date, usd]) => ({ date, usd }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      return fromDate ? out.filter((x) => x.date >= fromDate) : out;
    },
  };
}
