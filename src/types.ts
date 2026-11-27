/**
 * Shared data types (spec sections 3-7, 9). Dependency-free: it only declares
 * the JSON shapes that cross module / HTTP boundaries, so the pure model engine
 * (model.ts), the data layer (priceStore/spot), the job runner and the HTTP
 * router all agree on one contract. Nothing here carries a model coefficient;
 * every A/n/sigma value is computed at fit time.
 */

import type { RefractionFit } from './refraction.js';

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
// Block-height store (v0.2.0 spec section 3) — /data/heights.json.
// ---------------------------------------------------------------------------

/**
 * One day's block height: `h` = TRUE chain height of the last block of UTC day
 * `date` (Coin Metrics' cumulative count minus the calibrated offset). `usd` is the
 * Coin Metrics `PriceUSD` close of that day when the day came from Coin Metrics with
 * a price.
 */
export interface HeightObservation {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string;
  h: number;
  usd?: number;
}

/** A completed close paired with its true height: one row of the Refraction fit sample. */
export interface HeightClose {
  date: string;
  usd: number;
  h: number;
}

/** One day's raw (non-cumulative) block count as served by Coin Metrics `BlkCnt`. */
export interface BlockCountObservation {
  date: string;
  count: number;
  /** Coin Metrics `PriceUSD` close for the day; absent before 2010-07-18 or when not yet published. */
  usd?: number;
}

/** A difficulty-adjustment epoch boundary: block `height` was timestamped at `time` (unix seconds). */
export interface HeightEpoch {
  time: number;
  height: number;
}

/** One day's canonical record in `/data/heights.json`. */
export interface HeightRecord {
  h: number;
  /** Coin Metrics `PriceUSD` close; only on days written from Coin Metrics that carried a price. */
  usd?: number;
  /** `coinmetrics` (authoritative) | `seed` (bundled snapshot) | `tip` (derived from the live tip). */
  src: string;
  /** `interpolated` (replaced when the primary catches up) | `divergent` (epoch cross-check >50 blocks). */
  flags?: string[];
}

/** Latest chain tip seen by the height pipeline. */
export interface HeightTip {
  height: number;
  /** ISO timestamp the tip was observed. */
  at: string;
}

/** On-disk shape of `/data/heights.json` (`tip` is an additive optional field). */
export interface HeightStoreFile {
  version: 1;
  updatedAt: string;
  days: Record<string, HeightRecord>;
  tip?: HeightTip;
  /**
   * Calibrated `cumulative count - chain height` the `coinmetrics` days are stored
   * on. Absent in files written before v0.2.0's true-height basis: those days are
   * raw cumulative counts (offset 0) and are rebased on the next reconcile.
   */
  offset?: number;
  /** ms of the last successful full Coin Metrics load (drives the weekly integrity pass). */
  fullLoadAt?: number;
  /** Diagnostic offsets already announced (one activity event per distinct value). */
  offsetNoticed?: number[];
}

/** GET /api/heights payload: a dense daily array; index i is date `start` + i days. */
export interface ApiHeights {
  start: string;
  end: string;
  count: number;
  heights: number[];
  tip: HeightTip | null;
}

// ---------------------------------------------------------------------------
// Sources (spec section 3.2) — per-source health tracked in memory.
// ---------------------------------------------------------------------------

/** `height` = block-height capabilities (daily block counts, difficulty epochs, chain tip). */
export type SourceKind = 'history' | 'spot' | 'height';

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
  /**
   * Health of the block-height calls (counts, epochs, tip, lookup), tracked apart
   * from price health so a working tip endpoint can never mask a failing history or
   * spot endpoint. Present only on sources that have BOTH price and height
   * capabilities; for height-only sources (coinmetrics, blockstream) the main fields
   * above ARE the height health.
   */
  heightHealth?: SourceHealth;
}

// ---------------------------------------------------------------------------
// Model engine (spec section 4) — all recomputed each fit, never persisted as
// a source-of-truth coefficient.
// ---------------------------------------------------------------------------

export type BandMode = 'pointInTime' | 'fullSample' | 'quantileRegression';

/**
 * Residual-percentile offsets (log10 space) added to the trend line. Thirteen
 * percentiles, drawn as individual labelled lines since v0.1.2:
 * 0.01, 0.5, 2.5, 10, 16.5, 25, 50, 75, 83.5, 90, 97.5, 99.5, 99.99.
 * p025/p165/p835/p975 keep their original meaning; p005/p25/p75/p995 were added in
 * v0.1.1; p10/p50/p90 are a pure v0.1.2 addition; p0001/p9999 — the extreme
 * envelope pair, effectively the historical floor/ceiling — a pure v0.1.7 addition.
 * Records persisted before v0.1.7 carry only the eleven v0.1.2 keys (before v0.1.2
 * only the eight v0.1.1 keys, before v0.1.1 only the original four) — consumers must
 * guard on presence and treat absent keys as "not available until the next refit".
 */
export interface BandOffsets {
  p0001: number;
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
  p9999: number;
}

/**
 * One quantile-regression line in log10 space: `log10(price) = a + n*log10(t)`
 * (spec section 15.1). Same shape as the trend line, but fitted to a single
 * percentile of the price history rather than its mean — so each line carries
 * its OWN slope and the fan can narrow (or widen) with t instead of keeping the
 * constant width a residual offset implies.
 */
export interface BandLine {
  /** Intercept in log10 space. */
  a: number;
  /** Slope / exponent of this percentile's own regression. */
  n: number;
}

/**
 * The thirteen quantile-regression lines of the band ladder (spec sections 15.1
 * and 16.1), keyed exactly like BandOffsets and declared in ascending-percentile
 * order — the order model.ts's monotone rearrangement assigns sorted values back
 * in. Present only on fits taken with bandMode `quantileRegression`; records
 * written before v0.1.6 (or in the other two modes) simply have no `bandLines`,
 * and v0.1.6 records carry the eleven-line ladder without p0001/p9999.
 */
export interface BandLines {
  p0001: BandLine;
  p005: BandLine;
  p025: BandLine;
  p10: BandLine;
  p165: BandLine;
  p25: BandLine;
  p50: BandLine;
  p75: BandLine;
  p835: BandLine;
  p90: BandLine;
  p975: BandLine;
  p995: BandLine;
  p9999: BandLine;
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
  /** Quantile-regression ladder — only in bandMode `quantileRegression`. */
  bandLines?: BandLines;
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
  /**
   * Quantile-regression ladder (v0.1.6+, bandMode `quantileRegression` only).
   * Absent on every other record — consumers must guard on presence and fall
   * back to the `bandOffsets` path.
   */
  bandLines?: BandLines;
  includesProvisionalSpot: boolean;
  /** Wall-clock milliseconds the fit's owning job took. */
  durationMs: number;
  /**
   * Refraction model fit taken in the same job (v0.2.0). Absent on records written
   * before it, when no heights were available, or when the fit failed — consumers
   * must guard on presence.
   */
  refraction?: RefractionRecord;
}

/** Which daily-close series a Refraction fit was made on (spec 2.4 price-series rule). */
export type PriceSeriesKind = 'coinmetrics' | 'canonical';

/** The engine's fit plus the provenance needed to evaluate and explain it later. */
export interface RefractionRecord extends RefractionFit {
  priceSeries: PriceSeriesKind;
  /** Fingerprint of the closes the fit saw (count, sum of h, sum of usd); lets the exact percentile detect a different sample. */
  sampleChecksum?: { n: number; sumH: number; sumUsd: number };
  /** Wall-clock milliseconds `fitRefraction` itself took. */
  fitMs: number;
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

/** Which model the dashboard's chart/readouts show (both are always fitted). */
export type ModelKind = 'powerLaw' | 'refraction';

export interface EnabledSources {
  blockchainInfo: boolean;
  bitstamp: boolean;
  binance: boolean;
  kraken: boolean;
  coinbase: boolean;
  mempoolSpace: boolean;
  coingecko: boolean;
  /** Block-height sources (v0.2.0). Absent in older settings.json files => default true. */
  coinmetrics: boolean;
  blockstream: boolean;
}

/**
 * Personal holdings for the year-end table's "My holdings" valuation (spec
 * section 13.2). Purely a dashboard-entered what-if — it never touches the
 * model, scheduler or any source. Deliberately NOT env-seeded (personal data);
 * a fresh install starts empty and disabled.
 */
export interface Holdings {
  /** Whether the year-end table renders in holdings-valuation mode. */
  enabled: boolean;
  /** BTC applied to every year unless overridden per-year (0..21,000,000). */
  globalBtc: number;
  /**
   * Per-year BTC overrides keyed by 4-digit UTC year (`"YYYY"`, 2009..2060),
   * each 0..21,000,000. At most 60 entries. A PUT REPLACES this map wholesale
   * (it is not deep-merged with the entries already on disk).
   */
  perYear: Record<string, number>;
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
  /** Displayed model (v0.2.0); selecting it never triggers a refit. */
  model: ModelKind;
  /** `auto` uses every source; `manual` honours enabledSources. */
  sourceMode: SourceMode;
  enabledSources: EnabledSources;
  /** Year-end table holdings valuation (spec section 13.2). */
  holdings: Holdings;
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

/**
 * `/api/status.refraction` — the Refraction model evaluated NOW (spec 5.3). Present
 * only when the current fit carries a refraction record.
 */
/** Last close of the fitted sample, valued by the fit (B1). */
export interface StatusLastClose {
  date: string;
  usd: number;
  /** True height of that close. */
  height: number;
  /** Exact percentile of that close against the fit's own sample. */
  percentile: number;
  /** 50th-percentile line at `height`. */
  fairValue: number;
}

export interface StatusRefraction {
  /** Height used for every `*Now` value below. */
  heightNow: number;
  /** True when `heightNow` is a live chain tip observed within the last 3 hours. */
  heightIsLive: boolean;
  /** Last close of the fitted sample; null when the fit's sample cannot be reproduced. */
  lastClose: StatusLastClose | null;
  /** Whole days `dataEnd` lags behind yesterday (UTC); 0 when the fit is current. */
  staleDays: number;
  /** Price of the 50th-percentile line at `heightNow`. */
  fairValueNow: number;
  /** 0.1th-percentile line (the floor). */
  floorNow: number;
  /** 5th-percentile line (the anchor). */
  anchorNow: number;
  /** 99.9th-percentile line (the top). */
  topNow: number;
  /** (spot - fairValueNow) / fairValueNow * 100; null without a live spot. */
  deviationPct: number | null;
  /** Percentile of the live spot (exact against the fit's closes when available); null without a spot. */
  percentile: number | null;
  b1: number;
  c: number;
  points: number;
  dataEnd: string;
  priceSeries: PriceSeriesKind;
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
  /** Refraction model now (v0.2.0); absent when there is no refraction fit. */
  refraction?: StatusRefraction;
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
  /** Present only when the served fit carries a quantile-regression ladder. */
  bandLines?: BandLines;
  sample: { start: string; end: string; count: number; includesProvisionalSpot: boolean };
  projection: { endYear: number; cautionAfterYear: number };
  falsifiability: Falsifiability;
  milestones: Milestones;
  /** The current record's Refraction fit + `priceSeries` (v0.2.0); absent when it has none. */
  refraction?: RefractionRecord;
  history: Array<{
    fittedAt: string;
    a: number;
    n: number;
    r2: number;
    sigma: number;
    points: number;
    /** Refraction anchor slope / decay rate of that fit, when it had one. */
    refractionB1?: number;
    refractionC?: number;
  }>;
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
