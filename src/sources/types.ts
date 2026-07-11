/**
 * Price source contract + shared source infrastructure (spec section 3.2).
 *
 * A PriceSource is a thin, keyless HTTP client for one exchange/aggregator. The
 * SourceRegistry wraps every call with timing + in-memory health tracking
 * (lastOkAt / lastErrorAt / latencyMs / consecutiveFailures) so /api/status can
 * report a health row per source. `fetchJson` centralises the spec's transport
 * rule: AbortSignal.timeout + one retry after a short delay, no dependencies.
 *
 * This module deliberately imports NO concrete source (real sources are wired in
 * main.ts's composition root); it only imports the fixture DATA to build the
 * MOCK=1 doubles, so there is no import cycle.
 */

import { HISTORY_FIXTURE } from '../fixtures/history.js';
import type {
  DailyObservation,
  EnabledSources,
  Settings,
  SourceHealth,
  SourceKind,
  SourceStatus,
} from '../types.js';

export interface PriceSource {
  /** Stable identifier; matches the enabledSources key. */
  name: string;
  /** Capabilities this source provides. */
  kinds: SourceKind[];
  /** Latest USD spot price. */
  fetchSpot?(): Promise<number>;
  /** Daily USD history (optionally only dates >= fromDate). */
  fetchDailyHistory?(fromDate?: string): Promise<DailyObservation[]>;
  /**
   * A small, SINGLE-request recent daily window (last ~15 days) for the quorum
   * recent-fill path (spec 3.3) — avoids crawling the full paginated history on
   * every refit. Sources that lack it fall back to fetchDailyHistory(fromDate).
   */
  fetchRecentHistory?(): Promise<DailyObservation[]>;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export interface FetchOptions {
  /** Per-attempt abort timeout; default 5000 ms (spec 3.2). */
  timeoutMs?: number;
  /** Extra attempts after the first; default 1 (spec 3.2 "one retry"). */
  retries?: number;
  /** Delay before a retry; default 1000 ms (spec 3.2 "after 1s"). */
  retryDelayMs?: number;
}

/**
 * Fetch + parse JSON with a per-attempt AbortSignal.timeout and one retry after
 * a short delay (spec section 3.2). Throws the last error when every attempt
 * fails so the SourceRegistry can record the failure.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delay(retryDelayMs);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Convert unix seconds to a UTC `YYYY-MM-DD` date string. */
export function unixToUtcDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const p = (v: number): string => (v < 10 ? `0${v}` : String(v));
  return `${y}-${p(m)}-${p(day)}`;
}

/** Coerce an unknown scalar (string or number) to a finite positive USD value. */
export function toUsd(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unexpected price value: ${JSON.stringify(v)}`);
  return n;
}

// ---------------------------------------------------------------------------
// Enablement (spec section 3.3: auto = all; manual = enabledSources map)
// ---------------------------------------------------------------------------

export function isSourceEnabled(settings: Settings, name: string): boolean {
  if (settings.sourceMode === 'auto') return true;
  const map = settings.enabledSources as unknown as Record<string, boolean>;
  return map[name] === true;
}

// ---------------------------------------------------------------------------
// Registry + health tracking
// ---------------------------------------------------------------------------

function freshHealth(): SourceHealth {
  return {
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    latencyMs: null,
    consecutiveFailures: 0,
  };
}

export class SourceRegistry {
  private readonly health = new Map<string, SourceHealth>();

  constructor(public readonly sources: PriceSource[]) {
    for (const s of sources) this.health.set(s.name, freshHealth());
  }

  get(name: string): PriceSource | undefined {
    return this.sources.find((s) => s.name === name);
  }

  healthOf(name: string): SourceHealth {
    return this.health.get(name) ?? freshHealth();
  }

  historySources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('history') && s.fetchDailyHistory);
  }

  spotSources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('spot') && s.fetchSpot);
  }

  /**
   * Invoke `fn` against `src`, recording latency + health. Success resets the
   * consecutive-failure counter; failure records the message and rethrows so the
   * caller can fall through to the next source.
   */
  async run<T>(src: PriceSource, fn: (s: PriceSource) => Promise<T>): Promise<T> {
    const h = this.health.get(src.name) ?? freshHealth();
    this.health.set(src.name, h);
    const started = Date.now();
    try {
      const result = await fn(src);
      h.latencyMs = Date.now() - started;
      h.lastOkAt = new Date().toISOString();
      h.consecutiveFailures = 0;
      return result;
    } catch (e) {
      h.latencyMs = Date.now() - started;
      h.lastErrorAt = new Date().toISOString();
      h.lastError = e instanceof Error ? e.message : String(e);
      h.consecutiveFailures += 1;
      throw e;
    }
  }

  /** /api/status source rows: health + declared kinds + enabled(settings). */
  statusRows(settings: Settings): SourceStatus[] {
    return this.sources.map((s) => ({
      name: s.name,
      kinds: s.kinds,
      enabled: isSourceEnabled(settings, s.name),
      ...this.healthOf(s.name),
    }));
  }
}

// ---------------------------------------------------------------------------
// MOCK=1 doubles (spec section 6): history from the fixture, random-walk spot,
// network NEVER touched. Co-located with the source infra so main.ts can pick
// real-vs-mock the way the reference app picks its adapter.
// ---------------------------------------------------------------------------

const SPOT_MOCK_SOURCES: Array<{ name: string; kinds: SourceKind[] }> = [
  { name: 'coinbase', kinds: ['spot'] },
  { name: 'kraken', kinds: ['spot', 'history'] },
  { name: 'bitstamp', kinds: ['spot', 'history'] },
  { name: 'binance', kinds: ['spot', 'history'] },
  { name: 'mempoolSpace', kinds: ['spot', 'history'] },
  { name: 'coingecko', kinds: ['spot'] },
];

/**
 * Build fixture-backed fakes. blockchainInfo serves the whole fixture; the
 * history-capable exchanges serve a recent slice (so recent-fill/cross-check
 * logic exercises); every spot source reports a small random walk around the
 * last fixture price so a quorum median resolves.
 */
export function createMockSources(): PriceSource[] {
  const fixture: DailyObservation[] = HISTORY_FIXTURE.map((o) => ({ date: o.date, usd: o.usd }));
  const last = fixture.length > 0 ? (fixture[fixture.length - 1] as DailyObservation).usd : 50_000;
  const walk = { price: last };
  const nextSpot = (jitter: number): number => {
    walk.price = Math.max(1, walk.price * (1 + (Math.random() - 0.5) * 0.01));
    return walk.price * (1 + (Math.random() - 0.5) * jitter);
  };
  const recentSlice = (): DailyObservation[] => fixture.slice(-30).map((o) => ({ ...o }));

  const sources: PriceSource[] = [
    {
      name: 'blockchainInfo',
      kinds: ['history'],
      async fetchDailyHistory(fromDate?: string): Promise<DailyObservation[]> {
        const rows = fixture.map((o) => ({ ...o }));
        return fromDate ? rows.filter((o) => o.date >= fromDate) : rows;
      },
    },
  ];
  for (const meta of SPOT_MOCK_SOURCES) {
    const src: PriceSource = { name: meta.name, kinds: meta.kinds };
    if (meta.kinds.includes('spot')) src.fetchSpot = async () => nextSpot(0.004);
    if (meta.kinds.includes('history')) src.fetchDailyHistory = async () => recentSlice();
    sources.push(src);
  }
  return sources;
}
