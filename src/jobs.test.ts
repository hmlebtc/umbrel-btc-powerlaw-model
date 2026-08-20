// Tests for jobs.ts (spec section 5): single-flight start, and a full MOCK-backed
// refit that fits the fixture (points, corridor, provisional spot) and reports
// progress/summary. Network is never touched — the mock sources serve fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from './events.js';
import { HISTORY_FIXTURE } from './fixtures/history.js';
import { JobRunner, JobStats, ModelStore } from './jobs.js';
import { PriceStore } from './priceStore.js';
import { defaultSettings } from './settings.js';
import { createMockSources, SourceRegistry, type PriceSource } from './sources/types.js';
import { SpotAggregator } from './spot.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await delay(15);
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `n` whole UTC days before today. The recent-fill window is measured against
 * the WALL CLOCK (jobs.ts RECENT_WINDOW_DAYS), so a test that exercises it has
 * to place its days relative to today — hard-coded dates silently fall out of
 * the window as the fixture ages and the fill path stops being reached at all.
 */
function daysAgoUtc(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function build(sources?: PriceSource[]) {
  const registry = new SourceRegistry(sources ?? createMockSources());
  const priceStore = new PriceStore();
  const getSettings = () => defaultSettings();
  const spot = new SpotAggregator(registry, getSettings);
  const modelStore = new ModelStore();
  const jobStats = new JobStats();
  const events = new EventLog();
  const runner = new JobRunner({ registry, priceStore, spot, getSettings, modelStore, jobStats, events });
  return { runner, modelStore, priceStore };
}

/** Run one refit to completion (done or error). */
async function runToCompletion(runner: JobRunner): Promise<void> {
  runner.start('refit');
  await waitFor(() => runner.last() !== null && runner.last()!.state !== 'running');
}

test('JobRunner: a second start while one runs returns 409-style {ok:false}', async () => {
  const { runner } = build();
  const first = runner.start('refit');
  assert.equal(first.ok, true);
  const second = runner.start('refit');
  assert.equal(second.ok, false);
  if (!second.ok) assert.ok(second.error.length > 0);
  await waitFor(() => !runner.isRunning());
});

test('JobRunner: a full MOCK refit fits the fixture in-corridor with a provisional spot', async () => {
  const { runner, modelStore, priceStore } = build();
  const started = runner.start('refit');
  assert.equal(started.ok, true);
  await waitFor(() => runner.last() !== null && runner.last()!.state !== 'running');

  const last = runner.last()!;
  assert.equal(last.state, 'done', last.error ?? '');
  assert.equal(last.pct, 100);
  assert.equal(last.etaSeconds, 0);
  assert.equal(typeof last.summary, 'string');

  const m = modelStore.current();
  assert.ok(m, 'a fit should be persisted');
  assert.ok(m!.n >= 5.3 && m!.n <= 6.1, `n=${m!.n}`);
  assert.ok(m!.r2 >= 0.93, `r2=${m!.r2}`);
  // Unsampled (sampled=false) fixture is TRUE daily data -> ~5,800 priced points.
  assert.ok(m!.points >= 5800, `points=${m!.points}`);
  assert.equal(m!.includesProvisionalSpot, true);
  assert.ok(priceStore.count() >= 5800, `count=${priceStore.count()}`);
  // history is recorded newest-first.
  assert.equal(modelStore.history()[0]!.fittedAt, m!.fittedAt);
});

test('JobRunner: a quantileRegression refit persists the ladder to model.json (spec 15.2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-qr-model-'));
  try {
    const registry = new SourceRegistry(createMockSources());
    const priceStore = new PriceStore();
    const getSettings = () => ({ ...defaultSettings(), bandMode: 'quantileRegression' as const });
    const spot = new SpotAggregator(registry, getSettings);
    const modelStore = new ModelStore(dir); // persists to <dir>/model.json
    const jobStats = new JobStats();
    const events = new EventLog();
    const runner = new JobRunner({ registry, priceStore, spot, getSettings, modelStore, jobStats, events });
    await runToCompletion(runner);
    assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');

    const rec = modelStore.current()!;
    assert.equal(rec.bandMode, 'quantileRegression');
    assert.ok(rec.bandLines, 'the record must carry the ladder');

    // It survives the JSON round-trip to disk (a fresh store reads it back).
    const reloaded = new ModelStore(dir).current()!;
    assert.deepEqual(reloaded.bandLines, rec.bandLines);
    assert.equal(Object.keys(reloaded.bandLines!).length, 11);
    // Fallback offsets are persisted alongside it, unchanged in shape.
    assert.equal(Object.keys(reloaded.bandOffsets).length, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F2: TODAY is never committed; it enters the fit only as the provisional spot.
// ---------------------------------------------------------------------------

test('JobRunner: a today-dated candle is never committed; provisional spot is used (F2)', async () => {
  const today = todayUtc();
  // Make Kraken emit a candle dated TODAY on top of its recent slice.
  const sources = createMockSources().map((s) => {
    if (s.name === 'kraken' && s.fetchDailyHistory) {
      const orig = s.fetchDailyHistory.bind(s);
      return {
        ...s,
        fetchDailyHistory: async (from?: string) => {
          const rows = await orig(from);
          rows.push({ date: today, usd: 99_999 });
          return rows;
        },
      };
    }
    return s;
  });
  const { runner, modelStore, priceStore } = build(sources);
  await runToCompletion(runner);

  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.equal(priceStore.has(today), false, 'today must never be committed to the store');
  assert.equal(modelStore.current()!.includesProvisionalSpot, true);
  // The fitted sample end is today (the provisional point), while the stored
  // series stops at yesterday.
  assert.equal(modelStore.current()!.dataEnd, today);
});

// ---------------------------------------------------------------------------
// F3a: recent-fill fans out to 3 sources in parallel with a per-day quorum.
// ---------------------------------------------------------------------------

test('gatherRecent: parallel Kraken/Bitstamp/Binance feed a per-day quorum (F3a)', async () => {
  // Inside the recent window (and never today, which is never committed).
  const dayA = daysAgoUtc(3);
  const dayB = daysAgoUtc(2);
  const sources = createMockSources().map((s) => {
    if (s.name === 'blockchainInfo') {
      // Primary stops before the recent window so there is a gap to fill.
      return { ...s, fetchDailyHistory: async () => HISTORY_FIXTURE.filter((o) => o.date < dayA).map((o) => ({ ...o })) };
    }
    if (s.name === 'kraken') {
      return { ...s, fetchDailyHistory: async () => [
        { date: dayA, usd: 60_000 },
        { date: dayB, usd: 61_000 },
      ] };
    }
    if (s.name === 'bitstamp') {
      // Agrees with Kraken on dayA within 1%; silent on dayB.
      return { ...s, fetchDailyHistory: async () => [{ date: dayA, usd: 60_200 }] };
    }
    if (s.name === 'binance' || s.name === 'mempoolSpace') {
      return { ...s, fetchDailyHistory: async () => [] };
    }
    return s;
  });
  const { runner, priceStore } = build(sources);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');

  // dayA: two sources within 1% -> quorum -> unflagged, median value.
  const a = priceStore.get(dayA)!;
  assert.equal(a.usd, 60_100);
  assert.equal(a.flags, undefined);
  // dayB: lone responder -> accepted but unconfirmed.
  const b = priceStore.get(dayB)!;
  assert.equal(b.usd, 61_000);
  assert.deepEqual(b.flags, ['unconfirmed']);
});

// ---------------------------------------------------------------------------
// F3c: refuse to record a fit when the sample is below the minimum.
// ---------------------------------------------------------------------------

test('JobRunner: refuses to record a fit when the sample has < 365 points (F3c)', async () => {
  const sources: PriceSource[] = [
    {
      name: 'blockchainInfo',
      kinds: ['history'],
      fetchDailyHistory: async () => HISTORY_FIXTURE.slice(0, 50).map((o) => ({ ...o })),
    },
    { name: 'coinbase', kinds: ['spot'], fetchSpot: async () => 60_000 },
    { name: 'kraken', kinds: ['spot'], fetchSpot: async () => 60_050 },
  ];
  const { runner, modelStore } = build(sources);
  await runToCompletion(runner);

  const last = runner.last()!;
  assert.equal(last.state, 'error');
  assert.match(last.error ?? '', /365|point/i);
  assert.equal(modelStore.current(), null, 'no garbage model must be persisted');
});

// ---------------------------------------------------------------------------
// F9: JobStats EMA keyed per job kind, with graceful legacy-file migration.
// ---------------------------------------------------------------------------

test('JobStats: EMA is per job kind so a slow initial-sync does not inflate refit ETA (F9)', () => {
  const js = new JobStats();
  assert.equal(js.estimateSeconds('refit'), 20); // default when empty
  js.recordDuration('initial-sync', 80); // a slow first sync
  assert.equal(js.estimateSeconds('refit'), 20, 'refit ETA must be unaffected');
  assert.equal(js.estimateSeconds('initial-sync'), 80);
  js.recordDuration('refit', 10);
  assert.equal(js.estimateSeconds('refit'), 10);
});

test('JobStats: migrates an old single-value jobstats.json into the refit EMA (F9)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-jobstats-'));
  try {
    writeFileSync(join(dir, 'jobstats.json'), JSON.stringify({ emaSeconds: 42, lastCrossValidateAt: 123 }));
    const js = new JobStats(dir);
    assert.equal(js.estimateSeconds('refit'), 42, 'legacy value seeds the refit EMA');
    assert.equal(js.estimateSeconds('initial-sync'), 20, 'initial-sync starts from the default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
