// Tests for server.ts (spec section 6 HTTP API). Uses a MOCK-backed AppContext
// on an ephemeral port; the network is never touched. server.ts imports Agent
// B's ./ui/dashboard.js + ./ui/favicon.js, so this suite compiles/runs only once
// those modules exist at integration time (envelope + route contract otherwise
// mirror the reference app's createApiServer(ctx) pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
