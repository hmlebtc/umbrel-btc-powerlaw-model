/**
 * blockchain.info — the primary full-history source (spec sections 3.3/3.4).
 *
 * `charts/market-price?timespan=all&sampled=false` returns one edge-cached JSON
 * blob of { values: [{ x: unixSeconds, y: avgUsd }] }. `sampled=false` is
 * LOAD-BEARING: without it the endpoint returns a ~4-day-sampled grid (~1600
 * pts); with it, TRUE DAILY data on a strict 1-day grid (live-verified 6,398
 * points, 2009-01-03 -> today). We drop y<=0 rows (the unpriced 2009->mid-2010
 * era) and map to {date, usd}. History only — no spot endpoint.
 */

import type { DailyObservation } from '../types.js';
import { fetchJson, unixToUtcDate, type PriceSource } from './types.js';

interface MarketPriceResponse {
  values?: Array<{ x?: number; y?: number }>;
}

const ALL_URL =
  'https://api.blockchain.info/charts/market-price?timespan=all&sampled=false&format=json';

/** Parse a market-price payload into a priced daily series (drop y<=0). */
export function parseMarketPrice(resp: MarketPriceResponse): DailyObservation[] {
  const values = Array.isArray(resp.values) ? resp.values : [];
  const out: DailyObservation[] = [];
  for (const v of values) {
    const x = typeof v.x === 'number' ? v.x : NaN;
    const y = typeof v.y === 'number' ? v.y : NaN;
    if (!Number.isFinite(x) || !(y > 0)) continue;
    out.push({ date: unixToUtcDate(x), usd: y });
  }
  return out;
}

export function createBlockchainInfoSource(): PriceSource {
  return {
    name: 'blockchainInfo',
    kinds: ['history'],
    async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
      const resp = await fetchJson<MarketPriceResponse>(ALL_URL);
      const rows = parseMarketPrice(resp);
      return fromDate ? rows.filter((r) => r.date >= fromDate) : rows;
    },
  };
}
