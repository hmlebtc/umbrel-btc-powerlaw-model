// Hand-rolled canvas chart engine for the BTC Power Law Model dashboard.
//
// Exported as a JS *string* (CHART_JS) that dashboard.ts inlines into the page
// inside a <script> tag, BEFORE app.js. It defines a single global controller
// window.PLChart that app.js drives. No libraries, no CDN — everything is
// canvas 2D, devicePixelRatio-aware.
//
// Template-literal safety (mirrors src/dashboard.ts in the template repo):
// CHART_JS is a String.raw literal, so backslash escapes (\n in strings, the
// regex/dash-array literals) survive verbatim into the browser. There are NO
// backtick characters and NO dollar-brace runs anywhere inside it; the embedded
// JavaScript uses only quoted strings and "+" concatenation.
//
// What the client computes locally (server sends only params + daily prices):
//   trend price at day t:  10 ^ (a + n*log10(t))            [t = days since genesis]
//   band price k:          10 ^ (a + n*log10(t) + offset_k) [offset in log10 space]
// The trend and every VISIBLE percentile line (up to thirteen individually-toggled
// lines: 0.01/0.5/2.5/10/16.5/25/50/75/83.5/90/97.5/99.5/99.99%, the 50% median
// dashed, the 0.01/99.99% envelope pair added in v0.1.7) are
// re-sampled at ~2px resolution across the FULL domain (data start -> Dec 31 of
// projectionEndYear) so the curves stay smooth in any x/y mode and under any zoom.
//
// v0.1.6 (spec 15.3) adds a THIRD band methodology. When the fit says
// bandMode=quantileRegression AND carries bandLines, each percentile is its own
// fitted line (its own slope) rather than a parallel offset, so the band price is
//   band price k:          10 ^ (a_k + n_k*log10(t))
// evaluated per x and then MONOTONE-REARRANGED across the ladder (sort the ladder
// values ascending, hand them back in ascending-tau order) — a faithful replica of
// the backend's bandPricesAt(). Every consumer here (lines, fills, tooltip rows,
// tooltip quantile, oscillator guides, autoscale) reads through that one helper, so
// the drawn ladder can never cross. Any other mode — or a stale record that claims
// the mode but has no usable bandLines — keeps the unchanged parallel-offset path.
//
// Marker: PLCHART_ENGINE

import { REFRACTION_JS } from './refractionClient.js';

export const CHART_JS: string = String.raw`/* PLCHART_ENGINE */
"use strict";
(function () {
` + REFRACTION_JS + String.raw`
  // ---- constants ----------------------------------------------------------
  var GENESIS = Date.UTC(2009, 0, 3);   // power-law epoch; t = days since this
  var DAY = 86400000;
  var LN10 = Math.LN10;

  // porkopolis palette on dark background (spec section 8)
  var C = {
    price: "#42A04C",          // BTC price line
    priceDim: "rgba(66,160,76,0.55)",
    trend: "#ECECEC",          // power-regression trend
    outer: "#F44336",          // deviation colour when above trend (red)
    inner: "#03A9F4",          // deviation colour when below trend (blue)
    grid: "rgba(255,255,255,0.055)",
    gridStrong: "rgba(255,255,255,0.11)",
    axis: "#8a99ad",
    today: "rgba(236,236,236,0.55)",
    halving: "rgba(247,147,26,0.5)",
    caution: "rgba(148,163,184,0.10)",
    cautionLine: "rgba(148,163,184,0.16)",
    cross: "rgba(231,238,247,0.5)",
    oscUp: "#42A04C",          // ratio below 1 (undervalued)
    oscDown: "#F44336"         // ratio above 1 (overvalued)
  };

  // Halving markers: realised dates + projected (label "est.", dashed).
  var HALVINGS = [
    { ms: Date.UTC(2012, 10, 28), est: false },
    { ms: Date.UTC(2016, 6, 9), est: false },
    { ms: Date.UTC(2020, 4, 11), est: false },
    { ms: Date.UTC(2024, 3, 19), est: false },
    { ms: Date.UTC(2028, 3, 17), est: true },
    { ms: Date.UTC(2032, 3, 16), est: true }
  ];

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // The thirteen individually-toggled percentile lines (v0.1.2; the 0.01/99.99%
  // envelope pair added in v0.1.7). Each reads ONE offset off model.off by name and
  // is labelled by its percentile. The 50% median is DASHED gray; every other
  // percentile is dotted. "off" doubles as the legend/pref key. Lines whose offset
  // key is absent (fits made before that percentile existed) no-op, so every
  // consumer guards on linePresent(). Drawn top-down: 99.99% first, 0.01% last.
  var BAND_LINES = [
    { off: "p9999", pct: "99.99%", color: "#E91E63", dash: [2, 3], def: false },
    { off: "p995", pct: "99.5%", color: "#AB47BC", dash: [2, 3], def: false },
    { off: "p975", pct: "97.5%", color: "#F44336", dash: [2, 3], def: true },
    { off: "p90",  pct: "90%",   color: "#FF9800", dash: [2, 3], def: false },
    { off: "p835", pct: "83.5%", color: "#03A9F4", dash: [2, 3], def: true },
    { off: "p75",  pct: "75%",   color: "#26A69A", dash: [2, 3], def: false },
    { off: "p50",  pct: "50%",   color: "#9E9E9E", dash: [6, 4], def: false },
    { off: "p25",  pct: "25%",   color: "#26A69A", dash: [2, 3], def: false },
    { off: "p165", pct: "16.5%", color: "#03A9F4", dash: [2, 3], def: true },
    { off: "p10",  pct: "10%",   color: "#FF9800", dash: [2, 3], def: false },
    { off: "p025", pct: "2.5%",  color: "#F44336", dash: [2, 3], def: true },
    { off: "p005", pct: "0.5%",  color: "#AB47BC", dash: [2, 3], def: false },
    { off: "p0001", pct: "0.01%", color: "#E91E63", dash: [2, 3], def: false }
  ];

  // The ladder's band keys in ASCENDING-tau order (0.01% -> 99.99%) and the matching
  // percentages. This is the order the monotone rearrangement hands sorted values
  // back in, and the order the quantile interpolation walks (mirrors the backend
  // BAND_KEYS / BAND_TAUS).
  var QR_LADDER = ["p0001", "p005", "p025", "p10", "p165", "p25", "p50", "p75", "p835", "p90", "p975", "p995", "p9999"];
  var QR_PCTS = [0.01, 0.5, 2.5, 10, 16.5, 25, 50, 75, 83.5, 90, 97.5, 99.5, 99.99];
  // Reachable quantile range: the outermost ladder taus (mirrors the backend's
  // QUANTILE_MIN / QUANTILE_MAX, widened from 0.5/99.5 by the v0.1.7 envelope pair).
  var QUANTILE_MIN = 0.01, QUANTILE_MAX = 99.99;

  // Symmetric same-colour percentile pairs (outermost first). Band-fill shades
  // the region between a pair's two lines, but ONLY when BOTH lines are visible.
  // The 50% median is a lone line and has no fill. Opacities grade outermost-faintest.
  var FILL_PAIRS = [
    { lo: "p0001", hi: "p9999", fill: "rgba(233,30,99,0.03)" },
    { lo: "p005", hi: "p995", fill: "rgba(171,71,188,0.035)" },
    { lo: "p025", hi: "p975", fill: "rgba(244,67,54,0.05)" },
    { lo: "p10",  hi: "p90",  fill: "rgba(255,152,0,0.055)" },
    { lo: "p165", hi: "p835", fill: "rgba(3,169,244,0.07)" },
    { lo: "p25",  hi: "p75",  fill: "rgba(38,166,154,0.09)" }
  ];

  // ---- Refraction ladder (v0.2.0, spec 6.3) -------------------------------
  // The nine Refraction lines, drawn top-down (99.9% first), derived from the one
  // ladder list in the shared snippet (RF.LINES: key, colour, dash, width). They
  // use the same field names as BAND_LINES ("off" = legend/pref key, "pct" = label)
  // so the shared drawing paths take either list; "p" is the percentile the
  // evaluator is asked for, "w" the width, "tip" the tooltip label.
  var RF_LINES = [];
  (function () {
    for (var i = RF.LINES.length - 1; i >= 0; i--) {
      var L = RF.LINES[i];
      RF_LINES.push({ off: L.key, p: L.p, pct: L.p + "%", tip: L.p + "%" + (L.name ? " " + L.name : ""),
                      color: L.color, dash: L.dash, w: L.w, def: L.def });
    }
  })();
  var RF_BY_KEY = {};
  (function () { for (var i = 0; i < RF_LINES.length; i++) RF_BY_KEY[RF_LINES[i].off] = RF_LINES[i]; })();
  // The filled zones between ladder lines, cool to hot (spec 6.3). Unlike the
  // power-law pairs they do not depend on which lines are toggled on: they are the
  // model's zones, and the Band fill toggle switches them as a set.
  var RF_FILLS = [
    { lo: "r01", hi: "r15", fill: "rgba(96,165,250,0.17)" },
    { lo: "r15", hi: "r50", fill: "rgba(45,212,191,0.13)" },
    { lo: "r50", hi: "r75", fill: "rgba(245,213,71,0.12)" },
    { lo: "r75", hi: "r95", fill: "rgba(255,159,67,0.14)" },
    { lo: "r95", hi: "r999", fill: "rgba(255,92,122,0.16)" }
  ];

  // ---- math helpers -------------------------------------------------------
  function log10(x) { return Math.log(x) / LN10; }
  // continuous days-since-genesis (clamped to >=1 so log10(t) is defined)
  function daysCont(ms) { var d = (ms - GENESIS) / DAY; return d < 1 ? 1 : d; }
  function dayIndex(ms) { return Math.floor((ms - GENESIS) / DAY); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---- controller state ---------------------------------------------------
  var els = null;            // { main, mctx, osc, octx, tip, wrap, oscWrap }
  var model = null;          // { a, n, off:{p0001..p9999}, lines:{p0001..p9999}|null, projEnd, caution, bandMode }
  // Per-frame memo of the rearranged quantile-regression prices, keyed by timestamp.
  // Every line, fill, guide and tooltip asks for the same x grid, so one sort per x
  // per frame is enough. Cleared at the top of every draw().
  var qrCache = {};
  var prices = [];           // [{ t:ms, v:usd, flag:0|1 }] sorted by t
  var priceStart = null, priceEnd = null, provisional = null;
  var spot = null;           // { usd, at } — optional marker at today
  // prefs.bands maps each BAND_LINES "off" key -> shown boolean. Defaults mirror
  // the per-line "def" flags: the classic four (2.5/16.5/83.5/97.5) on, the rest off.
  var prefs = { xMode: "date", yMode: "log", bandFill: false, halvings: true, oscillator: true, preset: "full",
                bands: { p0001: false, p005: false, p025: true, p10: false, p165: true, p25: false, p50: false,
                         p75: false, p835: true, p90: false, p975: true, p995: false, p9999: false } };
  // Refraction mode (v0.2.0). rf = validated fit (RF.readFit), hm = date -> height
  // map (RF.heightMap); the mode is honoured only while both exist, so a missing
  // block or missing heights silently leaves the power-law drawing in place.
  // Refraction line visibility and its fill toggle are separate prefs (spec 6.3).
  var rf = null, hm = null;
  var rfNowRef = null;       // { h, ms, live }: the page's current height (U9 height rule)
  var mode = "powerLaw";
  prefs.rfLines = {};
  (function () { for (var i = 0; i < RF_LINES.length; i++) prefs.rfLines[RF_LINES[i].off] = RF_LINES[i].def; })();
  prefs.rfBandFill = true;
  var fullMin = Date.UTC(2010, 6, 18), fullMax = Date.UTC(2045, 11, 31);
  var view = { min: fullMin, max: fullMax };   // visible time window (ms)
  var todayMs = utcMidnight(Date.now());
  var onPresetCleared = null;

  // geometry (CSS px) recomputed each layout
  var G = { mL: 62, mR: 14, mT: 14, mB: 34, ml: 0, mr: 0, mt: 0, mb: 0, mw: 0, mh: 0,
            oT: 6, oB: 18, ot: 0, ob: 0, oh: 0, oOn: false };
  var yDom = { min: 1, max: 1e6 };   // main price y-domain for current view
  var oscDom = { min: 0.3, max: 3 }; // oscillator ratio y-domain

  // interaction
  var hover = null;          // { x, y } in CSS px, or null
  // drag holds an in-progress gesture. mode "pan" (plain left-drag / single-finger
  // touch) shifts the x view window; mode "zoom" (Shift+drag) is the range-select
  // rectangle. null when idle.
  var drag = null;
  var rafPending = false;
  var oscLabelYs = null;     // gutter-label y positions already used this frame (Refraction osc)

  function utcMidnight(ms) {
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // parse "YYYY-MM-DD" as a UTC midnight timestamp (timezone-proof)
  function parseDay(s) {
    var p = String(s).split("-");
    return Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }

  // ---- currency formatting (mirrors porkopolis: K/M above 10k, 2dp under $1)
  function fmtUSD(v) {
    if (v == null || !isFinite(v)) return "—";
    var a = Math.abs(v), s;
    if (a >= 1e12) s = trimNum(v / 1e12) + "T";
    else if (a >= 1e9) s = trimNum(v / 1e9) + "B";
    else if (a >= 1e6) s = trimNum(v / 1e6) + "M";
    else if (a >= 1e4) s = Math.round(v / 1e3) + "K";
    else if (a >= 1) s = Math.round(v).toLocaleString("en-US");
    else s = v.toFixed(2);
    return "$" + s;
  }
  function trimNum(x) {
    var r = Math.abs(x) >= 100 ? Math.round(x) : (Math.abs(x) >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100);
    return String(r);
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // =========================================================================
  //  AXIS MAPPING  (the load-bearing geometry)
  // =========================================================================
  // X: two modes share one time-domain view [view.min, view.max].
  //  - "date"    : linear in UTC milliseconds.
  //  - "log-days": linear in log10(days-since-genesis); the same time window is
  //                converted to its day-count endpoints and mapped on a log axis.
  // Y: "log" (default) or "linear".
  function xToPx(ms) {
    if (prefs.xMode === "logDays") {
      var lo = log10(daysCont(view.min)), hi = log10(daysCont(view.max));
      return G.ml + (log10(daysCont(ms)) - lo) / (hi - lo) * G.mw;
    }
    return G.ml + (ms - view.min) / (view.max - view.min) * G.mw;
  }
  function pxToMs(px) {
    var f = (px - G.ml) / G.mw;
    if (prefs.xMode === "logDays") {
      var lo = log10(daysCont(view.min)), hi = log10(daysCont(view.max));
      var d = Math.pow(10, lo + f * (hi - lo));
      return GENESIS + d * DAY;
    }
    return view.min + f * (view.max - view.min);
  }
  function yToPx(v) {
    if (prefs.yMode === "linear") {
      return G.mt + (yDom.max - v) / (yDom.max - yDom.min) * G.mh;
    }
    var lo = log10(yDom.min), hi = log10(yDom.max);
    return G.mt + (hi - log10(v <= 0 ? yDom.min : v)) / (hi - lo) * G.mh;
  }
  // oscillator y (always log ratio)
  function oscToPx(r) {
    var lo = log10(oscDom.min), hi = log10(oscDom.max);
    return G.ot + (hi - log10(r <= 0 ? oscDom.min : r)) / (hi - lo) * G.oh;
  }

  // trend + band prices at a given timestamp
  function trendLogAt(ms) { return model.a + model.n * log10(daysCont(ms)); }
  function trendAt(ms) { return Math.pow(10, trendLogAt(ms)); }
  function bandAt(ms, off) { return Math.pow(10, trendLogAt(ms) + off); }

  // ---- band values --------------------------------------------------------
  // True while the loaded fit carries usable quantile-regression band lines.
  function qrOn() { return !!(model && model.lines); }

  // The rearranged band prices at a timestamp (quantile-regression mode only):
  // evaluate every present line at t, sort the values ascending, and hand them back
  // to the present ladder keys in ascending-tau order — the monotone rearrangement
  // (Chernozhukov-Fernandez-Val-Galichon) the backend's bandPricesAt() applies, so
  // the ladder can never cross at any t even where the raw fits do.
  function qrPricesAt(ms) {
    var hit = qrCache[ms];
    if (hit) return hit;
    var lg = log10(daysCont(ms));
    var keys = [], vals = [], i, ln;
    for (i = 0; i < QR_LADDER.length; i++) {
      ln = model.lines[QR_LADDER[i]];
      if (!ln) continue;
      keys.push(QR_LADDER[i]);
      vals.push(Math.pow(10, ln.a + ln.n * lg));
    }
    vals.sort(function (p, q) { return p - q; });
    var out = {};
    for (i = 0; i < keys.length; i++) out[keys[i]] = vals[i];
    qrCache[ms] = out;
    return out;
  }

  // The single band evaluator every consumer goes through: the rearranged
  // quantile-regression price in that mode, the parallel trend+offset otherwise.
  function bandValueAt(ms, key) {
    if (qrOn()) return qrPricesAt(ms)[key];
    return bandAt(ms, model.off[key]);
  }
  function bandFn(key) { return function (ms) { return bandValueAt(ms, key); }; }

  // A percentile line is present only when the loaded model can evaluate it: its
  // own fitted line in quantileRegression mode, otherwise a finite offset (older
  // fits lack the newer keys -> those lines no-op).
  function linePresent(off) {
    if (!model) return false;
    if (model.lines) return !!model.lines[off];
    var v = model.off[off];
    return typeof v === "number" && isFinite(v);
  }
  // Visible = present AND toggled on via its legend chip.
  function offVisible(off) { return linePresent(off) && prefs.bands[off] === true; }

  // Widest offset envelope over the visible lines (falls back to the widest
  // present line, then to a flat 0/0). Used to frame the y-axis and the
  // oscillator so no visible line is ever clipped.
  function outerOffsets() {
    var lo = Infinity, hi = -Infinity, i, v;
    for (i = 0; i < BAND_LINES.length; i++) {
      if (!offVisible(BAND_LINES[i].off)) continue;
      v = model.off[BAND_LINES[i].off];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo)) {
      for (i = 0; i < BAND_LINES.length; i++) {
        if (!linePresent(BAND_LINES[i].off)) continue;
        v = model.off[BAND_LINES[i].off];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 0; }
    return { lo: lo, hi: hi };
  }

  // The quantile-regression twin of outerOffsets(): the lowest and highest VISIBLE
  // ladder keys (falling back to the present ones). Because the rearranged values
  // are ascending in ladder order at EVERY x, those two lines bound every visible
  // line everywhere — so framing the axes only needs to sample them.
  function outerKeys() {
    var lo = null, hi = null, i, k;
    for (i = 0; i < QR_LADDER.length; i++) {
      k = QR_LADDER[i];
      if (!offVisible(k)) continue;
      if (lo === null) lo = k;
      hi = k;
    }
    if (lo === null) {
      for (i = 0; i < QR_LADDER.length; i++) {
        k = QR_LADDER[i];
        if (!linePresent(k)) continue;
        if (lo === null) lo = k;
        hi = k;
      }
    }
    return { lo: lo, hi: hi };
  }

  // =========================================================================
  //  ACTIVE MODEL — the one indirection between "which model" and the drawing
  // =========================================================================
  // Every drawing path (lines, fills, autoscale, oscillator, tooltip, crosshair,
  // caution note) asks am() for the lines, their per-x values and the reference
  // line ("centre": the power-law Trend, or the Refraction 50% fair value). The
  // power-law adapter is a thin wrapper over the v0.1.8 functions above, so that
  // mode draws exactly what it always drew.
  function rfOn() { return !!(mode === "refraction" && rf && hm && model); }

  // Refraction line price at a timestamp; NaN where the model has no height.
  // Column cache (v0.2.0 review U5). A Refraction value depends on the date only
  // through the UTC day's height, so every column of a frame — the lines, both
  // edges of every zone, autoscale, the oscillator and the tooltip — shares one
  // record per DAY: its height, anchor and decay computed once, and each line's
  // price memoised on it. Indexed by the integer day (an array, not timestamps as
  // object keys — that string conversion was the real cost), it stays valid across
  // frames until the fit, the heights or "now" change (rfResetCache). The
  // arithmetic is exactly RF.linePriceAt's, so drawing is bit-identical to
  // evaluating every value afresh (pinned by a test through _columnCache(false)).
  var rfDays = [];            // day index (from the height map's start) -> column record
  var rfOffs = {};            // line key -> grid offset, fixed per fit
  var rfCacheOn = true;       // test hook: _columnCache(false) evaluates afresh
  var NO_COL = { ok: false, info: null };
  function rfCol(ms) {
    if (!hm) return NO_COL;
    var d = Math.floor((ms - hm.start) / DAY);
    if (!(d >= 0)) return NO_COL;
    var c = rfCacheOn ? rfDays[d] : undefined;
    if (c) return c;
    var hi = RF.heightInfo(hm, hm.start + d * DAY, rfNowRef);
    var h = hi ? hi.h : NaN;
    if (!(h > 0) || !isFinite(h)) c = { ok: false, info: hi };
    else c = { ok: true, info: hi, la: RF.anchorLogAt(rf, h), s: RF.decayAt(rf.c, rf.alpha, h), v: {} };
    if (rfCacheOn) rfDays[d] = c;
    return c;
  }
  function rfValueAt(ms, key) {
    var l = RF_BY_KEY[key];
    if (!l) return NaN;
    var c = rfCol(ms);
    if (!c.ok) return NaN;
    var v = c.v[key];
    if (v !== undefined) return v;
    var off = rfOffs[key];
    v = Math.pow(10, l.p > 5 ? c.la + off * c.s : c.la + off);
    c.v[key] = v;
    return v;
  }
  function rfResetCache() {
    rfDays = [];
    rfOffs = {};
    if (rf) for (var i = 0; i < RF_LINES.length; i++) rfOffs[RF_LINES[i].off] = RF.offsetAt(rf, RF_LINES[i].p);
  }
  function rfVisible(key) { return !!RF_BY_KEY[key] && prefs.rfLines[key] === true; }

  var PL_MODEL = {
    lines: BAND_LINES,
    visible: offVisible,
    valueAt: bandValueAt,
    centerAt: trendAt,
    drawCenter: true,
    fillOn: function () { return prefs.bandFill; },
    // visible symmetric pairs only, outermost first (the v0.1.8 rule)
    fills: function () {
      var out = [];
      for (var i = 0; i < FILL_PAIRS.length; i++) {
        var fp = FILL_PAIRS[i];
        if (offVisible(fp.lo) && offVisible(fp.hi)) out.push(fp);
      }
      return out;
    },
    // y-envelope sampler for autoscaleY: a constant offset pair in the parallel
    // modes, the outer ladder lines sampled per x when the bands are separately sloped
    envelope: function () {
      var ok = qrOn() ? outerKeys() : null;
      var ob = (ok && ok.lo) ? null : outerOffsets();
      return function (ms) {
        return [ob ? bandAt(ms, ob.lo) : bandValueAt(ms, ok.lo), ob ? bandAt(ms, ob.hi) : bandValueAt(ms, ok.hi)];
      };
    },
    oscRange: function () {
      var lo = 0.3, hi = 3;
      if (qrOn()) {
        var ok = outerKeys();
        if (ok.lo) {
          var qLo = Infinity, qHi = -Infinity, N = 60, k, msq, rLo, rHi;
          for (k = 0; k <= N; k++) {
            msq = view.min + (view.max - view.min) * (k / N);
            rLo = bandValueAt(msq, ok.lo) / trendAt(msq);
            rHi = bandValueAt(msq, ok.hi) / trendAt(msq);
            if (rLo > 0 && rLo < qLo) qLo = rLo;
            if (rHi > qHi) qHi = rHi;
          }
          if (isFinite(qLo) && isFinite(qHi) && qLo > 0) { lo = qLo; hi = qHi; }
        }
      } else {
        var ob = outerOffsets();
        if (!(ob.lo === 0 && ob.hi === 0)) { lo = Math.pow(10, ob.lo); hi = Math.pow(10, ob.hi); }
      }
      return { lo: lo, hi: hi };
    },
    // flat guides with parallel offsets, per-x curves for separately-sloped lines
    oscGuides: function (ctx) {
      for (var pi = 0; pi < BAND_LINES.length; pi++) {
        var bl = BAND_LINES[pi];
        if (!offVisible(bl.off)) continue;
        if (qrOn()) oscCurve(ctx, bl);
        else oscGuide(ctx, Math.pow(10, model.off[bl.off]), bl.color, bl.dash);
      }
    },
    tipRows: function (ms, pricePt) {
      var tl = trendLogAt(ms), trend = Math.pow(10, tl);
      var rows = [];
      rows.push(row("Date", fmtDate(ms) + "  (t=" + dayIndex(ms) + ")", C.axis));
      if (pricePt) {
        var dev = (pricePt.v / trend - 1) * 100;
        var q = qrOn() ? quantileFromLinesAt(ms, pricePt.v) : residualQuantile(log10(pricePt.v) - tl);
        rows.push(row("Price", fmtUSD(pricePt.v) + (pricePt.flag === 1 ? " (prov.)" : ""), C.price));
        rows.push(row("Deviation", (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%", dev >= 0 ? C.outer : C.inner));
        if (isFinite(q)) rows.push(row("Quantile", q.toFixed(1) + "%", C.axis));
      }
      // Every visible percentile line plus the Trend, merged and sorted by dollar
      // value descending. Each row is labelled by its percentile ("97.5%") or
      // "Trend" — no hi/lo wording (individual labelled lines since v0.1.2).
      var items = [], vi;
      for (vi = 0; vi < BAND_LINES.length; vi++) {
        var bl = BAND_LINES[vi];
        if (!offVisible(bl.off)) continue;
        items.push({ label: bl.pct, val: bandValueAt(ms, bl.off), color: bl.color });
      }
      items.push({ label: "Trend", val: trend, color: C.trend });
      items.sort(function (a, b) { return b.val - a.val; });
      for (vi = 0; vi < items.length; vi++) rows.push(row(items[vi].label, fmtUSD(items[vi].val), items[vi].color));
      return rows;
    },
    cautionText: function () { return ["beyond stated model validity (~" + model.caution + ")"]; }
  };

  var RF_MODEL = {
    lines: RF_LINES,
    visible: rfVisible,
    valueAt: rfValueAt,
    colOk: function (ms) { return rfCol(ms).ok; },
    centerAt: function (ms) { return rfValueAt(ms, "r50"); },
    drawCenter: false,   // the fair value is the (toggleable) 50% line itself
    fillOn: function () { return prefs.rfBandFill; },
    fills: function () { return RF_FILLS; },
    // The ladder is ordered at every height (d_q and z_q both rise with q, S > 0),
    // so the lowest and highest visible lines bound every visible line everywhere;
    // with the fill on, the outer zone edges (0.1% / 99.9%) are framed too.
    envelope: function () {
      var lo = null, hi = null, i;
      for (i = RF_LINES.length - 1; i >= 0; i--) {
        var k = RF_LINES[i].off;
        if (!rfVisible(k)) continue;
        if (lo === null) lo = k;
        hi = k;
      }
      if (prefs.rfBandFill || lo === null) { lo = "r01"; hi = "r999"; }
      return function (ms) { return [rfValueAt(ms, lo), rfValueAt(ms, hi)]; };
    },
    // the guide ratios move with height, so sample the visible outer curves
    oscRange: function () {
      var lo = 0.3, hi = 3, qLo = Infinity, qHi = -Infinity, N = 60, k, i, msq, c, r;
      for (k = 0; k <= N; k++) {
        msq = view.min + (view.max - view.min) * (k / N);
        c = rfValueAt(msq, "r50");
        if (!(c > 0)) continue;
        for (i = 0; i < RF_LINES.length; i++) {
          if (!rfVisible(RF_LINES[i].off)) continue;
          r = rfValueAt(msq, RF_LINES[i].off) / c;
          if (r > 0 && r < qLo) qLo = r;
          if (r > qHi) qHi = r;
        }
      }
      if (isFinite(qLo) && isFinite(qHi) && qLo > 0) { lo = Math.min(lo, qLo); hi = Math.max(hi, qHi); }
      return { lo: lo, hi: hi };
    },
    oscGuides: function (ctx) {
      // gutter labels of curves that start close together would overprint; keep
      // the first (top-down) and skip any within 10px of one already drawn
      oscLabelYs = [oscToPx(1)];
      for (var pi = 0; pi < RF_LINES.length; pi++) {
        var bl = RF_LINES[pi];
        if (bl.off === "r50" || !rfVisible(bl.off)) continue;   // 50% is the 1.0x guide itself
        oscCurve(ctx, bl);
      }
    },
    tipRows: function (ms, pricePt) {
      var rows = [], hi = rfCol(ms).info;
      var fair = rfValueAt(ms, "r50");
      rows.push(row("Date", fmtDate(ms), C.axis));
      rows.push(row("Block height", hi ? (Math.round(hi.h).toLocaleString("en-US") + (hi.est ? " (est.)" : "")) : "—", C.axis));
      if (pricePt) {
        rows.push(row("Price", fmtUSD(pricePt.v) + (pricePt.flag === 1 ? " (prov.)" : ""), C.price));
        if (fair > 0) {
          var dev = (pricePt.v / fair - 1) * 100;
          rows.push(row("Deviation", (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%", dev >= 0 ? C.outer : C.inner));
        }
        var q = hi ? RF.percentileOf(rf, hi.h, pricePt.v) : NaN;
        // grid inverse: an approximation of the server's exact percentile (U7)
        if (isFinite(q)) rows.push(row("Percentile", "≈" + q.toFixed(1) + "%", C.axis));
      }
      var items = [], vi;
      for (vi = 0; vi < RF_LINES.length; vi++) {
        var bl = RF_LINES[vi];
        if (!rfVisible(bl.off)) continue;
        var v = rfValueAt(ms, bl.off);
        if (isFinite(v)) items.push({ label: bl.tip, val: v, color: bl.color });
      }
      items.sort(function (a, b) { return b.val - a.val; });
      for (vi = 0; vi < items.length; vi++) rows.push(row(items[vi].label, fmtUSD(items[vi].val), items[vi].color));
      return rows;
    },
    // Same hatched region, different words (U4): the author publishes five-year
    // projections; everything right of "today" is the fitted model extended forward,
    // and the hatch marks the far range, well beyond anything he has published.
    cautionText: function () { return ["far range: well beyond", "the author's five-year", "projections"]; }
  };

  function am() { return rfOn() ? RF_MODEL : PL_MODEL; }

  // =========================================================================
  //  AUTOSCALE — choose the price y-domain that fits the current view
  // =========================================================================
  // Sample the outer offset envelope plus any visible price points across the
  // view, then pad in the active space (log or linear).
  function autoscaleY() {
    if (!model) { yDom = { min: 1, max: 1e6 }; return; }
    var lo = Infinity, hi = -Infinity, i;
    // Envelope of the active model's visible lines, sampled across the view
    // (see the adapters' envelope()).
    var env = am().envelope();
    var N = 100;
    for (i = 0; i <= N; i++) {
      var ms = view.min + (view.max - view.min) * (i / N);
      var lh = env(ms);
      var low = lh[0], high = lh[1];
      if (low < lo) lo = low;
      if (high > hi) hi = high;
    }
    // fold in visible price points so the green line is never clipped
    for (i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t < view.min || p.t > view.max) continue;
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (!isFinite(lo) || !isFinite(hi) || lo <= 0) { yDom = { min: 1, max: 1e6 }; return; }
    if (prefs.yMode === "linear") {
      var padL = (hi - lo) * 0.06;
      yDom = { min: Math.max(0.01, lo - padL), max: hi + padL };
    } else {
      var lgLo = log10(lo), lgHi = log10(hi), padD = (lgHi - lgLo) * 0.06 + 0.02;
      yDom = { min: Math.pow(10, lgLo - padD), max: Math.pow(10, lgHi + padD) };
    }
  }

  function autoscaleOsc() {
    // ratio domain wide enough for the visible line multipliers and the data
    var lo = 0.3, hi = 3;
    var A = am();
    if (model) { var rg = A.oscRange(); lo = rg.lo; hi = rg.hi; }
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t < view.min || p.t > view.max) continue;
      var r = p.v / A.centerAt(p.t);
      if (r > 0 && r < lo) lo = r;
      if (r > hi) hi = r;
    }
    var lgLo = log10(lo) - 0.08, lgHi = log10(hi) + 0.08;
    oscDom = { min: Math.pow(10, lgLo), max: Math.pow(10, lgHi) };
  }

  // =========================================================================
  //  LAYOUT — size the backing store for devicePixelRatio, compute plot rects
  // =========================================================================
  function layout() {
    if (!els) return;
    var dpr = window.devicePixelRatio || 1;
    // main canvas
    var mw = els.wrap.clientWidth, mh = els.wrap.clientHeight;
    if (mw < 10) mw = 320;
    if (mh < 10) mh = 320;
    setCanvasSize(els.main, els.mctx, mw, mh, dpr);
    G.ml = G.mL; G.mt = G.mT; G.mw = mw - G.mL - G.mR; G.mh = mh - G.mT - G.mB;
    if (G.mw < 1) G.mw = 1; if (G.mh < 1) G.mh = 1;
    // oscillator canvas (only when visible)
    G.oOn = !!(els.oscWrap && els.oscWrap.offsetParent !== null && prefs.oscillator);
    if (G.oOn) {
      var ow = els.oscWrap.clientWidth, oh = els.oscWrap.clientHeight;
      if (ow < 10) ow = mw; if (oh < 10) oh = 120;
      setCanvasSize(els.osc, els.octx, ow, oh, dpr);
      G.ot = G.oT; G.oh = oh - G.oT - G.oB; if (G.oh < 1) G.oh = 1;
    }
  }
  function setCanvasSize(canvas, ctx, cssW, cssH, dpr) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS px thereafter
  }

  // =========================================================================
  //  DRAW
  // =========================================================================
  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(function () { rafPending = false; draw(); });
  }

  function draw() {
    if (!els) return;
    qrCache = {};   // one rearrangement per x per frame
    layout();
    autoscaleY();
    if (G.oOn) autoscaleOsc();
    drawMain();
    if (G.oOn) drawOsc();
  }

  function drawMain() {
    var ctx = els.mctx;
    // clear the full CSS box (ctx is dpr-scaled, so CSS px covers the backing store)
    ctx.clearRect(0, 0, els.main.clientWidth, els.main.clientHeight);

    if (!model) { placeholder(ctx, "Loading model…"); return; }

    drawGrid(ctx);
    // clip series to the plot rectangle
    ctx.save();
    ctx.beginPath();
    ctx.rect(G.ml, G.mt, G.mw, G.mh);
    ctx.clip();
    if (am().fillOn()) drawBandFills(ctx);
    drawBands(ctx);
    if (am().drawCenter) drawTrend(ctx);
    drawPrice(ctx);
    drawTodayLine(ctx);
    if (prefs.halvings) drawHalvings(ctx);
    ctx.restore();

    drawCaution(ctx);   // dim hatch over the >caution-year region (over data)
    drawAxisLabels(ctx);
    if (hover) drawCrosshair(ctx);
    if (drag && drag.mode === "zoom") drawDragRect(ctx);
  }

  function placeholder(ctx, msg) {
    ctx.fillStyle = C.axis;
    ctx.font = "13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, G.ml + G.mw / 2, G.mt + G.mh / 2);
  }

  // ---- grid + y/x tick computation ----------------------------------------
  // "Nice" step for the linear y-axis: 1, 2 or 5 x a power of ten (Heckbert).
  // (v0.2.0: yTicks has called this since v0.1.x but it was never defined, so
  // Y = Linear threw and stopped the frame; added here, used by both models.)
  function niceNum(range, round) {
    if (!(range > 0) || !isFinite(range)) return 1;
    var exp = Math.floor(log10(range)), f = range / Math.pow(10, exp), nf;
    if (round) nf = f < 1.5 ? 1 : (f < 3 ? 2 : (f < 7 ? 5 : 10));
    else nf = f <= 1 ? 1 : (f <= 2 ? 2 : (f <= 5 ? 5 : 10));
    return nf * Math.pow(10, exp);
  }
  function yTicks() {
    var out = [];
    if (prefs.yMode === "linear") {
      var step = niceNum((yDom.max - yDom.min) / 6, true);
      var start = Math.ceil(yDom.min / step) * step;
      for (var v = start; v <= yDom.max + 1e-9; v += step) out.push(v);
      return out;
    }
    // log: decade lines, thinned if there are many decades
    var lo = Math.floor(log10(yDom.min)), hi = Math.ceil(log10(yDom.max));
    var span = hi - lo, dstep = span > 9 ? 2 : 1;
    for (var k = lo; k <= hi; k += dstep) {
      var val = Math.pow(10, k);
      if (val >= yDom.min && val <= yDom.max) out.push(val);
    }
    // if very few decades are visible, add 3x subdivisions for readability
    if (out.length <= 3) {
      var extra = [];
      for (var j = lo; j <= hi; j++) {
        var b = Math.pow(10, j);
        var m3 = b * 3;
        if (m3 >= yDom.min && m3 <= yDom.max) extra.push(m3);
      }
      out = out.concat(extra).sort(function (p, q) { return p - q; });
    }
    return out;
  }

  function drawGrid(ctx) {
    var i, y, x, t = yTicks();
    ctx.lineWidth = 1;
    for (i = 0; i < t.length; i++) {
      y = yToPx(t[i]);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(G.ml, y); ctx.lineTo(G.ml + G.mw, y); ctx.stroke();
    }
    var xt = xTicks();
    for (i = 0; i < xt.length; i++) {
      x = xToPx(xt[i].ms);
      if (x < G.ml - 0.5 || x > G.ml + G.mw + 0.5) continue;
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(x, G.mt); ctx.lineTo(x, G.mt + G.mh); ctx.stroke();
    }
  }

  // X ticks depend on the mode and the visible span.
  function xTicks() {
    var out = [];
    if (prefs.xMode === "logDays") {
      // ticks at 1-2-5 x powers of 10 days, within the visible day range
      var dLo = daysCont(view.min), dHi = daysCont(view.max);
      var kLo = Math.floor(log10(dLo)), kHi = Math.ceil(log10(dHi));
      var mults = [1, 2, 5];
      for (var k = kLo; k <= kHi; k++) {
        for (var mi = 0; mi < mults.length; mi++) {
          var d = mults[mi] * Math.pow(10, k);
          if (d >= dLo && d <= dHi) out.push({ ms: GENESIS + d * DAY, days: d });
        }
      }
      return out;
    }
    // date mode: year (or month) boundaries with an adaptive step
    var spanDays = (view.max - view.min) / DAY;
    var y0 = new Date(view.min).getUTCFullYear(), y1 = new Date(view.max).getUTCFullYear();
    if (spanDays < 420) {
      // month ticks
      var d = new Date(Date.UTC(y0, new Date(view.min).getUTCMonth(), 1));
      var stepM = spanDays < 130 ? 1 : (spanDays < 260 ? 2 : 3);
      while (d.getTime() <= view.max) {
        if (d.getTime() >= view.min) out.push({ ms: d.getTime(), month: true });
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + stepM, 1));
      }
      return out;
    }
    var years = y1 - y0 + 1;
    var stepY = years <= 12 ? 1 : (years <= 24 ? 2 : (years <= 60 ? 5 : 10));
    var startY = Math.ceil(y0 / stepY) * stepY;
    for (var yy = startY; yy <= y1; yy += stepY) out.push({ ms: Date.UTC(yy, 0, 1) });
    return out;
  }

  function drawAxisLabels(ctx) {
    var i;
    ctx.fillStyle = C.axis;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    // Y labels
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    var t = yTicks();
    for (i = 0; i < t.length; i++) {
      var y = yToPx(t[i]);
      if (y < G.mt - 1 || y > G.mt + G.mh + 1) continue;
      ctx.fillText(fmtUSD(t[i]), G.ml - 8, y);
    }
    // X labels
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    var xt = xTicks();
    for (i = 0; i < xt.length; i++) {
      var x = xToPx(xt[i].ms);
      if (x < G.ml - 20 || x > G.ml + G.mw + 20) continue;
      if (prefs.xMode === "logDays") {
        // BOTH day number and date (spec section 8)
        ctx.fillText(fmtDays(xt[i].days) + " d", x, G.mt + G.mh + 5);
        ctx.fillStyle = "rgba(138,153,173,0.7)";
        ctx.fillText(shortDate(xt[i].ms), x, G.mt + G.mh + 18);
        ctx.fillStyle = C.axis;
      } else if (xt[i].month) {
        var dd = new Date(xt[i].ms);
        ctx.fillText(MONTHS[dd.getUTCMonth()] + " " + String(dd.getUTCFullYear()).slice(2), x, G.mt + G.mh + 6);
      } else {
        ctx.fillText(String(new Date(xt[i].ms).getUTCFullYear()), x, G.mt + G.mh + 6);
      }
    }
  }
  function fmtDays(d) {
    if (d >= 1000) return (d / 1000) + "k";
    return String(d);
  }
  function shortDate(ms) {
    var dd = new Date(ms);
    return dd.getUTCFullYear() + "-" + pad2(dd.getUTCMonth() + 1);
  }

  // ---- series -------------------------------------------------------------
  // Build a poly-line for f(ms)->price sampled at ~2px across the plot width.
  function samplePath(ctx, valueFn) {
    var step = 2, started = false;
    ctx.beginPath();
    for (var px = G.ml; px <= G.ml + G.mw + 0.01; px += step) {
      var ms = pxToMs(px);
      var v = valueFn(ms);
      var y = yToPx(v);
      if (!isFinite(y)) { started = false; continue; }
      if (!started) { ctx.moveTo(px, y); started = true; } else { ctx.lineTo(px, y); }
    }
  }

  // Each visible percentile line is ONE polyline in its own colour. The 50%
  // median is drawn dashed; every other percentile is dotted. Lines the model
  // cannot evaluate (old fits) or toggled off via the legend are skipped cleanly.
  // The per-x value comes from bandFn(), so parallel offsets and separately-sloped
  // quantile-regression lines draw through the very same sampler.
  // (v0.2.0) The same loop draws the active model's list: the Refraction lines
  // carry their own width ("w"); the power-law percentiles keep the shared 1.4.
  function drawBands(ctx) {
    var A = am();
    ctx.lineWidth = 1.4;
    for (var i = 0; i < A.lines.length; i++) {
      var bl = A.lines[i];
      if (!A.visible(bl.off)) continue;
      var w = bl.w || 1.4;
      if (ctx.lineWidth !== w) ctx.lineWidth = w;
      ctx.setLineDash(bl.dash);
      ctx.strokeStyle = bl.color;
      samplePath(ctx, lineFn(A, bl.off));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  function lineFn(A, key) { return A === PL_MODEL ? bandFn(key) : function (ms) { return A.valueAt(ms, key); }; }

  // Optional translucent fills for the visible symmetric pairs (default off),
  // drawn outermost-first so inner pairs layer on top. A pair fills only when
  // BOTH of its lines are visible; the lone 50% median never fills.
  function drawBandFills(ctx) {
    var A = am(), list = A.fills();
    for (var i = 0; i < list.length; i++) fillBetween(ctx, A, list[i].lo, list[i].hi, list[i].fill);
  }
  // Fill between two ladder lines, sampled per x through the active evaluator so a
  // narrowing fan (quantile regression, or the Refraction lines bending onto the
  // anchor) fills its true shape. The polygon spans only the x range where both
  // edges are finite (a Refraction line has no value before the height series).
  function fillBetween(ctx, A, loKey, hiKey, color) {
    var step = 2, px, x0 = null, x1 = null, gap = false;
    for (px = G.ml; px <= G.ml + G.mw + 0.01; px += step) {
      var ms = pxToMs(px);
      // a Refraction column is drawable exactly when it has a height (positive
      // finite prices then map to finite pixels), so it needs no value evaluation
      if (A.colOk ? A.colOk(ms) : (isFinite(yToPx(A.valueAt(ms, hiKey))) && isFinite(yToPx(A.valueAt(ms, loKey))))) {
        if (x0 === null) x0 = px;
        x1 = px;
      } else { gap = true; if (x0 !== null) break; }
    }
    if (x0 === null) return;
    // finite across the whole plot (always, in power-law mode): the v0.1.8 bounds
    var xr = gap ? x1 : G.ml + G.mw;
    ctx.beginPath();
    for (px = x0; px <= x1 + 0.01; px += step) {
      var y = yToPx(A.valueAt(pxToMs(px), hiKey));
      if (px === x0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    for (px = xr; px >= x0 - 0.01; px -= step) {
      ctx.lineTo(px, yToPx(A.valueAt(pxToMs(px), loKey)));
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawTrend(ctx) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.trend;
    samplePath(ctx, function (ms) { return trendAt(ms); });
    ctx.stroke();
  }

  function drawPrice(ctx) {
    if (!prices.length) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.price;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t > view.max + DAY) break;             // sorted; nothing further is visible
      if (p.t < view.min - DAY) continue;
      var x = xToPx(p.t), y = yToPx(p.v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    // provisional today point drawn as a hollow ring
    if (provisional) {
      var px = xToPx(provisional.t), py = yToPx(provisional.v);
      ctx.lineWidth = 2; ctx.strokeStyle = C.price;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawTodayLine(ctx) {
    var x = xToPx(todayMs);
    if (x < G.ml || x > G.ml + G.mw) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.today;
    ctx.beginPath(); ctx.moveTo(x, G.mt); ctx.lineTo(x, G.mt + G.mh); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.today;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (x < G.ml + G.mw - 40) ctx.fillText("today", x + 3, G.mt + 2);
  }

  function drawHalvings(ctx) {
    ctx.save();
    ctx.lineWidth = 1;
    for (var i = 0; i < HALVINGS.length; i++) {
      var h = HALVINGS[i], x = xToPx(h.ms);
      if (x < G.ml || x > G.ml + G.mw) continue;
      ctx.setLineDash(h.est ? [2, 5] : [5, 4]);
      ctx.strokeStyle = C.halving;
      ctx.beginPath(); ctx.moveTo(x, G.mt); ctx.lineTo(x, G.mt + G.mh); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.halving;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      var lbl = "halving" + (h.est ? " est." : "");
      ctx.save();
      ctx.translate(x, G.mt + G.mh - 4);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(lbl, 0, -2);
      ctx.restore();
    }
    ctx.restore();
  }

  // Dim/hatch the region beyond the stated model validity year.
  function drawCaution(ctx) {
    if (!model) return;
    var startMs = Date.UTC(model.caution + 1, 0, 1);
    var x0 = xToPx(startMs);
    if (x0 >= G.ml + G.mw) return;
    x0 = Math.max(x0, G.ml);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, G.mt, G.ml + G.mw - x0, G.mh); ctx.clip();
    ctx.fillStyle = C.caution;
    ctx.fillRect(x0, G.mt, G.ml + G.mw - x0, G.mh);
    // diagonal hatch
    ctx.strokeStyle = C.cautionLine; ctx.lineWidth = 1;
    for (var d = -G.mh; d < G.mw; d += 9) {
      ctx.beginPath();
      ctx.moveTo(x0 + d, G.mt + G.mh);
      ctx.lineTo(x0 + d + G.mh, G.mt);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "rgba(148,163,184,0.75)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (x0 < G.ml + G.mw - 60) {
      var lines = am().cautionText();
      if (lines.length === 1) ctx.fillText(lines[0], x0 + 4, G.mt + 4);
      else {
        // multi-line (Refraction) caption sits at the foot of the hatch: the
        // ladder converges high on the right, so the bottom is always clear
        var top = G.mt + G.mh - 6 - lines.length * 11;
        for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], x0 + 4, top + li * 11);
      }
    }
  }

  // ---- crosshair + shared tooltip -----------------------------------------
  function drawCrosshair(ctx) {
    var x = clamp(hover.x, G.ml, G.ml + G.mw);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = C.cross; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, G.mt); ctx.lineTo(x, G.mt + G.mh); ctx.stroke();
    if (hover.y >= G.mt && hover.y <= G.mt + G.mh) {
      ctx.beginPath(); ctx.moveTo(G.ml, hover.y); ctx.lineTo(G.ml + G.mw, hover.y); ctx.stroke();
    }
    ctx.restore();

    var ms = pxToMs(x);
    // a dot on the reference line (Trend / fair value) at the cursor
    var ty = yToPx(am().centerAt(ms));
    if (isFinite(ty)) {
      ctx.fillStyle = C.trend;
      ctx.beginPath(); ctx.arc(x, ty, 3, 0, Math.PI * 2); ctx.fill();
    }
    // nearest price point (snap within ~30px), for price/deviation/quantile
    var near = nearestPrice(ms);
    var pxPrice = null;
    if (near && Math.abs(xToPx(near.t) - x) <= 30) {
      pxPrice = near;
      ctx.fillStyle = C.price;
      ctx.beginPath(); ctx.arc(xToPx(near.t), yToPx(near.v), 3.2, 0, Math.PI * 2); ctx.fill();
    }
    updateTooltip(ms, pxPrice, x);
  }

  function drawDragRect(ctx) {
    var x0 = clamp(Math.min(drag.x0, drag.x1), G.ml, G.ml + G.mw);
    var x1 = clamp(Math.max(drag.x0, drag.x1), G.ml, G.ml + G.mw);
    ctx.fillStyle = "rgba(79,140,255,0.14)";
    ctx.fillRect(x0, G.mt, x1 - x0, G.mh);
    ctx.strokeStyle = "rgba(79,140,255,0.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(x0, G.mt, x1 - x0, G.mh);
  }

  // binary search for the price point nearest a timestamp
  function nearestPrice(ms) {
    if (!prices.length) return null;
    var lo = 0, hi = prices.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (prices[mid].t < ms) lo = mid + 1; else hi = mid;
    }
    var a = prices[lo], b = prices[lo > 0 ? lo - 1 : 0];
    return (Math.abs(a.t - ms) <= Math.abs(b.t - ms)) ? a : b;
  }

  // Estimate the residual quantile client-side by interpolating the four classic
  // band anchors (offset -> percentile). Below/above the outer anchors we ease
  // toward 0/100 so the number stays monotone.
  function residualQuantile(resid) {
    var o = model.off;
    var xs = [o.p025, o.p165, o.p835, o.p975];
    var qs = [2.5, 16.5, 83.5, 97.5];
    if (resid <= xs[0]) {
      var f0 = xs[0] - (xs[1] - xs[0]);
      return clamp((resid - f0) / (xs[0] - f0) * qs[0], 0, qs[0]);
    }
    if (resid >= xs[3]) {
      var f1 = xs[3] + (xs[3] - xs[2]);
      return clamp(qs[3] + (resid - xs[3]) / (f1 - xs[3]) * (100 - qs[3]), qs[3], 100);
    }
    for (var i = 0; i < 3; i++) {
      if (resid >= xs[i] && resid <= xs[i + 1]) {
        var f = (resid - xs[i]) / (xs[i + 1] - xs[i]);
        return qs[i] + f * (qs[i + 1] - qs[i]);
      }
    }
    return 50;
  }

  // Quantile in quantileRegression mode (mirrors the backend quantileFromLines):
  // where the hovered price sits among the rearranged ladder values at this x, tau
  // linearly interpolated in log10 price space between the two bracketing lines and
  // clamped to the ladder's own outer levels — [0.01, 99.99] since v0.1.7.
  function quantileFromLinesAt(ms, usd) {
    if (!(usd > 0)) return NaN;
    var prices = qrPricesAt(ms), vals = [], pcts = [], i, v;
    for (i = 0; i < QR_LADDER.length; i++) {
      v = prices[QR_LADDER[i]];
      if (typeof v === "number" && isFinite(v) && v > 0) { vals.push(v); pcts.push(QR_PCTS[i]); }
    }
    if (!vals.length) return NaN;
    var y = log10(usd);
    if (y <= log10(vals[0])) return clamp(pcts[0], QUANTILE_MIN, QUANTILE_MAX);
    for (i = 1; i < vals.length; i++) {
      var loY = log10(vals[i - 1]), hiY = log10(vals[i]);
      if (y <= hiY) {
        var span = hiY - loY, w = span > 0 ? (y - loY) / span : 0;
        return clamp(pcts[i - 1] + w * (pcts[i] - pcts[i - 1]), QUANTILE_MIN, QUANTILE_MAX);
      }
    }
    return clamp(pcts[pcts.length - 1], QUANTILE_MIN, QUANTILE_MAX);
  }

  function updateTooltip(ms, pricePt, px) {
    if (!els.tip) return;
    var rows = am().tipRows(ms, pricePt);

    els.tip.innerHTML = rows.join("");
    els.tip.style.display = "block";
    // position: flip to the left of the cursor near the right edge
    var tw = els.tip.offsetWidth, wrapW = els.wrap.clientWidth;
    var left = px + 16;
    if (left + tw > wrapW - 4) left = px - tw - 16;
    if (left < 4) left = 4;
    var top = clamp(hover.y - 10, G.mt, G.mt + G.mh - els.tip.offsetHeight - 4);
    els.tip.style.left = left + "px";
    els.tip.style.top = top + "px";
  }
  // tooltip row (all values are locally-formatted numbers/dates — no injection)
  function row(k, v, color) {
    return '<div class="pltip-row"><span class="pltip-k">' + k + '</span>' +
      '<span class="pltip-v" style="color:' + color + '">' + v + '</span></div>';
  }
  function hideTooltip() { if (els && els.tip) els.tip.style.display = "none"; }

  // =========================================================================
  //  OSCILLATOR  (price / trend ratio, log scale)
  // =========================================================================
  function drawOsc() {
    var ctx = els.octx;
    var W = els.osc.clientWidth, H = els.osc.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (!model) return;
    // Guides: the 1.0x trend line plus every VISIBLE percentile line. With parallel
    // offsets a percentile sits at a constant multiple (10^offset), so its guide is
    // a flat line; with separately-sloped quantile-regression lines the ratio moves
    // with x, so the guide becomes a per-x CURVE (rearranged band value / trend).
    var A = am();
    oscLabelYs = null;   // label collision list; the Refraction guides opt in
    oscGuide(ctx, 1, "rgba(236,236,236,0.4)", []);
    A.oscGuides(ctx);
    // ratio line, coloured green below 1 / red above 1
    ctx.save();
    ctx.beginPath(); ctx.rect(G.ml, G.ot, G.mw, G.oh); ctx.clip();
    ctx.lineWidth = 1.4;
    var prev = null;
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t < view.min - DAY) { prev = p; continue; }
      if (p.t > view.max + DAY) break;
      var r = p.v / A.centerAt(p.t);
      var x = xToPx(p.t), y = oscToPx(r);
      if (prev) {
        var pr = prev.v / A.centerAt(prev.t);
        var mid = (r + pr) / 2;
        ctx.strokeStyle = mid >= 1 ? C.oscDown : C.oscUp;
        ctx.beginPath(); ctx.moveTo(xToPx(prev.t), oscToPx(pr)); ctx.lineTo(x, y); ctx.stroke();
      }
      prev = p;
    }
    ctx.restore();
    // shared crosshair x
    if (hover) {
      var hx = clamp(hover.x, G.ml, G.ml + G.mw);
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = C.cross; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, G.ot); ctx.lineTo(hx, G.ot + G.oh); ctx.stroke(); ctx.restore();
    }
  }

  // One flat oscillator guide at ratio r, labelled in the left gutter.
  function oscGuide(ctx, r, col, dash) {
    var gy = oscToPx(r);
    if (gy < G.ot || gy > G.ot + G.oh) return;
    ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(G.ml, gy); ctx.lineTo(G.ml + G.mw, gy); ctx.stroke(); ctx.restore();
    ctx.fillStyle = col; ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(r === 1 ? "1.0x" : (trimNum(r) + "x"), G.ml - 6, gy);
  }

  // One oscillator guide CURVE for a separately-sloped percentile line: its
  // rearranged band value divided by the trend, sampled at ~2px across the plot
  // width and clipped to the oscillator rect. The gutter label shows the ratio at
  // the left edge of the view, since it is no longer a single number.
  function oscCurve(ctx, bl) {
    var step = 2, started = false, px, ms, y;
    ctx.save();
    ctx.beginPath(); ctx.rect(G.ml, G.ot, G.mw, G.oh); ctx.clip();
    ctx.setLineDash(bl.dash); ctx.strokeStyle = bl.color; ctx.lineWidth = 1;
    ctx.beginPath();
    var A = am();
    for (px = G.ml; px <= G.ml + G.mw + 0.01; px += step) {
      ms = pxToMs(px);
      y = oscToPx(A.valueAt(ms, bl.off) / A.centerAt(ms));
      if (!isFinite(y)) { started = false; continue; }
      if (!started) { ctx.moveTo(px, y); started = true; } else { ctx.lineTo(px, y); }
    }
    ctx.stroke();
    ctx.restore();
    var msL = pxToMs(G.ml);
    var r0 = A.valueAt(msL, bl.off) / A.centerAt(msL);
    var ly = oscToPx(r0);
    if (!isFinite(ly) || ly < G.ot || ly > G.ot + G.oh) return;
    if (oscLabelYs) {
      for (var li = 0; li < oscLabelYs.length; li++) if (Math.abs(oscLabelYs[li] - ly) < 10) return;
      oscLabelYs.push(ly);
    }
    ctx.fillStyle = bl.color; ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(trimNum(r0) + "x", G.ml - 6, ly);
  }

  // =========================================================================
  //  INTERACTION
  // =========================================================================
  function localPt(ev) {
    var rect = els.main.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function inPlot(pt) {
    return pt.x >= G.ml && pt.x <= G.ml + G.mw && pt.y >= G.mt && pt.y <= G.mt + G.mh;
  }

  function setCursor(name) { if (els && els.main && els.main.style) els.main.style.cursor = name; }

  // Start a gesture at plot-x x. Shift held selects a range to zoom into;
  // otherwise it is a pan that carries the view along with the
  // pointer. A pan snapshots the view at grab time so every move recomputes from a
  // stable origin (no accumulation drift) and can bail out cleanly under ~4px.
  function beginDrag(x, shift) {
    hover = null; hideTooltip();
    if (shift) {
      drag = { mode: "zoom", x0: x, x1: x };
      setCursor("crosshair");
    } else {
      drag = { mode: "pan", x0: x, x1: x, view0: { min: view.min, max: view.max }, panned: false };
      setCursor("grabbing");
    }
  }

  // Pan window derived from the grab-time view0 shifted by dpx pixels. The point
  // grabbed under the cursor stays under the cursor. date mode shifts by the
  // pixel->ms scale; log-days mode shifts in log10(days) space. Clamped to the full
  // domain [data start, Dec 31 projectionEndYear] WITHOUT changing the span.
  function panFrom(view0, dpx) {
    if (prefs.xMode === "logDays") {
      var loL = log10(daysCont(view0.min)), hiL = log10(daysCont(view0.max));
      var span = hiL - loL;
      var dL = dpx / G.mw * span;                 // pixels -> log-day units
      var nLo = loL - dL, nHi = hiL - dL;          // drag right reveals earlier days
      var limLo = log10(daysCont(fullMin)), limHi = log10(daysCont(fullMax));
      if (nLo < limLo) { nLo = limLo; nHi = limLo + span; }
      if (nHi > limHi) { nHi = limHi; nLo = limHi - span; }
      return { min: GENESIS + Math.pow(10, nLo) * DAY, max: GENESIS + Math.pow(10, nHi) * DAY };
    }
    var mspan = view0.max - view0.min;
    var dms = dpx / G.mw * mspan;                  // pixels -> ms
    var a = view0.min - dms, b = view0.max - dms;   // drag right reveals earlier time
    if (a < fullMin) { a = fullMin; b = fullMin + mspan; }
    if (b > fullMax) { b = fullMax; a = fullMax - mspan; }
    return { min: a, max: b };
  }

  // Apply a pan for the pointer now at plot-x x. Movement under ~4px is left as a
  // click (no view change, no preset clear) so genuine double-click resets aren't
  // broken by micro-jitter; once the threshold is crossed the pan clears the active
  // preset chip exactly once (existing onPresetCleared) and tracks the pointer.
  function applyPan(x) {
    var dpx = x - drag.x0;
    if (!drag.panned) {
      if (Math.abs(dpx) < 4) return;
      drag.panned = true;
      if (onPresetCleared) onPresetCleared();
    }
    view = panFrom(drag.view0, dpx);
  }

  function onMove(ev) {
    var pt = localPt(ev);
    if (drag) {
      drag.x1 = pt.x;
      if (drag.mode === "pan") applyPan(pt.x);
      scheduleDraw();
      return;
    }
    if (inPlot(pt)) { hover = pt; scheduleDraw(); }
    else if (hover) { hover = null; hideTooltip(); scheduleDraw(); }
  }
  function onLeave() {
    // A pan continues even if the pointer briefly leaves the plot; the window-level
    // mouseup finalises it. A zoom selection or plain hover is cleared on leave.
    if (drag && drag.mode === "pan") return;
    if (hover || drag) { hover = null; drag = null; hideTooltip(); scheduleDraw(); }
  }
  function onDown(ev) {
    var pt = localPt(ev);
    if (!inPlot(pt)) return;
    beginDrag(pt.x, !!ev.shiftKey);
    ev.preventDefault();
  }
  function onUp() {
    if (!drag) return;
    var d = drag;
    drag = null;
    setCursor("grab");
    if (d.mode === "zoom") {
      var x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      if ((x1 - x0) > 4) {
        var a = pxToMs(clamp(x0, G.ml, G.ml + G.mw));
        var b = pxToMs(clamp(x1, G.ml, G.ml + G.mw));
        setView(a, b, true);
        return;
      }
    }
    scheduleDraw();
  }
  // Single-finger touch drag pans (pinch-zoom is out of scope this round).
  function touchLocal(t) {
    var rect = els.main.getBoundingClientRect();
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function onTouchStart(ev) {
    if (!ev.touches || ev.touches.length !== 1) { drag = null; return; }
    var pt = touchLocal(ev.touches[0]);
    if (!inPlot(pt)) return;
    beginDrag(pt.x, false);
    ev.preventDefault();
  }
  function onTouchMove(ev) {
    if (!drag || drag.mode !== "pan") return;
    if (!ev.touches || ev.touches.length !== 1) return;
    var pt = touchLocal(ev.touches[0]);
    drag.x1 = pt.x;
    applyPan(pt.x);
    scheduleDraw();
    ev.preventDefault();
  }
  function onTouchEnd() {
    if (!drag) return;
    drag = null;
    setCursor("grab");
    scheduleDraw();
  }
  function onWheel(ev) {
    var pt = localPt(ev);
    if (!inPlot(pt)) return;
    ev.preventDefault();
    var anchor = pxToMs(pt.x);
    var factor = Math.pow(1.0015, ev.deltaY);   // >1 zooms out, <1 zooms in
    var lo = anchor - (anchor - view.min) * factor;
    var hi = anchor + (view.max - anchor) * factor;
    setView(lo, hi, true);
  }
  function onDbl() { setPreset(prefs.preset || "full"); }

  // apply a new view window, clamped to the full domain and a minimum span
  function setView(a, b, userDriven) {
    if (a > b) { var tmp = a; a = b; b = tmp; }
    var minSpan = 7 * DAY;
    if (b - a < minSpan) { var c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
    a = clamp(a, fullMin, fullMax - minSpan);
    b = clamp(b, fullMin + minSpan, fullMax);
    view = { min: a, max: b };
    if (userDriven && onPresetCleared) onPresetCleared();
    scheduleDraw();
  }

  // =========================================================================
  //  PUBLIC API (called by app.js)
  // =========================================================================
  function mount(opts) {
    els = {
      main: opts.canvas, mctx: opts.canvas.getContext("2d"),
      osc: opts.osc, octx: opts.osc ? opts.osc.getContext("2d") : null,
      tip: opts.tip, wrap: opts.wrap, oscWrap: opts.oscWrap
    };
    onPresetCleared = opts.onPresetCleared || null;
    els.main.addEventListener("mousemove", onMove);
    els.main.addEventListener("mouseleave", onLeave);
    els.main.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    els.main.addEventListener("wheel", onWheel, { passive: false });
    els.main.addEventListener("dblclick", onDbl);
    els.main.addEventListener("touchstart", onTouchStart, { passive: false });
    els.main.addEventListener("touchmove", onTouchMove, { passive: false });
    els.main.addEventListener("touchend", onTouchEnd);
    els.main.addEventListener("touchcancel", onTouchEnd);
    setCursor("grab");
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { scheduleDraw(); });
      ro.observe(els.wrap);
      if (els.oscWrap) ro.observe(els.oscWrap);
    }
    window.addEventListener("resize", scheduleDraw);
    scheduleDraw();
  }

  // Quantile-regression band lines (v0.1.6): thirteen {a,n} pairs, one per ladder
  // key. Adopted ONLY when the fit declares bandMode=quantileRegression and carries
  // at least one finite line; a stale record (mode set, lines missing or garbage)
  // returns null so the parallel bandOffsets path renders instead.
  function readBandLines(m) {
    if (!m || m.bandMode !== "quantileRegression" || !m.bandLines) return null;
    var out = {}, any = false, i, ln;
    for (i = 0; i < QR_LADDER.length; i++) {
      ln = m.bandLines[QR_LADDER[i]];
      if (!ln || typeof ln.a !== "number" || !isFinite(ln.a)) continue;
      if (typeof ln.n !== "number" || !isFinite(ln.n)) continue;
      out[QR_LADDER[i]] = { a: ln.a, n: ln.n };
      any = true;
    }
    return any ? out : null;
  }

  function setModel(m) {
    // The Refraction fit rides on the same payload (v0.2.0); a missing or damaged
    // block leaves rf null, which keeps the chart in power-law mode.
    rf = m ? RF.readFit(m.refraction) : null;
    rfResetCache();
    if (!m) { model = null; scheduleDraw(); return; }
    var off = m.bandOffsets || {};
    // Carry all thirteen offsets; the newer keys may be undefined on old fits and
    // every drawing path guards on linePresent() before touching them.
    model = {
      a: m.a, n: m.n,
      off: {
        p0001: off.p0001, p005: off.p005, p025: off.p025, p10: off.p10, p165: off.p165,
        p25: off.p25, p50: off.p50, p75: off.p75, p835: off.p835,
        p90: off.p90, p975: off.p975, p995: off.p995, p9999: off.p9999
      },
      lines: readBandLines(m),
      bandMode: m.bandMode,
      projEnd: (m.projection && m.projection.endYear) || 2045,
      caution: (m.projection && m.projection.cautionAfterYear) || 2040
    };
    fullMax = Date.UTC(model.projEnd, 11, 31);
    if (m.sample && m.sample.start) fullMin = Math.min(fullMin, parseDay(m.sample.start));
    // if the current preset spans the full domain, re-anchor its end
    if (prefs.preset === "full") view = { min: fullMin, max: fullMax };
    else clampViewToDomain();
    scheduleDraw();
  }

  function setPrices(p) {
    prices = [];
    provisional = null;
    var pts = (p && p.points) || [];
    for (var i = 0; i < pts.length; i++) {
      var row = pts[i];
      var rec = { t: parseDay(row[0]), v: row[1], flag: row[2] || 0 };
      prices.push(rec);
      if (rec.flag === 1) provisional = rec;
    }
    prices.sort(function (x, y) { return x.t - y.t; });
    if (prices.length) {
      priceStart = prices[0].t;
      priceEnd = prices[prices.length - 1].t;
      fullMin = Math.min(fullMin, priceStart);
      if (prefs.preset === "full") view = { min: fullMin, max: fullMax };
    }
    scheduleDraw();
  }

  function setSpot(s) { spot = s || null; }

  function setPrefs(next) {
    var presetChanged = next.preset !== undefined && next.preset !== prefs.preset;
    for (var k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      if ((k === "bands" || k === "rfLines") && next[k] && typeof next[k] === "object") {
        // merge onto the existing per-line visibility map rather than replacing it
        var nb = {}, cur = prefs[k] || {};
        for (var bk in cur) { if (Object.prototype.hasOwnProperty.call(cur, bk)) nb[bk] = cur[bk]; }
        for (var bk2 in next[k]) { if (Object.prototype.hasOwnProperty.call(next[k], bk2)) nb[bk2] = next[k][bk2]; }
        prefs[k] = nb;
      } else {
        prefs[k] = next[k];
      }
    }
    if (presetChanged && prefs.preset) applyPreset(prefs.preset);
    scheduleDraw();
  }

  function setPreset(name) {
    prefs.preset = name;
    applyPreset(name);
    scheduleDraw();
  }

  function applyPreset(name) {
    todayMs = utcMidnight(Date.now());
    if (name === "full") { view = { min: fullMin, max: fullMax }; }
    else if (name === "history") { view = { min: fullMin, max: Math.max(todayMs, fullMin + DAY) }; }
    else if (name === "4y") { view = { min: todayMs - Math.round(4 * 365.25 * DAY), max: todayMs }; }
    else if (name === "1y") { view = { min: todayMs - 365 * DAY, max: todayMs }; }
    else if (name === "6m") { view = { min: todayMs - 182 * DAY, max: todayMs }; }
    clampViewToDomain();
  }
  function clampViewToDomain() {
    var minSpan = 7 * DAY;
    var a = clamp(view.min, fullMin, fullMax - minSpan);
    var b = clamp(view.max, a + minSpan, fullMax);
    view = { min: a, max: b };
  }

  function resize() { scheduleDraw(); }

  // /api/heights payload (dense daily array) for the Refraction date -> height map.
  function setHeights(api) { hm = RF.heightMap(api); rfResetCache(); scheduleDraw(); }
  // The current height and the time it describes ({ h, ms, live } or null): later
  // days are projected from it at 144 blocks/day (the page's one height rule). The
  // column cache is dropped only when the day or the height actually changes.
  function setNow(n) {
    var next = (n && n.h > 0 && isFinite(n.h) && isFinite(n.ms)) ? { h: n.h, ms: n.ms, live: n.live === true } : null;
    var same = next && rfNowRef && next.h === rfNowRef.h && next.live === rfNowRef.live &&
      Math.floor(next.ms / DAY) === Math.floor(rfNowRef.ms / DAY);
    if (same || (!next && !rfNowRef)) return;
    rfNowRef = next;
    rfResetCache();
    scheduleDraw();
  }
  // "powerLaw" | "refraction". Honoured only while the fit and the heights exist
  // (rfOn()); otherwise the power-law drawing stays in place.
  function setMode(name) {
    mode = name === "refraction" ? "refraction" : "powerLaw";
    hover = null; hideTooltip();
    scheduleDraw();
  }
  // Test hook (U5): evaluate every Refraction value afresh instead of through the
  // per-frame column cache, so a test can prove the cache changes no draw call.
  function columnCache(on) { rfCacheOn = on !== false; rfResetCache(); scheduleDraw(); }

  window.PLChart = {
    mount: mount,
    setModel: setModel,
    setPrices: setPrices,
    setSpot: setSpot,
    setPrefs: setPrefs,
    setPreset: setPreset,
    resize: resize,
    redraw: scheduleDraw,
    setHeights: setHeights,
    setNow: setNow,
    setMode: setMode,
    _columnCache: columnCache,
    fmtUSD: fmtUSD
  };
})();
`;
