/**
 * Power-law fit engine (spec section 4). PURE — no I/O, no clock, no globals.
 * Every value the dashboard shows (A, n, r2, sigma, band offsets, milestones)
 * is produced here from data at fit time; NOTHING in this file is a hard-coded
 * model coefficient. Published numbers (n~5.7, R^2~0.95) live ONLY in the test
 * corridors that call these functions.
 *
 * Model: price = A * t^n, with t = whole days since the Bitcoin genesis block
 * (2009-01-03 UTC). The regression is ordinary least squares of y = log10(usd)
 * on x = log10(t). The epoch is FIXED and must never be configurable — the
 * fitted (A, n) are only meaningful relative to this anchor because the exponent
 * is origin-sensitive (see README).
 */

import type {
  BandMode,
  BandOffsets,
  DailyObservation,
  Falsifiability,
  Milestones,
  ModelFit,
  OlsFit,
} from './types.js';

// ---------------------------------------------------------------------------
// Epoch & time
// ---------------------------------------------------------------------------

/** Genesis block date, 2009-01-03 UTC, in ms. FIXED — never configurable. */
export const EPOCH_MS = Date.UTC(2009, 0, 3);

const DAY_MS = 86_400_000;

/**
 * Whole days since genesis for a `YYYY-MM-DD` UTC date.
 * `t = floor((Date.UTC(date) - Date.UTC(2009,0,3)) / 86400000)`.
 */
export function t(dateUTC: string): number {
  const [y, m, d] = dateUTC.split('-').map((p) => Number(p));
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return Math.floor((ms - EPOCH_MS) / DAY_MS);
}

/** Inverse of t(): the UTC `YYYY-MM-DD` that is `tDays` whole days after genesis. */
export function dateFromT(tDays: number): string {
  const dt = new Date(EPOCH_MS + Math.round(tDays) * DAY_MS);
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  const p = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return `${yy}-${p(mm)}-${p(dd)}`;
}

/** Trend value in log10 space at day t: a + n*log10(t). */
export function trendLogAt(a: number, n: number, tDays: number): number {
  return a + n * Math.log10(tDays);
}

/** Trend price in USD at day t: A * t^n = 10^(a + n*log10(t)). */
export function trendUsdAt(a: number, n: number, tDays: number): number {
  return Math.pow(10, trendLogAt(a, n, tDays));
}

// ---------------------------------------------------------------------------
// Percentiles (linear interpolation between order statistics)
// ---------------------------------------------------------------------------

/**
 * Percentile via linear interpolation between order statistics (the numpy
 * default / "inclusive" method on an (N-1) basis). `p` is in [0,100].
 * Returns NaN for an empty input.
 */
export function percentile(values: readonly number[], p: number): number {
  const N = values.length;
  if (N === 0) return NaN;
  if (N === 1) return values[0] as number;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = (p / 100) * (N - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  const vLo = sorted[lo] as number;
  const vHi = sorted[hi] as number;
  return vLo + (vHi - vLo) * frac;
}

// ---------------------------------------------------------------------------
// OLS fit
// ---------------------------------------------------------------------------

interface Prepared {
  dates: string[];
  ts: number[];
  xs: number[];
  ys: number[];
}

/** Sort chronologically, drop usd<=0 and t<1, and precompute log columns. */
function prepare(sample: readonly DailyObservation[]): Prepared {
  const sorted = [...sample].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dates: string[] = [];
  const ts: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const obs of sorted) {
    if (!(obs.usd > 0)) continue;
    const td = t(obs.date);
    if (td < 1) continue;
    dates.push(obs.date);
    ts.push(td);
    xs.push(Math.log10(td));
    ys.push(Math.log10(obs.usd));
  }
  return { dates, ts, xs, ys };
}

/**
 * Ordinary least squares of y=log10(usd) on x=log10(t). Returns slope n,
 * intercept a (= log10 A), r2 = 1 - SSE/SST, sigma = population std-dev of
 * residuals, and the chronological residual vector. Throws when fewer than two
 * usable points exist (a line cannot be fit).
 */
export function fitOLS(sample: readonly DailyObservation[]): OlsFit {
  const { dates, xs, ys } = prepare(sample);
  const N = xs.length;
  if (N < 2) throw new Error(`fitOLS needs >=2 positive-price points, got ${N}`);

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < N; i++) {
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    sx += xi;
    sy += yi;
    sxx += xi * xi;
    sxy += xi * yi;
  }
  const denom = N * sxx - sx * sx;
  if (denom === 0) throw new Error('fitOLS: degenerate x column (all t equal)');
  const n = (N * sxy - sx * sy) / denom;
  const a = (sy - n * sx) / N;

  const yBar = sy / N;
  let sse = 0;
  let sst = 0;
  const residuals: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    const resid = yi - (a + n * xi);
    residuals[i] = resid;
    sse += resid * resid;
    sst += (yi - yBar) * (yi - yBar);
  }
  const r2 = sst === 0 ? 1 : 1 - sse / sst;
  const sigma = Math.sqrt(sse / N);

  return {
    a,
    n,
    A: Math.pow(10, a),
    r2,
    sigma,
    points: N,
    dataStart: dates[0] as string,
    dataEnd: dates[N - 1] as string,
    residuals,
  };
}

// ---------------------------------------------------------------------------
// Band offsets
// ---------------------------------------------------------------------------

const BAND_PCTS = { p025: 2.5, p165: 16.5, p835: 83.5, p975: 97.5 } as const;

function offsetsFromResiduals(residuals: readonly number[]): BandOffsets {
  return {
    p025: percentile(residuals, BAND_PCTS.p025),
    p165: percentile(residuals, BAND_PCTS.p165),
    p835: percentile(residuals, BAND_PCTS.p835),
    p975: percentile(residuals, BAND_PCTS.p975),
  };
}

/** Minimum expanding-window point count before a pointInTime residual is kept. */
export const POINT_IN_TIME_MIN_WINDOW = 730;

/**
 * Point-in-time residuals (spec section 4): an expanding-window OLS advanced
 * with O(1)-updatable running sums. For each chronological point i, once the
 * window holds >= 730 points, the residual is y_i minus the fit over points
 * <= i evaluated at x_i. These are the residuals whose percentiles form the
 * "as it looked at the time" bands porkopolis adopted after Jan 2025.
 */
export function pointInTimeResiduals(sample: readonly DailyObservation[]): number[] {
  const { xs, ys } = prepare(sample);
  const N = xs.length;
  const out: number[] = [];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < N; i++) {
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    sx += xi;
    sy += yi;
    sxx += xi * xi;
    sxy += xi * yi;
    const count = i + 1;
    if (count < POINT_IN_TIME_MIN_WINDOW) continue;
    const denom = count * sxx - sx * sx;
    if (denom === 0) continue;
    const slope = (count * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / count;
    out.push(yi - (intercept + slope * xi));
  }
  return out;
}

/**
 * The residual set a given band mode measures its percentiles over — the single
 * source of truth for "which residuals" (spec section 4). `fullSample` recomputes
 * the whole-sample residuals from `sample` against the supplied (a, n); this is
 * numerically identical to fitOLS's residual vector when (a, n) are that fit's
 * coefficients. `pointInTime` uses the expanding-window residuals, degrading to
 * full-sample when the sample is too short to yield >= 2 of them. currentQuantile
 * must be taken against THIS set so the quantile readout and the band the spot
 * visually sits in can never disagree — hence it is exported for on-demand
 * recomputation (the set itself is too big to persist).
 */
export function residualsForBands(
  sample: readonly DailyObservation[],
  a: number,
  n: number,
  mode: BandMode,
): number[] {
  if (mode === 'pointInTime') {
    const pit = pointInTimeResiduals(sample);
    if (pit.length >= 2) return pit;
  }
  const { xs, ys } = prepare(sample);
  const out: number[] = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    out[i] = (ys[i] as number) - (a + n * (xs[i] as number));
  }
  return out;
}

/**
 * Band offsets for the requested mode. Percentiles of the residual set
 * residualsForBands() selects (full-sample residuals, or the expanding-window
 * point-in-time residuals with a full-sample fallback when the sample is short).
 */
export function computeBandOffsets(
  fit: OlsFit,
  sample: readonly DailyObservation[],
  mode: BandMode,
): BandOffsets {
  return offsetsFromResiduals(residualsForBands(sample, fit.a, fit.n, mode));
}

// ---------------------------------------------------------------------------
// Top-level fit
// ---------------------------------------------------------------------------

/** Fit the sample and attach band offsets for `mode`. */
export function fit(
  sample: readonly DailyObservation[],
  mode: BandMode,
  includesProvisionalSpot = false,
): ModelFit {
  const ols = fitOLS(sample);
  const bandOffsets = computeBandOffsets(ols, sample, mode);
  return {
    a: ols.a,
    n: ols.n,
    A: ols.A,
    r2: ols.r2,
    sigma: ols.sigma,
    points: ols.points,
    dataStart: ols.dataStart,
    dataEnd: ols.dataEnd,
    bandMode: mode,
    bandOffsets,
    includesProvisionalSpot,
  };
}

// ---------------------------------------------------------------------------
// Current quantile, falsifiability, milestones
// ---------------------------------------------------------------------------

/**
 * Percentage of sample residuals at or below the spot residual
 * (log10(spot) - trend(today)). 0 when spot sits below every residual, 100 when
 * above all of them.
 */
export function currentQuantile(
  residuals: readonly number[],
  a: number,
  n: number,
  tToday: number,
  spotUsd: number,
): number {
  const N = residuals.length;
  if (N === 0 || !(spotUsd > 0) || tToday < 1) return NaN;
  const spotResidual = Math.log10(spotUsd) - trendLogAt(a, n, tToday);
  let le = 0;
  for (const r of residuals) if (r <= spotResidual) le++;
  return (le / N) * 100;
}

/**
 * Falsifiability guards (spec section 4): the exponent must stay in [5.0,7.0],
 * r2 must clear 0.80, and spot must not fall more than 3 sigma below trend.
 */
export function falsifiability(
  fitLike: { a: number; n: number; r2: number; sigma: number },
  tToday: number,
  spotUsd: number,
): Falsifiability {
  const trend = trendUsdAt(fitLike.a, fitLike.n, tToday);
  const floor = trend * Math.pow(10, -3 * fitLike.sigma);
  return {
    exponentInRange: fitLike.n >= 5.0 && fitLike.n <= 7.0,
    r2Healthy: fitLike.r2 >= 0.8,
    aboveFloor: spotUsd >= floor,
  };
}

const CROSSING_TARGETS = [100_000, 1_000_000, 10_000_000] as const;
const JAN_FIRST_YEARS = [2030, 2035, 2040, 2045] as const;

/**
 * Milestones derived from the current (a, n) — never stored. `crossings` are the
 * dates the trend line reaches $100k / $1M / $10M; `janFirstValues` are the
 * trend price on Jan 1 of 2030 / 2035 / 2040 / 2045.
 */
export function milestones(a: number, n: number): Milestones {
  const crossings = CROSSING_TARGETS.map((usd) => {
    if (!(n > 0)) return { usd, date: null };
    const tCross = Math.pow(10, (Math.log10(usd) - a) / n);
    if (!Number.isFinite(tCross) || tCross < 1) return { usd, date: null };
    return { usd, date: dateFromT(tCross) };
  });
  const janFirstValues = JAN_FIRST_YEARS.map((year) => ({
    year,
    usd: trendUsdAt(a, n, t(`${year}-01-01`)),
  }));
  return { crossings, janFirstValues };
}
