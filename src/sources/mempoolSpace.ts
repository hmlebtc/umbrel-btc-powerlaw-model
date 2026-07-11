/**
 * mempool.space — spot + coarse full historical price (spec sections 3.3/3.4).
 *
 * Spot:    api/v1/prices -> { USD }.
 * History: api/v1/historical-price?currency=USD -> { prices: [{ time(sec), USD }] }
 *          (coarse cadence; used as a cross-validation source).
 */

import type { DailyObservation } from '../types.js';
import { fetchJson, toUsd, unixToUtcDate, type PriceSource } from './types.js';

interface PricesResponse {
  USD?: number;
}
interface HistoricalResponse {
  prices?: Array<{ time?: number; USD?: number }>;
}

const SPOT_URL = 'https://mempool.space/api/v1/prices';
const HISTORY_URL = 'https://mempool.space/api/v1/historical-price?currency=USD';

export function createMempoolSpaceSource(): PriceSource {
  return {
    name: 'mempoolSpace',
    kinds: ['spot', 'history'],
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
