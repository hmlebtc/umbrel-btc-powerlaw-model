/**
 * Kraken — spot ticker + recent daily OHLC (spec sections 3.3/3.4).
 *
 * Spot:    Ticker?pair=XBTUSD -> result.XXBTZUSD.c[0] (last trade price).
 * History: OHLC?pair=XBTUSD&interval=1440 -> result.XXBTZUSD, each candle
 *          [time(sec), open, high, low, close, ...]; close is idx 4. Kraken only
 *          returns the last ~720 daily candles, so this is a recent-fill source.
 */

import type { DailyObservation } from '../types.js';
import { fetchJson, toUsd, unixToUtcDate, type PriceSource } from './types.js';

interface TickerResponse {
  result?: Record<string, { c?: [string, string] }>;
}
interface OhlcResponse {
  result?: Record<string, unknown>;
}

const TICKER_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
const OHLC_URL = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440';
const PAIR_KEY = 'XXBTZUSD';

export function createKrakenSource(): PriceSource {
  // One OHLC?interval=1440 call yields the last ~720 daily candles — this IS the
  // recent window, so both history entry points parse the same response.
  const fetchOhlc = async (): Promise<DailyObservation[]> => {
    const r = await fetchJson<OhlcResponse>(OHLC_URL);
    const rows = r.result?.[PAIR_KEY];
    if (!Array.isArray(rows)) throw new Error('kraken: missing OHLC result');
    const out: DailyObservation[] = [];
    for (const candle of rows as unknown[]) {
      if (!Array.isArray(candle)) continue;
      const ts = Number(candle[0]);
      const close = Number(candle[4]);
      if (!Number.isFinite(ts) || !(close > 0)) continue;
      out.push({ date: unixToUtcDate(ts), usd: close });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  };
  return {
    name: 'kraken',
    kinds: ['spot', 'history'],
    async fetchSpot(): Promise<number> {
      const r = await fetchJson<TickerResponse>(TICKER_URL, { timeoutMs: 4000 });
      const c = r.result?.[PAIR_KEY]?.c;
      if (!Array.isArray(c)) throw new Error('kraken: missing ticker result');
      return toUsd(c[0]);
    },
    async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
      const out = await fetchOhlc();
      return fromDate ? out.filter((x) => x.date >= fromDate) : out;
    },
    fetchRecentHistory: fetchOhlc,
  };
}
