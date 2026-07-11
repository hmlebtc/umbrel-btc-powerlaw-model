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
// The trend and the four percentile bands are re-sampled at ~2px resolution
// across the FULL domain (data start -> Dec 31 of projectionEndYear) so the
// curves stay smooth in any x/y mode and under any zoom.
//
// Marker: PLCHART_ENGINE

export const CHART_JS: string = String.raw`/* PLCHART_ENGINE */
"use strict";
(function () {
  // ---- constants ----------------------------------------------------------
  var GENESIS = Date.UTC(2009, 0, 3);   // power-law epoch; t = days since this
  var DAY = 86400000;
  var LN10 = Math.LN10;

  // porkopolis palette on dark background (spec section 8)
  var C = {
    price: "#42A04C",          // BTC price line
    priceDim: "rgba(66,160,76,0.55)",
    trend: "#ECECEC",          // power-regression trend
    outer: "#F44336",          // p97.5 / p2.5 bands (red, dotted)
    inner: "#03A9F4",          // p83.5 / p16.5 bands (blue, dotted)
    outerFill: "rgba(244,67,54,0.06)",
    innerFill: "rgba(3,169,244,0.06)",
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

  // ---- math helpers -------------------------------------------------------
  function log10(x) { return Math.log(x) / LN10; }
  // continuous days-since-genesis (clamped to >=1 so log10(t) is defined)
  function daysCont(ms) { var d = (ms - GENESIS) / DAY; return d < 1 ? 1 : d; }
  function dayIndex(ms) { return Math.floor((ms - GENESIS) / DAY); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---- controller state ---------------------------------------------------
  var els = null;            // { main, mctx, osc, octx, tip, wrap, oscWrap }
  var model = null;          // { a, n, off:{p025,p165,p835,p975}, projEnd, caution, bandMode }
  var prices = [];           // [{ t:ms, v:usd, flag:0|1 }] sorted by t
  var priceStart = null, priceEnd = null, provisional = null;
  var spot = null;           // { usd, at } — optional marker at today
  var prefs = { xMode: "date", yMode: "log", bandFill: false, halvings: true, oscillator: true, preset: "full" };
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
  var drag = null;           // { x0, x1 } during a drag-zoom selection
  var rafPending = false;

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
  // Y: "log" (linear in log10 price) or "linear".
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

  // =========================================================================
  //  AUTOSCALE — choose the price y-domain that fits the current view
  // =========================================================================
  // Sample the outer bands (p025 low, p975 high) plus any visible price points
  // across the view, then pad in the active space (log or linear).
  function autoscaleY() {
    if (!model) { yDom = { min: 1, max: 1e6 }; return; }
    var lo = Infinity, hi = -Infinity, i;
    var N = 100;
    for (i = 0; i <= N; i++) {
      var ms = view.min + (view.max - view.min) * (i / N);
      var low = bandAt(ms, model.off.p025);
      var high = bandAt(ms, model.off.p975);
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
    // ratio domain wide enough for the band multipliers and the data
    var lo = model ? Math.pow(10, model.off.p025) : 0.3;
    var hi = model ? Math.pow(10, model.off.p975) : 3;
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t < view.min || p.t > view.max) continue;
      var r = p.v / trendAt(p.t);
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
    if (prefs.bandFill) drawBandFills(ctx);
    drawBands(ctx);
    drawTrend(ctx);
    drawPrice(ctx);
    drawTodayLine(ctx);
    if (prefs.halvings) drawHalvings(ctx);
    ctx.restore();

    drawCaution(ctx);   // dim hatch over the >caution-year region (over data)
    drawAxisLabels(ctx);
    if (hover) drawCrosshair(ctx);
    if (drag) drawDragRect(ctx);
  }

  function placeholder(ctx, msg) {
    ctx.fillStyle = C.axis;
    ctx.font = "13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, G.ml + G.mw / 2, G.mt + G.mh / 2);
  }

  // ---- grid + y/x tick computation ----------------------------------------
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

  function drawBands(ctx) {
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 3]);
    // inner pair (blue): p835, p165
    ctx.strokeStyle = C.inner;
    samplePath(ctx, function (ms) { return bandAt(ms, model.off.p835); }); ctx.stroke();
    samplePath(ctx, function (ms) { return bandAt(ms, model.off.p165); }); ctx.stroke();
    // outer pair (red): p975, p025
    ctx.strokeStyle = C.outer;
    samplePath(ctx, function (ms) { return bandAt(ms, model.off.p975); }); ctx.stroke();
    samplePath(ctx, function (ms) { return bandAt(ms, model.off.p025); }); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Optional translucent fills between the band pairs (default off).
  function drawBandFills(ctx) {
    fillBetween(ctx, model.off.p025, model.off.p975, C.outerFill);
    fillBetween(ctx, model.off.p165, model.off.p835, C.innerFill);
  }
  function fillBetween(ctx, offLo, offHi, color) {
    var step = 2, px;
    ctx.beginPath();
    for (px = G.ml; px <= G.ml + G.mw + 0.01; px += step) {
      var y = yToPx(bandAt(pxToMs(px), offHi));
      if (px === G.ml) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    for (px = G.ml + G.mw; px >= G.ml - 0.01; px -= step) {
      ctx.lineTo(px, yToPx(bandAt(pxToMs(px), offLo)));
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
    if (x0 < G.ml + G.mw - 60) ctx.fillText("beyond stated model validity (~" + model.caution + ")", x0 + 4, G.mt + 4);
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
    // a dot on the trend at the cursor
    var ty = yToPx(trendAt(ms));
    ctx.fillStyle = C.trend;
    ctx.beginPath(); ctx.arc(x, ty, 3, 0, Math.PI * 2); ctx.fill();
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

  // Estimate the residual quantile client-side by interpolating the four known
  // band anchors (offset -> percentile). Below/above the outer bands we ease
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

  function updateTooltip(ms, pricePt, px) {
    if (!els.tip) return;
    var tl = trendLogAt(ms), trend = Math.pow(10, tl);
    var rows = [];
    rows.push(row("Date", fmtDate(ms) + "  (t=" + dayIndex(ms) + ")", C.axis));
    if (pricePt) {
      var dev = (pricePt.v / trend - 1) * 100;
      var q = residualQuantile(log10(pricePt.v) - tl);
      rows.push(row("Price", fmtUSD(pricePt.v) + (pricePt.flag === 1 ? " (prov.)" : ""), C.price));
      rows.push(row("Deviation", (dev >= 0 ? "+" : "") + dev.toFixed(1) + "%", dev >= 0 ? C.outer : C.inner));
      rows.push(row("Quantile", q.toFixed(1) + "%", C.axis));
    }
    rows.push(row("Trend", fmtUSD(trend), C.trend));
    rows.push(row("97.5%", fmtUSD(bandAt(ms, model.off.p975)), C.outer));
    rows.push(row("83.5%", fmtUSD(bandAt(ms, model.off.p835)), C.inner));
    rows.push(row("16.5%", fmtUSD(bandAt(ms, model.off.p165)), C.inner));
    rows.push(row("2.5%", fmtUSD(bandAt(ms, model.off.p025)), C.outer));

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
    // guide lines: 1.0 and the four band multipliers
    var guides = [
      { r: 1, col: "rgba(236,236,236,0.4)", dash: [] },
      { r: Math.pow(10, model.off.p975), col: C.outer, dash: [2, 3] },
      { r: Math.pow(10, model.off.p835), col: C.inner, dash: [2, 3] },
      { r: Math.pow(10, model.off.p165), col: C.inner, dash: [2, 3] },
      { r: Math.pow(10, model.off.p025), col: C.outer, dash: [2, 3] }
    ];
    for (var g = 0; g < guides.length; g++) {
      var gy = oscToPx(guides[g].r);
      if (gy < G.ot || gy > G.ot + G.oh) continue;
      ctx.save(); ctx.setLineDash(guides[g].dash); ctx.strokeStyle = guides[g].col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(G.ml, gy); ctx.lineTo(G.ml + G.mw, gy); ctx.stroke(); ctx.restore();
      ctx.fillStyle = guides[g].col; ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(guides[g].r === 1 ? "1.0x" : (trimNum(guides[g].r) + "x"), G.ml - 6, gy);
    }
    // ratio line, coloured green below 1 / red above 1
    ctx.save();
    ctx.beginPath(); ctx.rect(G.ml, G.ot, G.mw, G.oh); ctx.clip();
    ctx.lineWidth = 1.4;
    var prev = null;
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.t < view.min - DAY) { prev = p; continue; }
      if (p.t > view.max + DAY) break;
      var r = p.v / trendAt(p.t);
      var x = xToPx(p.t), y = oscToPx(r);
      if (prev) {
        var pr = prev.v / trendAt(prev.t);
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

  function onMove(ev) {
    var pt = localPt(ev);
    if (drag) { drag.x1 = pt.x; scheduleDraw(); return; }
    if (inPlot(pt)) { hover = pt; scheduleDraw(); }
    else if (hover) { hover = null; hideTooltip(); scheduleDraw(); }
  }
  function onLeave() { if (hover || drag) { hover = null; drag = null; hideTooltip(); scheduleDraw(); } }
  function onDown(ev) {
    var pt = localPt(ev);
    if (!inPlot(pt)) return;
    drag = { x0: pt.x, x1: pt.x };
    ev.preventDefault();
  }
  function onUp(ev) {
    if (!drag) return;
    var x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
    var moved = (x1 - x0) > 4;
    drag = null;
    if (moved) {
      var a = pxToMs(clamp(x0, G.ml, G.ml + G.mw));
      var b = pxToMs(clamp(x1, G.ml, G.ml + G.mw));
      setView(a, b, true);
    } else { scheduleDraw(); }
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
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { scheduleDraw(); });
      ro.observe(els.wrap);
      if (els.oscWrap) ro.observe(els.oscWrap);
    }
    window.addEventListener("resize", scheduleDraw);
    scheduleDraw();
  }

  function setModel(m) {
    if (!m) { model = null; scheduleDraw(); return; }
    var off = m.bandOffsets || {};
    model = {
      a: m.a, n: m.n,
      off: { p025: off.p025, p165: off.p165, p835: off.p835, p975: off.p975 },
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
    for (var k in next) { if (Object.prototype.hasOwnProperty.call(next, k)) prefs[k] = next[k]; }
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

  window.PLChart = {
    mount: mount,
    setModel: setModel,
    setPrices: setPrices,
    setSpot: setSpot,
    setPrefs: setPrefs,
    setPreset: setPreset,
    resize: resize,
    redraw: scheduleDraw,
    fmtUSD: fmtUSD
  };
})();
`;
