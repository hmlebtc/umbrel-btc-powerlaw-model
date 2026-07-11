// Tests for server.ts (spec section 6 HTTP API). Uses a MOCK-backed AppContext
// on an ephemeral port; the network is never touched. server.ts imports Agent
// B's ./ui/dashboard.js + ./ui/favicon.js, so this suite compiles/runs only once
// those modules exist at integration time (envelope + route contract otherwise
// mirror the reference app's createApiServer(ctx) pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { EventLog } from './events.js';
import { JobRunner, JobStats, ModelStore } from './jobs.js';
import { PriceStore } from './priceStore.js';
import { createApiServer, type AppContext } from './server.js';
import { defaultSettings, SettingsStore } from './settings.js';
import { createMockSources, SourceRegistry, type PriceSource } from './sources/types.js';
import { SpotAggregator } from './spot.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await delay(15);
  }
}

interface Harness {
  ctx: AppContext;
  cleanup: () => void;
}

function buildCtx(sources?: PriceSource[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-server-'));
  const settings = new SettingsStore(dir, defaultSettings());
  const getSettings = () => settings.get();
  const registry = new SourceRegistry(sources ?? createMockSources());
  const priceStore = new PriceStore();
  const modelStore = new ModelStore();
  const jobStats = new JobStats();
  const events = new EventLog();
  const spot = new SpotAggregator(registry, getSettings);
  const jobRunner = new JobRunner({ registry, priceStore, spot, getSettings, modelStore, jobStats, events });
  const ctx: AppContext = {
    settings,
    priceStore,
    modelStore,
    spot,
    jobRunner,
    registry,
    events,
    mock: true,
    startedAt: new Date().toISOString(),
    version: '0.1.0',
    gitSha: 'test-sha',
  };
  return { ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer<T>(ctx: AppContext, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createApiServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getJSON(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function putJSON(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function runRefit(ctx: AppContext): Promise<void> {
  ctx.jobRunner.start('refit');
  await waitFor(() => ctx.jobRunner.last() !== null && ctx.jobRunner.last()!.state !== 'running');
}

// ---------------------------------------------------------------------------
// Static + health.
// ---------------------------------------------------------------------------

test('GET /healthz -> 200 ok', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const res = await fetch(baseUrl + '/healthz');
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });
  } finally {
    cleanup();
  }
});

test('GET / -> 200 HTML and /favicon.svg -> image/svg+xml', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const page = await fetch(baseUrl + '/');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const fav = await fetch(baseUrl + '/favicon.svg');
      assert.equal(fav.status, 200);
      assert.match(fav.headers.get('content-type') ?? '', /image\/svg\+xml/);
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /api/status envelope + fields (before and after a fit).
// ---------------------------------------------------------------------------

test('GET /api/status: section-6 envelope with the documented keys', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/status');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      for (const key of [
        'version',
        'gitSha',
        'startedAt',
        'initialSyncDone',
        'spot',
        'model',
        'fairValueNow',
        'deviationPct',
        'currentQuantile',
        'nextRefitAt',
        'refitIntervalHours',
        'lastDailyAppendAt',
        'sources',
      ]) {
        assert.ok(key in body.data, `missing status key ${key}`);
      }
      // Before any fit.
      assert.equal(body.data.initialSyncDone, false);
      assert.equal(body.data.model, null);
      assert.ok(Array.isArray(body.data.sources) && body.data.sources.length === 7);
    });
  } finally {
    cleanup();
  }
});

test('GET /api/status + /api/model: populated after a refit', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await runRefit(ctx);
    await withServer(ctx, async (baseUrl) => {
      const status = await getJSON(baseUrl, '/api/status');
      assert.equal(status.body.data.initialSyncDone, true);
      assert.ok(status.body.data.model);
      assert.ok(status.body.data.model.n >= 5.3 && status.body.data.model.n <= 6.1);
      assert.ok(status.body.data.spot && status.body.data.spot.quorum >= 2);
      assert.equal(typeof status.body.data.fairValueNow, 'number');

      const model = await getJSON(baseUrl, '/api/model');
      assert.equal(model.status, 200);
      assert.equal(model.body.data.epochDate, '2009-01-03');
      assert.ok('bandOffsets' in model.body.data);
      assert.ok('falsifiability' in model.body.data);
      assert.equal(model.body.data.milestones.crossings.length, 3);
      // A fresh v0.1.2 fit serves all eleven band keys, non-decreasing in p-order.
      const bo = model.body.data.bandOffsets;
      const inPOrder = [
        bo.p005, bo.p025, bo.p10, bo.p165, bo.p25, bo.p50, bo.p75, bo.p835, bo.p90, bo.p975, bo.p995,
      ];
      for (const v of inPOrder) assert.equal(typeof v, 'number');
      for (let i = 1; i < inPOrder.length; i++) assert.ok(inPOrder[i] >= inPOrder[i - 1]);
    });
  } finally {
    cleanup();
  }
});

test('GET /api/model: 404-style {ok:false} before the first fit', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/model');
      assert.equal(status, 404);
      assert.equal(body.ok, false);
    });
  } finally {
    cleanup();
  }
});

test('GET /api/model: serves a pre-v0.1.1 4-key bandOffsets record as-is (backward-compat)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-legacy-model-'));
  try {
    // A model.json written before the v0.1.1 band fan: bandOffsets carries only
    // the original four keys. ModelStore.load must not crash on the missing keys,
    // and /api/model must serve the record unchanged (no refit has happened yet).
    const legacyOffsets = { p025: -0.5, p165: -0.2, p835: 0.2, p975: 0.5 };
    const legacy = {
      current: {
        fittedAt: '2026-01-01T00:00:00.000Z',
        a: -16.8,
        n: 5.7,
        A: Math.pow(10, -16.8),
        r2: 0.95,
        sigma: 0.28,
        points: 5800,
        dataStart: '2010-07-18',
        dataEnd: '2025-12-31',
        bandMode: 'fullSample',
        bandOffsets: legacyOffsets,
        includesProvisionalSpot: false,
        durationMs: 1234,
      },
      history: [],
    };
    writeFileSync(join(dir, 'model.json'), JSON.stringify(legacy));

    const settings = new SettingsStore(dir, defaultSettings());
    const getSettings = () => settings.get();
    const registry = new SourceRegistry(createMockSources());
    const priceStore = new PriceStore();
    const modelStore = new ModelStore(dir); // loads the legacy record from disk
    const jobStats = new JobStats();
    const events = new EventLog();
    const spot = new SpotAggregator(registry, getSettings);
    const jobRunner = new JobRunner({ registry, priceStore, spot, getSettings, modelStore, jobStats, events });
    const ctx: AppContext = {
      settings,
      priceStore,
      modelStore,
      spot,
      jobRunner,
      registry,
      events,
      mock: true,
      startedAt: new Date().toISOString(),
      version: '0.1.1',
      gitSha: 'test-sha',
    };

    // Loaded without throwing, keeping the four legacy keys verbatim.
    assert.deepEqual(modelStore.current()!.bandOffsets, legacyOffsets);

    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/model');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.bandOffsets, legacyOffsets);
      // Missing new keys are simply absent (those lines aren't drawn until a
      // refit) — both the v0.1.1 and the v0.1.2 additions.
      for (const k of ['p005', 'p10', 'p25', 'p50', 'p75', 'p90', 'p995']) {
        assert.ok(!(k in body.data.bandOffsets), `unexpected ${k} served for a legacy record`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/model: serves a pre-v0.1.2 8-key bandOffsets record as-is (backward-compat)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-legacy8-model-'));
  try {
    // A model.json written by v0.1.1: bandOffsets carries the eight-key band fan
    // but not the v0.1.2 p10/p50/p90 additions. ModelStore.load must not crash,
    // and /api/model must serve the record unchanged (no refit has happened yet)
    // so the UI renders p10/p50/p90 chips disabled until the next model update.
    const legacyOffsets = {
      p005: -0.72,
      p025: -0.5,
      p165: -0.2,
      p25: -0.12,
      p75: 0.12,
      p835: 0.2,
      p975: 0.5,
      p995: 0.72,
    };
    const legacy = {
      current: {
        fittedAt: '2026-04-01T00:00:00.000Z',
        a: -16.8,
        n: 5.7,
        A: Math.pow(10, -16.8),
        r2: 0.95,
        sigma: 0.28,
        points: 5850,
        dataStart: '2010-07-18',
        dataEnd: '2026-03-31',
        bandMode: 'pointInTime',
        bandOffsets: legacyOffsets,
        includesProvisionalSpot: false,
        durationMs: 1234,
      },
      history: [],
    };
    writeFileSync(join(dir, 'model.json'), JSON.stringify(legacy));

    const settings = new SettingsStore(dir, defaultSettings());
    const getSettings = () => settings.get();
    const registry = new SourceRegistry(createMockSources());
    const priceStore = new PriceStore();
    const modelStore = new ModelStore(dir); // loads the legacy record from disk
    const jobStats = new JobStats();
    const events = new EventLog();
    const spot = new SpotAggregator(registry, getSettings);
    const jobRunner = new JobRunner({ registry, priceStore, spot, getSettings, modelStore, jobStats, events });
    const ctx: AppContext = {
      settings,
      priceStore,
      modelStore,
      spot,
      jobRunner,
      registry,
      events,
      mock: true,
      startedAt: new Date().toISOString(),
      version: '0.1.2',
      gitSha: 'test-sha',
    };

    // Loaded without throwing, keeping the eight v0.1.1 keys verbatim.
    assert.deepEqual(modelStore.current()!.bandOffsets, legacyOffsets);

    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/model');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.bandOffsets, legacyOffsets);
      // The three v0.1.2 additions are absent until the next refit.
      for (const k of ['p10', 'p50', 'p90']) {
        assert.ok(!(k in body.data.bandOffsets), `unexpected ${k} served for a v0.1.1 record`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// /api/prices.
// ---------------------------------------------------------------------------

test('GET /api/prices: shape + provisional-today flag after a refit', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await runRefit(ctx);
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/prices?maxPoints=500');
      assert.equal(status, 200);
      const data = body.data;
      assert.ok(Array.isArray(data.points));
      assert.equal(data.decimated, true); // >500 fixture points
      assert.ok(data.points.length <= 500);
      const point = data.points[0];
      assert.equal(point.length, 3); // [date, usd, flag]
      // The last point is the provisional spot (flag 1).
      const lastPoint = data.points[data.points.length - 1];
      assert.equal(lastPoint[2], 1);
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /api/settings PUT validation.
// ---------------------------------------------------------------------------

test('PUT /api/settings: rejects out-of-range with errors[]', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await putJSON(baseUrl, '/api/settings', { refitIntervalHours: 999 });
      assert.equal(status, 400);
      assert.equal(body.ok, false);
      assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    });
  } finally {
    cleanup();
  }
});

test('PUT /api/settings: a valid patch is applied', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await putJSON(baseUrl, '/api/settings', { bandMode: 'fullSample' });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(ctx.settings.get().bandMode, 'fullSample');
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /api/refit single-flight: deterministic 202 then 409 via a gated source.
// ---------------------------------------------------------------------------

function gatedSources(gate: Promise<void>, onEnter: () => void): PriceSource[] {
  return createMockSources().map((s) => {
    if (s.name === 'blockchainInfo' && s.fetchDailyHistory) {
      const orig = s.fetchDailyHistory.bind(s);
      let tripped = false;
      return {
        ...s,
        fetchDailyHistory: async (from?: string) => {
          if (!tripped) {
            tripped = true;
            onEnter();
            await gate;
          }
          return orig(from);
        },
      };
    }
    return s;
  });
}

test('POST /api/refit: 202 with jobId, then 409 while it runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => {
    entered = r;
  });
  const { ctx, cleanup } = buildCtx(gatedSources(gate, () => entered()));
  try {
    await withServer(ctx, async (baseUrl) => {
      const first = await fetch(baseUrl + '/api/refit', { method: 'POST' });
      assert.equal(first.status, 202);
      const firstBody = (await first.json()) as any;
      assert.equal(firstBody.ok, true);
      assert.equal(typeof firstBody.data.jobId, 'string');

      // The job is parked in fetch-history on the gate: provably in-flight.
      await enteredP;
      const second = await fetch(baseUrl + '/api/refit', { method: 'POST' });
      assert.equal(second.status, 409);
      const secondBody = (await second.json()) as any;
      assert.equal(secondBody.ok, false);

      release();
      await waitFor(() => ctx.jobRunner.last() !== null && ctx.jobRunner.last()!.state !== 'running');
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /api/job + /api/events.
// ---------------------------------------------------------------------------

test('GET /api/job: {current,last} shape', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    await withServer(ctx, async (baseUrl) => {
      const { status, body } = await getJSON(baseUrl, '/api/job');
      assert.equal(status, 200);
      assert.ok('current' in body.data && 'last' in body.data);
    });
  } finally {
    cleanup();
  }
});

test('GET /api/events: array, honours limit', async () => {
  const { ctx, cleanup } = buildCtx();
  try {
    ctx.events.add('a', 'one');
    ctx.events.add('b', 'two');
    ctx.events.add('c', 'three');
    await withServer(ctx, async (baseUrl) => {
      const { body } = await getJSON(baseUrl, '/api/events?limit=2');
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0].msg, 'three'); // newest first
    });
  } finally {
    cleanup();
  }
});
