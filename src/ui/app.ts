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

export const APP_JS: string = String.raw`/* PLAPP_MAIN */
"use strict";
(function () {
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
  var prefs = loadPrefs();

  function loadPrefs() {
    var d = { xMode: "date", yMode: "log", bandFill: false, halvings: true, oscillator: true, preset: "full" };
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
      }
    } catch (e) { /* ignore corrupt prefs */ }
    return d;
  }
  function savePrefs() {
    try { window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* quota / private mode */ }
  }

  // =========================================================================
  //  STATE
  // =========================================================================
  var lastStatus = null, lastModel = null, lastFittedAt = null;
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
    window.PLChart.setPrefs({ xMode: prefs.xMode, yMode: prefs.yMode, bandFill: prefs.bandFill, halvings: prefs.halvings, oscillator: prefs.oscillator });
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
    bindToggle("tgBands", "bandFill", function (on) { window.PLChart.setPrefs({ bandFill: on }); });
    bindToggle("tgHalvings", "halvings", function (on) { window.PLChart.setPrefs({ halvings: on }); });
    bindToggle("tgOsc", "oscillator", function (on) {
      show("oscWrap", on);
      window.PLChart.setPrefs({ oscillator: on });
      window.PLChart.resize();
    });
    markActiveMode(); markActiveRange(); markToggles();
    show("oscWrap", prefs.oscillator);
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
    setTog("tgBands", prefs.bandFill);
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

    nextRefitAt = s.nextRefitAt || null;
    renderNextRefit();
    setText("ro_nextRefit_sub", s.refitIntervalHours != null ? ("every " + s.refitIntervalHours + " h") : "");

    renderSources(s.sources || []);

    // initial-sync overlay (full-page progress lives here; filled by the job poll)
    var syncing = s.initialSyncDone === false;
    show("initOverlay", syncing);

    // model + prices are (re)fetched whenever the fit timestamp changes
    if (m && m.fittedAt && m.fittedAt !== lastFittedAt) {
      lastFittedAt = m.fittedAt;
      reloadModelAndPrices();
    } else if (!m && lastFittedAt === null && !syncing) {
      // no fit yet but sync claims done — leave readouts as skeletons
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
    renderModel(res.data);
    if (chartReady) window.PLChart.setModel(res.data);
    return true;
  }
  async function loadPrices() {
    var res = await apiGet("/api/prices?maxPoints=8000");
    if (res.ok && chartReady) window.PLChart.setPrices(res.data);
  }

  function renderModel(m) {
    if (!m) return;
    setText("ro_n", fmtN(m.n));
    setText("ro_A", m.a != null ? ("10^" + Number(m.a).toFixed(3)) : "—");
    setText("ro_r2", m.r2 != null ? Number(m.r2).toFixed(4) : "—");
    setText("ro_sigma", m.sigma != null ? Number(m.sigma).toFixed(4) : "—");
    setText("bandModeNote", m.bandMode === "fullSample" ? "bands: full-sample percentiles" : "bands: point-in-time percentiles");
    renderMilestones(m.milestones || {});
    renderFalsifiability(m.falsifiability || {});
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
    var okM = await loadModel();
    await loadPrices();
    if (userRefitPending && okM && lastModel) {
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

  // =========================================================================
  //  SETTINGS DRAWER
  // =========================================================================
  var settingsCache = null;
  var SOURCES = ["blockchainInfo", "bitstamp", "binance", "kraken", "coinbase", "mempoolSpace", "coingecko"];

  async function loadSettings() {
    var res = await apiGet("/api/settings");
    if (res.ok) { settingsCache = res.data || {}; fillSettingsForm(settingsCache); }
  }
  function fillSettingsForm(c) {
    c = c || {};
    setV("cfg_refitIntervalHours", c.refitIntervalHours != null ? c.refitIntervalHours : 12);
    setV("cfg_spotPollMinutes", c.spotPollMinutes != null ? c.spotPollMinutes : 5);
    setV("cfg_projectionEndYear", c.projectionEndYear != null ? c.projectionEndYear : 2045);
    setV("cfg_bandMode", c.bandMode || "pointInTime");
    setV("cfg_sourceMode", c.sourceMode || "auto");
    var en = c.enabledSources || {};
    for (var i = 0; i < SOURCES.length; i++) setC("cfg_src_" + SOURCES[i], en[SOURCES[i]] !== false);
    reflectSourceMode();
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
    return {
      refitIntervalHours: numVal("cfg_refitIntervalHours", 12),
      spotPollMinutes: numVal("cfg_spotPollMinutes", 5),
      projectionEndYear: numVal("cfg_projectionEndYear", 2045),
      bandMode: val("cfg_bandMode"),
      sourceMode: val("cfg_sourceMode"),
      enabledSources: en
    };
  }
  // client-side pre-validation mirroring spec sections 7 and 3.3
  function validateSettings(s) {
    var e = {};
    if (!(s.refitIntervalHours >= 1 && s.refitIntervalHours <= 168)) e.refitIntervalHours = "1–168 hours";
    if (!(s.spotPollMinutes >= 1 && s.spotPollMinutes <= 60)) e.spotPollMinutes = "1–60 minutes";
    if (!(s.projectionEndYear >= 2030 && s.projectionEndYear <= 2055)) e.projectionEndYear = "2030–2055";
    if (s.bandMode !== "pointInTime" && s.bandMode !== "fullSample") e.bandMode = "invalid band mode";
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
          toast("Settings saved", "ok");
          loadStatus();
        } else {
          if (res.errors && res.errors.length) { applyServerErrors(res.errors); if (errBox) { errBox.textContent = res.errors.join("; "); errBox.style.display = "block"; } }
          else if (errBox) { errBox.textContent = res.error; errBox.style.display = "block"; }
          toast(res.error || "Save failed", "error");
        }
      });
    }
    var sm = $("cfg_sourceMode");
    if (sm) sm.addEventListener("change", reflectSourceMode);
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

  // =========================================================================
  //  TICKER + BOOT
  // =========================================================================
  function tick() {
    refreshRelTimes();
    renderNextRefit();
    tickJobEta();
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { loadStatus(); loadJob(); loadEvents(); if (window.PLChart) window.PLChart.resize(); }
  });

  function boot() {
    mountChart();
    wireControls();
    wireUpdateButton();
    wireSettings();
    // Boot-time loads force through the document.hidden guard so a page opened in
    // a background tab is fully populated (the interval pollers below keep it).
    loadSettings().then(function () { loadStatus(true); });
    loadEvents(true);
    loadJob(true);
    setJobRate(5000);
    setInterval(loadStatus, 10000);
    setInterval(loadEvents, 20000);
    setInterval(tick, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;
