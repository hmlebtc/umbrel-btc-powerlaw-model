// UI smoke test (Agent B): the dashboard is a self-contained string assembled
// at import time, so we can assert its shape without a browser.
//
// It verifies that:
//   - the page shell contains the chart canvas, oscillator canvas and tooltip,
//   - every readout card id the app.js code writes to actually exists,
//   - CHART_JS and APP_JS are inlined into the page (marker + real body),
//   - none of the String.raw literals leaked a backtick or a dollar-brace
//     (the template-literal safety invariant from spec section 2 / 8), and
//   - FAVICON_SVG is a well-formed, self-contained SVG that is inlined into the
//     page. This test is deliberately SHAPE-AGNOSTIC: it asserts nothing about
//     the favicon's paths/colors so the artwork can be redesigned freely.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DASHBOARD_HTML } from "./ui/dashboard.js";
import { CHART_JS } from "./ui/chart.js";
import { APP_JS } from "./ui/app.js";
import { FAVICON_SVG } from "./ui/favicon.js";

test("dashboard contains the chart canvas, oscillator and tooltip", () => {
  assert.ok(DASHBOARD_HTML.includes('id="chartCanvas"'), "chart canvas missing");
  assert.ok(DASHBOARD_HTML.includes('id="oscCanvas"'), "oscillator canvas missing");
  assert.ok(DASHBOARD_HTML.includes('id="chartTip"'), "tooltip element missing");
  assert.ok(DASHBOARD_HTML.includes("<canvas"), "no <canvas> element");
});

test("dashboard contains every readout id the app writes to", () => {
  const ids = [
    "ro_fairValue", "ro_deviation", "ro_quantile", "ro_n", "ro_A",
    "ro_r2", "ro_sigma", "ro_days", "ro_nextRefit"
  ];
  for (const id of ids) {
    assert.ok(DASHBOARD_HTML.includes('id="' + id + '"'), "missing readout id " + id);
  }
});

test("dashboard has an info button for every readout tile and settings field", () => {
  // one 16px circled-i popover trigger per readout tile...
  const readoutHelp = [
    "fairValue", "deviation", "quantile", "exponentN", "coeffA",
    "r2", "sigma", "days", "nextRefit"
  ];
  // ...and per settings field / the sources fieldset (spec 11.2)
  const settingsHelp = [
    "refitInterval", "spotPoll", "projectionEndYear", "bandMode",
    "sourceMode", "enabledSources"
  ];
  assert.ok(DASHBOARD_HTML.includes('class="infobtn"'), "no info button markup present");
  for (const id of readoutHelp.concat(settingsHelp)) {
    assert.ok(
      DASHBOARD_HTML.includes('data-help="' + id + '"'),
      "missing info button for " + id,
    );
  }
  // every info trigger is keyboard/AT reachable and starts collapsed
  assert.ok(DASHBOARD_HTML.includes('aria-expanded="false"'), "info button missing aria-expanded");
  // the single shared popover host exists
  assert.ok(DASHBOARD_HTML.includes('id="infoPop"'), "shared info popover host missing");
  // the header spot ticker carries its explanatory title (spec 11.2)
  assert.ok(
    DASHBOARD_HTML.includes("Live price: median of the exchange sources currently responding"),
    "header spot ticker title string missing",
  );
});

test("dashboard has the collapsible chart explainer panel with its verbatim copy", () => {
  assert.ok(DASHBOARD_HTML.includes('id="explainPanel"'), "explainer panel container missing");
  assert.ok(DASHBOARD_HTML.includes('id="explainToggle"'), "explainer toggle button missing");
  assert.ok(DASHBOARD_HTML.includes("What am I looking at?"), "explainer heading missing");
  // one distinctive marker phrase from each of the four verbatim paragraphs
  // (the band paragraph was rewritten for the v0.1.2 individual-line vernacular)
  const markers = [
    "the ring at the end is the live price for today",
    "The default four (2.5/16.5/83.5/97.5) are the classic porkopolis set",
    "The hatched area past ~2040 is where the model's own authors",
    "it is the same information as the bands, flattened out"
  ];
  for (const m of markers) {
    assert.ok(DASHBOARD_HTML.includes(m), "explainer panel missing paragraph marker: " + m);
  }
});

test("dashboard has the per-percentile legend with a More-bands expander", () => {
  // the four default chips are visible in the top legend row...
  for (const key of ["p025", "p165", "p835", "p975"]) {
    assert.ok(DASHBOARD_HTML.includes('id="lg_' + key + '"'), "default legend chip lg_" + key + " missing");
    assert.ok(DASHBOARD_HTML.includes('data-band="' + key + '"'), "default legend chip data-band " + key + " missing");
  }
  // ...and the seven non-default chips (incl. the 50% median) live in the expander row
  for (const key of ["p005", "p10", "p25", "p50", "p75", "p90", "p995"]) {
    assert.ok(DASHBOARD_HTML.includes('id="lg_' + key + '"'), "expander legend chip lg_" + key + " missing");
  }
  // the "More bands" expander chip + its revealed row
  assert.ok(DASHBOARD_HTML.includes('id="moreBandsToggle"'), "More-bands expander toggle missing");
  assert.ok(DASHBOARD_HTML.includes('id="moreBandsRow"'), "More-bands expander row missing");
  assert.ok(DASHBOARD_HTML.includes("More bands"), "More-bands expander label missing");
  // percentile labels are shown on the chips
  for (const label of ["2.5%", "16.5%", "83.5%", "97.5%", "0.5%", "50%", "99.5%"]) {
    assert.ok(DASHBOARD_HTML.includes(">" + label + "<"), "legend chip label " + label + " missing");
  }
  // Price and Trend static indicators are present too
  assert.ok(DASHBOARD_HTML.includes('id="chartLegend"'), "legend row container missing");
  assert.ok(DASHBOARD_HTML.includes('aria-pressed="true"'), "default chips missing aria-pressed");

  // the OLD v0.1.1 pair-chip ids must be gone entirely
  for (const oldKey of ["50", "67", "95", "99"]) {
    assert.ok(!DASHBOARD_HTML.includes('id="lg_' + oldKey + '"'), "stale pair chip lg_" + oldKey + " still present");
  }
});

test("chart explainer swaps in the v0.1.3 pan interaction sentence", () => {
  // the new verbatim interaction sentence (spec 13.1) is present...
  assert.ok(
    DASHBOARD_HTML.includes(
      "Drag to move around the chart, hold Shift and drag to select a range to zoom into, scroll to zoom at the cursor, and double-click to reset the view.",
    ),
    "new v0.1.3 pan interaction sentence missing",
  );
  // ...and the old v0.1.2 sentence is gone (its distinctive opening no longer appears)
  assert.ok(
    !DASHBOARD_HTML.includes("Drag to zoom, scroll to zoom at the cursor, double-click to reset."),
    "old interaction sentence still present",
  );
  assert.ok(!DASHBOARD_HTML.includes("Drag to zoom,"), "stale 'Drag to zoom,' fragment still present");
});

test("year-end table exposes the Price | My-holdings mode toggle and BTC column", () => {
  // the segmented mode toggle (spec 13.2) lives on the table card, not the settings drawer
  assert.ok(DASHBOARD_HTML.includes('id="ytMode_price"'), "Price mode segment missing");
  assert.ok(DASHBOARD_HTML.includes('id="ytMode_holdings"'), "My-holdings mode segment missing");
  assert.ok(DASHBOARD_HTML.includes(">My holdings<"), "My holdings segment label missing");
  // the global BTC input control
  assert.ok(DASHBOARD_HTML.includes('id="ytGlobalBtc"'), "global BTC input missing");
  assert.ok(DASHBOARD_HTML.includes("applies to all years"), "global BTC helper copy missing");
  // the holdings-mode header columns: BTC + Actual value (spec 13.2 header row)
  assert.ok(DASHBOARD_HTML.includes(">BTC</th>"), "holdings BTC column header missing");
  assert.ok(DASHBOARD_HTML.includes(">Actual value</th>"), "holdings Actual value column header missing");
  // the per-row editable BTC input class the app renders into each row
  assert.ok(DASHBOARD_HTML.includes("yt-btc-input"), "per-row BTC input class missing");
});

test("year-end table carries the red/green tint classes (spec 13.3)", () => {
  // tint class rules (green >= actual, red below) present in the page CSS + app markup
  assert.ok(DASHBOARD_HTML.includes("yt-hi"), "green tint class yt-hi missing");
  assert.ok(DASHBOARD_HTML.includes("yt-lo"), "red tint class yt-lo missing");
  // the spec-mandated tint hues
  assert.ok(DASHBOARD_HTML.includes("#42A04C"), "green tint colour missing");
  assert.ok(DASHBOARD_HTML.includes("#EF5350"), "red tint colour missing");
});

test("year-end table help gains the holdings + tinting verbatim paragraphs", () => {
  assert.ok(
    DASHBOARD_HTML.includes(
      "The amounts are stored only on your Umbrel, behind its login. This is a what-if illustration, not financial advice.",
    ),
    "holdings help paragraph missing",
  );
  assert.ok(
    DASHBOARD_HTML.includes("a quick read of which lines contained reality"),
    "tinting help sentence missing",
  );
});

test("dashboard has the year-end model table (title, columns, footnote, info)", () => {
  assert.ok(DASHBOARD_HTML.includes('id="yearTableCard"'), "year-end table card missing");
  assert.ok(DASHBOARD_HTML.includes('id="yearTableRows"'), "year-end table body missing");
  assert.ok(DASHBOARD_HTML.includes("Year-end model table"), "year-end table title missing");
  // the fixed column headers (Year | Actual close | 2.5% | 16.5% | Trend | 83.5% | 97.5%)
  for (const col of ["Year", "Actual close", "2.5%", "16.5%", "Trend", "83.5%", "97.5%"]) {
    assert.ok(DASHBOARD_HTML.includes(">" + col + "</th>"), "year-end table column header " + col + " missing");
  }
  // the beyond-2040 footnote line
  assert.ok(
    DASHBOARD_HTML.includes("Years beyond ~2040 exceed the model author's stated validity horizon."),
    "year-end table footnote missing",
  );
  // the info popover trigger for the card
  assert.ok(DASHBOARD_HTML.includes('data-help="yearEndTable"'), "year-end table info button missing");
});

test("dashboard carries the v0.1.2 verbatim copy phrases (bands + table)", () => {
  const phrases = [
    "with no hindsight",                                    // band-mode help (kept)
    "more conservative funnel",                             // band-mode help (new)
    "descriptions of the past, not statistical guarantees", // explainer band paragraph (new)
    "the classic porkopolis set",                           // explainer band paragraph (new)
    "December 31st values for every year",                  // year-end table help (new)
  ];
  for (const p of phrases) {
    assert.ok(DASHBOARD_HTML.includes(p), "missing verbatim copy phrase: " + p);
  }
});

test("chart tooltip uses percentile labels, never hi/lo wording", () => {
  const backtick = String.fromCharCode(96);
  // the v0.1.1 tooltip appended ' hi' / ' lo' to each pair label — that wording is gone
  assert.ok(!CHART_JS.includes('" hi"'), "tooltip still uses the old ' hi' label suffix");
  assert.ok(!CHART_JS.includes('" lo"'), "tooltip still uses the old ' lo' label suffix");
  // and no BAND_PAIRS-era construct leaked through
  assert.ok(!CHART_JS.includes("BAND_PAIRS"), "chart engine still references the old BAND_PAIRS model");
  assert.ok(!CHART_JS.includes(backtick), "CHART_JS contains a backtick");
});

test("dashboard inlines CHART_JS and APP_JS (markers + bodies)", () => {
  assert.ok(DASHBOARD_HTML.includes("PLCHART_ENGINE"), "CHART_JS marker not inlined");
  assert.ok(DASHBOARD_HTML.includes("PLAPP_MAIN"), "APP_JS marker not inlined");
  assert.ok(DASHBOARD_HTML.includes(CHART_JS), "CHART_JS body not inlined verbatim");
  assert.ok(DASHBOARD_HTML.includes(APP_JS), "APP_JS body not inlined verbatim");
  assert.ok(DASHBOARD_HTML.includes("window.PLChart"), "chart engine body missing");
});

test("dashboard exposes the Update-model control, title and disclaimer", () => {
  assert.ok(DASHBOARD_HTML.includes('id="updateBtn"'), "update button missing");
  assert.ok(DASHBOARD_HTML.includes("<title>BTC Power Law Model</title>"), "title missing");
  assert.ok(DASHBOARD_HTML.includes("Not financial advice"), "disclaimer missing");
});

test("favicon is well-formed self-contained SVG, and inlined (shape-agnostic)", () => {
  const backtick = String.fromCharCode(96);
  const dollarBrace = "$" + "{";
  const svg = FAVICON_SVG.trim();
  // structural well-formedness only — nothing about specific shapes or colors
  assert.ok(svg.startsWith("<svg"), "FAVICON_SVG must start with <svg");
  assert.ok(svg.endsWith("</svg>"), "FAVICON_SVG must end with </svg>");
  assert.ok(
    svg.includes('xmlns="http://www.w3.org/2000/svg"'),
    "FAVICON_SVG must declare the SVG namespace",
  );
  // balanced angle brackets => no obviously truncated markup (SVG attribute
  // values never contain a raw < or >, so opens must equal closes)
  const opens = (svg.match(/</g) || []).length;
  const closes = (svg.match(/>/g) || []).length;
  assert.equal(opens, closes, "FAVICON_SVG has unbalanced < and > (malformed markup)");
  // template-literal safety invariant applies to the favicon string too
  assert.ok(!svg.includes(backtick), "FAVICON_SVG contains a backtick");
  assert.ok(!svg.includes(dollarBrace), "FAVICON_SVG contains a dollar-brace");
  // it is inlined verbatim into the page header
  assert.ok(DASHBOARD_HTML.includes(FAVICON_SVG), "FAVICON_SVG not inlined into the dashboard");
});

test("no String.raw literal leaked a backtick or a dollar-brace", () => {
  const backtick = String.fromCharCode(96);
  const dollarBrace = "$" + "{";
  const parts: Array<[string, string]> = [
    ["DASHBOARD_HTML", DASHBOARD_HTML],
    ["CHART_JS", CHART_JS],
    ["APP_JS", APP_JS],
    ["FAVICON_SVG", FAVICON_SVG]
  ];
  for (const [name, s] of parts) {
    assert.ok(!s.includes(backtick), name + " contains a backtick");
    assert.ok(!s.includes(dollarBrace), name + " contains a dollar-brace");
  }
});

// ===========================================================================
//  BAND-PREFERENCES MIGRATION (spec 12.1, REVISED) — live localStorage repro
// ===========================================================================
// APP_JS is an IIFE that, at eval time, reads window.localStorage['bpl.prefs.v1']
// and (for the legacy v0.1.1 pair shape {50,67,95,99}) migrates prefs.bands to the
// v0.1.2 per-line shape AND persists the new shape immediately. We reproduce a page
// load exactly as Fable's adversarial review did: seed a localStorage stub with the
// legacy shape, evaluate the REAL APP_JS string against thin window/document stubs
// (fetch rejects, so no render path runs and the migration persist is the only
// write), then read the stub back to observe both the migrated map and the fact
// that the legacy pair shape was overwritten. The harness never reimplements any
// app logic — it only supplies the browser globals APP_JS closes over.

interface LocalStorageStub {
  store: Record<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
function makeLocalStorage(seed: string): LocalStorageStub {
  const store: Record<string, string> = { "bpl.prefs.v1": seed };
  return {
    store,
    getItem(k) { const v = store[k]; return v === undefined ? null : v; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

// Evaluate APP_JS with a localStorage seeded to `seed`; return the stub's backing
// store so tests can inspect what was persisted under 'bpl.prefs.v1'.
function evalAppWithPrefs(seed: string): Record<string, string> {
  const localStorage = makeLocalStorage(seed);
  const noop = (): void => {};
  const windowStub: Record<string, unknown> = {
    localStorage,
    addEventListener: noop,
    removeEventListener: noop,
    innerWidth: 1440,
    innerHeight: 900,
  };
  // getElementById returns null everywhere => every DOM writer in APP_JS no-ops
  // (each guards on the element existing); readyState !== "loading" => boot() runs
  // synchronously. The migration + persist happen at module-eval time, before boot.
  const documentStub: Record<string, unknown> = {
    readyState: "complete",
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }),
    addEventListener: noop,
    removeEventListener: noop,
  };
  // fetch rejects; apiGet/apiSend catch it and return {ok:false}, so no status/model
  // render runs and savePrefs is only ever reached by the migration persist.
  const fetchStub = (): Promise<never> => Promise.reject(new Error("no network in test"));
  const setIntervalStub = (): number => 0;
  const clearIntervalStub = noop;
  const setTimeoutStub = (): number => 0;
  const clearTimeoutStub = noop;
  const rafStub = (): number => 0;

  const factory = new Function(
    "window", "document", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "requestAnimationFrame",
    APP_JS,
  ) as (
    w: unknown, d: unknown, f: unknown,
    si: unknown, ci: unknown, st: unknown, ct: unknown, raf: unknown,
  ) => void;
  factory(
    windowStub, documentStub, fetchStub,
    setIntervalStub, clearIntervalStub, setTimeoutStub, clearTimeoutStub, rafStub,
  );

  return localStorage.store;
}

const NEW_DEFAULT_BANDS: Record<string, boolean> = {
  p005: false, p025: true, p10: false, p165: true, p25: false, p50: false,
  p75: false, p835: true, p90: false, p975: true, p995: false,
};
const EXTRA_KEYS = ["p005", "p10", "p25", "p50", "p75", "p90", "p995"];

// The raw JSON persisted under 'bpl.prefs.v1' after a page load, asserting it exists.
function persistedPrefs(store: Record<string, string>): string {
  const raw = store["bpl.prefs.v1"];
  assert.ok(raw, "prefs were not persisted after migration");
  return raw;
}
// The migrated per-line bands map read back out of the persisted prefs.
function persistedBands(store: Record<string, string>): Record<string, boolean> {
  return JSON.parse(persistedPrefs(store)).bands as Record<string, boolean>;
}

// (a) v0.1.1 default (all pairs true) -> exactly the new default set (four on, seven off).
test("legacy v0.1.1 default bands migrate to exactly the new default set", () => {
  const seed = JSON.stringify({ bands: { "50": true, "67": true, "95": true, "99": true } });
  const bands = persistedBands(evalAppWithPrefs(seed));
  assert.deepEqual(bands, NEW_DEFAULT_BANDS, "v0.1.1 default did not migrate to classic-four-on / extras-off");
  // exactly four lines end up on — the eight-line defect must not recur
  const onCount = Object.keys(bands).filter((k) => bands[k] === true).length;
  assert.equal(onCount, 4, "expected exactly four visible bands after migration, got " + onCount);
});

// (b) v0.1.1 with 95:false,67:true -> p025/p975 off, p165/p835 on, extras off.
test("legacy 95:false,67:true migrates the classic pairs and forces extras off", () => {
  const seed = JSON.stringify({ bands: { "95": false, "67": true } });
  const bands = persistedBands(evalAppWithPrefs(seed));
  assert.equal(bands.p025, false, "95:false should map p025 off");
  assert.equal(bands.p975, false, "95:false should map p975 off");
  assert.equal(bands.p165, true, "67:true should map p165 on");
  assert.equal(bands.p835, true, "67:true should map p835 on");
  for (const k of EXTRA_KEYS) {
    assert.equal(bands[k], false, "extra percentile " + k + " must be forced off on migration");
  }
});

// (c) After migration the persisted shape contains p* keys and none of 50/67/95/99.
test("migration persists the new per-line shape, never the legacy pair keys", () => {
  const seed = JSON.stringify({ bands: { "50": true, "67": true, "95": true, "99": true } });
  const store = evalAppWithPrefs(seed);
  const raw = persistedPrefs(store);
  const bands = persistedBands(store);
  for (const k of ["p025", "p165", "p835", "p975"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(bands, k), "persisted bands missing per-line key " + k);
  }
  for (const legacy of ["50", "67", "95", "99"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(bands, legacy), "legacy pair key " + legacy + " survived into persisted bands");
    assert.ok(raw.indexOf('"' + legacy + '"') === -1, 'raw persisted prefs still contain a "' + legacy + '" key');
  }
});

// Regression for the second reported defect: an already-migrated (new-shape) prefs
// must be stable — the migration must NOT re-run and NOT rewrite localStorage each
// load (previously the legacy shape survived and re-migrated on every reload).
test("an already-migrated new-shape prefs load is stable and not rewritten", () => {
  const legacy = JSON.stringify({ bands: { "50": true, "67": true, "95": true, "99": true } });
  const migrated = persistedPrefs(evalAppWithPrefs(legacy));
  const second = persistedPrefs(evalAppWithPrefs(migrated));
  assert.equal(second, migrated, "second load re-migrated / rewrote an already-migrated prefs");
});
