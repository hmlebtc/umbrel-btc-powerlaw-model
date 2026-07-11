/**
 * Binance (data-api.binance.vision, keyless) — spot + daily klines
 * (spec sections 3.3/3.4).
 *
 * Spot:    ticker/price?symbol=BTCUSDT -> `price`.
 * History: klines?symbol=BTCUSDT&interval=1d&startTime=<ms>&limit=1000,
 *          paginated forward from 2017-08-17. Each kline is an array:
 *          [openTime(ms), open, high, low, close, ...]; close (idx 4) is USD.
 */

import type { DailyObservation } from '../types.js';
import { fetchJson, toUsd, unixToUtcDate, type PriceSource } from './types.js';

interface PriceTicker {
  price?: string;
}
type Kline = [number, string, string, string, string, ...unknown[]];

const SPOT_URL = 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT';
const KLINES_BASE =
  'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000&startTime=';
// Single-request recent window for the quorum recent-fill path (spec 3.3).
const KLINES_RECENT_URL =
  'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=15';
// 2017-08-17 UTC — Binance's first BTCUSDT daily kline.
const HISTORY_START_MS = Date.UTC(2017, 7, 17);
const PAGE_CAP = 40;
const DAY_MS = 86_400_000;

/** Map a kline batch to a sorted daily series (openTime -> date, close = USD). */
function parseKlines(rows: Kline[]): DailyObservation[] {
  const byDate = new Map<string, number>();
  for (const k of rows) {
    const openMs = Number(k[0]);
    const close = Number(k[4]);
    if (!Number.isFinite(openMs) || !(close > 0)) continue;
    byDate.set(unixToUtcDate(Math.floor(openMs / 1000)), close);
  }
  return [...byDate.entries()]
    .map(([date, usd]) => ({ date, usd }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function createBinanceSource(): PriceSource {
  return {
    name: 'binance',
    kinds: ['spot', 'history'],
    async fetchSpot(): Promise<number> {
      const t = await fetchJson<PriceTicker>(SPOT_URL, { timeoutMs: 4000 });
      return toUsd(t.price);
    },
    async fetchRecentHistory(): Promise<DailyObservation[]> {
      const rows = await fetchJson<Kline[]>(KLINES_RECENT_URL);
      return Array.isArray(rows) ? parseKlines(rows) : [];
    },
    async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
      const byDate = new Map<string, number>();
      let start = HISTORY_START_MS;
      const now = Date.now();
      for (let page = 0; page < PAGE_CAP; page++) {
        const rows = await fetchJson<Kline[]>(KLINES_BASE + String(start));
        if (!Array.isArray(rows) || rows.length === 0) break;
        let maxOpen = start;
        for (const k of rows) {
          const openMs = Number(k[0]);
          const close = Number(k[4]);
          if (!Number.isFinite(openMs) || !(close > 0)) continue;
          byDate.set(unixToUtcDate(Math.floor(openMs / 1000)), close);
          if (openMs > maxOpen) maxOpen = openMs;
        }
        if (maxOpen >= now - DAY_MS || rows.length < 1000) break;
        start = maxOpen + DAY_MS;
      }
      const out: DailyObservation[] = [...byDate.entries()]
        .map(([date, usd]) => ({ date, usd }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      return fromDate ? out.filter((r) => r.date >= fromDate) : out;
    },
  };
}
