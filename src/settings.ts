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
