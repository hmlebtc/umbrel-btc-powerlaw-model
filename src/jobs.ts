/**
 * Job runner + model/stats persistence (spec section 5).
 *
 * Two job kinds — `initial-sync` (first boot, no prices.json) and `refit`
 * (scheduled or manual) — share one pipeline of weighted steps:
 *   fetch-history (40) -> fetch-spot (10) -> reconcile (10) -> fit (30) -> persist (10).
 * `pct` is the sum of completed step weights; `etaSeconds` is the remaining-weight
 * share of an EMA over the last five run durations (default 20 s when empty).
 * start() is synchronous single-flight so POST /api/refit can 409 without
 * awaiting; the job runs on a macrotask. Every completed refit records a fit into
 * /data/model.json and logs an event with old->new (a, n, r2) deltas.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { EventLog } from './events.js';
import { fit } from './model.js';
import { PriceStore, resolveRecentDay, type RecentCandidate } from './priceStore.js';
import { isSourceEnabled, type SourceRegistry } from './sources/types.js';
import type { SpotAggregator } from './spot.js';
import type {
  DailyObservation,
  FitRecord,
  Job,
  JobKind,
  ModelStoreFile,
  Settings,
} from './types.js';

// ---------------------------------------------------------------------------
// Model persistence — /data/model.json (current + capped history, newest first).
// ---------------------------------------------------------------------------

const HISTORY_CAP = 200;

export class ModelStore {
  private data: ModelStoreFile = { current: null, history: [] };

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'model.json') : null;
  }

  current(): FitRecord | null {
    return this.data.current;
  }

  history(): FitRecord[] {
    return this.data.history;
  }

  record(rec: FitRecord): void {
    this.data.current = rec;
    this.data.history.unshift(rec);
    if (this.data.history.length > HISTORY_CAP) this.data.history.length = HISTORY_CAP;
    this.save();
  }

  load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModelStoreFile>;
      if (parsed && typeof parsed === 'object') {
        this.data = {
          current: parsed.current ?? null,
          history: Array.isArray(parsed.history) ? parsed.history.slice(0, HISTORY_CAP) : [],
        };
      }
    } catch {
      /* corrupt file -> start empty */
    }
  }

  save(): void {
    const path = this.path();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      renameSync(tmp, path);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Run-duration EMA + weekly cross-validation gate — /data/jobstats.json.
// ---------------------------------------------------------------------------

interface JobStatsFile {
  /** Run-duration EMA keyed by job kind so a slow first sync never inflates a
   * refit's ETA (spec F9). */
  emaByKind: Record<JobKind, number | null>;
  lastCrossValidateAt: number | null;
}

const EMA_ALPHA = 2 / 6; // EMA over ~5 samples
const DEFAULT_ESTIMATE_SEC = 20;
const WEEK_MS = 7 * 86_400_000;

export class JobStats {
  private data: JobStatsFile = {
    emaByKind: { 'initial-sync': null, refit: null },
    lastCrossValidateAt: null,
  };

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'jobstats.json') : null;
  }

  estimateSeconds(kind: JobKind): number {
    return this.data.emaByKind[kind] ?? DEFAULT_ESTIMATE_SEC;
  }

  recordDuration(kind: JobKind, seconds: number): void {
    const prev = this.data.emaByKind[kind];
    this.data.emaByKind[kind] =
      prev === null ? seconds : EMA_ALPHA * seconds + (1 - EMA_ALPHA) * prev;
    this.save();
  }

  shouldCrossValidate(kind: JobKind, now: number): boolean {
    if (kind === 'initial-sync') return true;
    const last = this.data.lastCrossValidateAt;
    return last === null || now - last > WEEK_MS;
  }

  markCrossValidated(now: number): void {
    this.data.lastCrossValidateAt = now;
    this.save();
  }

  load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        emaByKind?: Partial<Record<JobKind, unknown>>;
        emaSeconds?: unknown; // legacy single-value shape
        lastCrossValidateAt?: unknown;
      };
      const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      const emaByKind: Record<JobKind, number | null> = { 'initial-sync': null, refit: null };
      if (parsed.emaByKind && typeof parsed.emaByKind === 'object') {
        emaByKind['initial-sync'] = num(parsed.emaByKind['initial-sync']);
        emaByKind.refit = num(parsed.emaByKind.refit);
      } else if (typeof parsed.emaSeconds === 'number') {
        // Migrate the old single-value file: treat it as the refit EMA (spec F9).
        emaByKind.refit = parsed.emaSeconds;
      }
      this.data = { emaByKind, lastCrossValidateAt: num(parsed.lastCrossValidateAt) };
    } catch {
      /* start fresh */
    }
  }

  save(): void {
    const path = this.path();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      renameSync(tmp, path);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

interface StepDef {
  name: string;
  weight: number;
}

const STEPS: StepDef[] = [
  { name: 'fetch-history', weight: 40 },
  { name: 'fetch-spot', weight: 10 },
  { name: 'reconcile', weight: 10 },
  { name: 'fit', weight: 30 },
  { name: 'persist', weight: 10 },
];
const STEP_COUNT = STEPS.length;

/** Number of trailing days for which recent-fill candidates are gathered. */
const RECENT_WINDOW_DAYS = 10;

export interface JobDeps {
  registry: SourceRegistry;
  priceStore: PriceStore;
  spot: SpotAggregator;
  getSettings: () => Settings;
  modelStore: ModelStore;
  jobStats: JobStats;
  events: EventLog;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC calendar day before today — the latest date the store may commit. */
function yesterdayUtc(): string {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - 86_400_000).toISOString().slice(0, 10);
}

function fmtDeltas(prev: FitRecord | null, next: FitRecord): string {
  // 4 decimals on n and R2 so small parameter drift between refits is visible
  // (e.g. n=5.6209->5.6211), not rounded away (spec F5).
  const n = next.n.toFixed(4);
  const r2 = next.r2.toFixed(4);
  if (!prev) return `first fit: n=${n}, R2=${r2}, points=${next.points}`;
  return `n=${prev.n.toFixed(4)}->${n}, R2=${prev.r2.toFixed(4)}->${r2}, points=${next.points}`;
}

/** Sample size below which a fit is refused (spec 3.3 fit-safety). */
const MIN_FIT_POINTS = 365;

export class JobRunner {
  private jobCurrent: Job | null = null;
  private jobLast: Job | null = null;

  constructor(private readonly deps: JobDeps) {}

  current(): Job | null {
    return this.jobCurrent;
  }

  last(): Job | null {
    return this.jobLast;
  }

  isRunning(): boolean {
    return this.jobCurrent?.state === 'running';
  }

  /** Synchronous single-flight start; the job body runs on a macrotask. */
  start(kind: JobKind): { ok: true; jobId: string } | { ok: false; error: string } {
    if (this.isRunning()) return { ok: false, error: 'a job is already running' };
    const job: Job = {
      id: randomUUID(),
      kind,
      startedAt: new Date().toISOString(),
      state: 'running',
      step: STEPS[0]!.name,
      stepIndex: 0,
      stepCount: STEP_COUNT,
      pct: 0,
      etaSeconds: this.deps.jobStats.estimateSeconds(kind),
    };
    this.jobCurrent = job;
    setImmediate(() => {
      void this.execute(job);
    });
    return { ok: true, jobId: job.id };
  }

  private eta(completedWeight: number, kind: JobKind): number {
    const remaining = Math.max(0, 100 - completedWeight);
    return Math.round((remaining / 100) * this.deps.jobStats.estimateSeconds(kind));
  }

  private async gatherRecent(settings: Settings): Promise<Map<string, RecentCandidate[]>> {
    const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const byDate = new Map<string, RecentCandidate[]>();
    const add = (src: string, rows: DailyObservation[]): void => {
      for (const r of rows) {
        if (r.date < cutoff || !(r.usd > 0)) continue;
        const list = byDate.get(r.date) ?? [];
        list.push({ src, usd: r.usd });
        byDate.set(r.date, list);
      }
    };
    // Kraken (OHLC interval=1440), Bitstamp (limit=15) and Binance (limit=15) are
    // queried IN PARALLEL — not a stop-at-first chain — so every responder feeds
    // resolveRecentDay's per-day quorum (spec 3.3). Prefer each source's cheap
    // single-request recent window, falling back to fetchDailyHistory(cutoff).
    await Promise.all(
      ['kraken', 'bitstamp', 'binance'].map(async (name) => {
        const src = this.deps.registry.get(name);
        if (!src || !isSourceEnabled(settings, name)) return;
        if (!src.fetchRecentHistory && !src.fetchDailyHistory) return;
        try {
          const rows = await this.deps.registry.run(src, (s) =>
            s.fetchRecentHistory ? s.fetchRecentHistory() : s.fetchDailyHistory!(cutoff),
          );
          add(name, rows);
        } catch {
          /* health recorded by registry */
        }
      }),
    );
    return byDate;
  }

  private async gatherCrossValidation(
    settings: Settings,
  ): Promise<Array<{ src: string; points: DailyObservation[] }>> {
    const out: Array<{ src: string; points: DailyObservation[] }> = [];
    for (const name of ['bitstamp', 'binance', 'mempoolSpace']) {
      const src = this.deps.registry.get(name);
      if (!src?.fetchDailyHistory || !isSourceEnabled(settings, name)) continue;
      try {
        out.push({ src: name, points: await this.deps.registry.run(src, (s) => s.fetchDailyHistory!()) });
      } catch {
        /* health recorded by registry */
      }
    }
    return out;
  }

  private async execute(job: Job): Promise<void> {
    const settings = this.deps.getSettings();
    const startMs = Date.now();
    let completedWeight = 0;

    const enter = (idx: number): void => {
      job.stepIndex = idx;
      job.step = STEPS[idx]!.name;
      job.pct = completedWeight;
      job.etaSeconds = this.eta(completedWeight, job.kind);
    };
    const done = (idx: number): void => {
      completedWeight += STEPS[idx]!.weight;
      job.pct = completedWeight;
      job.etaSeconds = this.eta(completedWeight, job.kind);
    };

    try {
      // --- fetch-history ----------------------------------------------------
      enter(0);
      let history: DailyObservation[] = [];
      const primary = this.deps.registry.get('blockchainInfo');
      if (primary?.fetchDailyHistory && isSourceEnabled(settings, 'blockchainInfo')) {
        try {
          history = await this.deps.registry.run(primary, (s) => s.fetchDailyHistory!());
        } catch {
          /* fall back to whatever is in the store */
        }
      }
      const recent = await this.gatherRecent(settings);
      const crossValidate = this.deps.jobStats.shouldCrossValidate(job.kind, startMs);
      const crossSeries = crossValidate ? await this.gatherCrossValidation(settings) : [];
      done(0);

      // --- fetch-spot -------------------------------------------------------
      enter(1);
      const spot = await this.deps.spot.poll();
      done(1);

      // --- reconcile --------------------------------------------------------
      enter(2);
      // Never commit today: the primary's last point is today's lagging average
      // and an exchange's last candle is the in-progress day (spec 3.3). The
      // guard lives in ONE place — the store drops any date past yesterday in
      // every fold path — so today only enters the fit as the provisional spot.
      this.deps.priceStore.setMaxCommitDate(yesterdayUtc());
      if (history.length > 0) this.deps.priceStore.reconcilePrimary(history, 'blockchainInfo');
      const primaryLast = this.lastDate(history) ?? this.deps.priceStore.latestDate();
      const resolved = new Map<string, ReturnType<typeof resolveRecentDay>>();
      for (const [date, candidates] of recent) {
        // Only fill days the authoritative primary hasn't covered yet.
        if (primaryLast !== null && date <= primaryLast) continue;
        const r = resolveRecentDay(candidates);
        if (r) resolved.set(date, r);
      }
      const fill = new Map<string, { usd: number; src: string; flags: string[] }>();
      for (const [date, r] of resolved) if (r) fill.set(date, r);
      this.deps.priceStore.applyRecentFill(fill);
      for (const cs of crossSeries) {
        // Cross-validate EXISTING dates (flag-only), then gap-fill dates the
        // store is MISSING from this secondary series (spec 3.3 F3b).
        const divs = this.deps.priceStore.crossValidate(cs.points, cs.src);
        if (divs.length > 0) {
          this.deps.events.add('divergence', `${cs.src}: ${divs.length} date(s) diverge >5% from stored`);
        }
        const added = this.deps.priceStore.fillMissing(cs.points, cs.src);
        if (added > 0) {
          this.deps.events.add('backfill', `${cs.src}: filled ${added} missing date(s)`);
        }
      }
      if (crossValidate) this.deps.jobStats.markCrossValidated(startMs);
      done(2);

      // --- fit --------------------------------------------------------------
      enter(3);
      const series = this.deps.priceStore.series();
      const today = todayUtc();
      const sample: DailyObservation[] = series.map((o) => ({ ...o }));
      let includesProvisional = false;
      if (spot && spot.usd > 0 && !this.deps.priceStore.has(today)) {
        sample.push({ date: today, usd: spot.usd });
        includesProvisional = true;
      }
      // Refuse to record a garbage model when the sample is too thin (e.g. the
      // primary is down on first boot): fail the job, persist nothing (spec 3.3).
      if (sample.length < MIN_FIT_POINTS) {
        throw new Error(
          `refusing to record fit: sample has ${sample.length} point(s), need >= ${MIN_FIT_POINTS}`,
        );
      }
      const previous = this.deps.modelStore.current();
      const modelFit = fit(sample, settings.bandMode, includesProvisional);
      done(3);

      // --- persist ----------------------------------------------------------
      enter(4);
      this.deps.priceStore.save();
      const durationMs = Date.now() - startMs;
      const rec: FitRecord = {
        fittedAt: new Date().toISOString(),
        a: modelFit.a,
        n: modelFit.n,
        A: modelFit.A,
        r2: modelFit.r2,
        sigma: modelFit.sigma,
        points: modelFit.points,
        dataStart: modelFit.dataStart,
        dataEnd: modelFit.dataEnd,
        bandMode: modelFit.bandMode,
        bandOffsets: modelFit.bandOffsets,
        includesProvisionalSpot: modelFit.includesProvisionalSpot,
        durationMs,
      };
      this.deps.modelStore.record(rec);
      this.deps.jobStats.recordDuration(job.kind, durationMs / 1000);
      done(4);

      job.state = 'done';
      job.finishedAt = new Date().toISOString();
      job.pct = 100;
      job.etaSeconds = 0;
      job.step = 'done';
      job.summary = fmtDeltas(previous, rec);
      this.deps.events.add('refit', `${job.kind} complete: ${job.summary}`);
    } catch (e) {
      job.state = 'error';
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = new Date().toISOString();
      job.etaSeconds = 0;
      this.deps.events.add('refit', `${job.kind} failed: ${job.error}`);
    } finally {
      this.jobLast = job;
      this.jobCurrent = null;
    }
  }

  private lastDate(points: DailyObservation[]): string | null {
    let latest: string | null = null;
    for (const p of points) if (latest === null || p.date > latest) latest = p.date;
    return latest;
  }
}
