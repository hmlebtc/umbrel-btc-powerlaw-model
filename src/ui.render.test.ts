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
interface RecordingCtx {
  calls: Call[];
  sets: Assign[];
  proxy: CanvasRenderingContext2DLike;
  reset(): void;
}
// Structural type just so we can hand the proxy to the (any-typed) engine.
type CanvasRenderingContext2DLike = Record<string, unknown>;

function makeRecordingCtx(): RecordingCtx {
  const calls: Call[] = [];
  const sets: Assign[] = [];
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
        return undefined;
      };
    },
    set(_t, prop, value) {
      if (typeof prop === "string") {
        store[prop] = value;
        sets.push({ prop, value });
      }
      return true;
    },
  };
  const proxy = new Proxy(store, handler) as CanvasRenderingContext2DLike;
  return {
    calls,
    sets,
    proxy,
    reset() {
      calls.length = 0;
      sets.length = 0;
    },
  };
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
  addEventListener(...a: unknown[]): void;
  removeEventListener(...a: unknown[]): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

function makeCanvas(w: number, h: number, ctx: CanvasRenderingContext2DLike): CanvasStub {
  return {
    clientWidth: w,
    clientHeight: h,
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
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
function runPaint(prefs?: Record<string, unknown>): PaintResult {
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
  PLChart.setModel(MODEL_PAYLOAD);
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

// (3) >500 lineTo across price + trend + 4 bands over the domain -------------
test("a full frame emits well over 500 lineTo calls (price + trend + 4 bands)", () => {
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
