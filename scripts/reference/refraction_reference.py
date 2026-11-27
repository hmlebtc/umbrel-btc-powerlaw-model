# REFERENCE IMPLEMENTATION (not used at runtime).
#
# The Python implementation the TypeScript engine in src/refraction.ts was validated
# against: the exact tau=0.05 anchor (LP via scipy), the exact decay search and the
# Hyndman-Fan type-8 calibration. src/fixtures/refractionGolden.ts holds the numbers it
# produced. Needs numpy and scipy (`python3 -I`); the app itself has no Python or npm
# runtime dependencies and this directory is excluded from the Docker image.
#
"""Reference implementation of Plan C's Bitcoin Refraction Model (Phase 1).

Pure numpy/scipy. Run with `python3 -I`. No network, no I/O except the explicit
loaders at the bottom (which only read CSV / TS data files as data, never execute them).

Model (spec 2.1):
  x = log10(h), y = log10(P)
  anchor:  log10 A(h) = b0 + b1*x                      (tau = 0.05 quantile regression)
  decay :  S(h; c) = 1 - tanh(c*h/200000)**alpha       (alpha = 5/4)
  q > 5 :  log10(P_q/A) = z_q * S(h)
  q < 5 :  log10(P_q/A) = d_q
  z_q = q-quantile of r_i/S_i,  d_q = q-quantile of r_i,   r_i = log10(P_i/A(h_i))
"""
import math
import re
import datetime as _dt
import numpy as np
from scipy.optimize import linprog

ALPHA = 1.25
TAU_ANCHOR = 0.05
TAU_DECAY = 0.999
BLOCKS_PER_DAY = 144
LADDER = [0.1, 1, 5, 15, 25, 50, 75, 95, 99.9]


# ----------------------------------------------------------------------------- basics
def pinball(e, tau):
    """Sum of the pinball (check) loss rho_tau(e) = e*(tau - 1[e<0])."""
    e = np.asarray(e, dtype=float)
    return float(np.sum(np.where(e >= 0, tau * e, (tau - 1.0) * e)))


def S(h, c, alpha=ALPHA):
    h = np.asarray(h, dtype=float)
    return 1.0 - np.tanh(c * h / 200000.0) ** alpha


def kth_index(n, tau):
    """0-based index of the order statistic that minimises sum rho_tau(e_i - a):
    k = ceil(n*tau) (1-based). Computed robustly against FP noise in n*tau."""
    k = math.ceil(n * tau - 1e-9)
    return max(1, min(n, k)) - 1


# ----------------------------------------------------------------------------- anchor QR
def qr_lp(x, y, tau=TAU_ANCHOR):
    """Exact linear quantile regression y ~ b0 + b1 x via the LP (HiGHS)."""
    x = np.asarray(x, float); y = np.asarray(y, float); n = len(x)
    # variables: b0, b1, u(n), v(n);  y - b0 - b1 x = u - v
    cost = np.concatenate([[0.0, 0.0], np.full(n, tau), np.full(n, 1.0 - tau)])
    from scipy.sparse import csr_matrix, hstack, identity
    Aeq = hstack([csr_matrix(np.column_stack([np.ones(n), x])), identity(n), -identity(n)]).tocsr()
    bounds = [(None, None), (None, None)] + [(0, None)] * (2 * n)
    res = linprog(cost, A_eq=Aeq, b_eq=y, bounds=bounds, method="highs",
                  options={"primal_feasibility_tolerance": 1e-10, "dual_feasibility_tolerance": 1e-10})
    if not res.success:
        raise RuntimeError(res.message)
    b0, b1 = res.x[0], res.x[1]
    return float(b0), float(b1), pinball(y - b0 - b1 * x, tau)


def _profile_loss(x, y, b, tau):
    e = y - b * x
    k = kth_index(len(e), tau)
    a = np.partition(e, k)[k]
    return pinball(e - a, tau), a


def qr_1d(x, y, tau=TAU_ANCHOR, lo=None, hi=None, iters=200):
    """Exact QR by a 1-D convex search over the slope (intercept = order statistic
    k=ceil(n*tau) of y - b*x), golden section to ~1e-14, then an exact vertex snap:
    the optimum line passes through 2 data points; one is the k-th order statistic at
    the approximate optimum, the other is found by testing all slopes through it that lie
    within a small window of the approximate slope."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    if lo is None:
        # OLS slope +- generous bracket
        bo = np.polyfit(x, y, 1)[0]
        lo, hi = bo - 5.0, bo + 5.0
    gr = (math.sqrt(5) - 1) / 2
    a_, b_ = lo, hi
    c_ = b_ - gr * (b_ - a_); d_ = a_ + gr * (b_ - a_)
    fc = _profile_loss(x, y, c_, tau)[0]; fd = _profile_loss(x, y, d_, tau)[0]
    for _ in range(iters):
        if b_ - a_ < 1e-14:
            break
        if fc <= fd:
            b_, d_, fd = d_, c_, fc
            c_ = b_ - gr * (b_ - a_); fc = _profile_loss(x, y, c_, tau)[0]
        else:
            a_, c_, fc = c_, d_, fd
            d_ = a_ + gr * (b_ - a_); fd = _profile_loss(x, y, d_, tau)[0]
    bapprox = 0.5 * (a_ + b_)
    # vertex snap
    e = y - bapprox * x
    k = kth_index(len(e), tau)
    order = np.argsort(e, kind="stable")
    best = (np.inf, None, None)
    for i in order[max(0, k - 2):k + 3]:
        dx = x - x[i]
        ok = np.abs(dx) > 1e-12
        sl = np.where(ok, (y - y[i]) / np.where(ok, dx, 1.0), np.nan)
        cand = np.where(ok & (np.abs(sl - bapprox) < 1e-6))[0]
        for j in cand:
            L, a = _profile_loss(x, y, sl[j], tau)
            if L < best[0]:
                best = (L, sl[j], a)
    L0, a0 = _profile_loss(x, y, bapprox, tau)
    if best[1] is None or best[0] > L0:
        return float(a0), float(bapprox), L0, False
    return float(best[2]), float(best[1]), best[0], True


# ----------------------------------------------------------------------------- decay
def weighted_quantile_z(t, w, tau):
    """argmin_z sum w_i rho_tau(t_i - z), w > 0: smallest t_(k) with cum weight >= tau*W."""
    o = np.argsort(t, kind="stable")
    ts = t[o]; cw = np.cumsum(w[o])
    k = int(np.searchsorted(cw, tau * cw[-1], side="left"))
    return float(ts[min(k, len(ts) - 1)])


def decay_joint(r, h, c, tau=TAU_DECAY, mask=None):
    """Candidate (a): for fixed c, z*(c) = argmin_z sum rho(r - z S) (exact: weighted
    tau-quantile of r/S with weights S). Returns (loss, z)."""
    s = S(h, c)
    if mask is not None:
        r = r[mask]; s = s[mask]
    z = weighted_quantile_z(r / s, s, tau)
    return pinball(r - z * s, tau), z


def golden_min(f, lo, hi, tol=1e-12, iters=300):
    gr = (math.sqrt(5) - 1) / 2
    a_, b_ = lo, hi
    c_ = b_ - gr * (b_ - a_); d_ = a_ + gr * (b_ - a_)
    fc = f(c_); fd = f(d_)
    for _ in range(iters):
        if b_ - a_ < tol:
            break
        if fc <= fd:
            b_, d_, fd = d_, c_, fc
            c_ = b_ - gr * (b_ - a_); fc = f(c_)
        else:
            a_, c_, fc = c_, d_, fd
            d_ = a_ + gr * (b_ - a_); fd = f(d_)
    return 0.5 * (a_ + b_)


def grid_then_golden(f, lo, hi, n=2001, tol=1e-12):
    """Deterministic global-ish minimiser: uniform grid, then golden section inside the
    bracket of the best grid point (lowest index on ties)."""
    g = np.linspace(lo, hi, n)
    vals = np.array([f(c) for c in g])
    i = int(np.argmin(vals))
    a_ = g[max(0, i - 1)]; b_ = g[min(n - 1, i + 1)]
    cbest = golden_min(f, a_, b_, tol=tol)
    return cbest, f(cbest), g, vals


def flat_range(g, vals, rel=1e-3):
    """c range on grid g where objective is within rel of the minimum."""
    m = vals.min()
    ok = vals <= m * (1 + rel) if m > 0 else vals <= m + rel * abs(m)
    idx = np.where(ok)[0]
    return float(g[idx[0]]), float(g[idx[-1]])


def n_local_minima(vals):
    v = np.asarray(vals)
    return int(np.sum((v[1:-1] < v[:-2]) & (v[1:-1] <= v[2:])))


# ----------------------------------------------------------------------------- calibration
def calibrate(r, s, qs, method="linear"):
    out = {}
    t = r / s
    for q in qs:
        if q < 5:
            out[q] = float(np.quantile(r, q / 100.0, method=method))
        elif q == 5:
            out[q] = 0.0
        else:
            out[q] = float(np.quantile(t, q / 100.0, method=method))
    return out


def line_price(q, h, b0, b1, c, zd):
    la = b0 + b1 * math.log10(h)
    if q < 5:
        return 10 ** (la + zd[q])
    if q == 5:
        return 10 ** la
    return 10 ** (la + zd[q] * float(S(h, c)))


def percentile_of(h, usd, b0, b1, c, r_all, t_all):
    """Empirical coverage percentile of a (h, usd) point: share (in %) of fitted closes
    whose r (below anchor) or r/S (above anchor) is strictly below the point's."""
    r0 = math.log10(usd) - (b0 + b1 * math.log10(h))
    if r0 <= 0:
        return 100.0 * float(np.mean(r_all < r0))
    t0 = r0 / float(S(h, c))
    return 100.0 * float(np.mean(t_all < t0))


# ----------------------------------------------------------------------------- data
def d2o(s):
    return _dt.date.fromisoformat(s).toordinal()


def o2d(o):
    return _dt.date.fromordinal(int(o)).isoformat()


def load_cm(path):
    dates, prices = [], []
    with open(path) as f:
        next(f)
        for line in f:
            p = line.strip().split(",")
            if len(p) < 3 or p[2] == "":
                continue
            v = float(p[2])
            if v > 0:
                dates.append(d2o(p[0])); prices.append(v)
    return np.array(dates), np.array(prices)


def load_heights(path):
    """Returns dict ordinal -> cumulative blocks through end of UTC day (inclusive)."""
    out = {}
    with open(path) as f:
        next(f)
        for line in f:
            p = line.strip().split(",")
            out[d2o(p[0])] = int(p[2])
    return out


def load_fixture(path):
    """Regex-parse MARKET_PRICE_VALUES [[unixSeconds, usd], ...]; drop usd <= 0.
    Date = UTC date of the unix timestamp (as the app does)."""
    txt = open(path).read()
    i = txt.index("MARKET_PRICE_VALUES")
    j = txt.index("];", i)
    body = txt[i:j]
    dates, prices = [], []
    for m in re.finditer(r"\[\s*(\d{9,11})\s*,\s*([0-9.eE+-]+)\s*\]", body):
        ts = int(m.group(1)); v = float(m.group(2))
        if v <= 0:
            continue
        d = _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).date().toordinal()
        dates.append(d); prices.append(v)
    return np.array(dates), np.array(prices)


def load_bci(path):
    dates, prices = [], []
    with open(path) as f:
        next(f)
        for line in f:
            p = line.strip().split(",")
            v = float(p[1])
            if v > 0:
                dates.append(d2o(p[0])); prices.append(v)
    return np.array(dates), np.array(prices)


def heights_for(dates, H, conv="incl", off=0):
    """Height convention for a daily close on date D:
       incl: cum(D)    prev: cum(D-1)    mid: (cum(D-1)+cum(D))/2,   plus `off` blocks."""
    out = []
    for d in dates:
        if conv == "incl":
            v = H[d]
        elif conv == "prev":
            v = H[d - 1]
        elif conv == "mid":
            v = 0.5 * (H[d - 1] + H[d])
        elif conv == "next":
            v = H[d + 1]
        else:
            raise ValueError(conv)
        out.append(v + off)
    return np.array(out, dtype=float)


# ----------------------------------------------------------------------------- port-mirroring pieces
H_OFFSET = -5   # h = Coin Metrics cumulative BlkCnt through the day, minus 5 (see report B1)


def seqsum(a):
    """Left-to-right sequential sum (what a plain TS for-loop does)."""
    return float(np.cumsum(np.asarray(a, float))[-1])


def pinball_seq(e, tau):
    e = np.asarray(e, dtype=float)
    return seqsum(np.where(e >= 0, tau * e, (tau - 1.0) * e))


def q_type8(sorted_v, p):
    """Hyndman-Fan type 8 (numpy 'median_unbiased') on an ascending array.
    1-based position hpos = (n + 1/3) p + 1/3, clamped to [1, n], linear interpolation."""
    n = len(sorted_v)
    hpos = (n + 1.0 / 3.0) * p + 1.0 / 3.0
    if hpos <= 1:
        return float(sorted_v[0])
    if hpos >= n:
        return float(sorted_v[-1])
    j = int(math.floor(hpos))
    g = hpos - j
    return float(sorted_v[j - 1] + g * (sorted_v[j] - sorted_v[j - 1]))


def q_type8_inverse(sorted_v, x):
    """Inverse of q_type8: p such that q_type8(v, p) = x (piecewise linear), clamped to
    [p(1), p(n)]. On a flat run of ties returns the lowest p."""
    n = len(sorted_v)
    if x <= sorted_v[0]:
        return (1 - 1.0 / 3.0) / (n + 1.0 / 3.0)
    if x >= sorted_v[-1]:
        return (n - 1.0 / 3.0) / (n + 1.0 / 3.0)
    j = int(np.searchsorted(sorted_v, x, side="right"))   # v[j-1] <= x < v[j]  (1-based j)
    lo, hi = sorted_v[j - 1], sorted_v[j]
    g = (x - lo) / (hi - lo) if hi > lo else 0.0
    hpos = j + g
    return (hpos - 1.0 / 3.0) / (n + 1.0 / 3.0)


def decay_joint_seq(r, h, c, tau=TAU_DECAY):
    s = S(h, c)
    t = r / s
    o = np.argsort(t, kind="stable")
    cw = np.cumsum(s[o])
    k = int(np.searchsorted(cw, tau * cw[-1], side="left"))
    z = float(t[o][min(k, len(t) - 1)])
    return pinball_seq(r - z * s, tau), z


def c_search(r, h, lo=0.02, hi=1.0, step0=1e-2, levels=6, factor=10, half=2, tau=TAU_DECAY):
    """Deterministic nested grid search for c (port algorithm):
    level 0: c = lo + i*step0 (i integer) on [lo, hi]; take the argmin (lowest c on ties);
    each next level: step /= factor, grid c_best + j*step for j in [-factor*half, +factor*half]
    (i.e. +-`half` old steps); after `levels` refinements the step is step0/factor**levels
    (default 1e-2/1e6 = 1e-8). Strict '<' improvement in increasing-c order => lowest c on ties."""
    def f(c):
        return decay_joint_seq(r, h, c, tau)[0]
    n0 = int(round((hi - lo) / step0))
    best_c, best_f = None, math.inf
    for i in range(n0 + 1):
        c = lo + i * step0
        v = f(c)
        if v < best_f:
            best_c, best_f = c, v
    step = step0
    evals = n0 + 1
    for _ in range(levels):
        step /= factor
        center = best_c
        for j in range(-factor * half, factor * half + 1):
            c = center + j * step
            if c <= 0:
                continue
            v = f(c); evals += 1
            if v < best_f:
                best_c, best_f = c, v
    return best_c, best_f, evals


# ----------------------------------------------------------------------------- full fit
class Fit:
    pass


def fit(h, P, c_proc="joint", c_lo=0.05, c_hi=0.6, c_grid=2201, qmethod="linear",
        qs=None, c_fixed=None, anchor=None):
    """Chosen procedure: exact anchor QR (tau .05), c = argmin over c of
    min_z sum rho_.999(r - z S(h;c)) (candidate a), coverage calibration with `qmethod`."""
    qs = qs or LADDER
    x = np.log10(h); y = np.log10(P)
    F = Fit()
    if anchor is None:
        b0, b1, L, _ = qr_1d(x, y, TAU_ANCHOR)
    else:
        b0, b1 = anchor; L = pinball(y - b0 - b1 * x, TAU_ANCHOR)
    r = y - b0 - b1 * x
    F.b0, F.b1, F.anchor_loss = b0, b1, L
    if c_fixed is not None:
        F.c = c_fixed; F.decay_loss, F.z_fit = decay_joint(r, h, c_fixed)
    else:
        f = lambda c: decay_joint(r, h, c)[0]
        F.c, F.decay_loss, F.grid, F.gvals = grid_then_golden(f, c_lo, c_hi, c_grid)
        F.z_fit = decay_joint(r, h, F.c)[1]
    F.r = r; F.s = S(h, F.c); F.t = r / F.s
    F.zd = calibrate(r, F.s, qs, qmethod)
    F.n = len(h); F.h = h; F.P = P
    F.below_anchor = int(np.sum(r < 0))
    return F


GOLDEN_GRID = [0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90,
               95, 97.5, 99, 99.5, 99.9]


def fit_port(h, P, qs=None, c_kw=None):
    """The final procedure, written the way the TypeScript port should do it."""
    qs = qs or GOLDEN_GRID
    h = np.asarray(h, float); P = np.asarray(P, float)
    x = np.log10(h); y = np.log10(P)
    b0, b1, La, snapped = qr_1d(x, y, TAU_ANCHOR)
    r = y - (b0 + b1 * x)
    c, Ld, evals = c_search(r, h, **(c_kw or {}))
    s = S(h, c); t = r / s
    rs = np.sort(r); ts = np.sort(t)
    zd = {}
    for q in qs:
        if q < 5:
            zd[q] = q_type8(rs, q / 100.0)
        elif q == 5:
            zd[q] = 0.0
        else:
            zd[q] = q_type8(ts, q / 100.0)
    F = Fit()
    F.b0, F.b1, F.c, F.anchor_loss, F.decay_loss = b0, b1, c, pinball_seq(r, TAU_ANCHOR), Ld
    F.z_fit = decay_joint_seq(r, h, c)[1]
    F.zd = zd; F.r = r; F.s = s; F.t = t; F.rs = rs; F.ts = ts; F.n = len(h); F.h = h; F.P = P
    F.snapped = snapped; F.evals = evals
    return F


def percentile_port(F, h, usd):
    """Model percentile of (h, usd): invert the type-8 quantile of r (below anchor) or of
    r/S (at/above anchor). Returns percent in (0, 100)."""
    r0 = math.log10(usd) - (F.b0 + F.b1 * math.log10(h))
    if r0 < 0:
        return 100.0 * q_type8_inverse(F.rs, r0)
    return 100.0 * q_type8_inverse(F.ts, r0 / float(S(h, F.c)))


def share_below(F, h, usd):
    r0 = math.log10(usd) - (F.b0 + F.b1 * math.log10(h))
    if r0 < 0:
        return 100.0 * float(np.mean(F.r < r0))
    return 100.0 * float(np.mean(F.t < r0 / float(S(h, F.c))))
