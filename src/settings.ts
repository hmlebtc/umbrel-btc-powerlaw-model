/**
 * Persisted settings (spec section 7) — ${BPL_DATA_DIR}/settings.json.
 *
 * On first boot (file absent) settings are seeded from BPL_* env vars, then the
 * saved file always wins — env changes never clobber a live configuration (the
 * "env seeds once" pattern from the reference app). Validation follows the same
 * dual-path shape: every field that fails is reported in `errors` AND reverted
 * to its default (recorded in `resetFields`). The load/seed/store-init paths
 * fall back per-field and log; the interactive PUT /api/settings path rejects
 * (400) with the error list instead of silently reverting.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log } from './log.js';
import type { BandMode, EnabledSources, Settings, SourceMode } from './types.js';

// ---------------------------------------------------------------------------
// Defaults — must match the compose env defaults (Agent C) so a fresh install
// and the MOCK=1 E2E are coherent out of the box.
// ---------------------------------------------------------------------------

export function defaultSettings(): Settings {
  return {
    refitIntervalHours: 12,
    spotPollMinutes: 5,
    projectionEndYear: 2045,
    bandMode: 'pointInTime',
    sourceMode: 'auto',
    enabledSources: {
      blockchainInfo: true,
      bitstamp: true,
      binance: true,
      kraken: true,
      coinbase: true,
      mempoolSpace: true,
      coingecko: true,
    },
    // Personal what-if amounts (spec 13.2); empty + off on a fresh install.
    holdings: {
      enabled: false,
      globalBtc: 0,
      perYear: {},
    },
  };
}

/** Spot-capable sources (spec section 3.3 spot pool). blockchainInfo is history-only. */
const SPOT_SOURCE_KEYS: Array<keyof EnabledSources> = [
  'bitstamp',
  'binance',
  'kraken',
  'coinbase',
  'mempoolSpace',
  'coingecko',
];

const BAND_MODES: BandMode[] = ['pointInTime', 'fullSample'];
const SOURCE_MODES: SourceMode[] = ['auto', 'manual'];

// ---------------------------------------------------------------------------
// Merge / validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, patchVal] of Object.entries(patch)) {
    const baseVal = out[key];
    out[key] =
      isPlainObject(patchVal) && isPlainObject(baseVal) ? deepMerge(baseVal, patchVal) : patchVal;
  }
  return out as T;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Finite real number in an inclusive range (BTC amounts are fractional). */
function isNumInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

// Holdings bounds (spec section 13.2). BTC amounts are fractional (up to 8 dp)
// and capped at the 21M supply; perYear is keyed by 4-digit years 2009..2060,
// at most 60 entries.
const HOLDINGS_MAX_BTC = 21_000_000;
const HOLDINGS_MAX_YEARS = 60;
const HOLDINGS_YEAR_MIN = 2009;
const HOLDINGS_YEAR_MAX = 2060;
const YEAR_KEY_RE = /^\d{4}$/;

export interface ValidationResult {
  errors: string[];
  /** Top-level field names that failed and were reverted to their default. */
  resetFields: string[];
  settings: Settings;
}

/**
 * Validate + normalise a fully-populated settings object. Each failing field is
 * reported in `errors` (so PUT can 400) AND reverted to its default in the
 * returned `settings` with its name in `resetFields` (so the load/seed/init
 * paths can fall back per field). enabledSources booleans are coerced; a manual
 * config that cannot satisfy the section-3.3 capability floor reverts the map.
 */
export function validateSettings(input: Settings): ValidationResult {
  const errors: string[] = [];
  const resetFields: string[] = [];
  const def = defaultSettings();
  const c = deepMerge(def, clone(input)) as Settings;

  const reset = (field: keyof Settings, msg: string): void => {
    errors.push(msg);
    if (!resetFields.includes(field)) resetFields.push(field);
    (c as unknown as Record<string, unknown>)[field] = clone(
      (def as unknown as Record<string, unknown>)[field],
    );
  };

  if (!isIntInRange(c.refitIntervalHours, 1, 168)) {
    reset('refitIntervalHours', 'refitIntervalHours must be an integer between 1 and 168');
  }
  if (!isIntInRange(c.spotPollMinutes, 1, 60)) {
    reset('spotPollMinutes', 'spotPollMinutes must be an integer between 1 and 60');
  }
  if (!isIntInRange(c.projectionEndYear, 2030, 2055)) {
    reset('projectionEndYear', 'projectionEndYear must be an integer between 2030 and 2055');
  }
  if (!BAND_MODES.includes(c.bandMode)) {
    reset('bandMode', "bandMode must be 'pointInTime' or 'fullSample'");
  }
  if (!SOURCE_MODES.includes(c.sourceMode)) {
    reset('sourceMode', "sourceMode must be 'auto' or 'manual'");
  }

  // Coerce every enabledSources flag to a real boolean (defends against strings
  // like "false" arriving from a hand-edited settings.json / query).
  const es = isPlainObject(c.enabledSources) ? (c.enabledSources as Record<string, unknown>) : {};
  const merged: EnabledSources = { ...def.enabledSources };
  for (const key of Object.keys(def.enabledSources) as Array<keyof EnabledSources>) {
    if (key in es) merged[key] = Boolean(es[key]);
  }
  c.enabledSources = merged;

  // Manual-mode capability floor (spec section 3.3): a usable history source AND
  // at least two spot sources. An unsatisfiable manual map reverts to all-on.
  if (c.sourceMode === 'manual') {
    const historyOk =
      c.enabledSources.blockchainInfo || (c.enabledSources.bitstamp && c.enabledSources.binance);
    const spotCount = SPOT_SOURCE_KEYS.filter((k) => c.enabledSources[k]).length;
    if (!historyOk || spotCount < 2) {
      errors.push(
        'manual sourceMode requires a history source (blockchainInfo, or bitstamp+binance) ' +
          'and at least 2 spot sources',
      );
      if (!resetFields.includes('enabledSources')) resetFields.push('enabledSources');
      c.enabledSources = clone(def.enabledSources);
    }
  }

  // Holdings (spec 13.2) — same dual-path shape as every other field: any
  // structural problem is BOTH reported (so PUT 400s) AND reverts the WHOLE
  // holdings object to its default (so the load/seed/init path falls back and
  // logs). Follows the folders-array pattern: `enabled` coerced to a boolean;
  // globalBtc and each perYear value must be finite numbers in [0, 21,000,000];
  // perYear keys must be 4-digit years in [2009, 2060] with at most 60 entries.
  const rawH = (c as unknown as Record<string, unknown>).holdings;
  if (!isPlainObject(rawH)) {
    reset('holdings', 'holdings must be an object');
  } else {
    let bad = false;
    if (!isNumInRange(rawH.globalBtc, 0, HOLDINGS_MAX_BTC)) {
      errors.push(`holdings.globalBtc must be a number between 0 and ${HOLDINGS_MAX_BTC}`);
      bad = true;
    }
    const cleanPerYear: Record<string, number> = {};
    if (!isPlainObject(rawH.perYear)) {
      errors.push('holdings.perYear must be an object');
      bad = true;
    } else {
      const entries = Object.entries(rawH.perYear);
      if (entries.length > HOLDINGS_MAX_YEARS) {
        errors.push(`holdings.perYear cannot exceed ${HOLDINGS_MAX_YEARS} entries`);
        bad = true;
      }
      for (const [year, amount] of entries) {
        const yr = Number(year);
        if (!YEAR_KEY_RE.test(year) || yr < HOLDINGS_YEAR_MIN || yr > HOLDINGS_YEAR_MAX) {
          errors.push(`holdings.perYear has an invalid year key: ${JSON.stringify(year)}`);
          bad = true;
          continue;
        }
        if (!isNumInRange(amount, 0, HOLDINGS_MAX_BTC)) {
          errors.push(`holdings.perYear[${year}] must be a number between 0 and ${HOLDINGS_MAX_BTC}`);
          bad = true;
          continue;
        }
        cleanPerYear[year] = amount;
      }
    }
    if (bad) {
      if (!resetFields.includes('holdings')) resetFields.push('holdings');
      c.holdings = clone(def.holdings);
    } else {
      c.holdings = { enabled: Boolean(rawH.enabled), globalBtc: rawH.globalBtc as number, perYear: cleanPerYear };
    }
  }

  return { errors, resetFields, settings: c };
}

/**
 * Load/seed/init path: validate with per-field fallback and LOG any reverted
 * field (so a corrupt settings.json / bad BPL_* value can never persist). Returns
 * the safe settings.
 */
function sanitizeSettings(input: Settings, source: string): Settings {
  const { settings, resetFields } = validateSettings(input);
  if (resetFields.length > 0) {
    log(
      `settings: ${resetFields.length} invalid field(s) reset to defaults ` +
        `(${resetFields.join(', ')}) [source: ${source}]`,
    );
  }
  return settings;
}

// ---------------------------------------------------------------------------
// First-boot env seeding (BPL_* — must match compose env names, Agent C).
// ---------------------------------------------------------------------------

function envInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

export function seedSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const c = defaultSettings();

  const refit = envInt(env.BPL_REFIT_INTERVAL_HOURS);
  if (refit !== undefined) c.refitIntervalHours = refit;
  const poll = envInt(env.BPL_SPOT_POLL_MINUTES);
  if (poll !== undefined) c.spotPollMinutes = poll;
  const endYear = envInt(env.BPL_PROJECTION_END_YEAR);
  if (endYear !== undefined) c.projectionEndYear = endYear;
  if (env.BPL_BAND_MODE) c.bandMode = env.BPL_BAND_MODE as BandMode;
  if (env.BPL_SOURCE_MODE) c.sourceMode = env.BPL_SOURCE_MODE as SourceMode;

  // NOTE (spec 13.2): `holdings` is deliberately NOT seeded from any BPL_* env
  // var. It is personal, dashboard-entered data (how much BTC the user holds),
  // not an operator tuning knob, so there is no compose default to propagate and
  // no reason to let an environment value pre-populate someone's private figures.
  // It always starts at the defaultSettings() empty/disabled state on first boot.

  // Normalise + fall back per field so a bad env value can't persist an invalid
  // configuration on first boot.
  return sanitizeSettings(c, 'env');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function saveSettings(dataDir: string, settings: Settings): void {
  atomicWriteJson(settingsPath(dataDir), settings);
}

export function loadSettings(dataDir: string, env: NodeJS.ProcessEnv = process.env): Settings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) {
    const seeded = seedSettingsFromEnv(env);
    saveSettings(dataDir, seeded);
    return seeded;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return defaultSettings();
  }
  return sanitizeSettings(deepMerge(defaultSettings(), parsed), 'settings.json');
}

/**
 * Mutable holder so a live PUT is reflected everywhere settings are read via
 * get(). update() validates + persists + applies, returning {ok:true} or
 * {ok:false, errors:[...]} (no partial application on error).
 */
export class SettingsStore {
  private current: Settings;

  constructor(private readonly dataDir: string, initial?: Settings) {
    this.current = initial ? sanitizeSettings(initial, 'store-init') : loadSettings(dataDir);
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): { ok: true } | { ok: false; errors: string[] } {
    const merged = deepMerge(this.current, patch);
    // Spec 13.2: a PUT REPLACES the whole holdings.perYear map. deepMerge would
    // otherwise union it with the entries already on disk (both are plain
    // objects), so when the patch supplies holdings.perYear it wins wholesale
    // (validateSettings still normalises / can revert it).
    const patchHoldings = (patch as { holdings?: unknown }).holdings;
    if (isPlainObject(patchHoldings) && 'perYear' in patchHoldings) {
      (merged as Settings).holdings.perYear = clone(patchHoldings.perYear) as Record<string, number>;
    }
    const { errors, settings } = validateSettings(merged);
    if (errors.length > 0) return { ok: false, errors };
    this.current = settings;
    try {
      saveSettings(this.dataDir, settings);
    } catch {
      /* keep the in-memory update even if persistence fails */
    }
    return { ok: true };
  }
}
