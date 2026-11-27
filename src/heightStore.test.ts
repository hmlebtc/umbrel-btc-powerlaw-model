// Tests for heightStore.ts (v0.2.0 spec section 3.3): cumulative conversion, the
// recent-fill plan, the epoch cross-check, tip median, the dense series, the store
// rules (authoritative upsert, interpolated stand-ins, seed fallback, today never
// stored) and the whole reconcile pass. Pure/no network; the bundled snapshot is
// the fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAILY_BLOCK_COUNTS,
  HEIGHTS_SNAPSHOT_END,
  SNAPSHOT_HEIGHT_OFFSET,
  blockCountsFromSnapshot,
  heightsFromSnapshot,
} from './fixtures/heights.js';
import {
  HeightStore,
  addDays,
  isIsoDate,
  planBlockCountFetch,
  plausibleTipRange,
  spliceCounts,
  validRecord,
  crossCheckEpochs,
  cumulativeFromCounts,
  denseHeights,
  interpolateAt,
  planRecentFill,
  reconcileHeights,
  tipMedian,
  yesterdayOf,
} from './heightStore.js';
import type { HeightEpoch, HeightObservation } from './types.js';

const SNAP = heightsFromSnapshot();
const SNAP_LAST = SNAP[SNAP.length - 1] as HeightObservation;
/** A clock 6 h into the day after the snapshot's last day (so 'yesterday' = 2026-11-26). */
const NOW = Date.parse('2026-11-27T06:00:00Z');
const TIP = SNAP_LAST.h + 36; // ~6 h into 2026-11-27 at roughly the nominal rate, past the last day end

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bpl-heights-'));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

test('fixture: one count per day from genesis, TRUE heights (running sum - offset) to the snapshot end', () => {
  assert.equal(SNAP.length, DAILY_BLOCK_COUNTS.length);
  assert.equal(SNAP[0]!.date, '2009-01-03');
  assert.equal(SNAP_LAST.date, HEIGHTS_SNAPSHOT_END);
  assert.equal(SNAPSHOT_HEIGHT_OFFSET, 5);
  assert.equal(SNAP_LAST.h, 977_595); // running sum 977,600 minus the measured offset
  // Genesis is not counted: 0 blocks on day one, first blocks on 2009-01-09.
  assert.equal(SNAP[0]!.h, 0);
  assert.equal(SNAP.find((p) => p.h > 0)!.date, '2009-01-09');
  // Contiguous, non-decreasing, and the cumulative equals the running sum of counts.
  for (let i = 1; i < SNAP.length; i++) {
    assert.equal(SNAP[i]!.date, addDays(SNAP[i - 1]!.date, 1));
    // (the first days are floored at 0, so only check once the series is clear of the floor)
    if (SNAP[i - 1]!.h > 0) assert.equal(SNAP[i]!.h - SNAP[i - 1]!.h, DAILY_BLOCK_COUNTS[i]);
  }
  // blockCountsFromSnapshot stays RAW: its running sum is the snapshot + offset.
  const rawSum = blockCountsFromSnapshot().reduce((a, c) => a + c.count, 0);
  assert.equal(rawSum, 977_600);
  assert.deepEqual(blockCountsFromSnapshot().slice(0, 2), [
    { date: '2009-01-03', count: 0 },
    { date: '2009-01-04', count: 0 },
  ]);
});

test('fixture: on the true-height basis the first day reaching each halving block is the real halving day', () => {
  const firstAtOrAbove = (h: number): string => SNAP.find((p) => p.h >= h)!.date;
  assert.equal(firstAtOrAbove(210_000), '2012-11-28');
  assert.equal(firstAtOrAbove(420_000), '2016-07-09');
  assert.equal(firstAtOrAbove(630_000), '2020-05-11');
  // The raw running sum reached 840,000 a day early (2024-04-19); true heights fix that.
  assert.equal(firstAtOrAbove(840_000), '2024-04-20');
});

// ---------------------------------------------------------------------------
// cumulativeFromCounts
// ---------------------------------------------------------------------------

test('cumulativeFromCounts: running sum from genesis, duplicates keep the last row', () => {
  const r = cumulativeFromCounts([
    { date: '2009-01-04', count: 0 },
    { date: '2009-01-03', count: 0 },
    { date: '2009-01-05', count: 5 },
    { date: '2009-01-05', count: 7 },
    { date: '2009-01-06', count: 3 },
  ]);
  assert.equal(r.problem, null);
  assert.deepEqual(r.points, [
    { date: '2009-01-03', h: 0 },
    { date: '2009-01-04', h: 0 },
    { date: '2009-01-05', h: 7 },
    { date: '2009-01-06', h: 10 },
  ]);
});

test('cumulativeFromCounts: refuses a series not starting at genesis (heights would be offset)', () => {
  const r = cumulativeFromCounts([{ date: '2010-07-18', count: 172 }]);
  assert.deepEqual(r.points, []);
  assert.match(r.problem ?? '', /expected 2009-01-03/);
  assert.deepEqual(cumulativeFromCounts([]).points, []);
});

test('cumulativeFromCounts: the first calendar gap truncates (a missing day would under-count every later h)', () => {
  const r = cumulativeFromCounts([
    { date: '2009-01-03', count: 0 },
    { date: '2009-01-04', count: 0 },
    { date: '2009-01-06', count: 9 }, // 01-05 missing
  ]);
  assert.deepEqual(r.points.map((p) => p.date), ['2009-01-03', '2009-01-04']);
  assert.match(r.problem ?? '', /gap before 2009-01-06/);
});

test('cumulativeFromCounts: the whole snapshot round-trips', () => {
  const r = cumulativeFromCounts(blockCountsFromSnapshot());
  assert.equal(r.problem, null);
  // cumulativeFromCounts is RAW (no offset); true heights are raw - offset, floored at 0.
  assert.deepEqual(
    r.points.map((p) => ({ date: p.date, h: Math.max(0, p.h - SNAPSHOT_HEIGHT_OFFSET) })),
    SNAP,
  );
});

// ---------------------------------------------------------------------------
// interpolateAt / planRecentFill
// ---------------------------------------------------------------------------

test('interpolateAt: piecewise linear, clamped at both ends', () => {
  const a = [{ t: 0, h: 100 }, { t: 10, h: 200 }, { t: 20, h: 220 }];
  assert.equal(interpolateAt(a, 5), 150);
  assert.equal(interpolateAt(a, 15), 210);
  assert.equal(interpolateAt(a, -3), 100);
  assert.equal(interpolateAt(a, 99), 220);
  assert.ok(Number.isNaN(interpolateAt([], 1)));
});

test('planRecentFill: linear in time between last authoritative end-of-day and (now, tip)', () => {
  // End of 2025-12-31 = 2026-01-01T00:00 at h=1000; tip 1216 at 2026-01-02T12:00 (1.5 days).
  const tipAt = Date.parse('2026-01-02T12:00:00Z');
  const plan = planRecentFill({ date: '2025-12-31', h: 1000 }, { h: 1216, atMs: tipAt }, [], '2026-01-01');
  // End of 2026-01-01 is 1 of 1.5 days along: 1000 + 216 * 2/3 = 1144.
  assert.deepEqual(plan, [{ date: '2026-01-01', h: 1144 }]);
  const two = planRecentFill({ date: '2025-12-30', h: 856 }, { h: 1216, atMs: tipAt }, [], '2026-01-01');
  assert.deepEqual(two.map((p) => p.date), ['2025-12-31', '2026-01-01']);
  assert.equal(two[0]!.h, 1000); // 856 + 360*(1/2.5)
  assert.equal(two[1]!.h, 1144);
});

test('planRecentFill: epochs between the anchors bend the line; non-monotone ones are ignored', () => {
  const tipAt = Date.parse('2026-01-05T00:00:00Z');
  const start = { date: '2025-12-31', h: 1000 }; // end of day = 2026-01-01T00:00
  // Straight line start->tip is 100 blocks/day; an epoch at the 2-day mark says 1100, not 1200.
  const epoch: HeightEpoch = { time: Date.parse('2026-01-03T00:00:00Z') / 1000, height: 1100 };
  const bent = planRecentFill(start, { h: 1400, atMs: tipAt }, [epoch], '2026-01-03');
  assert.deepEqual(bent.map((p) => p.h), [1050, 1100, 1250]);
  // An epoch below the last authoritative height would make the series non-monotone: ignored.
  const below: HeightEpoch = { time: Date.parse('2026-01-03T00:00:00Z') / 1000, height: 900 };
  assert.deepEqual(
    planRecentFill(start, { h: 1400, atMs: tipAt }, [below], '2026-01-02').map((p) => p.h),
    [1100, 1200],
  );
  // An epoch above the tip is rejected too.
  const above: HeightEpoch = { time: Date.parse('2026-01-03T00:00:00Z') / 1000, height: 5000 };
  assert.deepEqual(
    planRecentFill(start, { h: 1400, atMs: tipAt }, [above], '2026-01-02').map((p) => p.h),
    [1100, 1200],
  );
});

test('planRecentFill: a tip below the last authoritative height plans nothing; no gap plans nothing', () => {
  const tipAt = Date.parse('2026-01-02T00:00:00Z');
  assert.deepEqual(planRecentFill({ date: '2025-12-31', h: 1000 }, { h: 999, atMs: tipAt }, [], '2026-01-01'), []);
  assert.deepEqual(planRecentFill({ date: '2026-01-01', h: 1000 }, { h: 1100, atMs: tipAt }, [], '2026-01-01'), []);
});

// ---------------------------------------------------------------------------
// crossCheckEpochs
// ---------------------------------------------------------------------------

function midDayEpoch(date: string, offset: number): HeightEpoch {
  const prev = SNAP.find((p) => p.date === addDays(date, -1))!;
  const cur = SNAP.find((p) => p.date === date)!;
  return { time: Date.parse(`${date}T12:00:00Z`) / 1000, height: Math.round((prev.h + cur.h) / 2) + offset };
}

test('crossCheckEpochs: agreement and a 50-block difference stay quiet; 80 is flagged', () => {
  const quiet = [midDayEpoch('2020-06-01', 0), midDayEpoch('2021-03-03', 50), midDayEpoch('2022-04-05', -50)];
  assert.deepEqual(crossCheckEpochs(SNAP, quiet), []);
  const out = crossCheckEpochs(SNAP, [midDayEpoch('2020-06-01', 80), midDayEpoch('2022-04-05', -51)]);
  assert.deepEqual(out.map((d) => d.date), ['2020-06-01', '2022-04-05']);
  assert.ok(out[0]!.diff >= 79 && out[0]!.diff <= 81);
  assert.ok(out[1]!.diff <= -50);
});

test('crossCheckEpochs: epochs outside the stored range are skipped', () => {
  const series = SNAP.filter((p) => p.date >= '2020-01-01' && p.date <= '2020-12-31');
  const before: HeightEpoch = { time: Date.parse('2019-06-01T00:00:00Z') / 1000, height: 1 };
  const firstDay: HeightEpoch = { time: Date.parse('2020-01-01T10:00:00Z') / 1000, height: 1 }; // no prior day stored
  const after: HeightEpoch = { time: Date.parse('2022-06-01T00:00:00Z') / 1000, height: 1 };
  assert.deepEqual(crossCheckEpochs(series, [before, firstDay, after]), []);
});

// ---------------------------------------------------------------------------
// tipMedian / denseHeights
// ---------------------------------------------------------------------------

test('tipMedian: median of reachable answers; one answer is enough; below-store answers rejected', () => {
  assert.equal(tipMedian([977_627, 977_627, 977_676]), 977_627);
  assert.equal(tipMedian([977_700]), 977_700);
  // Even count: the LOWER middle value, never a mean (R2) — one bad answer cannot drag it.
  assert.equal(tipMedian([100, 104]), 100);
  assert.equal(tipMedian([100, 2_000_000_000]), 100);
  assert.equal(tipMedian([1, 2, 3, 4]), 2);
  // A stale answer below the last stored height is dropped, not averaged in.
  assert.equal(tipMedian([900_000, 977_650, 977_660], 977_600), 977_650);
  assert.equal(tipMedian([900_000], 977_600), null);
  assert.equal(tipMedian([]), null);
  assert.equal(tipMedian([NaN, 1.5, -4]), null);
  assert.equal(tipMedian([5, 50, 500], 10, 100), 50); // upper bound rejects too
});

test('denseHeights: dense from first to last, interior gaps interpolated', () => {
  assert.equal(denseHeights([]), null);
  const d = denseHeights([
    { date: '2020-01-01', h: 100 },
    { date: '2020-01-04', h: 400 },
    { date: '2020-01-05', h: 450 },
  ])!;
  assert.deepEqual(d, { start: '2020-01-01', end: '2020-01-05', heights: [100, 200, 300, 400, 450] });
});

// ---------------------------------------------------------------------------
// HeightStore rules
// ---------------------------------------------------------------------------

test('HeightStore.reconcilePrimary: adds, updates, counts revisions, never stores today', () => {
  const s = new HeightStore();
  s.setMaxCommitDate('2020-01-03');
  let r = s.reconcilePrimary(
    [{ date: '2020-01-01', h: 10 }, { date: '2020-01-02', h: 20 }, { date: '2020-01-04', h: 40 }],
    'coinmetrics',
  );
  assert.deepEqual(r, { added: 2, updated: 0, revised: 0 });
  assert.equal(s.has('2020-01-04'), false); // past the commit bound = "today"
  r = s.reconcilePrimary([{ date: '2020-01-01', h: 10 }, { date: '2020-01-02', h: 22 }], 'coinmetrics');
  assert.deepEqual(r, { added: 0, updated: 1, revised: 1 });
  assert.equal(s.get('2020-01-02')!.h, 22);
  assert.equal(s.get('2020-01-02')!.src, 'coinmetrics');
  assert.equal(s.get('2020-01-02')!.flags, undefined);
});

test('HeightStore.applyInterpolated: flagged, replaced by the primary, never overwrites real data', () => {
  const s = new HeightStore();
  s.setMaxCommitDate('2020-01-10');
  s.reconcilePrimary([{ date: '2020-01-01', h: 10 }], 'coinmetrics');
  assert.equal(s.applyInterpolated([{ date: '2020-01-01', h: 999 }, { date: '2020-01-02', h: 20 }]), 1);
  assert.equal(s.get('2020-01-01')!.h, 10); // authoritative kept
  assert.deepEqual(s.get('2020-01-02'), { h: 20, src: 'tip', flags: ['interpolated'] });
  assert.deepEqual(s.lastAuthoritative(), { date: '2020-01-01', h: 10 });
  // Today stays out.
  s.setMaxCommitDate('2020-01-02');
  assert.equal(s.applyInterpolated([{ date: '2020-01-03', h: 30 }]), 0);
  // The primary catching up replaces the stand-in and drops the flag.
  const r = s.reconcilePrimary([{ date: '2020-01-02', h: 21 }], 'coinmetrics');
  assert.equal(r.added, 0);
  assert.equal(r.updated, 1);
  assert.deepEqual(s.get('2020-01-02'), { h: 21, src: 'coinmetrics' });
});

test('HeightStore.seedMissing: fills gaps and stand-ins, never real or seed data', () => {
  const s = new HeightStore();
  s.setMaxCommitDate('2020-01-05');
  s.reconcilePrimary([{ date: '2020-01-01', h: 10 }], 'coinmetrics');
  s.applyInterpolated([{ date: '2020-01-03', h: 33 }]);
  const n = s.seedMissing([
    { date: '2020-01-01', h: 11 },
    { date: '2020-01-02', h: 22 },
    { date: '2020-01-03', h: 30 },
    { date: '2020-01-06', h: 60 },
  ]);
  assert.equal(n, 2); // 01-02 (gap) and 01-03 (stand-in); 01-06 is "today"
  assert.equal(s.get('2020-01-01')!.h, 10);
  assert.deepEqual(s.get('2020-01-03'), { h: 30, src: 'seed' });
  assert.equal(s.seedMissing([{ date: '2020-01-02', h: 99 }]), 0);
});

test('HeightStore: toApi is null until something is stored, then dense with the tip', () => {
  const s = new HeightStore();
  assert.equal(s.toApi(), null);
  s.reconcilePrimary([{ date: '2020-01-01', h: 5 }, { date: '2020-01-03', h: 9 }], 'coinmetrics');
  s.setTip(12, Date.parse('2020-01-04T00:00:00Z'));
  assert.deepEqual(s.toApi(), {
    start: '2020-01-01',
    end: '2020-01-03',
    count: 3,
    heights: [5, 7, 9],
    tip: { height: 12, at: '2020-01-04T00:00:00.000Z' },
  });
});

test('HeightStore: heights.json round trip (atomic write), tip kept, corrupt or malformed data tolerated', () => {
  const dir = tmp();
  try {
    const a = new HeightStore(dir);
    a.reconcilePrimary([{ date: '2020-01-01', h: 5 }], 'coinmetrics');
    a.applyInterpolated([{ date: '2020-01-02', h: 9 }]);
    a.setTip(12, Date.parse('2020-01-04T00:00:00Z'));
    a.save();
    const raw = JSON.parse(readFileSync(join(dir, 'heights.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.days['2020-01-02'], { h: 9, src: 'tip', flags: ['interpolated'] });
    const b = new HeightStore(dir);
    assert.deepEqual(b.series(), [{ date: '2020-01-01', h: 5 }, { date: '2020-01-02', h: 9 }]);
    assert.equal(b.tip()!.height, 12);

    writeFileSync(join(dir, 'heights.json'), '{not json', 'utf8');
    assert.equal(new HeightStore(dir).count(), 0);
    writeFileSync(
      join(dir, 'heights.json'),
      JSON.stringify({ version: 1, days: { '2020-01-01': { h: 5, src: 'x' }, '2020-01-02': { h: 'a' }, '2020-01-03': null } }),
      'utf8',
    );
    assert.deepEqual(new HeightStore(dir).series(), [{ date: '2020-01-01', h: 5 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reconcileHeights (whole pass)
// ---------------------------------------------------------------------------

test('reconcileHeights: primary ok -> authoritative to the snapshot end, yesterday interpolated, today absent', () => {
  const s = new HeightStore();
  const counts = [...blockCountsFromSnapshot(), { date: '2026-11-27', count: 77 }]; // a row for "today"
  const r = reconcileHeights(s, { counts, epochs: [], tips: [TIP, TIP + 1, TIP + 40], seed: SNAP }, NOW);
  assert.equal(r.primary, 'ok');
  assert.equal(r.tip, TIP + 1);
  assert.equal(yesterdayOf(NOW), '2026-11-26');
  assert.equal(s.has('2026-11-27'), false);
  assert.deepEqual(s.get(HEIGHTS_SNAPSHOT_END), { h: 977_595, src: 'coinmetrics' });
  const y = s.get('2026-11-26')!;
  assert.equal(y.src, 'tip');
  assert.deepEqual(y.flags, ['interpolated']);
  // End of 11-26 is 24 h of the 30 h from end-of-11-25 to NOW: 977595 + (tip - 977595) * 24/30.
  // The tip is already a true height, so nothing is offset again.
  assert.equal(y.h, Math.round(977_595 + (TIP + 1 - 977_595) * (24 / 30)));
  assert.equal(r.interpolated, 1);
  assert.equal(s.tip()!.at, new Date(NOW).toISOString());
  assert.equal(s.count(), SNAP.length + 1);
});

test('reconcileHeights: the next run with the primary caught up replaces the stand-in', () => {
  const s = new HeightStore();
  const inputs = { counts: blockCountsFromSnapshot(), epochs: [], tips: [TIP], seed: SNAP };
  reconcileHeights(s, inputs, NOW);
  const counts2 = [...blockCountsFromSnapshot(), { date: '2026-11-26', count: 150 }];
  const later = Date.parse('2026-11-27T18:00:00Z');
  const r = reconcileHeights(s, { ...inputs, counts: counts2, tips: [978_000] }, later);
  assert.equal(r.revised, 0);
  assert.deepEqual(s.get('2026-11-26'), { h: 977_745, src: 'coinmetrics' }); // 977,600 + 150 - 5
  assert.equal(s.lastAuthoritative()!.date, '2026-11-26');
  assert.equal(s.has('2026-11-27'), false);
});

test('reconcileHeights: primary unreachable and store empty -> seeded from the snapshot, then filled from the tip', () => {
  const s = new HeightStore();
  const r = reconcileHeights(s, { counts: null, epochs: [], tips: [TIP], seed: SNAP }, NOW);
  assert.equal(r.primary, 'unreachable');
  assert.equal(r.seeded, SNAP.length);
  assert.equal(s.get('2020-05-11')!.src, 'seed');
  assert.equal(s.get('2026-11-26')!.flags![0], 'interpolated');
  assert.equal(s.count(), SNAP.length + 1);
});

test('reconcileHeights: seed fallback uses epochs as intermediate anchors when the gap is long', () => {
  const s = new HeightStore();
  const shortSeed = SNAP.filter((p) => p.date <= '2026-11-20');
  const tip = SNAP_LAST.h + 144 * 2;
  // An epoch stamped 2026-11-23T00:00 reporting a height clearly below the straight line.
  const epoch: HeightEpoch = { time: Date.parse('2026-11-23T00:00:00Z') / 1000, height: 977_000 };
  const plain = new HeightStore();
  reconcileHeights(plain, { counts: null, epochs: [], tips: [tip], seed: shortSeed }, NOW);
  reconcileHeights(s, { counts: null, epochs: [epoch], tips: [tip], seed: shortSeed }, NOW);
  // Both are monotone; the epoch-bent mid-gap day is lower than the straight-line one.
  assert.ok(s.get('2026-11-23')!.h <= plain.get('2026-11-23')!.h);
  assert.ok(s.get('2026-11-26')!.h >= s.get('2026-11-25')!.h);
});

test('reconcileHeights: primary unreachable but store already full -> seed is a no-op, real data kept', () => {
  const s = new HeightStore();
  reconcileHeights(s, { counts: blockCountsFromSnapshot(), epochs: [], tips: [TIP], seed: SNAP }, NOW);
  const r = reconcileHeights(s, { counts: null, epochs: [], tips: [TIP], seed: SNAP }, NOW);
  assert.equal(r.seeded, 0);
  assert.equal(s.get('2020-05-11')!.src, 'coinmetrics');
});

test('reconcileHeights: a primary that does not start at genesis is rejected and the seed is used', () => {
  const s = new HeightStore();
  const bad = blockCountsFromSnapshot().filter((c) => c.date >= '2010-01-01');
  const r = reconcileHeights(s, { counts: bad, epochs: [], tips: [], seed: SNAP }, NOW);
  assert.equal(r.primary, 'rejected');
  assert.match(r.primaryProblem ?? '', /expected 2009-01-03/);
  assert.equal(r.seeded, SNAP.length);
  assert.equal(s.get('2026-11-26'), undefined); // no tip => no recent fill
  assert.equal(s.tip(), null);
});

test('reconcileHeights: tips below the stored height are rejected; nothing is interpolated', () => {
  const s = new HeightStore();
  const r = reconcileHeights(s, { counts: blockCountsFromSnapshot(), epochs: [], tips: [900_000, 950_000], seed: SNAP }, NOW);
  assert.equal(r.tip, null);
  assert.equal(r.tipRejected, true);
  assert.equal(r.interpolated, 0);
  assert.equal(s.tip(), null);
  assert.equal(s.has('2026-11-26'), false);
});

test('reconcileHeights: a >50-block epoch disagreement flags the day, keeps the stored value, and is reported once', () => {
  const s = new HeightStore();
  const epochs = [midDayEpoch('2020-06-01', 80), midDayEpoch('2021-03-03', 10)];
  const inputs = { counts: blockCountsFromSnapshot(), epochs, tips: [TIP], seed: SNAP };
  const before = SNAP.find((p) => p.date === '2020-06-01')!.h;
  const r1 = reconcileHeights(s, inputs, NOW);
  assert.deepEqual(r1.newDivergences.map((d) => d.date), ['2020-06-01']);
  assert.deepEqual(s.get('2020-06-01'), { h: before, src: 'coinmetrics', flags: ['divergent'] });
  assert.equal(s.get('2021-03-03')!.flags, undefined);
  // Same disagreement next refit: still flagged, but no new event-worthy divergence.
  const r2 = reconcileHeights(s, inputs, NOW);
  assert.deepEqual(r2.newDivergences, []);
  assert.deepEqual(s.datesWithFlag('divergent'), ['2020-06-01']);
});

// ---------------------------------------------------------------------------
// v0.2.0 Coin Metrics closes + true-height basis (spec 5.1)
// ---------------------------------------------------------------------------

const RAW = blockCountsFromSnapshot();
const withUsd = (extra: Record<string, number>) => RAW.map((c) => (extra[c.date] ? { ...c, usd: extra[c.date] } : c));
const lookup = (date: string, height: number) => [{ date, height }];

test('cumulativeFromCounts carries the close through and stays RAW (offset applied later)', () => {
  const r = cumulativeFromCounts([
    { date: '2009-01-03', count: 0 },
    { date: '2009-01-04', count: 4, usd: 1.5 },
  ]);
  assert.deepEqual(r.points, [{ date: '2009-01-03', h: 0 }, { date: '2009-01-04', h: 4, usd: 1.5 }]);
});

test('reconcilePrimary keeps the close only on days that carry one and drops a vanished one', () => {
  const s = new HeightStore();
  s.reconcilePrimary([{ date: '2020-01-01', h: 10, usd: 7000 }, { date: '2020-01-02', h: 20 }], 'coinmetrics');
  assert.deepEqual(s.get('2020-01-01'), { h: 10, src: 'coinmetrics', usd: 7000 });
  assert.deepEqual(s.get('2020-01-02'), { h: 20, src: 'coinmetrics' });
  assert.deepEqual(s.series(), [{ date: '2020-01-01', h: 10, usd: 7000 }, { date: '2020-01-02', h: 20 }]);
  // A changed close is an update; a close that disappears is dropped (no stale price).
  const r = s.reconcilePrimary([{ date: '2020-01-01', h: 10, usd: 7001 }, { date: '2020-01-02', h: 20, usd: 8000 }], 'coinmetrics');
  assert.equal(r.updated, 2);
  assert.equal(s.get('2020-01-02')!.usd, 8000);
  s.reconcilePrimary([{ date: '2020-01-01', h: 10 }], 'coinmetrics');
  assert.equal(s.get('2020-01-01')!.usd, undefined);
});

test('completedCloses / closeCount: only days with a close and a non-interpolated h, ascending', () => {
  const s = new HeightStore();
  s.setMaxCommitDate('2020-01-10');
  s.reconcilePrimary([{ date: '2020-01-02', h: 20, usd: 8000 }, { date: '2020-01-01', h: 10, usd: 7000 }, { date: '2020-01-03', h: 30 }], 'coinmetrics');
  s.seedMissing([{ date: '2020-01-04', h: 44 }]);
  s.applyInterpolated([{ date: '2020-01-05', h: 55 }]);
  assert.deepEqual(s.completedCloses(), [
    { date: '2020-01-01', usd: 7000, h: 10 },
    { date: '2020-01-02', usd: 8000, h: 20 },
  ]);
  assert.equal(s.closeCount(), 2);
  assert.equal(new HeightStore().closeCount(), 0);
});

test('R7: the basis is always the snapshot constant; a lookup never changes stored heights', () => {
  const s = new HeightStore();
  const counts = withUsd({ '2026-11-25': 59_000 });
  const r = reconcileHeights(s, { counts, epochs: [], tips: [], seed: SNAP, lookups: lookup('2026-11-25', 977_597) }, NOW);
  assert.equal(r.offset, SNAPSHOT_HEIGHT_OFFSET);
  assert.equal(s.offset(), 5);
  assert.equal(s.get('2026-11-25')!.h, 977_595); // 977,600 - 5, whatever the lookup said
  assert.equal(s.get('2026-11-25')!.usd, 59_000);
  assert.equal(r.offsetNotice, null); // only one day measured: not enough for a notice
  // Same inputs with wildly different lookups: history is byte-identical.
  const before = JSON.stringify(s.series());
  reconcileHeights(s, { counts, epochs: [], tips: [], seed: SNAP, lookups: [{ date: '2026-11-26', height: 1 }, { date: '2026-11-25', height: 5 }] }, NOW);
  assert.equal(JSON.stringify(s.series()), before);
});

test('R7: a notice needs BOTH of the last two complete days to disagree with the basis, once per distinct value', () => {
  const s = new HeightStore();
  const counts = [...RAW, { date: '2026-11-26', count: 135 }];
  const disagree = [{ date: '2026-11-26', height: 977_732 }, { date: '2026-11-25', height: 977_597 }];
  const run = (lookups: typeof disagree) => reconcileHeights(s, { counts, epochs: [], tips: [], seed: SNAP, lookups }, NOW);
  // 11-26 stored = 977,730; measured offset 5 + (977,730 - 977,732) = 3. 11-25: 5 + (977,595 - 977,597) = 3.
  const first = run(disagree);
  assert.deepEqual(first.offsetNotice, { measured: 3, basis: 5, dates: ['2026-11-26', '2026-11-25'] });
  assert.equal(run(disagree).offsetNotice, null); // same value: silent
  assert.equal(s.get('2026-11-26')!.h, 977_730); // never rewritten
  // One day agreeing with the basis cancels the notice.
  assert.equal(run([{ date: '2026-11-26', height: 977_730 }, { date: '2026-11-25', height: 977_597 }]).offsetNotice, null);
  // A different disagreeing value is announced (once).
  const other = run([{ date: '2026-11-26', height: 977_735 }, { date: '2026-11-25', height: 977_600 }]);
  assert.equal(other.offsetNotice!.measured, 0);
  // The announced values survive a save/load.
  const dir = tmp();
  try {
    const p = new HeightStore(dir);
    p.noticeOffset(3);
    p.save();
    assert.equal(new HeightStore(dir).noticeOffset(3), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R7: the legacy migration shifts coinmetrics days (and old seed days) once, and never again', () => {
  const s = new HeightStore();
  s.reconcilePrimary([{ date: '2020-01-01', h: 100 }], 'coinmetrics');
  s.seedMissing([{ date: '2020-01-02', h: 200 }]);
  s.applyInterpolated([{ date: '2020-01-03', h: 300 }]);
  assert.equal(s.offset(), null);
  assert.equal(s.rebaseTo(5), 2); // coinmetrics + seed; interpolated untouched
  assert.deepEqual([s.get('2020-01-01')!.h, s.get('2020-01-02')!.h, s.get('2020-01-03')!.h], [95, 195, 300]);
  assert.equal(s.rebaseTo(5), 0);
  assert.equal(s.get('2020-01-01')!.h, 95);
});

test('an old heights.json (raw cumulative days, no offset, no usd) loads and is rebased onto true heights', () => {
  const dir = tmp();
  try {
    const days: Record<string, { h: number; src: string }> = {};
    let h = 0;
    for (const c of RAW) {
      h += c.count;
      days[c.date] = { h, src: 'coinmetrics' };
    }
    writeFileSync(join(dir, 'heights.json'), JSON.stringify({ version: 1, updatedAt: '2026-11-26T00:00:00Z', days }), 'utf8');
    const s = new HeightStore(dir);
    assert.equal(s.offset(), null);
    assert.equal(s.closeCount(), 0);
    assert.equal(s.get('2026-11-25')!.h, 977_600);
    // The next reconcile with the primary down still moves the old rows to the true basis.
    const r = reconcileHeights(s, { counts: null, epochs: [], tips: [], seed: SNAP }, NOW);
    assert.equal(r.offset, 5);
    assert.equal(s.get('2026-11-25')!.h, 977_595);
    assert.deepEqual(s.series().slice(-1)[0], { date: '2026-11-25', h: 977_595 });
    s.save();
    assert.equal(JSON.parse(readFileSync(join(dir, 'heights.json'), 'utf8')).offset, 5);
    assert.equal(new HeightStore(dir).offset(), 5);
    // A damaged offset in the file is ignored rather than trusted.
    writeFileSync(join(dir, 'heights.json'), JSON.stringify({ version: 1, days: {}, offset: 99 }), 'utf8');
    assert.equal(new HeightStore(dir).offset(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no double subtraction: seed, interpolated days and the tip are stored as given', () => {
  const s = new HeightStore();
  const r = reconcileHeights(s, { counts: null, epochs: [], tips: [TIP], seed: SNAP }, NOW);
  assert.equal(r.seeded, SNAP.length);
  assert.equal(s.get('2026-11-25')!.h, 977_595); // snapshot already true
  assert.equal(s.tip()!.height, TIP);
  const y = s.get('2026-11-26')!;
  assert.ok(y.h > 977_595 && y.h < TIP);
  assert.equal(y.h, Math.round(977_595 + (TIP - 977_595) * (24 / 30)));
  // And when the primary later arrives, only ITS days are offset.
  reconcileHeights(s, { counts: RAW, epochs: [], tips: [TIP], seed: SNAP }, NOW);
  assert.equal(s.get('2026-11-25')!.h, 977_595);
  assert.equal(s.get('2026-11-26')!.h, y.h);
});

// ---------------------------------------------------------------------------
// Review round 1: R2 (tips), R4 (incremental), R8 (load validation)
// ---------------------------------------------------------------------------

test('R2: plausibleTipRange is [last authoritative h, h + 300/day + 300]', () => {
  const last = { date: '2026-11-25', h: 977_595 };
  const r = plausibleTipRange(last, Date.parse('2026-11-27T06:00:00Z')); // 30 h after the end of 11-25
  assert.equal(r.lo, 977_595);
  assert.equal(r.hi, Math.floor(977_595 + 300 * 1.25 + 300));
  assert.equal(plausibleTipRange(last, Date.parse('2026-11-25T00:00:00Z')).hi, 977_895); // before the day ended: no negative elapsed
  assert.deepEqual(plausibleTipRange(null, NOW).lo, 0);
});

test('R2: a 2e9 tip is rejected, nothing is poisoned, and honest tips are accepted on later runs', () => {
  const s = new HeightStore();
  const base = { counts: RAW, epochs: [], seed: SNAP };
  const r1 = reconcileHeights(s, { ...base, tips: [2_000_000_000] }, NOW);
  assert.equal(r1.tip, null);
  assert.equal(r1.tipRejected, true);
  assert.equal(s.tip(), null);
  assert.equal(s.has('2026-11-26'), false); // no interpolation toward garbage
  // Two sources, one hostile: the LOWER median wins, so the honest answer stands.
  const r2 = reconcileHeights(s, { ...base, tips: [TIP, 2_000_000_000] }, NOW);
  assert.equal(r2.tip, TIP);
  assert.ok(s.get('2026-11-26')!.h < TIP);
  // The next run with only the honest tip works (no lock-out by a poisoned stored day).
  const r3 = reconcileHeights(s, { ...base, tips: [TIP + 3] }, NOW);
  assert.equal(r3.tip, TIP + 3);
  assert.equal(r3.tipRejected, false);
});

test('R2: the tip floor is the last AUTHORITATIVE height, not an interpolated day', () => {
  const s = new HeightStore();
  const base = { counts: RAW, epochs: [], seed: SNAP };
  reconcileHeights(s, { ...base, tips: [977_700] }, NOW); // interpolates 11-26 near 977,6xx
  // A later, lower (but still >= last authoritative 977,595) honest tip must be accepted.
  const r = reconcileHeights(s, { ...base, tips: [977_640] }, NOW);
  assert.equal(r.tip, 977_640);
  assert.ok(s.get('2026-11-26')!.h <= 977_640);
  assert.equal(s.tip()!.height, 977_640);
});

test('R2: with no plausible tip, stale interpolated days are dropped; interpolated days never fall below the base or decrease', () => {
  const s = new HeightStore();
  const base = { counts: RAW, epochs: [], seed: SNAP };
  reconcileHeights(s, { ...base, tips: [TIP] }, NOW);
  assert.equal(s.get('2026-11-26')!.flags![0], 'interpolated');
  const none = reconcileHeights(s, { ...base, tips: [] }, NOW);
  assert.equal(none.droppedInterpolated, 1);
  assert.equal(s.has('2026-11-26'), false);
  // Coin Metrics catches up to 11-26 while no tip is reachable: no stale lower day lingers.
  reconcileHeights(s, { ...base, counts: [...RAW, { date: '2026-11-26', count: 135 }], tips: [] }, NOW);
  assert.equal(s.get('2026-11-26')!.src, 'coinmetrics');
  const series = s.series();
  for (let i = 1; i < series.length; i++) assert.ok(series[i]!.h >= series[i - 1]!.h, `decrease at ${series[i]!.date}`);
});

test('R4: spliceCounts continues from the base day; a gap truncates; a wrong start or missing base is a problem', () => {
  const rows = [{ date: '2020-01-03', count: 10 }, { date: '2020-01-04', count: 20, usd: 5 }, { date: '2020-01-05', count: 30 }];
  const ok = spliceCounts('2020-01-02', 100, rows);
  assert.equal(ok.problem, null);
  assert.deepEqual(ok.points, [{ date: '2020-01-03', h: 110 }, { date: '2020-01-04', h: 130, usd: 5 }, { date: '2020-01-05', h: 160 }]);
  assert.deepEqual(spliceCounts('2020-01-02', 100, [rows[0]!, rows[2]!]).points.map((p) => p.date), ['2020-01-03']);
  assert.match(spliceCounts('2020-01-01', 100, rows).problem ?? '', /expected 2020-01-02/);
  assert.match(spliceCounts('2020-01-02', 0, rows).problem ?? '', /base/);
  assert.match(spliceCounts('2020-01-05', 100, rows).problem ?? '', /no incremental rows/);
});

test('R4: planBlockCountFetch is full for a new store, after 7 days, and incremental (last day - 7) otherwise', () => {
  const s = new HeightStore();
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'full' });
  s.reconcilePrimary([{ date: '2026-11-25', h: 5 }], 'coinmetrics');
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'full' }); // never completed a full load
  s.setFullLoadAt(NOW - 3_600_000);
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'incremental', startDate: '2026-11-18' });
  s.setFullLoadAt(NOW - 7 * 86_400_000);
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'full' });
  s.setFullLoadAt(NOW + 3_600_000); // clock went backwards
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'full' });
});

test('R4: full load and full + incremental produce identical heights and closes, including a revised count in the overlap', () => {
  const closes = { '2026-07-01': 61_000, '2026-07-05': 62_000, '2026-07-09': 63_000, '2026-07-10': 64_000 };
  const counts = withUsd(closes);
  const base = { epochs: [], tips: [TIP], seed: SNAP };
  const full = new HeightStore();
  reconcileHeights(full, { ...base, counts }, NOW);

  // Incremental path: an earlier full load up to 07-31, then a later incremental window.
  const inc = new HeightStore();
  reconcileHeights(inc, { ...base, counts: counts.filter((c) => c.date <= '2026-07-31') }, Date.parse('2026-08-01T06:00:00Z'));
  assert.ok(inc.fullLoadAt() !== null);
  const plan = planBlockCountFetch(inc, Date.parse('2026-08-02T06:00:00Z'));
  assert.deepEqual(plan, { mode: 'incremental', startDate: '2026-07-24' });
  const window = counts.filter((c) => c.date >= '2026-07-24');
  const r = reconcileHeights(inc, { ...base, counts: window, countsMode: 'incremental' }, NOW);
  assert.equal(r.primary, 'ok');
  assert.equal(r.mode, 'incremental');
  assert.deepEqual(inc.series(), full.series());
  assert.deepEqual(inc.completedCloses(), full.completedCloses());

  // A revised count INSIDE the overlap (07-27) shifts every later day by the same amount;
  // days before the window are untouched; and it matches a full load of the revised data.
  const revised = counts.map((c) => (c.date === '2026-07-27' ? { ...c, count: c.count + 3 } : c));
  reconcileHeights(inc, { ...base, counts: revised.filter((c) => c.date >= '2026-07-24'), countsMode: 'incremental' }, NOW);
  const fullRevised = new HeightStore();
  reconcileHeights(fullRevised, { ...base, counts: revised }, NOW);
  assert.deepEqual(inc.series(), fullRevised.series());
  assert.equal(inc.get('2026-07-26')!.h, full.get('2026-07-26')!.h);
  assert.equal(inc.get('2026-07-27')!.h, full.get('2026-07-27')!.h + 3);
  assert.equal(inc.get('2026-11-25')!.h, full.get('2026-11-25')!.h + 3);
});

test('R4: an incremental window with no stored base is rejected and forces a full load next time', () => {
  const s = new HeightStore();
  reconcileHeights(s, { counts: RAW, epochs: [], tips: [], seed: SNAP }, NOW);
  assert.ok(s.fullLoadAt() !== null);
  const r = reconcileHeights(s, { counts: RAW.filter((c) => c.date >= '2030-01-01').concat([{ date: '2026-12-30', count: 1 }]), countsMode: 'incremental', epochs: [], tips: [], seed: SNAP }, NOW);
  assert.equal(r.primary, 'rejected');
  assert.match(r.primaryProblem ?? '', /no stored base/);
  assert.equal(s.fullLoadAt(), null);
  assert.deepEqual(planBlockCountFetch(s, NOW), { mode: 'full' });
  assert.equal(s.get('2020-05-11')!.src, 'coinmetrics'); // stored data untouched
});

test('R4: a counts-only answer (BlkCnt fallback) keeps the closes the days already have', () => {
  const s = new HeightStore();
  reconcileHeights(s, { counts: withUsd({ '2026-07-09': 63_000 }), epochs: [], tips: [], seed: SNAP }, NOW);
  assert.equal(s.get('2026-07-09')!.usd, 63_000);
  reconcileHeights(s, { counts: RAW, epochs: [], tips: [], seed: SNAP }, NOW); // no usd anywhere
  assert.equal(s.get('2026-07-09')!.usd, 63_000);
  // ...but a series that does carry closes still replaces/drops them as before.
  reconcileHeights(s, { counts: withUsd({ '2026-07-01': 1 }), epochs: [], tips: [], seed: SNAP }, NOW);
  assert.equal(s.get('2026-07-09')!.usd, undefined);
});

test('R8: validRecord accepts good records and rejects every malformed field', () => {
  assert.deepEqual(validRecord('2020-01-01', { h: 5, src: 'coinmetrics', usd: 7, flags: ['x'], extra: 1 }), { h: 5, src: 'coinmetrics', usd: 7, flags: ['x'] });
  assert.deepEqual(validRecord('2020-01-01', { h: 5, src: 's', flags: [] }), { h: 5, src: 's' });
  for (const bad of [
    { h: 5.5, src: 's' }, { h: -1, src: 's' }, { h: '5', src: 's' }, { h: 5 }, { h: 5, src: 3 },
    { h: 5, src: 's', flags: 5 }, { h: 5, src: 's', flags: [1] }, { h: 5, src: 's', usd: 0 }, { h: 5, src: 's', usd: 'x' },
    { h: 2e9, src: 's' }, null, 7,
  ]) assert.equal(validRecord('2020-01-01', bad), null, JSON.stringify(bad));
  for (const key of ['zz', '2020-1-1', '2026-02-30', '2020-01-01T00', '']) assert.equal(validRecord(key, { h: 1, src: 's' }), null, key);
  assert.equal(isIsoDate('2024-02-29'), true);
  assert.equal(isIsoDate('2023-02-29'), false);
});

test('R8: a heights.json with corrupted records loads minus the bad ones, and the next reconcile succeeds and repairs the file', () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, 'heights.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-26T00:00:00Z',
        days: {
          '2020-01-01': { h: 5, src: 'coinmetrics' },
          '2020-01-02': { h: 9, src: 'coinmetrics', flags: 5 },
          zz: { h: 99, src: 'coinmetrics' },
          '2020-01-03': { h: 'x', src: 'coinmetrics' },
          '2020-01-04': { h: 12, src: 7 },
        },
        tip: { height: -4, at: 'never' },
        fullLoadAt: 'soon',
      }),
      'utf8',
    );
    const s = new HeightStore(dir);
    assert.deepEqual(s.series(), [{ date: '2020-01-01', h: 5 }]);
    assert.equal(s.tip(), null);
    assert.equal(s.fullLoadAt(), null);
    const r = reconcileHeights(s, { counts: RAW, epochs: [], tips: [TIP], seed: SNAP }, NOW);
    assert.equal(r.primary, 'ok');
    assert.equal(s.toApi()!.end, '2026-11-26'); // no 'zz' sorting last
    s.save();
    const saved = JSON.parse(readFileSync(join(dir, 'heights.json'), 'utf8'));
    assert.equal('zz' in saved.days, false);
    assert.equal(Object.keys(saved.days).length, SNAP.length + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
