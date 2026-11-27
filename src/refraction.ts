/**
 * Refraction model engine (spec sections 2 and 4). PURE — no I/O, no clock, no
 * randomness, no globals. Every coefficient (b0, b1, c, the 27 grid offsets) is
 * produced here from data at fit time; NOTHING in this file is a fitted number.
 * Published values (b1 ~ 5.72, c ~ 0.197, the author's tables) live ONLY in
 * src/fixtures/refractionGolden.ts and the tests.
 *
 * MODEL (all logs base 10; h = block height of a daily close, P = close in USD):
 *   anchor (5th-percentile line)  log A(h) = b0 + b1 * log h
 *   decay                          S(h)     = 1 - tanh(c * h / 200000) ^ alpha,  alpha = 5/4
 *   lines above the anchor (q > 5) log(P_q / A) = z_q * S(h)   (converge on A as S -> 0)
 *   lines below the anchor (q < 5) log(P_q / A) = d_q          (parallel to A, d_q < 0)
 * z_q and d_q are coverage-calibrated: a share q of all closes lies below line q.
 *
 * PROCEDURE (spec 2.4, binding) and why each step is EXACT rather than approximate:
 *  1. Clean: drop rows with h <= 0, usd <= 0, non-finite values or a malformed
 *     date; sort by date (one row per date, the last one given wins).
 *  2. Anchor: the tau = 0.05 linear quantile regression of y = log P on x = log h.
 *     For a FIXED slope b the optimal intercept is an order statistic of y - b*x
 *     (k = ceil(n*tau)), so the loss is a convex 1-D function of b alone: a
 *     golden-section search on b brackets the optimum to 1e-14. The true LP
 *     optimum is a vertex — a line through two data points — so we then "snap":
 *     test every slope through one of the 5 points ranked k-2..k+2 and any other
 *     point within 1e-6 of the approximate slope, and keep the lowest loss. The
 *     result is the exact LP solution (verified against HiGHS to 4e-14), not an
 *     IRLS approximation, which is not accurate enough for the 99.9th line.
 *  3. Residuals r_i = y_i - (b0 + b1 * x_i).
 *  4. Decay: c = argmin_c min_z sum rho_0.999(r_i - z * S_i(c)). For a fixed c the
 *     inner problem is a weighted quantile (write r - zS = S (r/S - z)): z* is the
 *     smallest t_i = r_i / S_i (ascending, ties by index) whose running S-sum
 *     reaches 0.999 * sum S — exact, no optimiser. The outer loss in c is nearly
 *     flat (within 0.1% over c ~ 0.196..0.199) yet the published tables reproduce
 *     only for c within ~1e-7 of the exact argmin, so c comes from a fixed nested
 *     grid (step 1e-2 down to 1e-8, lowest c wins ties) that mirrors the Python
 *     reference step for step: the same doubles are evaluated in the same order,
 *     so c is bit-identical, not merely close. EDGE RULE (spec R6): if the
 *     coarse argmin is the first or last coarse point (0.02 or 1.00), or the
 *     refined c is not strictly inside that range, the sample has no interior
 *     optimum and fitRefraction THROWS rather than return an edge (left alone,
 *     the refinement walks below the grid to c ~ 1e-19, i.e. silently no decay).
 *  5. Calibration: Hyndman–Fan type 8 quantiles of {r_i} (q < 5) and of
 *     {r_i / S_i} (q > 5) over ALL closes; the 5th line is the anchor (offset 0).
 *  6. Sequential (anchor -> c -> calibration), no joint iteration.
 *  7. Plain left-to-right sums everywhere, stable index tie-breaks: two runs on
 *     the same input are bit-identical.
 *
 * SPEED without changing a bit: the decay search evaluates the inner minimiser
 * ~345 times. The straightforward version sorts all n t-values each time; but z*
 * sits in the top 0.1% of the S-weight, so we select only the top few t-values
 * (quickselect for the cut-off value, then a sort of that small block in the same
 * (t, index) order as the full sort) and walk
 * down from the top. That walk decides the same cut as the full prefix sum except
 * when the cut lands within floating-point noise of the threshold; we bound that
 * noise rigorously and fall back to the full sort in that case (see
 * innerZFast). Grid points that round to an already-evaluated c are memoised. What
 * remains is the n tanh/pow evaluations of S per c, which the loss needs anyway. The anchor's order statistics use a deterministic quickselect
 * instead of a sort: the k-th smallest VALUE does not depend on how it is found.
 */

// ---------------------------------------------------------------------------
// Model-definition constants (spec 2.1 — "set", not fitted)
// ---------------------------------------------------------------------------

/** Exponent on the tanh in S(h). Set by the model author, never fitted. */
export const REFRACTION_ALPHA = 1.25;
/** Quantile of the anchor regression: the anchor IS the 5th-percentile line. */
export const REFRACTION_ANCHOR_TAU = 0.05;
/** Quantile the decay rate c is fitted to ("fit to the 99.9th percentile"). */
export const REFRACTION_DECAY_TAU = 0.999;
/** Blocks per day for forward projection of height (the protocol's target rate). */
export const REFRACTION_BLOCKS_PER_DAY = 144;
/** Fewest usable closes we accept (two years): below this the 99.9th line is noise. */
export const REFRACTION_MIN_POINTS = 730;
/** Percentiles the calibration is stored on, ascending. 5 is the anchor (offset exactly 0). */
export const REFRACTION_GRID_PCTS: readonly number[] = Object.freeze([
  0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 97.5, 99,
  99.5, 99.9,
]);
/** Lines the dashboard draws, ascending. */
export const REFRACTION_LADDER: readonly number[] = Object.freeze([0.1, 1, 5, 15, 25, 50, 75, 95, 99.9]);

/** The anchor's percentile (= 100 * 0.05, which is exactly 5 in IEEE doubles). */
const ANCHOR_PCT = REFRACTION_ANCHOR_TAU * 100;
/** Height scale inside the tanh: the source writes c*u/2 with u = h/100000. */
const DECAY_SCALE = 200000;
/** Below this S a point above the anchor is "above every line" (r/S would blow up). */
const S_FLOOR = 1e-12;
/** Percentile output range of the grid inverse (the grid's own ends). */
const PCT_MIN = 0.1;
const PCT_MAX = 99.9;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Types (engine-local by design; src/types.ts is untouched in Phase 3)
// ---------------------------------------------------------------------------

export interface RefractionObservation {
  /** UTC calendar date of the close, `YYYY-MM-DD`. */
  date: string;
  /** Daily close in USD. */
  usd: number;
  /** Chain height of the last block of that UTC day. */
  h: number;
}

export interface RefractionFit {
  b0: number;
  b1: number; // anchor: log10 A = b0 + b1*log10 h
  c: number;
  alpha: number; // decay: S(h) = 1 - tanh(c*h/200000)^alpha
  gridPcts: number[]; // = REFRACTION_GRID_PCTS
  gridOffsets: number[]; // d_q (<0) below 5, 0 at 5, z_q (>0) above 5
  points: number;
  dataStart: string;
  dataEnd: string;
  lastHeight: number; // h of dataEnd: the projection origin
  anchorLoss: number;
  decayLoss: number;
  shareBelowAnchor: number; // diagnostic, ~0.05
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

/**
 * S(h) = 1 - tanh(c*h/200000)^alpha. In (0, 1] for h >= 0; it reaches exactly 0
 * once tanh rounds to 1 (h beyond ~1.9e7 blocks at c ~ 0.2) — never negative and
 * never NaN for finite h >= 0, which is what keeps the lines finite far out.
 */
export function decayAt(c: number, alpha: number, h: number): number {
  return 1 - Math.pow(Math.tanh((c * h) / DECAY_SCALE), alpha);
}

/** log10 of the anchor (5th-percentile line) at height h: b0 + b1*log10(h). */
export function anchorLogAt(fit: Pick<RefractionFit, 'b0' | 'b1'>, h: number): number {
  return fit.b0 + fit.b1 * Math.log10(h);
}

/**
 * Offset of line `pct`, linear in pct between grid points and clamped to the
 * grid's ends. Below the anchor it is d_q (log distance to A); above, z_q (to be
 * multiplied by S(h)). Interpolating in pct keeps the ladder monotone whenever
 * the stored offsets are.
 */
export function offsetAt(fit: RefractionFit, pct: number): number {
  const ps = fit.gridPcts;
  const os = fit.gridOffsets;
  const m = Math.min(ps.length, os.length);
  if (m === 0 || !Number.isFinite(pct)) return NaN;
  if (pct <= (ps[0] as number)) return os[0] as number;
  if (pct >= (ps[m - 1] as number)) return os[m - 1] as number;
  for (let i = 1; i < m; i++) {
    const p1 = ps[i] as number;
    if (pct <= p1) {
      const p0 = ps[i - 1] as number;
      const o0 = os[i - 1] as number;
      const o1 = os[i] as number;
      // Exact grid hit returns the stored offset untouched (no 0*x rounding games).
      if (pct === p1) return o1;
      return o0 + ((pct - p0) / (p1 - p0)) * (o1 - o0);
    }
  }
  return os[m - 1] as number;
}

/**
 * Price of the `pct` line at height h. Lines above the anchor scale their offset
 * by S(h) (refraction toward the anchor); lines at or below it are parallel.
 * NaN for a non-positive or non-finite h or pct. Finite for every h whose anchor
 * price is representable: S -> 0 only pulls the upper lines onto the anchor.
 */
export function linePriceAt(fit: RefractionFit, pct: number, h: number): number {
  if (!(h > 0) || !Number.isFinite(h) || !Number.isFinite(pct)) return NaN;
  const la = anchorLogAt(fit, h);
  const off = offsetAt(fit, pct);
  const lg = pct > ANCHOR_PCT ? la + off * decayAt(fit.c, fit.alpha, h) : la + off;
  return Math.pow(10, lg);
}

/**
 * Inverse of a monotone piecewise-linear map pct -> offset over grid entries
 * [from, to], clamped to the ends. On a flat run of equal offsets the LOWEST pct
 * wins (same rule as the exact type-8 inverse).
 */
function invertGrid(ps: readonly number[], os: readonly number[], from: number, to: number, v: number): number {
  if (v <= (os[from] as number)) return ps[from] as number;
  if (v >= (os[to] as number)) return ps[to] as number;
  for (let i = from + 1; i <= to; i++) {
    const o1 = os[i] as number;
    if (o1 >= v) {
      if (o1 === v) {
        // first index with this offset = lowest pct of a flat run
        let j = i;
        while (j > from && (os[j - 1] as number) === v) j--;
        return ps[j] as number;
      }
      const o0 = os[i - 1] as number;
      const p0 = ps[i - 1] as number;
      const p1 = ps[i] as number;
      return p0 + ((v - o0) / (o1 - o0)) * (p1 - p0);
    }
  }
  return ps[to] as number;
}

/**
 * Percentile of a price at height h, by inverting linePriceAt on the stored grid
 * (an approximation of the exact type-8 inverse; see percentileExact). Clamped to
 * [0.1, 99.9]. NaN on bad input (h or usd non-positive / non-finite, empty grid).
 */
export function percentileOf(fit: RefractionFit, h: number, usd: number): number {
  if (!(h > 0) || !(usd > 0) || !Number.isFinite(h) || !Number.isFinite(usd)) return NaN;
  const ps = fit.gridPcts;
  const os = fit.gridOffsets;
  const m = Math.min(ps.length, os.length);
  if (m === 0) return NaN;
  const r0 = Math.log10(usd) - anchorLogAt(fit, h);
  if (!Number.isFinite(r0)) return NaN;
  // Split the grid at the anchor: entries <= 5 carry d_q, entries >= 5 carry z_q.
  let lastBelow = -1;
  let firstAbove = m;
  for (let i = 0; i < m; i++) {
    const p = ps[i] as number;
    if (p <= ANCHOR_PCT) lastBelow = i;
    if (p >= ANCHOR_PCT && firstAbove === m) firstAbove = i;
  }
  let pct: number;
  if (r0 < 0 || firstAbove === m) {
    pct = lastBelow < 0 ? (ps[0] as number) : invertGrid(ps, os, 0, lastBelow, r0);
  } else {
    const s = decayAt(fit.c, fit.alpha, h);
    if (!(s >= S_FLOOR)) pct = ps[m - 1] as number; // above the anchor where every upper line has collapsed onto it
    else pct = invertGrid(ps, os, firstAbove, m - 1, r0 / s);
  }
  return Math.min(PCT_MAX, Math.max(PCT_MIN, pct));
}

/**
 * Height projected to `date`: lastHeight + 144 * whole UTC calendar days from
 * lastDate (negative before it). Pure date arithmetic on `YYYY-MM-DD` strings —
 * Date.UTC has no DST and counts leap days. NaN on a malformed date.
 */
export function projectHeight(lastHeight: number, lastDate: string, date: string): number {
  const a = utcDayMs(lastDate);
  const b = utcDayMs(date);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return lastHeight + REFRACTION_BLOCKS_PER_DAY * Math.round((b - a) / DAY_MS);
}

/** ms of 00:00 UTC on a strict `YYYY-MM-DD` date (round-trip checked), else NaN. */
function utcDayMs(date: string): number {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const ms = Date.UTC(y, mo - 1, d);
  // Reject 2026-02-30 & co. (Date.UTC would silently roll them over).
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return ms;
}

// ---------------------------------------------------------------------------
// Sample preparation
// ---------------------------------------------------------------------------

interface Prepared {
  n: number;
  dates: string[];
  h: Float64Array;
  x: Float64Array; // log10 h
  y: Float64Array; // log10 usd
}

/**
 * Drop unusable rows, sort by date (stable), keep the LAST row given for a
 * duplicated date (a later upsert supersedes an earlier one rather than
 * double-weighting that day), and precompute the log columns.
 */
function prepare(sample: readonly RefractionObservation[]): Prepared {
  const ok: RefractionObservation[] = [];
  for (const o of sample) {
    if (o === null || typeof o !== 'object') continue;
    if (!(o.h > 0) || !Number.isFinite(o.h)) continue;
    if (!(o.usd > 0) || !Number.isFinite(o.usd)) continue;
    if (!Number.isFinite(utcDayMs(o.date))) continue;
    ok.push(o);
  }
  // Array.prototype.sort is stable (ES2019), so equal dates keep input order.
  ok.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows: RefractionObservation[] = [];
  for (let i = 0; i < ok.length; i++) {
    const o = ok[i] as RefractionObservation;
    const next = ok[i + 1];
    if (next !== undefined && next.date === o.date) continue; // a later row for this date follows
    rows.push(o);
  }
  const n = rows.length;
  const dates: string[] = new Array(n);
  const h = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = rows[i] as RefractionObservation;
    dates[i] = o.date;
    h[i] = o.h;
    x[i] = Math.log10(o.h);
    y[i] = Math.log10(o.usd);
  }
  return { n, dates, h, x, y };
}

// ---------------------------------------------------------------------------
// Small exact primitives
// ---------------------------------------------------------------------------

/** Pinball (check) loss of one residual: tau*e for e >= 0, (tau-1)*e below. */
function pin(e: number, tau: number): number {
  return e >= 0 ? tau * e : (tau - 1) * e;
}

/**
 * 0-based index of the order statistic that minimises sum rho_tau(e_i - a):
 * k = ceil(n*tau) (1-based). The -1e-9 guards FP noise when n*tau is an integer
 * (e.g. n = 6000: 6000*0.05 = 300.00000000000006 must give 300, not 301).
 */
function kthIndex(n: number, tau: number): number {
  return Math.max(1, Math.min(n, Math.ceil(n * tau - 1e-9))) - 1;
}

/**
 * k-th smallest value of `a` (0-based), partially reordering `a` in place.
 * Deterministic Hoare quickselect with a median-of-three pivot (no randomness);
 * after a bounded number of rounds it sorts the remaining window, so the worst
 * case stays O(n log n). The VALUE returned equals sorted(a)[k] exactly,
 * whichever way it is found — that is why this can replace the reference's sort.
 */
function selectKth(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  let rounds = 0;
  while (hi > lo) {
    if (++rounds > 64) {
      const w = a.subarray(lo, hi + 1);
      w.sort();
      return a[k] as number;
    }
    const mid = lo + ((hi - lo) >> 1);
    // median of three -> pivot value
    const va = a[lo] as number;
    const vb = a[mid] as number;
    const vc = a[hi] as number;
    const pivot = va < vb ? (vb < vc ? vb : va < vc ? vc : va) : va < vc ? va : vb < vc ? vc : vb;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((a[i] as number) < pivot) i++;
      while ((a[j] as number) > pivot) j--;
      if (i <= j) {
        const t = a[i] as number;
        a[i] = a[j] as number;
        a[j] = t;
        i++;
        j--;
      }
    }
    // [lo, j] <= pivot, [i, hi] >= pivot, (j, i) == pivot
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k] as number;
  }
  return a[k] as number;
}

/** Hyndman–Fan type 8 quantile of an ascending array (numpy 'median_unbiased'). */
function quantileType8(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  const pos = (n + 1 / 3) * p + 1 / 3; // 1-based position
  if (pos <= 1) return sorted[0] as number;
  if (pos >= n) return sorted[n - 1] as number;
  const j = Math.floor(pos);
  const g = pos - j;
  const lo = sorted[j - 1] as number;
  return lo + g * ((sorted[j] as number) - lo);
}

/**
 * Inverse of quantileType8 (a fraction in (0,1)): piecewise linear between order
 * statistics, clamped to [p(1), p(n)] = [(2/3)/(n+1/3), (n-1/3)/(n+1/3)]; on a
 * run of ties the lowest p.
 */
function quantileType8Inverse(sorted: Float64Array, v: number): number {
  const n = sorted.length;
  if (v <= (sorted[0] as number)) return (1 - 1 / 3) / (n + 1 / 3);
  if (v >= (sorted[n - 1] as number)) return (n - 1 / 3) / (n + 1 / 3);
  // j = number of elements <= v (binary search, 'right' side): sorted[j-1] <= v < sorted[j]
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= v) lo = mid + 1;
    else hi = mid;
  }
  const j = lo;
  const a = sorted[j - 1] as number;
  const b = sorted[j] as number;
  const g = b > a ? (v - a) / (b - a) : 0;
  return (j + g - 1 / 3) / (n + 1 / 3);
}

// ---------------------------------------------------------------------------
// Step 2 — exact anchor quantile regression
// ---------------------------------------------------------------------------

interface AnchorResult {
  b0: number;
  b1: number;
}

/**
 * Profile loss at slope b: intercept a = k-th order statistic of e = y - b*x (the
 * exact optimum for that slope), loss = sum rho_tau(e - a), left to right.
 */
function profileLoss(x: Float64Array, y: Float64Array, b: number, tau: number, k: number, e: Float64Array, scratch: Float64Array): [number, number] {
  const n = x.length;
  for (let i = 0; i < n; i++) e[i] = (y[i] as number) - b * (x[i] as number);
  scratch.set(e);
  const a = selectKth(scratch, k);
  let L = 0;
  for (let i = 0; i < n; i++) L += pin((e[i] as number) - a, tau);
  return [L, a];
}

function fitAnchor(x: Float64Array, y: Float64Array, tau: number): AnchorResult {
  const n = x.length;
  const k = kthIndex(n, tau);
  const e = new Float64Array(n);
  const scratch = new Float64Array(n);

  // Bracket: OLS slope +- 5 (the QR slope of a log-log trend is never 5 away from OLS).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] as number;
    sy += y[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    sxy += dx * ((y[i] as number) - my);
    sxx += dx * dx;
  }
  if (!(sxx > 0)) throw new Error('fitRefraction: degenerate heights (all log10 h equal)');
  const bOls = sxy / sxx;

  // Golden section on the convex profile loss, to bracket width 1e-14 (<= 200 steps).
  const gr = (Math.sqrt(5) - 1) / 2;
  let lo = bOls - 5;
  let hi = bOls + 5;
  let c = hi - gr * (hi - lo);
  let d = lo + gr * (hi - lo);
  let fc = profileLoss(x, y, c, tau, k, e, scratch)[0];
  let fd = profileLoss(x, y, d, tau, k, e, scratch)[0];
  for (let it = 0; it < 200 && !(hi - lo < 1e-14); it++) {
    if (fc <= fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - gr * (hi - lo);
      fc = profileLoss(x, y, c, tau, k, e, scratch)[0];
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + gr * (hi - lo);
      fd = profileLoss(x, y, d, tau, k, e, scratch)[0];
    }
  }
  const bApprox = 0.5 * (lo + hi);

  // Vertex snap. The LP optimum passes through two data points, one of which is
  // (near) the k-th order statistic at the approximate slope. Rank by e at bApprox
  // with ties by index (a one-off full sort: it fixes WHICH 5 points we try).
  for (let i = 0; i < n; i++) e[i] = (y[i] as number) - bApprox * (x[i] as number);
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((i, j) => {
    const ei = e[i] as number;
    const ej = e[j] as number;
    return ei < ej ? -1 : ei > ej ? 1 : i - j;
  });
  let bestL = Infinity;
  let bestB = NaN;
  let bestA = NaN;
  const e2 = new Float64Array(n);
  for (let q = Math.max(0, k - 2); q < Math.min(n, k + 3); q++) {
    const i = order[q] as number;
    const xi = x[i] as number;
    const yi = y[i] as number;
    for (let j = 0; j < n; j++) {
      const dx = (x[j] as number) - xi;
      if (!(Math.abs(dx) > 1e-12)) continue;
      const sl = ((y[j] as number) - yi) / dx;
      if (!(Math.abs(sl - bApprox) < 1e-6)) continue;
      const [L, a] = profileLoss(x, y, sl, tau, k, e2, scratch);
      if (L < bestL) {
        bestL = L;
        bestB = sl;
        bestA = a;
      }
    }
  }
  const [L0, a0] = profileLoss(x, y, bApprox, tau, k, e2, scratch);
  // No vertex within reach (or worse than the bracket midpoint): keep the bracket.
  if (Number.isNaN(bestB) || bestL > L0) return { b0: a0, b1: bApprox };
  return { b0: bestA, b1: bestB };
}

// ---------------------------------------------------------------------------
// Step 4 — decay rate c
// ---------------------------------------------------------------------------

/** Workspace for decayObjective, allocated once per fit. */
interface DecayWork {
  s: Float64Array;
  t: Float64Array;
  top: Int32Array;
  scratch: Float64Array;
}

function decayWork(n: number): DecayWork {
  return { s: new Float64Array(n), t: new Float64Array(n), top: new Int32Array(n), scratch: new Float64Array(n) };
}

/** (t, index) ascending order — the reference's stable argsort of t. */
function tLess(t: Float64Array, i: number, j: number): boolean {
  const ti = t[i] as number;
  const tj = t[j] as number;
  return ti < tj || (ti === tj && i < j);
}

/**
 * The straightforward inner minimiser (the reference's procedure, verbatim): sort
 * ALL indices by (t, index), z* = first t whose running S-sum reaches tau * sum S
 * (sum taken in that same sorted order, as numpy's cumsum does).
 */
function innerZFull(w: DecayWork, n: number, tau: number): number {
  const { s, t } = w;
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((i, j) => (tLess(t, i, j) ? -1 : tLess(t, j, i) ? 1 : 0));
  let W = 0;
  for (let q = 0; q < n; q++) W += s[idx[q] as number] as number;
  const target = tau * W;
  let cw = 0;
  for (let q = 0; q < n; q++) {
    const i = idx[q] as number;
    cw += s[i] as number;
    if (cw >= target) return t[i] as number;
  }
  return t[idx[n - 1] as number] as number;
}

/**
 * Fast inner minimiser, provably identical to innerZFull or it defers to it.
 *
 * Read the sorted order from the TOP: with U_p = weight of the p largest t's, the
 * running sum below position n-1-p is W - U_p, so the reference picks the largest
 * p with U_p <= W - tau*W. Only the top ~0.1% of the weight matters, so we take
 * the block of the m largest (t, index) keys (O(n) select + a tiny sort) and walk
 * U_p down from the top; m grows 4x if the block runs out before the cut.
 *
 * The reference and this walk sum in different orders, so their rounding differs.
 * For n positive terms any summation order is within (n-1)*u*W of the exact sum
 * (u = 2^-53), so both decide the cut exactly as exact arithmetic would whenever
 * the cut's margin |U_p - (W - tau*W)| exceeds ~4*n*u*W. We demand 8*n*EPSILON*W
 * (= 16*n*u*W, 4x that bound) on both sides of the cut; otherwise -> innerZFull.
 * Returns the identical double (it IS a t value of the same index).
 */
function innerZFast(w: DecayWork, n: number, tau: number, W: number, topHint: number, guardScale: number): { z: number; fast: boolean } {
  const { s, t, top } = w;
  const thr = W - tau * W;
  const guard = guardScale * n * Number.EPSILON * W;
  let m = Math.max(1, Math.min(n, topHint));
  for (;;) {
    // The m-th largest t VALUE (O(n) quickselect on a copy), then every index at
    // or above it — a complete top block of the sorted order (ties included, so
    // it may hold more than m) — sorted descending by (t, index): a larger index
    // ranks higher among equal t in the stable ascending sort.
    w.scratch.set(t);
    const vm = selectKth(w.scratch, n - m);
    let cnt = 0;
    for (let i = 0; i < n; i++) if ((t[i] as number) >= vm) top[cnt++] = i;
    const block = top.subarray(0, cnt);
    block.sort((i, j) => (tLess(t, j, i) ? -1 : tLess(t, i, j) ? 1 : 0));
    // Walk down: U_p = weight of top p (U_0 = 0 <= thr always).
    let U = 0;
    for (let p = 0; p < cnt; p++) {
      const Unext = U + (s[top[p] as number] as number);
      if (Unext > thr) {
        // cut: z = top[p]; margins on both sides of the threshold
        if (thr - U > guard && Unext - thr > guard) return { z: t[top[p] as number] as number, fast: true };
        return { z: innerZFull(w, n, tau), fast: false };
      }
      U = Unext;
    }
    if (m >= n) return { z: innerZFull(w, n, tau), fast: false }; // cannot happen for tau < 1; stay exact anyway
    m = Math.min(n, m * 4);
  }
}

/**
 * min_z sum rho_tau(r_i - z S_i(c)) for one c: fills S and t = r/S, finds z*, and
 * returns the loss (summed in index order, independent of any sort).
 */
function decayObjective(
  r: Float64Array,
  h: Float64Array,
  c: number,
  alpha: number,
  tau: number,
  w: DecayWork,
  mode: DecayMode,
): { loss: number; z: number; fast: boolean } {
  const n = r.length;
  const { s, t } = w;
  let W = 0;
  for (let i = 0; i < n; i++) {
    const si = 1 - Math.pow(Math.tanh((c * (h[i] as number)) / DECAY_SCALE), alpha);
    s[i] = si;
    t[i] = (r[i] as number) / si;
    W += si;
  }
  let z: number;
  let fast = false;
  if (mode.oracle) {
    z = innerZFull(w, n, tau);
  } else {
    const hint = mode.topHint ?? 2 * Math.ceil(n * (1 - tau)) + 16;
    const res = innerZFast(w, n, tau, W, hint, mode.guardScale ?? 8);
    z = res.z;
    fast = res.fast;
  }
  let L = 0;
  for (let i = 0; i < n; i++) L += pin((r[i] as number) - z * (s[i] as number), tau);
  return { loss: L, z, fast };
}

/** Knobs used only by the tests to pin the fast path against the oracle. */
interface DecayMode {
  oracle?: boolean;
  topHint?: number;
  guardScale?: number;
}

/**
 * Deterministic nested grid for c, mirroring the reference's c_search exactly:
 * level 0 c = 0.02 + i*0.01 (i = 0..98); then 6 levels, step /= 10 and
 * c = incumbent + j*step (j = -20..20, incumbent fixed for the level, c <= 0
 * skipped). Strict '<' while c increases => the lowest c wins ties. The doubles
 * are formed by the same expressions in the same order as the Python, so c is
 * bit-identical to it given bit-identical losses.
 */
function searchDecay(r: Float64Array, h: Float64Array, alpha: number, tau: number, mode: DecayMode): { c: number; loss: number; evals: number; computed: number; fastEvals: number } {
  const w = decayWork(r.length);
  const lo = 0.02;
  const hi = 1.0;
  const step0 = 1e-2;
  const levels = 6;
  const factor = 10;
  const half = 2;
  let evals = 0;
  let fastEvals = 0;
  let computed = 0;
  // Memo by the exact double c: the loss is a pure function of c, so a grid point
  // that rounds to an already-evaluated c (each level's j = 0 is its incumbent;
  // some j = +-10, +-20 coincide with the previous level's points) is free and
  // provably the same number. `evals` counts the reference's schedule regardless.
  const memo = new Map<number, number>();
  const f = (c: number): number => {
    evals++;
    const known = memo.get(c);
    if (known !== undefined) return known;
    const res = decayObjective(r, h, c, alpha, tau, w, mode);
    computed++;
    if (res.fast) fastEvals++;
    memo.set(c, res.loss);
    return res.loss;
  };
  const n0 = Math.round((hi - lo) / step0);
  let bestC = NaN;
  let bestF = Infinity;
  let bestI = -1;
  for (let i = 0; i <= n0; i++) {
    const c = lo + i * step0;
    const v = f(c);
    if (v < bestF) {
      bestC = c;
      bestF = v;
      bestI = i;
    }
  }
  // Edge guard (spec R6). A coarse argmin on the first or last grid point means
  // the optimum may lie outside the grid; refining around it would walk off the
  // grid (to c ~ 1e-19 below it: "no decay") and pass for a normal fit. Refuse.
  const cFirst = lo;
  const cLast = lo + n0 * step0;
  if (bestI === 0 || bestI === n0) {
    throw new Error(
      `fitRefraction: decay rate c has no interior optimum on [${cFirst}, ${cLast}] (coarse argmin at the ${bestI === 0 ? 'lower' : 'upper'} edge, c = ${bestC}); this sample does not support a Refraction fit`,
    );
  }
  let step = step0;
  for (let l = 0; l < levels; l++) {
    step /= factor;
    const center = bestC;
    for (let j = -factor * half; j <= factor * half; j++) {
      const c = center + j * step;
      if (c <= 0) continue;
      const v = f(c);
      if (v < bestF) {
        bestC = c;
        bestF = v;
      }
    }
  }
  // Belt and braces for R6: the refined c must sit strictly inside the coarse range.
  if (!(bestC > cFirst && bestC < cLast)) {
    throw new Error(`fitRefraction: decay rate c = ${bestC} is not strictly inside the coarse range (${cFirst}, ${cLast})`);
  }
  return { c: bestC, loss: bestF, evals, computed, fastEvals };
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

function fitPrepared(p: Prepared, mode: DecayMode): { fit: RefractionFit; evals: number; computed: number; fastEvals: number } {
  const { n, x, y, h } = p;
  const alpha = REFRACTION_ALPHA;

  // Step 2: exact anchor.
  const { b0, b1 } = fitAnchor(x, y, REFRACTION_ANCHOR_TAU);

  // Step 3: residuals (same expression as the reference: y - (b0 + b1*x)).
  const r = new Float64Array(n);
  let anchorLoss = 0;
  let below = 0;
  for (let i = 0; i < n; i++) {
    const ri = (y[i] as number) - (b0 + b1 * (x[i] as number));
    r[i] = ri;
    anchorLoss += pin(ri, REFRACTION_ANCHOR_TAU);
    if (ri < 0) below++;
  }

  // Step 4: decay rate.
  const dec = searchDecay(r, h, alpha, REFRACTION_DECAY_TAU, mode);
  const c = dec.c;

  // Step 5: coverage calibration (type 8) over all closes.
  const rs = Float64Array.from(r).sort();
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = (r[i] as number) / decayAt(c, alpha, h[i] as number);
  const ts = t.sort();
  const gridPcts = REFRACTION_GRID_PCTS.slice();
  const gridOffsets = gridPcts.map((q) =>
    q < ANCHOR_PCT ? quantileType8(rs, q / 100) : q === ANCHOR_PCT ? 0 : quantileType8(ts, q / 100),
  );

  return {
    fit: {
      b0,
      b1,
      c,
      alpha,
      gridPcts,
      gridOffsets,
      points: n,
      dataStart: p.dates[0] as string,
      dataEnd: p.dates[n - 1] as string,
      lastHeight: h[n - 1] as number,
      anchorLoss,
      decayLoss: dec.loss,
      shareBelowAnchor: below / n,
    },
    evals: dec.evals,
    computed: dec.computed,
    fastEvals: dec.fastEvals,
  };
}

/**
 * Fit the Refraction model (spec 2.4) to daily closes with block heights.
 * Throws when fewer than REFRACTION_MIN_POINTS usable closes remain after
 * cleaning (h <= 0, usd <= 0, non-finite or malformed rows are dropped), and
 * when the decay rate has no interior optimum on the c grid (spec R6).
 */
export function fitRefraction(sample: readonly RefractionObservation[]): RefractionFit {
  const p = prepare(sample);
  if (p.n < REFRACTION_MIN_POINTS) {
    throw new Error(`fitRefraction needs >= ${REFRACTION_MIN_POINTS} usable closes (h > 0, usd > 0), got ${p.n}`);
  }
  return fitPrepared(p, {}).fit;
}

/**
 * Exact model percentile of (h, usd) against the closes the fit was made on: the
 * inverse of the type-8 calibration quantile of r (below the anchor) or of r/S
 * (at or above it), in percent. Clamped to the type-8 range
 * [100*(2/3)/(n+1/3), 100*(n-1/3)/(n+1/3)] (NOT to [0.1, 99.9]: this is the
 * server-side exact value). `sample` is cleaned exactly as fitRefraction cleans
 * it. NaN on bad input or an empty sample.
 */
export function percentileExact(fit: RefractionFit, sample: readonly RefractionObservation[], h: number, usd: number): number {
  if (!(h > 0) || !(usd > 0) || !Number.isFinite(h) || !Number.isFinite(usd)) return NaN;
  const p = prepare(sample);
  const n = p.n;
  if (n === 0) return NaN;
  const r0 = Math.log10(usd) - anchorLogAt(fit, h);
  if (!Number.isFinite(r0)) return NaN;
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = (p.y[i] as number) - (fit.b0 + fit.b1 * (p.x[i] as number));
  if (r0 < 0) return 100 * quantileType8Inverse(r.sort(), r0);
  const s0 = decayAt(fit.c, fit.alpha, h);
  if (!(s0 >= S_FLOOR)) return (100 * (n - 1 / 3)) / (n + 1 / 3); // above every (collapsed) upper line
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = (r[i] as number) / decayAt(fit.c, fit.alpha, p.h[i] as number);
  return 100 * quantileType8Inverse(t.sort(), r0 / s0);
}

// ---------------------------------------------------------------------------
// Test hooks (not part of the spec'd interface; no production caller)
// ---------------------------------------------------------------------------

/**
 * @internal Test-only access to the fit with the decay search forced onto the
 * straightforward full-sort path (`oracle`) or with the fast path's knobs moved
 * (`topHint` small exercises buffer growth; `guardScale` huge forces fallback),
 * plus per-c evaluation. Lets the tests prove fast === straightforward bit for bit.
 */
export const refractionTestHooks = {
  fitWith(sample: readonly RefractionObservation[], mode: DecayMode): { fit: RefractionFit; evals: number; computed: number; fastEvals: number } {
    const p = prepare(sample);
    if (p.n < REFRACTION_MIN_POINTS) throw new Error('fitWith: too few points');
    return fitPrepared(p, mode);
  },
  decayAtC(r: readonly number[], h: readonly number[], c: number, mode: DecayMode): { loss: number; z: number; fast: boolean } {
    const rr = Float64Array.from(r);
    return decayObjective(rr, Float64Array.from(h), c, REFRACTION_ALPHA, REFRACTION_DECAY_TAU, decayWork(rr.length), mode);
  },
};
