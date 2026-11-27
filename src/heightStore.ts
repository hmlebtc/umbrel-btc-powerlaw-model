/**
 * Canonical daily block-height series (v0.2.0 spec section 3) — /data/heights.json.
 *
 * DEFINITION OF h. `h(D)` = TRUE chain height of the last block mined on UTC day D
 * (genesis = height 0). Coin Metrics' cumulative BlkCnt (genesis not counted) runs a
 * few blocks ahead of that, so the `coinmetrics` days are stored as
 * `cumulative - offset`, floored at 0, where `offset` is the bundled snapshot's
 * measured constant SNAPSHOT_HEIGHT_OFFSET (persisted in heights.json as the basis
 * the days are on). It is NEVER adjusted dynamically: the mempool.space "last block
 * at or before 00:00Z of D+1" lookup is a diagnostic only (one activity event when
 * two consecutive complete days both disagree with the basis); history is not
 * rewritten because of it. A legacy file with no `offset` is raw cumulative and is
 * migrated once. Seed days, interpolated days and the live tip are already true
 * heights and are never offset again. Each
 * `coinmetrics` day also keeps its Coin Metrics PriceUSD close (`usd`) when it had
 * one — the completed-close sample (`completedCloses()`) the Refraction fit uses.
 * Today is never stored; today's provisional height is the live tip (`tip()`).
 *
 * Like the price store this is multi-source and never silently overwrites:
 *   - reconcilePrimary : Coin Metrics daily counts -> cumulative -> authoritative
 *     upsert (`src: 'coinmetrics'`), replacing any interpolated stand-in.
 *   - applyInterpolated: recent days after the primary's last date, linearly
 *     interpolated between the last authoritative (end of day, h) and (now, tip);
 *     flagged `interpolated`, replaced when the primary catches up.
 *   - seedMissing      : bundled-snapshot fallback when the primary is unreachable
 *     (`src: 'seed'`); fills gaps and interpolated stand-ins, never real data.
 *   - flagDivergent    : mempool.space difficulty epochs that disagree with the
 *     store by more than 50 blocks flag the day `divergent`; the stored value wins.
 * A commit-date guard (setMaxCommitDate) keeps TODAY out of every path.
 *
 * The pure logic (cumulative conversion, piecewise-linear fill plan, epoch
 * cross-check, tip median, dense series) is exported separately from the I/O so it
 * is unit-testable without a clock or a disk; reconcileHeights() composes it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SNAPSHOT_HEIGHT_OFFSET } from './fixtures/heights.js';
import { MAX_BLOCK_VALUE } from './sources/types.js';
import type {
  ApiHeights,
  BlockCountObservation,
  HeightClose,
  HeightEpoch,
  HeightObservation,
  HeightRecord,
  HeightStoreFile,
  HeightTip,
} from './types.js';

/** The genesis block's UTC day: the only valid first day of a cumulative series. */
export const HEIGHT_GENESIS_DATE = '2009-01-03';
/** Epoch-vs-store disagreement (blocks) above which a day is flagged `divergent` (spec 3.3.4). */
export const EPOCH_DIVERGENCE_BLOCKS = 50;
const DAY_MS = 86_400_000;
/** Sanity range for a persisted basis offset (blocks). */
export const OFFSET_MIN = 0;
export const OFFSET_MAX = 20;

// ---------------------------------------------------------------------------
// Date helpers (UTC `YYYY-MM-DD`; mirror the rest of the app)
// ---------------------------------------------------------------------------

/** ms of 00:00 UTC on `date`. */
export function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** ms of the END of UTC day `date` (= 00:00 UTC of the next day). */
export function dayEndMs(date: string): number {
  return dayStartMs(date) + DAY_MS;
}

export function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return utcDateOf(dayStartMs(date) + n * DAY_MS);
}

/** The UTC calendar day before `nowMs` — the latest date the store may commit. */
export function yesterdayOf(nowMs: number): string {
  return addDays(utcDateOf(nowMs), -1);
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export interface CumulativeResult {
  points: HeightObservation[];
  /** Why the series was empty or truncated; null when every input row was used. */
  problem: string | null;
}

/**
 * Convert daily block counts to RAW cumulative counts (no offset applied; the
 * reconcile pass subtracts the calibrated offset). A row's `usd` is carried through. Defensive by construction: the
 * series MUST start on the genesis day (else every height would be offset by the
 * unseen earlier blocks, so nothing is returned), duplicates keep the last row,
 * and the first calendar gap truncates the series there — a missing day would
 * silently under-count every later height, so the contiguous prefix is all that
 * is trusted (the recent-fill / epoch anchors cover the rest).
 */
export function cumulativeFromCounts(rows: readonly BlockCountObservation[]): CumulativeResult {
  const byDate = new Map<string, BlockCountObservation>();
  for (const r of rows) {
    if (typeof r.date === 'string' && Number.isInteger(r.count) && r.count >= 0) byDate.set(r.date, r);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return { points: [], problem: 'no usable block-count rows' };
  if (dates[0] !== HEIGHT_GENESIS_DATE) {
    return { points: [], problem: `series starts ${dates[0]}, expected ${HEIGHT_GENESIS_DATE}` };
  }
  const points: HeightObservation[] = [];
  let h = 0;
  let expected = HEIGHT_GENESIS_DATE;
  for (const date of dates) {
    if (date !== expected) {
      return { points, problem: `gap before ${date} (expected ${expected}); truncated` };
    }
    const row = byDate.get(date) as BlockCountObservation;
    h += row.count;
    points.push(row.usd !== undefined && row.usd > 0 ? { date, h, usd: row.usd } : { date, h });
    expected = addDays(date, 1);
  }
  return { points, problem: null };
}

/**
 * Incremental load (R4): extend the stored series from its base day with new daily
 * counts. True height is linear in the counts (h = cumulative - constant offset), so
 * h(D) = h(base) + the counts from base+1 through D — no offset needed, and a revised
 * count inside the overlap window is honoured because everything after the base is
 * recomputed. The rows must begin on the day after `baseDate` and be contiguous
 * (the first gap truncates, as in cumulativeFromCounts); rows on/before the base are
 * ignored. `baseH` must be > 0 (a floored early height cannot be extended).
 */
export function spliceCounts(baseDate: string, baseH: number, rows: readonly BlockCountObservation[]): CumulativeResult {
  if (!(baseH > 0)) return { points: [], problem: 'incremental base height is not positive' };
  const byDate = new Map<string, BlockCountObservation>();
  for (const r of rows) {
    if (typeof r.date === 'string' && r.date > baseDate && Number.isInteger(r.count) && r.count >= 0) byDate.set(r.date, r);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return { points: [], problem: 'no incremental rows after the stored base' };
  if (dates[0] !== addDays(baseDate, 1)) {
    return { points: [], problem: `incremental rows start ${dates[0]}, expected ${addDays(baseDate, 1)}` };
  }
  const points: HeightObservation[] = [];
  let h = baseH;
  let expected = addDays(baseDate, 1);
  for (const date of dates) {
    if (date !== expected) return { points, problem: `gap before ${date} (expected ${expected}); truncated` };
    const row = byDate.get(date) as BlockCountObservation;
    h += row.count;
    points.push(row.usd !== undefined && row.usd > 0 ? { date, h, usd: row.usd } : { date, h });
    expected = addDays(date, 1);
  }
  return { points, problem: null };
}

/** Cumulative point -> true height on offset `offset` (floored at 0). */
export function toTrueHeight(p: HeightObservation, offset: number): HeightObservation {
  const h = Math.max(0, p.h - offset);
  return p.usd !== undefined ? { date: p.date, h, usd: p.usd } : { date: p.date, h };
}

export interface HeightAnchor {
  /** Instant, ms since epoch. */
  t: number;
  h: number;
}

/** Piecewise-linear value at `t` through ascending-`t` anchors (clamped at the ends). */
export function interpolateAt(anchors: readonly HeightAnchor[], t: number): number {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!first || !last) return NaN;
  if (t <= first.t) return first.h;
  if (t >= last.t) return last.h;
  for (let i = 1; i < anchors.length; i++) {
    const b = anchors[i] as HeightAnchor;
    if (t <= b.t) {
      const a = anchors[i - 1] as HeightAnchor;
      return b.t === a.t ? b.h : a.h + ((b.h - a.h) * (t - a.t)) / (b.t - a.t);
    }
  }
  return last.h;
}

/**
 * Recent-fill plan (spec 3.3.2/3.3.3): the heights for every date after
 * `lastAuth.date` up to `maxDate`, linearly interpolated in time through the last
 * authoritative (end of day, h), any mempool epochs that fall strictly between
 * (kept only while the chain stays monotone and below the tip), and (tip.atMs,
 * tip.h). Values are rounded integers, non-decreasing. Empty when the tip is below
 * the last authoritative height or no date needs filling.
 */
export function planRecentFill(
  lastAuth: HeightObservation,
  tip: { h: number; atMs: number },
  epochs: readonly HeightEpoch[],
  maxDate: string,
): HeightObservation[] {
  if (tip.h < lastAuth.h) return [];
  const startT = dayEndMs(lastAuth.date);
  const anchors: HeightAnchor[] = [{ t: startT, h: lastAuth.h }];
  const sorted = [...epochs].sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    const t = e.time * 1000;
    const prev = anchors[anchors.length - 1] as HeightAnchor;
    if (t > prev.t && t < tip.atMs && e.height >= prev.h && e.height <= tip.h) {
      anchors.push({ t, h: e.height });
    }
  }
  anchors.push({ t: tip.atMs, h: tip.h });

  const out: HeightObservation[] = [];
  let floor = lastAuth.h;
  for (let d = addDays(lastAuth.date, 1); d <= maxDate; d = addDays(d, 1)) {
    const v = Math.max(floor, Math.round(interpolateAt(anchors, dayEndMs(d))));
    floor = v;
    out.push({ date: d, h: v });
  }
  return out;
}

export interface EpochDivergence {
  /** The UTC day containing the epoch's timestamp. */
  date: string;
  epochHeight: number;
  /** The store, linearly interpolated at the epoch's instant. */
  stored: number;
  /** epochHeight - stored. */
  diff: number;
}

/**
 * Cross-check (spec 3.3.4): for every epoch `{time, height}` whose instant lies
 * inside the stored range (the day and the day before it are both stored), compare
 * its height with the store interpolated at that instant; report those more than
 * `threshold` blocks apart.
 */
export function crossCheckEpochs(
  series: readonly HeightObservation[],
  epochs: readonly HeightEpoch[],
  threshold: number = EPOCH_DIVERGENCE_BLOCKS,
): EpochDivergence[] {
  const byDate = new Map<string, number>();
  for (const p of series) byDate.set(p.date, p.h);
  const out: EpochDivergence[] = [];
  for (const e of epochs) {
    const tMs = e.time * 1000;
    if (!Number.isFinite(tMs) || !Number.isFinite(new Date(tMs).getTime())) continue;
    const date = utcDateOf(tMs);
    const cur = byDate.get(date);
    const prev = byDate.get(addDays(date, -1));
    if (cur === undefined || prev === undefined) continue;
    const stored = prev + ((cur - prev) * (tMs - dayStartMs(date))) / DAY_MS;
    const diff = e.height - stored;
    if (Math.abs(diff) > threshold) out.push({ date, epochHeight: e.height, stored: Math.round(stored), diff: Math.round(diff) });
  }
  return out;
}

/** Most extra blocks per elapsed day (and flat allowance) a plausible tip may add to the last authoritative height. */
export const TIP_MAX_BLOCKS_PER_DAY = 300;
export const TIP_FLAT_ALLOWANCE = 300;

/**
 * The window a tip must fall in (v0.2.0 R2): at least the last AUTHORITATIVE height
 * (interpolated days never count) and at most that height + 300 blocks per elapsed
 * day since the end of that day + 300. Without an authoritative day there is
 * nothing to anchor on, so only the global height bound applies.
 */
export function plausibleTipRange(lastAuth: HeightObservation | null, nowMs: number): { lo: number; hi: number } {
  if (!lastAuth) return { lo: 0, hi: MAX_BLOCK_VALUE };
  const elapsedDays = Math.max(0, (nowMs - dayEndMs(lastAuth.date)) / DAY_MS);
  return { lo: lastAuth.h, hi: Math.floor(lastAuth.h + TIP_MAX_BLOCKS_PER_DAY * elapsedDays + TIP_FLAT_ALLOWANCE) };
}

/**
 * Tip (spec 3.3.5 + R2): median of the answers that are integers inside [minH, maxH].
 * One answer is enough. Null when none qualifies. An even count takes the LOWER
 * middle value (never a mean: one bad answer must not be able to drag it).
 */
export function tipMedian(values: readonly number[], minH = 0, maxH = MAX_BLOCK_VALUE): number | null {
  const ok = values.filter((v) => Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v >= minH && v <= maxH);
  if (ok.length === 0) return null;
  const s = [...ok].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1] as number;
}

/**
 * Dense daily array for the API: every date from the first to the last stored
 * day, with any interior gap linearly interpolated (rounded) so the client can
 * index by `date - start`. Null for an empty series.
 */
export function denseHeights(series: readonly HeightObservation[]): { start: string; end: string; heights: number[] } | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return null;
  const heights: number[] = [];
  let prev = first;
  heights.push(first.h);
  for (let i = 1; i < series.length; i++) {
    const cur = series[i] as HeightObservation;
    const gap = Math.round((dayStartMs(cur.date) - dayStartMs(prev.date)) / DAY_MS);
    for (let k = 1; k < gap; k++) heights.push(Math.round(prev.h + ((cur.h - prev.h) * k) / gap));
    heights.push(cur.h);
    prev = cur;
  }
  return { start: first.date, end: last.date, heights };
}

// ---------------------------------------------------------------------------
// Store (thin I/O around a Map)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date (rejects `2026-02-30`, `zz`, `2026-1-1`). */
export function isIsoDate(date: string): boolean {
  if (!ISO_DATE_RE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && utcDateOf(ms) === date;
}

/**
 * Per-record load validation (R8): ISO date key that round-trips, integer
 * `0 <= h <= 1e8`, string `src`, `flags` (if present) an array of strings, `usd`
 * (if present) a positive finite number. Returns a clean copy with only the known
 * fields, or null to drop the record.
 */
export function validRecord(date: string, rec: unknown): HeightRecord | null {
  if (!isIsoDate(date) || !rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.h !== 'number' || !Number.isInteger(r.h) || r.h < 0 || r.h > MAX_BLOCK_VALUE) return null;
  if (typeof r.src !== 'string') return null;
  const out: HeightRecord = { h: r.h, src: r.src };
  if (r.usd !== undefined) {
    if (typeof r.usd !== 'number' || !Number.isFinite(r.usd) || r.usd <= 0) return null;
    out.usd = r.usd;
  }
  if (r.flags !== undefined) {
    if (!Array.isArray(r.flags) || !r.flags.every((f) => typeof f === 'string')) return null;
    if (r.flags.length > 0) out.flags = [...(r.flags as string[])];
  }
  return out;
}

export class HeightStore {
  private days = new Map<string, HeightRecord>();
  private updatedAt = new Date(0).toISOString();
  private tipValue: HeightTip | null = null;
  /** Persisted cumulative-minus-height offset the coinmetrics days are on; null = never calibrated (raw counts, offset 0). */
  private offsetValue: number | null = null;
  /** ms of the last successful FULL Coin Metrics load (R4 integrity pass); null = never / force a full load. */
  private fullLoadAtValue: number | null = null;
  /** Diagnostic offsets already announced (R7: at most one event per distinct value). */
  private noticed = new Set<number>();
  /** Inclusive upper bound on committable dates; null = no bound. */
  private maxDate: string | null = null;

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'heights.json') : null;
  }

  /** Inclusive latest committable date (typically yesterday); today is never stored. */
  setMaxCommitDate(maxInclusive: string | null): void {
    this.maxDate = maxInclusive;
  }

  private withinBound(date: string): boolean {
    return this.maxDate === null || date <= this.maxDate;
  }

  has(date: string): boolean {
    return this.days.has(date);
  }

  get(date: string): HeightRecord | undefined {
    return this.days.get(date);
  }

  count(): number {
    return this.days.size;
  }

  private isInterpolated(rec: HeightRecord): boolean {
    return rec.flags?.includes('interpolated') === true;
  }

  /**
   * Authoritative upsert of a cumulative series (spec 3.3.1): adds missing days and
   * REPLACES existing ones (interpolated stand-ins, seed values, stale flags).
   * `revised` counts days the same source previously stored with a different h —
   * a past value changing deserves a log line.
   */
  reconcilePrimary(
    points: readonly HeightObservation[],
    src: string,
    opts: { keepUsd?: boolean } = {},
  ): { added: number; updated: number; revised: number } {
    // keepUsd: the source answered counts only (BlkCnt fallback), so a missing close
    // means "not requested", not "no close": keep what the day already has.
    const usdOf = (p: HeightObservation): number | undefined => {
      if (p.usd !== undefined && p.usd > 0) return p.usd;
      return opts.keepUsd ? this.days.get(p.date)?.usd : undefined;
    };
    const withUsd = (p: HeightObservation): HeightRecord => {
      const u = usdOf(p);
      return u !== undefined ? { h: p.h, src, usd: u } : { h: p.h, src };
    };
    let added = 0;
    let updated = 0;
    let revised = 0;
    for (const p of points) {
      if (!Number.isFinite(p.h) || p.h < 0 || !this.withinBound(p.date)) continue;
      const existing = this.days.get(p.date);
      if (!existing) added++;
      else if (
        existing.h !== p.h ||
        existing.src !== src ||
        existing.usd !== usdOf(p) ||
        this.isInterpolated(existing)
      ) {
        updated++;
        if (existing.src === src && existing.h !== p.h) revised++;
      }
      this.days.set(p.date, withUsd(p));
    }
    return { added, updated, revised };
  }

  /**
   * Fallback seed (spec 3.3.3): add snapshot days that are MISSING, and replace
   * interpolated stand-ins (a real count beats an estimate); never touch an
   * existing authoritative or seed value. Returns how many were written.
   */
  seedMissing(points: readonly HeightObservation[], src = 'seed'): number {
    let n = 0;
    for (const p of points) {
      if (!this.withinBound(p.date)) continue;
      const existing = this.days.get(p.date);
      if (existing && !this.isInterpolated(existing)) continue;
      this.days.set(p.date, { h: p.h, src });
      n++;
    }
    return n;
  }

  /**
   * Upsert interpolated recent days (spec 3.3.2): written only where the date is
   * missing or already an interpolated stand-in — real data is never overwritten.
   */
  applyInterpolated(points: readonly HeightObservation[], src = 'tip'): number {
    let n = 0;
    for (const p of points) {
      if (!this.withinBound(p.date)) continue;
      const existing = this.days.get(p.date);
      if (existing && !this.isInterpolated(existing)) continue;
      this.days.set(p.date, { h: p.h, src, flags: ['interpolated'] });
      n++;
    }
    return n;
  }

  /** The basis offset the stored `coinmetrics` days are on, or null for a legacy raw-cumulative file. */
  offset(): number | null {
    return this.offsetValue;
  }

  /**
   * One-time basis migration (R7, finding 19): move the stored days onto
   * `h = cumulative - newOffset` and persist `newOffset`. Days are on the persisted
   * offset, or raw cumulative (0) for a file written before offsets existed; such a
   * legacy file's `seed` days (an earlier build stored them raw too) migrate with it.
   * A no-op when the persisted offset already equals `newOffset` — the app never
   * calls this with anything but the snapshot constant. Returns days rewritten.
   */
  rebaseTo(newOffset: number): number {
    const legacy = this.offsetValue === null;
    const old = this.offsetValue ?? 0;
    let n = 0;
    if (old !== newOffset) {
      for (const rec of this.days.values()) {
        if (rec.src !== 'coinmetrics' && !(legacy && rec.src === 'seed')) continue;
        rec.h = Math.max(0, rec.h + old - newOffset);
        n++;
      }
    }
    this.offsetValue = newOffset;
    return n;
  }

  /** Remove every interpolated stand-in (R2: never keep stale estimates). Returns how many. */
  dropInterpolated(): number {
    let n = 0;
    for (const [date, rec] of [...this.days]) {
      if (this.isInterpolated(rec)) {
        this.days.delete(date);
        n++;
      }
    }
    return n;
  }

  /** Number of stored `coinmetrics` days. */
  coinMetricsDays(): number {
    let n = 0;
    for (const rec of this.days.values()) if (rec.src === 'coinmetrics') n++;
    return n;
  }

  /** Latest stored `coinmetrics` day, or null. */
  lastCoinMetricsDate(): string | null {
    let best: string | null = null;
    for (const [date, rec] of this.days) if (rec.src === 'coinmetrics' && (best === null || date > best)) best = date;
    return best;
  }

  fullLoadAt(): number | null {
    return this.fullLoadAtValue;
  }

  /** Record a successful full load (ms), or null to force the next load to be full. */
  setFullLoadAt(ms: number | null): void {
    this.fullLoadAtValue = ms;
  }

  /** True the first time `value` is announced (and remembers it, persisted). */
  noticeOffset(value: number): boolean {
    if (this.noticed.has(value)) return false;
    this.noticed.add(value);
    return true;
  }

  /**
   * Completed-close sample for the Refraction fit: every stored day that has BOTH a
   * Coin Metrics close and a non-interpolated height, ascending by date. (The engine
   * itself drops h <= 0 / usd <= 0.)
   */
  completedCloses(): HeightClose[] {
    const out: HeightClose[] = [];
    for (const [date, rec] of this.days) {
      if (rec.usd !== undefined && rec.usd > 0 && !this.isInterpolated(rec)) out.push({ date, usd: rec.usd, h: rec.h });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  /** Chronological `{date, h}` of the days whose height is NOT an interpolated stand-in. */
  confirmedHeights(): HeightObservation[] {
    const out: HeightObservation[] = [];
    for (const [date, rec] of this.days) if (!this.isInterpolated(rec)) out.push({ date, h: rec.h });
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  /** How many days `completedCloses()` would return. */
  closeCount(): number {
    let n = 0;
    for (const rec of this.days.values()) if (rec.usd !== undefined && rec.usd > 0 && !this.isInterpolated(rec)) n++;
    return n;
  }

  addFlag(date: string, flag: string): void {
    const rec = this.days.get(date);
    if (!rec) return;
    const flags = new Set(rec.flags ?? []);
    flags.add(flag);
    rec.flags = [...flags];
  }

  /** Flag each divergent day `divergent` (the stored value is kept). */
  flagDivergent(divergences: readonly EpochDivergence[]): void {
    for (const d of divergences) this.addFlag(d.date, 'divergent');
  }

  datesWithFlag(flag: string): string[] {
    const out: string[] = [];
    for (const [date, rec] of this.days) if (rec.flags?.includes(flag)) out.push(date);
    return out.sort();
  }

  /** Latest stored day that is NOT an interpolated stand-in. */
  lastAuthoritative(): HeightObservation | null {
    let best: HeightObservation | null = null;
    for (const [date, rec] of this.days) {
      if (this.isInterpolated(rec)) continue;
      if (best === null || date > best.date) best = { date, h: rec.h };
    }
    return best;
  }

  /** Height of the latest stored day of any kind (0 when empty). */
  lastStoredH(): number {
    const s = this.series();
    return s.length > 0 ? (s[s.length - 1] as HeightObservation).h : 0;
  }

  /** Chronological `{date, h}` series — the input a later phase fits against. */
  series(): HeightObservation[] {
    const out: HeightObservation[] = [];
    for (const [date, rec] of this.days) out.push(rec.usd !== undefined ? { date, h: rec.h, usd: rec.usd } : { date, h: rec.h });
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  latestDate(): string | null {
    let latest: string | null = null;
    for (const date of this.days.keys()) if (latest === null || date > latest) latest = date;
    return latest;
  }

  setTip(height: number, atMs: number): void {
    this.tipValue = { height, at: new Date(atMs).toISOString() };
  }

  /** The latest accepted chain tip, or null when none has been seen. */
  tip(): HeightTip | null {
    return this.tipValue ? { ...this.tipValue } : null;
  }

  /** GET /api/heights payload, or null until at least one height is stored. */
  toApi(): ApiHeights | null {
    const dense = denseHeights(this.series());
    if (!dense) return null;
    return { start: dense.start, end: dense.end, count: dense.heights.length, heights: dense.heights, tip: this.tip() };
  }

  toFile(): HeightStoreFile {
    const days: Record<string, HeightRecord> = {};
    for (const [date, rec] of [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      days[date] = rec;
    }
    return {
      version: 1,
      updatedAt: this.updatedAt,
      days,
      ...(this.tipValue ? { tip: this.tipValue } : {}),
      ...(this.offsetValue !== null ? { offset: this.offsetValue } : {}),
      ...(this.fullLoadAtValue !== null ? { fullLoadAt: this.fullLoadAtValue } : {}),
      ...(this.noticed.size > 0 ? { offsetNoticed: [...this.noticed].sort((a, b) => a - b) } : {}),
    };
  }

  load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HeightStoreFile>;
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        const days = new Map<string, HeightRecord>();
        for (const [date, rec] of Object.entries(parsed.days)) {
          // R8: validate every record; a damaged one is dropped (the next reconcile
          // refills it and the next save writes the repaired file), never trusted.
          const clean = validRecord(date, rec);
          if (clean) days.set(date, clean);
        }
        this.days = days;
        this.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : this.updatedAt;
        const tip = parsed.tip;
        this.tipValue =
          tip && Number.isInteger(tip.height) && tip.height >= 0 && tip.height <= MAX_BLOCK_VALUE &&
          typeof tip.at === 'string' && Number.isFinite(Date.parse(tip.at))
            ? { height: tip.height, at: tip.at }
            : null;
        const off = parsed.offset;
        this.offsetValue = typeof off === 'number' && Number.isInteger(off) && off >= OFFSET_MIN && off <= OFFSET_MAX ? off : null;
        const fl = parsed.fullLoadAt;
        this.fullLoadAtValue = typeof fl === 'number' && Number.isFinite(fl) ? fl : null;
        this.noticed = new Set(
          Array.isArray(parsed.offsetNoticed) ? parsed.offsetNoticed.filter((v) => Number.isInteger(v)) : [],
        );
      }
    } catch {
      /* corrupt file -> start empty rather than crash */
    }
  }

  save(): void {
    const path = this.path();
    if (!path) return;
    this.updatedAt = new Date().toISOString();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toFile()), 'utf8');
      renameSync(tmp, path);
    } catch {
      /* best-effort persistence */
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration (pure given its inputs + a store; no network, no clock but nowMs)
// ---------------------------------------------------------------------------

export interface HeightInputs {
  /** Coin Metrics daily counts; null = source disabled or unreachable. */
  counts: readonly BlockCountObservation[] | null;
  /**
   * `full` (default): `counts` is the whole history from genesis. `incremental`:
   * `counts` is a window starting some days before the stored tail; it is spliced
   * onto the stored base day (see spliceCounts).
   */
  countsMode?: 'full' | 'incremental';
  epochs: readonly HeightEpoch[];
  /** Every successful tip answer (one per reachable tip source). */
  tips: readonly number[];
  /** Bundled snapshot (true heights), used only when `counts` is null/unusable. */
  seed: readonly HeightObservation[];
  /**
   * Diagnostic lookups: for each `date`, the chain height of the last block at or
   * before the END of that UTC day (00:00Z of date+1). They never change the stored
   * heights (R7); see HeightReconcileReport.offsetNotice.
   */
  lookups?: ReadonlyArray<{ date: string; height: number }>;
}

export interface HeightReconcileReport {
  primary: 'ok' | 'unreachable' | 'rejected';
  /** Why the primary was rejected or truncated (null when clean). */
  primaryProblem: string | null;
  mode: 'full' | 'incremental';
  added: number;
  updated: number;
  revised: number;
  seeded: number;
  interpolated: number;
  /** Interpolated stand-ins removed this run before re-planning (R2). */
  droppedInterpolated: number;
  tip: number | null;
  /** True when tip answers existed but none was plausible (R2). */
  tipRejected: boolean;
  /** The basis offset the coinmetrics days are stored on (always the snapshot constant). */
  offset: number;
  /** Days rewritten by the one-time legacy-basis migration. */
  rebased: number;
  /**
   * Set (once per distinct value) when the last two complete days BOTH measure an
   * offset different from the basis via the mempool lookup. Diagnostic only.
   */
  offsetNotice: { measured: number; basis: number; dates: string[] } | null;
  /** Days newly flagged `divergent` by this run (not already flagged before it). */
  newDivergences: EpochDivergence[];
}

/**
 * Should the next Coin Metrics fetch be the full history or an incremental window
 * (R4)? Full when the store has no Coin Metrics days, never completed a full load, or
 * the last one is 7 or more days old (integrity pass); otherwise incremental from 7
 * days before the last stored Coin Metrics day.
 */
export function planBlockCountFetch(store: HeightStore, nowMs: number): { mode: 'full' } | { mode: 'incremental'; startDate: string } {
  const last = store.lastCoinMetricsDate();
  const fullAt = store.fullLoadAt();
  if (last === null || fullAt === null || nowMs - fullAt >= 7 * DAY_MS || nowMs < fullAt) return { mode: 'full' };
  return { mode: 'incremental', startDate: addDays(last, -7) };
}

/**
 * One height reconcile pass (spec 3.3 + review R2/R4/R7): primary upsert (full, or
 * spliced incremental; else seed), tip (plausible only), recent fill, epoch
 * cross-check, offset diagnostic. `nowMs` is when the tips were observed. Never
 * throws on bad inputs; the job wraps it in try/catch regardless so a height problem
 * can never fail a refit.
 */
export function reconcileHeights(store: HeightStore, input: HeightInputs, nowMs: number): HeightReconcileReport {
  const maxDate = yesterdayOf(nowMs);
  store.setMaxCommitDate(maxDate);
  const flaggedBefore = new Set(store.datesWithFlag('divergent'));
  const mode = input.countsMode ?? 'full';
  const report: HeightReconcileReport = {
    primary: 'unreachable',
    primaryProblem: null,
    mode,
    added: 0,
    updated: 0,
    revised: 0,
    seeded: 0,
    interpolated: 0,
    droppedInterpolated: 0,
    tip: null,
    tipRejected: false,
    offset: SNAPSHOT_HEIGHT_OFFSET,
    rebased: 0,
    offsetNotice: null,
    newDivergences: [],
  };

  // Basis: always the snapshot constant; only a legacy raw file is migrated (once).
  report.rebased = store.rebaseTo(SNAPSHOT_HEIGHT_OFFSET);

  // 1. Primary (never a date on/after today: the store's bound drops them).
  let points: HeightObservation[] | null = null;
  if (input.counts !== null) {
    let cum: CumulativeResult;
    if (mode === 'incremental') {
      const rows = [...input.counts].sort((a, b) => (a.date < b.date ? -1 : 1));
      const first = rows[0];
      const baseDate = first ? addDays(first.date, -1) : null;
      const base = baseDate ? store.get(baseDate) : undefined;
      cum =
        baseDate && base && base.src === 'coinmetrics' && !(base.flags?.includes('interpolated'))
          ? spliceCounts(baseDate, base.h, rows)
          : { points: [], problem: 'incremental window has no stored base day' };
    } else {
      cum = cumulativeFromCounts(input.counts);
    }
    report.primaryProblem = cum.problem;
    if (cum.points.length > 0) {
      points = cum.points.map((p) => (mode === 'incremental' ? p : toTrueHeight(p, SNAPSHOT_HEIGHT_OFFSET)));
      report.primary = 'ok';
      // A series with no close at all is the BlkCnt-only fallback: keep stored closes.
      const r = store.reconcilePrimary(points, 'coinmetrics', { keepUsd: !points.some((p) => p.usd !== undefined) });
      report.added = r.added;
      report.updated = r.updated;
      report.revised = r.revised;
      if (mode === 'full') store.setFullLoadAt(nowMs);
    } else {
      report.primary = 'rejected';
      if (mode === 'incremental') store.setFullLoadAt(null); // heal with a full load next time
    }
  }

  // 3. Fallback seed when the primary gave nothing usable (no-op if the store is full).
  if (report.primary !== 'ok') report.seeded = store.seedMissing(input.seed);

  // 5. Tip (R2): plausible answers only, measured against the last AUTHORITATIVE day.
  const lastAuth = store.lastAuthoritative();
  const range = plausibleTipRange(lastAuth, nowMs);
  const tip = tipMedian(input.tips, range.lo, range.hi);
  if (tip !== null) {
    report.tip = tip;
    store.setTip(tip, nowMs);
  } else if (input.tips.length > 0) {
    report.tipRejected = true;
  }

  // 2/3. Recent fill from the last authoritative day to the tip. Interpolated days are
  // rebuilt from scratch every run: with no plausible tip they are dropped rather than
  // kept stale (R2), and a rebuilt series is monotone and never below the base (R2/F9).
  report.droppedInterpolated = store.dropInterpolated();
  if (tip !== null && lastAuth) {
    const plan = planRecentFill(lastAuth, { h: tip, atMs: nowMs }, input.epochs, maxDate);
    report.interpolated = store.applyInterpolated(plan);
  }

  // 4. Cross-check against mempool epochs; the stored value always wins.
  const divergences = crossCheckEpochs(store.series(), input.epochs);
  store.flagDivergent(divergences);
  report.newDivergences = divergences.filter((d) => !flaggedBefore.has(d.date));

  // R7 diagnostic: both of the last two complete days disagree with the basis.
  const want = [addDays(utcDateOf(nowMs), -1), addDays(utcDateOf(nowMs), -2)];
  const measured: number[] = [];
  for (const d of want) {
    const lk = input.lookups?.find((l) => l.date === d);
    const rec = store.get(d);
    if (lk && Number.isFinite(lk.height) && rec && rec.src === 'coinmetrics' && !rec.flags?.includes('interpolated')) {
      measured.push(SNAPSHOT_HEIGHT_OFFSET + (rec.h - lk.height));
    }
  }
  if (measured.length === 2 && measured.every((m) => m !== SNAPSHOT_HEIGHT_OFFSET)) {
    const value = measured[0] as number; // yesterday's reading
    if (store.noticeOffset(value)) {
      report.offsetNotice = { measured: value, basis: SNAPSHOT_HEIGHT_OFFSET, dates: want };
    }
  }
  return report;
}
