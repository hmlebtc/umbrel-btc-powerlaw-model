// Tests for settings.ts (spec section 7): numeric-range / enum validation with
// per-field revert, the section-3.3 manual-mode capability floor, env seeding,
// load-path fallback, and the PUT reject path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultSettings,
  loadSettings,
  seedSettingsFromEnv,
  SettingsStore,
  validateSettings,
} from './settings.js';
import type { Settings } from './types.js';

function withDefaults(overrides: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...overrides } as Settings;
}

// ---------------------------------------------------------------------------
// Baseline + numeric/enum validation.
// ---------------------------------------------------------------------------

test('validateSettings: defaults pass unchanged', () => {
  const { errors, resetFields } = validateSettings(defaultSettings());
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
});

test('validateSettings: out-of-range refitIntervalHours reverts to default', () => {
  for (const bad of [0, 200, 1.5]) {
    const { errors, resetFields, settings } = validateSettings(
      withDefaults({ refitIntervalHours: bad }),
    );
    assert.ok(errors.some((e) => e.includes('refitIntervalHours')), `bad=${bad}`);
    assert.ok(resetFields.includes('refitIntervalHours'));
    assert.equal(settings.refitIntervalHours, 12);
  }
});

test('validateSettings: out-of-range spotPollMinutes and projectionEndYear revert', () => {
  const a = validateSettings(withDefaults({ spotPollMinutes: 61 }));
  assert.ok(a.resetFields.includes('spotPollMinutes'));
  assert.equal(a.settings.spotPollMinutes, 5);

  const b = validateSettings(withDefaults({ projectionEndYear: 2100 }));
  assert.ok(b.resetFields.includes('projectionEndYear'));
  assert.equal(b.settings.projectionEndYear, 2045);
});

test('validateSettings: invalid bandMode / sourceMode revert to default', () => {
  const a = validateSettings(withDefaults({ bandMode: 'nonsense' as unknown as Settings['bandMode'] }));
  assert.ok(a.resetFields.includes('bandMode'));
  assert.equal(a.settings.bandMode, 'pointInTime');

  const b = validateSettings(withDefaults({ sourceMode: 'weird' as unknown as Settings['sourceMode'] }));
  assert.ok(b.resetFields.includes('sourceMode'));
  assert.equal(b.settings.sourceMode, 'auto');
});

// ---------------------------------------------------------------------------
// Manual-mode capability floor (spec section 3.3).
// ---------------------------------------------------------------------------

test('validateSettings: manual mode with too few spot sources reverts enabledSources', () => {
  const hostile = withDefaults({
    sourceMode: 'manual',
    enabledSources: {
      blockchainInfo: true, // history ok
      bitstamp: false,
      binance: false,
      kraken: false,
      coinbase: false, // only 0 spot sources
      mempoolSpace: false,
      coingecko: false,
    },
  });
  const { errors, resetFields, settings } = validateSettings(hostile);
  assert.ok(errors.some((e) => e.includes('manual')));
  assert.ok(resetFields.includes('enabledSources'));
  assert.deepEqual(settings.enabledSources, defaultSettings().enabledSources);
});

test('validateSettings: manual mode with no history source reverts enabledSources', () => {
  const hostile = withDefaults({
    sourceMode: 'manual',
    enabledSources: {
      blockchainInfo: false,
      bitstamp: true, // bitstamp alone is not enough for history (needs +binance)
      binance: false,
      kraken: true,
      coinbase: true,
      mempoolSpace: false,
      coingecko: false,
    },
  });
  const { errors, resetFields } = validateSettings(hostile);
  assert.ok(errors.some((e) => e.includes('manual')));
  assert.ok(resetFields.includes('enabledSources'));
});

test('validateSettings: a valid manual config is accepted', () => {
  const good = withDefaults({
    sourceMode: 'manual',
    enabledSources: {
      blockchainInfo: true,
      bitstamp: true,
      binance: false,
      kraken: true,
      coinbase: true,
      mempoolSpace: false,
      coingecko: false,
    },
  });
  const { errors, resetFields } = validateSettings(good);
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
});

// ---------------------------------------------------------------------------
// Env seeding.
// ---------------------------------------------------------------------------

test('seedSettingsFromEnv: reads BPL_* and normalises invalid values', () => {
  const seeded = seedSettingsFromEnv({
    BPL_REFIT_INTERVAL_HOURS: '24',
    BPL_SPOT_POLL_MINUTES: '10',
    BPL_PROJECTION_END_YEAR: '2050',
    BPL_BAND_MODE: 'fullSample',
    BPL_SOURCE_MODE: 'auto',
  } as NodeJS.ProcessEnv);
  assert.equal(seeded.refitIntervalHours, 24);
  assert.equal(seeded.spotPollMinutes, 10);
  assert.equal(seeded.projectionEndYear, 2050);
  assert.equal(seeded.bandMode, 'fullSample');

  const bad = seedSettingsFromEnv({ BPL_REFIT_INTERVAL_HOURS: '999' } as NodeJS.ProcessEnv);
  assert.equal(bad.refitIntervalHours, 12); // out of range -> default
});

// ---------------------------------------------------------------------------
// Load-path fallback + PUT reject.
// ---------------------------------------------------------------------------

test('loadSettings: a hostile persisted value is reverted on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ...defaultSettings(), refitIntervalHours: 999 }),
      'utf8',
    );
    const loaded = loadSettings(dir);
    assert.equal(loaded.refitIntervalHours, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SettingsStore.update: rejects invalid, applies valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    const bad = store.update({ refitIntervalHours: 999 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.length > 0);
    assert.equal(store.get().refitIntervalHours, 12); // unchanged

    const good = store.update({ refitIntervalHours: 6, bandMode: 'fullSample' });
    assert.equal(good.ok, true);
    assert.equal(store.get().refitIntervalHours, 6);
    assert.equal(store.get().bandMode, 'fullSample');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
