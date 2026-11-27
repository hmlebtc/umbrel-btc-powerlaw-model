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
import { blockCountsFromSnapshot, heightsFromSnapshot } from '../fixtures/heights.js';
import type {
  BlockCountObservation,
  DailyObservation,
  EnabledSources,
  HeightEpoch,
  Settings,
  SourceHealth,
  SourceKind,
  SourceStatus,
} from '../types.js';

export interface BlockCountOptions {
  /** Incremental fetch: only days on/after this UTC date (`YYYY-MM-DD`). Omitted = full history. */
  startDate?: string;
}

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
  /** Full daily block-count history (v0.2.0 spec 3.2; Coin Metrics `BlkCnt`). */
  fetchBlockCounts?(opts?: BlockCountOptions): Promise<BlockCountObservation[]>;
  /** Difficulty-adjustment epoch boundaries `{time, height}` (mempool.space). */
  fetchEpochs?(): Promise<HeightEpoch[]>;
  /** Current chain tip height. */
  fetchTipHeight?(): Promise<number>;
  /** Height of the last block at or before unix time `unixSec` (immutable once past). */
  fetchLastBlockHeightBefore?(unixSec: number): Promise<number>;
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

/**
 * Coerce an unknown scalar (number, or a numeric string as Coin Metrics and the
 * plain-text tip endpoints serve it) to a non-negative integer, or throw. Used
 * for chain-tip responses; the row parsers use the non-throwing variant below.
 */
export function toBlockCount(v: unknown): number {
  const n = parseBlockCount(v);
  if (n === null) throw new Error(truncateError(`unexpected block count value: ${JSON.stringify(v)}`));
  return n;
}

/** Upper bound for any block height / count taken from an upstream (about 190x today's chain). */
export const MAX_BLOCK_VALUE = 1e8;

/** Cap on stored error strings: an upstream body must not be able to bloat /api/status. */
export const MAX_ERROR_CHARS = 200;
export function truncateError(msg: string): string {
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS - 3)}...` : msg;
}

/** Non-throwing `toBlockCount`: null for anything that is not a finite integer in [0, MAX_BLOCK_VALUE]. */
export function parseBlockCount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= MAX_BLOCK_VALUE ? n : null;
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
  /** Block-height-capability health, kept apart from `health` (price capabilities). */
  private readonly heightHealth = new Map<string, SourceHealth>();

  constructor(public readonly sources: PriceSource[]) {
    for (const s of sources) this.health.set(s.name, freshHealth());
  }

  get(name: string): PriceSource | undefined {
    return this.sources.find((s) => s.name === name);
  }

  healthOf(name: string): SourceHealth {
    return this.health.get(name) ?? freshHealth();
  }

  heightHealthOf(name: string): SourceHealth {
    return this.heightHealth.get(name) ?? freshHealth();
  }

  historySources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('history') && s.fetchDailyHistory);
  }

  /** Sources that can serve the full daily block-count history (Coin Metrics). */
  blockCountSources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('height') && s.fetchBlockCounts);
  }

  /** Sources that can serve difficulty-epoch boundaries (mempool.space). */
  epochSources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('height') && s.fetchEpochs);
  }

  /** Sources that can resolve "height of the last block before time T" (mempool.space). */
  blockLookupSources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('height') && s.fetchLastBlockHeightBefore);
  }

  /** Sources that can serve the chain tip height. */
  tipSources(): PriceSource[] {
    return this.sources.filter((s) => s.kinds.includes('height') && s.fetchTipHeight);
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
    return this.track(this.health, src, fn);
  }

  /**
   * Like `run`, for the block-height capabilities (counts, epochs, tip, lookup).
   * Recorded in a SEPARATE health table so a succeeding tip call can never reset the
   * failure counter a failing history/spot call of the same source set (v0.2.0 R1).
   */
  async runHeight<T>(src: PriceSource, fn: (s: PriceSource) => Promise<T>): Promise<T> {
    return this.track(this.heightHealth, src, fn);
  }

  private async track<T>(table: Map<string, SourceHealth>, src: PriceSource, fn: (s: PriceSource) => Promise<T>): Promise<T> {
    const h = table.get(src.name) ?? freshHealth();
    table.set(src.name, h);
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
      h.lastError = truncateError(e instanceof Error ? e.message : String(e));
      h.consecutiveFailures += 1;
      throw e;
    }
  }

  /** /api/status source rows: health + declared kinds + enabled(settings). */
  statusRows(settings: Settings): SourceStatus[] {
    return this.sources.map((s) => {
      const priceCapable = s.kinds.some((k) => k === 'spot' || k === 'history');
      const row: SourceStatus = {
        name: s.name,
        kinds: s.kinds,
        enabled: isSourceEnabled(settings, s.name),
        // Price-capable sources keep reporting PRICE health exactly as in v0.1.8; the
        // height-only sources have no other health, so theirs is the main row.
        ...(priceCapable ? this.healthOf(s.name) : this.heightHealthOf(s.name)),
      };
      if (priceCapable && s.kinds.includes('height')) row.heightHealth = this.heightHealthOf(s.name);
      return row;
    });
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
  { name: 'mempoolSpace', kinds: ['spot', 'history', 'height'] },
  { name: 'coingecko', kinds: ['spot'] },
];

/**
 * Mock TRUE chain height at instant `ms`: inside the snapshot, linear within the
 * day over the snapshot's true heights; after it, the snapshot's last true height
 * plus the nominal 144 blocks/day. The mock tip and the mock last-block-before
 * lookup both come from here, so they are consistent with each other and with the
 * snapshot's offset (the mock lookup reproduces the snapshot exactly at day ends,
 * so calibration measures SNAPSHOT_HEIGHT_OFFSET).
 */
function mockTrueHeightAt(ms: number): number {
  const snap = heightsFromSnapshot();
  const last = snap[snap.length - 1];
  if (!last) return 0;
  const startMs = Date.parse(`${snap[0]!.date}T00:00:00Z`);
  const endMs = Date.parse(`${last.date}T00:00:00Z`) + 86_400_000;
  if (ms >= endMs) return last.h + Math.max(0, Math.round((144 * (ms - endMs)) / 86_400_000));
  if (ms <= startMs) return 0;
  const i = Math.min(snap.length - 1, Math.floor((ms - startMs) / 86_400_000));
  const before = i > 0 ? (snap[i - 1] as { h: number }).h : 0;
  const frac = (ms - (startMs + i * 86_400_000)) / 86_400_000;
  return Math.round(before + ((snap[i] as { h: number }).h - before) * frac);
}

function mockTipHeight(): number {
  return mockTrueHeightAt(Date.now());
}

/**
 * Mock difficulty epochs (newest first): every 2016th block of the snapshot,
 * timestamped by linear interpolation inside the day it falls in — so the 50-block
 * cross-check against the very series it came from stays quiet in mock mode.
 */
function mockEpochs(): HeightEpoch[] {
  const snap = heightsFromSnapshot();
  const out: HeightEpoch[] = [];
  let di = 0;
  const last = snap[snap.length - 1];
  for (let height = 2016; last && height <= last.h; height += 2016) {
    while (di < snap.length && (snap[di] as { h: number }).h < height) di++;
    const day = snap[di] as { date: string; h: number };
    const before = di > 0 ? (snap[di - 1] as { h: number }).h : 0;
    const frac = day.h > before ? (height - before) / (day.h - before) : 1;
    const ms = Date.parse(`${day.date}T00:00:00Z`) + frac * 86_400_000;
    out.push({ time: Math.floor(ms / 1000), height });
  }
  return out.reverse();
}

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
    if (meta.name === 'mempoolSpace') {
      src.fetchEpochs = async () => mockEpochs();
      src.fetchTipHeight = async () => mockTipHeight();
      src.fetchLastBlockHeightBefore = async (unixSec: number) => mockTrueHeightAt(unixSec * 1000);
    }
    sources.push(src);
  }
  // v0.2.0 block-height doubles: Coin Metrics serves the bundled snapshot's daily
  // counts; Blockstream and blockchain.info answer the mock tip (the mempool.space
  // double above does too, plus the epochs).
  const primary = sources[0] as PriceSource;
  primary.kinds = [...primary.kinds, 'height'];
  primary.fetchTipHeight = async () => mockTipHeight();
  sources.push({
    name: 'coinmetrics',
    kinds: ['height'],
    // MOCK DATA: the "Coin Metrics close" of each date is the HISTORY_FIXTURE
    // (blockchain.info) price of the same date where one exists; it is not real
    // Coin Metrics PriceUSD and only exercises the close-carrying code paths.
    fetchBlockCounts: async (opts?: BlockCountOptions) => {
      const usdByDate = new Map(fixture.map((o) => [o.date, o.usd] as const));
      return blockCountsFromSnapshot()
        .filter((c) => !opts?.startDate || c.date >= opts.startDate)
        .map((c) => {
          const usd = usdByDate.get(c.date);
          return usd !== undefined ? { ...c, usd } : c;
        });
    },
  });
  sources.push({
    name: 'blockstream',
    kinds: ['height'],
    fetchTipHeight: async () => mockTipHeight(),
  });
  return sources;
}
