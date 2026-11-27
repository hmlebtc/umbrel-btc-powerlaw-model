/**
 * Glue between the Refraction engine (refraction.ts, pure) and the app's stores
 * (v0.2.0 spec 2.4 / 5.2 / 5.3): which closes feed the fit, and the "model now"
 * block served by /api/status. Kept out of jobs.ts / server.ts so both share one
 * definition of the sample and the height-now rule.
 */

import { addDays, dayEndMs, yesterdayOf } from './heightStore.js';
import type { HeightStore } from './heightStore.js';
import {
  REFRACTION_BLOCKS_PER_DAY,
  REFRACTION_MIN_POINTS,
  linePriceAt,
  percentileExact,
  percentileOf,
  type RefractionObservation,
} from './refraction.js';
import type { DailyObservation, PriceSeriesKind, RefractionRecord, StatusLastClose, StatusRefraction } from './types.js';

/** A live tip older than this is treated as stale and the height is projected instead. */
export const TIP_FRESH_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

export interface RefractionSample {
  sample: RefractionObservation[];
  priceSeries: PriceSeriesKind;
}

/** Coin Metrics closes may trail the canonical series by at most this many days (R3). */
export const MAX_CLOSE_LAG_DAYS = 3;

/**
 * The closes the Refraction fit uses (spec 2.4, review R3):
 *  - Coin Metrics closes with their true heights, when there are at least
 *    REFRACTION_MIN_POINTS of them AND the last one is no more than 3 days older than
 *    the last completed canonical close (a Coin Metrics series that stalled, or was
 *    cut short by a missing count, must not freeze the fit);
 *  - otherwise the app's canonical completed daily series (no provisional spot) joined
 *    on date with the stored heights, INCLUDING interpolated days (they are accurate to
 *    a few dozen blocks and keep the fit current);
 *  - if that join is too thin but a Coin Metrics series exists, that one (stale beats
 *    nothing; the job logs the staleness); otherwise null (no fit).
 */
export function buildRefractionSample(
  heightStore: HeightStore,
  canonical: () => readonly DailyObservation[],
): RefractionSample | null {
  const closes = heightStore.completedCloses();
  const canon = canonical();
  const lastCanon = canon.length > 0 ? (canon[canon.length - 1] as DailyObservation).date : null;
  const lastClose = closes.length > 0 ? (closes[closes.length - 1] as { date: string }).date : null;
  const cmUsable = closes.length >= REFRACTION_MIN_POINTS;
  const cmFresh = cmUsable && (lastCanon === null || (lastClose as string) >= addDays(lastCanon, -MAX_CLOSE_LAG_DAYS));
  if (cmFresh) return { sample: closes, priceSeries: 'coinmetrics' };

  const heights = new Map<string, number>();
  for (const p of heightStore.series()) heights.set(p.date, p.h);
  const joined: RefractionObservation[] = [];
  for (const o of canon) {
    const h = heights.get(o.date);
    if (h !== undefined && h > 0 && o.usd > 0) joined.push({ date: o.date, usd: o.usd, h });
  }
  if (joined.length >= REFRACTION_MIN_POINTS) return { sample: joined, priceSeries: 'canonical' };
  return cmUsable ? { sample: closes, priceSeries: 'coinmetrics' } : null;
}

/** Whole days the fit's last close lags behind yesterday (UTC); 0 when current. */
export function staleDaysOf(dataEnd: string, nowMs: number): number {
  const lag = Math.round((Date.parse(`${yesterdayOf(nowMs)}T00:00:00Z`) - Date.parse(`${dataEnd}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(lag) && lag > 0 ? lag : 0;
}

/** Fingerprint of a sample (count, sum of h, sum of usd) in input order. */
export function sampleChecksum(sample: readonly RefractionObservation[]): { n: number; sumH: number; sumUsd: number } {
  let sumH = 0;
  let sumUsd = 0;
  for (const o of sample) {
    sumH += o.h;
    sumUsd += o.usd;
  }
  return { n: sample.length, sumH, sumUsd };
}

/**
 * Height to evaluate "now" at: the live tip when the store has one observed within
 * TIP_FRESH_MS; else the last stored height plus 144 blocks per day elapsed since
 * the END of that stored day (fractional days count); else the fit's own last height
 * projected the same way.
 */
export function heightNow(
  heightStore: HeightStore,
  record: RefractionRecord,
  nowMs: number,
): { height: number; live: boolean } {
  const tip = heightStore.tip();
  if (tip && nowMs - Date.parse(tip.at) <= TIP_FRESH_MS && nowMs >= Date.parse(tip.at) - 60_000) {
    return { height: tip.height, live: true };
  }
  const series = heightStore.series();
  const last = series[series.length - 1];
  const baseH = last ? last.h : record.lastHeight;
  const baseEnd = last ? dayEndMs(last.date) : dayEndMs(record.dataEnd);
  const elapsedDays = Math.max(0, (nowMs - baseEnd) / DAY_MS);
  return { height: Math.round(baseH + REFRACTION_BLOCKS_PER_DAY * elapsedDays), live: false };
}

// Per-fit cache: the exact percentile needs the fit's closes and two sorts; /api/status
// is polled every 10 s. The cache is keyed on a checksum of the rebuilt sample (R10), so
// a store that changed under the same record (restart, revision) can never be served
// from a stale entry, and the exact inverse is used only for the fit's own sample.
interface Cached {
  lastClose?: StatusLastClose | null;
  sampleKey: string;
  sample: RefractionObservation[] | null;
  key: string;
  pct: number | null;
}
const cache = new WeakMap<RefractionRecord, Cached>();

function checksumKey(c: { n: number; sumH: number; sumUsd: number }): string {
  return `${c.n}|${c.sumH}|${c.sumUsd}`;
}

/** The rebuilt sample when it is the fit's own (same series, count and checksum), else null. */
function exactSample(
  record: RefractionRecord,
  heightStore: HeightStore,
  canonical: () => readonly DailyObservation[],
): { sample: RefractionObservation[]; key: string } | null {
  const built = buildRefractionSample(heightStore, canonical);
  if (!built || built.priceSeries !== record.priceSeries) return null;
  const sample = built.sample.filter((o) => o.date <= record.dataEnd);
  if (sample.length !== record.points) return null;
  const sum = sampleChecksum(sample);
  const want = record.sampleChecksum;
  if (want && checksumKey(want) !== checksumKey(sum)) return null;
  return { sample, key: checksumKey(sum) };
}

function cacheFor(record: RefractionRecord, ex: { sample: RefractionObservation[]; key: string } | null): Cached {
  const sampleKey = ex ? ex.key : 'grid';
  let c = cache.get(record);
  if (!c || c.sampleKey !== sampleKey) {
    c = { sampleKey, sample: ex ? ex.sample : null, key: '', pct: null };
    cache.set(record, c);
  }
  return c;
}

/**
 * The last close of the fitted sample with its EXACT percentile against that sample
 * and the 50th line at its height (B1). Null unless the rebuilt sample is provably
 * the fit's own (series, count and checksum all match): never a value computed from a
 * different sample. Cached per fit and sample checksum.
 */
export function lastCloseOf(
  record: RefractionRecord,
  heightStore: HeightStore,
  canonical: () => readonly DailyObservation[],
): StatusLastClose | null {
  const ex = record.sampleChecksum ? exactSample(record, heightStore, canonical) : null;
  if (!ex) return null;
  const c = cacheFor(record, ex);
  if (c.lastClose !== undefined) return c.lastClose;
  const last = ex.sample[ex.sample.length - 1];
  let out: StatusLastClose | null = null;
  if (last) {
    const pct = percentileExact(record, ex.sample, last.h, last.usd);
    const fairValue = linePriceAt(record, 50, last.h);
    if (Number.isFinite(pct) && Number.isFinite(fairValue)) {
      out = { date: last.date, usd: last.usd, height: last.h, percentile: pct, fairValue };
    }
  }
  c.lastClose = out;
  return out;
}

/** Percentile of `usd` at `h`: exact against the fit's closes when available, else the grid inverse. */
export function percentileNow(
  record: RefractionRecord,
  heightStore: HeightStore,
  canonical: () => readonly DailyObservation[],
  h: number,
  usd: number,
): number | null {
  const ex = exactSample(record, heightStore, canonical);
  const c = cacheFor(record, ex);
  const sampleKey = c.sampleKey;
  const key = `${sampleKey}|${Math.round(h)}|${usd}`;
  if (c.key === key) return c.pct;
  let pct = c.sample ? percentileExact(record, c.sample, h, usd) : NaN;
  if (!Number.isFinite(pct)) pct = percentileOf(record, h, usd);
  c.key = key;
  c.pct = Number.isFinite(pct) ? pct : null;
  return c.pct;
}

/** The `/api/status.refraction` block, or null if the lines are not finite at the height. */
export function buildRefractionStatus(
  record: RefractionRecord,
  heightStore: HeightStore,
  canonical: () => readonly DailyObservation[],
  spotUsd: number | null,
  nowMs: number,
): StatusRefraction | null {
  const { height, live } = heightNow(heightStore, record, nowMs);
  const fairValueNow = linePriceAt(record, 50, height);
  const floorNow = linePriceAt(record, 0.1, height);
  const anchorNow = linePriceAt(record, 5, height);
  const topNow = linePriceAt(record, 99.9, height);
  if (![fairValueNow, floorNow, anchorNow, topNow].every((v) => Number.isFinite(v))) return null;
  const hasSpot = spotUsd !== null && spotUsd > 0;
  return {
    heightNow: height,
    heightIsLive: live,
    staleDays: staleDaysOf(record.dataEnd, nowMs),
    lastClose: lastCloseOf(record, heightStore, canonical),
    fairValueNow,
    floorNow,
    anchorNow,
    topNow,
    deviationPct: hasSpot ? ((spotUsd - fairValueNow) / fairValueNow) * 100 : null,
    percentile: hasSpot ? percentileNow(record, heightStore, canonical, height, spotUsd) : null,
    b1: record.b1,
    c: record.c,
    points: record.points,
    dataEnd: record.dataEnd,
    priceSeries: record.priceSeries,
  };
}
