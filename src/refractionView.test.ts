// Tests for refractionView.ts (v0.2.0 spec 2.4 / 5.2 / 5.3): the fit sample choice,
// the height-now rule (live tip vs projected), the /api/status refraction block and
// its caching / null-safety, plus legacy model.json records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_FIXTURE } from './fixtures/history.js';
import { heightsFromSnapshot } from './fixtures/heights.js';
import { HeightStore, dayEndMs } from './heightStore.js';
import { ModelStore } from './jobs.js';
import { REFRACTION_MIN_POINTS, fitRefraction, linePriceAt } from './refraction.js';
import { buildRefractionSample, buildRefractionStatus, heightNow, lastCloseOf, percentileNow, sampleChecksum, staleDaysOf } from './refractionView.js';
import type { FitRecord, RefractionRecord } from './types.js';

const SNAP = heightsFromSnapshot();
const NOW = Date.parse('2026-11-27T12:00:00Z');

/** A store like the one a MOCK refit builds: authoritative days with fixture closes. */
function storeWithCloses(withUsd = true): HeightStore {
  const s = new HeightStore();
  const usd = new Map(HISTORY_FIXTURE.map((o) => [o.date, o.usd] as const));
  s.reconcilePrimary(
    SNAP.map((p) => (withUsd && usd.has(p.date) ? { ...p, usd: usd.get(p.date) as number } : { date: p.date, h: p.h })),
    'coinmetrics',
  );
  return s;
}
const canonical = () => HISTORY_FIXTURE;

let cached: { rec: RefractionRecord; store: HeightStore } | null = null;
function fitted(): { rec: RefractionRecord; store: HeightStore } {
  if (!cached) {
    const store = storeWithCloses();
    const built = buildRefractionSample(store, canonical)!;
    cached = { rec: { ...fitRefraction(built.sample), priceSeries: built.priceSeries, fitMs: 1 }, store };
  }
  return cached;
}

test('buildRefractionSample: Coin Metrics closes when there are enough, in date order', () => {
  const b = buildRefractionSample(storeWithCloses(), canonical)!;
  assert.equal(b.priceSeries, 'coinmetrics');
  assert.ok(b.sample.length >= REFRACTION_MIN_POINTS);
  assert.ok(b.sample.every((o, i) => i === 0 || o.date > b.sample[i - 1]!.date));
});

test('buildRefractionSample: canonical fallback joins closes with stored heights, INCLUDING interpolated days (R3)', () => {
  const store = storeWithCloses(false); // heights, no Coin Metrics closes
  store.setMaxCommitDate('2026-11-26');
  store.applyInterpolated([{ date: '2026-11-26', h: 977_700 }]);
  const b = buildRefractionSample(store, canonical)!;
  assert.equal(b.priceSeries, 'canonical');
  assert.equal(b.sample.length, HISTORY_FIXTURE.length);
  // A canonical close on an interpolated-only date IS used now, so the fit stays current.
  const extra = () => [...HISTORY_FIXTURE, { date: '2026-11-26', usd: 60_000 }];
  const withExtra = buildRefractionSample(store, extra)!;
  assert.equal(withExtra.sample.length, HISTORY_FIXTURE.length + 1);
  assert.deepEqual(withExtra.sample.at(-1), { date: '2026-11-26', usd: 60_000, h: 977_700 });
});

test('buildRefractionSample (R3): stale Coin Metrics closes lose to a fresher canonical series; a 3-day lag is tolerated', () => {
  const store = storeWithCloses(); // closes end 2026-07-10 (fixture end)
  const canon = (lastDate: string) => () => {
    const base = HISTORY_FIXTURE.filter((o) => o.date <= '2026-07-10');
    return lastDate > '2026-07-10' ? [...base, { date: lastDate, usd: 60_000 }] : base;
  };
  assert.equal(buildRefractionSample(store, canon('2026-07-10'))!.priceSeries, 'coinmetrics');
  assert.equal(buildRefractionSample(store, canon('2026-07-13'))!.priceSeries, 'coinmetrics'); // exactly 3 days
  const stale = buildRefractionSample(store, canon('2026-07-14'))!; // 4 days
  assert.equal(stale.priceSeries, 'canonical');
  assert.equal(stale.sample.at(-1)!.date, '2026-07-14');
});

test('buildRefractionSample (R3): a truncated Coin Metrics series (a dropped count) falls back instead of fitting a stub', () => {
  const store = new HeightStore();
  const usd = new Map(HISTORY_FIXTURE.map((o) => [o.date, o.usd] as const));
  // Closes stop in 2016 (as if a count went missing), heights continue as seed/interpolated.
  store.reconcilePrimary(SNAP.filter((p) => p.date <= '2016-06-30').map((p) => (usd.has(p.date) ? { ...p, usd: usd.get(p.date)! } : p)), 'coinmetrics');
  store.seedMissing(SNAP.filter((p) => p.date > '2016-06-30'));
  assert.ok(store.closeCount() >= REFRACTION_MIN_POINTS);
  const b = buildRefractionSample(store, canonical)!;
  assert.equal(b.priceSeries, 'canonical');
  assert.equal(b.sample.at(-1)!.date, '2026-07-10');
});

test('buildRefractionSample: too little data either way -> null', () => {
  assert.equal(buildRefractionSample(new HeightStore(), canonical), null);
  // Stale Coin Metrics + thin canonical join still beats nothing.
  const store = storeWithCloses();
  assert.equal(buildRefractionSample(store, () => [{ date: '2026-11-20', usd: 1 }])!.priceSeries, 'coinmetrics');
  assert.equal(buildRefractionSample(storeWithCloses(false), () => HISTORY_FIXTURE.slice(0, 100)), null);
});

test('heightNow: a fresh tip is live; a stale or missing one projects 144/day from the end of the last stored day', () => {
  const { rec, store } = fitted();
  const s = new HeightStore();
  s.reconcilePrimary([{ date: '2026-11-25', h: 977_595 }], 'coinmetrics');
  // No tip: 12 h after the end of 11-26 would be... last stored day is 11-25 (ends 11-26 00:00).
  const projected = heightNow(s, rec, Date.parse('2026-11-27T00:00:00Z'));
  assert.deepEqual(projected, { height: 977_595 + 144, live: false });
  s.setTip(977_800, Date.parse('2026-11-27T10:00:00Z'));
  assert.deepEqual(heightNow(s, rec, Date.parse('2026-11-27T12:00:00Z')), { height: 977_800, live: true });
  // 3 h + 1 min later the tip is stale again -> projection from the last stored day.
  const stale = heightNow(s, rec, Date.parse('2026-11-27T13:01:00Z'));
  assert.equal(stale.live, false);
  assert.equal(stale.height, Math.round(977_595 + 144 * (37.0167 / 24)));
  // Empty store falls back to the fit's own last height and date.
  const empty = heightNow(new HeightStore(), rec, dayEndMs(rec.dataEnd) + 86_400_000);
  assert.deepEqual(empty, { height: rec.lastHeight + 144, live: false });
  assert.ok(store.count() > 0);
});

test('buildRefractionStatus: lines are ordered, deviation matches the 50th line, percentile is exact and cached', () => {
  const { rec, store } = fitted();
  store.setTip(977_800, NOW - 1000);
  const spot = linePriceAt(rec, 50, 977_800) * 1.1;
  const st = buildRefractionStatus(rec, store, canonical, spot, NOW)!;
  assert.equal(st.heightNow, 977_800);
  assert.equal(st.heightIsLive, true);
  assert.ok(st.floorNow < st.anchorNow && st.anchorNow < st.fairValueNow && st.fairValueNow < st.topNow);
  assert.equal(st.fairValueNow, linePriceAt(rec, 50, 977_800));
  assert.ok(Math.abs(st.deviationPct! - 10) < 1e-9);
  assert.ok(st.percentile! > 40 && st.percentile! < 60, `percentile ${st.percentile}`);
  assert.equal(st.b1, rec.b1);
  assert.equal(st.c, rec.c);
  assert.equal(st.points, rec.points);
  assert.equal(st.dataEnd, rec.dataEnd);
  assert.equal(st.priceSeries, 'coinmetrics');
  // Same inputs again: identical (and served from the per-fit cache).
  assert.equal(buildRefractionStatus(rec, store, canonical, spot, NOW)!.percentile, st.percentile);
  assert.equal(percentileNow(rec, store, canonical, 977_800, spot), st.percentile);
});

test('buildRefractionStatus: without a spot the price-dependent fields are null, the lines are still there', () => {
  const { rec, store } = fitted();
  for (const spot of [null, 0, -5]) {
    const st = buildRefractionStatus(rec, store, canonical, spot, NOW)!;
    assert.equal(st.deviationPct, null);
    assert.equal(st.percentile, null);
    assert.ok(st.fairValueNow > 0);
  }
});

test('buildRefractionStatus: the grid percentile is used when the exact sample no longer matches the fit', () => {
  const { rec } = fitted();
  // A store without the fit's closes cannot reproduce the sample, so the grid inverse answers.
  const sparse = storeWithCloses(false);
  const st = buildRefractionStatus({ ...rec }, sparse, () => [], linePriceAt(rec, 50, 977_000), NOW)!;
  assert.ok(st.percentile! > 40 && st.percentile! < 60);
});

test('legacy model.json (no refraction) loads unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-view-'));
  try {
    const legacy = {
      fittedAt: '2026-01-01T00:00:00Z', a: -16.2, n: 5.6, A: 1, r2: 0.9, sigma: 0.3, points: 5000,
      dataStart: '2010-08-18', dataEnd: '2026-01-01', bandMode: 'fullSample', bandOffsets: {}, includesProvisionalSpot: false, durationMs: 10,
    };
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ current: legacy, history: [legacy] }), 'utf8');
    const ms = new ModelStore(dir);
    assert.equal((ms.current() as FitRecord).refraction, undefined);
    assert.equal(ms.history().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3: staleDaysOf counts whole days behind yesterday (UTC) and is 0 when current', () => {
  assert.equal(staleDaysOf('2026-11-26', NOW), 0); // NOW = 2026-11-27 12:00 -> yesterday is 11-26
  assert.equal(staleDaysOf('2026-11-27', NOW), 0);
  assert.equal(staleDaysOf('2026-11-25', NOW), 1);
  assert.equal(staleDaysOf('2026-07-10', NOW), 139);
  assert.equal(staleDaysOf('nonsense', NOW), 0);
  const { rec, store } = fitted();
  assert.equal(buildRefractionStatus(rec, store, canonical, null, NOW)!.staleDays, 139);
});

test('R10: the exact percentile is only used against the fit\'s own sample (checksum), and the cache follows the sample', () => {
  const { store } = fitted();
  const built = buildRefractionSample(store, canonical)!;
  const rec: RefractionRecord = { ...fitted().rec, sampleChecksum: sampleChecksum(built.sample) };
  const spot = linePriceAt(rec, 50, 977_000);
  const exact = percentileNow(rec, store, canonical, 977_000, spot)!;
  // Same length, different values (a revision after a restart): the checksum differs, so the grid answers.
  const revised = storeWithCloses();
  revised.reconcilePrimary([{ date: '2020-06-01', h: SNAP.find((p) => p.date === '2020-06-01')!.h, usd: 12_345 }], 'coinmetrics');
  assert.equal(revised.completedCloses().length, store.completedCloses().length);
  const viaGrid = percentileNow(rec, revised, canonical, 977_000, spot)!;
  assert.ok(Number.isFinite(viaGrid));
  assert.notEqual(viaGrid, exact);
  // And back to the original store: the exact value is served again (cache keyed by checksum, not stuck on 'grid').
  assert.equal(percentileNow(rec, store, canonical, 977_000, spot), exact);
  // A record WITHOUT a checksum (older build) still gets the count-only check.
  const legacy: RefractionRecord = { ...fitted().rec };
  assert.equal(percentileNow(legacy, store, canonical, 977_000, spot), exact);
});

test('B1: lastClose is the fit sample\'s last close, exact percentile + 50th line; null when the sample differs or has no checksum', () => {
  const { store } = fitted();
  const built = buildRefractionSample(store, canonical)!;
  const rec: RefractionRecord = { ...fitted().rec, sampleChecksum: sampleChecksum(built.sample) };
  const lc = lastCloseOf(rec, store, canonical)!;
  const last = built.sample.at(-1)!;
  assert.deepEqual([lc.date, lc.usd, lc.height], [last.date, last.usd, last.h]);
  assert.equal(lc.fairValue, linePriceAt(rec, 50, last.h));
  assert.ok(lc.percentile > 0 && lc.percentile < 100);
  assert.equal(lastCloseOf(rec, store, canonical), lc); // cached object
  // Same length, different values: not the fit's sample -> null, never a foreign value.
  const revised = storeWithCloses();
  revised.reconcilePrimary([{ date: '2020-06-01', h: SNAP.find((p) => p.date === '2020-06-01')!.h, usd: 12_345 }], 'coinmetrics');
  assert.equal(lastCloseOf(rec, revised, canonical), null);
  assert.equal(lastCloseOf(rec, new HeightStore(), canonical), null);
  assert.equal(lastCloseOf({ ...rec, sampleChecksum: undefined }, store, canonical), null); // legacy record
  // Status carries it (and null when it cannot be reproduced).
  assert.deepEqual(buildRefractionStatus(rec, store, canonical, null, NOW)!.lastClose, lc);
  assert.equal(buildRefractionStatus(rec, revised, canonical, null, NOW)!.lastClose, null);
});
