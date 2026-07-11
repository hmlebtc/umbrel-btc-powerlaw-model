/**
 * Background timers (spec section 5).
 *
 * Three self-rescheduling setTimeout chains (no naive setInterval drift, all
 * unref'd):
 *   - refit       : first tick anchored to lastFitAt + refitIntervalHours (fires
 *                   at boot when overdue or never fit), then every interval; a
 *                   tick is skipped while a job is already running.
 *   - spot poll   : every spotPollMinutes.
 *   - daily-append: the first tick after 00:20 UTC each day (refetch folds the
 *                   previous UTC day's real close in).
 * The next-run arithmetic lives in the pure nextRefitAt()/nextDailyAppendAt()
 * helpers (unit-tested with an injected clock). reschedule() rebuilds every timer
 * when settings change.
 */

import type { EventLog } from './events.js';
import type { JobRunner, ModelStore } from './jobs.js';
import type { SpotAggregator } from './spot.js';
import type { Settings } from './types.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAILY_APPEND_MINUTES = 20; // 00:20 UTC

/**
 * Next refit timestamp: `lastFitAt + intervalHours`, clamped to `now` when that
 * is already in the past; `now` when never fit (run immediately at boot).
 */
export function nextRefitAt(lastFitAtMs: number | null, intervalHours: number, now: number): number {
  if (lastFitAtMs === null) return now;
  const next = lastFitAtMs + intervalHours * HOUR_MS;
  return next <= now ? now : next;
}

/** Next 00:20 UTC strictly after `now`. */
export function nextDailyAppendAt(now: number): number {
  const d = new Date(now);
  const target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    DAILY_APPEND_MINUTES,
    0,
    0,
  );
  return now < target ? target : target + DAY_MS;
}

export interface SchedulerDeps {
  getSettings: () => Settings;
  jobRunner: JobRunner;
  spot: SpotAggregator;
  modelStore: ModelStore;
  events: EventLog;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export class Scheduler {
  private refitTimer: NodeJS.Timeout | null = null;
  private spotTimer: NodeJS.Timeout | null = null;
  private appendTimer: NodeJS.Timeout | null = null;
  private lastDailyAppend: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.scheduleRefit(true);
    this.scheduleSpot();
    this.scheduleDailyAppend();
  }

  stop(): void {
    for (const t of [this.refitTimer, this.spotTimer, this.appendTimer]) {
      if (t) clearTimeout(t);
    }
    this.refitTimer = this.spotTimer = this.appendTimer = null;
  }

  /** Rebuild every timer (call after a settings change). */
  reschedule(): void {
    this.stop();
    this.start();
  }

  lastDailyAppendAt(): string | null {
    return this.lastDailyAppend;
  }

  /** ISO of the next anchored refit (for /api/status), or null when unknown. */
  nextRefitAtISO(): string | null {
    const fittedAt = this.deps.modelStore.current()?.fittedAt ?? null;
    const lastMs = fittedAt ? Date.parse(fittedAt) : null;
    const interval = this.deps.getSettings().refitIntervalHours;
    return new Date(nextRefitAt(lastMs, interval, this.now())).toISOString();
  }

  private setTimer(delay: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(fn, Math.max(0, delay));
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  private scheduleRefit(initial: boolean): void {
    let delay: number;
    if (initial) {
      const fittedAt = this.deps.modelStore.current()?.fittedAt ?? null;
      const lastMs = fittedAt ? Date.parse(fittedAt) : null;
      const interval = this.deps.getSettings().refitIntervalHours;
      delay = Math.max(0, nextRefitAt(lastMs, interval, this.now()) - this.now());
    } else {
      delay = this.deps.getSettings().refitIntervalHours * HOUR_MS;
    }
    this.refitTimer = this.setTimer(delay, () => {
      if (!this.deps.jobRunner.isRunning()) this.deps.jobRunner.start('refit');
      this.scheduleRefit(false);
    });
  }

  private scheduleSpot(): void {
    const delay = this.deps.getSettings().spotPollMinutes * MINUTE_MS;
    this.spotTimer = this.setTimer(delay, () => {
      void this.deps.spot.poll();
      this.scheduleSpot();
    });
  }

  private scheduleDailyAppend(): void {
    const delay = Math.max(0, nextDailyAppendAt(this.now()) - this.now());
    this.appendTimer = this.setTimer(delay, () => {
      this.lastDailyAppend = new Date(this.now()).toISOString();
      if (!this.deps.jobRunner.isRunning()) this.deps.jobRunner.start('refit');
      this.deps.events.add('daily-append', 'daily append tick (00:20 UTC)');
      this.scheduleDailyAppend();
    });
  }
}
