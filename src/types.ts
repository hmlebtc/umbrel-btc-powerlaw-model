/**
 * Shared data types (spec sections 3-7, 9). Dependency-free: it only declares
 * the JSON shapes that cross module / HTTP boundaries, so the pure model engine
 * (model.ts), the data layer (priceStore/spot), the job runner and the HTTP
 * router all agree on one contract. Nothing here carries a model coefficient;
 * every A/n/sigma value is computed at fit time.
 */

// ---------------------------------------------------------------------------
// Core observations & price store (spec section 3)
// ---------------------------------------------------------------------------

/** A single daily USD observation used by the model sample and the fixtures. */
export interface DailyObservation {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Average USD price on that date; always > 0 in a valid sample. */
  usd: number;
}

/** One day's canonical record in `/data/prices.json`. */
export interface DayRecord {
  usd: number;
  /** Name of the source the value was last written from. */
  src: string;
  /** `unconfirmed` (single-source recent fill) | `divergent` (cross-check >5%). */
  flags?: string[];
}

/** On-disk shape of `/data/prices.json` (spec section 3.1). */
export interface PriceStoreFile {
  version: 1;
  updatedAt: string;
  days: Record<string, DayRecord>;
}

// ---------------------------------------------------------------------------
// Sources (spec section 3.2) — per-source health tracked in memory.
// ---------------------------------------------------------------------------

export type SourceKind = 'history' | 'spot';

export interface SourceHealth {
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
}

/** /api/status per-source health row (health + which kinds + enabled). */
export interface SourceStatus extends SourceHealth {
  name: string;
  kinds: SourceKind[];
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Model engine (spec section 4) — all recomputed each fit, never persisted as
// a source-of-truth coefficient.
// ---------------------------------------------------------------------------

export type BandMode = 'pointInTime' | 'fullSample';

/**
 * Residual-percentile offsets (log10 space) added to the trend line. Eleven
 * percentiles, drawn as individual labelled lines since v0.1.2:
 * 0.5, 2.5, 10, 16.5, 25, 50, 75, 83.5, 90, 97.5, 99.5. p025/p165/p835/p975
 * keep their original meaning; p005/p25/p75/p995 were added in v0.1.1; p10/p50/p90
 * are a pure v0.1.2 addition. Records persisted before v0.1.2 carry only the eight
 * v0.1.1 keys (and pre-v0.1.1 records only the original four) — consumers must
 * guard on presence and treat absent keys as "not available until the next refit".
 */
export interface BandOffsets {
  p005: number;
  p025: number;
  p10: number;
  p165: number;
  p25: number;
  p50: number;
  p75: number;
  p835: number;
  p90: number;
  p975: number;
  p995: number;
}

/** Falsifiability guards recomputed each fit (spec section 4). */
export interface Falsifiability {
  /** n within [5.0, 7.0]. */
  exponentInRange: boolean;
  /** r2 >= 0.80. */
  r2Healthy: boolean;
  /** spot >= trend * 10^(-3 sigma). */
  aboveFloor: boolean;
}

export interface MilestoneCrossing {
  usd: number;
  /** UTC date the trend crosses `usd`, or null when never (n<=0 guard). */
  date: string | null;
}

export interface MilestoneJanValue {
  year: number;
  usd: number;
}

export interface Milestones {
  crossings: MilestoneCrossing[];
  janFirstValues: MilestoneJanValue[];
}

/** Pure OLS output (model.ts fitOLS) before bands are attached. */
export interface OlsFit {
  /** Intercept in log10 space (= log10(A)). */
  a: number;
  /** Slope / exponent. */
  n: number;
  /** 10^a. */
  A: number;
  /** Coefficient of determination, 1 - SSE/SST. */
  r2: number;
  /** Population std-dev of residuals, sqrt(SSE/N). */
  sigma: number;
  /** Number of (t>=1, usd>0) points used. */
  points: number;
  /** First / last sample date. */
  dataStart: string;
  dataEnd: string;
  /** Per-point residuals (y - fit), aligned to the chronological sample. */
  residuals: number[];
}

/** Full fit: OLS + band offsets + provisional-spot flag (model.ts fit). */
export interface ModelFit {
  a: number;
  n: number;
  A: number;
  r2: number;
  sigma: number;
  points: number;
  dataStart: string;
  dataEnd: string;
  bandMode: BandMode;
  bandOffsets: BandOffsets;
  includesProvisionalSpot: boolean;
}

/** A persisted fit record in `/data/model.json` (current + history). */
export interface FitRecord {
  fittedAt: string;
  a: number;
  n: number;
  A: number;
  r2: number;
  sigma: number;
  points: number;
  dataStart: string;
  dataEnd: string;
  bandMode: BandMode;
  bandOffsets: BandOffsets;
  includesProvisionalSpot: boolean;
  /** Wall-clock milliseconds the fit's owning job took. */
  durationMs: number;
}

export interface ModelStoreFile {
  current: FitRecord | null;
  history: FitRecord[];
}

// ---------------------------------------------------------------------------
// Spot aggregation (spec section 3.3)
// ---------------------------------------------------------------------------

export interface SpotSample {
  name: string;
  usd: number;
  ageSec: number;
}

export interface SpotResult {
  usd: number;
  at: string;
  stale: boolean;
  quorum: number;
  sources: SpotSample[];
}

// ---------------------------------------------------------------------------
// Jobs & scheduler (spec section 5)
// ---------------------------------------------------------------------------

export type JobKind = 'initial-sync' | 'refit';
export type JobState = 'running' | 'done' | 'error';

export interface Job {
  id: string;
  kind: JobKind;
  startedAt: string;
  finishedAt?: string;
  state: JobState;
  step: string;
  stepIndex: number;
  stepCount: number;
  pct: number;
  etaSeconds: number;
  error?: string;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Settings (spec section 7) — persisted at ${BPL_DATA_DIR}/settings.json.
// ---------------------------------------------------------------------------

export type SourceMode = 'auto' | 'manual';

export interface EnabledSources {
  blockchainInfo: boolean;
  bitstamp: boolean;
  binance: boolean;
  kraken: boolean;
  coinbase: boolean;
  mempoolSpace: boolean;
  coingecko: boolean;
}

export interface Settings {
  /** Auto-refit cadence in hours (1-168). */
  refitIntervalHours: number;
  /** Spot poll cadence in minutes (1-60). */
  spotPollMinutes: number;
  /** Last projection year shown on the chart (2030-2055). */
  projectionEndYear: number;
  /** Residual band methodology. */
  bandMode: BandMode;
  /** `auto` uses every source; `manual` honours enabledSources. */
  sourceMode: SourceMode;
  enabledSources: EnabledSources;
}

// ---------------------------------------------------------------------------
// Activity log (spec section 3 / 5) — /api/events payload.
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  at: string;
  kind: string;
  msg: string;
}

// ---------------------------------------------------------------------------
// HTTP API payloads (spec section 6)
// ---------------------------------------------------------------------------

export interface StatusSpot {
  usd: number;
  at: string;
  stale: boolean;
  quorum: number;
  sources: SpotSample[];
}

export interface StatusModel {
  fittedAt: string;
  a: number;
  n: number;
  A: number;
  r2: number;
  sigma: number;
  points: number;
  dataStart: string;
  dataEnd: string;
  includesProvisionalSpot: boolean;
  durationMs: number;
}

export interface ApiStatus {
  version: string;
  gitSha: string;
  startedAt: string;
  initialSyncDone: boolean;
  spot: StatusSpot | null;
  model: StatusModel | null;
  fairValueNow: number | null;
  deviationPct: number | null;
  currentQuantile: number | null;
  nextRefitAt: string | null;
  refitIntervalHours: number;
  lastDailyAppendAt: string | null;
  sources: SourceStatus[];
}

export interface ApiModel {
  fittedAt: string;
  epochDate: '2009-01-03';
  a: number;
  n: number;
  r2: number;
  sigma: number;
  bandMode: BandMode;
  bandOffsets: BandOffsets;
  sample: { start: string; end: string; count: number; includesProvisionalSpot: boolean };
  projection: { endYear: number; cautionAfterYear: number };
  falsifiability: Falsifiability;
  milestones: Milestones;
  history: Array<{ fittedAt: string; a: number; n: number; r2: number; sigma: number; points: number }>;
}

export type PricePoint = [string, number, number];

export interface ApiPrices {
  start: string;
  end: string;
  count: number;
  decimated: boolean;
  points: PricePoint[];
}

export interface ApiJob {
  current: Job | null;
  last: Job | null;
}
