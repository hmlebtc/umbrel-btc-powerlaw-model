/**
 * Coin Metrics community API — daily block counts (v0.2.0 spec 3.2).
 *
 * `asset-metrics?assets=btc&metrics=BlkCnt,PriceUSD&frequency=1d&page_size=10000` returns
 *   { data: [{ asset, time: '2026-11-23T00:00:00.000000000Z', BlkCnt: '168' }, ...],
 *     next_page_url?: '...' }
 * Every number is a JSON STRING, a missing count is an absent key or an empty
 * string, rows are ascending within a page and pages run from the newest end. One
 * page of 10,000 rows covers the whole ~6.5k-day history, but `next_page_url` is
 * followed (capped) so a future history longer than a page still resolves. The
 * cumulative conversion lives in heightStore.ts (pure, tested).
 */

import type { BlockCountObservation } from '../types.js';
import { fetchJson, parseBlockCount, type BlockCountOptions, type PriceSource } from './types.js';

interface MetricsResponse {
  data?: Array<{ time?: unknown; BlkCnt?: unknown; PriceUSD?: unknown }>;
  next_page_url?: unknown;
}

const BASE_URL = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
/** Combined request (counts + closes) and the counts-only fallback (see fetchBlockCounts). */
const METRICS_COMBINED = 'BlkCnt,PriceUSD';
const METRICS_COUNTS_ONLY = 'BlkCnt';
/** The full ~650 KB history is generated server-side; give it room (one retry only). */
const FULL_TIMEOUT_MS = 30_000;
/** An incremental window is a few KB. */
const INCREMENTAL_TIMEOUT_MS = 10_000;

/** The request URL: full history, or only days on/after `startDate` (incremental). */
export function blockCountsUrl(metrics: string, startDate?: string): string {
  return (
    `${BASE_URL}?assets=btc&metrics=${metrics}&frequency=1d&page_size=10000` +
    (startDate ? `&start_time=${startDate}` : '')
  );
}
const MAX_PAGES = 5;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Parse one page of rows into `{date, count}`: the date is the UTC day of `time`,
 * rows whose count is missing/empty/non-numeric/negative are dropped (never
 * guessed), and a repeated date keeps its last row. Sorted ascending. `usd` is the
 * PriceUSD close when present and a positive number (it is absent before
 * 2010-07-18 and can be missing on the newest row); its absence never drops the row.
 */
export function parseBlockCounts(resp: MetricsResponse): BlockCountObservation[] {
  const rows = Array.isArray(resp.data) ? resp.data : [];
  const byDate = new Map<string, BlockCountObservation>();
  for (const r of rows) {
    const m = typeof r.time === 'string' ? DATE_RE.exec(r.time) : null;
    const count = parseBlockCount(r.BlkCnt);
    if (!m || count === null) continue;
    const usd = typeof r.PriceUSD === 'string' && r.PriceUSD.trim() === '' ? NaN : Number(r.PriceUSD);
    const obs: BlockCountObservation = { date: m[1] as string, count };
    if (r.PriceUSD != null && Number.isFinite(usd) && usd > 0) obs.usd = usd;
    byDate.set(obs.date, obs);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function createCoinMetricsSource(): PriceSource {
  const load = async (metrics: string, startDate: string | undefined): Promise<BlockCountObservation[]> => {
    const timeoutMs = startDate ? INCREMENTAL_TIMEOUT_MS : FULL_TIMEOUT_MS;
    const byDate = new Map<string, BlockCountObservation>();
    let url: string | null = blockCountsUrl(metrics, startDate);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const resp: MetricsResponse = await fetchJson<MetricsResponse>(url, { timeoutMs });
      for (const row of parseBlockCounts(resp)) byDate.set(row.date, row);
      const next: unknown = resp.next_page_url;
      url = typeof next === 'string' && next.startsWith('https://community-api.coinmetrics.io/') ? next : null;
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  };
  return {
    name: 'coinmetrics',
    kinds: ['height'],
    /**
     * Daily block counts (+ closes). Asks for `BlkCnt,PriceUSD` in one call; if that
     * fails (e.g. the community tier drops PriceUSD and answers 403) it retries with
     * `BlkCnt` alone so the counts are never lost — the rows then carry no `usd`.
     * `opts.startDate` makes it an incremental fetch.
     */
    async fetchBlockCounts(opts?: BlockCountOptions): Promise<BlockCountObservation[]> {
      try {
        return await load(METRICS_COMBINED, opts?.startDate);
      } catch {
        return await load(METRICS_COUNTS_ONLY, opts?.startDate);
      }
    },
  };
}
