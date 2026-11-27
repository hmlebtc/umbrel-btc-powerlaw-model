// Dashboard Refraction mode (v0.2.0, spec 6.2 / 6.9).
//
// 1. Cross-check: the client's ES5 evaluators (REFRACTION_JS, concatenated into
//    both CHART_JS and APP_JS) are evaluated with `new Function` and compared
//    with the engine (src/refraction.ts) on the SAME real fit — fixture prices
//    joined to the bundled block-height snapshot — for a spread of percentiles and
//    heights, past and projected. Agreement must be 1e-9 relative.
// 2. App behaviour without a browser: the REAL APP_JS is booted against a small
//    recording DOM and a routed fetch stub (no network), so the tests can observe
//    which mode the page settles in, what the readouts / tables / CSV say, and the
//    disabled-pill rule when the fit carries no refraction block.
//
// The harness never reimplements app or engine logic; it only supplies globals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { REFRACTION_JS } from "./ui/refractionClient.js";
import { CHART_JS } from "./ui/chart.js";
import { APP_JS } from "./ui/app.js";
import { DASHBOARD_HTML } from "./ui/dashboard.js";
import {
  anchorLogAt,
  decayAt,
  fitRefraction,
  linePriceAt,
  offsetAt,
  percentileOf,
  projectHeight,
  REFRACTION_LADDER,
  type RefractionFit,
  type RefractionObservation,
} from "./refraction.js";
import { HISTORY_FIXTURE } from "./fixtures/history.js";
import { heightsFromSnapshot } from "./fixtures/heights.js";

// ---------------------------------------------------------------------------
// Shared real inputs: fixture closes joined to the snapshot's true heights.
// ---------------------------------------------------------------------------

const HEIGHTS = heightsFromSnapshot();
const H_BY_DATE = new Map(HEIGHTS.map((o) => [o.date, o.h] as [string, number]));
const SAMPLE: RefractionObservation[] = [];
for (const o of HISTORY_FIXTURE) {
  const h = H_BY_DATE.get(o.date);
  if (h !== undefined && h > 0) SAMPLE.push({ date: o.date, usd: o.usd, h });
}
const FIT: RefractionFit = fitRefraction(SAMPLE);
const HEIGHTS_API = {
  start: (HEIGHTS[0] as { date: string }).date,
  end: (HEIGHTS[HEIGHTS.length - 1] as { date: string }).date,
  count: HEIGHTS.length,
  heights: HEIGHTS.map((o) => o.h),
  tip: null,
};
const LAST_H = (HEIGHTS[HEIGHTS.length - 1] as { h: number }).h;
const LAST_DATE = HEIGHTS_API.end;

type RFApi = {
  LADDER: number[];
  readFit(r: unknown): RefractionFit | null;
  decayAt(c: number, a: number, h: number): number;
  anchorLogAt(f: unknown, h: number): number;
  offsetAt(f: unknown, p: number): number;
  linePriceAt(f: unknown, p: number, h: number): number;
  percentileOf(f: unknown, h: number, usd: number): number;
  dayMs(s: string): number;
  heightMap(api: unknown): unknown;
  LINES: Array<{ p: number; key: string; name: string; color: string; def: boolean; yt: boolean }>;
  heightInfo(hm: unknown, ms: number, now?: unknown): { h: number; est: boolean; past: boolean } | null;
  heightAt(hm: unknown, ms: number, now?: unknown): number;
  crossingDay(f: unknown, hm: unknown, p: number, usd: number, a: number, b: number, now?: unknown): number | null;
};
function loadRF(): RFApi {
  return new Function(REFRACTION_JS + "\nreturn RF;")() as RFApi;
}

function relClose(a: number, b: number, tol: number, what: string): void {
  assert.ok(Number.isFinite(a) && Number.isFinite(b), what + ": non-finite " + a + " / " + b);
  const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
  assert.ok(rel <= tol || a === b, what + ": client " + a + " vs engine " + b + " (rel " + rel + ")");
}

const PCTS = [0.1, 0.2, 0.25, 0.7, 1, 2.5, 4.99, 5, 5.01, 6, 7.5, 12, 15, 25, 33.3, 50, 62.5, 75, 90, 95, 97.5, 99, 99.5, 99.9];
const PAST_DATES = ["2010-08-18", "2011-06-08", "2013-12-04", "2015-01-14", "2017-12-17", "2020-03-12", "2021-11-10", "2024-04-20"];
const FUTURE_DATES = ["2027-01-01", "2028-04-17", "2030-12-31", "2035-06-30", "2040-12-31", "2045-12-31", "2055-12-31"];

// ===========================================================================
//  6.2 cross-check
// ===========================================================================

test("the shared snippet is concatenated into both CHART_JS and APP_JS (written once)", () => {
  assert.ok(CHART_JS.includes(REFRACTION_JS), "CHART_JS lacks the shared Refraction snippet");
  assert.ok(APP_JS.includes(REFRACTION_JS), "APP_JS lacks the shared Refraction snippet");
  // exactly once each, and only these two scripts carry it
  assert.equal(CHART_JS.split("PLREFRACTION_MATH").length - 1, 1, "snippet duplicated inside CHART_JS");
  assert.equal(APP_JS.split("PLREFRACTION_MATH").length - 1, 1, "snippet duplicated inside APP_JS");
  assert.equal(DASHBOARD_HTML.split("PLREFRACTION_MATH").length - 1, 2, "page should carry the snippet twice (one per script)");
  // the ladder matches the engine's
  assert.deepEqual(loadRF().LADDER, REFRACTION_LADDER.slice(), "client ladder differs from REFRACTION_LADDER");
});

test("client evaluators match src/refraction.ts to 1e-9 on a real fit (past and projected heights)", () => {
  const RF = loadRF();
  const fit = RF.readFit(FIT);
  assert.ok(fit, "readFit rejected a real engine fit");
  const heights: number[] = [];
  for (const d of PAST_DATES) heights.push(H_BY_DATE.get(d) as number);
  for (const d of FUTURE_DATES) heights.push(projectHeight(LAST_H, LAST_DATE, d));
  heights.push(1, 1000, 210000, 5e6, 2e7); // extremes: tiny, decayed, collapsed
  let n = 0;
  for (const h of heights) {
    assert.ok(h > 0, "bad test height " + h);
    relClose(RF.decayAt(FIT.c, FIT.alpha, h), decayAt(FIT.c, FIT.alpha, h), 1e-9, "decayAt h=" + h);
    relClose(RF.anchorLogAt(fit, h), anchorLogAt(FIT, h), 1e-9, "anchorLogAt h=" + h);
    for (const p of PCTS) {
      relClose(RF.offsetAt(fit, p), offsetAt(FIT, p), 1e-9, "offsetAt p=" + p);
      relClose(RF.linePriceAt(fit, p, h), linePriceAt(FIT, p, h), 1e-9, "linePriceAt p=" + p + " h=" + h);
      n++;
    }
    // percentile of prices spread across (and beyond) the ladder at this height
    for (const p of [0.05, 0.1, 0.6, 3, 5, 9, 40, 50, 80, 99.9, 100]) {
      const usd = linePriceAt(FIT, Math.min(99.9, Math.max(0.1, p)), h) * (p > 99.9 ? 3 : p < 0.1 ? 0.5 : 1.0001);
      const a = RF.percentileOf(fit, h, usd);
      const b = percentileOf(FIT, h, usd);
      relClose(a, b, 1e-9, "percentileOf p~" + p + " h=" + h);
    }
  }
  assert.ok(n > 400, "too few cross-check points: " + n);
  // bad input agrees too
  assert.ok(Number.isNaN(RF.linePriceAt(fit, 50, 0)) && Number.isNaN(linePriceAt(FIT, 50, 0)), "h=0 must be NaN in both");
  assert.ok(Number.isNaN(RF.percentileOf(fit, 900000, -1)) && Number.isNaN(percentileOf(FIT, 900000, -1)), "usd<0 must be NaN in both");
});

test("client date -> height map: stored days by index, projection = engine projectHeight, none before the series", () => {
  const RF = loadRF();
  const hm = RF.heightMap(HEIGHTS_API);
  assert.ok(hm, "heightMap rejected the snapshot payload");
  for (const d of PAST_DATES.concat(["2009-01-09", LAST_DATE])) {
    const info = RF.heightInfo(hm, RF.dayMs(d));
    assert.ok(info, "no height for stored day " + d);
    assert.equal(info.h, H_BY_DATE.get(d), "stored height mismatch on " + d);
    assert.equal(info.est, false, d + " should not be marked estimated");
    // any instant during the day maps to that day
    assert.equal(RF.heightAt(hm, RF.dayMs(d) + 86400000 - 1), H_BY_DATE.get(d), "late-in-day lookup off on " + d);
  }
  for (const d of FUTURE_DATES) {
    const info = RF.heightInfo(hm, RF.dayMs(d));
    assert.ok(info && info.est, "projected day " + d + " should be estimated");
    assert.equal(info.h, projectHeight(LAST_H, LAST_DATE, d), "projection disagrees with the engine on " + d);
  }
  // before the first day there is no model; day 0 of the chain (h = 0) has none either
  assert.equal(RF.heightInfo(hm, RF.dayMs("2009-01-02")), null, "a day before the series should have no height");
  assert.equal(RF.heightInfo(hm, RF.dayMs("2009-01-03")), null, "a zero height should mean no model");
  // the one height rule with a "now": later days = now.h + 144 per day from today;
  // today itself is now.h exactly (est unless live); never below the last stored day
  const nowMs = RF.dayMs("2026-11-27") + 13 * 3600000;
  const now = { h: LAST_H + 300, ms: nowMs, live: true };
  assert.deepEqual(RF.heightInfo(hm, RF.dayMs("2026-11-27"), now), { h: LAST_H + 300, est: false, past: false });
  assert.deepEqual(RF.heightInfo(hm, RF.dayMs("2027-11-27"), now), { h: LAST_H + 300 + 144 * 365, est: true, past: false });
  assert.deepEqual(RF.heightInfo(hm, RF.dayMs("2031-11-27"), now), { h: LAST_H + 300 + 144 * (365 * 5 + 1), est: true, past: false });
  // a day between the stored end (2026-11-25) and today is a gap: estimated AND past
  assert.deepEqual(RF.heightInfo(hm, RF.dayMs("2026-11-26"), now), { h: LAST_H + 156, est: true, past: true });
  assert.equal(RF.heightInfo(hm, RF.dayMs("2026-11-26"), { h: LAST_H - 500, ms: nowMs })?.h, LAST_H, "a stale now must not run below the stored height");
  // stored days ignore "now"
  assert.deepEqual(RF.heightInfo(hm, RF.dayMs("2020-03-12"), now), { h: H_BY_DATE.get("2020-03-12"), est: false, past: true });
  // malformed payloads are rejected rather than half-read
  for (const bad of [null, {}, { start: "x", heights: [1] }, { start: "2009-01-03", heights: [] }, { start: "2009-01-03", heights: [5, 0] }]) {
    assert.equal(RF.heightMap(bad), null, "heightMap accepted " + JSON.stringify(bad));
  }
});

test("readFit rejects incomplete or damaged refraction blocks", () => {
  const RF = loadRF();
  const good = JSON.parse(JSON.stringify(FIT)) as Record<string, unknown>;
  assert.ok(RF.readFit(good));
  for (const k of ["b0", "b1", "c", "alpha", "gridPcts", "gridOffsets"]) {
    const bad = { ...good };
    delete bad[k];
    assert.equal(RF.readFit(bad), null, "readFit accepted a block without " + k);
  }
  assert.equal(RF.readFit({ ...good, gridOffsets: (good.gridOffsets as number[]).slice(1) }), null, "length mismatch accepted");
  assert.equal(RF.readFit({ ...good, b1: NaN }), null, "NaN b1 accepted");
  assert.equal(RF.readFit(null), null);
});

test("crossingDay finds the first day the fair-value line reaches a level", () => {
  const RF = loadRF();
  const fit = RF.readFit(FIT);
  const hm = RF.heightMap(HEIGHTS_API);
  const from = RF.dayMs("2010-08-18");
  const to = Date.UTC(2150, 11, 31);
  const day = RF.crossingDay(fit, hm, 50, 1e6, from, to);
  assert.ok(day !== null, "fair value never reached $1M");
  const before = linePriceAt(FIT, 50, RF.heightAt(hm, (day as number) - 86400000));
  const on = linePriceAt(FIT, 50, RF.heightAt(hm, day as number));
  assert.ok(before < 1e6 && on >= 1e6, "not the first crossing day: " + before + " -> " + on);
  assert.equal(RF.crossingDay(fit, hm, 50, 1e30, from, to), null, "an unreachable level should give null");
});

// ===========================================================================
//  App behaviour: boot the REAL APP_JS against a recording DOM + routed fetch
// ===========================================================================

type FakeEl = {
  id: string; textContent: string; innerHTML: string; value: string; checked: boolean; disabled: boolean;
  className: string; title: string; style: Record<string, string>; attrs: Record<string, string>;
  listeners: Record<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; removeAttribute(k: string): void;
  addEventListener(t: string, h: (ev: unknown) => void): void;
};
function makeEl(id: string): FakeEl {
  const el: FakeEl = {
    id, textContent: "", innerHTML: "", value: "", checked: false, disabled: false, className: "", title: "",
    style: {}, attrs: {}, listeners: {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? (el.attrs[k] as string) : null; },
    removeAttribute(k) { delete el.attrs[k]; if (k === "title") el.title = ""; },
    addEventListener(t, h) { (el.listeners[t] ??= []).push(h); },
  };
  const extra = el as unknown as Record<string, unknown>;
  extra.classList = { add() {}, remove() {}, contains() { return false; } };
  extra.appendChild = () => {};
  extra.querySelectorAll = () => [];
  return el;
}

// A fixed clock for the page: 13:00 UTC on 2026-11-27, two days after the height
// snapshot ends (2026-11-25), so 2026-11-26 is a stored-series gap ("est." + past).
const NOW_MS = Date.UTC(2026, 10, 27, 13, 0, 0);
const NOW_H = LAST_H + 144 * 2;
const NOW_REF = { h: NOW_H, ms: NOW_MS, live: true };
const SPOT = 63000;
const RF_RECORD = { ...FIT, priceSeries: "coinmetrics", fitMs: 300 };
const LAST_FIT_H = H_BY_DATE.get(FIT.dataEnd) as number;
const STATUS_RF = {
  heightNow: NOW_H, heightIsLive: true,
  fairValueNow: linePriceAt(FIT, 50, NOW_H), floorNow: linePriceAt(FIT, 0.1, NOW_H),
  anchorNow: linePriceAt(FIT, 5, NOW_H), topNow: linePriceAt(FIT, 99.9, NOW_H),
  deviationPct: (SPOT / linePriceAt(FIT, 50, NOW_H) - 1) * 100, percentile: percentileOf(FIT, NOW_H, SPOT),
  b1: FIT.b1, c: FIT.c, points: FIT.points, dataEnd: FIT.dataEnd, priceSeries: "coinmetrics",
  staleDays: 139,
  lastClose: { date: FIT.dataEnd, usd: 63187.84, height: LAST_FIT_H, percentile: 8.47, fairValue: linePriceAt(FIT, 50, LAST_FIT_H) },
};
const PL_MODEL = {
  fittedAt: "2026-07-12T09:30:00.000Z", epochDate: "2009-01-03", a: -16.27, n: 5.62, r2: 0.96, sigma: 0.3,
  bandMode: "fullSample",
  bandOffsets: { p0001: -1.2, p005: -0.9, p025: -0.6, p10: -0.45, p165: -0.3, p25: -0.2, p50: 0, p75: 0.2, p835: 0.3, p90: 0.45, p975: 0.6, p995: 0.9, p9999: 1.2 },
  sample: { start: FIT.dataStart, end: FIT.dataEnd, count: FIT.points, includesProvisionalSpot: false },
  projection: { endYear: 2045, cautionAfterYear: 2040 },
  falsifiability: { exponentInRange: true, r2Healthy: true, aboveFloor: true },
  milestones: { crossings: [], janFirstValues: [] }, history: [],
};
const PRICE_ROWS: Array<[string, number, number]> = SAMPLE.map((o) => [o.date, o.usd, 0] as [string, number, number]);

type Reply = { status: number; body: unknown };
interface BootOpts {
  model?: string; refraction?: boolean; heights?: boolean | Array<"ok" | "404" | "fail">; statusRf?: boolean | Record<string, unknown>;
  gatePuts?: boolean; events?: unknown[]; jobRunning?: boolean;
}
interface Boot {
  el(id: string): FakeEl; puts: unknown[]; app: Record<string, unknown>; settings: Record<string, unknown>;
  requests: string[]; intervals: Array<{ fn: () => void; ms: number }>;
  release(i: number): void; flush(): Promise<void>; setNow(ms: number): void;
}
async function boot(opts: BootOpts): Promise<Boot> {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => { let e = els.get(id); if (!e) { e = makeEl(id); els.set(id, e); } return e; };
  const settings: Record<string, unknown> = {
    refitIntervalHours: 12, spotPollMinutes: 5, projectionEndYear: 2045, bandMode: "fullSample",
    model: opts.model ?? "refraction", sourceMode: "auto", enabledSources: {}, holdings: { enabled: false, globalBtc: 0, perYear: {} },
  };
  const model = { ...PL_MODEL, ...(opts.refraction === false ? {} : { refraction: RF_RECORD }) };
  const statusRf = typeof opts.statusRf === "object" ? { ...STATUS_RF, ...opts.statusRf } : STATUS_RF;
  const status = {
    version: "0.2.0", initialSyncDone: true, spot: { usd: SPOT, at: new Date(NOW_MS).toISOString(), stale: false, quorum: 3 },
    model: { fittedAt: PL_MODEL.fittedAt, a: PL_MODEL.a, n: PL_MODEL.n, A: 1e-16, r2: 0.96, sigma: 0.3, points: 5806 },
    fairValueNow: 150000, deviationPct: -58, currentQuantile: 9.7, nextRefitAt: null, refitIntervalHours: 12, sources: [],
    ...(opts.statusRf === false || opts.refraction === false ? {} : { refraction: statusRf }),
  };
  const puts: unknown[] = [];
  const requests: string[] = [];
  const gates: Array<() => void> = [];
  const heightSeq = Array.isArray(opts.heights) ? opts.heights.slice() : null;
  const reply = (r: Reply) => Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  const fetchStub = (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const path = url.split("?")[0] as string;
    requests.push((init && init.method ? init.method : "GET") + " " + path);
    if (init && init.method === "PUT" && path === "/api/settings") {
      const patch = JSON.parse(init.body || "{}") as Record<string, unknown>;
      puts.push(patch);
      const answer = (): Promise<unknown> => { Object.assign(settings, patch); return reply({ status: 200, body: { ok: true, data: { ...settings } } }); };
      if (!opts.gatePuts) return answer();
      return new Promise((resolve) => { gates.push(() => { resolve(answer()); }); });
    }
    switch (path) {
      case "/api/settings": return reply({ status: 200, body: { ok: true, data: { ...settings } } });
      case "/api/status": return reply({ status: 200, body: { ok: true, data: status } });
      case "/api/model": return reply({ status: 200, body: { ok: true, data: model } });
      case "/api/prices": return reply({ status: 200, body: { ok: true, data: { points: PRICE_ROWS } } });
      case "/api/heights": {
        const k = heightSeq ? (heightSeq.length > 1 ? heightSeq.shift() : heightSeq[0]) : (opts.heights === false ? "404" : "ok");
        if (k === "fail") return Promise.reject(new Error("network down"));
        return k === "404" ? reply({ status: 404, body: { ok: false, error: "heights not available yet" } }) : reply({ status: 200, body: { ok: true, data: HEIGHTS_API } });
      }
      case "/api/events": return reply({ status: 200, body: { ok: true, data: opts.events ?? [] } });
      case "/api/job": return reply({ status: 200, body: { ok: true, data: { current: opts.jobRunning ? { state: "running", kind: "refit", pct: 10 } : null, last: null } } });
      default: return reply({ status: 404, body: { ok: false, error: "nope" } });
    }
  };
  const store: Record<string, string> = {};
  const noop = (): void => {};
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  let clock = NOW_MS;
  // a Date whose "now" is the test clock (everything else is the real Date)
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a: unknown[]) { if (a.length === 0) super(clock); else super(...(a as [number])); }
    static override now(): number { return clock; }
  }
  const windowStub: Record<string, unknown> = {
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: noop },
    addEventListener: noop, removeEventListener: noop, innerWidth: 1440, innerHeight: 900,
  };
  const documentStub: Record<string, unknown> = {
    readyState: "complete", hidden: false, getElementById: el, querySelectorAll: () => [],
    createElement: () => makeEl(""), addEventListener: noop, removeEventListener: noop,
    documentElement: { clientWidth: 1440, clientHeight: 900 },
  };
  const factory = new Function("window", "document", "fetch", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "requestAnimationFrame", "Date", APP_JS) as (...a: unknown[]) => void;
  factory(windowStub, documentStub, fetchStub, (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; }, noop, () => 0, noop, () => 0, FixedDate);
  const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  return {
    el, puts, app: windowStub.PLApp as Record<string, unknown>, settings, requests, intervals, flush,
    release: (i: number) => { const g = gates[i]; assert.ok(g, "no PUT #" + i + " waiting"); g(); },
    setNow: (ms: number) => { clock = ms; },
  };
}
const modeOf = (b: Boot): string => (b.app.mode as () => string)();
// the app's fmtUSD falls back to "$" + raw value without the chart engine loaded
const usd = (v: number): string => "$" + v;
const fullUsd = (v: number): string => "$" + Math.round(v).toLocaleString("en-US");
const click = (b: Boot, id: string): void => { for (const h of b.el(id).listeners.click ?? []) h({}); };
// the status poll is the 10 s interval the app registers
const statusPoll = (b: Boot): (() => void) => (b.intervals.find((i) => i.ms === 10000) as { fn: () => void }).fn;

test("Refraction mode: readouts, switch, tables and corner note follow the setting", async () => {
  const b = await boot({ model: "refraction" });
  assert.equal(modeOf(b), "refraction");
  // the nine tiles carry the status block's values
  assert.equal(b.el("ro_fairValue").textContent, usd(STATUS_RF.fairValueNow));
  assert.equal(b.el("ro_n").textContent, usd(STATUS_RF.floorNow), "Floor now tile");
  assert.equal(b.el("ro_sigma").textContent, usd(STATUS_RF.topNow), "Top now tile");
  assert.equal(b.el("ro_A").textContent, FIT.b1.toFixed(3), "b1 tile");
  assert.equal(b.el("ro_r2").textContent, FIT.c.toFixed(4), "c tile");
  assert.equal(b.el("ro_quantile").textContent, STATUS_RF.percentile.toFixed(1) + "%", "exact percentile: no ≈");
  assert.equal(b.el("ro_days").textContent, NOW_H.toLocaleString("en-US"));
  assert.equal(b.el("ro_days_sub").textContent, "live chain tip");
  assert.equal(b.el("ro_A_sub").textContent, FIT.points.toLocaleString("en-US") + " closes · fit through " + FIT.dataEnd, "U3 b1 sub-line");
  assert.ok(b.el("ro_r2_sub").textContent.startsWith("S = "), "c sub-line shows S");
  // switch state
  assert.equal(b.el("model_refraction").disabled, false);
  assert.equal(b.el("model_refraction").getAttribute("aria-pressed"), "true");
  assert.equal(b.el("model_powerLaw").getAttribute("aria-pressed"), "false");
  // per-mode chrome
  assert.equal(b.el("pctTableCard").style.display, "", "percentile card should show");
  assert.equal(b.el("ytHeadRfPrice").style.display, "");
  assert.equal(b.el("ytHeadPrice").style.display, "none");
  assert.equal(b.el("rfLegendMain").style.display, "");
  assert.equal(b.el("plLegendMain").style.display, "none");
  assert.equal(b.el("bandModeNote").textContent, "Refraction (Plan C) · Coin Metrics closes · fit through " + FIT.dataEnd, "U3 corner note");
  assert.match(b.el("rfExplainSources").textContent, /Coin Metrics daily closes/, "U8 data-source sentence from priceSeries");
  // falsifiability: the two Refraction chips replace the three power-law ones
  const f = b.el("falsifiability").innerHTML;
  assert.ok(f.includes("above the 0.1% floor") && f.includes("no month below the floor"), f);
  assert.ok(!f.includes("n in [5,7]"), "power-law chip leaked into Refraction mode");
});

test("U3: a fit more than 3 days behind shows the warning chip and the last-close age", async () => {
  const b = await boot({ model: "refraction" });
  const chip = b.el("rfStaleChip");
  assert.equal(chip.style.display, "", "stale chip should show at staleDays 139");
  assert.equal(chip.textContent, "fit is 139 days behind");
  const stats = b.el("pctTableStats").innerHTML;
  assert.ok(stats.includes(FIT.dataEnd + " (139 days old)"), stats);
  // the header tile uses the server's exact lastClose percentile, with a % and no ≈
  assert.ok(stats.includes(">8.5%<"), "exact last-close percentile expected: " + stats);
  assert.ok(!stats.includes("≈"), stats);
  // current fit: no chip
  const fresh = await boot({ model: "refraction", statusRf: { staleDays: 0 } });
  assert.equal(fresh.el("rfStaleChip").style.display, "none");
  // without B1's lastClose the client estimate is shown, marked ≈
  const est = await boot({ model: "refraction", statusRf: { lastClose: null } });
  assert.match(est.el("pctTableStats").innerHTML, />≈\d+\.\d%</);
  // and in power-law mode the chip never shows
  const pl = await boot({ model: "powerLaw" });
  assert.equal(pl.el("rfStaleChip").style.display, "none");
});

test("percentile table: Today equals the status block; horizons and Jan-1 milestones match the engine", async () => {
  const b = await boot({ model: "refraction" });
  const rows = b.el("pctTableRows").innerHTML.split("</tr>").filter((r) => r.includes("<td"));
  assert.equal(rows.length, 9, "rows 99.9 .. 0.1");
  // [full, abbreviated] of each value cell
  const cells = (r: string): Array<[string, string]> =>
    [...r.matchAll(/<span class="usd-full">([^<]*)<\/span><span class="usd-abbr">([^<]*)<\/span>/g)].map((m) => [m[1] as string, m[2] as string]);
  const expectRow = [STATUS_RF.topNow, null, null, STATUS_RF.fairValueNow, null, null, STATUS_RF.anchorNow, null, STATUS_RF.floorNow];
  const pcts = [99.9, 95, 75, 50, 25, 15, 5, 1, 0.1];
  // horizon heights under the one rule: now.h + 144 per calendar day
  const hz = [NOW_H, NOW_H + 144 * 365, NOW_H + 144 * (3 * 365 + 1), NOW_H + 144 * (5 * 365 + 1)];
  rows.forEach((r, i) => {
    const c = cells(r);
    assert.equal(c.length, 4, "four value cells");
    const today = expectRow[i];
    if (today !== null) assert.equal(c[0]?.[1], usd(today as number), "Today vs status for " + pcts[i]);
    hz.forEach((h, k) => assert.equal(c[k]?.[0], fullUsd(linePriceAt(FIT, pcts[i] as number, h)), "cell " + pcts[i] + " / " + k));
  });
  assert.ok((rows[3] as string).includes("pt-fair"), "the 50% row is emphasised");
  // the pure helper agrees exactly
  const data = (b.app.rf as { pctTableData: (f: unknown, hm: unknown, now: unknown) => { cols: Array<{ h: number }>; rows: Array<{ p: number; vals: number[] }> } })
    .pctTableData(FIT, loadRF().heightMap(HEIGHTS_API), NOW_REF);
  assert.deepEqual(data.cols.map((c) => c.h), hz);
  assert.equal(data.rows[3]?.vals[0], STATUS_RF.fairValueNow, "Today must be the status value bit for bit");
  // Jan-1 milestones under the same rule
  for (const y of [2030, 2035, 2040, 2045]) {
    const days = Math.round((Date.UTC(y, 0, 1) - Date.UTC(2026, 10, 27)) / 86400000);
    assert.equal(b.el("ms_" + y).textContent, usd(linePriceAt(FIT, 50, NOW_H + 144 * days)), "Jan 1 " + y);
  }
  assert.match(b.el("ms_1m").textContent, /^\d{4}-\d{2}-\d{2}$/);
});

test("without a refraction block: power law, pill disabled; 'not fitted yet' vs a failed fit (U6)", async () => {
  const b = await boot({ model: "refraction", refraction: false });
  assert.equal(modeOf(b), "powerLaw");
  const pill = b.el("model_refraction");
  assert.equal(pill.disabled, true, "Refraction pill should be disabled");
  assert.match(pill.title, /^Not fitted yet/);
  assert.equal(b.el("model_powerLaw").getAttribute("aria-pressed"), "true");
  assert.equal(b.el("ro_n").textContent, "5.62", "power-law Exponent n tile should render");
  assert.equal(b.el("pctTableCard").style.display, "none");
  assert.ok(b.el("falsifiability").innerHTML.includes("n in [5,7]"), "power-law chips expected");
  assert.match(b.el("err_model").textContent, /not available yet/, "settings select explains the fallback");
  const running = await boot({ model: "refraction", refraction: false, jobRunning: true });
  assert.match(running.el("model_refraction").title, /running now/);
  const failed = await boot({
    model: "refraction", refraction: false,
    events: [{ at: "2026-07-12T09:29:50.000Z", kind: "refit", msg: "refraction fit failed: decay search ended on the edge" }],
  });
  assert.match(failed.el("model_refraction").title, /could not fit/);
});

test("U2: heights are retried on the status poll after a 404 or a failure, then the mode engages", async () => {
  const b = await boot({ model: "refraction", heights: ["404", "fail", "ok"] });
  assert.equal(modeOf(b), "powerLaw");
  assert.equal(b.el("model_refraction").disabled, true);
  const poll = statusPoll(b);
  poll(); await b.flush();                        // first retry: immediately on the next poll
  assert.equal(b.requests.filter((r) => r === "GET /api/heights").length, 2);
  assert.match(b.el("model_refraction").title, /could not be loaded \(network down\); retrying/);
  poll(); await b.flush();                        // backoff: too soon, no request
  assert.equal(b.requests.filter((r) => r === "GET /api/heights").length, 2, "backoff not honoured");
  b.setNow(NOW_MS + 25000);
  poll(); await b.flush();
  assert.equal(b.requests.filter((r) => r === "GET /api/heights").length, 3);
  assert.equal(modeOf(b), "refraction", "mode should engage once heights load");
  // loaded: a status height more than a day past the map's end reloads the map (once per 10 min)
  const far = await boot({ model: "refraction", statusRf: { heightNow: LAST_H + 400 } });
  statusPoll(far)(); await far.flush();
  statusPoll(far)(); await far.flush();
  assert.equal(far.requests.filter((r) => r === "GET /api/heights").length, 2, "one refresh, throttled");
});

test("U1: the switch is serialised — the server and the page end in the last requested state", async () => {
  const b = await boot({ model: "powerLaw", gatePuts: true });
  assert.equal(modeOf(b), "powerLaw");
  click(b, "model_refraction");
  await b.flush();
  assert.equal(modeOf(b), "refraction", "optimistic switch");
  click(b, "model_powerLaw");                     // while the first PUT is unanswered
  click(b, "model_refraction");
  click(b, "model_powerLaw");
  await b.flush();
  assert.deepEqual(b.puts, [{ model: "refraction" }], "only one PUT in flight");
  assert.equal(modeOf(b), "powerLaw", "page shows the latest request");
  b.release(0); await b.flush();                  // the stale reply must not flip the page back
  assert.equal(modeOf(b), "powerLaw");
  assert.deepEqual(b.puts, [{ model: "refraction" }, { model: "powerLaw" }], "the latest value is sent next");
  b.release(1); await b.flush();
  assert.equal(b.settings.model, "powerLaw");
  assert.equal(modeOf(b), "powerLaw");
  assert.equal(b.el("cfg_model").value, "powerLaw");
  assert.equal(b.puts.length, 2, "nothing more to send");
  // no refit is ever requested by switching
  assert.ok(!b.requests.includes("POST /api/refit"));
});

test("U10: another device's switch is followed; a stale Save does not write the model back", async () => {
  const b = await boot({ model: "powerLaw" });
  b.settings.model = "refraction";                // switched elsewhere
  const minute = (b.intervals.find((i) => i.ms === 60000) as { fn: () => void }).fn;
  minute(); await b.flush();
  assert.equal(modeOf(b), "refraction");
  assert.equal(b.el("cfg_model").value, "refraction");
  // the form's Save, without touching the model select, sends no model key
  b.settings.model = "powerLaw";                  // and back again elsewhere, not yet seen here
  const submit = b.el("settingsForm").listeners.submit?.[0] as (ev: unknown) => void;
  b.el("cfg_refitIntervalHours").value = "12"; b.el("cfg_spotPollMinutes").value = "5"; b.el("cfg_projectionEndYear").value = "2045";
  b.el("cfg_bandMode").value = "fullSample"; b.el("cfg_sourceMode").value = "auto";
  submit({ preventDefault() {} }); await b.flush();
  const put = b.puts[b.puts.length - 1] as Record<string, unknown>;
  assert.ok(put && !("model" in put), "stale Save wrote the model: " + JSON.stringify(put));
  assert.equal(b.settings.model, "powerLaw");
});

test("Refraction readouts fall back to client evaluation when status has no refraction block", async () => {
  const b = await boot({ model: "refraction", statusRf: false });
  assert.equal(modeOf(b), "refraction");
  // no tip in the snapshot payload -> projected from the last stored day; the
  // client's grid percentile is marked approximate
  assert.ok(b.el("ro_fairValue").textContent.startsWith("$"));
  assert.match(b.el("ro_days_sub").textContent, /estimated/);
  assert.match(b.el("ro_quantile").textContent, /^≈\d/);
});

test("one table render is time-zone independent", async () => {
  const saved = process.env.TZ;
  const out: string[] = [];
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      const b = await boot({ model: "refraction" });
      out.push(b.el("pctTableRows").innerHTML + b.el("ptHead").innerHTML + b.el("yearTableRows").innerHTML + b.el("ms_1m").textContent);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.ok((out[0] as string).length > 1000);
  assert.equal(out[1], out[0], "Los Angeles render differs from UTC");
  assert.equal(out[2], out[0], "Kiritimati render differs from UTC");
});

// ---- pure helpers: CSV, cells, tint, falsifiability ------------------------

type RfHelpers = {
  buildYearEndCsv: (rfx: unknown, series: unknown, holdings: unknown, endYear: number) => string;
  modelCells: (rfx: unknown, ms: number, scale: number) => string;
  tintClass: (rfx: unknown, y: number, nowY: number, close: unknown, ms: number) => string;
  falsifiability: (f: unknown, hm: unknown, series: unknown, now: unknown, spot: number | null, nowRef?: unknown) => { aboveFloor: boolean | null; noMonthBelow: boolean | null; runBelow: number | null };
  csvFileName: (isRf: boolean, m: unknown) => string;
};
async function helpers(): Promise<{ rf: RfHelpers; plCsv: (m: unknown, s: unknown, h: unknown, y: number) => string; rfx: unknown; hm: unknown }> {
  const b = await boot({ model: "powerLaw" });
  const RF = loadRF();
  const hm = RF.heightMap(HEIGHTS_API);
  return { rf: b.app.rf as RfHelpers, plCsv: b.app.buildYearEndCsv as (m: unknown, s: unknown, h: unknown, y: number) => string, rfx: { fit: RF.readFit(FIT), hm, now: NOW_REF }, hm };
}
const NO_HOLD = { enabled: false, globalBtc: 0, perYear: {} };
const HOLD_2 = { enabled: true, globalBtc: 2, perYear: {} };

test("CSV: Refraction header, file name, every ladder line; the power-law export is unchanged", async () => {
  const { rf, plCsv, rfx } = await helpers();
  const csv = rf.buildYearEndCsv(rfx, PRICE_ROWS, NO_HOLD, 2045);
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Year,Actual close,Block height,Height estimated,0.1%,1%,5%,15%,25%,50%,75%,95%,99.9%");
  assert.equal(lines.length, 1 + (2045 - 2010 + 1));
  const r2020 = (lines.find((l) => l.startsWith("2020,")) as string).split(",");
  assert.equal(r2020[2], String(H_BY_DATE.get("2020-12-31")), "stored height for a past year");
  assert.equal(r2020[3], "no", "a stored height is not estimated");
  assert.equal(r2020[9], linePriceAt(FIT, 50, H_BY_DATE.get("2020-12-31") as number).toFixed(2), "50% cell");
  const r2040 = (lines.find((l) => l.startsWith("2040,")) as string).split(",");
  assert.equal(r2040[1], "", "no actual close in the future");
  // the one height rule: now.h + 144 per day from today
  const d2040 = Math.round((Date.UTC(2040, 11, 31) - Date.UTC(2026, 10, 27)) / 86400000);
  assert.equal(r2040[2], String(NOW_H + 144 * d2040), "projected height for a future year");
  assert.equal(r2040[3], "yes");
  const hold = rf.buildYearEndCsv(rfx, PRICE_ROWS, HOLD_2, 2045).slice(1).split("\r\n");
  assert.equal(hold[0], "Year,BTC held,Actual value,Block height,Height estimated,0.1% value,1% value,5% value,15% value,25% value,50% value,75% value,95% value,99.9% value");
  assert.equal(rf.csvFileName(true, { fittedAt: "2026-07-12T09:30:00.000Z" }), "btc-refraction-year-end_2026-07-12.csv");
  assert.equal(rf.csvFileName(false, { fittedAt: "2026-07-12T09:30:00.000Z" }), "btc-powerlaw-year-end_2026-07-12.csv");
  // power-law builder: same header bytes as v0.1.8 even with a refraction block on the model
  const pl = plCsv({ ...PL_MODEL, refraction: RF_RECORD }, PRICE_ROWS, NO_HOLD, 2045);
  assert.equal(pl.slice(1).split("\r\n")[0], "Year,Actual close,0.01%,0.5%,2.5%,10%,16.5%,25%,50%,75%,83.5%,90%,97.5%,99.5%,99.99%,Trend");
  assert.equal(pl, plCsv(PL_MODEL, PRICE_ROWS, NO_HOLD, 2045), "the refraction block changed the power-law CSV");
});

// sha256 of v0.1.8's buildYearEndCsv on exactly these inputs, produced by running
// the v0.1.8 (2a0dbd8) APP_JS itself: the power-law export must stay byte-identical.
const V018_CSV = {
  price: { len: 5185, sha: "227ed415c4878d4f7a0c716c4623a946cdf3090d302d80bb1c41f96e5a7a77fe" },
  holdings: { len: 5281, sha: "f5ec3c40e6e717582da2ab696ddcc25b467b7abfcb2d028f18299be10ce12efd" },
};
test("power-law CSV is byte-identical to v0.1.8 (price and holdings modes)", async () => {
  const { plCsv } = await helpers();
  for (const [name, hold] of [["price", NO_HOLD], ["holdings", { enabled: true, globalBtc: 0.5, perYear: { "2030": 2 } }]] as const) {
    const csv = plCsv({ ...PL_MODEL, refraction: RF_RECORD }, PRICE_ROWS, hold, 2045);
    const want = V018_CSV[name];
    assert.equal(csv.length, want.len, name + " length");
    assert.equal(createHash("sha256").update(csv, "utf8").digest("hex"), want.sha, name + " bytes differ from v0.1.8");
  }
});

test("year-end cells: six ascending Refraction columns, dashes without a height, tint vs the 50% line", async () => {
  const { rf, rfx } = await helpers();
  const cells = [...rf.modelCells(rfx, Date.UTC(2030, 11, 31), 1).matchAll(/<td([^>]*)>([^<]*)<\/td>/g)].map((m) => m[2] as string);
  assert.equal(cells.length, 6, "0.1 | 5 | 50 | 75 | 95 | 99.9");
  const vals = cells.map((c) => Number(c.slice(1)));
  for (let i = 1; i < vals.length; i++) assert.ok((vals[i - 1] as number) < (vals[i] as number), "not ascending: " + cells.join(" "));
  const none = rf.modelCells({ fit: (rfx as { fit: unknown }).fit, hm: null }, Date.UTC(2030, 11, 31), 1);
  assert.equal((none.match(/—/g) || []).length, 6, "no heights -> six dashes");
  assert.ok(none.includes('title="no block height for this date"'));
  const dec31 = Date.UTC(2020, 11, 31);
  const fair = linePriceAt(FIT, 50, H_BY_DATE.get("2020-12-31") as number);
  assert.equal(rf.tintClass(rfx, 2020, 2026, ["2020-12-31", fair * 1.01, 0], dec31), "yt-hi");
  assert.equal(rf.tintClass(rfx, 2020, 2026, ["2020-12-31", fair * 0.99, 0], dec31), "yt-lo");
  assert.equal(rf.tintClass(rfx, 2040, 2026, null, Date.UTC(2040, 11, 31)), "");
  // U9: a past date the store lacks is estimated: cells carry "est.", no tint
  const short = { start: HEIGHTS_API.start, heights: HEIGHTS_API.heights.slice(0, 4018), tip: null }; // ends 2020-01-03
  const rfShort = { fit: (rfx as { fit: unknown }).fit, hm: loadRF().heightMap(short), now: NOW_REF };
  const est = rf.modelCells(rfShort, Date.UTC(2021, 11, 31), 1);
  assert.equal((est.match(/ est\.<\/td>/g) || []).length, 6, "estimated past cells must be marked: " + est);
  assert.equal(rf.tintClass(rfShort, 2021, 2026, ["2021-12-31", 1e9, 0], Date.UTC(2021, 11, 31)), "", "no tint on an estimated height");
  assert.ok(!rf.modelCells(rfShort, Date.UTC(2030, 11, 31), 1).includes("est."), "future cells are projections, not marked est.");
});

test("falsifiability chips: above-floor and the 30-close month rule", async () => {
  const { rf, rfx, hm } = await helpers();
  const fit = (rfx as { fit: unknown }).fit;
  const floorAt = (d: string): number => linePriceAt(FIT, 0.1, H_BY_DATE.get(d) as number);
  const days = HEIGHTS.slice(-40).map((o) => o.date);
  const below = (n: number): Array<[string, number, number]> =>
    days.map((d, i) => [d, floorAt(d) * (i >= days.length - n ? 0.9 : 1.1), 0] as [string, number, number]);
  const now = { floorNow: 50000 };
  assert.deepEqual(rf.falsifiability(fit, hm, below(29), now, 60000), { aboveFloor: true, noMonthBelow: true, runBelow: 29 });
  assert.deepEqual(rf.falsifiability(fit, hm, below(30), now, 40000), { aboveFloor: false, noMonthBelow: false, runBelow: 30 });
  // a provisional today point is not a close
  const prov = below(29).concat([["2099-01-01", 1, 1]]);
  assert.equal(rf.falsifiability(fit, hm, prov, now, null).runBelow, 29);
  assert.equal(rf.falsifiability(fit, hm, prov, now, null).aboveFloor, null);
  // U9: closes on days whose height is only estimated are no evidence (the run stops)
  const gap = below(29).concat([["2026-11-26", 1, 0]]);   // after the stored end, before "today"
  assert.equal(rf.falsifiability(fit, hm, gap, now, null, NOW_REF).runBelow, 0);
});

// ---- page shell (spec 6.9 ids) and the chart engine ------------------------

test("the page shell carries every Refraction id, hidden by default", () => {
  for (const id of ["model_powerLaw", "model_refraction", "explainPanelRf", "pctTableCard", "pctTableRows", "pctTableToggle",
    "ytHeadRfPrice", "ytHeadRfHoldings", "rfLegendMain", "rfLegendMore", "plLegendMain", "plLegendMore", "cfg_model", "err_model",
    "lg_r01", "lg_r1", "lg_r5", "lg_r15", "lg_r25", "lg_r50", "lg_r75", "lg_r95", "lg_r999"]) {
    assert.ok(DASHBOARD_HTML.includes('id="' + id + '"'), "missing id " + id);
  }
  for (const id of ["explainPanelRf", "pctTableCard", "ytHeadRfPrice", "ytHeadRfHoldings", "rfLegendMain", "rfLegendMore"]) {
    assert.ok(DASHBOARD_HTML.includes('id="' + id + '" style="display:none"'), id + " must start hidden");
  }
  // the switch is first in the chart card's control row, and its pills are real buttons
  const ctl = DASHBOARD_HTML.indexOf('<div class="chart-controls">');
  assert.ok(ctl >= 0 && DASHBOARD_HTML.indexOf('id="modelCtl"') > ctl && DASHBOARD_HTML.indexOf('id="modelCtl"') < DASHBOARD_HTML.indexOf('id="xMode_date"'));
  assert.ok(DASHBOARD_HTML.includes('<button class="seg" id="model_refraction" type="button" aria-pressed="false" disabled'));
  assert.ok(DASHBOARD_HTML.includes('data-help="modelSwitch"') && DASHBOARD_HTML.includes('data-help="pctTable"') && DASHBOARD_HTML.includes('data-help="model"'));
  assert.ok(DASHBOARD_HTML.includes("Band mode <span class=\"lbl-note\">(power-law model only)</span>"));
  // explainer credits the author and keeps the caveats, in our own words
  for (const p of ["Plan C (@TheRealPlanC)", "independent re-implementation", "protocol time", "five-year projections", "Not financial advice"]) {
    assert.ok(DASHBOARD_HTML.includes(p), "Refraction explainer missing: " + p);
  }
  const bt = String.fromCharCode(96);
  assert.ok(!REFRACTION_JS.includes(bt) && !REFRACTION_JS.includes("$" + "{"), "REFRACTION_JS leaked a backtick or dollar-brace");
});

function recCtx(): { proxy: Record<string, unknown>; seq: Array<{ k: string; n: string; v: unknown }> } {
  const seq: Array<{ k: string; n: string; v: unknown }> = [];
  const store: Record<string, unknown> = {};
  const proxy = new Proxy(store, {
    get(_t, p) {
      if (typeof p === "symbol") return undefined;
      if (Object.prototype.hasOwnProperty.call(store, p)) return store[p];
      return (...a: unknown[]) => { seq.push({ k: "call", n: p, v: a }); return undefined; };
    },
    set(_t, p, v) { if (typeof p === "string") { store[p] = v; seq.push({ k: "set", n: p, v }); } return true; },
  });
  return { proxy, seq };
}
const RF_COLORS = ["#FF5C7A", "#FF9F43", "#F5D547", "#ECECEC", "#5EEAD4", "#38BDF8", "#60A5FA", "#818CF8", "#A78BFA"];
const PL_BAND_COLORS = ["#E91E63", "#AB47BC", "#F44336", "#FF9800", "#03A9F4", "#26A69A", "#9E9E9E"];
function strokesIn(seq: Array<{ k: string; n: string; v: unknown }>, colors: string[]): number {
  let cur = ""; let n = 0;
  for (const e of seq) {
    if (e.k === "set" && e.n === "strokeStyle") cur = String(e.v);
    else if (e.k === "call" && e.n === "stroke" && colors.includes(cur)) n++;
  }
  return n;
}
function paintChart(setup: (c: Record<string, (x: unknown) => void>) => void): Array<{ k: string; n: string; v: unknown }> {
  const main = recCtx(); const osc = recCtx();
  const canvas = (w: number, h: number, ctx: unknown) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) });
  const win: Record<string, unknown> = { devicePixelRatio: 1, requestAnimationFrame: (cb: () => void) => { cb(); return 1; }, addEventListener() {} };
  (new Function("window", "ResizeObserver", CHART_JS) as (w: unknown, r: unknown) => void)(win, undefined);
  const c = win.PLChart as Record<string, (x?: unknown) => void>;
  c.mount!({ canvas: canvas(900, 460, main.proxy), osc: canvas(900, 126, osc.proxy), tip: { style: {}, innerHTML: "" }, wrap: { clientWidth: 900, clientHeight: 460 }, oscWrap: { clientWidth: 900, clientHeight: 126, offsetParent: {} } });
  c.setModel!({ ...PL_MODEL, refraction: RF_RECORD });
  c.setPrices!({ points: PRICE_ROWS });
  setup(c as Record<string, (x: unknown) => void>);
  main.seq.length = 0;
  c.redraw!();
  return main.seq;
}

test("chart: Refraction mode draws the five default lines and the zones; power law is untouched", () => {
  const rfSeq = paintChart((c) => { c.setHeights!(HEIGHTS_API); c.setMode!("refraction"); });
  assert.equal(strokesIn(rfSeq, RF_COLORS), 5, "default Refraction lines: 0.1 / 5 / 50 / 95 / 99.9");
  assert.equal(strokesIn(rfSeq, PL_BAND_COLORS), 0, "power-law bands leaked into Refraction mode");
  const fills = rfSeq.filter((e) => e.k === "call" && e.n === "fill").length;
  assert.equal(fills, 5, "five filled zones (fill on by default in this mode)");
  // the caption names the five-year horizon
  assert.ok(rfSeq.some((e) => e.k === "call" && e.n === "fillText" && String((e.v as unknown[])[0]).includes("five-year")));
  // every line on
  const all: Record<string, boolean> = {};
  for (const k of ["r01", "r1", "r5", "r15", "r25", "r50", "r75", "r95", "r999"]) all[k] = true;
  const allSeq = paintChart((c) => { c.setHeights!(HEIGHTS_API); c.setPrefs!({ rfLines: all }); c.setMode!("refraction"); });
  assert.equal(strokesIn(allSeq, RF_COLORS), 9);
  // back to power law: exactly the v0.1.8 four default lines, no Refraction colour
  const plSeq = paintChart((c) => { c.setHeights!(HEIGHTS_API); c.setMode!("refraction"); c.setMode!("powerLaw"); });
  assert.equal(strokesIn(plSeq, PL_BAND_COLORS), 4);
  assert.equal(strokesIn(plSeq.filter((e) => !(e.k === "set" && e.v === "#ECECEC")), RF_COLORS), 0);
});

test("chart: Refraction mode without heights keeps the power-law drawing and never throws", () => {
  const seq = paintChart((c) => { c.setMode!("refraction"); });
  assert.equal(strokesIn(seq, PL_BAND_COLORS), 4, "should fall back to the power-law lines");
  const seq2 = paintChart((c) => { c.setHeights!({ start: "2009-01-03", heights: [] }); c.setMode!("refraction"); });
  assert.equal(strokesIn(seq2, PL_BAND_COLORS), 4);
});

test("U5: the column cache changes no draw call (Refraction and power law, idle and hovered)", () => {
  const all: Record<string, boolean> = {};
  for (const L of loadRF().LINES) all[L.key] = true;
  const cfgs: Array<[string, (c: Record<string, (x: unknown) => void>) => void]> = [
    ["rf-default", (c) => { c.setHeights!(HEIGHTS_API); c.setNow!(NOW_REF); c.setMode!("refraction"); }],
    ["rf-all-linear-logdays", (c) => { c.setHeights!(HEIGHTS_API); c.setNow!(NOW_REF); c.setPrefs!({ rfLines: all, yMode: "linear", xMode: "logDays" }); c.setMode!("refraction"); }],
    ["rf-1y-nofill", (c) => { c.setHeights!(HEIGHTS_API); c.setPrefs!({ rfBandFill: false, preset: "1y" }); c.setMode!("refraction"); }],
    ["pl-default", (c) => { c.setHeights!(HEIGHTS_API); c.setMode!("powerLaw"); }],
  ];
  for (const [name, setup] of cfgs) {
    const seqs = [true, false].map((on) => JSON.stringify(paintChart((c) => { c._columnCache!(on); setup(c); })));
    assert.ok((seqs[0] as string).length > 10000, name + ": suspiciously short frame");
    assert.equal(seqs[0], seqs[1], name + ": cached and uncached frames differ");
  }
});

test("Linear Y draws (the v0.1.8 niceNum ReferenceError stays fixed) in both modes", () => {
  for (const mode of ["powerLaw", "refraction"]) {
    let seq: Array<{ k: string; n: string; v: unknown }> = [];
    assert.doesNotThrow(() => { seq = paintChart((c) => { c.setHeights!(HEIGHTS_API); c.setPrefs!({ yMode: "linear" }); c.setMode!(mode); }); }, mode);
    const labels = seq.filter((e) => e.k === "call" && e.n === "fillText" && /^\$\d/.test(String((e.v as unknown[])[0])));
    assert.ok(labels.length >= 3, mode + ": expected linear $ axis labels, got " + labels.length);
    assert.ok(seq.filter((e) => e.k === "call" && e.n === "lineTo").length > 500, mode + ": too few lineTo in linear mode");
  }
});

test("U11: one ladder list — chips, chart colours and the engine ladder all come from RF.LINES", () => {
  const RF = loadRF();
  assert.deepEqual(RF.LINES.map((l) => l.p), REFRACTION_LADDER.slice());
  for (const L of RF.LINES) {
    assert.ok(DASHBOARD_HTML.includes('id="lg_' + L.key + '" data-rfline="' + L.key + '"'), "legend chip for " + L.key);
    assert.ok(CHART_JS.includes("RF.LINES"), "chart must derive its ladder from RF.LINES");
  }
  // no hand-kept copies left in the app or chart scripts
  for (const dead of ["PT_COLORS", "PT_ROWS", "heightOnDate", "heightAfterYears", "refractionReady", "rfSeries"]) {
    assert.ok(!APP_JS.includes(dead) && !CHART_JS.includes(dead), "dead name still present: " + dead);
  }
  assert.ok(!APP_JS.includes('var RF_LINE_KEYS = ["r01"'), "RF_LINE_KEYS must be derived");
});
