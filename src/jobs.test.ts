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
import { HEIGHTS_SNAPSHOT_END, heightsFromSnapshot } from './fixtures/heights.js';
import { HeightStore } from './heightStore.js';
import { HEIGHT_FETCH_CAP_MS, JobRunner, JobStats, ModelStore, startupJobKind } from './jobs.js';
import { PriceStore } from './priceStore.js';
import { defaultSettings } from './settings.js';
import type { FitRecord, Settings } from './types.js';
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
    // Thirteen rungs since v0.1.7 (the 0.01%/99.99% envelope pair, spec 16.1).
    assert.equal(Object.keys(reloaded.bandLines!).length, 13);
    assert.ok('p0001' in reloaded.bandLines! && 'p9999' in reloaded.bandLines!);
    // Fallback offsets are persisted alongside it, unchanged in shape.
    assert.equal(Object.keys(reloaded.bandOffsets).length, 13);
    assert.ok('p0001' in reloaded.bandOffsets && 'p9999' in reloaded.bandOffsets);
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

// ---------------------------------------------------------------------------
// v0.2.0 block heights: fetched in parallel with the price history, reconciled
// inside the existing steps, and never able to fail the refit.
// ---------------------------------------------------------------------------

function buildWithHeights(sources?: PriceSource[], settingsFn: () => Settings = defaultSettings) {
  const registry = new SourceRegistry(sources ?? createMockSources());
  const priceStore = new PriceStore();
  const heightStore = new HeightStore();
  const getSettings = settingsFn;
  const spot = new SpotAggregator(registry, getSettings);
  const modelStore = new ModelStore();
  const jobStats = new JobStats();
  const events = new EventLog();
  const runner = new JobRunner({ registry, priceStore, heightStore, spot, getSettings, modelStore, jobStats, events });
  return { runner, heightStore, events, modelStore };
}

test('JobRunner (MOCK): a refit ends with a populated height store, a tip, and today never stored', async () => {
  const { runner, heightStore, modelStore } = buildWithHeights();
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.ok(modelStore.current());

  const series = heightStore.series();
  const snap = heightsFromSnapshot();
  assert.equal(series[0]!.date, '2009-01-03');
  assert.ok(series.length >= snap.length);
  // Authoritative days equal the snapshot; the last stored day is yesterday.
  assert.equal(heightStore.get(HEIGHTS_SNAPSHOT_END)!.src, 'coinmetrics');
  assert.equal(heightStore.latestDate(), daysAgoUtc(1));
  assert.equal(heightStore.has(todayUtc()), false);
  const tip = heightStore.tip();
  assert.ok(tip && tip.height >= series[series.length - 1]!.h);
  const api = heightStore.toApi()!;
  assert.equal(api.count, api.heights.length);
  // The job steps themselves are unchanged (5 steps).
  assert.equal(runner.last()!.stepCount, 5);
});

test('JobRunner: with every height source failing the refit still succeeds (seeded from the snapshot, no tip)', async () => {
  const boom = async (): Promise<never> => {
    throw new Error('height source down');
  };
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.fetchTipHeight) o.fetchTipHeight = boom;
    if (s.fetchEpochs) o.fetchEpochs = boom;
    if (s.fetchBlockCounts) o.fetchBlockCounts = boom;
    return o;
  });
  const { runner, heightStore, modelStore } = buildWithHeights(sources);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.ok(modelStore.current());
  assert.equal(heightStore.get('2020-05-11')!.src, 'seed');
  assert.equal(heightStore.tip(), null);
  assert.equal(heightStore.latestDate(), HEIGHTS_SNAPSHOT_END);
});

test('JobRunner: a throwing height reconcile is logged and never fails the refit', async () => {
  const { runner, heightStore, events, modelStore } = buildWithHeights();
  heightStore.setMaxCommitDate = () => {
    throw new Error('store exploded');
  };
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.ok(modelStore.current());
  assert.ok(events.list().some((e) => /heights: reconcile failed/.test(e.msg)));
});

test('JobRunner: coinmetrics disabled (manual mode) -> the primary is skipped and the seed is used', async () => {
  const manual = (): Settings => {
    const s = defaultSettings();
    s.sourceMode = 'manual';
    s.enabledSources.coinmetrics = false;
    return s;
  };
  const { runner, heightStore } = buildWithHeights(undefined, manual);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.equal(heightStore.get('2020-05-11')!.src, 'seed');
  assert.ok(heightStore.tip(), 'tip sources are still enabled');
});

test('JobRunner: without a height store the refit behaves as before (no height calls at all)', async () => {
  let calls = 0;
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.fetchTipHeight) o.fetchTipHeight = async () => { calls++; return 1; };
    if (s.fetchBlockCounts) o.fetchBlockCounts = async () => { calls++; return []; };
    return o;
  });
  const { runner } = build(sources);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done');
  assert.equal(calls, 0);
});

test('JobRunner (MOCK): the refit stores Coin Metrics closes on the true-height basis and calibrates offset 5', async () => {
  const { runner, heightStore } = buildWithHeights();
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.equal(heightStore.offset(), 5);
  assert.equal(heightStore.get(HEIGHTS_SNAPSHOT_END)!.h, 977_595);
  const sample = heightStore.completedCloses();
  assert.equal(sample.length, heightStore.closeCount());
  assert.ok(sample.length > 5000);
  assert.ok(sample.every((p) => p.usd > 0 && p.date < todayUtc()));
});

test('JobRunner: a failing calibration lookup never fails the refit; the default offset is used', async () => {
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.fetchLastBlockHeightBefore) o.fetchLastBlockHeightBefore = async () => { throw new Error('lookup down'); };
    return o;
  });
  const { runner, heightStore } = buildWithHeights(sources);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.equal(heightStore.offset(), 5);
});

// ---------------------------------------------------------------------------
// v0.2.0 Refraction fit inside the refit job (spec 5.2)
// ---------------------------------------------------------------------------

test('JobRunner (MOCK): the record carries a refraction fit on the Coin Metrics closes', async () => {
  const { runner, modelStore, events } = buildWithHeights();
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  const rec = modelStore.current()!;
  const r = rec.refraction!;
  assert.ok(r, 'refraction block missing');
  assert.equal(r.priceSeries, 'coinmetrics');
  assert.ok(r.points > 5000);
  assert.ok(Math.abs(r.b1 - 5.75) < 0.05, `b1 ${r.b1}`);
  assert.ok(Math.abs(r.c - 0.2087) < 0.005, `c ${r.c}`);
  assert.equal(r.gridPcts.length, r.gridOffsets.length);
  assert.ok(r.fitMs >= 0);
  // The power-law side is the usual record, and the activity event names the fit.
  assert.ok(rec.points >= 5800 && rec.n > 5);
  assert.ok(events.list().some((e) => /refraction b1=\d\.\d{4}, c=0\.\d{4} \(coinmetrics/.test(e.msg)));
  // R3: the mock prices end 2026-07-10, far behind yesterday: one event says so.
  assert.equal(events.list().filter((e) => /refraction fit ends 2026-07-10, \d+ days behind yesterday/.test(e.msg)).length, 1);
  assert.equal(r.sampleChecksum!.n, r.points);
  assert.equal(runner.last()!.stepCount, 5);
});

test('JobRunner: without Coin Metrics closes the refraction fit falls back to the canonical series', async () => {
  const { runner, modelStore, heightStore } = buildWithHeights();
  heightStore.completedCloses = () => [];
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  const r = modelStore.current()!.refraction!;
  assert.equal(r.priceSeries, 'canonical');
  assert.ok(r.points > 5000);
});

test('JobRunner: too little height data -> no refraction block, one event, power-law record intact', async () => {
  const { runner, modelStore, heightStore, events } = buildWithHeights();
  heightStore.completedCloses = () => [];
  heightStore.series = () => [];
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.equal(modelStore.current()!.refraction, undefined);
  assert.equal(events.list().filter((e) => /refraction skipped/.test(e.msg)).length, 1);
});

test('JobRunner: an engine failure is logged and the power-law record is still written as before', async () => {
  const { runner, modelStore, heightStore, events } = buildWithHeights();
  // 800 rows pass the sample-size gate but every h is 0, so the engine rejects them all.
  // (dated up to yesterday so the Coin Metrics series counts as fresh and is the one chosen)
  heightStore.completedCloses = () => Array.from({ length: 800 }, (_, i) => ({ date: daysAgoUtc(800 - i), usd: 100, h: 0 }));
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  const rec = modelStore.current()!;
  assert.equal(rec.refraction, undefined);
  assert.ok(rec.points >= 5800 && Number.isFinite(rec.n));
  assert.equal(events.list().filter((e) => /refraction fit failed/.test(e.msg)).length, 1);
  assert.ok(events.list().some((e) => /complete/.test(e.msg) && !/refraction b1/.test(e.msg)));
});

test('JobRunner: without a height store the record has no refraction block and no refraction event (v0.1.8)', async () => {
  const { runner, modelStore } = build();
  await runToCompletion(runner);
  const rec = modelStore.current()!;
  assert.equal('refraction' in rec, false);
});

// ---------------------------------------------------------------------------
// Review round 1 (R1, R2, R4, R5)
// ---------------------------------------------------------------------------

/** Run one more refit to completion (runToCompletion returns early when a previous job is already `last`). */
async function runAgain(runner: JobRunner): Promise<void> {
  const r = runner.start('refit');
  assert.equal(r.ok, true);
  await waitFor(() => !runner.isRunning());
}

test('R1: a blockchain.info history failure reaches "fail" even though its tip call succeeds on every refit', async () => {
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.name === 'blockchainInfo') {
      const first = s.fetchDailyHistory!;
      let n = 0;
      o.fetchDailyHistory = async (from?: string) => {
        if (n++ === 0) return first(from); // the first refit builds the model
        throw new Error('HTTP 503');
      };
    }
    return o;
  });
  const { runner, heightStore } = buildWithHeights(sources);
  const registry = (runner as unknown as { deps: { registry: SourceRegistry } }).deps.registry;
  await runToCompletion(runner);
  for (let i = 0; i < 3; i++) await runAgain(runner);
  const row = registry.statusRows(defaultSettings()).find((r) => r.name === 'blockchainInfo')!;
  assert.ok(row.consecutiveFailures >= 3, `consecutiveFailures ${row.consecutiveFailures}`);
  assert.ok(row.heightHealth && row.heightHealth.consecutiveFailures === 0 && row.heightHealth.lastOkAt);
  assert.ok(heightStore.tip(), 'height pipeline kept working');
});

test('R2 (job): a hostile tip source cannot poison the store, and honest runs keep working', async () => {
  const hostile = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.name === 'blockstream') o.fetchTipHeight = async () => 2_000_000_000;
    return o;
  });
  const { runner, heightStore } = buildWithHeights(hostile);
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done');
  // Two honest tips (mempool, blockchain.info) + one hostile: the median is honest.
  assert.ok(heightStore.tip()!.height < 1_000_000);
  assert.ok(heightStore.series().every((p) => p.h < 1_000_000));
});

test('R4 (job): the first refit loads the full history, later ones fetch incrementally from last day - 7', async () => {
  const asked: Array<string | undefined> = [];
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.fetchBlockCounts) {
      const inner = s.fetchBlockCounts;
      o.fetchBlockCounts = async (opts) => {
        asked.push(opts?.startDate);
        return inner(opts);
      };
    }
    return o;
  });
  const { runner, heightStore } = buildWithHeights(sources);
  await runToCompletion(runner);
  await runAgain(runner);
  assert.deepEqual(asked, [undefined, '2026-11-18']);
  // The spliced store equals what a clean full load gives.
  const clean = buildWithHeights();
  await runToCompletion(clean.runner);
  assert.deepEqual(heightStore.series().filter((p) => !heightStore.get(p.date)!.flags), clean.heightStore.series().filter((p) => !clean.heightStore.get(p.date)!.flags));
});

test('R4 (job): a hanging height fetch cannot hold up the refit past the cap; the refit proceeds without heights and says so', async () => {
  const sources = createMockSources().map((s) => {
    const o: PriceSource = { ...s };
    if (s.fetchBlockCounts) o.fetchBlockCounts = () => new Promise<never>(() => undefined); // never settles
    return o;
  });
  const registry = new SourceRegistry(sources);
  const priceStore = new PriceStore();
  const heightStore = new HeightStore();
  const events = new EventLog();
  const spot = new SpotAggregator(registry, defaultSettings as () => Settings);
  const modelStore = new ModelStore();
  const runner = new JobRunner({
    registry, priceStore, heightStore, spot, getSettings: defaultSettings, modelStore, jobStats: new JobStats(), events, heightFetchCapMs: 150,
  });
  const started = Date.now();
  await runToCompletion(runner);
  assert.equal(runner.last()!.state, 'done', runner.last()!.error ?? '');
  assert.ok(Date.now() - started < 10_000);
  assert.equal(heightStore.count(), 0, 'late/absent height data is not applied');
  assert.ok(modelStore.current() && !modelStore.current()!.refraction);
  assert.ok(events.list().some((e) => /exceeded 0 s|exceeded \d+ s/.test(e.msg)));
  assert.equal(HEIGHT_FETCH_CAP_MS, 30_000);
});

test('R5: startupJobKind — initial sync, the upgrade refit, or nothing', () => {
  const rec = (withRefraction: boolean) =>
    ({ fittedAt: 'x', refraction: withRefraction ? ({} as never) : undefined }) as unknown as FitRecord;
  assert.equal(startupJobKind(0, rec(true), 10), 'initial-sync'); // no prices
  assert.equal(startupJobKind(5000, null, 10), 'initial-sync'); // no model
  assert.equal(startupJobKind(5000, rec(false), 0), 'refit'); // upgrade: model without Refraction, no heights
  assert.equal(startupJobKind(5000, rec(false), 6000), null); // heights exist: ordinary schedule
  assert.equal(startupJobKind(5000, rec(true), 0), null); // already has Refraction
  assert.equal(startupJobKind(5000, rec(true), 6000), null);
});
