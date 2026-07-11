/**
 * Bitstamp — spot ticker + full paginated daily OHLC (spec sections 3.3/3.4).
 *
 * Spot:    ticker/btcusd -> `last`.
 * History: ohlc/btcusd?step=86400&limit=1000&start=<unix>, paginated forward
 *          from 2011-08-18 (1000 candles/request) using each response's last
 *          timestamp to advance. `close` is the daily USD value.
 */

import type { DailyObservation } from '../types.js';
import { fetchJson, toUsd, unixToUtcDate, type PriceSource } from './types.js';

interface Ticker {
  last?: string;
}
interface OhlcResponse {
  data?: { ohlc?: Array<{ timestamp?: string; close?: string }> };
}

const TICKER_URL = 'https://www.bitstamp.net/api/v2/ticker/btcusd/';
const OHLC_BASE = 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=';
// Single-request recent window for the quorum recent-fill path (spec 3.3).
const OHLC_RECENT_URL = 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=15';
// 2011-08-18 UTC — Bitstamp's first daily candle.
const HISTORY_START_UNIX = Math.floor(Date.UTC(2011, 7, 18) / 1000);
const PAGE_CAP = 40;
const DAY = 86_400;

/** Map a Bitstamp OHLC candle list to a sorted daily series (close = USD). */
function parseOhlc(ohlc: Array<{ timestamp?: string; close?: string }>): DailyObservation[] {
  const byDate = new Map<string, number>();
  for (const c of ohlc) {
    const ts = Number(c.timestamp);
    const close = Number(c.close);
    if (!Number.isFinite(ts) || !(close > 0)) continue;
    byDate.set(unixToUtcDate(ts), close);
  }
  return [...byDate.entries()]
    .map(([date, usd]) => ({ date, usd }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function createBitstampSource(): PriceSource {
  return {
    name: 'bitstamp',
    kinds: ['spot', 'history'],
    async fetchSpot(): Promise<number> {
      const t = await fetchJson<Ticker>(TICKER_URL, { timeoutMs: 4000 });
      return toUsd(t.last);
    },
    async fetchRecentHistory(): Promise<DailyObservation[]> {
      const resp = await fetchJson<OhlcResponse>(OHLC_RECENT_URL);
      return parseOhlc(resp.data?.ohlc ?? []);
    },
    async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
      const byDate = new Map<string, number>();
      let start = HISTORY_START_UNIX;
      const nowUnix = Math.floor(Date.now() / 1000);
      for (let page = 0; page < PAGE_CAP; page++) {
        const resp = await fetchJson<OhlcResponse>(OHLC_BASE + String(start));
        const ohlc = resp.data?.ohlc ?? [];
        if (ohlc.length === 0) break;
        let maxTs = start;
        for (const c of ohlc) {
          const ts = Number(c.timestamp);
          const close = Number(c.close);
          if (!Number.isFinite(ts) || !(close > 0)) continue;
          byDate.set(unixToUtcDate(ts), close);
          if (ts > maxTs) maxTs = ts;
        }
        if (maxTs >= nowUnix - DAY || ohlc.length < 1000) break;
        start = maxTs + DAY;
      }
      const out: DailyObservation[] = [...byDate.entries()]
        .map(([date, usd]) => ({ date, usd }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      return fromDate ? out.filter((r) => r.date >= fromDate) : out;
    },
  };
}
