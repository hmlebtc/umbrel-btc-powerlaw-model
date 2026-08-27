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
  BandLine,
  BandLines,
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
 * Slope/intercept of a (optionally weighted) least-squares line through the
 * prepared log columns, via the same O(1)-updatable running sums the rest of the
 * engine uses. With no weights this is plain OLS (w=1 multiplies exactly, so the
 * unweighted path is bit-identical to summing the raw columns); with weights it
 * is the weighted step of the quantile-regression IRLS loop (spec 15.1).
 */
function lineFromColumns(
  xs: readonly number[],
  ys: readonly number[],
  weights?: readonly number[],
): { a: number; n: number } {
  const N = xs.length;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < N; i++) {
    const w = weights ? (weights[i] as number) : 1;
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    sw += w;
    sx += w * xi;
    sy += w * yi;
    sxx += w * xi * xi;
    sxy += w * xi * yi;
  }
  const denom = sw * sxx - sx * sx;
  if (denom === 0) throw new Error('fitOLS: degenerate x column (all t equal)');
  const n = (sw * sxy - sx * sy) / denom;
  const a = (sy - n * sx) / sw;
  return { a, n };
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

  const { a, n } = lineFromColumns(xs, ys);

  let sy = 0;
  for (let i = 0; i < N; i++) sy += ys[i] as number;
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

const BAND_PCTS = {
  p0001: 0.01,
  p005: 0.5,
  p025: 2.5,
  p10: 10,
  p165: 16.5,
  p25: 25,
  p50: 50,
  p75: 75,
  p835: 83.5,
  p90: 90,
  p975: 97.5,
  p995: 99.5,
  p9999: 99.99,
} as const;

function offsetsFromResiduals(residuals: readonly number[]): BandOffsets {
  return {
    p0001: percentile(residuals, BAND_PCTS.p0001),
    p005: percentile(residuals, BAND_PCTS.p005),
    p025: percentile(residuals, BAND_PCTS.p025),
    p10: percentile(residuals, BAND_PCTS.p10),
    p165: percentile(residuals, BAND_PCTS.p165),
    p25: percentile(residuals, BAND_PCTS.p25),
    p50: percentile(residuals, BAND_PCTS.p50),
    p75: percentile(residuals, BAND_PCTS.p75),
    p835: percentile(residuals, BAND_PCTS.p835),
    p90: percentile(residuals, BAND_PCTS.p90),
    p975: percentile(residuals, BAND_PCTS.p975),
    p995: percentile(residuals, BAND_PCTS.p995),
    p9999: percentile(residuals, BAND_PCTS.p9999),
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
 *
 * `quantileRegression` has no residual set of its own — its lines are fitted
 * directly to the prices — so it falls through to the full-sample residuals,
 * which is exactly the fallback bandOffsets carries in that mode (spec 15.1).
 * The quantile READOUT in that mode comes from quantileFromLines(), not here.
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
// Quantile regression bands (spec section 15.1)
// ---------------------------------------------------------------------------

/** A band key of the thirteen-line ladder (shared by offsets and lines). */
export type BandKey = keyof BandOffsets;

/**
 * The ladder's quantile levels, one per band key, in ASCENDING tau order — the
 * order the monotone rearrangement assigns sorted values back in. tau is the
 * fraction (0.975), the matching BAND_PCTS entry the percentage (97.5).
 */
export const BAND_TAUS: Readonly<Record<BandKey, number>> = {
  p0001: 0.0001,
  p005: 0.005,
  p025: 0.025,
  p10: 0.1,
  p165: 0.165,
  p25: 0.25,
  p50: 0.5,
  p75: 0.75,
  p835: 0.835,
  p90: 0.9,
  p975: 0.975,
  p995: 0.995,
  p9999: 0.9999,
};

/** Band keys in ascending-tau order (BAND_TAUS is declared in that order). */
export const BAND_KEYS = Object.keys(BAND_TAUS) as BandKey[];

/** IRLS stopping rule: |da| + |dn| below this ends the loop as converged. */
export const QR_TOLERANCE = 1e-10;
/** Hard iteration cap — the loop is deterministic, never open-ended. */
export const QR_MAX_ITERATIONS = 200;
/** Floor on |residual| in the IRLS weight, so a point on the line can't divide by 0. */
const QR_MIN_ABS_RESIDUAL = 1e-6;

/**
 * The quantile readout is clamped to the ladder's own outer levels — widened to
 * the v0.1.7 envelope pair (spec 16.1). Semantics are unchanged; the reachable
 * range simply follows the outermost taus.
 */
const QUANTILE_MIN = 0.01;
const QUANTILE_MAX = 99.99;

export interface QuantileLineFit extends BandLine {
  /** IRLS iterations actually run (1..QR_MAX_ITERATIONS). */
  iterations: number;
  /** True when |da|+|dn| fell under QR_TOLERANCE before the cap. */
  converged: boolean;
}

/**
 * Linear quantile regression y = a + n*x minimising the pinball loss
 * `sum rho_tau(y - a - n*x)`, `rho_tau(u) = u*(tau - [u<0])` (spec 15.1).
 *
 * Method: IRLS. Start from the OLS solution, then repeatedly reweight each point
 * by `|tau - [r_i<0]| / max(|r_i|, 1e-6)` and re-solve the weighted least-squares
 * line — the weighted L2 problem whose fixed point is the L1-type pinball
 * optimum. Stops when |da| + |dn| < 1e-10 or after 200 iterations. Wholly
 * deterministic: no randomness, no time-dependence, and the accumulation order
 * is fixed, so repeated runs on the same columns are bit-identical.
 */
export function fitQuantileLine(
  xs: readonly number[],
  ys: readonly number[],
  tau: number,
): QuantileLineFit {
  const N = xs.length;
  if (N < 2) throw new Error(`fitQuantileLine needs >=2 points, got ${N}`);

  let { a, n } = lineFromColumns(xs, ys);
  const weights = new Array<number>(N);
  let iterations = 0;
  let converged = false;

  for (let it = 1; it <= QR_MAX_ITERATIONS; it++) {
    iterations = it;
    for (let i = 0; i < N; i++) {
      const resid = (ys[i] as number) - (a + n * (xs[i] as number));
      weights[i] =
        Math.abs(tau - (resid < 0 ? 1 : 0)) / Math.max(Math.abs(resid), QR_MIN_ABS_RESIDUAL);
    }
    const next = lineFromColumns(xs, ys, weights);
    const delta = Math.abs(next.a - a) + Math.abs(next.n - n);
    a = next.a;
    n = next.n;
    if (delta < QR_TOLERANCE) {
      converged = true;
      break;
    }
  }

  return { a, n, iterations, converged };
}

/**
 * The thirteen ladder taus fitted as separate quantile regressions on the SAME
 * prepared log-log columns fitOLS uses (spec 15.1). Each line gets its own slope,
 * which is the whole point of the mode: porkopolis's latest methodology draws
 * separately-sloped percentile lines that converge toward trend rather than
 * parallel offsets from it.
 *
 * The outermost pair (tau 0.0001 / 0.9999, spec 16.1) sits below the sample's own
 * 1/N resolution at ~5,800 daily points, so those two lines are effectively the
 * historical floor and ceiling envelopes (porkopolis's Q0/Q100) rather than
 * meaningful coverage levels. They need no special casing — the ladder arrays
 * drive the loop — but their IRLS runs may legitimately hit the iteration cap
 * without the convergence flag, which is why the tests assert the envelope
 * property rather than a coverage share.
 */
export function fitBandLines(sample: readonly DailyObservation[]): BandLines {
  const { xs, ys } = prepare(sample);
  const out = {} as Record<BandKey, BandLine>;
  for (const key of BAND_KEYS) {
    const q = fitQuantileLine(xs, ys, BAND_TAUS[key]);
    out[key] = { a: q.a, n: q.n };
  }
  return out as BandLines;
}

function isFiniteLine(line: BandLine | undefined): line is BandLine {
  return !!line && Number.isFinite(line.a) && Number.isFinite(line.n);
}

/**
 * The thirteen band prices at day t, MONOTONE-REARRANGED
 * (Chernozhukov-Fernandez-Val-Galichon): evaluate every line, sort the values
 * ascending, and hand them back to the ladder keys in ascending-tau order. Fitted
 * quantile lines have independent slopes and may therefore cross far outside the
 * data range; rearranging makes the drawn ladder non-crossing at EVERY t while
 * leaving the set of values untouched. Every consumer (chart, tooltip, oscillator
 * guides, year-end table, CSV) must read band values through this.
 *
 * A malformed / partial `bandLines` (hand-edited model.json) yields only the keys
 * that could be evaluated, rearranged among themselves.
 */
export function bandPricesAt(bandLines: BandLines, tDays: number): Record<BandKey, number> {
  const keys = BAND_KEYS.filter((k) => isFiniteLine(bandLines[k]));
  const values = keys
    .map((k) => {
      const line = bandLines[k];
      return trendUsdAt(line.a, line.n, tDays);
    })
    .sort((p, q) => p - q);
  const out = {} as Record<BandKey, number>;
  for (let i = 0; i < keys.length; i++) out[keys[i] as BandKey] = values[i] as number;
  return out;
}

/**
 * Current quantile in `quantileRegression` mode: where `priceUsd` sits among the
 * rearranged ladder values at day t, with tau linearly interpolated between the
 * two bracketing lines and scaled to a percentage. The interpolation runs in
 * log10 price space — the space the whole engine (and the residual-based quantile
 * of the other two modes) works in. Clamped to the ladder's own outer levels
 * [0.01, 99.99] since v0.1.7; NaN for a non-positive price or t < 1.
 */
export function quantileFromLines(
  bandLines: BandLines,
  tDays: number,
  priceUsd: number,
): number {
  if (!(priceUsd > 0) || tDays < 1) return NaN;
  const prices = bandPricesAt(bandLines, tDays);
  const keys = BAND_KEYS.filter((k) => Number.isFinite(prices[k]) && prices[k] > 0);
  if (keys.length === 0) return NaN;

  const clamp = (q: number): number => Math.min(QUANTILE_MAX, Math.max(QUANTILE_MIN, q));
  const pctAt = (k: BandKey): number => BAND_TAUS[k] * 100;
  const logAt = (k: BandKey): number => Math.log10(prices[k]);

  const y = Math.log10(priceUsd);
  if (y <= logAt(keys[0] as BandKey)) return clamp(pctAt(keys[0] as BandKey));
  for (let i = 1; i < keys.length; i++) {
    const lo = keys[i - 1] as BandKey;
    const hi = keys[i] as BandKey;
    const loY = logAt(lo);
    const hiY = logAt(hi);
    if (y <= hiY) {
      const span = hiY - loY;
      const w = span > 0 ? (y - loY) / span : 0;
      return clamp(pctAt(lo) + w * (pctAt(hi) - pctAt(lo)));
    }
  }
  return clamp(pctAt(keys[keys.length - 1] as BandKey));
}

// ---------------------------------------------------------------------------
// Top-level fit
// ---------------------------------------------------------------------------

/**
 * Fit the sample and attach band offsets for `mode`. In `quantileRegression`
 * mode the thirteen separately-sloped ladder lines are attached as well, and
 * `bandOffsets` is STILL filled with the full-sample offsets: a documented
 * fallback so a stale client (or any consumer reading an old record shape) keeps
 * drawing parallel bands instead of nothing. sigma / r2 / falsifiability stay
 * OLS-based in every mode.
 */
export function fit(
  sample: readonly DailyObservation[],
  mode: BandMode,
  includesProvisionalSpot = false,
): ModelFit {
  const ols = fitOLS(sample);
  const bandOffsets = computeBandOffsets(ols, sample, mode);
  const out: ModelFit = {
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
  if (mode === 'quantileRegression') out.bandLines = fitBandLines(sample);
  return out;
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
