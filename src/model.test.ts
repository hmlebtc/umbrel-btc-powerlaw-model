// Tests for model.ts (spec section 4). The engine is pure, so every case here is
// a direct call — no I/O, no network. Published values (n~5.7, R^2~0.95) appear
// ONLY as the corridor bounds below, never in src.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBandOffsets,
  currentQuantile,
  dateFromT,
  falsifiability,
  fit,
  fitOLS,
  milestones,
  percentile,
  pointInTimeResiduals,
  residualsForBands,
  t,
  trendUsdAt,
} from './model.js';
import { HISTORY_FIXTURE, syntheticPowerLaw } from './fixtures/history.js';

// ---------------------------------------------------------------------------
// t(): UTC-anchored, DST-independent, genesis at 0.
// ---------------------------------------------------------------------------

test('t(): genesis is 0 and advances one per UTC day', () => {
  assert.equal(t('2009-01-03'), 0);
  assert.equal(t('2009-01-04'), 1);
  assert.equal(t('2009-01-13'), 10);
});

test('t(): is pure UTC arithmetic across a DST boundary (no local-time drift)', () => {
  // US spring-forward 2021-03-14; UK 2021-03-28. Differences must stay exactly 1.
  assert.equal(t('2021-03-15') - t('2021-03-14'), 1);
  assert.equal(t('2021-03-29') - t('2021-03-28'), 1);
  // A day either side of a UTC year boundary.
  assert.equal(t('2021-01-01') - t('2020-12-31'), 1);
});

test('dateFromT is the inverse of t for whole days', () => {
  for (const dstr of ['2009-01-04', '2013-07-01', '2021-03-14', '2045-12-31']) {
    assert.equal(dateFromT(t(dstr)), dstr);
  }
});

// ---------------------------------------------------------------------------
// Percentile: linear interpolation between order statistics (hand-computed).
// ---------------------------------------------------------------------------

test('percentile: linear interpolation matches hand-computed values', () => {
  const arr = [10, 20, 30, 40]; // N=4, (N-1) basis
  assert.equal(percentile(arr, 25), 17.5); // rank 0.75 -> 10 + .75*10
  assert.equal(percentile(arr, 50), 25); // rank 1.5  -> 20 + .5*10
  assert.equal(percentile(arr, 97.5), 39.25); // rank 2.925 -> 30 + .925*10
  assert.equal(percentile(arr, 0), 10);
  assert.equal(percentile(arr, 100), 40);
});

test('percentile: unsorted input and single/empty edge cases', () => {
  assert.equal(percentile([40, 10, 30, 20], 50), 25);
  assert.equal(percentile([7], 42), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

// ---------------------------------------------------------------------------
// Exact recovery on a synthetic power law (spec section 4).
// ---------------------------------------------------------------------------

test('fitOLS: exact recovery of a noiseless power law to <1e-9', () => {
  // Published-value-free: the coefficients are passed IN by this test.
  const A_INTERCEPT = -16.5;
  const N_EXP = 5.69;
  const sample = syntheticPowerLaw({ a: A_INTERCEPT, n: N_EXP, startT: 1, count: 2500, noiseSigma: 0 });
  const f = fitOLS(sample);
  assert.ok(Math.abs(f.a - A_INTERCEPT) < 1e-9, `|da|=${Math.abs(f.a - A_INTERCEPT)}`);
  assert.ok(Math.abs(f.n - N_EXP) < 1e-9, `|dn|=${Math.abs(f.n - N_EXP)}`);
  assert.ok(f.r2 > 0.999999, `r2=${f.r2}`);
  assert.equal(f.points, 2500);
});

test('fitOLS: throws on fewer than two priced points', () => {
  assert.throws(() => fitOLS([{ date: '2015-01-01', usd: 100 }]));
});

// ---------------------------------------------------------------------------
// Real fixture corridor (spec section 4).
// ---------------------------------------------------------------------------

test('fit: real blockchain.info fixture lands in the published corridor', () => {
  const sample = HISTORY_FIXTURE.map((o) => ({ date: o.date, usd: o.usd }));
  // The unsampled (sampled=false) snapshot is TRUE daily data: ~5,800 priced pts.
  assert.ok(sample.length >= 5800, `expected ~5,800+ priced fixture points, got ${sample.length}`);
  const f = fit(sample, 'fullSample');
  assert.ok(f.points >= 5800, `points=${f.points}`);
  assert.ok(f.n >= 5.3 && f.n <= 6.1, `n=${f.n} outside [5.3,6.1]`);
  assert.ok(f.r2 >= 0.93, `r2=${f.r2} below 0.93`);

  const last = sample[sample.length - 1]!;
  const fairValue = trendUsdAt(f.a, f.n, t(last.date));
  assert.ok(
    fairValue >= last.usd / 3 && fairValue <= last.usd * 3,
    `fair value ${fairValue} not within [${last.usd / 3}, ${last.usd * 3}]`,
  );
});

// ---------------------------------------------------------------------------
// Point-in-time bands on synthetic-with-known-noise (spec section 4).
// ---------------------------------------------------------------------------

test('pointInTime bands approximate the known Gaussian noise sigma', () => {
  const SIGMA = 0.15;
  const sample = syntheticPowerLaw({
    a: -16.5,
    n: 5.69,
    startT: 1,
    count: 2500,
    noiseSigma: SIGMA,
    seed: 42,
  });
  const pit = pointInTimeResiduals(sample);
  assert.ok(pit.length > 1500, `expected many point-in-time residuals, got ${pit.length}`);

  const f = fitOLS(sample);
  const bands = computeBandOffsets(f, sample, 'pointInTime');
  // Ordering: p975 > p835 > 0 > p165 > p025.
  assert.ok(bands.p975 > bands.p835 && bands.p835 > 0);
  assert.ok(bands.p025 < bands.p165 && bands.p165 < 0);
  // ~1.96*sigma for the outer band, roughly symmetric.
  const expectedOuter = 1.96 * SIGMA;
  assert.ok(Math.abs(bands.p975 - expectedOuter) < 0.06, `p975=${bands.p975}`);
  assert.ok(Math.abs(bands.p025 + expectedOuter) < 0.06, `p025=${bands.p025}`);
});

test('computeBandOffsets: pointInTime degrades to fullSample when sample is short', () => {
  const sample = syntheticPowerLaw({ a: -16, n: 5.5, startT: 1, count: 100, noiseSigma: 0.1, seed: 7 });
  const f = fitOLS(sample);
  const pit = computeBandOffsets(f, sample, 'pointInTime');
  const full = computeBandOffsets(f, sample, 'fullSample');
  // < 730 points -> no point-in-time residuals -> identical to full-sample bands.
  assert.deepEqual(pit, full);
});

// ---------------------------------------------------------------------------
// v0.1.2 band fan: eleven individually-labelled percentile lines (spec 12.1).
// 0.5, 2.5, 10, 16.5, 25, 50, 75, 83.5, 90, 97.5, 99.5. p10/p50/p90 are the
// pure v0.1.2 addition over the eight v0.1.1 keys.
// ---------------------------------------------------------------------------

test('computeBandOffsets: exposes all eleven keys, non-decreasing in ascending-p order', () => {
  const sample = syntheticPowerLaw({
    a: -16.5,
    n: 5.69,
    startT: 1,
    count: 2500,
    noiseSigma: 0.15,
    seed: 42,
  });
  const f = fitOLS(sample);
  const bands = computeBandOffsets(f, sample, 'pointInTime');

  // All eleven percentiles are present (pure addition over the v0.1.1 eight keys).
  assert.deepEqual(
    Object.keys(bands).sort(),
    ['p005', 'p025', 'p10', 'p165', 'p25', 'p50', 'p75', 'p835', 'p90', 'p975', 'p995'].sort(),
  );

  // Offsets are monotonically non-decreasing in ascending percentile order:
  // 0.5 < 2.5 < 10 < 16.5 < 25 < 50 < 75 < 83.5 < 90 < 97.5 < 99.5 — the key
  // order here is deliberately by percentile value, not lexicographic key order.
  const inPOrder = [
    bands.p005,
    bands.p025,
    bands.p10,
    bands.p165,
    bands.p25,
    bands.p50,
    bands.p75,
    bands.p835,
    bands.p90,
    bands.p975,
    bands.p995,
  ];
  for (let i = 1; i < inPOrder.length; i++) {
    assert.ok(
      (inPOrder[i] as number) >= (inPOrder[i - 1] as number),
      `not monotone at ${i}: ${inPOrder[i - 1]} -> ${inPOrder[i]}`,
    );
  }
  // Symmetric noise: the inner pair straddles zero and the outer pair is widest.
  assert.ok(bands.p25 < 0 && bands.p75 > 0);
  assert.ok(bands.p005 < bands.p025 && bands.p975 < bands.p995);
});

test('computeBandOffsets: p50 (median) of symmetric residuals sits ~0', () => {
  // Zero-mean symmetric Gaussian noise -> the median residual is essentially 0,
  // and much closer to zero than the inner quartiles bracketing it.
  const sample = syntheticPowerLaw({
    a: -16.5,
    n: 5.69,
    startT: 1,
    count: 2500,
    noiseSigma: 0.15,
    seed: 42,
  });
  const f = fitOLS(sample);
  const bands = computeBandOffsets(f, sample, 'fullSample');
  assert.ok(Math.abs(bands.p50) < 0.01, `p50=${bands.p50} not ~0`);
  // The median is bracketed by the 25%/75% quartiles it lands between.
  assert.ok(bands.p25 < bands.p50 && bands.p50 < bands.p75);
});

test('computeBandOffsets: each key maps to its percentile of the banded residual set', () => {
  const sample = syntheticPowerLaw({ a: -16.5, n: 5.69, startT: 1, count: 2500, noiseSigma: 0.15, seed: 42 });
  const f = fitOLS(sample);
  // fullSample -> the banded residual set is exactly residualsForBands(...,'fullSample'),
  // so the mapping key->percentile can be checked to floating-point equality.
  const residuals = residualsForBands(sample, f.a, f.n, 'fullSample');
  const bands = computeBandOffsets(f, sample, 'fullSample');
  assert.equal(bands.p005, percentile(residuals, 0.5));
  assert.equal(bands.p025, percentile(residuals, 2.5));
  assert.equal(bands.p10, percentile(residuals, 10));
  assert.equal(bands.p165, percentile(residuals, 16.5));
  assert.equal(bands.p25, percentile(residuals, 25));
  assert.equal(bands.p50, percentile(residuals, 50));
  assert.equal(bands.p75, percentile(residuals, 75));
  assert.equal(bands.p835, percentile(residuals, 83.5));
  assert.equal(bands.p90, percentile(residuals, 90));
  assert.equal(bands.p975, percentile(residuals, 97.5));
  assert.equal(bands.p995, percentile(residuals, 99.5));
});

test('percentile: hand-computed p005/p995 with interpolation on a small vector', () => {
  const arr = [0, 10, 20, 30, 40]; // N=5, (N-1) basis
  // p=0.5  -> rank 0.005*4 = 0.02 -> 0  + (10-0)*0.02 = 0.2
  assert.ok(Math.abs(percentile(arr, 0.5) - 0.2) < 1e-12, `p005=${percentile(arr, 0.5)}`);
  // p=99.5 -> rank 0.995*4 = 3.98 -> 30 + (40-30)*0.98 = 39.8
  assert.ok(Math.abs(percentile(arr, 99.5) - 39.8) < 1e-12, `p995=${percentile(arr, 99.5)}`);
});

test('residualsForBands: matches the residual set each bandMode actually bands (F4)', () => {
  // Long noised sample so the point-in-time window is populated.
  const sample = syntheticPowerLaw({
    a: -16.5,
    n: 5.69,
    startT: 1,
    count: 2500,
    noiseSigma: 0.15,
    seed: 42,
  });
  const f = fitOLS(sample);

  // pointInTime -> the expanding-window residuals (what currentQuantile must use).
  const pit = pointInTimeResiduals(sample);
  assert.deepEqual(residualsForBands(sample, f.a, f.n, 'pointInTime'), pit);

  // fullSample -> reproduces fitOLS's own residual vector to floating precision.
  const full = residualsForBands(sample, f.a, f.n, 'fullSample');
  assert.equal(full.length, f.residuals.length);
  for (let i = 0; i < full.length; i++) {
    assert.ok(Math.abs((full[i] as number) - (f.residuals[i] as number)) < 1e-12);
  }

  // Coherence: a quantile taken over the pointInTime set differs from one over
  // the full-sample set, so using the wrong set would visibly disagree with the
  // drawn band — the exact bug F4 fixes.
  const tToday = t(sample[sample.length - 1]!.date);
  const spot = trendUsdAt(f.a, f.n, tToday) * 1.4; // 40% above trend
  const qPit = currentQuantile(pit, f.a, f.n, tToday, spot);
  const qFull = currentQuantile(full, f.a, f.n, tToday, spot);
  assert.ok(Number.isFinite(qPit) && Number.isFinite(qFull));
});

test('residualsForBands: pointInTime falls back to full-sample on a short sample (F4)', () => {
  const sample = syntheticPowerLaw({ a: -16, n: 5.5, startT: 1, count: 100, noiseSigma: 0.1, seed: 7 });
  const f = fitOLS(sample);
  // < 730 points -> no point-in-time residuals -> the full-sample set is used.
  assert.deepEqual(
    residualsForBands(sample, f.a, f.n, 'pointInTime'),
    residualsForBands(sample, f.a, f.n, 'fullSample'),
  );
});

// ---------------------------------------------------------------------------
// currentQuantile edge cases (spec section 4).
// ---------------------------------------------------------------------------

test('currentQuantile: below-all -> 0, above-all -> 100, midpoint fraction', () => {
  // Build a sample whose residuals we can reason about: use an exact line so the
  // fit residuals are ~0, then probe spot around the trend.
  const sample = syntheticPowerLaw({ a: -16.5, n: 5.69, startT: 1, count: 800, noiseSigma: 0 });
  const f = fitOLS(sample);
  const tToday = t(sample[sample.length - 1]!.date);
  const trend = trendUsdAt(f.a, f.n, tToday);
  // Residuals are all ~0, so spot well above trend -> 100, well below -> 0.
  assert.equal(currentQuantile(f.residuals, f.a, f.n, tToday, trend * 10), 100);
  assert.equal(currentQuantile(f.residuals, f.a, f.n, tToday, trend / 10), 0);
});

test('currentQuantile: fraction at or below a known residual set', () => {
  // Residuals [-0.3,-0.1,0,0.1,0.2]; with a=0,n=0 the trend log at any t is 0, so
  // spotResidual = log10(spot). Choose spot=1 -> residual 0 -> 3 of 5 are <=0 -> 60%.
  const residuals = [-0.3, -0.1, 0, 0.1, 0.2];
  assert.equal(currentQuantile(residuals, 0, 0, 1, 1), 60);
  assert.equal(currentQuantile(residuals, 0, 0, 1, 0.001), 0);
  assert.equal(currentQuantile(residuals, 0, 0, 1, 1000), 100);
});

// ---------------------------------------------------------------------------
// Falsifiability guards (spec section 4).
// ---------------------------------------------------------------------------

test('falsifiability: healthy fixture passes; a crashed spot fails the floor', () => {
  const sample = HISTORY_FIXTURE.map((o) => ({ date: o.date, usd: o.usd }));
  const f = fitOLS(sample);
  const tToday = t(sample[sample.length - 1]!.date);
  const trend = trendUsdAt(f.a, f.n, tToday);

  const healthy = falsifiability(f, tToday, trend);
  assert.equal(healthy.exponentInRange, true);
  assert.equal(healthy.r2Healthy, true);
  assert.equal(healthy.aboveFloor, true);

  // Spot 10 orders of magnitude below trend -> below the -3 sigma floor.
  const crashed = falsifiability(f, tToday, trend * 1e-10);
  assert.equal(crashed.aboveFloor, false);
});

// ---------------------------------------------------------------------------
// Milestones (spec section 4).
// ---------------------------------------------------------------------------

test('milestones: crossings and Jan-1 values derive from (a, n)', () => {
  const sample = HISTORY_FIXTURE.map((o) => ({ date: o.date, usd: o.usd }));
  const f = fitOLS(sample);
  const m = milestones(f.a, f.n);

  assert.equal(m.crossings.length, 3);
  for (const c of m.crossings) {
    assert.ok(c.usd === 100_000 || c.usd === 1_000_000 || c.usd === 10_000_000);
    assert.equal(typeof c.date, 'string'); // a rising trend crosses each target
  }
  // $1M crossing must be later than $100k.
  const k100 = m.crossings.find((c) => c.usd === 100_000)!.date!;
  const m1 = m.crossings.find((c) => c.usd === 1_000_000)!.date!;
  assert.ok(m1 > k100);

  assert.deepEqual(
    m.janFirstValues.map((v) => v.year),
    [2030, 2035, 2040, 2045],
  );
  // Monotonically increasing trend value year over year.
  for (let i = 1; i < m.janFirstValues.length; i++) {
    assert.ok(m.janFirstValues[i]!.usd > m.janFirstValues[i - 1]!.usd);
  }
});

test('milestones: a non-positive exponent yields null crossing dates', () => {
  const m = milestones(-16.5, -1);
  for (const c of m.crossings) assert.equal(c.date, null);
});
