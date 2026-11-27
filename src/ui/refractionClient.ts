// Client-side Refraction model maths (v0.2.0, spec 6.2), written ONCE as an ES5
// snippet and concatenated into BOTH browser scripts — CHART_JS (drawing) and
// APP_JS (readouts, tables, CSV, milestones) — so the chart and the tables can
// never disagree about what a line is worth at a date.
//
// It is a faithful mirror of the pure evaluators in src/refraction.ts (decayAt,
// anchorLogAt, offsetAt, linePriceAt, percentileOf, projectHeight); the test
// src/ui.refraction.test.ts runs these functions against the engine on the same
// fit and asserts agreement to 1e-9 relative. Change one, change the other.
//
// Nothing here is a fitted number. The constants are the model-definition ones the
// spec allows in code (2.1): 144 blocks/day for projection, the anchor percentile
// (5), the tanh height scale (200000) and the drawn ladder. Every coefficient
// comes from /api/model.refraction at run time.
//
// ONE height rule for the whole page (review U9). The dense daily array of
// /api/heights gives stored days (index i = start day + i, value = chain height at
// the end of that UTC day). Any later day is "now" (the status block's current
// height, when the caller passes it) plus 144 blocks per whole calendar day from
// today; without a "now" it is the last stored height plus 144 per day (the
// engine's projectHeight). Such heights are marked est; one that falls on a day
// before today ("past" and est) is a gap in the stored series, which the page
// shows as estimated and never uses for a judgement (the actual-close tint, the
// floor-breach chip). Before the first stored day — or on a stored day whose
// height is 0, before the chain had a block beyond genesis — there is no model.
//
// The ladder (review U11): LINES below is the one list of the Refraction lines on
// the page, with each line's key, label and style; the chart, the legend logic,
// the tables and the CSV all derive their lists from it.
//
// Template-literal safety: String.raw literal, ES5 only (var, function
// expressions, "+" concatenation), NO backticks and NO dollar-brace runs.
//
// Marker: PLREFRACTION_MATH

export const REFRACTION_JS: string = String.raw`/* PLREFRACTION_MATH */
var RF = (function () {
  var DAY = 86400000;
  var BLOCKS_PER_DAY = 144;      // protocol target rate, used only to project forward
  var ANCHOR_PCT = 5;            // the anchor IS the 5th-percentile line (offset 0)
  var DECAY_SCALE = 200000;      // S(h) = 1 - tanh(c*h/200000)^alpha
  var S_FLOOR = 1e-12;           // below this every upper line has collapsed onto the anchor
  var PCT_MIN = 0.1, PCT_MAX = 99.9;
  var TIP_FRESH_MS = 3 * 3600000; // same freshness rule as the server's heightNow()
  // The lines the dashboard draws, ascending (mirrors REFRACTION_LADDER): key (the
  // legend / pref id), short name, colour (cool floor -> hot top on the dark theme;
  // the 50% fair value keeps the power-law Trend's near-white), dash, width (the
  // fair value has the Trend's weight), def = visible by default, yt = a column of
  // the on-screen year-end table.
  var LINES = [
    { p: 0.1, key: "r01", name: "floor", color: "#A78BFA", dash: [], w: 1.5, def: true, yt: true },
    { p: 1, key: "r1", name: "", color: "#818CF8", dash: [5, 3], w: 1.3, def: false, yt: false },
    { p: 5, key: "r5", name: "anchor", color: "#60A5FA", dash: [], w: 1.6, def: true, yt: true },
    { p: 15, key: "r15", name: "", color: "#38BDF8", dash: [5, 3], w: 1.3, def: false, yt: false },
    { p: 25, key: "r25", name: "", color: "#5EEAD4", dash: [5, 3], w: 1.3, def: false, yt: false },
    { p: 50, key: "r50", name: "fair value", color: "#ECECEC", dash: [], w: 2, def: true, yt: true },
    { p: 75, key: "r75", name: "", color: "#F5D547", dash: [5, 3], w: 1.3, def: false, yt: true },
    { p: 95, key: "r95", name: "", color: "#FF9F43", dash: [5, 3], w: 1.3, def: true, yt: true },
    { p: 99.9, key: "r999", name: "top", color: "#FF5C7A", dash: [], w: 1.5, def: true, yt: true }
  ];
  var LADDER = [];
  (function () { for (var i = 0; i < LINES.length; i++) LADDER.push(LINES[i].p); })();

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  // Native log10/tanh where the browser has them (every current one does), so the
  // client agrees with the engine to the last few ulps; ES5 fallbacks otherwise.
  var log10 = Math.log10 ? function (x) { return Math.log10(x); } : function (x) { return Math.log(x) / Math.LN10; };
  var tanh = Math.tanh ? function (x) { return Math.tanh(x); } : function (x) {
    if (x > 20) return 1;
    if (x < -20) return -1;
    var e = Math.exp(2 * x);
    return (e - 1) / (e + 1);
  };

  // Validate and copy a /api/model.refraction block. null when anything the
  // evaluators need is missing or not finite, so a stale or damaged record can
  // never reach the drawing code (the page then stays in power-law mode).
  function readFit(r) {
    if (!r || typeof r !== "object") return null;
    if (!isNum(r.b0) || !isNum(r.b1) || !isNum(r.c) || !isNum(r.alpha)) return null;
    var ps = r.gridPcts, os = r.gridOffsets;
    if (!ps || !os || typeof ps.length !== "number" || ps.length < 2 || os.length !== ps.length) return null;
    var cp = [], co = [], i;
    for (i = 0; i < ps.length; i++) {
      if (!isNum(ps[i]) || !isNum(os[i])) return null;
      if (i > 0 && !(ps[i] > ps[i - 1])) return null;
      cp.push(ps[i]); co.push(os[i]);
    }
    return {
      b0: r.b0, b1: r.b1, c: r.c, alpha: r.alpha, gridPcts: cp, gridOffsets: co,
      points: isNum(r.points) ? r.points : null,
      dataStart: typeof r.dataStart === "string" ? r.dataStart : "",
      dataEnd: typeof r.dataEnd === "string" ? r.dataEnd : "",
      lastHeight: isNum(r.lastHeight) ? r.lastHeight : null,
      priceSeries: r.priceSeries === "canonical" ? "canonical" : "coinmetrics"
    };
  }

  // ---- evaluators (mirror src/refraction.ts) ------------------------------
  function decayAt(c, alpha, h) {
    return 1 - Math.pow(tanh((c * h) / DECAY_SCALE), alpha);
  }
  function anchorLogAt(fit, h) {
    return fit.b0 + fit.b1 * log10(h);
  }
  // Offset of line pct: linear in pct between grid points, clamped to the ends.
  function offsetAt(fit, pct) {
    var ps = fit.gridPcts, os = fit.gridOffsets;
    var m = Math.min(ps.length, os.length);
    if (m === 0 || !isNum(pct)) return NaN;
    if (pct <= ps[0]) return os[0];
    if (pct >= ps[m - 1]) return os[m - 1];
    for (var i = 1; i < m; i++) {
      var p1 = ps[i];
      if (pct <= p1) {
        var p0 = ps[i - 1], o0 = os[i - 1], o1 = os[i];
        if (pct === p1) return o1;
        return o0 + ((pct - p0) / (p1 - p0)) * (o1 - o0);
      }
    }
    return os[m - 1];
  }
  // Price of the pct line at height h: lines above the anchor bend toward it by
  // S(h); lines at or below it are parallel. NaN on a bad height or percentile.
  function linePriceAt(fit, pct, h) {
    if (!(h > 0) || !isNum(h) || !isNum(pct)) return NaN;
    var la = anchorLogAt(fit, h);
    var off = offsetAt(fit, pct);
    var lg = pct > ANCHOR_PCT ? la + off * decayAt(fit.c, fit.alpha, h) : la + off;
    return Math.pow(10, lg);
  }
  function invertGrid(ps, os, from, to, v) {
    if (v <= os[from]) return ps[from];
    if (v >= os[to]) return ps[to];
    for (var i = from + 1; i <= to; i++) {
      var o1 = os[i];
      if (o1 >= v) {
        if (o1 === v) {
          var j = i;
          while (j > from && os[j - 1] === v) j--;
          return ps[j];
        }
        var o0 = os[i - 1], p0 = ps[i - 1], p1 = ps[i];
        return p0 + ((v - o0) / (o1 - o0)) * (p1 - p0);
      }
    }
    return ps[to];
  }
  // Percentile of a price at height h by inverting the stored grid, clamped to
  // [0.1, 99.9]; NaN on bad input. This is the engine's percentileOf: linear
  // between grid points, so it is only an approximation of the exact inverse the
  // server computes against the fit's own closes — close where the grid is dense,
  // but off by a few tenths of a point in sparse gaps (e.g. 1.5 vs 1.3 between the
  // 1% and 2% points). The page labels every value from here with "≈".
  function percentileOf(fit, h, usd) {
    if (!(h > 0) || !(usd > 0) || !isNum(h) || !isNum(usd)) return NaN;
    var ps = fit.gridPcts, os = fit.gridOffsets;
    var m = Math.min(ps.length, os.length);
    if (m === 0) return NaN;
    var r0 = log10(usd) - anchorLogAt(fit, h);
    if (!isNum(r0)) return NaN;
    var lastBelow = -1, firstAbove = m, i;
    for (i = 0; i < m; i++) {
      if (ps[i] <= ANCHOR_PCT) lastBelow = i;
      if (ps[i] >= ANCHOR_PCT && firstAbove === m) firstAbove = i;
    }
    var pct;
    if (r0 < 0 || firstAbove === m) {
      pct = lastBelow < 0 ? ps[0] : invertGrid(ps, os, 0, lastBelow, r0);
    } else {
      var s = decayAt(fit.c, fit.alpha, h);
      if (!(s >= S_FLOOR)) pct = ps[m - 1];
      else pct = invertGrid(ps, os, firstAbove, m - 1, r0 / s);
    }
    return Math.min(PCT_MAX, Math.max(PCT_MIN, pct));
  }

  // ---- date -> height ------------------------------------------------------
  // ms of 00:00 UTC on a strict YYYY-MM-DD date (round-trip checked), else NaN.
  function dayMs(s) {
    var mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
    if (!mm) return NaN;
    var y = +mm[1], mo = +mm[2], d = +mm[3];
    var ms = Date.UTC(y, mo - 1, d);
    var back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
    return ms;
  }
  // Read /api/heights into a lookup: { start, h[], n, lastH, lastMs, tip }.
  // null when the payload is missing, malformed, or ends on a non-positive height.
  function heightMap(api) {
    if (!api || typeof api !== "object" || !api.heights || typeof api.heights.length !== "number") return null;
    var start = dayMs(api.start);
    var n = api.heights.length;
    if (!isNum(start) || n < 1) return null;
    var h = new Array(n), i;
    for (i = 0; i < n; i++) h[i] = isNum(api.heights[i]) ? api.heights[i] : NaN;
    var lastH = h[n - 1];
    if (!(lastH > 0)) return null;
    var tip = (api.tip && isNum(api.tip.height) && api.tip.height > 0) ? { height: api.tip.height, at: api.tip.at } : null;
    return { start: start, h: h, n: n, lastH: lastH, lastMs: start + (n - 1) * DAY, tip: tip };
  }
  // Height for the UTC day containing ms under the page's one height rule:
  // { h, est, past }. now = { h, ms, live } is the current height (the status
  // block's heightNow) and the time it describes; omit it to project from the last
  // stored day. est: the height is not a stored one (today counts as not est only
  // when now.live). past: the day is before today (needs now.ms). null before the
  // series or on a stored day with no positive height.
  function heightInfo(hm, ms, now) {
    if (!hm || !isNum(ms)) return null;
    var d = Math.floor((ms - hm.start) / DAY);
    if (d < 0) return null;
    if (d < hm.n) { var v = hm.h[d]; return v > 0 ? { h: v, est: false, past: true } : null; }
    var today = (now && isNum(now.ms)) ? Math.floor((now.ms - hm.start) / DAY) : NaN;
    var past = isNum(today) && d < today;
    if (now && isNum(now.h) && now.h > 0 && isNum(today)) {
      // never below the last stored height (a stale "now" cannot run backwards)
      var h = Math.max(hm.lastH, now.h + BLOCKS_PER_DAY * (d - today));
      return { h: h, est: !(d === today && now.live === true), past: past };
    }
    return { h: hm.lastH + BLOCKS_PER_DAY * (d - (hm.n - 1)), est: true, past: past };
  }
  // Same, as a bare number (NaN = no model), for the per-pixel drawing paths.
  function heightAt(hm, ms, now) {
    var hi = heightInfo(hm, ms, now);
    return hi ? hi.h : NaN;
  }
  // The height "now" when the server's status block is unavailable: a live tip
  // observed within 3 hours, else the last stored day projected from its END at
  // 144 blocks per (fractional) day — the server's heightNow() rule.
  function heightNow(hm, nowMs) {
    if (!hm) return null;
    if (hm.tip) {
      var at = Date.parse(hm.tip.at);
      if (isNum(at) && nowMs - at <= TIP_FRESH_MS && nowMs >= at - 60000) return { h: hm.tip.height, est: false };
    }
    var elapsed = Math.max(0, (nowMs - (hm.lastMs + DAY)) / DAY);
    return { h: Math.round(hm.lastH + BLOCKS_PER_DAY * elapsed), est: true };
  }
  // The first UTC day in [fromMs, toMs] on which the pct line is at or above usd,
  // scanned day by day (the line is not a closed-form function of the date, and a
  // daily scan over a century is only ~36k evaluations). null when it never does.
  function crossingDay(fit, hm, pct, usd, fromMs, toMs, now) {
    var d0 = Math.max(fromMs, hm ? hm.start : fromMs);
    for (var ms = d0; ms <= toMs; ms += DAY) {
      var v = linePriceAt(fit, pct, heightAt(hm, ms, now));
      if (v >= usd) return ms;
    }
    return null;
  }

  return {
    LINES: LINES, LADDER: LADDER,
    readFit: readFit, decayAt: decayAt, anchorLogAt: anchorLogAt, offsetAt: offsetAt,
    linePriceAt: linePriceAt, percentileOf: percentileOf,
    dayMs: dayMs, heightMap: heightMap, heightInfo: heightInfo, heightAt: heightAt,
    heightNow: heightNow, crossingDay: crossingDay
  };
})();
`;
