/**
 * Canonical daily price series (spec sections 3.1-3.3) — /data/prices.json.
 *
 * The store is the single source of truth for the model sample: a UTC-dated map
 * of { usd, src, flags }. Four fold paths bring source data in:
 *   - reconcilePrimary : blockchain.info full history; existing values are
 *     UPDATED when they change (authoritative refresh each refit).
 *   - applyRecentFill   : recent days assembled by the caller from Kraken /
 *     Bitstamp / Binance via resolveRecentDay() (quorum + `unconfirmed` flag).
 *   - fillMissing       : dates MISSING from the store but present in a secondary
 *     history series are ADDED with a `secondary` flag (gap fill on initial-sync
 *     / weekly cross-validation); existing dates are left to crossValidate.
 *   - crossValidate     : overlapping dates from a secondary source that diverge
 *     >5% keep the STORED value but gain a `divergent` flag (never silently
 *     dropped) and are returned for event logging.
 * A single commit-date guard (setMaxCommitDate) keeps TODAY out of the store
 * (spec 3.3): the primary's last point is today's lagging average and an
 * exchange's last candle is the in-progress day, so any date past the guard is
 * dropped by every fold path. Today is represented ONLY by the provisional spot
 * point derived at fit time from the spot median.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DailyObservation, DayRecord, PriceStoreFile } from './types.js';

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] as number) + (s[mid] as number)) / 2 : (s[mid] as number);
}

export interface RecentCandidate {
  src: string;
  usd: number;
}

export interface ResolvedDay {
  usd: number;
  src: string;
  flags: string[];
}

/**
 * Resolve a single recent day from the candidate source values (spec section
 * 3.3): accept when >=2 agree within 1% (no flag); a lone responder is accepted
 * with `unconfirmed`; >=2 that all disagree take the median but stay
 * `unconfirmed`. Returns null when nothing positive is available.
 */
export function resolveRecentDay(values: RecentCandidate[]): ResolvedDay | null {
  const pos = values.filter((v) => v.usd > 0);
  if (pos.length === 0) return null;
  if (pos.length === 1) {
    const only = pos[0] as RecentCandidate;
    return { usd: only.usd, src: only.src, flags: ['unconfirmed'] };
  }
  const med = median(pos.map((v) => v.usd));
  const agree = pos.filter((v) => Math.abs(v.usd - med) / med <= 0.01);
  if (agree.length >= 2) {
    return { usd: median(agree.map((v) => v.usd)), src: agree.map((v) => v.src).join('+'), flags: [] };
  }
  return { usd: med, src: pos.map((v) => v.src).join('+'), flags: ['unconfirmed'] };
}

export interface Divergence {
  date: string;
  stored: number;
  other: number;
  src: string;
}

const DIVERGENCE_THRESHOLD = 0.05;

export class PriceStore {
  private days = new Map<string, DayRecord>();
  private updatedAt = new Date(0).toISOString();
  /** Inclusive upper bound on committable dates; null = no bound (spec 3.3). */
  private maxDate: string | null = null;

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'prices.json') : null;
  }

  /**
   * Set the inclusive latest date the fold paths may commit (typically
   * yesterday). Dates past it — i.e. TODAY — are dropped so today only ever
   * enters the model as the provisional spot point (spec 3.3). null clears it.
   */
  setMaxCommitDate(maxInclusive: string | null): void {
    this.maxDate = maxInclusive;
  }

  private withinBound(date: string): boolean {
    return this.maxDate === null || date <= this.maxDate;
  }

  has(date: string): boolean {
    return this.days.has(date);
  }

  get(date: string): DayRecord | undefined {
    return this.days.get(date);
  }

  count(): number {
    return this.days.size;
  }

  /** Low-level upsert; overwrites value/src and (when provided) flags. */
  set(date: string, usd: number, src: string, flags?: string[]): void {
    if (!(usd > 0)) return;
    const rec: DayRecord = { usd, src };
    if (flags && flags.length > 0) rec.flags = [...new Set(flags)];
    this.days.set(date, rec);
  }

  addFlag(date: string, flag: string): void {
    const rec = this.days.get(date);
    if (!rec) return;
    const flags = new Set(rec.flags ?? []);
    flags.add(flag);
    rec.flags = [...flags];
  }

  private removeFlag(date: string, flag: string): void {
    const rec = this.days.get(date);
    if (!rec || !rec.flags) return;
    const flags = rec.flags.filter((f) => f !== flag);
    if (flags.length > 0) rec.flags = flags;
    else delete rec.flags;
  }

  /**
   * Fold an authoritative full-history series in: add missing days, update days
   * whose value changed (clearing a stale `unconfirmed` flag, since a primary
   * value now confirms them). Returns counts for logging.
   */
  reconcilePrimary(points: DailyObservation[], src: string): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const p of points) {
      if (!(p.usd > 0) || !this.withinBound(p.date)) continue;
      const existing = this.days.get(p.date);
      if (!existing) {
        this.days.set(p.date, { usd: p.usd, src });
        added++;
      } else if (existing.usd !== p.usd) {
        existing.usd = p.usd;
        existing.src = src;
        updated++;
        this.removeFlag(p.date, 'unconfirmed');
      }
    }
    return { added, updated };
  }

  /** Upsert caller-resolved recent days (carrying any `unconfirmed` flag). */
  applyRecentFill(resolved: Map<string, ResolvedDay>): number {
    let n = 0;
    for (const [date, r] of resolved) {
      if (!this.withinBound(date)) continue; // never commit today (spec 3.3)
      this.set(date, r.usd, r.src, r.flags);
      n++;
    }
    return n;
  }

  /**
   * Gap fill (spec 3.3): add dates PRESENT in a secondary history series but
   * MISSING from the store (and within the commit bound) with a `secondary`
   * flag. Existing dates are left untouched — crossValidate handles those. Runs
   * on initial-sync and the weekly cross-validation pass. Returns how many were
   * added.
   */
  fillMissing(points: DailyObservation[], src: string): number {
    let added = 0;
    for (const p of points) {
      if (!(p.usd > 0) || this.days.has(p.date) || !this.withinBound(p.date)) continue;
      this.days.set(p.date, { usd: p.usd, src, flags: ['secondary'] });
      added++;
    }
    return added;
  }

  /**
   * Cross-validate a secondary source against stored values: dates diverging
   * more than 5% keep the stored value but gain a `divergent` flag. Returns the
   * divergences so the caller can log an event (never silently dropped).
   */
  crossValidate(points: DailyObservation[], src: string): Divergence[] {
    const divergences: Divergence[] = [];
    for (const p of points) {
      const existing = this.days.get(p.date);
      if (!existing || !(existing.usd > 0) || !(p.usd > 0)) continue;
      const rel = Math.abs(existing.usd - p.usd) / existing.usd;
      if (rel > DIVERGENCE_THRESHOLD) {
        this.addFlag(p.date, 'divergent');
        divergences.push({ date: p.date, stored: existing.usd, other: p.usd, src });
      }
    }
    return divergences;
  }

  /** Chronological priced series (usd>0) for the model sample. */
  series(): DailyObservation[] {
    const out: DailyObservation[] = [];
    for (const [date, rec] of this.days) {
      if (rec.usd > 0) out.push({ date, usd: rec.usd });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  latestDate(): string | null {
    let latest: string | null = null;
    for (const date of this.days.keys()) {
      if (latest === null || date > latest) latest = date;
    }
    return latest;
  }

  toFile(): PriceStoreFile {
    const days: Record<string, DayRecord> = {};
    for (const [date, rec] of [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      days[date] = rec;
    }
    return { version: 1, updatedAt: this.updatedAt, days };
  }

  load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PriceStoreFile>;
      if (parsed && typeof parsed === 'object' && parsed.days) {
        this.days = new Map(Object.entries(parsed.days));
        this.updatedAt = parsed.updatedAt ?? this.updatedAt;
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
