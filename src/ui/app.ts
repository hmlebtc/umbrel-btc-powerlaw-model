// Dashboard application logic for the BTC Power Law Model.
//
// Exported as a JS *string* (APP_JS) that dashboard.ts inlines into the page
// inside a <script> tag AFTER chart.js, so window.PLChart already exists when
// this IIFE runs. It owns everything except the chart canvas rendering:
// data loading + polling, the readout cards, the header spot ticker, the
// Update-Model job flow (progress + ETA + completion toast), the settings
// drawer, source-health chips, the events feed, and the footer.
//
// It consumes ONLY the JSON API in spec section 6 (envelope {ok:true,data} |
// {ok:false,error} on every /api/* route). Every server string is passed
// through esc() before it reaches innerHTML.
//
// Template-literal safety (mirrors the template repo's dashboard.ts): APP_JS is
// a String.raw literal, so backslash escapes survive verbatim. There are NO
// backtick characters and NO dollar-brace runs anywhere inside it; the embedded
// JavaScript uses only quoted strings and "+" concatenation.
//
// Marker: PLAPP_MAIN

import { REFRACTION_JS } from './refractionClient.js';

export const APP_JS: string = String.raw`/* PLAPP_MAIN */
"use strict";
(function () {
` + REFRACTION_JS + String.raw`
  var GENESIS = Date.UTC(2009, 0, 3);
  var DAY = 86400000;

  // ---- tiny DOM helpers (template pattern) --------------------------------
  function $(id) { return document.getElementById(id); }
  var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function setHtml(id, h) { var e = $(id); if (e) e.innerHTML = h; }
  function setV(id, v) { var e = $(id); if (e) e.value = (v == null ? "" : String(v)); }
  function setC(id, v) { var e = $(id); if (e) e.checked = !!v; }
  function val(id) { var e = $(id); return e ? e.value : ""; }
  function numVal(id, d) { var e = $(id); if (!e) return d; var n = parseInt(e.value, 10); return isNaN(n) ? d : n; }
  function checked(id) { var e = $(id); return e ? !!e.checked : false; }
  function show(id, on) { var e = $(id); if (e) e.style.display = on ? "" : "none"; }
  function busy(btn, label) { var old = btn.textContent; btn.disabled = true; if (label) btn.textContent = label; return old; }
  function unbusy(btn, old) { btn.disabled = false; if (old != null) btn.textContent = old; }

  var fmtUSD = (window.PLChart && window.PLChart.fmtUSD) || function (v) { return "$" + v; };
  function fmtN(n) { return (n == null || !isFinite(n)) ? "—" : Number(n).toFixed(2); }
  // 4-decimal variant used for the refit completion toast so small fit drift
  // (n and R² typically move in the 4th decimal between refits) stays visible.
  function fmtN4(n) { return (n == null || !isFinite(n)) ? "—" : Number(n).toFixed(4); }
  function fmtPct(p) { return (p == null || !isFinite(p)) ? "—" : (p >= 0 ? "+" : "") + Number(p).toFixed(1) + "%"; }
  function fmtInt(n) { if (n == null || n === "") return "0"; var x = Number(n); return isNaN(x) ? String(n) : x.toLocaleString("en-US"); }

  // ---- time helpers -------------------------------------------------------
  function toIso(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") { var d = new Date(v); return isNaN(d.getTime()) ? "" : d.toISOString(); }
    var t = Date.parse(v); return isNaN(t) ? "" : new Date(t).toISOString();
  }
  function relTime(iso, now) {
    var t = Date.parse(iso); if (isNaN(t)) return "—";
    var s = Math.round(((now || Date.now()) - t) / 1000); if (s < 0) s = 0;
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60); if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60); if (h < 24) return h + " hr ago";
    var d = Math.floor(h / 24); return d + " day" + (d === 1 ? "" : "s") + " ago";
  }
  function relSpan(v) {
    var iso = toIso(v); if (!iso) return '<span class="muted">—</span>';
    var abs = new Date(iso).toLocaleString();
    return '<span class="rel" data-ts="' + esc(iso) + '" title="' + esc(abs) + '">' + esc(relTime(iso)) + "</span>";
  }
  function refreshRelTimes() {
    var now = Date.now(), els = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < els.length; i++) els[i].textContent = relTime(els[i].getAttribute("data-ts"), now);
  }
  // countdown "in 4h 12m" toward a future ISO timestamp
  function until(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return "—";
    var s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return "due now";
    if (s < 60) return "in " + s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return "in " + m + "m";
    var h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return "in " + h + "h " + rm + "m";
    var d = Math.floor(h / 24), rh = h % 24;
    return "in " + d + "d " + rh + "h";
  }

  // ---- toasts -------------------------------------------------------------
  function toast(msg, kind) {
    var box = $("toasts"); if (!box) return;
    var el = document.createElement("div");
    el.className = "toast toast-" + (kind || "info");
    el.setAttribute("role", "status");
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
    }, 5200);
  }

  // ---- API envelope wrappers ({ok:true,data} | {ok:false,error}) ----------
  async function apiGet(url) {
    try {
      var r = await fetch(url, { cache: "no-store" });
      var j = await r.json();
      if (r.ok && j && j.ok) return { ok: true, data: j.data, status: r.status };
      return { ok: false, error: (j && j.error) ? j.error : ("HTTP " + r.status), errors: pickErrors(j), status: r.status };
    } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e), status: 0 }; }
  }
  async function apiSend(method, url, body) {
    try {
      var r = await fetch(url, { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      var j = null; try { j = await r.json(); } catch (e2) { j = null; }
      if (r.ok && j && j.ok) return { ok: true, data: j.data, status: r.status };
      return { ok: false, error: (j && j.error) ? j.error : ("HTTP " + r.status), errors: pickErrors(j), status: r.status };
    } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e), status: 0 }; }
  }
  function apiPost(url, body) { return apiSend("POST", url, body); }
  function apiPut(url, body) { return apiSend("PUT", url, body); }
  function pickErrors(j) {
    if (!j) return null;
    if (Array.isArray(j.errors)) return j.errors;
    if (j.data && Array.isArray(j.data.errors)) return j.data.errors;
    return null;
  }
  function connOk() { var n = $("connNote"); if (n) n.style.display = "none"; }
  function connFail() { var n = $("connNote"); if (n) n.style.display = "inline"; }

  // =========================================================================
  //  DISPLAY PREFERENCES (localStorage)
  // =========================================================================
  var PREF_KEY = "bpl.prefs.v1";
  var RANGES = { "full": 1, "history": 1, "4y": 1, "1y": 1, "6m": 1 };

  // Per-percentile band-visibility keys mirror the chart engine's BAND_LINES
  // "off" keys (v0.1.2 individual lines; the 0.01/99.99% envelope pair added in
  // v0.1.7). Defaults reproduce the classic four: 2.5/16.5/83.5/97.5% on, every
  // other percentile off. Stored prefs written before a key existed simply lack it,
  // and migrateBands leaves those at the default below — so the new pair needs NO
  // migration, only its two explicit false defaults.
  var BAND_KEYS = ["p0001", "p005", "p025", "p10", "p165", "p25", "p50", "p75", "p835", "p90", "p975", "p995", "p9999"];
  function defaultBands() {
    return { p0001: false, p005: false, p025: true, p10: false, p165: true, p25: false, p50: false,
             p75: false, p835: true, p90: false, p975: true, p995: false, p9999: false };
  }
  // v0.1.1 -> v0.1.2 migration (spec 12.1, REVISED after Fable review). The old
  // prefs.bands used pair keys {50,67,95,99}. ONLY the classic-four pairs carry
  // over onto their two symmetric per-line keys; the 50% and 99% pairs are
  // deliberately dropped so the seven extras stay OFF by default (they are one
  // click away under "More bands"). The migrated map is persisted immediately by
  // the caller so the legacy pair shape never survives to a second load.
  var LEGACY_KEYS = ["50", "67", "95", "99"];
  var LEGACY_CARRY = {
    "95": ["p025", "p975"],
    "67": ["p165", "p835"]
  };
  // Set true by loadPrefs when it migrated a legacy pair-shape bands map, so boot
  // can persist the new shape exactly once (see the savePrefs call after loadPrefs).
  var prefsMigrated = false;
  // Robust legacy detection (spec 12.1): the stored bands map is the v0.1.1 pair
  // shape iff it carries ANY of the pair keys 50/67/95/99 and NONE of the v0.1.2
  // per-line p* keys. A mixed object is treated as new-shape (not migrated).
  function isLegacyBands(stored) {
    if (!stored || typeof stored !== "object") return false;
    var i, sawLegacy = false;
    for (i = 0; i < LEGACY_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(stored, LEGACY_KEYS[i])) { sawLegacy = true; break; }
    }
    if (!sawLegacy) return false;
    for (i = 0; i < BAND_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(stored, BAND_KEYS[i])) return false;
    }
    return true;
  }
  // Reconcile a stored bands object onto the v0.1.2 per-line defaults:
  //   - legacy pair shape -> carry ONLY 95 -> p025/p975 and 67 -> p165/p835; the
  //     seven extras (incl. the old 50/99 pairs) stay at their default (off);
  //   - new per-line shape -> explicit boolean keys win over the defaults;
  //   - anything else (empty/corrupt) -> full new defaults (classic four on).
  function migrateBands(stored) {
    var b = defaultBands();
    if (!stored || typeof stored !== "object") return b;
    if (isLegacyBands(stored)) {
      for (var pair in LEGACY_CARRY) {
        if (!Object.prototype.hasOwnProperty.call(LEGACY_CARRY, pair)) continue;
        if (typeof stored[pair] !== "boolean") continue;
        var keys = LEGACY_CARRY[pair];
        b[keys[0]] = stored[pair];
        b[keys[1]] = stored[pair];
      }
      return b;
    }
    for (var i = 0; i < BAND_KEYS.length; i++) {
      var bk = BAND_KEYS[i];
      if (typeof stored[bk] === "boolean") b[bk] = stored[bk];
    }
    return b;
  }
  var prefs = loadPrefs();
  // Persist a just-migrated legacy prefs immediately (spec 12.1) so the old pair
  // shape can never survive to a second load and re-run the migration.
  if (prefsMigrated) savePrefs();

  function loadPrefs() {
    var d = { xMode: "date", yMode: "log", bandFill: false, halvings: true, oscillator: true, preset: "full",
              bands: defaultBands(), explain: false, moreBands: false };
    try {
      var raw = window.localStorage.getItem(PREF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p.xMode === "date" || p.xMode === "logDays") d.xMode = p.xMode;
        if (p.yMode === "log" || p.yMode === "linear") d.yMode = p.yMode;
        if (typeof p.bandFill === "boolean") d.bandFill = p.bandFill;
        if (typeof p.halvings === "boolean") d.halvings = p.halvings;
        if (typeof p.oscillator === "boolean") d.oscillator = p.oscillator;
        if (RANGES[p.preset]) d.preset = p.preset;
        if (typeof p.explain === "boolean") d.explain = p.explain;
        if (typeof p.moreBands === "boolean") d.moreBands = p.moreBands;
        if (p.bands && typeof p.bands === "object") {
          if (isLegacyBands(p.bands)) prefsMigrated = true;
          d.bands = migrateBands(p.bands);
        }
      }
    } catch (e) { /* ignore corrupt prefs */ }
    return d;
  }
  function savePrefs() {
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* quota / private mode */ }
  }

  // Refraction display prefs (v0.2.0, spec 6.3): per-line visibility and the
  // zone-fill toggle, stored under their OWN key so the power-law prefs above are
  // read and written exactly as before. Defaults: 0.1 / 5 / 50 / 95 / 99.9 on.
  var RF_PREF_KEY = "bpl.rfprefs.v1";
  // Keys and defaults come from the one ladder list in the shared snippet (U11).
  var RF_LINE_KEYS = [];
  (function () { for (var i = 0; i < RF.LINES.length; i++) RF_LINE_KEYS.push(RF.LINES[i].key); })();
  function defaultRfLines() {
    var d = {};
    for (var i = 0; i < RF.LINES.length; i++) d[RF.LINES[i].key] = RF.LINES[i].def;
    return d;
  }
  function loadRfPrefs() {
    var d = { lines: defaultRfLines(), bandFill: true };
    try {
      var raw = window.localStorage.getItem(RF_PREF_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p.bandFill === "boolean") d.bandFill = p.bandFill;
        if (p && p.lines && typeof p.lines === "object") {
          for (var i = 0; i < RF_LINE_KEYS.length; i++) {
            if (typeof p.lines[RF_LINE_KEYS[i]] === "boolean") d.lines[RF_LINE_KEYS[i]] = p.lines[RF_LINE_KEYS[i]];
          }
        }
      }
    } catch (e) { /* ignore corrupt prefs */ }
    return d;
  }
  function saveRfPrefs() {
    try { window.localStorage.setItem(RF_PREF_KEY, JSON.stringify(rfPrefs)); } catch (e) { /* quota / private mode */ }
  }
  var rfPrefs = loadRfPrefs();

  // =========================================================================
  //  STATE
  // =========================================================================
  var lastStatus = null, lastModel = null, lastFittedAt = null;
  // Refraction inputs (v0.2.0): the validated fit from /api/model.refraction and the
  // date -> height map from /api/heights. Both must exist for the mode to engage.
  var rfFit = null, hmap = null, heightsLoaded = false;
  var appliedMode = null;          // the mode the page was last laid out for
  var rfMilestoneCache = null;     // { key, jan:{year:usd}, oneM, hundredK }
  var lastEvents = [];             // the activity list, read by rfFitFailed()
  var formModel = null;            // the model value the settings form was filled with (U10)
  var priceSeries = [];   // [[ 'YYYY-MM-DD', usd, flag ], ...] held for the year-end table
  var nextRefitAt = null;
  var jobTimer = null, jobActive = false;
  var userRefitPending = false;
  var jobEta = { base: null, at: 0 };
  var chartReady = false;

  // =========================================================================
  //  CHART WIRING
  // =========================================================================
  function mountChart() {
    if (!window.PLChart || !$("chartCanvas")) return;
    window.PLChart.mount({
      canvas: $("chartCanvas"),
      osc: $("oscCanvas"),
      tip: $("chartTip"),
      wrap: $("chartWrap"),
      oscWrap: $("oscWrap"),
      onPresetCleared: function () { prefs.preset = ""; markActiveRange(); }
    });
    window.PLChart.setPrefs({ xMode: prefs.xMode, yMode: prefs.yMode, bandFill: prefs.bandFill, halvings: prefs.halvings, oscillator: prefs.oscillator, bands: prefs.bands });
    window.PLChart.setPrefs({ rfLines: rfPrefs.lines, rfBandFill: rfPrefs.bandFill });
    if (prefs.preset) window.PLChart.setPreset(prefs.preset);
    chartReady = true;
  }

  function wireControls() {
    // segmented X / Y mode
    bindSeg("xMode", ["date", "logDays"], function (v) { prefs.xMode = v; window.PLChart.setPrefs({ xMode: v }); });
    bindSeg("yMode", ["log", "linear"], function (v) { prefs.yMode = v; window.PLChart.setPrefs({ yMode: v }); });
    // range preset pills
    var ranges = ["full", "history", "4y", "1y", "6m"];
    for (var i = 0; i < ranges.length; i++) bindRange(ranges[i]);
    // toggles
    // Band fill follows the active model: the power-law pairs keep their v0.1.8
    // pref; the Refraction zones have their own (default on).
    var tgb = $("tgBands");
    if (tgb) tgb.addEventListener("click", function () {
      if (rfActive()) {
        rfPrefs.bandFill = !rfPrefs.bandFill; saveRfPrefs(); markToggles();
        window.PLChart.setPrefs({ rfBandFill: rfPrefs.bandFill });
        return;
      }
      prefs.bandFill = !prefs.bandFill; savePrefs(); markToggles();
      window.PLChart.setPrefs({ bandFill: prefs.bandFill });
    });
    bindToggle("tgHalvings", "halvings", function (on) { window.PLChart.setPrefs({ halvings: on }); });
    bindToggle("tgOsc", "oscillator", function (on) {
      show("oscWrap", on);
      window.PLChart.setPrefs({ oscillator: on });
      window.PLChart.resize();
    });
    markActiveMode(); markActiveRange(); markToggles();
    show("oscWrap", prefs.oscillator);
    wireLegend(); wireMoreBands(); wireExplain();
    wireRfLegend(); wireModelSwitch();
  }

  // ---- band legend chips (v0.1.2) -----------------------------------------
  // Each percentile chip click-toggles its single line's visibility, persisted
  // per-percentile in prefs.bands and pushed to the chart via setPrefs({bands}).
  // Price/Trend are static indicators. aria-pressed reflects the on/off state.
  // Chips whose offset key is absent from the current fit render disabled.
  function wireLegend() {
    for (var i = 0; i < BAND_KEYS.length; i++) {
      (function (key) {
        var el = $("lg_" + key);
        if (!el) return;
        el.addEventListener("click", function () {
          if (el.disabled) return;
          prefs.bands[key] = !prefs.bands[key];
          savePrefs();
          setLegendChip(key);
          var patch = { bands: {} };
          patch.bands[key] = prefs.bands[key];
          if (window.PLChart) window.PLChart.setPrefs(patch);
        });
      })(BAND_KEYS[i]);
    }
    markLegend();
  }
  function markLegend() { for (var i = 0; i < BAND_KEYS.length; i++) setLegendChip(BAND_KEYS[i]); }
  function setLegendChip(key) {
    var el = $("lg_" + key);
    if (el) el.setAttribute("aria-pressed", prefs.bands[key] === true ? "true" : "false");
  }
  // Disable chips the current model cannot draw (pre-0.1.2 fits missing an offset),
  // with the spec title; re-enable once a fresh fit supplies the key. Availability
  // is asked of the same helper the chart's own linePresent() mirrors, so in
  // quantileRegression mode a chip tracks its fitted line rather than its offset.
  function updateLegendAvailability(m) {
    var lines = bandLinesOf(m);
    for (var i = 0; i < BAND_KEYS.length; i++) {
      var key = BAND_KEYS[i], el = $("lg_" + key);
      if (!el) continue;
      var present = bandKeyPresent(m, lines, key);
      el.disabled = !present;
      if (present) el.removeAttribute("title");
      else el.title = "available after the next model update";
    }
  }

  // ---- "More bands" expander (v0.1.2) -------------------------------------
  // Reveals the second chip row (the non-default percentiles incl. the 50% median
  // and the 0.01/99.99% envelope pair that brackets it since v0.1.7). Open/closed
  // state persisted in prefs.moreBands (default collapsed).
  function wireMoreBands() {
    var btn = $("moreBandsToggle");
    if (!btn) return;
    applyMoreBands();
    btn.addEventListener("click", function () {
      prefs.moreBands = !prefs.moreBands;
      savePrefs();
      applyMoreBands();
    });
  }
  function applyMoreBands() {
    var open = !!prefs.moreBands;
    show("moreBandsRow", open);
    var btn = $("moreBandsToggle");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    setText("moreBandsChev", open ? "▴" : "▾");
  }

  // ---- chart explainer panel (v0.1.1) -------------------------------------
  // Collapsible "What am I looking at?" panel; open/closed state persisted in
  // prefs.explain (default collapsed). Folds in the old interaction-hint line.
  function wireExplain() {
    var btn = $("explainToggle");
    if (!btn) return;
    applyExplain();
    btn.addEventListener("click", function () {
      prefs.explain = !prefs.explain;
      savePrefs();
      applyExplain();
    });
  }
  function applyExplain() {
    var open = !!prefs.explain;
    // (v0.2.0) one open/closed state, the panel of the active model
    var rfm = rfActive();
    show("explainPanel", open && !rfm);
    show("explainPanelRf", open && rfm);
    var btn = $("explainToggle");
    if (btn) btn.setAttribute("aria-controls", rfm ? "explainPanelRf" : "explainPanel");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    setText("explainChevron", open ? "▾" : "▸");
  }
  function bindSeg(group, values, apply) {
    for (var i = 0; i < values.length; i++) {
      (function (v) {
        var el = $(group + "_" + v);
        if (!el) return;
        el.addEventListener("click", function () {
          prefs[group] = v; savePrefs(); markActiveMode(); apply(v);
        });
      })(values[i]);
    }
  }
  function bindRange(name) {
    var el = $("rg_" + name);
    if (!el) return;
    el.addEventListener("click", function () {
      prefs.preset = name; savePrefs(); markActiveRange(); window.PLChart.setPreset(name);
    });
  }
  function bindToggle(id, key, apply) {
    var el = $(id);
    if (!el) return;
    el.addEventListener("click", function () {
      prefs[key] = !prefs[key]; savePrefs(); markToggles(); apply(prefs[key]);
    });
  }
  function markActiveMode() {
    setSeg("xMode", ["date", "logDays"], prefs.xMode);
    setSeg("yMode", ["log", "linear"], prefs.yMode);
  }
  function setSeg(group, values, active) {
    for (var i = 0; i < values.length; i++) {
      var el = $(group + "_" + values[i]);
      if (el) el.className = "seg" + (values[i] === active ? " seg-on" : "");
    }
  }
  function markActiveRange() {
    var ranges = ["full", "history", "4y", "1y", "6m"];
    for (var i = 0; i < ranges.length; i++) {
      var el = $("rg_" + ranges[i]);
      if (el) el.className = "pill-btn" + (ranges[i] === prefs.preset ? " pill-on" : "");
    }
  }
  function markToggles() {
    setTog("tgBands", rfActive() ? rfPrefs.bandFill : prefs.bandFill);
    setTog("tgHalvings", prefs.halvings);
    setTog("tgOsc", prefs.oscillator);
  }
  function setTog(id, on) { var el = $(id); if (el) { el.className = "pill-btn" + (on ? " pill-on" : ""); el.setAttribute("aria-pressed", on ? "true" : "false"); } }

  // =========================================================================
  //  STATUS  (readouts, spot ticker, source chips, init overlay, footer)
  // =========================================================================
  // The force flag is passed ONLY by the boot-time call so a page loaded in a
  // hidden (background) tab still populates its readouts; the polling interval
  // keeps the document.hidden guard (no wasted fetches while the tab is hidden).
  async function loadStatus(force) {
    if (!force && document.hidden) return;
    var res = await apiGet("/api/status");
    if (res.ok) { renderStatus(res.data); connOk(); } else { connFail(); }
  }

  function renderStatus(s) {
    lastStatus = s;
    // header + footer versions
    setText("appVersion", s.version ? ("v" + s.version) : "");
    setText("footVersion", "BTC Power Law Model" + (s.version ? (" v" + s.version) : "") + (s.gitSha ? (" · " + String(s.gitSha).slice(0, 12)) : ""));

    renderSpot(s.spot);
    renderReadouts(s);
    var m = s.model;

    nextRefitAt = s.nextRefitAt || null;
    renderNextRefit();
    setText("ro_nextRefit_sub", s.refitIntervalHours != null ? ("every " + s.refitIntervalHours + " h") : "");

    renderSources(s.sources || []);

    // initial-sync overlay (full-page progress lives here; filled by the job poll)
    var syncing = s.initialSyncDone === false;
    show("initOverlay", syncing);

    // (v0.2.0) the Refraction "now" values move with the tip and the spot; the
    // heights are retried / refreshed from here (U2)
    if (rfActive()) {
      if (window.PLChart && window.PLChart.setNow) window.PLChart.setNow(rfNowRef());
      renderPctTable(); renderFalsifiabilityRf(); renderRfNotes();
      if (lastModel) renderMilestonesRf();
    }
    maybeRetryHeights(s);

    // model + prices are (re)fetched whenever the fit timestamp changes
    if (m && m.fittedAt && m.fittedAt !== lastFittedAt) {
      lastFittedAt = m.fittedAt;
      reloadModelAndPrices();
    } else if (!m && lastFittedAt === null && !syncing) {
      // no fit yet but sync claims done — leave readouts as skeletons
    }
  }

  // The nine readout tiles for the active model (v0.2.0); the power-law branch is
  // the v0.1.8 code unchanged.
  function renderReadouts(s) {
    if (rfActive()) { renderReadoutsRf(s); return; }
    // readouts sourced from status
    setText("ro_fairValue", s.fairValueNow != null ? fmtUSD(s.fairValueNow) : "—");
    var dev = $("ro_deviation");
    if (dev) { dev.textContent = fmtPct(s.deviationPct); dev.className = "ro-v " + (s.deviationPct == null ? "" : (s.deviationPct >= 0 ? "pos" : "neg")); }
    setText("ro_quantile", s.currentQuantile != null ? (Number(s.currentQuantile).toFixed(1) + "%") : "—");
    setText("ro_days", fmtInt(daysSinceGenesis()));

    var m = s.model;
    if (m) {
      setText("ro_n", fmtN(m.n));
      setText("ro_A", m.a != null ? ("10^" + Number(m.a).toFixed(3)) : "—");
      setText("ro_A_sub", m.A != null ? ("A = " + m.A.toExponential(3)) : "");
      setText("ro_r2", m.r2 != null ? Number(m.r2).toFixed(4) : "—");
      setText("ro_sigma", m.sigma != null ? Number(m.sigma).toFixed(4) : "—");
      var extra = [];
      if (m.points != null) extra.push(fmtInt(m.points) + " pts");
      if (m.includesProvisionalSpot) extra.push("incl. spot");
      setText("ro_n_sub", extra.join(" · "));
    }
  }

  function daysSinceGenesis() {
    var now = new Date();
    var todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((todayUtc - GENESIS) / DAY);
  }

  function renderNextRefit() {
    setText("ro_nextRefit", nextRefitAt ? until(nextRefitAt) : "—");
  }

  function renderSpot(sp) {
    if (!sp || sp.usd == null) {
      setText("spotPrice", "—");
      setHtml("spotMeta", '<span class="muted">no spot yet</span>');
      show("spotStale", false);
      return;
    }
    setText("spotPrice", fmtUSD(sp.usd));
    var q = sp.quorum != null ? (sp.quorum + " sources") : "";
    setHtml("spotMeta", "updated " + relSpan(sp.at) + (q ? (" · " + esc(q)) : ""));
    show("spotStale", !!sp.stale);
  }

  // ---- source-health chips ------------------------------------------------
  function sourceState(x) {
    if (!x.lastOkAt && !x.lastErrorAt) return "unknown";
    if (x.consecutiveFailures >= 3) return "fail";
    if (x.consecutiveFailures >= 1) return "warn";
    return "ok";
  }
  function renderSources(list) {
    var box = $("sourceChips");
    if (!box) return;
    // sourceMode is not in /api/status per contract; read it from the settings
    // cache so chips are clickable only in manual mode (auto mode is read-only).
    var manualMode = settingsCache && settingsCache.sourceMode === "manual";
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var x = list[i] || {};
      var st = sourceState(x);
      var lat = (x.latencyMs != null && x.latencyMs > 0) ? (Math.round(x.latencyMs) + "ms") : "";
      var off = x.enabled === false;
      html += '<button type="button" class="srcchip srcchip-' + st + (off ? " srcchip-off" : "") +
        '" data-src="' + esc(x.name) + '" title="' + esc(chipTitle(x)) + '"' +
        (manualMode ? "" : " data-ro=\"1\"") + '>' +
        '<span class="srcdot"></span>' +
        '<span class="srcname">' + esc(x.name) + "</span>" +
        (lat ? ('<span class="srclat">' + esc(lat) + "</span>") : "") +
        (off ? '<span class="srcoff">off</span>' : "") +
        "</button>";
    }
    box.innerHTML = html;
    // wire clicks
    var btns = box.querySelectorAll(".srcchip");
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener("click", function () { onSourceChipClick(this.getAttribute("data-src"), this.getAttribute("data-ro") === "1"); });
    }
  }
  function chipTitle(x) {
    var parts = [];
    parts.push((x.kinds || []).join("+") || "source");
    if (x.lastOkAt) parts.push("ok " + relTime(toIso(x.lastOkAt)));
    if (x.lastError) parts.push("err: " + x.lastError);
    if (x.consecutiveFailures) parts.push(x.consecutiveFailures + " fails");
    // (v0.2.0) block-height calls are tracked apart from price health
    var hh = x.heightHealth;
    if (hh && typeof hh === "object") {
      if (hh.consecutiveFailures) parts.push("block heights failing (" + hh.consecutiveFailures + "x" + (hh.lastError ? ": " + hh.lastError : "") + ")");
      else if (hh.lastOkAt) parts.push("block heights ok " + relTime(toIso(hh.lastOkAt)));
    }
    return parts.join(" · ");
  }
  async function onSourceChipClick(name, readonly) {
    if (readonly) { toast("Switch source mode to Manual to toggle individual sources", "info"); return; }
    if (!settingsCache || !settingsCache.enabledSources) { toast("Settings not loaded yet", "info"); return; }
    var cur = settingsCache.enabledSources[name] !== false;
    var patch = { enabledSources: {} };
    patch.enabledSources[name] = !cur;
    var res = await apiPut("/api/settings", patch);
    if (res.ok) {
      settingsCache = res.data || settingsCache;
      fillSettingsForm(settingsCache);
      toast(name + (cur ? " disabled" : " enabled"), "ok");
      loadStatus();
    } else {
      toast(res.error || "Could not update source", "error");
      if (res.errors) toast(res.errors.join("; "), "error");
    }
  }

  // =========================================================================
  //  MODEL  (readouts refinement, milestones, chart params)
  // =========================================================================
  async function loadModel() {
    var res = await apiGet("/api/model");
    if (!res.ok) { return false; }
    lastModel = res.data;
    rfFit = RF.readFit(res.data && res.data.refraction);
    renderModel(res.data);
    updateLegendAvailability(res.data);
    if (chartReady) window.PLChart.setModel(res.data);
    renderYearTable();
    return true;
  }
  async function loadPrices() {
    var res = await apiGet("/api/prices?maxPoints=8000");
    if (res.ok) {
      priceSeries = (res.data && res.data.points) || [];
      renderYearTable();
      if (chartReady) window.PLChart.setPrices(res.data);
    }
  }

  function renderModel(m) {
    if (!m) return;
    if (rfActive()) {
      renderRfNotes();
      renderMilestonesRf();
      renderFalsifiabilityRf();
      return;
    }
    setText("ro_n", fmtN(m.n));
    setText("ro_A", m.a != null ? ("10^" + Number(m.a).toFixed(3)) : "—");
    setText("ro_r2", m.r2 != null ? Number(m.r2).toFixed(4) : "—");
    setText("ro_sigma", m.sigma != null ? Number(m.sigma).toFixed(4) : "—");
    setText("bandModeNote", bandModeNote(m.bandMode));
    renderMilestones(m.milestones || {});
    renderFalsifiability(m.falsifiability || {});
  }
  // The chart's top-right corner note names the methodology the drawn bands came
  // from (v0.1.6 adds the quantile-regression branch).
  function bandModeNote(mode) {
    if (mode === "quantileRegression") return "bands: quantile regression";
    if (mode === "fullSample") return "bands: full-sample percentiles";
    return "bands: point-in-time percentiles";
  }

  // =========================================================================
  //  YEAR-END MODEL TABLE (v0.1.2, spec 12.2 — client-side, no API change)
  // =========================================================================
  // One row per calendar year 2010..projectionEndYear. "Actual close" is the last
  // stored price of that year (from /api/prices, which the app already holds);
  // the model columns (2.5/16.5/Trend/83.5/97.5%) are computed client-side at
  // t(Dec 31) from the fit — parallel offsets, or the fit's own band lines in
  // quantileRegression mode (v0.1.6), always through bandUsdAt(). Columns are FIXED
  // to the default percentile set regardless of the chart legend. Recomputed on
  // model/prices refresh and when projectionEndYear changes.
  var YEAR_GENESIS = Date.UTC(2009, 0, 3);
  function tDays(ms) { var d = Math.floor((ms - YEAR_GENESIS) / DAY); return d < 1 ? 1 : d; }
  function trendLogAtYear(m, ms) { return m.a + m.n * (Math.log(tDays(ms)) / Math.LN10); }
  function modelUsdAt(m, ms, off) {
    var lg = trendLogAtYear(m, ms) + (off || 0);
    return Math.pow(10, lg);
  }

  // ---- band column evaluation (v0.1.6, spec 15.3) -------------------------
  // ONE bandLines-aware helper behind every band column, so the year-end table, the
  // CSV export and the chart can never disagree about what a percentile is worth on
  // a date. In quantileRegression mode each percentile is its own fitted line and
  // the ladder values at a date are MONOTONE-REARRANGED (evaluate every line, sort
  // ascending, hand back in ascending-tau order) exactly as the backend's
  // bandPricesAt() does; in every other mode — and for a stale record that claims
  // the mode but carries no usable bandLines — the value is the parallel
  // trend + offset. Ladder order matches the backend BAND_KEYS.
  var QR_LADDER = ["p0001", "p005", "p025", "p10", "p165", "p25", "p50", "p75", "p835", "p90", "p975", "p995", "p9999"];
  function bandLinesOf(m) {
    if (!(m && m.bandMode === "quantileRegression" && m.bandLines)) return null;
    var out = {}, any = false, i, ln;
    for (i = 0; i < QR_LADDER.length; i++) {
      ln = m.bandLines[QR_LADDER[i]];
      if (!ln || typeof ln.a !== "number" || !isFinite(ln.a)) continue;
      if (typeof ln.n !== "number" || !isFinite(ln.n)) continue;
      out[QR_LADDER[i]] = ln;
      any = true;
    }
    return any ? out : null;
  }
  // The rearranged ladder prices at a date: { key -> usd } over the present lines.
  function bandLinePricesAt(lines, ms) {
    var lg = Math.log(tDays(ms)) / Math.LN10;
    var keys = [], vals = [], i;
    for (i = 0; i < QR_LADDER.length; i++) {
      if (!lines[QR_LADDER[i]]) continue;
      keys.push(QR_LADDER[i]);
      vals.push(Math.pow(10, lines[QR_LADDER[i]].a + lines[QR_LADDER[i]].n * lg));
    }
    vals.sort(function (p, q) { return p - q; });
    var out = {};
    for (i = 0; i < keys.length; i++) out[keys[i]] = vals[i];
    return out;
  }
  // Price of one column at a date. key === null is the Trend itself (mode-independent);
  // null is returned when the column is unavailable in this fit (a percentile a legacy
  // record never carried), which the callers render as an em-dash / empty CSV field.
  function bandUsdAt(m, ms, key) {
    if (!(m && m.a != null && m.n != null)) return null;
    if (key == null) return modelUsdAt(m, ms, 0);
    var lines = bandLinesOf(m);
    if (lines) {
      var price = bandLinePricesAt(lines, ms)[key];
      return (typeof price === "number" && isFinite(price)) ? price : null;
    }
    var off = (m.bandOffsets || {})[key];
    if (typeof off !== "number" || !isFinite(off)) return null;
    return modelUsdAt(m, ms, off);
  }
  // Whether a percentile column exists in this fit at all (its own line in
  // quantileRegression mode, otherwise a finite offset).
  function bandKeyPresent(m, lines, key) {
    if (lines) return !!lines[key];
    var off = (m && m.bandOffsets) ? m.bandOffsets[key] : undefined;
    return typeof off === "number" && isFinite(off);
  }
  // Latest calendar year we have any real (non-provisional) or provisional close for.
  function currentUtcYear() { return new Date().getUTCFullYear(); }
  // The last stored price whose date falls in year Y (pure over an explicit
  // series so the CSV builder can reuse it without touching closure state).
  function lastCloseInSeries(series, y) {
    var best = null;
    for (var i = 0; i < series.length; i++) {
      var row = series[i];
      var ys = parseInt(String(row[0]).slice(0, 4), 10);
      if (ys !== y) continue;
      if (best === null || String(row[0]) > String(best[0])) best = row;
    }
    return best; // [date, usd, flag] or null
  }
  function lastCloseOfYear(y) { return lastCloseInSeries(priceSeries, y); }
  function projEndYear() {
    // Follow the live setting so the row range extends immediately when the user
    // changes projectionEndYear (before the next refit rewrites model.projection).
    if (settingsCache && settingsCache.projectionEndYear) return settingsCache.projectionEndYear;
    if (lastModel && lastModel.projection && lastModel.projection.endYear) return lastModel.projection.endYear;
    return 2045;
  }
  function cautionYear() {
    if (lastModel && lastModel.projection && lastModel.projection.cautionAfterYear) return lastModel.projection.cautionAfterYear;
    return 2040;
  }
  // =========================================================================
  //  HOLDINGS VALUATION (v0.1.3, spec 13.2 — settings.holdings, server-side)
  // =========================================================================
  // settings.holdings = { enabled, globalBtc, perYear:{"YYYY":btc} }. All three
  // are always PUT together (perYear replaces the whole object per spec). currentHoldings
  // normalizes the settings cache into that exact shape (defensive: the field may be
  // absent on a pre-0.1.3 backend). The table shows either raw prices (Price mode) or
  // holdings x price (My-holdings mode).
  function currentHoldings() {
    var h = (settingsCache && settingsCache.holdings) || {};
    var perYear = {};
    if (h.perYear && typeof h.perYear === "object") {
      for (var k in h.perYear) {
        if (!Object.prototype.hasOwnProperty.call(h.perYear, k)) continue;
        var v = Number(h.perYear[k]);
        if (isFinite(v)) perYear[k] = v;
      }
    }
    var g = Number(h.globalBtc);
    return { enabled: !!h.enabled, globalBtc: isFinite(g) ? g : 0, perYear: perYear };
  }
  // Effective BTC for a year: its per-year override if set, else the global amount.
  function holdingsForYear(y, h) {
    var ov = h.perYear[String(y)];
    return (typeof ov === "number" && isFinite(ov)) ? ov : h.globalBtc;
  }
  // BTC amount up to 8 decimals, trailing zeros (and a bare dot) trimmed.
  function fmtBtc(x) {
    if (x == null || !isFinite(x)) return "";
    var s = Number(x).toFixed(8);
    if (s.indexOf(".") >= 0) { s = s.replace(/0+$/, ""); s = s.replace(/\.$/, ""); }
    return s;
  }
  // Build a clone of the holdings object with one field changed, ready to PUT.
  function holdingsClone(h) {
    var perYear = {};
    for (var k in h.perYear) { if (Object.prototype.hasOwnProperty.call(h.perYear, k)) perYear[k] = h.perYear[k]; }
    return { enabled: h.enabled, globalBtc: h.globalBtc, perYear: perYear };
  }
  // PUT the full holdings object; on success adopt the server echo and re-render, on
  // failure toast and re-render from the last known-good cache (reverting the control).
  async function putHoldings(next) {
    var res = await apiPut("/api/settings", { holdings: next });
    if (res.ok) {
      settingsCache = res.data || settingsCache;
      renderYearTable();
    } else {
      toast(res.error || "Could not update holdings", "error");
      if (res.errors && res.errors.length) toast(res.errors.join("; "), "error");
      renderYearTable();
    }
  }

  // Reflect holdings state onto the mode toggle, header rows, and global input.
  function syncHoldingsControls(h, tm) {
    var on = h.enabled;
    var pe = $("ytMode_price"), he = $("ytMode_holdings");
    if (pe) { pe.className = "seg" + (on ? "" : " seg-on"); pe.setAttribute("aria-pressed", on ? "false" : "true"); }
    if (he) { he.className = "seg" + (on ? " seg-on" : ""); he.setAttribute("aria-pressed", on ? "true" : "false"); }
    // (v0.2.0) the header rows of the active model; the other model's stay hidden
    tm = tm || { headPrice: "ytHeadPrice", headHold: "ytHeadHoldings", otherPrice: "ytHeadRfPrice", otherHold: "ytHeadRfHoldings" };
    show(tm.otherPrice, false);
    show(tm.otherHold, false);
    show(tm.headPrice, !on);
    show(tm.headHold, on);
    show("ytHoldingsControl", on);
    var gi = $("ytGlobalBtc");
    if (gi && document.activeElement !== gi) gi.value = h.globalBtc ? fmtBtc(h.globalBtc) : "";
  }

  // One model cell: price*scale, always untinted (v0.1.4 — only the Actual close /
  // Actual value cell is tinted now, by actualTintClass; the model/band columns are
  // plain text). key === null is the Trend; a percentile column this fit cannot
  // evaluate (absent from a pre-0.1.2 record, or the v0.1.8 floor rail on a
  // pre-0.1.7 one) renders an em-dash carrying the same "available after the next
  // model update" title the disabled legend chips use.
  var COLUMN_UNAVAILABLE = "available after the next model update";
  function valCell(m, ms, key, scale) {
    var price = bandUsdAt(m, ms, key);
    if (price == null || !isFinite(price)) {
      return key == null ? "<td>—</td>" : '<td title="' + COLUMN_UNAVAILABLE + '">—</td>';
    }
    return "<td>" + esc(fmtUSD(price * scale)) + "</td>";
  }
  // The six fixed model columns, in display order (v0.1.8, spec 17): the 0.01%
  // floor rail leads the band block, then 2.5% | 16.5% | Trend | 83.5% | 97.5%.
  // Same order in both display modes — only the leading Year/BTC/Actual columns
  // differ. Every cell goes through bandUsdAt(), so the rail follows the active
  // band mode (rearranged band lines in quantileRegression) like its neighbours.
  var YT_COLUMNS = ["p0001", "p025", "p165", null, "p835", "p975"];
  function modelCells(m, dec31, scale) {
    var out = "", i;
    for (i = 0; i < YT_COLUMNS.length; i++) {
      if (!(m && m.a != null && m.n != null)) { out += "<td>—</td>"; continue; }
      out += valCell(m, dec31, YT_COLUMNS[i], scale);
    }
    return out;
  }
  // Tint class for the Actual close / Actual value cell (v0.1.4, spec 13.3 REVISED).
  // Green (yt-hi) when the year's actual close sat AT OR ABOVE the trend, red (yt-lo)
  // when it finished below. Comparison-date fairness: a past year compares its Dec-31
  // close to the Dec-31 trend; the in-progress year compares its latest close to the
  // trend evaluated at THAT SAME date (t of the latest close), not Dec-31, so a mid-
  // year read is not skewed. Prices are compared in both display modes (holdings
  // scale both sides equally). No close (future years) or no model -> "" (untinted).
  function actualTintClass(m, y, nowY, close, dec31) {
    if (!(m && m.a != null && m.n != null)) return "";
    if (!close) return "";
    var actualPrice = close[1];
    if (actualPrice == null || !isFinite(actualPrice)) return "";
    var cmpMs = dec31;
    if (y === nowY) { var d = dateToMs(String(close[0])); if (d != null) cmpMs = d; }
    var trendPrice = modelUsdAt(m, cmpMs, 0);
    if (!isFinite(trendPrice)) return "";
    return actualPrice >= trendPrice ? "yt-hi" : "yt-lo";
  }
  // Parse a 'YYYY-MM-DD' date string to a UTC ms timestamp (null if unparseable).
  function dateToMs(s) {
    var mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    if (!mm) return null;
    return Date.UTC(+mm[1], +mm[2] - 1, +mm[3]);
  }

  // =========================================================================
  //  YEAR-END TABLE CSV EXPORT (v0.1.5, spec 14 — client-side, no API change)
  // =========================================================================
  // Ascending percentile columns for the export, 0.01% -> 99.99%. This is the FULL
  // superset (every line in a current fit), not the on-screen default four; the
  // builder keeps only the percentiles whose offset key exists in the given model
  // (legacy fits export what they have), and Trend is always the LAST column.
  var CSV_PCTS = [
    { key: "p0001", label: "0.01%" },
    { key: "p005", label: "0.5%" },
    { key: "p025", label: "2.5%" },
    { key: "p10",  label: "10%" },
    { key: "p165", label: "16.5%" },
    { key: "p25",  label: "25%" },
    { key: "p50",  label: "50%" },
    { key: "p75",  label: "75%" },
    { key: "p835", label: "83.5%" },
    { key: "p90",  label: "90%" },
    { key: "p975", label: "97.5%" },
    { key: "p995", label: "99.5%" },
    { key: "p9999", label: "99.99%" }
  ];
  // One numeric price cell for the CSV: raw number, 2 decimals, no currency symbol /
  // thousand separators; empty when the column is unavailable in this fit. Values
  // come from the same bandUsdAt() helper the on-screen table uses (key === null is
  // the Trend), so an export can never disagree with the table or the chart.
  function csvPrice(m, ms, key, scale) {
    var price = bandUsdAt(m, ms, key);
    if (price == null || !isFinite(price)) return "";
    return (price * scale).toFixed(2);
  }
  // Pure CSV builder (spec 14): rows come only from (model, price series, holdings,
  // endYear) — no DOM, no closure mutable state — so it is unit-tested directly
  // through the smoke-test harness. Emits UTF-8 BOM + CRLF row endings. Columns:
  // Year, [BTC held in holdings mode], Actual close/value, ascending percentiles
  // present in the fit, Trend last. In holdings mode every price column becomes
  // holdings x price and its header gains a " value" suffix.
  function buildYearEndCsv(m, series, holdings, endYear) {
    var BOM = "\uFEFF";
    var mode = !!(holdings && holdings.enabled);
    var lines = bandLinesOf(m);
    var present = [];
    for (var i = 0; i < CSV_PCTS.length; i++) {
      if (bandKeyPresent(m, lines, CSV_PCTS[i].key)) present.push(CSV_PCTS[i]);
    }
    var header = ["Year"];
    if (mode) header.push("BTC held");
    header.push(mode ? "Actual value" : "Actual close");
    for (i = 0; i < present.length; i++) header.push(mode ? (present[i].label + " value") : present[i].label);
    header.push(mode ? "Trend value" : "Trend");
    var lines = [header.join(",")];
    for (var y = 2010; y <= endYear; y++) {
      var dec31 = Date.UTC(y, 11, 31);
      var scale = mode ? holdingsForYear(y, holdings) : 1;
      var row = [String(y)];
      if (mode) row.push(fmtBtc(holdingsForYear(y, holdings)));
      var close = lastCloseInSeries(series, y);
      var actual = close ? close[1] : null;
      row.push((actual != null && isFinite(actual)) ? (actual * scale).toFixed(2) : "");
      for (i = 0; i < present.length; i++) row.push(csvPrice(m, dec31, present[i].key, scale));
      row.push(csvPrice(m, dec31, null, scale));
      lines.push(row.join(","));
    }
    return BOM + lines.join("\r\n");
  }
  // The fitted-date stamp for the export filename: fittedAt as YYYY-MM-DD
  // (UTC), falling back to today when the fit somehow lacks a timestamp.
  function fittedDate(m) {
    var iso = toIso(m && m.fittedAt);
    if (!iso) iso = new Date().toISOString();
    return iso.slice(0, 10);
  }
  // Trigger a client-side download of the CSV text via a temporary object-URL
  // anchor, revoking the URL afterwards (spec 14 — no server endpoint).
  function downloadCsv(text, filename) {
    try {
      var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (e) {
      toast("Could not export CSV", "error");
    }
  }
  // Wire the "Export CSV" button (spec 14). Builds the CSV from the current model,
  // price series, and holdings settings, then downloads it.
  function wireExportCsv() {
    var btn = $("ytExportBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (!lastModel) { toast("No model yet — nothing to export", "info"); return; }
      var rfx = rfCtx();
      var csv = rfx ? buildYearEndCsvRf(rfx, priceSeries, currentHoldings(), projEndYear())
                    : buildYearEndCsv(lastModel, priceSeries, currentHoldings(), projEndYear());
      downloadCsv(csv, csvFileName(!!rfx, lastModel));
    });
  }

  // =========================================================================
  //  REFRACTION MODE (v0.2.0, spec 6) — the whole page follows the switch
  // =========================================================================
  // The mode is "refraction" only when the user asked for it (settings.model) AND
  // the fit carries a valid refraction block AND block heights are loaded; in any
  // other state the page is the v0.1.8 power-law page and the Refraction pill is
  // disabled with the reason. Every Refraction value is computed by the shared RF
  // snippet (the same code the chart draws with), under its one height rule.
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function rfReady() { return !!(rfFit && hmap); }
  function wantRf() { return !!(settingsCache && settingsCache.model === "refraction"); }
  function rfActive() { return wantRf() && rfReady(); }
  function rfCtx() { return rfActive() ? { fit: rfFit, hm: hmap, now: rfNowRef() } : null; }
  // Why the Refraction pill is disabled ("" when it is available). A missing block
  // is "not fitted yet" unless the update that produced the current fit logged a
  // Refraction failure or skip (U6).
  function rfUnavailableReason() {
    if (rfReady()) return "";
    if (!lastModel || !heightsLoaded) return "Loading the Refraction model…";
    if (!rfFit) {
      if (rfFitFailed()) return "Not available: the latest model update could not fit the Refraction model (see Activity). It needs block heights and at least two years of daily closes, and is tried again at every update.";
      return "Not fitted yet: the Refraction model appears after the model update that is " + (jobActive ? "running now." : "due next (or press Update model).");
    }
    if (heightsError) return "Block heights could not be loaded (" + heightsError + "); retrying.";
    return "Not available yet: block heights have not been downloaded. The Refraction model appears once a model update has fetched them.";
  }
  // True when the activity log shows the Refraction fit failing or being skipped in
  // the job that produced the current fit (logged shortly before its fittedAt).
  function rfFitFailed() {
    var fitAt = lastModel ? Date.parse(lastModel.fittedAt) : NaN;
    if (!isNum(fitAt)) return false;
    for (var i = 0; i < lastEvents.length; i++) {
      var ev = lastEvents[i] || {}, msg = String(ev.msg || ""), at = Date.parse(ev.at);
      if (msg.indexOf("refraction fit failed") !== 0 && msg.indexOf("refraction skipped") !== 0) continue;
      if (isNum(at) && at <= fitAt + 5000 && at >= fitAt - 15 * 60000) return true;
    }
    return false;
  }
  function seriesName(kind) { return kind === "canonical" ? "app price series (fallback)" : "Coin Metrics closes"; }
  function utcDay(ms) { var d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  // Whole dollars with thousands separators (the percentile table on desktop, so it
  // can be compared with the author's table digit for digit), with the abbreviated
  // form beside it for narrow screens (CSS shows one of the two).
  function fmtUsdFull(v) { return isNum(v) ? "$" + Math.round(v).toLocaleString("en-US") : "—"; }
  function usdBoth(v) {
    return '<span class="usd-full">' + esc(fmtUsdFull(v)) + '</span><span class="usd-abbr">' + esc(fmtUSD(v)) + "</span>";
  }
  function fmtPctile(p, approx) { return isNum(p) ? (approx ? "≈" : "") + Number(p).toFixed(1) + "%" : "—"; }

  // The Refraction "now" block: /api/status.refraction when the server sent one,
  // else the same numbers evaluated here at the live tip (or projected height).
  function rfNow() {
    if (!rfReady()) return null;
    var s = lastStatus && lastStatus.refraction;
    if (s && isNum(s.fairValueNow) && isNum(s.heightNow)) return s;
    var hn = RF.heightNow(hmap, Date.now());
    if (!hn) return null;
    var spot = lastStatus && lastStatus.spot && isNum(lastStatus.spot.usd) ? lastStatus.spot.usd : null;
    var fair = RF.linePriceAt(rfFit, 50, hn.h);
    var pct = spot ? RF.percentileOf(rfFit, hn.h, spot) : NaN;
    return {
      heightNow: hn.h, heightIsLive: !hn.est, fairValueNow: fair,
      floorNow: RF.linePriceAt(rfFit, 0.1, hn.h), anchorNow: RF.linePriceAt(rfFit, 5, hn.h),
      topNow: RF.linePriceAt(rfFit, 99.9, hn.h),
      deviationPct: spot && fair > 0 ? (spot - fair) / fair * 100 : null,
      percentile: isNum(pct) ? pct : null, percentileApprox: true,
      b1: rfFit.b1, c: rfFit.c, points: rfFit.points, dataEnd: rfFit.dataEnd, priceSeries: rfFit.priceSeries,
      staleDays: null, lastClose: null
    };
  }
  // The page's one height rule (U9): stored days, else this "now" + 144 per day.
  function rfNowRef() {
    var r = rfNow();
    return r && isNum(r.heightNow) ? { h: r.heightNow, ms: Date.now(), live: r.heightIsLive === true } : null;
  }
  // How many whole days the fit's last close lags behind yesterday (UTC): the
  // server's staleDays, else the same count here.
  function rfStaleDays() {
    var s = lastStatus && lastStatus.refraction;
    if (s && isNum(s.staleDays)) return s.staleDays;
    var end = rfFit ? RF.dayMs(rfFit.dataEnd) : NaN;
    if (!isNum(end)) return null;
    return Math.max(0, Math.round((utcDay(Date.now()) - 86400000 - end) / 86400000));
  }
  function staleSuffix(n) { return n > 3 ? " (" + n + " days old)" : ""; }

  // ---- readouts: same nine tiles, Refraction values (spec 6.4) -------------
  function renderReadoutsRf(s) {
    var r = rfNow();
    if (!r) return;
    setText("ro_fairValue", fmtUSD(r.fairValueNow));
    var dev = $("ro_deviation");
    if (dev) { dev.textContent = fmtPct(r.deviationPct); dev.className = "ro-v " + (r.deviationPct == null ? "" : (r.deviationPct >= 0 ? "pos" : "neg")); }
    setText("ro_quantile", fmtPctile(r.percentile, r.percentileApprox === true));
    setText("ro_n", fmtUSD(r.floorNow));
    setText("ro_n_sub", "0.1% line today");
    setText("ro_A", isNum(r.b1) ? Number(r.b1).toFixed(3) : "—");
    setText("ro_A_sub", (r.points != null ? fmtInt(r.points) + " closes · " : "") + "fit through " + (r.dataEnd || rfFit.dataEnd));
    setText("ro_r2", isNum(r.c) ? Number(r.c).toFixed(4) : "—");
    var S = RF.decayAt(rfFit.c, rfFit.alpha, r.heightNow);
    setText("ro_r2_sub", isNum(S) ? ("S = " + S.toFixed(3) + " at this height") : "");
    setText("ro_sigma", fmtUSD(r.topNow));
    setText("ro_days", fmtInt(Math.round(r.heightNow)));
    setText("ro_days_sub", r.heightIsLive ? "live chain tip" : "estimated (+144 blocks/day)");
  }
  // Corner note, staleness chip and explainer data-source sentence (U3, U8).
  function renderRfNotes() {
    var on = rfActive();
    var stale = on ? rfStaleDays() : null;
    var chip = $("rfStaleChip");
    if (chip) {
      var warn = on && isNum(stale) && stale > 3;
      chip.style.display = warn ? "" : "none";
      chip.textContent = warn ? ("fit is " + stale + " days behind") : "";
      chip.title = warn ? ("The Refraction fit ends on " + rfFit.dataEnd + ": the newest daily closes with block heights are " + stale +
        " days older than yesterday. The lines are still drawn from that fit; the next successful update catches up.") : "";
    }
    if (!on) return;
    setText("bandModeNote", "Refraction (Plan C) · " + seriesName(rfFit.priceSeries) + " · fit through " + rfFit.dataEnd);
    setText("rfExplainSources", rfFit.priceSeries === "canonical" ?
      "Prices are the app's own daily price series: Coin Metrics closes - the series the author uses - were not available for the latest fit, so the top line can sit several percent away from his. " :
      "Prices are Coin Metrics daily closes, the series the author uses. ");
  }

  // ---- milestones (spec 6.7) -----------------------------------------------
  // Fair value on 1 January of the four milestone years, and the first day the
  // fair-value line reaches $1M / $100k, solved by a daily scan (cached per fit,
  // heights and current height).
  var RF_MS_YEARS = [2030, 2035, 2040, 2045];
  function rfMilestones(fit, hm, now) {
    var jan = {}, i;
    for (i = 0; i < RF_MS_YEARS.length; i++) {
      jan[RF_MS_YEARS[i]] = RF.linePriceAt(fit, 50, RF.heightAt(hm, Date.UTC(RF_MS_YEARS[i], 0, 1), now));
    }
    var from = RF.dayMs(fit.dataStart);
    if (!isNum(from)) from = hm.start;
    var to = Date.UTC(2150, 11, 31);
    var oneM = RF.crossingDay(fit, hm, 50, 1e6, from, to, now);
    var hundredK = RF.crossingDay(fit, hm, 50, 1e5, from, to, now);
    return { jan: jan, oneM: oneM === null ? null : isoDay(oneM), hundredK: hundredK === null ? null : isoDay(hundredK) };
  }
  function renderMilestonesRf() {
    var now = rfNowRef();
    var key = lastFittedAt + "|" + (hmap ? hmap.n + ":" + hmap.lastH : "") + "|" + (now ? now.h + ":" + utcDay(now.ms) : "");
    if (!rfMilestoneCache || rfMilestoneCache.key !== key) {
      rfMilestoneCache = rfMilestones(rfFit, hmap, now);
      rfMilestoneCache.key = key;
    }
    var ms = rfMilestoneCache;
    for (var i = 0; i < RF_MS_YEARS.length; i++) {
      var v = ms.jan[RF_MS_YEARS[i]];
      setText("ms_" + RF_MS_YEARS[i], isNum(v) ? fmtUSD(v) : "—");
    }
    setText("ms_1m", ms.oneM || "—");
    setText("ms_1m_sub", ms.hundredK ? ("$100k " + ms.hundredK) : "");
  }
  // The author's own break conditions (spec 6.7): spot at or above the 0.1% floor
  // now, and fewer than 30 consecutive daily closes below the floor at the end of
  // the series. Completed closes only (the provisional today point is skipped); a
  // close whose height is only estimated is no evidence either way (U9).
  function closesBelowFloorRun(fit, hm, series, now) {
    var run = 0;
    for (var i = series.length - 1; i >= 0; i--) {
      var row = series[i];
      if (row[2] === 1) continue;
      var ms = dateToMs(String(row[0]));
      var hi = ms == null ? null : RF.heightInfo(hm, ms, now);
      if (!hi || (hi.est && hi.past) || !(row[1] > 0)) break;
      var floor = RF.linePriceAt(fit, 0.1, hi.h);
      if (!isNum(floor)) break;
      if (row[1] < floor) run++; else break;
    }
    return run;
  }
  function rfFalsifiability(fit, hm, series, now, spotUsd, nowRef) {
    var above = (now && isNum(spotUsd) && isNum(now.floorNow)) ? spotUsd >= now.floorNow : null;
    var run = series && series.length ? closesBelowFloorRun(fit, hm, series, nowRef) : null;
    return { aboveFloor: above, noMonthBelow: run === null ? null : run < 30, runBelow: run };
  }
  function renderFalsifiabilityRf() {
    var spot = lastStatus && lastStatus.spot && isNum(lastStatus.spot.usd) ? lastStatus.spot.usd : null;
    var f = rfFalsifiability(rfFit, hmap, priceSeries, rfNow(), spot, rfNowRef());
    var chip = function (ok, label, title) {
      var cls = ok === false ? "fchip-bad" : (ok === true ? "fchip-ok" : "fchip-unk");
      return '<span class="fchip ' + cls + '" title="' + esc(title) + '">' + esc(label) + "</span>";
    };
    setHtml("falsifiability",
      chip(f.aboveFloor, "above the 0.1% floor", "The live price is at or above the 0.1% floor line today.") +
      chip(f.noMonthBelow, "no month below the floor", f.runBelow == null ? "No daily closes loaded yet." :
        ("Consecutive daily closes below the floor at the end of the series: " + f.runBelow + " (the model breaks at 30).")));
  }

  // ---- year-end table + CSV in Refraction mode (spec 6.6) ------------------
  // Columns 0.1 | 5 | 50 | 75 | 95 | 99.9 at 31 December under the page's height
  // rule: stored heights for stored days, projected for later ones; a past day the
  // store lacks is marked "est.", and there is a dash where there is no height.
  // Both column lists derive from the snippet's one ladder (U11).
  var RF_YT_PCTS = [], RF_CSV_PCTS = [];
  (function () {
    for (var i = 0; i < RF.LINES.length; i++) {
      RF_CSV_PCTS.push({ p: RF.LINES[i].p, label: RF.LINES[i].p + "%" });
      if (RF.LINES[i].yt) RF_YT_PCTS.push(RF.LINES[i].p);
    }
  })();
  function rfInfoAt(rfx, ms) { return (rfx && rfx.hm) ? RF.heightInfo(rfx.hm, ms, rfx.now) : null; }
  function rfUsdAt(rfx, ms, pct) {
    var hi = rfInfoAt(rfx, ms);
    if (!hi || !rfx.fit) return null;
    var v = RF.linePriceAt(rfx.fit, pct, hi.h);
    return isNum(v) ? v : null;
  }
  var RF_NO_HEIGHT = "no block height for this date";
  var RF_EST_HEIGHT = "the block height for this past date is estimated (not in the stored series)";
  function rfModelCells(rfx, dec31, scale) {
    var out = "", hi = rfInfoAt(rfx, dec31);
    var estPast = !!(hi && hi.est && hi.past);
    for (var i = 0; i < RF_YT_PCTS.length; i++) {
      var v = rfUsdAt(rfx, dec31, RF_YT_PCTS[i]);
      if (v == null) out += '<td title="' + RF_NO_HEIGHT + '">—</td>';
      else if (estPast) out += '<td class="yt-est" title="' + RF_EST_HEIGHT + '">' + esc(fmtUSD(v * scale)) + " est.</td>";
      else out += "<td>" + esc(fmtUSD(v * scale)) + "</td>";
    }
    return out;
  }
  // Same tint rule as the power-law table, against the 50% line: green at or above
  // fair value, red below; the year in progress compares at its latest close's date.
  // No tint when that date's height is only estimated (U9).
  function rfTintClass(rfx, y, nowY, close, dec31) {
    if (!rfx || !close) return "";
    var actualPrice = close[1];
    if (actualPrice == null || !isFinite(actualPrice)) return "";
    var cmpMs = dec31;
    if (y === nowY) { var d = dateToMs(String(close[0])); if (d != null) cmpMs = d; }
    var hi = rfInfoAt(rfx, cmpMs);
    if (!hi || (hi.est && hi.past)) return "";
    var fair = rfUsdAt(rfx, cmpMs, 50);
    if (fair == null) return "";
    return actualPrice >= fair ? "yt-hi" : "yt-lo";
  }
  // Pure CSV builder for this mode: Year, [BTC held], Actual close/value, Block
  // height at 31 December, whether that height is estimated (anything not in the
  // stored series), then every ladder line ascending. BOM + CRLF and the 2-decimal
  // rule exactly as the power-law export.
  function buildYearEndCsvRf(rfx, series, holdings, endYear) {
    var BOM = "﻿";
    var mode = !!(holdings && holdings.enabled);
    var header = ["Year"];
    if (mode) header.push("BTC held");
    header.push(mode ? "Actual value" : "Actual close");
    header.push("Block height");
    header.push("Height estimated");
    for (var i = 0; i < RF_CSV_PCTS.length; i++) header.push(mode ? (RF_CSV_PCTS[i].label + " value") : RF_CSV_PCTS[i].label);
    var lines = [header.join(",")];
    for (var y = 2010; y <= endYear; y++) {
      var dec31 = Date.UTC(y, 11, 31);
      var scale = mode ? holdingsForYear(y, holdings) : 1;
      var row = [String(y)];
      if (mode) row.push(fmtBtc(holdingsForYear(y, holdings)));
      var close = lastCloseInSeries(series, y);
      var actual = close ? close[1] : null;
      row.push((actual != null && isFinite(actual)) ? (actual * scale).toFixed(2) : "");
      var hi = rfInfoAt(rfx, dec31);
      row.push(hi && isNum(hi.h) ? String(Math.round(hi.h)) : "");
      row.push(hi ? (hi.est ? "yes" : "no") : "");
      for (i = 0; i < RF_CSV_PCTS.length; i++) {
        var v = rfUsdAt(rfx, dec31, RF_CSV_PCTS[i].p);
        row.push(v == null ? "" : (v * scale).toFixed(2));
      }
      lines.push(row.join(","));
    }
    return BOM + lines.join("\r\n");
  }
  // Export file name per mode; the power-law name is the v0.1.5 one, unchanged.
  function csvFileName(isRf, m) {
    return (isRf ? "btc-refraction-year-end_" : "btc-powerlaw-year-end_") + fittedDate(m) + ".csv";
  }

  // The table's model-specific parts behind one object, so renderYearTable() stays
  // a single code path for both models.
  function tableModel() {
    var rfx = rfCtx();
    if (rfx) {
      return {
        cells: function (ms, sc) { return rfModelCells(rfx, ms, sc); },
        tint: function (y, nowY, close, ms) { return rfTintClass(rfx, y, nowY, close, ms); },
        headPrice: "ytHeadRfPrice", headHold: "ytHeadRfHoldings", otherPrice: "ytHeadPrice", otherHold: "ytHeadHoldings"
      };
    }
    var m = lastModel;
    return {
      cells: function (ms, sc) { return modelCells(m, ms, sc); },
      tint: function (y, nowY, close, ms) { return actualTintClass(m, y, nowY, close, ms); },
      headPrice: "ytHeadPrice", headHold: "ytHeadHoldings", otherPrice: "ytHeadRfPrice", otherHold: "ytHeadRfHoldings"
    };
  }

  // ---- percentile table (spec 6.5) -----------------------------------------
  // Rows top-down (the ladder reversed), the 50% fair value emphasised; columns
  // Today and the same date 1 / 3 / 5 years later, every height from the page's
  // one rule — so "Today" is exactly the status block's height.
  var PT_YEARS = [0, 1, 3, 5];
  // Pure: the table's numbers for a fit, the height map and "now" ({h, ms, live}).
  function pctTableData(fit, hm, now) {
    var t0 = new Date(utcDay(now.ms)), cols = [], rows = [], i, j;
    for (i = 0; i < PT_YEARS.length; i++) {
      var ms = Date.UTC(t0.getUTCFullYear() + PT_YEARS[i], t0.getUTCMonth(), t0.getUTCDate());
      cols.push({ years: PT_YEARS[i], ms: ms, h: RF.heightAt(hm, ms, now) });
    }
    for (j = RF.LINES.length - 1; j >= 0; j--) {
      var L = RF.LINES[j], vals = [];
      for (i = 0; i < cols.length; i++) vals.push(RF.linePriceAt(fit, L.p, cols[i].h));
      rows.push({ p: L.p, name: L.name, color: L.color, vals: vals });
    }
    return { cols: cols, rows: rows };
  }
  // The last completed daily close: the server's exact record when it sent one
  // (B1), else the client's grid estimate (flagged approx; est when its height is
  // not a stored one).
  function lastCloseStats(fit, hm, series, status, now) {
    var lc = status && status.lastClose;
    if (lc && isNum(lc.usd) && isNum(lc.height) && typeof lc.date === "string") {
      return { date: lc.date, usd: lc.usd, h: lc.height, pct: isNum(lc.percentile) ? lc.percentile : NaN,
               fair: isNum(lc.fairValue) ? lc.fairValue : RF.linePriceAt(fit, 50, lc.height), approx: false, est: false };
    }
    for (var i = series.length - 1; i >= 0; i--) {
      var row = series[i];
      if (row[2] === 1 || !(row[1] > 0)) continue;
      var ms = dateToMs(String(row[0]));
      var hi = ms == null ? null : RF.heightInfo(hm, ms, now);
      if (!hi) return null;
      return { date: String(row[0]), usd: row[1], h: hi.h, pct: RF.percentileOf(fit, hi.h, row[1]),
               fair: RF.linePriceAt(fit, 50, hi.h), approx: true, est: hi.est };
    }
    return null;
  }
  function renderPctTable() {
    var on = rfActive();
    show("pctTableCard", on);
    if (!on) return;
    var now = rfNow(), ref = rfNowRef();
    if (!now || !ref) return;
    var data = pctTableData(rfFit, hmap, ref);
    var head = '<th scope="col">Line</th>';
    var LBL = ["Today", "1 year", "3 years", "5 years"];
    for (var i = 0; i < data.cols.length; i++) {
      var c = data.cols[i];
      head += '<th scope="col">' + LBL[i] + '<span class="th-sub">' + esc(isoDay(c.ms)) + '</span><span class="th-sub"><span class="th-word">block </span>' + esc(fmtInt(Math.round(c.h))) + "</span></th>";
    }
    setHtml("ptHead", head);
    // the rule under the lowest line still at or above today's percentile marks
    // where the live price sits on the ladder
    var spotRow = -1;
    if (isNum(now.percentile)) {
      for (var k = 0; k < data.rows.length; k++) if (data.rows[k].p >= now.percentile) spotRow = k;
    }
    var html = "";
    for (var j = 0; j < data.rows.length; j++) {
      var r = data.rows[j];
      var cls = (r.p === 50 ? "pt-fair" : "") + (j === spotRow ? " pt-spot" : "");
      html += '<tr class="' + cls + '"><td class="pt-line"><span class="pt-line-in"><span class="pt-sw" style="background:' + r.color + '"></span>' +
        r.p + "%" + (r.name ? ' <span class="pt-name">' + r.name + "</span>" : "") + "</span></td>";
      for (var q = 0; q < r.vals.length; q++) html += "<td>" + usdBoth(r.vals[q]) + "</td>";
      html += "</tr>";
    }
    setHtml("pctTableRows", html);
    var lc = lastCloseStats(rfFit, hmap, priceSeries, now, ref);
    var stale = rfStaleDays();
    var tile = function (l, v, sub) { return '<div class="mstile"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s">' + sub + "</div></div>"; };
    setHtml("pctTableStats", lc ?
      tile("Last daily close", usdBoth(lc.usd), esc(lc.date) + esc(staleSuffix(isNum(stale) ? stale : 0)) + " · block " + esc(fmtInt(Math.round(lc.h))) + (lc.est ? " est." : "")) +
      tile("Its percentile", esc(fmtPctile(lc.pct, lc.approx)), "share of all days that closed lower") +
      tile("Fair value then", usdBoth(lc.fair), "50% line at that close") : "");
    setText("pctTableFoot", "Today is block " + fmtInt(Math.round(now.heightNow)) + (now.heightIsLive ? " (live chain tip)" : " (estimated)") +
      ". Each horizon adds 144 blocks per calendar day to the same date that many years later, so those heights are projections." +
      (spotRow >= 0 ? " The green rule marks where today's price sits on the ladder." : ""));
  }

  // ---- the switch (spec 6.1) ------------------------------------------------
  function wireModelSwitch() {
    var pl = $("model_powerLaw"), rfb = $("model_refraction");
    if (pl) pl.addEventListener("click", function () { setModelSetting("powerLaw"); });
    if (rfb) rfb.addEventListener("click", function () { if (!rfb.disabled) setModelSetting("refraction"); });
  }
  // Writes the server setting (follows the user across devices; never refits).
  // The page switches at once. The PUTs are SERIALISED (U1): one in flight at a
  // time, and when it returns, the latest requested value is sent again if it
  // differs — so the server ends in the last requested state, no reply can be
  // overtaken by an older one, and the page matches the server after the last
  // reply. A refused final PUT reverts to the last value the server confirmed.
  var modelWant = null, modelInFlight = false, modelConfirmed = null;
  function setModelSetting(v) {
    if (!settingsCache) { toast("Settings not loaded yet", "info"); return; }
    if (modelConfirmed === null) modelConfirmed = settingsCache.model || "powerLaw";
    modelWant = v;
    settingsCache.model = v;
    setV("cfg_model", v); formModel = v;
    applyMode();
    pumpModel();
  }
  async function pumpModel() {
    if (modelInFlight) return;
    modelInFlight = true;
    for (;;) {
      var v = modelWant;
      if (v === modelConfirmed) break;
      var res = await apiPut("/api/settings", { model: v });
      if (res.ok && res.data) modelConfirmed = res.data.model || v;
      if (modelWant !== v) continue;          // the user switched again meanwhile
      if (res.ok && res.data) {
        settingsCache = res.data;
      } else {
        settingsCache.model = modelConfirmed;
        modelWant = modelConfirmed;
        toast(res.error || "Could not switch the model", "error");
      }
      setV("cfg_model", settingsCache.model || "powerLaw"); formModel = settingsCache.model || "powerLaw";
      reflectModelNote();
      applyMode();
      break;
    }
    modelInFlight = false;
  }
  function markModelSwitch() {
    var on = rfActive(), reason = rfUnavailableReason();
    var pl = $("model_powerLaw"), rfb = $("model_refraction");
    if (pl) { pl.className = "seg" + (on ? "" : " seg-on"); pl.setAttribute("aria-pressed", on ? "false" : "true"); }
    if (rfb) {
      rfb.className = "seg" + (on ? " seg-on" : "");
      rfb.setAttribute("aria-pressed", on ? "true" : "false");
      rfb.disabled = !!reason;
      if (reason) rfb.title = reason; else rfb.removeAttribute("title");
    }
  }
  function reflectModelNote() {
    var e = $("err_model");
    if (!e) return;
    e.textContent = (val("cfg_model") === "refraction" && !rfReady() && lastModel && heightsLoaded) ?
      "Refraction is not available yet - the page shows the power law until it is." : "";
  }

  // ---- block heights: load, retry, refresh (U2) ----------------------------
  // /api/heights is fetched with every model reload. While it is missing (404, or
  // a failed request) and the status says a Refraction fit exists, the status poll
  // retries with backoff (next poll, then 20 s, 40 s ... capped at 5 min); once
  // loaded, it is reloaded when the status height runs more than a day (144
  // blocks) past the map's last stored day, at most every 10 minutes.
  var heightsFails = 0, heightsNextTry = 0, heightsLoading = false, heightsError = "", heightsRefreshAt = 0;
  async function loadHeights() {
    heightsLoading = true;
    var res = await apiGet("/api/heights");
    heightsLoading = false;
    heightsLoaded = true;
    var map = res.ok ? RF.heightMap(res.data) : null;
    if (map) {
      hmap = map; heightsFails = 0; heightsError = "";
      if (chartReady && window.PLChart.setHeights) window.PLChart.setHeights(res.data);
    } else {
      // keep a map we already have when a refresh fails; drop it only if none
      heightsFails++;
      heightsNextTry = Date.now() + (heightsFails <= 1 ? 0 : Math.min(300000, 10000 * Math.pow(2, heightsFails - 1)));
      heightsError = res.ok ? "malformed reply" : (res.status === 404 ? "" : (res.error || "request failed"));
      if (!hmap && chartReady && window.PLChart.setHeights) window.PLChart.setHeights(null);
    }
    rfMilestoneCache = null;
  }
  function maybeRetryHeights(s) {
    if (heightsLoading || !heightsLoaded) return;
    var hasRf = !!(s && (s.refraction || (lastModel && lastModel.refraction)));
    if (!hasRf) return;
    var now = Date.now();
    if (!hmap) {
      if (now < heightsNextTry) return;
      loadHeights().then(applyMode);
      return;
    }
    var hNow = s && s.refraction && isNum(s.refraction.heightNow) ? s.refraction.heightNow : null;
    if (hNow !== null && hNow > hmap.lastH + 144 && now >= heightsRefreshAt) {
      heightsRefreshAt = now + 600000;
      loadHeights().then(applyMode);
    }
  }

  // ---- legend chips for the Refraction lines ---------------------------------
  function wireRfLegend() {
    for (var i = 0; i < RF_LINE_KEYS.length; i++) {
      (function (key) {
        var el = $("lg_" + key);
        if (!el) return;
        el.addEventListener("click", function () {
          rfPrefs.lines[key] = !rfPrefs.lines[key];
          saveRfPrefs();
          markRfLegend();
          var patch = { rfLines: {} };
          patch.rfLines[key] = rfPrefs.lines[key];
          if (window.PLChart) window.PLChart.setPrefs(patch);
        });
      })(RF_LINE_KEYS[i]);
    }
    markRfLegend();
  }
  function markRfLegend() {
    for (var i = 0; i < RF_LINE_KEYS.length; i++) {
      var el = $("lg_" + RF_LINE_KEYS[i]);
      if (el) el.setAttribute("aria-pressed", rfPrefs.lines[RF_LINE_KEYS[i]] === true ? "true" : "false");
    }
  }

  // Swap every data-rf / data-rf-aria string in the shell for its Refraction
  // wording (or back to the original, remembered on the first swap).
  function swapModeText(on) {
    if (!document.querySelectorAll) return;
    var els = document.querySelectorAll("[data-rf]"), i, el;
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (el.plText === undefined) el.plText = el.textContent;
      el.textContent = on ? el.getAttribute("data-rf") : el.plText;
    }
    els = document.querySelectorAll("[data-rf-aria]");
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (el.plAria === undefined) el.plAria = el.getAttribute("aria-label");
      el.setAttribute("aria-label", on ? el.getAttribute("data-rf-aria") : el.plAria);
    }
  }

  // Lay the page out for the active model. Cheap and idempotent: called whenever
  // an input to the decision changes (settings, model, heights, the pill, status).
  function applyMode() {
    var on = false;
    try { on = rfActive(); } catch (e) { on = false; }
    markModelSwitch();
    reflectModelNote();
    if (on !== appliedMode) {
      appliedMode = on;
      swapModeText(on);
      show("plLegendMain", !on); show("rfLegendMain", on);
      show("plLegendMore", !on); show("rfLegendMore", on);
      applyExplain();
      if (infoOpenBtn) closeInfo();
    }
    markToggles();
    if (window.PLChart && window.PLChart.setNow) window.PLChart.setNow(on ? rfNowRef() : null);
    if (window.PLChart && window.PLChart.setMode) window.PLChart.setMode(on ? "refraction" : "powerLaw");
    renderRfNotes();
    if (lastModel) renderModel(lastModel);
    if (lastStatus) renderReadouts(lastStatus);
    renderPctTable();
    renderYearTable();
  }

  function renderYearTable() {
    var h = currentHoldings();
    var tm = tableModel();
    syncHoldingsControls(h, tm);
    var body = $("yearTableRows");
    if (!body) return;
    var m = lastModel;
    var endY = projEndYear();
    var caution = cautionYear();
    var nowY = currentUtcYear();
    var mode = h.enabled;
    var html = "";
    var anyBeyond = false;
    for (var y = 2010; y <= endY; y++) {
      var dec31 = Date.UTC(y, 11, 31);
      var close = lastCloseOfYear(y);
      var actualPrice = close ? close[1] : null;
      var scale = mode ? holdingsForYear(y, h) : 1;
      // v0.1.4: only the actual close / value cell is tinted (green at/above trend,
      // red below), with the fair same-date comparison for the year in progress.
      var tint = tm.tint(y, nowY, close, dec31);
      // Leading columns: Year, then either (BTC input + Actual value) or (Actual close).
      var lead;
      if (mode) {
        var override = h.perYear[String(y)];
        var hasOv = typeof override === "number" && isFinite(override);
        var btcCell = '<td class="yt-btc-cell"><input class="yt-btc-input" type="number" min="0" max="21000000" step="any" inputmode="decimal" data-year="' + y +
          '" value="' + (hasOv ? esc(fmtBtc(override)) : "") + '" placeholder="' + esc(h.globalBtc ? fmtBtc(h.globalBtc) : "0") +
          '" aria-label="BTC held at end of ' + y + '"></td>';
        var avCell;
        if (close && y === nowY) avCell = '<td class="yt-prog' + (tint ? " " + tint : "") + '" title="year in progress">' + esc(fmtUSD(actualPrice * scale)) + " ·</td>";
        else if (close) avCell = "<td" + (tint ? ' class="' + tint + '"' : "") + ">" + esc(fmtUSD(actualPrice * scale)) + "</td>";
        else avCell = "<td>—</td>";
        lead = "<td>" + y + "</td>" + btcCell + avCell;
      } else {
        var actualTd;
        if (close && y === nowY) actualTd = '<td class="yt-prog' + (tint ? " " + tint : "") + '" title="year in progress">' + esc(fmtUSD(actualPrice)) + " ·</td>";
        else if (close) actualTd = "<td" + (tint ? ' class="' + tint + '"' : "") + ">" + esc(fmtUSD(actualPrice)) + "</td>";
        else actualTd = "<td>—</td>";
        lead = "<td>" + y + "</td>" + actualTd;
      }
      var cells = tm.cells(dec31, scale);
      var beyond = y > caution;
      if (beyond) anyBeyond = true;
      var rowCls = "yt-row" + (y === nowY ? " yt-now" : "") + (beyond ? " yt-beyond" : "");
      html += '<tr class="' + rowCls + '">' + lead + cells + "</tr>";
    }
    body.innerHTML = html;
    show("yearTableFoot", anyBeyond);
    if (mode) wireHoldingsRowInputs();
  }

  // Wire the per-row BTC inputs (rebuilt on every render). Blur or Enter commits the
  // per-year override; empty clears it back to the global amount. Each commit PUTs the
  // whole holdings object.
  function wireHoldingsRowInputs() {
    var body = $("yearTableRows");
    if (!body) return;
    var inputs = body.querySelectorAll(".yt-btc-input");
    for (var i = 0; i < inputs.length; i++) {
      (function (inp) {
        inp.addEventListener("blur", function () { commitPerYear(inp); });
        inp.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.keyCode === 13) { ev.preventDefault(); inp.blur(); }
        });
      })(inputs[i]);
    }
  }
  async function commitPerYear(inp) {
    var year = inp.getAttribute("data-year");
    var raw = String(inp.value == null ? "" : inp.value).trim();
    var h = currentHoldings();
    var prev = h.perYear[year];
    var hadPrev = typeof prev === "number" && isFinite(prev);
    var next = holdingsClone(h);
    if (raw === "") {
      if (!hadPrev) { renderYearTable(); return; }
      delete next.perYear[year];
    } else {
      var v = Number(raw);
      if (!isFinite(v) || v < 0) { toast("Enter a valid BTC amount", "error"); renderYearTable(); return; }
      if (hadPrev && prev === v) { renderYearTable(); return; }
      next.perYear[year] = v;
    }
    await putHoldings(next);
  }

  // Mode toggle + global-BTC control wiring (called once at boot).
  function wireHoldingsMode() {
    var pe = $("ytMode_price"), he = $("ytMode_holdings");
    if (pe) pe.addEventListener("click", function () { setHoldingsEnabled(false); });
    if (he) he.addEventListener("click", function () { setHoldingsEnabled(true); });
    var gi = $("ytGlobalBtc");
    if (gi) {
      gi.addEventListener("blur", function () { commitGlobalBtc(gi); });
      gi.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.keyCode === 13) { ev.preventDefault(); gi.blur(); } });
    }
  }
  async function setHoldingsEnabled(on) {
    var h = currentHoldings();
    if (h.enabled === on) return;
    var next = holdingsClone(h);
    next.enabled = on;
    await putHoldings(next);
  }
  async function commitGlobalBtc(gi) {
    var raw = String(gi.value == null ? "" : gi.value).trim();
    var h = currentHoldings();
    var v = raw === "" ? 0 : Number(raw);
    if (!isFinite(v) || v < 0) { toast("Enter a valid BTC amount", "error"); renderYearTable(); return; }
    if (v === h.globalBtc) { renderYearTable(); return; }
    var next = holdingsClone(h);
    next.globalBtc = v;
    await putHoldings(next);
  }

  function renderMilestones(ms) {
    var jan = {};
    var jl = ms.janFirstValues || [];
    for (var i = 0; i < jl.length; i++) jan[jl[i].year] = jl[i].usd;
    var years = [2030, 2035, 2040, 2045];
    for (var y = 0; y < years.length; y++) {
      setText("ms_" + years[y], jan[years[y]] != null ? fmtUSD(jan[years[y]]) : "—");
    }
    // $1M trend crossing date
    var cross = ms.crossings || [];
    var oneM = null, hundredK = null, tenM = null;
    for (var c = 0; c < cross.length; c++) {
      if (cross[c].usd === 1000000) oneM = cross[c].date;
      else if (cross[c].usd === 100000) hundredK = cross[c].date;
      else if (cross[c].usd === 10000000) tenM = cross[c].date;
    }
    setText("ms_1m", oneM ? oneM : "—");
    setText("ms_1m_sub", hundredK ? ("$100k " + hundredK) : (tenM ? ("$10M " + tenM) : ""));
  }

  function renderFalsifiability(f) {
    var chip = function (ok, label) {
      var cls = ok === false ? "fchip-bad" : (ok === true ? "fchip-ok" : "fchip-unk");
      return '<span class="fchip ' + cls + '">' + esc(label) + "</span>";
    };
    setHtml("falsifiability",
      chip(f.exponentInRange, "n in [5,7]") +
      chip(f.r2Healthy, "R² healthy") +
      chip(f.aboveFloor, "above floor"));
  }

  async function reloadModelAndPrices() {
    var before = lastModel ? { n: lastModel.n, r2: lastModel.r2 } : null;
    var rfBefore = rfFit ? { b1: rfFit.b1, c: rfFit.c } : null;
    var okM = await loadModel();
    await loadHeights();
    await loadPrices();
    applyMode();
    if (userRefitPending && okM && lastModel && rfActive()) {
      userRefitPending = false;
      toast("Model updated — b1=" + (rfBefore ? fmtN4(rfBefore.b1) + "→" : "") + fmtN4(rfFit.b1) +
        ", c=" + (rfBefore ? fmtN4(rfBefore.c) + "→" : "") + fmtN4(rfFit.c), "ok");
    } else if (userRefitPending && okM && lastModel) {
      userRefitPending = false;
      var msg;
      // 4-decimal n and before→after R² so the drift is visible
      // ("n=5.6209→5.6211, R²=0.9600→0.9601").
      if (before) msg = "Model updated — n=" + fmtN4(before.n) + "→" + fmtN4(lastModel.n) + ", R²=" + fmtN4(before.r2) + "→" + fmtN4(lastModel.r2);
      else msg = "Model updated — n=" + fmtN4(lastModel.n) + ", R²=" + fmtN4(lastModel.r2);
      toast(msg, "ok");
    }
  }

  // =========================================================================
  //  EVENTS
  // =========================================================================
  // force (boot-only) mirrors loadStatus: populate a hidden-tab load once, but
  // keep the hidden guard for the polling interval.
  async function loadEvents(force) {
    if (!force && document.hidden) return;
    var res = await apiGet("/api/events?limit=20");
    if (res.ok) renderEvents(res.data || []);
  }
  function renderEvents(list) {
    lastEvents = list || [];
    if (!rfReady()) markModelSwitch();
    var box = $("eventsList"), empty = $("eventsEmpty");
    if (!box) return;
    if (!list.length) { box.innerHTML = ""; if (empty) empty.style.display = "block"; return; }
    if (empty) empty.style.display = "none";
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var ev = list[i] || {};
      var kind = ev.kind || "info";
      var cls = "chip-info";
      if (kind === "refit" || kind === "ok" || kind === "fit") cls = "chip-ok";
      else if (kind === "warn" || kind === "divergent") cls = "chip-warn";
      else if (kind === "error" || kind === "fail") cls = "chip-error";
      html += '<li class="log-item">' +
        '<span class="chip ' + cls + '">' + esc(kind) + "</span>" +
        '<div class="log-main">' +
        '<div class="log-title">' + esc(ev.msg || "") + "</div>" +
        '<div class="log-sub">' + relSpan(ev.at) + "</div>" +
        "</div></li>";
    }
    box.innerHTML = html;
    refreshRelTimes();
  }

  // =========================================================================
  //  JOBS  (Update-Model progress, ETA, initial-sync overlay)
  // =========================================================================
  // force (boot-only) mirrors loadStatus: populate a hidden-tab load once, but
  // keep the hidden guard for the interval-driven polling.
  async function loadJob(force) {
    if (!force && document.hidden) return;
    var res = await apiGet("/api/job");
    if (!res.ok) return;
    var d = res.data || {};
    var cur = d.current, last = d.last;
    renderJob(cur, last);
    var running = !!(cur && cur.state === "running");
    if (running) { jobEta = { base: cur.etaSeconds, at: Date.now() }; }
    if (running !== jobActive) {
      jobActive = running;
      if (!rfReady()) markModelSwitch();
      setJobRate(running ? 1000 : 5000);
      if (!running) onJobFinished(last || cur);
    }
  }
  function setJobRate(ms) { if (jobTimer) clearInterval(jobTimer); jobTimer = setInterval(loadJob, ms); }

  function renderJob(cur, last) {
    var running = !!(cur && cur.state === "running");
    show("jobBadge", running);
    var isInit = running && cur.kind === "initial-sync";
    // refit strip (compact, under the header)
    var showStrip = running && !isInit;
    show("refitStrip", showStrip);
    if (showStrip) fillProgress("refit", cur);
    // initial-sync overlay progress (overlay visibility itself is driven by status)
    if (isInit || (lastStatus && lastStatus.initialSyncDone === false)) {
      fillProgress("init", cur || { step: "starting", pct: 0, stepIndex: 0, stepCount: 5, etaSeconds: null, state: "running" });
    }
  }
  function fillProgress(prefix, job) {
    var pct = Math.max(0, Math.min(100, Math.round(job.pct || 0)));
    var fill = $(prefix + "BarFill"); if (fill) fill.style.width = pct + "%";
    setText(prefix + "Pct", pct + "%");
    var idx = job.stepIndex != null ? (job.stepIndex + 1) : "";
    var cnt = job.stepCount != null ? job.stepCount : "";
    var stepLbl = STEP_LABELS[job.step] || job.step || "working";
    setText(prefix + "Step", stepLbl + (idx && cnt ? ("  (" + idx + "/" + cnt + ")") : ""));
    setText(prefix + "Eta", etaText(job));
  }
  var STEP_LABELS = {
    "fetch-history": "Fetching full price history",
    "fetch-spot": "Reading live spot prices",
    "reconcile": "Reconciling into store",
    "fit": "Fitting power-law model",
    "persist": "Saving results",
    "starting": "Starting…"
  };
  function etaText(job) {
    var base = (job && job.etaSeconds != null) ? job.etaSeconds : jobEta.base;
    if (base == null) return "";
    var remain = base;
    if (jobEta.at) remain = Math.max(0, base - (Date.now() - jobEta.at) / 1000);
    if (remain <= 0) return "finishing…";
    return "~" + Math.round(remain) + "s remaining";
  }
  function tickJobEta() {
    if (!jobActive) return;
    if (lastStatus && lastStatus.initialSyncDone === false) setText("initEta", etaText({}));
    if ($("refitStrip") && $("refitStrip").style.display !== "none") setText("refitEta", etaText({}));
  }
  function onJobFinished(job) {
    show("refitStrip", false);
    show("jobBadge", false);
    if (job && job.state === "error") {
      userRefitPending = false;
      toast("Model update failed — " + (job.error || "unknown error"), "error");
    }
    // pull fresh status/events; fittedAt change will hot-swap model+prices,
    // and reloadModelAndPrices() fires the completion toast when user-driven.
    loadStatus();
    loadEvents();
    reloadModelAndPrices();
  }

  // Update-Model button
  function wireUpdateButton() {
    var btn = $("updateBtn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var old = busy(btn, "Updating…");
      var res = await apiPost("/api/refit", {});
      unbusy(btn, old);
      if (res.ok) {
        userRefitPending = true;
        toast("Model update started", "info");
        jobActive = true; setJobRate(1000); loadJob();
      } else if (res.status === 409) {
        toast("A model update is already running", "info");
        jobActive = true; setJobRate(1000); loadJob();
      } else {
        toast(res.error || "Could not start model update", "error");
      }
    });
  }

  // A band-mode change only takes effect at the next fit (the bands are computed
  // during the refit), so a settings save that switched modes starts one itself
  // instead of leaving the chart showing the old methodology (spec 15.3). A 409 is
  // tolerated SILENTLY — a run is already in flight and will pick up the new mode.
  async function autoRefitForBandMode() {
    toast("Band mode changed — updating the model…", "info");
    var res = await apiPost("/api/refit", {});
    if (res.ok || res.status === 409) {
      userRefitPending = true;
      jobActive = true; setJobRate(1000); loadJob();
    } else {
      toast(res.error || "Could not start model update", "error");
    }
  }

  // =========================================================================
  //  SETTINGS DRAWER
  // =========================================================================
  var settingsCache = null;
  var SOURCES = ["blockchainInfo", "bitstamp", "binance", "kraken", "coinbase", "mempoolSpace", "coingecko", "coinmetrics", "blockstream"];

  // (U10) Re-read the settings when the tab becomes visible and about once a
  // minute, so a model switch made on another device is followed. Only the cached
  // settings and the model select (when untouched) are updated — never the rest
  // of the form, which may hold unsaved edits — and nothing while a switch of our
  // own is in flight.
  async function refreshSettings() {
    if (document.hidden || modelInFlight || !settingsCache) return;
    var res = await apiGet("/api/settings");
    if (!res.ok || !res.data || modelInFlight) return;
    var untouched = val("cfg_model") === formModel;
    settingsCache = res.data;
    modelConfirmed = settingsCache.model || "powerLaw";
    modelWant = modelConfirmed;
    if (untouched) { setV("cfg_model", modelConfirmed); formModel = modelConfirmed; }
    applyMode();
  }
  async function loadSettings() {
    var res = await apiGet("/api/settings");
    if (res.ok) { settingsCache = res.data || {}; fillSettingsForm(settingsCache); renderYearTable(); applyMode(); }
  }
  function fillSettingsForm(c) {
    c = c || {};
    setV("cfg_refitIntervalHours", c.refitIntervalHours != null ? c.refitIntervalHours : 12);
    setV("cfg_spotPollMinutes", c.spotPollMinutes != null ? c.spotPollMinutes : 5);
    setV("cfg_projectionEndYear", c.projectionEndYear != null ? c.projectionEndYear : 2045);
    setV("cfg_bandMode", c.bandMode || "pointInTime");
    setV("cfg_model", c.model === "refraction" ? "refraction" : "powerLaw");
    formModel = c.model === "refraction" ? "refraction" : "powerLaw";
    setV("cfg_sourceMode", c.sourceMode || "auto");
    var en = c.enabledSources || {};
    for (var i = 0; i < SOURCES.length; i++) setC("cfg_src_" + SOURCES[i], en[SOURCES[i]] !== false);
    reflectSourceMode();
    reflectModelNote();
  }
  function reflectSourceMode() {
    var manual = val("cfg_sourceMode") === "manual";
    for (var i = 0; i < SOURCES.length; i++) { var el = $("cfg_src_" + SOURCES[i]); if (el) el.disabled = !manual; }
    show("sourcesFieldset", true);
    var note = $("sourceModeNote");
    if (note) note.textContent = manual ? "Manual — pick exactly which sources to use." : "Auto — all sources are used; toggles are read-only.";
  }
  function collectSettings() {
    var en = {};
    for (var i = 0; i < SOURCES.length; i++) en[SOURCES[i]] = checked("cfg_src_" + SOURCES[i]);
    var out = {
      refitIntervalHours: numVal("cfg_refitIntervalHours", 12),
      spotPollMinutes: numVal("cfg_spotPollMinutes", 5),
      projectionEndYear: numVal("cfg_projectionEndYear", 2045),
      bandMode: val("cfg_bandMode"),
      sourceMode: val("cfg_sourceMode"),
      enabledSources: en
    };
    // (U10) the model goes into a Save only when this form changed it, so a stale
    // tab cannot write back a choice made since on another device
    var mv = val("cfg_model");
    if (mv && mv !== formModel) out.model = mv;
    return out;
  }
  // client-side pre-validation mirroring spec sections 7 and 3.3
  function validateSettings(s) {
    var e = {};
    if (!(s.refitIntervalHours >= 1 && s.refitIntervalHours <= 168)) e.refitIntervalHours = "1–168 hours";
    if (!(s.spotPollMinutes >= 1 && s.spotPollMinutes <= 60)) e.spotPollMinutes = "1–60 minutes";
    if (!(s.projectionEndYear >= 2030 && s.projectionEndYear <= 2055)) e.projectionEndYear = "2030–2055";
    if (s.bandMode !== "pointInTime" && s.bandMode !== "fullSample" && s.bandMode !== "quantileRegression") e.bandMode = "invalid band mode";
    if (s.model !== undefined && s.model !== "powerLaw" && s.model !== "refraction") e.model = "invalid model";
    if (s.sourceMode !== "auto" && s.sourceMode !== "manual") e.sourceMode = "invalid source mode";
    if (s.sourceMode === "manual") {
      var en = s.enabledSources;
      var historyOk = en.blockchainInfo || (en.bitstamp && en.binance);
      if (!historyOk) e.sources = "history needs blockchainInfo, or both bitstamp and binance";
      var spotCount = 0, spotSrc = ["coinbase", "kraken", "bitstamp", "binance", "mempoolSpace", "coingecko"];
      for (var i = 0; i < spotSrc.length; i++) if (en[spotSrc[i]]) spotCount++;
      if (spotCount < 2) e.sources = (e.sources ? e.sources + "; " : "") + "at least 2 spot sources required";
    }
    return e;
  }
  function clearFieldErrors() { var b = document.querySelectorAll(".field-err"); for (var i = 0; i < b.length; i++) b[i].textContent = ""; }
  function applyFieldErrors(e) { for (var k in e) { if (Object.prototype.hasOwnProperty.call(e, k)) { var el = $("err_" + k); if (el) el.textContent = e[k]; } } }

  function wireSettings() {
    var form = $("settingsForm");
    if (form) {
      form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        // Remembered before the PUT so a save that switched band methodology can
        // kick off the refit that actually applies it (spec 15.3).
        var prevBandMode = settingsCache ? settingsCache.bandMode : null;
        var errBox = $("settingsErrors");
        if (errBox) { errBox.style.display = "none"; errBox.textContent = ""; }
        clearFieldErrors();
        var payload = collectSettings();
        var errs = validateSettings(payload);
        var has = false; for (var k in errs) { if (Object.prototype.hasOwnProperty.call(errs, k)) { has = true; break; } }
        if (has) {
          applyFieldErrors(errs);
          if (errBox) { errBox.textContent = "Fix the highlighted fields before saving."; errBox.style.display = "block"; }
          toast("Settings not saved — see errors", "error");
          return;
        }
        var btn = $("saveSettingsBtn"), old = busy(btn, "Saving…");
        var res = await apiPut("/api/settings", payload);
        unbusy(btn, old);
        if (res.ok) {
          settingsCache = res.data || payload;
          fillSettingsForm(settingsCache);
          renderYearTable();   // projectionEndYear may have changed the row range
          applyMode();         // the model setting may have changed (never refits)
          toast("Settings saved", "ok");
          loadStatus();
          var newBandMode = settingsCache.bandMode || payload.bandMode;
          if (prevBandMode && newBandMode && newBandMode !== prevBandMode) await autoRefitForBandMode();
        } else {
          if (res.errors && res.errors.length) { applyServerErrors(res.errors); if (errBox) { errBox.textContent = res.errors.join("; "); errBox.style.display = "block"; } }
          else if (errBox) { errBox.textContent = res.error; errBox.style.display = "block"; }
          toast(res.error || "Save failed", "error");
        }
      });
    }
    var sm = $("cfg_sourceMode");
    if (sm) sm.addEventListener("change", reflectSourceMode);
    var mdl = $("cfg_model");
    if (mdl) mdl.addEventListener("change", reflectModelNote);
    var toggle = $("settingsToggle");
    if (toggle) toggle.addEventListener("click", function () {
      var body = $("settingsBody");
      if (!body) return;
      var open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      setText("settingsChevron", open ? "▸" : "▾");
    });
  }
  // server errors may be strings or {field,message}; surface both
  function applyServerErrors(errs) {
    for (var i = 0; i < errs.length; i++) {
      var e = errs[i];
      if (e && typeof e === "object" && e.field) { var el = $("err_" + e.field); if (el) el.textContent = e.message || "invalid"; }
    }
  }

  // Year-end table collapsible (v0.1.2): mirrors the settings drawer toggle;
  // expanded by default (the body starts visible in the page shell).
  function wireYearTable() {
    wireHoldingsMode();
    wireExportCsv();
    // (v0.2.0) the percentile table collapses the same way
    var pt = $("pctTableToggle");
    if (pt) pt.addEventListener("click", function () {
      var body = $("pctTableBody");
      if (!body) return;
      var open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      pt.setAttribute("aria-expanded", open ? "false" : "true");
      setText("pctTableChevron", open ? "▸" : "▾");
    });
    var toggle = $("yearTableToggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var body = $("yearTableBody");
      if (!body) return;
      var open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      setText("yearTableChevron", open ? "▸" : "▾");
    });
  }

  // =========================================================================
  //  INFO POPOVERS  (the ⓘ tooltip/explainer system, spec 11.2)
  // =========================================================================
  // Static, page-local help copy keyed by the data-help attribute on each ⓘ
  // button. Every string is a constant baked into the page — never server data —
  // and is rendered via textContent, so no escaping is involved. The
  // enabledSources entry is an array so each source one-liner gets its own line.
  var HELP = {
    fairValue: "What the fitted power law says is a 'normal' price for today: A x t^n with t = days since genesis. It is the long-run trend value, not a prediction or a target.",
    deviation: "How far the live price sits from today's fair value: (spot - fair value) / fair value. Negative means price is below trend (historically 'cheap' relative to the curve); positive means above.",
    quantile: "Where today's deviation ranks against every daily deviation in history. 12% means price has been this far (or further) below trend on only ~12% of all days. 50% = right on the typical day.",
    exponentN: "The power in price = A x t^n - how steeply price has grown with time. It is re-estimated from the full price history at every refit; nothing is hard-coded. Historically it lands around 5.6-5.8.",
    coeffA: "The scale constant in price = A x t^n. It looks tiny because t is counted in days and n is large. A and n move together: each refit re-derives both from the data.",
    r2: "How much of the variation in log price the trend line explains, over the whole history (1.0 = perfect). ~0.96 is a very tight long-run fit - but a high R² alone does not prove the model can predict the future.",
    sigma: "The typical distance of daily prices from the trend, measured in log10 units. 0.30 is about a factor of 2: price has routinely lived anywhere between half and double the trend.",
    days: "The t in the formula: whole days elapsed since Bitcoin's genesis block on 2009-01-03. The fitted numbers only make sense against this fixed starting point.",
    nextRefit: "When the app will next refetch all data and refit the model automatically. Set the cadence in Settings, or press Update model to run one right now.",
    refitInterval: "How often the model refetches every data source and refits all parameters (n, A, R², sigma, bands). Default 12 hours. Lower = fresher parameters and slightly more API traffic; the fit itself only shifts meaningfully as new daily closes arrive.",
    spotPoll: "How often the live price refreshes (median of the responding exchanges). This drives the header ticker, the deviation and quantile tiles, and the provisional 'today' point the next refit will use.",
    projectionEndYear: "How far the trend and bands are drawn into the future on the chart. Anything past ~2040 is hatched because the model's authors themselves say not to rely on it out there.",
    bandMode: [
      "Both modes draw the same kind of lines: 'price has historically closed below this line X% of the time.' They differ only in how history is scored.",
      "Full-sample: every day in history is compared against today's trend line. Simple, but it judges 2011's prices with a curve fitted on everything through today - hindsight. Because the early years sit far from today's line, the extreme percentiles stretch wider: higher tops and lower floors.",
      "Point-in-time (the default, and porkopolis's current method): each day is compared against the trend as it was fitted using only the data available up to that day - what the model would actually have said at the time, with no hindsight. The extreme percentiles, especially the upper ones, come out tighter.",
      "Quantile regression (porkopolis's latest method): instead of drawing bands around the trend, each percentile line is its own regression fitted directly to the price history, with its own slope. Because every Bitcoin cycle so far has swung less far from trend than the one before, these lines converge toward the trend as time passes - the funnel narrows.",
      "Practical effect on the projections: full-sample paints the widest funnel (hindsight stretches the extremes); point-in-time is tighter; quantile regression is different in kind - its funnel narrows over time, so far-future ceilings sit much closer to trend and floors much higher. Parallel bands assume Bitcoin stays as volatile as its whole history; the narrowing funnel assumes the calming trend of the last four cycles continues. Neither is a prediction."
    ],
    yearEndTable: [
      "December 31st values for every year: past years show the actual closing price; every year shows what the current fit puts the trend and the default percentile lines at on that date. All model values are recomputed from live data at every refit, so this whole table shifts slightly as the fit updates. Years past ~2040 are shown faded - the model's own authors say not to lean on it out there.",
      "My holdings mode: enter how much BTC you expect to hold at the end of each year - one amount for every year, or per-year amounts if you plan to keep accumulating. The table then multiplies your holdings by each line's price for that year; past years use the actual closing price. The amounts are stored only on your Umbrel, behind its login. This is a what-if illustration, not financial advice.",
      "For years with an actual close, the actual value is tinted green when the year finished at or above the trend line, red when it finished below - the same above-or-below-trend read as the Deviation tile, year by year. For the year still in progress the comparison uses the trend at the date of the latest close, not December 31st. It is not a judgment of good or bad.",
      "Export CSV downloads this table with full-precision numbers and every percentile line in the current fit - not just the columns shown - ready for Excel or any spreadsheet. In My holdings mode it exports your holdings and their values instead of prices.",
      "The 0.01% column is the model's floor rail - the line only two days in fifteen years have ever closed below."
    ],
    sourceMode: "Auto uses every working source with built-in cross-checks and quorum rules - recommended. Manual lets you choose sources yourself; you must keep a valid history source (blockchain.info, or Bitstamp + Binance together) and at least two spot sources.",
    enabledSources: [
      "blockchainInfo: primary daily history since 2010 (multi-exchange average)",
      "bitstamp: daily history since 2011 + live spot + recent-day fill",
      "binance: daily history since 2017 + live spot + recent-day fill",
      "kraken: recent daily candles + live spot",
      "coinbase: live spot",
      "mempoolSpace: live spot + coarse history cross-check + block-height cross-check and tip",
      "coingecko: last-resort live spot only",
      "coinmetrics: daily block counts (the block-height history) and the daily closes the Refraction model is fitted on",
      "blockstream: chain-tip height only"
    ]
  };

  // v0.2.0: help for the controls this release adds (shared by both modes), and the
  // Refraction wording of every popover. helpBody() picks the active model's copy;
  // keys without a Refraction entry are model-neutral and read the same in both.
  HELP.modelSwitch = [
    "Switches the whole page between two models of Bitcoin's long-run price: the power law (price against calendar days since genesis) and Plan C's Refraction model (price against block height, with lines that narrow over time). The chart, readouts, tables, milestones, CSV and help all follow the switch.",
    "The choice is saved in the app's settings, so it follows you to every device. Switching never refits anything: both models are fitted at every update."
  ];
  HELP.model = "Which model the dashboard shows: the power law, or Plan C's Refraction model. The same switch sits above the chart. Both models are fitted at every update, so changing this never starts a refit.";
  HELP.pctTable = [
    "Each Refraction line's price today and at the same date one, three and five years from now. 'Today' uses the current block height; each horizon adds 144 blocks per calendar day (one block every ten minutes), so those heights - and everything evaluated at them - are projections.",
    "Read a row as 'price has closed below this line on that share of all days so far'. The 50% row is the model's fair value. The cards above the table show the last completed daily close, where it sat on the ladder, and the fair value on that day.",
    "The author publishes projections five years out, which is why the table stops there. Like everything on this page it is recomputed from data at each update and is not financial advice."
  ];
  var HELP_RF = {
    fairValue: "The Refraction model's 50% line at today's block height: price has closed below this line on half of all days in history and above it on the other half. It is the model's middle, not a prediction or a target.",
    deviation: "How far the live price sits from today's fair value: (spot - fair value) / fair value. Negative means price is below the 50% line; positive means above.",
    quantile: "Where the live price sits on the Refraction ladder at today's height: 12% means price has closed this low (relative to the lines) on about 12% of all days. Below 5% puts it under the anchor; 0.1% is the floor.",
    exponentN: "The 0.1% line at today's block height - the floor. Only about one daily close in a thousand has ever been below it, so it rests on a few extreme days. One of the model's own break conditions is price staying under it for a month.",
    coeffA: "The power in the anchor line, A = 10^b0 x height^b1: how steeply the 5% line climbs as blocks are mined. It is re-estimated from the full history at every update; nothing is hard-coded. The sub-line says how many daily closes the fit used and which price series they came from.",
    r2: [
      "How quickly the lines above the anchor bend toward it as the chain grows. The reach of every upper line is multiplied by S = 1 - tanh(c x height / 200,000)^1.25, which starts at 1 and falls slowly toward 0.",
      "c is fitted so that the 99.9% line holds the top 0.1% of closes; the sub-line shows S at today's height (1.0 would mean no narrowing yet)."
    ],
    sigma: "The 99.9% line at today's block height - the top of the ladder. Price has closed above it on about one day in a thousand. It rests on a handful of extreme closes and moves by several percent if the app has to use its fallback price series.",
    days: "The Refraction model's clock: the number of blocks mined so far. 'Live chain tip' means it was read from the network within the last three hours; otherwise it is estimated from the last stored day at 144 blocks per day.",
    refitInterval: "How often the app refetches every data source and refits both models: the power law and the Refraction lines (anchor, decay and every percentile). Default 12 hours. The fit itself only shifts meaningfully as new daily closes arrive.",
    projectionEndYear: "How far the lines are drawn into the future on the chart and in the year-end table. The author of the Refraction model publishes five-year projections; everything right of 'today' is the fitted model extended forward at 144 blocks a day, and the hatch from ~2040 marks the far range, well beyond anything he has published.",
    bandMode: [
      "Applies to the power-law model only: it chooses how the power law's percentile bands are measured. The Refraction model always uses its own calibration - each line is placed so the matching share of all daily closes lies below it.",
      "Changing it starts a refit of the power-law bands; it does not change anything on this Refraction view."
    ],
    yearEndTable: [
      "December 31st values for every year: past years show the actual closing price; every year shows where the Refraction lines sit at that date's block height - the stored height for past years, a projection at 144 blocks per day for future ones (a dash means there is no height; 'est.' marks a past date whose height is not in the stored series). All values are recomputed from live data at every update. Every year after today is the fitted model extended forward; the author publishes five-year projections, and the faded years from ~2040 are far beyond them.",
      "My holdings mode: enter how much BTC you expect to hold at the end of each year - one amount for every year, or per-year amounts. The table then multiplies your holdings by each line's price for that year; past years use the actual closing price. The amounts are stored only on your Umbrel, behind its login. This is a what-if illustration, not financial advice.",
      "For years with an actual close, the actual value is tinted green when the year finished at or above the 50% fair-value line, red when it finished below. For the year still in progress the comparison uses the line at the date of the latest close. It is not a judgment of good or bad.",
      "Export CSV downloads this table with full-precision numbers, the block height used for each year, and every line of the ladder (0.1% to 99.9%) - not just the columns shown. In My holdings mode it exports your holdings and their values instead of prices."
    ]
  };
  function helpBody(key) {
    var body = (rfActive() && HELP_RF[key] != null) ? HELP_RF[key] : HELP[key];
    if (key === "modelSwitch" || key === "model") {
      var reason = rfUnavailableReason();
      if (reason) body = (Array.isArray(body) ? body : [body]).concat(["Refraction: " + reason]);
    }
    return body;
  }

  var infoOpenBtn = null, infoPinned = false;

  function closestInfoBtn(el) {
    while (el && el.nodeType === 1) {
      if (el.classList && el.classList.contains("infobtn")) return el;
      el = el.parentNode;
    }
    return null;
  }
  function inPopover(el) {
    while (el && el.nodeType === 1) { if (el.id === "infoPop") return true; el = el.parentNode; }
    return false;
  }
  // Position the shared popover under (or, if it would overflow, above) the button,
  // clamped to stay inside the viewport. Uses position:fixed viewport coordinates.
  function positionPopover(btn) {
    var pop = $("infoPop"); if (!pop) return;
    var r = btn.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = r.left + r.width / 2 - pw / 2;
    if (left + pw > vw - 8) left = vw - 8 - pw;
    if (left < 8) left = 8;
    var top = r.bottom + 6;
    if (top + ph > vh - 8) { var above = r.top - ph - 6; top = above >= 8 ? above : Math.max(8, vh - 8 - ph); }
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }
  function openInfo(btn, pin) {
    var body = helpBody(btn.getAttribute("data-help"));
    if (body == null) return;
    var pop = $("infoPop"); if (!pop) return;
    if (infoOpenBtn && infoOpenBtn !== btn) { infoOpenBtn.setAttribute("aria-expanded", "false"); infoOpenBtn.removeAttribute("aria-describedby"); }
    pop.textContent = "";
    var lines = Array.isArray(body) ? body : [body];
    for (var i = 0; i < lines.length; i++) {
      var d = document.createElement("div");
      d.className = "infopop-line";
      d.textContent = lines[i];
      pop.appendChild(d);
    }
    pop.classList.add("show");
    positionPopover(btn);
    infoOpenBtn = btn; infoPinned = !!pin;
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-describedby", "infoPop");
  }
  function closeInfo() {
    var pop = $("infoPop");
    if (pop) pop.classList.remove("show");
    if (infoOpenBtn) { infoOpenBtn.setAttribute("aria-expanded", "false"); infoOpenBtn.removeAttribute("aria-describedby"); }
    infoOpenBtn = null; infoPinned = false;
  }
  // hover opens; click/tap toggles (pins); Escape/outside-click closes; one at a time.
  function wireInfo() {
    document.addEventListener("mouseover", function (ev) {
      if (infoPinned) return;
      var btn = closestInfoBtn(ev.target);
      if (btn && btn !== infoOpenBtn) openInfo(btn, false);
    });
    document.addEventListener("mouseout", function (ev) {
      if (infoPinned || !infoOpenBtn) return;
      var to = ev.relatedTarget;
      if (to && (closestInfoBtn(to) === infoOpenBtn || inPopover(to))) return;
      var from = ev.target;
      if (closestInfoBtn(from) === infoOpenBtn || inPopover(from)) closeInfo();
    });
    document.addEventListener("click", function (ev) {
      var btn = closestInfoBtn(ev.target);
      if (btn) {
        ev.preventDefault();
        if (infoOpenBtn === btn && infoPinned) closeInfo();
        else openInfo(btn, true);
        return;
      }
      if (!inPopover(ev.target)) closeInfo();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" || ev.keyCode === 27) closeInfo();
    });
    window.addEventListener("resize", function () { if (infoOpenBtn) positionPopover(infoOpenBtn); });
    window.addEventListener("scroll", function () { if (infoOpenBtn) positionPopover(infoOpenBtn); }, true);
  }

  // =========================================================================
  //  TICKER + BOOT
  // =========================================================================
  function tick() {
    refreshRelTimes();
    renderNextRefit();
    tickJobEta();
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { loadStatus(); loadJob(); loadEvents(); refreshSettings(); if (window.PLChart) window.PLChart.resize(); }
  });

  function boot() {
    mountChart();
    wireControls();
    wireUpdateButton();
    wireSettings();
    wireYearTable();
    wireInfo();
    // Boot-time loads force through the document.hidden guard so a page opened in
    // a background tab is fully populated (the interval pollers below keep it).
    loadSettings().then(function () { loadStatus(true); });
    loadEvents(true);
    loadJob(true);
    setJobRate(5000);
    setInterval(loadStatus, 10000);
    setInterval(loadEvents, 20000);
    setInterval(refreshSettings, 60000);
    setInterval(tick, 1000);
  }

  // Expose the pure year-end CSV builder (spec 14) and the pure year-end model-cell
  // renderer (spec 17) so the Export CSV click flow and the smoke-test harness can
  // reach them. Both are DOM-free functions of their arguments. Nothing else on the
  // app is global.
  window.PLApp = {
    buildYearEndCsv: buildYearEndCsv, modelCells: modelCells,
    // v0.2.0 Refraction helpers, pure functions of their arguments (spec 6.9)
    rf: {
      buildYearEndCsv: buildYearEndCsvRf, modelCells: rfModelCells, tintClass: rfTintClass,
      pctTableData: pctTableData, lastCloseStats: lastCloseStats, milestones: rfMilestones,
      falsifiability: rfFalsifiability, csvFileName: csvFileName
    },
    // the page's current decision, for the boot-harness tests
    mode: function () { return rfActive() ? "refraction" : "powerLaw"; },
    unavailableReason: rfUnavailableReason
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;
