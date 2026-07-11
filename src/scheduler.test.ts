// Tests for scheduler.ts (spec section 5): the pure next-run arithmetic with an
// injected clock, plus nextRefitAtISO() anchoring.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EventLog } from './events.js';
import type { JobRunner, ModelStore } from './jobs.js';
import { nextDailyAppendAt, nextRefitAt, Scheduler } from './scheduler.js';
import { defaultSettings } from './settings.js';
import type { SpotAggregator } from './spot.js';
import type { FitRecord } from './types.js';

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// nextRefitAt: anchored to lastFitAt + interval, overdue -> now, never -> now.
// ---------------------------------------------------------------------------

test('nextRefitAt: never fit runs immediately (now)', () => {
  assert.equal(nextRefitAt(null, 12, 1000), 1000);
});

test('nextRefitAt: anchored to lastFitAt + interval when in the future', () => {
  assert.equal(nextRefitAt(0, 12, 1000), 12 * HOUR);
});

test('nextRefitAt: overdue clamps to now', () => {
  assert.equal(nextRefitAt(0, 12, 12 * HOUR + 1), 12 * HOUR + 1);
});

// ---------------------------------------------------------------------------
// nextDailyAppendAt: first 00:20 UTC strictly after now.
// ---------------------------------------------------------------------------

test('nextDailyAppendAt: before 00:20 UTC -> today 00:20', () => {
  const now = Date.UTC(2026, 6, 10, 0, 0, 0);
  assert.equal(nextDailyAppendAt(now), Date.UTC(2026, 6, 10, 0, 20, 0));
});

test('nextDailyAppendAt: after 00:20 UTC -> tomorrow 00:20', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  assert.equal(nextDailyAppendAt(now), Date.UTC(2026, 6, 11, 0, 20, 0));
});

test('nextDailyAppendAt: exactly at 00:20 UTC -> tomorrow (strictly after)', () => {
  const now = Date.UTC(2026, 6, 10, 0, 20, 0);
  assert.equal(nextDailyAppendAt(now), Date.UTC(2026, 6, 11, 0, 20, 0));
});

// ---------------------------------------------------------------------------
// nextRefitAtISO(): reflects the persisted fit + injected clock.
// ---------------------------------------------------------------------------

function stubDeps(fittedAt: string | null, now: number) {
  const modelStore = {
    current: (): FitRecord | null => (fittedAt ? ({ fittedAt } as FitRecord) : null),
  } as unknown as ModelStore;
  return {
    getSettings: () => defaultSettings(),
    jobRunner: { isRunning: () => false, start: () => ({ ok: true, jobId: 'x' }) } as unknown as JobRunner,
    spot: { poll: async () => null } as unknown as SpotAggregator,
    modelStore,
    events: { add: () => {} } as unknown as EventLog,
    now: () => now,
  };
}

test('nextRefitAtISO: anchors to lastFitAt + refitIntervalHours (default 12h)', () => {
  const fittedAt = '2026-07-10T00:00:00.000Z';
  const now = Date.parse(fittedAt) + HOUR; // 1h after the fit
  const sched = new Scheduler(stubDeps(fittedAt, now));
  const expected = new Date(Date.parse(fittedAt) + 12 * HOUR).toISOString();
  assert.equal(sched.nextRefitAtISO(), expected);
});

test('nextRefitAtISO: never fit -> now', () => {
  const now = Date.UTC(2026, 6, 10, 8, 0, 0);
  const sched = new Scheduler(stubDeps(null, now));
  assert.equal(sched.nextRefitAtISO(), new Date(now).toISOString());
});
