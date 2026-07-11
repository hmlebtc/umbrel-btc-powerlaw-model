/**
 * HTTP API (spec section 6). node:http only — no framework, no auth (Umbrel's
 * app_proxy is the boundary). Every JSON response uses the envelope
 * {ok:true,data} | {ok:false,error}. Bodies are capped at 64 KB and the router
 * never throws out (a bad request can't take the process down). The dashboard
 * shell + favicon come from Agent B's ui modules.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { DASHBOARD_HTML } from './ui/dashboard.js';
import { FAVICON_SVG } from './ui/favicon.js';
import type { EventLog } from './events.js';
import type { JobRunner, ModelStore } from './jobs.js';
import {
  currentQuantile,
  falsifiability,
  milestones,
  residualsForBands,
  t as tDays,
  trendUsdAt,
} from './model.js';
import type { PriceStore } from './priceStore.js';
import type { Scheduler } from './scheduler.js';
import type { SettingsStore } from './settings.js';
import type { SourceRegistry } from './sources/types.js';
import type { SpotAggregator } from './spot.js';
import type { ApiModel, ApiPrices, ApiStatus, PricePoint, Settings, StatusModel } from './types.js';

const BODY_LIMIT = 64 * 1024;
const DEFAULT_MAX_POINTS = 8000;

export interface AppContext {
  settings: SettingsStore;
  priceStore: PriceStore;
  modelStore: ModelStore;
  spot: SpotAggregator;
  jobRunner: JobRunner;
  registry: SourceRegistry;
  events: EventLog;
  scheduler?: Scheduler;
  mock: boolean;
  startedAt: string;
  version: string;
  gitSha: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Response helpers (envelope)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { ok: true, data });
}

function fail(res: ServerResponse, status: number, message: string, extra?: object): void {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

interface BodyRead {
  ok: boolean;
  tooLarge: boolean;
  text: string;
}

function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: BodyRead): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done({ ok: false, tooLarge: true, text: '' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done({ ok: true, tooLarge: false, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => done({ ok: false, tooLarge: false, text: '' }));
  });
}

function parseJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, value: v as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

function buildStatus(ctx: AppContext): ApiStatus {
  const settings = ctx.settings.get();
  const spot = ctx.spot.snapshot();
  const model = ctx.modelStore.current();
  const tToday = tDays(todayUtc());

  const statusModel: StatusModel | null = model
    ? {
        fittedAt: model.fittedAt,
        a: model.a,
        n: model.n,
        A: model.A,
        r2: model.r2,
        sigma: model.sigma,
        points: model.points,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        includesProvisionalSpot: model.includesProvisionalSpot,
        durationMs: model.durationMs,
      }
    : null;

  let fairValueNow: number | null = null;
  let deviationPct: number | null = null;
  let quantile: number | null = null;
  if (model) {
    fairValueNow = trendUsdAt(model.a, model.n, tToday);
    if (spot && spot.usd > 0) {
      deviationPct = ((spot.usd - fairValueNow) / fairValueNow) * 100;
      // Measure the spot's quantile against the SAME residual set the active
      // bandMode drew its bands from, so the readout and the band the spot sits
      // in can never disagree (spec section 4).
      const residuals = residualsForBands(ctx.priceStore.series(), model.a, model.n, model.bandMode);
      const q = currentQuantile(residuals, model.a, model.n, tToday, spot.usd);
      quantile = Number.isFinite(q) ? q : null;
    }
  }

  return {
    version: ctx.version,
    gitSha: ctx.gitSha,
    startedAt: ctx.startedAt,
    initialSyncDone: model !== null,
    spot,
    model: statusModel,
    fairValueNow,
    deviationPct,
    currentQuantile: quantile,
    nextRefitAt: ctx.scheduler ? ctx.scheduler.nextRefitAtISO() : null,
    refitIntervalHours: settings.refitIntervalHours,
    lastDailyAppendAt: ctx.scheduler ? ctx.scheduler.lastDailyAppendAt() : null,
    sources: ctx.registry.statusRows(settings),
  };
}

function buildModel(ctx: AppContext): ApiModel | null {
  const model = ctx.modelStore.current();
  if (!model) return null;
  const settings = ctx.settings.get();
  const tToday = tDays(todayUtc());
  const spot = ctx.spot.snapshot();
  // With no live spot, use the trend itself so aboveFloor is trivially satisfied.
  const spotUsd = spot && spot.usd > 0 ? spot.usd : trendUsdAt(model.a, model.n, tToday);
  return {
    fittedAt: model.fittedAt,
    epochDate: '2009-01-03',
    a: model.a,
    n: model.n,
    r2: model.r2,
    sigma: model.sigma,
    bandMode: model.bandMode,
    bandOffsets: model.bandOffsets,
    sample: {
      start: model.dataStart,
      end: model.dataEnd,
      count: model.points,
      includesProvisionalSpot: model.includesProvisionalSpot,
    },
    projection: { endYear: settings.projectionEndYear, cautionAfterYear: 2040 },
    falsifiability: falsifiability(model, tToday, spotUsd),
    milestones: milestones(model.a, model.n),
    history: ctx.modelStore.history().map((h) => ({
      fittedAt: h.fittedAt,
      a: h.a,
      n: h.n,
      r2: h.r2,
      sigma: h.sigma,
      points: h.points,
    })),
  };
}

function buildPrices(ctx: AppContext, maxPointsRaw: number): ApiPrices {
  const maxPoints =
    Number.isFinite(maxPointsRaw) && maxPointsRaw > 0 ? Math.floor(maxPointsRaw) : DEFAULT_MAX_POINTS;
  const series = ctx.priceStore.series();
  const points: PricePoint[] = series.map((o) => [o.date, o.usd, 0]);
  const spot = ctx.spot.snapshot();
  const today = todayUtc();
  if (spot && spot.usd > 0 && !ctx.priceStore.has(today)) points.push([today, spot.usd, 1]);

  const total = points.length;
  let out = points;
  let decimated = false;
  if (total > maxPoints) {
    const stride = Math.ceil(total / maxPoints);
    out = points.filter((_, i) => i % stride === 0 || i === total - 1);
    decimated = true;
  }
  return {
    start: total > 0 ? (points[0] as PricePoint)[0] : '',
    end: total > 0 ? (points[total - 1] as PricePoint)[0] : '',
    count: out.length,
    decimated,
    points: out,
  };
}

// ---------------------------------------------------------------------------
// Mutating handlers
// ---------------------------------------------------------------------------

async function handleSettingsPut(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (body.tooLarge) return fail(res, 413, 'request body too large');
  if (!body.ok) return fail(res, 400, 'could not read request body');
  const parsed = parseJson(body.text);
  if (!parsed.ok) return fail(res, 400, 'invalid JSON body');

  const result = ctx.settings.update(parsed.value as Partial<Settings>);
  if (!result.ok) return fail(res, 400, 'invalid settings', { errors: result.errors });
  ctx.scheduler?.reschedule();
  ctx.events.add('settings', 'settings updated via API');
  return ok(res, ctx.settings.get());
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Static / health
  if (method === 'GET' && path === '/') return sendText(res, 200, DASHBOARD_HTML, 'text/html; charset=utf-8');
  if (method === 'GET' && path === '/favicon.svg') return sendText(res, 200, FAVICON_SVG, 'image/svg+xml');
  if (method === 'GET' && path === '/healthz') return sendText(res, 200, 'ok', 'text/plain; charset=utf-8');

  // Read-only JSON
  if (method === 'GET' && path === '/api/status') return ok(res, buildStatus(ctx));
  if (method === 'GET' && path === '/api/model') {
    const m = buildModel(ctx);
    if (!m) return fail(res, 404, 'model not fitted yet');
    return ok(res, m);
  }
  if (method === 'GET' && path === '/api/prices') {
    return ok(res, buildPrices(ctx, Number(url.searchParams.get('maxPoints'))));
  }
  if (method === 'GET' && path === '/api/events') {
    const n = Number(url.searchParams.get('limit'));
    return ok(res, ctx.events.list(Number.isFinite(n) && n > 0 ? n : undefined));
  }
  if (method === 'GET' && path === '/api/job') {
    return ok(res, { current: ctx.jobRunner.current(), last: ctx.jobRunner.last() });
  }
  if (method === 'GET' && path === '/api/settings') return ok(res, ctx.settings.get());

  // Mutations
  if (method === 'PUT' && path === '/api/settings') return handleSettingsPut(ctx, req, res);
  if (method === 'POST' && path === '/api/refit') {
    const started = ctx.jobRunner.start('refit');
    if (!started.ok) return fail(res, 409, started.error);
    return sendJson(res, 202, { ok: true, data: { jobId: started.jobId } });
  }

  return fail(res, 404, 'not found');
}

export function createApiServer(ctx: AppContext): Server {
  return createServer((req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      if (!res.headersSent) fail(res, 500, errMsg(err));
      else res.end();
    });
  });
}
