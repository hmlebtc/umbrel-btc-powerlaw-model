// Tests for refraction.ts (spec sections 2.4 and 4). The engine is pure, so every
// case is a direct call — no I/O, no network. Published numbers (b1 ~ 5.72,
// c ~ 0.197, the author's table cells) appear ONLY via fixtures/refractionGolden.ts,
// which is generated from the Phase 1 Python reference's golden JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  anchorLogAt,
  decayAt,
  fitRefraction,
  linePriceAt,
  offsetAt,
  percentileExact,
  percentileOf,
  projectHeight,
  REFRACTION_ALPHA,
  REFRACTION_ANCHOR_TAU,
  REFRACTION_BLOCKS_PER_DAY,
  REFRACTION_DECAY_TAU,
  REFRACTION_GRID_PCTS,
  REFRACTION_LADDER,
  REFRACTION_MIN_POINTS,
  refractionTestHooks,
  type RefractionFit,
  type RefractionObservation,
} from './refraction.js';
import { HISTORY_FIXTURE, seededRandom } from './fixtures/history.js';
import { blockCountsFromSnapshot } from './fixtures/heights.js';
import {
  FIXTURE_ERA,
  PINNED_Q4B,
  PUBLISHED_EVALUATOR,
  REPLICA_24NOV,
  REPLICA_25NOV,
  type PctRows,
  type PctTable,
} from './fixtures/refractionGolden.js';

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

/**
 * The golden's fixture-era input, rebuilt from the app's own fixtures: prices
 * from HISTORY_FIXTURE, h = running sum of the RAW daily block counts through
 * that date + hOffset (-5), joined on date. (Not heightsFromSnapshot(): its
 * height basis is changing in another phase; the raw counts are stable.)
 */
function fixtureEraSample(): RefractionObservation[] {
  const cum = new Map<string, number>();
  let run = 0;
  for (const bc of blockCountsFromSnapshot()) {
    run += bc.count;
    cum.set(bc.date, run + FIXTURE_ERA.hOffset);
  }
  return HISTORY_FIXTURE.map((o) => {
    const h = cum.get(o.date);
    if (h === undefined) throw new Error(`no height for fixture date ${o.date}`);
    return { date: o.date, usd: o.usd, h };
  });
}

const SAMPLE = fixtureEraSample();
let cachedFit: RefractionFit | null = null;
let fitMs = NaN;
function eraFit(): RefractionFit {
  if (cachedFit === null) {
    const t0 = performance.now();
    cachedFit = fitRefraction(SAMPLE);
    fitMs = performance.now() - t0;
  }
  return cachedFit;
}

/** A RefractionFit carrying given coefficients and a [pct, offset] table (evaluator-only tests). */
function fitFrom(E: { b0: number; b1: number; c: number; alpha: number; zd: PctTable }): RefractionFit {
  return {
    b0: E.b0,
    b1: E.b1,
    c: E.c,
    alpha: E.alpha,
    gridPcts: E.zd.map((p) => p[0]),
    gridOffsets: E.zd.map((p) => p[1]),
    points: 0,
    dataStart: '',
    dataEnd: '',
    lastHeight: 0,
    anchorLoss: NaN,
    decayLoss: NaN,
    shareBelowAnchor: NaN,
  };
}

function rel(a: number, b: number): number {
  return Math.abs(a / b - 1);
}

/** Residual columns of a fit over a cleaned sample (as the engine computes them). */
function residuals(fit: RefractionFit, sample: readonly RefractionObservation[]): { r: number[]; h: number[] } {
  const r: number[] = [];
  const h: number[] = [];
  for (const o of sample) {
    r.push(Math.log10(o.usd) - (fit.b0 + fit.b1 * Math.log10(o.h)));
    h.push(o.h);
  }
  return { r, h };
}

/** Coverage definition: % of closes strictly below line `pct` at their own height. */
function coverage(fit: RefractionFit, sample: readonly RefractionObservation[], pct: number): number {
  let below = 0;
  for (const o of sample) if (o.usd < linePriceAt(fit, pct, o.h)) below++;
  return (100 * below) / sample.length;
}

/** Plain coverage share (%) of a point: r below the anchor, r/S above (the golden's share_below_pct). */
function shareBelow(fit: RefractionFit, sample: readonly RefractionObservation[], h: number, usd: number): number {
  const r0 = Math.log10(usd) - anchorLogAt(fit, h);
  const { r, h: hs } = residuals(fit, sample);
  let k = 0;
  if (r0 < 0) {
    for (const ri of r) if (ri < r0) k++;
  } else {
    const t0 = r0 / decayAt(fit.c, fit.alpha, h);
    for (let i = 0; i < r.length; i++) if ((r[i] as number) / decayAt(fit.c, fit.alpha, hs[i] as number) < t0) k++;
  }
  return (100 * k) / r.length;
}

function assertSameFit(a: RefractionFit, b: RefractionFit, label: string): void {
  for (const key of ['b0', 'b1', 'c', 'alpha', 'points', 'lastHeight', 'anchorLoss', 'decayLoss', 'shareBelowAnchor'] as const) {
    assert.ok(Object.is(a[key], b[key]), `${label}: ${key} ${a[key]} vs ${b[key]}`);
  }
  assert.equal(a.dataStart, b.dataStart, `${label}: dataStart`);
  assert.equal(a.dataEnd, b.dataEnd, `${label}: dataEnd`);
  assert.equal(a.gridOffsets.length, b.gridOffsets.length);
  for (let i = 0; i < a.gridOffsets.length; i++) {
    assert.ok(Object.is(a.gridPcts[i], b.gridPcts[i]), `${label}: gridPcts[${i}]`);
    assert.ok(Object.is(a.gridOffsets[i], b.gridOffsets[i]), `${label}: gridOffsets[${i}] ${a.gridOffsets[i]} vs ${b.gridOffsets[i]}`);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('model-definition constants match the spec', () => {
  assert.equal(REFRACTION_ALPHA, 1.25);
  assert.equal(REFRACTION_ANCHOR_TAU, 0.05);
  assert.equal(REFRACTION_DECAY_TAU, 0.999);
  assert.equal(REFRACTION_BLOCKS_PER_DAY, 144);
  assert.equal(REFRACTION_MIN_POINTS, 730);
  assert.equal(REFRACTION_ANCHOR_TAU * 100, 5); // the engine's anchor pct is exactly 5
  assert.deepEqual([...REFRACTION_GRID_PCTS], FIXTURE_ERA.zd.map((p) => p[0]));
  assert.deepEqual([...REFRACTION_LADDER], [0.1, 1, 5, 15, 25, 50, 75, 95, 99.9]);
  for (const q of REFRACTION_LADDER) assert.ok(REFRACTION_GRID_PCTS.includes(q), `ladder ${q} on the grid`);
});

// ---------------------------------------------------------------------------
// 1. Fixture-era fit vs the Python golden
// ---------------------------------------------------------------------------

test('fixture era: rebuilt input matches the golden checksum (data first, numbers second)', () => {
  const g = FIXTURE_ERA.input;
  assert.equal(SAMPLE.length, g.count);
  assert.equal(SAMPLE[0]?.date, g.firstDate);
  assert.equal(SAMPLE[SAMPLE.length - 1]?.date, g.lastDate);
  assert.equal(SAMPLE[0]?.h, g.firstH);
  assert.equal(SAMPLE[SAMPLE.length - 1]?.h, g.lastH);
  let sp = 0;
  let sh = 0;
  for (const o of SAMPLE) {
    sp += Math.log10(o.usd);
    sh += Math.log10(o.h);
  }
  // numpy sums pairwise and its log10 may differ by an ulp: agree to ~1e-15 relative, so 1e-9 absolute
  // still flags any single changed close or height.
  assert.ok(Math.abs(sp - g.sumLog10Price) < 1e-9, `sum log10 price ${sp} vs ${g.sumLog10Price}`);
  assert.ok(Math.abs(sh - g.sumLog10H) < 1e-9, `sum log10 h ${sh} vs ${g.sumLog10H}`);
});

test('fixture era: b0, b1, c, losses and shape match the golden', () => {
  const f = eraFit();
  const g = FIXTURE_ERA.fit;
  const tol = FIXTURE_ERA.tolerances;
  assert.ok(Math.abs(f.b0 - g.b0) <= tol.b0b1Abs, `b0 ${f.b0} vs ${g.b0}`);
  assert.ok(Math.abs(f.b1 - g.b1) <= tol.b0b1Abs, `b1 ${f.b1} vs ${g.b1}`);
  // c comes off a fixed grid: it must be the same double (or, at worst, 1e-12 away).
  assert.ok(Object.is(f.c, g.c) || Math.abs(f.c - g.c) <= 1e-12, `c ${f.c} vs ${g.c}`);
  assert.equal(f.alpha, g.alpha);
  assert.ok(rel(f.anchorLoss, g.anchorLoss) <= tol.lossRel, `anchorLoss ${f.anchorLoss} vs ${g.anchorLoss}`);
  assert.ok(rel(f.decayLoss, g.decayLoss) <= tol.lossRel, `decayLoss ${f.decayLoss} vs ${g.decayLoss}`);
  assert.equal(f.points, FIXTURE_ERA.input.count);
  assert.equal(f.dataStart, FIXTURE_ERA.input.firstDate);
  assert.equal(f.dataEnd, FIXTURE_ERA.input.lastDate);
  assert.equal(f.lastHeight, FIXTURE_ERA.input.lastH);
  assert.equal(f.shareBelowAnchor, g.closesBelowAnchor / FIXTURE_ERA.input.count);
  const hooked = refractionTestHooks.fitWith(SAMPLE, {});
  assert.equal(hooked.evals, g.cSearchEvaluations);
});

test('fixture era: all 27 grid offsets match the golden', () => {
  const f = eraFit();
  const tol = FIXTURE_ERA.tolerances.zdAbs;
  assert.equal(f.gridOffsets.length, 27);
  FIXTURE_ERA.zd.forEach(([q, v], i) => {
    assert.equal(f.gridPcts[i], q);
    assert.ok(Math.abs((f.gridOffsets[i] as number) - v) <= tol, `offset ${q}: ${f.gridOffsets[i]} vs ${v}`);
  });
  assert.equal(f.gridOffsets[REFRACTION_GRID_PCTS.indexOf(5)], 0);
});

test('fixture era: the 10 line probes match the golden', () => {
  const f = eraFit();
  for (const L of FIXTURE_ERA.lines) {
    const v = linePriceAt(f, L.q, L.h);
    assert.ok(rel(v, L.usd) <= FIXTURE_ERA.tolerances.lineRel, `line ${L.q} @ ${L.h}: ${v} vs ${L.usd}`);
  }
});

test('fixture era: the 10 percentile probes match the golden (exact type-8 inverse)', () => {
  const f = eraFit();
  for (const P of FIXTURE_ERA.percentiles) {
    const v = percentileExact(f, SAMPLE, P.h, P.usd);
    assert.ok(Math.abs(v - P.pct) <= FIXTURE_ERA.tolerances.pctAbs, `pct @ (${P.h}, ${P.usd}): ${v} vs ${P.pct}`);
    // ... and the plain coverage share recomputed here matches the golden's share_below_pct
    const s = shareBelow(f, SAMPLE, P.h, P.usd);
    assert.ok(Math.abs(s - P.shareBelowPct) <= FIXTURE_ERA.tolerances.pctAbs, `share @ (${P.h}, ${P.usd}): ${s} vs ${P.shareBelowPct}`);
  }
});

test('fixture era: one fit is fast enough for the home-server process', () => {
  eraFit();
  // Measured ~0.1 s on the dev box vs ~0.8 s for the straightforward port; 3 s is a smoke bound only.
  assert.ok(fitMs < 3000, `fitRefraction took ${fitMs.toFixed(0)} ms`);
});

// ---------------------------------------------------------------------------
// 2 + 3. Evaluator vs the published tables
// ---------------------------------------------------------------------------

function eachCell(rows: PctRows, heights: ReadonlyArray<number>, fn: (q: number, h: number, v: number) => void): number {
  let cells = 0;
  for (const [q, row] of rows) {
    row.forEach((v, j) => {
      if (v === null) return;
      fn(q, heights[j] as number, v);
      cells++;
    });
  }
  return cells;
}

test('published evaluator: reproduces the reference model outputs tightly', () => {
  const fit = fitFrom(PUBLISHED_EVALUATOR);
  const n = eachCell(PUBLISHED_EVALUATOR.lines, PUBLISHED_EVALUATOR.heights, (q, h, v) => {
    const got = linePriceAt(fit, q, h);
    assert.ok(rel(got, v) <= 1e-12, `${q} @ ${h}: ${got} vs ${v}`);
  });
  assert.equal(n, 36);
});

test('published evaluator: published 25 Nov table within the pinned-coefficient tolerance', () => {
  // Coefficients rounded to 3-4 decimals plus the golden's free-fit heights: the golden itself
  // documents "~0.05%" (measured worst cell 0.063%). See the hand-back: 0.01% is NOT reachable here.
  const fit = fitFrom(PUBLISHED_EVALUATOR);
  let worst = 0;
  const n = eachCell(PUBLISHED_EVALUATOR.published, PUBLISHED_EVALUATOR.heights, (q, h, v) => {
    worst = Math.max(worst, rel(linePriceAt(fit, q, h), v));
  });
  assert.equal(n, 28);
  assert.ok(worst <= 7e-4, `worst ${worst}`);
});

test('pinned coefficients with re-solved z/d and height (numeric-check Q4b): every cell within 0.01%', () => {
  const fit = fitFrom(PINNED_Q4B);
  let worst = 0;
  const n = eachCell(PINNED_Q4B.published, PINNED_Q4B.heights, (q, h, v) => {
    worst = Math.max(worst, rel(linePriceAt(fit, q, h), v));
  });
  assert.equal(n, 28);
  assert.ok(worst <= 1e-4, `worst ${worst}`);
  assert.ok(Math.abs(worst - PINNED_Q4B.reportedWorstRel) < 1e-6, `worst ${worst} vs reported ${PINNED_Q4B.reportedWorstRel}`);
});

for (const [name, E] of [
  ['25 Nov', REPLICA_25NOV],
  ['24 Nov', REPLICA_24NOV],
] as const) {
  test(`dollar-exact replica (${name}): every published cell within $0.50, model outputs tight`, () => {
    const fit = fitFrom(E);
    const cells = eachCell(E.published, E.heights, (q, h, v) => {
      const got = linePriceAt(fit, q, h);
      assert.ok(Math.abs(got - v) <= 0.5, `${q} @ ${h}: ${got} vs published ${v}`);
    });
    assert.equal(cells, name === '25 Nov' ? 28 : 13);
    eachCell(E.lines, E.heights, (q, h, v) => {
      const got = linePriceAt(fit, q, h);
      assert.ok(rel(got, v) <= 1e-12, `${q} @ ${h}: ${got} vs ${v}`);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Synthetic recovery
// ---------------------------------------------------------------------------

/**
 * Data drawn from a known Refraction model: draw a percentile u ~ U(0,1) per day
 * and place the close at the model's u-line (offsets linear in u between the
 * given knots, z*S above the anchor, d below). Heights 144/day with seeded jitter.
 */
function syntheticRefraction(opts: {
  b0: number;
  b1: number;
  c: number;
  knots: ReadonlyArray<readonly [number, number]>;
  count: number;
  seed: number;
  startDate?: string;
}): RefractionObservation[] {
  const rng = seededRandom(opts.seed);
  const truth = fitFrom({ b0: opts.b0, b1: opts.b1, c: opts.c, alpha: REFRACTION_ALPHA, zd: opts.knots });
  const start = Date.parse(`${opts.startDate ?? '2011-01-01'}T00:00:00Z`);
  const out: RefractionObservation[] = [];
  let h = 100000;
  for (let i = 0; i < opts.count; i++) {
    h += 130 + Math.floor(rng() * 29); // 130..158 blocks/day
    const u = 100 * rng();
    const q = Math.min(99.9, Math.max(0.1, u));
    out.push({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), usd: linePriceAt(truth, q, h), h });
  }
  return out;
}

const SYN_KNOTS = [
  [0.1, -0.09],
  [1, -0.06],
  [5, 0],
  [15, 0.12],
  [25, 0.22],
  [50, 0.55],
  [75, 0.97],
  [95, 1.45],
  [99.9, 1.8],
] as const;

test('synthetic recovery: coverage of every grid percentile and the anchor share', () => {
  const sample = syntheticRefraction({ b0: -29.5, b1: 5.73, c: 0.2, knots: SYN_KNOTS, count: 4000, seed: 20261126 });
  const f = fitRefraction(sample);
  const n = sample.length;
  // Coverage calibration: each line has a share q of closes below it, to within one order statistic.
  for (const q of REFRACTION_GRID_PCTS) {
    const cov = coverage(f, sample, q);
    assert.ok(Math.abs(cov - q) <= 100 * (2 / n), `coverage ${q}: ${cov}`);
  }
  assert.ok(Math.abs(f.shareBelowAnchor - 0.05) <= 2 / n, `anchor share ${f.shareBelowAnchor}`);
  // Structure recovered: anchor slope, decay rate and the upper offsets near the truth.
  assert.ok(Math.abs(f.b1 - 5.73) < 0.05, `b1 ${f.b1}`);
  assert.ok(Math.abs(f.c - 0.2) < 0.02, `c ${f.c}`);
  for (const [q, v] of SYN_KNOTS) {
    const got = offsetAt(f, q);
    assert.ok(Math.abs(got - v) < 0.03, `offset ${q}: ${got} vs ${v}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Properties
// ---------------------------------------------------------------------------

test('lines are strictly increasing in percentile at past, present and +20 years', () => {
  const f = eraFit();
  const h20 = projectHeight(f.lastHeight, f.dataEnd, '2046-07-10');
  const pcts = [...REFRACTION_GRID_PCTS, 0.3, 2.5, 4.99, 5.01, 6, 33, 66.6, 98, 99.95];
  pcts.sort((a, b) => a - b);
  for (const h of [FIXTURE_ERA.input.firstH, 400000, f.lastHeight, h20]) {
    for (let i = 1; i < pcts.length; i++) {
      const a = linePriceAt(f, pcts[i - 1] as number, h);
      const b = linePriceAt(f, pcts[i] as number, h);
      if ((pcts[i] as number) <= 99.9) assert.ok(b > a, `h=${h}: line ${pcts[i]} (${b}) > line ${pcts[i - 1]} (${a})`);
    }
  }
});

test('lines above the anchor converge on it; lines below are parallel to it', () => {
  const f = eraFit();
  const hs = [75000, 200000, 500000, f.lastHeight, 1.5e6, 2.5e6, 5e6];
  for (const q of REFRACTION_GRID_PCTS) {
    let prevRatio = Infinity;
    for (const h of hs) {
      const la = anchorLogAt(f, h);
      const lr = Math.log10(linePriceAt(f, q, h)) - la;
      if (q > 5) {
        assert.ok(lr < prevRatio, `q=${q}: log ratio to anchor decreasing in h at ${h}`);
        assert.ok(lr > 0);
        prevRatio = lr;
      } else {
        // parallel: constant log offset d_q at every height (only pow/log10 rounding)
        assert.ok(Math.abs(lr - offsetAt(f, q)) <= 1e-12 * Math.max(1, Math.abs(la)), `q=${q} parallel at ${h}`);
      }
    }
  }
});

test('percentileOf(linePriceAt(p, h), h) round-trips every grid percentile', () => {
  const f = eraFit();
  for (const h of [80000, 420000, f.lastHeight, projectHeight(f.lastHeight, f.dataEnd, '2046-07-10')]) {
    for (const p of [...REFRACTION_GRID_PCTS, 0.7, 12.5, 62]) {
      const back = percentileOf(f, h, linePriceAt(f, p, h));
      assert.ok(Math.abs(back - p) <= 1e-9, `h=${h} p=${p}: ${back}`);
    }
  }
});

test('percentileOf clamps to [0.1, 99.9] and returns NaN on bad input', () => {
  const f = eraFit();
  const h = f.lastHeight;
  assert.equal(percentileOf(f, h, 1e-6), 0.1);
  assert.equal(percentileOf(f, h, 1e12), 99.9);
  for (const [hh, usd] of [
    [0, 1000],
    [-5, 1000],
    [NaN, 1000],
    [Infinity, 1000],
    [h, 0],
    [h, -1],
    [h, NaN],
    [h, Infinity],
  ]) {
    assert.ok(Number.isNaN(percentileOf(f, hh as number, usd as number)), `NaN for (${hh}, ${usd})`);
  }
  assert.ok(Number.isNaN(percentileExact(f, SAMPLE, h, -1)));
  assert.ok(Number.isNaN(percentileExact(f, [], h, 1000)));
  assert.ok(Number.isNaN(linePriceAt(f, 50, 0)));
  assert.ok(Number.isNaN(linePriceAt(f, NaN, h)));
});

test('percentileExact agrees with the coverage definition to within one close', () => {
  const f = eraFit();
  const n = SAMPLE.length;
  const rng = seededRandom(7);
  for (let k = 0; k < 40; k++) {
    const o = SAMPLE[Math.floor(rng() * n)] as RefractionObservation;
    const usd = o.usd * Math.pow(10, (rng() - 0.5) * 0.6);
    const exact = percentileExact(f, SAMPLE, o.h, usd);
    const share = shareBelow(f, SAMPLE, o.h, usd);
    assert.ok(Math.abs(exact - share) <= 100 / n + 1e-9, `(${o.h}, ${usd}): exact ${exact} vs share ${share}`);
  }
  // and the grid approximation agrees with the exact inverse to a fraction of a percentile point
  for (const P of FIXTURE_ERA.percentiles) {
    const approx = percentileOf(f, P.h, P.usd);
    const exact = Math.min(99.9, Math.max(0.1, P.pct));
    assert.ok(Math.abs(approx - exact) < 1.5, `grid ${approx} vs exact ${exact}`);
  }
});

test('projectHeight: 144 blocks per whole UTC day, leap days included', () => {
  assert.equal(projectHeight(1000, '2028-02-28', '2028-03-01'), 1000 + 2 * 144); // 2028-02-29 exists
  assert.equal(projectHeight(1000, '2027-02-28', '2027-03-01'), 1000 + 144);
  assert.equal(projectHeight(1000, '2028-01-01', '2029-01-01'), 1000 + 366 * 144);
  assert.equal(projectHeight(1000, '2026-11-25', '2026-11-25'), 1000);
  assert.equal(projectHeight(1000, '2026-11-25', '2026-11-24'), 1000 - 144);
  assert.equal(projectHeight(1000, '2026-03-28', '2026-03-30'), 1000 + 288); // across EU DST: pure UTC
  assert.ok(Number.isNaN(projectHeight(1000, '2026-02-30', '2026-03-01')));
  assert.ok(Number.isNaN(projectHeight(1000, '2026-11-25', 'tomorrow')));
});

// ---------------------------------------------------------------------------
// 6. Determinism and edges
// ---------------------------------------------------------------------------

test('determinism: two fits on the same input are bit-identical', () => {
  assertSameFit(fitRefraction(SAMPLE), fitRefraction(SAMPLE), 'run2');
  assertSameFit(fitRefraction(SAMPLE), eraFit(), 'run3');
});

test('edges: junk rows are dropped and unsorted input is sorted (identical fit)', () => {
  const junk: RefractionObservation[] = [
    { date: '2015-01-01', usd: 0, h: 336000 },
    { date: '2015-01-02', usd: -3, h: 336100 },
    { date: '2015-01-03', usd: NaN, h: 336200 },
    { date: '2015-01-04', usd: 300, h: 0 },
    { date: '2015-01-05', usd: 300, h: -1 },
    { date: '2015-01-06', usd: 300, h: Infinity },
    { date: '2015-13-01', usd: 300, h: 336300 },
    { date: 'not a date', usd: 300, h: 336300 },
    null as unknown as RefractionObservation,
  ];
  // The junk dates collide with real dates; junk is dropped BEFORE de-duplication, so the real rows stay.
  const dirty = [...SAMPLE.slice(0, 2000), ...junk, ...SAMPLE.slice(2000)];
  assertSameFit(fitRefraction(dirty), eraFit(), 'junk');
  const rng = seededRandom(99);
  const shuffled = SAMPLE.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = shuffled[i] as RefractionObservation;
    shuffled[i] = shuffled[j] as RefractionObservation;
    shuffled[j] = t;
  }
  assertSameFit(fitRefraction(shuffled), eraFit(), 'shuffled');
});

test('edges: a duplicated date keeps the last row given', () => {
  const last = SAMPLE[SAMPLE.length - 1] as RefractionObservation;
  const stale = { ...last, usd: last.usd * 3 };
  assertSameFit(fitRefraction([...SAMPLE.slice(0, -1), stale, last]), eraFit(), 'dup');
});

test('edges: throws below REFRACTION_MIN_POINTS usable points, fits at exactly the minimum', () => {
  const sample = syntheticRefraction({ b0: -29.5, b1: 5.73, c: 0.2, knots: SYN_KNOTS, count: REFRACTION_MIN_POINTS, seed: 5 });
  assert.doesNotThrow(() => fitRefraction(sample));
  const short = [...sample.slice(0, REFRACTION_MIN_POINTS - 1), { date: '2030-01-01', usd: 0, h: 2e6 }];
  assert.throws(() => fitRefraction(short), /needs >= 730 usable closes.*got 729/);
  assert.throws(() => fitRefraction([]), /got 0/);
});

test('edges: huge heights keep every line finite (S -> 0 pulls upper lines onto the anchor)', () => {
  const f = eraFit();
  assert.equal(decayAt(f.c, f.alpha, 1e9), 0);
  for (const h of [5e6, 2e7, 1e8, 1e9, 1e12]) {
    const anchor = linePriceAt(f, 5, h);
    assert.ok(Number.isFinite(anchor) && anchor > 0, `anchor finite at ${h}`);
    for (const q of REFRACTION_GRID_PCTS) {
      const v = linePriceAt(f, q, h);
      assert.ok(Number.isFinite(v) && v > 0, `line ${q} finite at ${h}: ${v}`);
      if (q > 5 && h >= 1e8) assert.equal(v, anchor);
    }
    const p = percentileOf(f, h, anchor * 2);
    assert.ok(Number.isFinite(p) && p <= 99.9 && p >= 0.1, `percentileOf finite at ${h}: ${p}`);
    assert.ok(Number.isFinite(percentileExact(f, SAMPLE, h, anchor * 2)));
  }
  assert.equal(percentileOf(f, 1e9, linePriceAt(f, 5, 1e9) * 2), 99.9);
});

// ---------------------------------------------------------------------------
// 7. Fast path === straightforward oracle
// ---------------------------------------------------------------------------

/**
 * Test-only ORACLE: the reference's inner minimiser written the obvious way
 * (full stable argsort of t = r/S, cumulative S in sorted order, first index
 * reaching tau * total), independent of the engine's code.
 */
function oracleDecay(r: readonly number[], h: readonly number[], c: number): { loss: number; z: number } {
  const n = r.length;
  const s = h.map((hi) => 1 - Math.pow(Math.tanh((c * hi) / 200000), REFRACTION_ALPHA));
  const t = r.map((ri, i) => ri / (s[i] as number));
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => {
    const a = t[i] as number;
    const b = t[j] as number;
    return a < b ? -1 : a > b ? 1 : i - j;
  });
  let W = 0;
  for (const i of idx) W += s[i] as number;
  const target = REFRACTION_DECAY_TAU * W;
  let cw = 0;
  let z = t[idx[n - 1] as number] as number;
  for (const i of idx) {
    cw += s[i] as number;
    if (cw >= target) {
      z = t[i] as number;
      break;
    }
  }
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const e = (r[i] as number) - z * (s[i] as number);
    loss += e >= 0 ? REFRACTION_DECAY_TAU * e : (REFRACTION_DECAY_TAU - 1) * e;
  }
  return { loss, z };
}

test('fast path: the whole fit equals the straightforward full-sort fit bit for bit', () => {
  const oracle = refractionTestHooks.fitWith(SAMPLE, { oracle: true });
  const fast = refractionTestHooks.fitWith(SAMPLE, {});
  assertSameFit(fast.fit, oracle.fit, 'fast vs oracle');
  assertSameFit(eraFit(), oracle.fit, 'public vs oracle');
  assert.equal(fast.evals, oracle.evals);
  assert.ok(fast.computed < fast.evals, `memo saved evaluations: ${fast.computed}/${fast.evals}`);
  assert.ok(fast.fastEvals >= fast.computed - 2, `fast path taken ${fast.fastEvals}/${fast.computed}`);
  const syn = syntheticRefraction({ b0: -29.5, b1: 5.73, c: 0.2, knots: SYN_KNOTS, count: 3000, seed: 11 });
  assertSameFit(refractionTestHooks.fitWith(syn, {}).fit, refractionTestHooks.fitWith(syn, { oracle: true }).fit, 'synthetic');
});

test('fast path: per-c inner minimiser equals the test oracle across c, buffer growth and forced fallback', () => {
  const f = eraFit();
  const { r, h } = residuals(f, SAMPLE);
  for (let k = 0; k <= 120; k++) {
    const c = 0.001 + k * 0.01;
    const o = oracleDecay(r, h, c);
    for (const mode of [{}, { topHint: 1 }, { guardScale: 1e12 }]) {
      const got = refractionTestHooks.decayAtC(r, h, c, mode);
      assert.ok(Object.is(got.z, o.z), `c=${c} ${JSON.stringify(mode)}: z ${got.z} vs ${o.z}`);
      assert.ok(Object.is(got.loss, o.loss), `c=${c} ${JSON.stringify(mode)}: loss`);
      if ('guardScale' in mode) assert.equal(got.fast, false);
    }
  }
});

test('fast path: heavy ties in t resolve by index exactly like the stable sort', () => {
  const rng = seededRandom(3);
  const n = 3000;
  // Few distinct r and h values => many exactly equal t = r/S, including at the cut.
  const r = Array.from({ length: n }, () => [-0.1, 0, 0.3, 0.9, 1.2][Math.floor(rng() * 5)] as number);
  const h = Array.from({ length: n }, () => [300000, 600000, 900000][Math.floor(rng() * 3)] as number);
  for (const c of [0.05, 0.2, 0.5, 1]) {
    const o = oracleDecay(r, h, c);
    for (const mode of [{}, { topHint: 2 }]) {
      const got = refractionTestHooks.decayAtC(r, h, c, mode);
      assert.ok(Object.is(got.z, o.z) && Object.is(got.loss, o.loss), `ties c=${c}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R6: the c search refuses an edge instead of walking off its grid
// ---------------------------------------------------------------------------

const EDGE_ERR = /decay rate c has no interior optimum on \[0\.02, 1\]/;

test('R6: real 730-close window 2016-01-08..2018-01-06 hits the lower c edge and throws', () => {
  const w = SAMPLE.filter((o) => o.date >= '2016-01-08' && o.date <= '2018-01-06');
  assert.equal(w.length, REFRACTION_MIN_POINTS);
  assert.throws(() => fitRefraction(w), /lower edge/);
  assert.throws(() => fitRefraction(w), EDGE_ERR);
});

test('R6: synthetic "top grows" sample (last 700 closes x30) throws at the lower edge', () => {
  const syn = SAMPLE.map((o, i) => (i > SAMPLE.length - 700 ? { ...o, usd: o.usd * 30 } : o));
  assert.throws(() => fitRefraction(syn), /lower edge/);
});

test('R6: synthetic sample with very fast decay throws at the upper edge', () => {
  const syn = syntheticRefraction({ b0: -29.5, b1: 5.73, c: 4, knots: SYN_KNOTS, count: 3000, seed: 42 });
  assert.throws(() => fitRefraction(syn), /upper edge/);
});

test('R6: the fixture-era fit is unaffected (same doubles as before the guard, 345 evaluations)', () => {
  const f = eraFit();
  // Values recorded from this engine before the guard existed (and c = the golden double).
  assert.ok(Object.is(f.b0, -29.62308807260035));
  assert.ok(Object.is(f.b1, 5.7529277242698384));
  assert.ok(Object.is(f.c, FIXTURE_ERA.fit.c));
  assert.equal(refractionTestHooks.fitWith(SAMPLE, {}).evals, FIXTURE_ERA.fit.cSearchEvaluations);
  assert.ok(f.c > 0.02 && f.c < 1);
});
