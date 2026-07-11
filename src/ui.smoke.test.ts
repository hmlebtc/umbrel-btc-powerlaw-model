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
