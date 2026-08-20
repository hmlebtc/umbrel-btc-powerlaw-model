// Headless render test for the canvas chart engine (Agent B, spec section 8).
//
// The integration/smoke tests only ever checked that the right element IDs exist
// in the page string — nobody had confirmed the canvas actually PAINTS, because a
// hidden/headless browser parks requestAnimationFrame and never flushes a frame.
//
// This test builds a tiny, HONEST DOM/canvas harness INSIDE the file (zero deps,
// node:test only): a recording 2D context (a Proxy that logs every method call
// and every property assignment), canvas/wrap stubs with clientWidth/clientHeight
// and getContext, a window stub whose requestAnimationFrame runs SYNCHRONOUSLY,
// and a ResizeObserver slot forced to undefined. We then evaluate the REAL
// CHART_JS string with `new Function` against those globals, mount PLChart, feed
// it a REAL fit computed from the committed blockchain.info fixture (no hard-coded
// coefficients) plus the fixture price series, force one clean paint, and assert
// on what the context actually recorded.
//
// The harness is deliberately thin: it never reimplements any chart logic. If the
// engine reaches for a DOM API the stub lacks, the fix is to extend the stub here,
// not to fake the drawing.
//
// NOTE ON IMPORT PATHS: this file compiles to dist/ui.render.test.js (rootDir
// src), so `node --test dist/*.test.js` picks it up, and model/fixture/chart are
// siblings under dist — hence './model.js', './fixtures/history.js',
// './ui/chart.js' (the task's '../model.js' assumed a dist/ui/ location that the
// test glob would not match).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHART_JS } from "./ui/chart.js";
import { computeBandOffsets, fitOLS } from "./model.js";
import { HISTORY_FIXTURE } from "./fixtures/history.js";

// ---------------------------------------------------------------------------
// Recording 2D context: a Proxy that captures method calls and property sets.
// ---------------------------------------------------------------------------

interface Call {
  m: string;
  args: unknown[];
}
interface Assign {
  prop: string;
  value: unknown;
}
// A single ordered timeline entry (a method call OR a property assignment) so a
// test can reconstruct state at the moment of a call — e.g. "which strokeStyle
// was live when this stroke() ran", used to count the dotted band polylines.
type SeqEntry =
  | { kind: "call"; m: string; args: unknown[] }
  | { kind: "set"; prop: string; value: unknown };
interface RecordingCtx {
  calls: Call[];
  sets: Assign[];
  seq: SeqEntry[];
  proxy: CanvasRenderingContext2DLike;
  reset(): void;
}
// Structural type just so we can hand the proxy to the (any-typed) engine.
type CanvasRenderingContext2DLike = Record<string, unknown>;

function makeRecordingCtx(): RecordingCtx {
  const calls: Call[] = [];
  const sets: Assign[] = [];
  const seq: SeqEntry[] = [];
  const store: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      // Return a previously-assigned data property (strokeStyle, font, ...) if
      // the engine reads it back; otherwise treat the access as a method and
      // return a recorder that logs the call.
      if (Object.prototype.hasOwnProperty.call(store, prop)) return store[prop];
      return (...args: unknown[]): undefined => {
        calls.push({ m: prop, args });
        seq.push({ kind: "call", m: prop, args });
        return undefined;
      };
    },
    set(_t, prop, value) {
      if (typeof prop === "string") {
        store[prop] = value;
        sets.push({ prop, value });
        seq.push({ kind: "set", prop, value });
      }
      return true;
    },
  };
  const proxy = new Proxy(store, handler) as CanvasRenderingContext2DLike;
  return {
    calls,
    sets,
    seq,
    proxy,
    reset() {
      calls.length = 0;
      sets.length = 0;
      seq.length = 0;
    },
  };
}

// The v0.1.2 percentile-line colours (six distinct hues; symmetric percentiles
// share a hue, and the 50% median is gray). On the main canvas these appear as
// strokeStyle ONLY inside drawBands (verified against chart.ts: every other
// stroke uses a non-band colour), so counting stroke() calls made while a band
// colour is live counts exactly the visible percentile polylines.
const BAND_COLORS = ["#AB47BC", "#F44336", "#FF9800", "#03A9F4", "#26A69A", "#9E9E9E"];
function countBandPolylines(ctx: RecordingCtx): number {
  let cur: string | null = null;
  let n = 0;
  for (const e of ctx.seq) {
    if (e.kind === "set" && e.prop === "strokeStyle") cur = String(e.value);
    else if (e.kind === "call" && e.m === "stroke" && cur !== null && BAND_COLORS.indexOf(cur) >= 0) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Canvas + layout element stubs.
// ---------------------------------------------------------------------------

interface CanvasStub {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  style: Record<string, string>;
  getContext(type: string): CanvasRenderingContext2DLike;
  addEventListener(type: string, handler: (ev: unknown) => void, opts?: unknown): void;
  removeEventListener(...a: unknown[]): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  // name -> handler, recorded so interaction tests can replay the REAL handlers
  // the engine wired up (mousedown/mousemove/touch*/...) with synthetic events.
  listeners: Record<string, (ev: unknown) => void>;
}

function makeCanvas(w: number, h: number, ctx: CanvasRenderingContext2DLike): CanvasStub {
  const listeners: Record<string, (ev: unknown) => void> = {};
  return {
    clientWidth: w,
    clientHeight: h,
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    addEventListener: (type: string, handler: (ev: unknown) => void): void => {
      listeners[type] = handler;
    },
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    listeners,
  };
}

// ---------------------------------------------------------------------------
// A real fit + price series computed once from the committed fixture. Pure —
// model.ts touches no globals — so this needs no harness.
// ---------------------------------------------------------------------------

const SAMPLE = HISTORY_FIXTURE.map((o) => ({ date: o.date, usd: o.usd }));
const FIT = fitOLS(SAMPLE);
const BAND_OFFSETS = computeBandOffsets(FIT, SAMPLE, "fullSample");

const MODEL_PAYLOAD = {
  a: FIT.a,
  n: FIT.n,
  r2: FIT.r2,
  sigma: FIT.sigma,
  bandMode: "fullSample",
  bandOffsets: BAND_OFFSETS,
  projection: { endYear: 2045, cautionAfterYear: 2040 },
  sample: {
    start: FIT.dataStart,
    end: FIT.dataEnd,
    count: FIT.points,
    includesProvisionalSpot: false,
  },
};
const PRICE_PAYLOAD = {
  start: FIT.dataStart,
  end: FIT.dataEnd,
  count: SAMPLE.length,
  decimated: false,
  points: SAMPLE.map((o) => [o.date, o.usd, 0] as [string, number, number]),
};

// Spec-mandated series colours (spec section 8) the strokeStyle must have seen.
const SPEC_COLORS = {
  price: "#42A04C",
  trend: "#ECECEC",
  outer: "#F44336",
  inner: "#03A9F4",
} as const;

const WRAP_W = 900;
const WRAP_H = 460;
const OSC_W = 900;
const OSC_H = 126;
const DPR = 2;

interface PaintResult {
  mainCtx: RecordingCtx;
  oscCtx: RecordingCtx;
  mainCanvas: CanvasStub;
  oscCanvas: CanvasStub;
  dpr: number;
}

// Evaluate the real CHART_JS against the stubs, mount, feed the fit + prices,
// then reset the recorders and force ONE clean full paint so the assertions see
// exactly one frame that has both the model and the prices present.
function runPaint(prefs?: Record<string, unknown>, model?: unknown): PaintResult {
  const mainCtx = makeRecordingCtx();
  const oscCtx = makeRecordingCtx();
  const mainCanvas = makeCanvas(WRAP_W, WRAP_H, mainCtx.proxy);
  const oscCanvas = makeCanvas(OSC_W, OSC_H, oscCtx.proxy);

  const wrap = { clientWidth: WRAP_W, clientHeight: WRAP_H };
  // offsetParent must be non-null (visible) for the engine to size/draw the osc.
  const oscWrap = { clientWidth: OSC_W, clientHeight: OSC_H, offsetParent: {} };
  const tip = { style: {} as Record<string, string>, innerHTML: "", offsetWidth: 0, offsetHeight: 0 };

  const windowStub: Record<string, unknown> = {
    devicePixelRatio: DPR,
    // synchronous rAF: a real browser would defer this; here we flush immediately
    requestAnimationFrame: (cb: () => void): number => {
      cb();
      return 1;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // `window` and `ResizeObserver` are passed as parameters so they resolve to our
  // controlled values regardless of the host globals (ResizeObserver forced to
  // undefined => the engine's `typeof ResizeObserver` guard skips it cleanly).
  const factory = new Function("window", "ResizeObserver", CHART_JS) as unknown as (
    w: unknown,
    ro: unknown,
  ) => void;
  factory(windowStub, undefined);

  const PLChart = windowStub["PLChart"] as {
    mount(o: unknown): void;
    setModel(m: unknown): void;
    setPrices(p: unknown): void;
    setPrefs(p: unknown): void;
    redraw(): void;
  };
  assert.ok(PLChart, "CHART_JS did not install window.PLChart");

  PLChart.mount({
    canvas: mainCanvas,
    osc: oscCanvas,
    tip,
    wrap,
    oscWrap,
    onPresetCleared: () => {},
  });
  if (prefs) PLChart.setPrefs(prefs);
  PLChart.setModel(model === undefined ? MODEL_PAYLOAD : model);
  PLChart.setPrices(PRICE_PAYLOAD);

  // Isolate a single clean frame with model + prices in place.
  mainCtx.reset();
  oscCtx.reset();
  PLChart.redraw();

  return { mainCtx, oscCtx, mainCanvas, oscCanvas, dpr: DPR };
}

// Paint once eagerly and capture any throw so assertion (1) can pinpoint it.
let paintError: unknown = null;
let paintResult: PaintResult | null = null;
try {
  paintResult = runPaint();
} catch (e) {
  paintError = e;
}

// Null-safe accessor: narrows to a concrete PaintResult inside its own scope so
// downstream tests never wrestle with closed-over `let` narrowing.
function paint(): PaintResult {
  const r = paintResult;
  assert.ok(r, "paint did not complete: " + String(paintError));
  return r;
}

// (1) no exception -----------------------------------------------------------
test("chart mounts and paints a full frame without throwing", () => {
  assert.equal(
    paintError,
    null,
    "mount + setModel + setPrices + redraw threw: " + String(paintError),
  );
  assert.ok(paintResult, "no paint result captured");
});

// (2) backing store resized to clientWidth*dpr -------------------------------
test("layout resizes the canvas backing store to clientWidth * dpr", () => {
  const h = paint();
  const c = h.mainCanvas;
  assert.equal(c.width, c.clientWidth * h.dpr, "main backing-store width != clientWidth*dpr");
  assert.equal(c.height, c.clientHeight * h.dpr, "main backing-store height != clientHeight*dpr");
  // CSS size is kept at the logical px (so the image is not scaled twice)
  assert.equal(c.style["width"], WRAP_W + "px", "main canvas CSS width not set");
  assert.equal(c.style["height"], WRAP_H + "px", "main canvas CSS height not set");
  // the oscillator canvas was sized too
  assert.equal(h.oscCanvas.width, OSC_W * h.dpr, "osc backing-store width != clientWidth*dpr");
});

// (3) >500 lineTo across price + trend + the 4 default lines over the domain ---
test("a full frame emits well over 500 lineTo calls (price + trend + 4 default lines)", () => {
  const h = paint();
  const lineTos = h.mainCtx.calls.filter((c) => c.m === "lineTo").length;
  const moveTos = h.mainCtx.calls.filter((c) => c.m === "moveTo").length;
  assert.ok(lineTos > 500, "expected >500 lineTo calls in one frame, got " + lineTos);
  assert.ok(moveTos > 0, "expected at least one moveTo, got " + moveTos);
});

// (4) $-formatted axis labels via fillText -----------------------------------
test("axis labels are drawn as $-formatted fillText strings", () => {
  const h = paint();
  const dollarLabels = h.mainCtx.calls.filter(
    (c) => c.m === "fillText" && typeof c.args[0] === "string" && (c.args[0] as string).includes("$"),
  );
  assert.ok(
    dollarLabels.length >= 3,
    "expected several $-formatted axis labels, got " + dollarLabels.length,
  );
});

// (5) strokeStyle saw the four spec series colours ---------------------------
test("strokeStyle is assigned all four spec series colours in one frame", () => {
  const h = paint();
  const strokeColors = new Set(
    h.mainCtx.sets.filter((s) => s.prop === "strokeStyle").map((s) => String(s.value)),
  );
  for (const [label, color] of Object.entries(SPEC_COLORS)) {
    assert.ok(
      strokeColors.has(color),
      "strokeStyle never saw the " + label + " colour " + color +
        " (saw: " + Array.from(strokeColors).join(", ") + ")",
    );
  }
});

// (6) the oscillator canvas also drew when enabled ---------------------------
test("with the oscillator enabled the osc canvas also paints", () => {
  const h = paint();
  const oscLineTos = h.oscCtx.calls.filter((c) => c.m === "lineTo").length;
  const oscCleared = h.oscCtx.calls.some((c) => c.m === "clearRect");
  assert.ok(oscCleared, "oscillator canvas was never cleared (did not draw)");
  assert.ok(oscLineTos > 0, "oscillator ratio line drew no segments, got " + oscLineTos);

  // Sanity counter-check: with the oscillator OFF, the osc canvas stays blank.
  const off = runPaint({ oscillator: false });
  const offOscLineTos = off.oscCtx.calls.filter((c) => c.m === "lineTo").length;
  assert.equal(offOscLineTos, 0, "osc drew segments while disabled (" + offOscLineTos + ")");
});

// (7a) v0.1.2 defaults: with default prefs only the classic FOUR percentile lines
//      (2.5/16.5/83.5/97.5%) are visible, so exactly four polylines are drawn.
test("default prefs draw exactly the four default percentile lines", () => {
  const h = paint(); // default prefs => only p025/p165/p835/p975 visible
  const bands = countBandPolylines(h.mainCtx);
  assert.equal(bands, 4, "expected 4 default band polylines, got " + bands);
});

// (7b) v0.1.2: with the full 11-key model and EVERY line toggled on, eleven
//      individual polylines are drawn — including the DASHED 50% median (gray,
//      setLineDash [6,4], the sole non-dotted percentile).
test("11-key offsets with all lines on draw eleven polylines incl. the dashed median", () => {
  const offs = BAND_OFFSETS as unknown as Record<string, number>;
  const ALL_KEYS = ["p005", "p025", "p10", "p165", "p25", "p50", "p75", "p835", "p90", "p975", "p995"];
  // sanity: the fixture-derived offsets really do carry all eleven keys
  for (const k of ALL_KEYS) {
    assert.ok(typeof offs[k] === "number", "fixture bandOffsets missing key " + k);
  }
  const allOn: Record<string, boolean> = {};
  for (const k of ALL_KEYS) allOn[k] = true;
  const h = runPaint({ bands: allOn });

  const bands = countBandPolylines(h.mainCtx);
  assert.equal(bands, 11, "expected 11 percentile polylines with every line on, got " + bands);

  const strokeColors = new Set(
    h.mainCtx.sets.filter((s) => s.prop === "strokeStyle").map((s) => String(s.value)),
  );
  assert.ok(strokeColors.has("#9E9E9E"), "50% median gray #9E9E9E never stroked");
  assert.ok(strokeColors.has("#FF9800"), "10%/90% amber #FF9800 never stroked");
  // the median is the only DASHED percentile: a setLineDash([6,4]) must be present
  const dashedMedian = h.mainCtx.calls.some(
    (c) => c.m === "setLineDash" && JSON.stringify(c.args[0]) === "[6,4]",
  );
  assert.ok(dashedMedian, "median line was not drawn dashed (no setLineDash([6,4]))");
});

// (8) backward-compat: a model whose bandOffsets predates v0.1.2 (only the four
//     classic keys) must paint WITHOUT throwing and draw exactly those four lines
//     — the lines whose offset keys are absent simply no-op.
test("4-key (legacy) offsets draw exactly four band lines and never throw", () => {
  const fourKeyOffsets = {
    p025: BAND_OFFSETS.p025,
    p165: BAND_OFFSETS.p165,
    p835: BAND_OFFSETS.p835,
    p975: BAND_OFFSETS.p975,
  };
  const fourKeyModel = { ...MODEL_PAYLOAD, bandOffsets: fourKeyOffsets };

  let err: unknown = null;
  let res: PaintResult | null = null;
  try {
    res = runPaint(undefined, fourKeyModel);
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, "painting a 4-key (legacy) model threw: " + String(err));
  assert.ok(res, "no paint result for the 4-key model");
  const bands = countBandPolylines((res as PaintResult).mainCtx);
  assert.equal(bands, 4, "expected exactly 4 band polylines for a 4-key model, got " + bands);
  // colours belonging only to absent keys must never be stroked
  const strokeColors = new Set(
    (res as PaintResult).mainCtx.sets.filter((s) => s.prop === "strokeStyle").map((s) => String(s.value)),
  );
  assert.ok(!strokeColors.has("#26A69A"), "25%/75% teal drew despite missing p25/p75 keys");
  assert.ok(!strokeColors.has("#9E9E9E"), "median gray drew despite missing p50 key");
});

// ===========================================================================
//  QUANTILE-REGRESSION BAND LINES (spec 15.3, v0.1.6)
// ===========================================================================
// In this mode the server sends eleven separately-fitted {a,n} lines instead of
// eleven parallel offsets, and the chart must evaluate each one per x (with the
// monotone rearrangement) rather than sliding the trend up and down by a constant.
// The observable difference is geometric: parallel offsets keep a CONSTANT vertical
// pixel gap between two lines on a log y-axis, separately-sloped lines do not.

const QR_LADDER = ["p005", "p025", "p10", "p165", "p25", "p50", "p75", "p835", "p90", "p975", "p995"] as const;

// A synthetic, deliberately NON-parallel ladder around the real fixture fit: line j
// sits at trend + delta*(0.9 - 0.2*log10(t)) in log10 space, delta running -1..+1
// across the ladder. The spread shrinks as t grows — a converging fan like the one
// porkopolis's quantile regressions produce — and stays strictly ordered over the
// whole 2010..2045 domain, so the eleven lines are eleven distinct polylines.
function syntheticBandLines(): Record<string, { a: number; n: number }> {
  const out: Record<string, { a: number; n: number }> = {};
  for (let j = 0; j < QR_LADDER.length; j++) {
    const delta = (j - 5) / 5;
    out[QR_LADDER[j] as string] = { a: FIT.a + delta * 0.9, n: FIT.n - delta * 0.2 };
  }
  return out;
}
const QR_MODEL_PAYLOAD = {
  ...MODEL_PAYLOAD,
  bandMode: "quantileRegression",
  bandLines: syntheticBandLines(),
};
// A stale record: the mode is set but the fit predates it and carries no lines.
const QR_STALE_MODEL_PAYLOAD = { ...MODEL_PAYLOAD, bandMode: "quantileRegression" };

const ALL_BANDS_ON: Record<string, boolean> = (() => {
  const o: Record<string, boolean> = {};
  for (const k of QR_LADDER) o[k] = true;
  return o;
})();

// Every polyline stroked while a band colour was live, in draw order — which is the
// engine's BAND_LINES order, 99.5% first down to 0.5% last. Points are the (x,y) CSS
// px pairs the engine actually emitted, so a test can measure the vertical distance
// between two lines at any sample index.
function bandPolylines(ctx: RecordingCtx): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: string | null = null;
  let pts: Array<[number, number]> = [];
  for (const e of ctx.seq) {
    if (e.kind === "set" && e.prop === "strokeStyle") cur = String(e.value);
    else if (e.kind === "call" && e.m === "beginPath") pts = [];
    else if (e.kind === "call" && (e.m === "moveTo" || e.m === "lineTo")) {
      const x = e.args[0];
      const y = e.args[1];
      if (typeof x === "number" && typeof y === "number") pts.push([x, y]);
    } else if (e.kind === "call" && e.m === "stroke") {
      if (cur !== null && BAND_COLORS.indexOf(cur) >= 0 && pts.length > 1) out.push(pts);
      pts = [];
    }
  }
  return out;
}
function polyAt(lines: Array<Array<[number, number]>>, i: number): Array<[number, number]> {
  const l = lines[i];
  assert.ok(l, "no band polyline at draw index " + i);
  return l;
}
function yAt(line: Array<[number, number]>, k: number): number {
  const p = line[k];
  assert.ok(p, "polyline has no sample at index " + k);
  return p[1];
}

// (9) The whole point of the mode: eleven lines that are NOT parallel ------------
test("quantileRegression bandLines draw eleven percentile lines whose gaps change across x", () => {
  const h = runPaint({ bands: ALL_BANDS_ON }, QR_MODEL_PAYLOAD);

  const bands = countBandPolylines(h.mainCtx);
  assert.equal(bands, 11, "expected 11 percentile polylines from bandLines, got " + bands);

  const lines = bandPolylines(h.mainCtx);
  assert.equal(lines.length, 11, "expected 11 recorded band polylines, got " + lines.length);
  const top = polyAt(lines, 0);   // 99.5% — drawn first
  const bottom = polyAt(lines, 10); // 0.5% — drawn last
  assert.equal(top.length, bottom.length, "the two lines were not sampled on the same x grid");
  assert.ok(top.length > 100, "too few samples to measure a gap: " + top.length);

  const last = top.length - 1;
  const gapLeft = Math.abs(yAt(top, 0) - yAt(bottom, 0));
  const gapRight = Math.abs(yAt(top, last) - yAt(bottom, last));
  assert.ok(gapLeft > 2 && gapRight > 0, "degenerate gaps (" + gapLeft + " / " + gapRight + ")");
  assert.ok(
    gapRight < gapLeft * 0.75,
    "the funnel did not narrow: gap " + gapLeft.toFixed(2) + "px at the left edge vs " +
      gapRight.toFixed(2) + "px at the right — the lines drew parallel",
  );

  // …and the oscillator guides follow: in this mode each visible percentile is a
  // per-x ratio CURVE, not the flat two-point multiplier line the offset modes draw.
  // (The price/trend ratio line itself is stroked as many 2-point segments, so the
  // length filter isolates the guides.)
  const oscGuides = bandPolylines(h.oscCtx).filter((l) => l.length > 50);
  assert.ok(oscGuides.length > 0, "no per-x oscillator guide curves were drawn");
  const guide = polyAt(oscGuides, 0);
  const ys = guide.map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1, "an oscillator guide drew flat (not a per-x curve)");
});

// (10) …while the offsets modes keep drawing the parallel ladder unchanged -------
test("an offsets-only model still draws parallel percentile lines", () => {
  const h = runPaint({ bands: ALL_BANDS_ON });   // fullSample offsets fixture model
  const lines = bandPolylines(h.mainCtx);
  assert.equal(lines.length, 11, "expected 11 recorded band polylines, got " + lines.length);
  const top = polyAt(lines, 0);
  const bottom = polyAt(lines, 10);
  assert.equal(top.length, bottom.length, "the two lines were not sampled on the same x grid");

  // On a log y-axis a constant log10 offset difference is a constant pixel gap.
  const gaps: number[] = [];
  for (const k of [0, Math.floor(top.length / 3), Math.floor((2 * top.length) / 3), top.length - 1]) {
    gaps.push(Math.abs(yAt(top, k) - yAt(bottom, k)));
  }
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(gaps[0] !== undefined && (gaps[0] as number) > 2, "degenerate parallel gap: " + gaps.join(","));
  assert.ok(spread < 1e-6, "offset bands drifted out of parallel (gaps " + gaps.join(", ") + ")");
});

// (11) Stale record guard: mode set, no bandLines -> offsets rendering, no throw ---
test("a quantileRegression record without bandLines falls back to offsets rendering", () => {
  let err: unknown = null;
  let res: PaintResult | null = null;
  try {
    res = runPaint(undefined, QR_STALE_MODEL_PAYLOAD);
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, "painting a bandLines-less quantileRegression record threw: " + String(err));
  assert.ok(res, "no paint result for the stale quantileRegression model");
  const bands = countBandPolylines((res as PaintResult).mainCtx);
  assert.equal(bands, 4, "stale record should fall back to the four default offset lines, got " + bands);
});

// ===========================================================================
//  INTERACTION HARNESS  (drag-to-pan / range-zoom / touch)  — v0.1.3-pre
// ===========================================================================
// The paint tests above prove draw() runs under the synchronous-rAF stub, which
// is the ONLY place chart geometry G is initialised. The pan/zoom/touch handlers
// no-op until G exists (they all read G.ml/G.mw/...), so a hidden browser that
// parks requestAnimationFrame can never exercise them — but this harness can.
//
// We reuse the same recording context + canvas stub, but now ALSO record every
// addEventListener the engine makes: on the CANVAS (mousedown/mousemove/touch*)
// AND on WINDOW (mouseup binds to window, so a pan can never finalise without it).
// Tests then replay the REAL handlers with synthetic event objects and assert on
// DRAWN OUTPUT only — the x-axis year labels the engine paints below the plot.
// No private state is read (no eval into the IIFE); no drawing is faked.

interface PLChartApi {
  mount(o: unknown): void;
  setModel(m: unknown): void;
  setPrices(p: unknown): void;
  setPrefs(p: unknown): void;
  setPreset(n: string): void;
  redraw(): void;
}

interface Interactive {
  chart: PLChartApi;
  mainCtx: RecordingCtx;
  mainCanvas: CanvasStub;
  canvasL: Record<string, (ev: unknown) => void>; // canvas-bound handlers
  windowL: Record<string, (ev: unknown) => void>; // window-bound handlers (mouseup)
  cleared: { count: number }; // onPresetCleared invocation counter
}

// Plot rectangle the engine derives for a 900x460 wrap (mL62/mR14/mT14/mB34):
// x in [62, 886], y in [14, 426]. These are the same constants layout() computes.
const PLOT = { left: 62, right: WRAP_W - 14, top: 14, bottom: WRAP_H - 34 };
const CX = (PLOT.left + PLOT.right) / 2; // 474 — plot-centre x
const CY = (PLOT.top + PLOT.bottom) / 2; // 220 — plot-centre y

// Mount the real engine against recording stubs, feed the fixture model+prices,
// and let it paint once (synchronous rAF) so geometry G is live before any gesture.
function mountInteractive(): Interactive {
  const mainCtx = makeRecordingCtx();
  const oscCtx = makeRecordingCtx();
  const mainCanvas = makeCanvas(WRAP_W, WRAP_H, mainCtx.proxy);
  const oscCanvas = makeCanvas(OSC_W, OSC_H, oscCtx.proxy);
  const wrap = { clientWidth: WRAP_W, clientHeight: WRAP_H };
  const oscWrap = { clientWidth: OSC_W, clientHeight: OSC_H, offsetParent: {} };
  const tip = { style: {} as Record<string, string>, innerHTML: "", offsetWidth: 0, offsetHeight: 0 };

  const windowL: Record<string, (ev: unknown) => void> = {};
  const windowStub: Record<string, unknown> = {
    devicePixelRatio: DPR,
    requestAnimationFrame: (cb: () => void): number => { cb(); return 1; },
    addEventListener: (type: string, h: (ev: unknown) => void): void => { windowL[type] = h; },
    removeEventListener: (): void => {},
  };

  const factory = new Function("window", "ResizeObserver", CHART_JS) as unknown as (
    w: unknown,
    ro: unknown,
  ) => void;
  factory(windowStub, undefined);
  const chart = windowStub["PLChart"] as PLChartApi;
  assert.ok(chart, "CHART_JS did not install window.PLChart");

  const cleared = { count: 0 };
  chart.mount({
    canvas: mainCanvas,
    osc: oscCanvas,
    tip,
    wrap,
    oscWrap,
    onPresetCleared: () => { cleared.count++; },
  });
  chart.setModel(MODEL_PAYLOAD);
  chart.setPrices(PRICE_PAYLOAD);

  return { chart, mainCtx, mainCanvas, canvasL: mainCanvas.listeners, windowL, cleared };
}

// Invoke a recorded handler by name with a synthetic event.
function fire(map: Record<string, (ev: unknown) => void>, type: string, ev: unknown): void {
  const h = map[type];
  assert.ok(h, "no handler registered for '" + type + "'");
  h(ev);
}
function mouseEv(x: number, y: number, shift?: boolean): Record<string, unknown> {
  return { clientX: x, clientY: y, shiftKey: !!shift, button: 0, buttons: 1, preventDefault(): void {} };
}
function touch1Ev(x: number, y: number): Record<string, unknown> {
  return { touches: [{ clientX: x, clientY: y }], preventDefault(): void {} };
}

// A mouse drag (x0,y)->(x1,y): shift => range-zoom rectangle, else pan. mouseup
// is dispatched on WINDOW, matching how the engine bound it.
function mouseDrag(h: Interactive, x0: number, x1: number, y: number, shift: boolean): void {
  fire(h.canvasL, "mousedown", mouseEv(x0, y, shift));
  fire(h.canvasL, "mousemove", mouseEv(x1, y, shift));
  fire(h.windowL, "mouseup", {});
}

// Establish a deterministic ~10.3-year sub-window (yearly ticks) by range-zooming
// x=280..520 out of the full 2010..2045 domain. A pan from the FULL view is
// edge-clamped to a no-op (it already spans the whole domain), so tests that must
// observe a real shift zoom in first to leave room on both sides.
function zoomToSubView(h: Interactive): void {
  mouseDrag(h, 280, 520, CY, true);
}

// The x-axis tick labels are the only fillText strings the engine paints BELOW
// the plot (y-labels sit left/inside the plot; today/caution/halving text sits at
// or above the top). So a y-arg past the plot bottom isolates the x-axis labels.
function xLabels(ctx: RecordingCtx): string[] {
  const out: string[] = [];
  for (const c of ctx.calls) {
    if (c.m !== "fillText") continue;
    const s = c.args[0];
    const yy = c.args[2];
    if (typeof s === "string" && typeof yy === "number" && yy > PLOT.bottom) out.push(s);
  }
  return out;
}
// In date mode a whole-year tick is painted as a bare 4-digit string ("2024");
// month ticks ("Jan 24") and log-day ticks ("123 d") never match, so this yields
// exactly the visible whole years, which are what shift under a pan/zoom.
function yearsFrom(labels: string[]): number[] {
  const out: number[] = [];
  for (const l of labels) if (/^\d{4}$/.test(l)) out.push(parseInt(l, 10));
  return out;
}
// Force one clean frame and read back its x-axis year labels.
function frameYears(h: Interactive): number[] {
  h.mainCtx.reset();
  h.chart.redraw();
  return yearsFrom(xLabels(h.mainCtx));
}

// (a) PAN: a +120px centre drag shifts the window toward earlier dates ----------
test("drag-pan shifts the drawn x-axis labels toward earlier dates", () => {
  const h = mountInteractive();
  zoomToSubView(h);
  h.cleared.count = 0;
  const before = frameYears(h);
  assert.ok(before.length >= 3, "sub-view drew too few year labels: " + before.join(","));

  mouseDrag(h, CX, CX + 120, CY, false);

  const after = frameYears(h);
  assert.ok(after.length >= 3, "post-pan drew too few year labels: " + after.join(","));
  assert.ok(
    Math.min(...after) < Math.min(...before),
    "pan did not move the labels earlier (before " + before.join(",") + " / after " + after.join(",") + ")",
  );
  assert.notEqual(JSON.stringify(after), JSON.stringify(before), "pan left the label set unchanged");
});

// (b) MICRO-DRAG: a 2px twitch is a click, not a pan — nothing moves, no clear ---
test("a 2px micro-drag neither pans the view nor clears the preset", () => {
  const h = mountInteractive();
  zoomToSubView(h);
  h.cleared.count = 0;
  const before = frameYears(h);

  mouseDrag(h, CX, CX + 2, CY, false);

  const after = frameYears(h);
  assert.equal(JSON.stringify(after), JSON.stringify(before), "a 2px twitch moved the drawn labels");
  assert.equal(h.cleared.count, 0, "a 2px twitch cleared the preset");
});

// (c) A committed pan clears the active preset EXACTLY once (not once per move) --
test("a drag-pan calls onPresetCleared exactly once", () => {
  const h = mountInteractive();
  zoomToSubView(h);
  h.cleared.count = 0;

  fire(h.canvasL, "mousedown", mouseEv(CX, CY, false));
  fire(h.canvasL, "mousemove", mouseEv(CX + 60, CY, false));
  fire(h.canvasL, "mousemove", mouseEv(CX + 120, CY, false)); // 2nd move must NOT re-clear
  fire(h.windowL, "mouseup", {});

  assert.equal(h.cleared.count, 1, "expected exactly one preset-clear, got " + h.cleared.count);
});

// (d) SHIFT+DRAG ZOOM: a shift range-select narrows the visible date span -------
test("shift-drag range-zoom narrows the drawn date range and clears the preset", () => {
  const h = mountInteractive();
  const before = frameYears(h); // full 2010..2045 domain
  assert.ok(before.length >= 3, "full view drew too few year labels: " + before.join(","));
  h.cleared.count = 0;

  mouseDrag(h, 300, 600, CY, true); // 300px range-select, well over the 50px floor

  const after = frameYears(h);
  assert.ok(after.length >= 2, "zoomed view drew too few year labels: " + after.join(","));
  const spanBefore = Math.max(...before) - Math.min(...before);
  const spanAfter = Math.max(...after) - Math.min(...after);
  assert.ok(
    spanAfter < spanBefore,
    "range-zoom did not narrow the span (" + spanBefore + "yr -> " + spanAfter + "yr)",
  );
  assert.equal(h.cleared.count, 1, "range-zoom should clear the preset once, got " + h.cleared.count);
});

// (e) CLAMP: panning far past the data start never draws a year before 2010 -----
test("panning far left clamps at the data start (no year label before 2010)", () => {
  const h = mountInteractive();
  zoomToSubView(h);

  mouseDrag(h, CX, CX + 5000, CY, false); // huge rightward drag reveals earlier dates

  const years = frameYears(h);
  assert.ok(years.length >= 3, "clamped view drew too few year labels: " + years.join(","));
  assert.ok(
    Math.min(...years) >= 2010,
    "a year label preceded the 2010 data start: " + years.join(","),
  );
});

// (f) TOUCH: a single-finger drag pans; a two-finger touch is ignored -----------
test("single-finger touch drag pans; a two-finger touch does not", () => {
  const h = mountInteractive();
  zoomToSubView(h);
  const before = frameYears(h);

  fire(h.canvasL, "touchstart", touch1Ev(CX, CY));
  fire(h.canvasL, "touchmove", touch1Ev(CX + 80, CY));
  fire(h.canvasL, "touchend", { preventDefault(): void {} });

  const afterPan = frameYears(h);
  assert.ok(
    Math.min(...afterPan) < Math.min(...before),
    "single-finger touch did not pan earlier (before " + before.join(",") + " / after " + afterPan.join(",") + ")",
  );

  // Two fingers must be ignored entirely (pinch is out of scope this round).
  const baseline = frameYears(h);
  const two = { touches: [{ clientX: CX, clientY: CY }, { clientX: CX + 40, clientY: CY }], preventDefault(): void {} };
  const twoMoved = { touches: [{ clientX: CX + 80, clientY: CY }, { clientX: CX + 120, clientY: CY }], preventDefault(): void {} };
  fire(h.canvasL, "touchstart", two);
  fire(h.canvasL, "touchmove", twoMoved);
  fire(h.canvasL, "touchend", { preventDefault(): void {} });

  const afterMulti = frameYears(h);
  assert.equal(JSON.stringify(afterMulti), JSON.stringify(baseline), "a two-finger touch moved the view");
});
