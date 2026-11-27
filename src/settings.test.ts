// Tests for settings.ts (spec section 7): numeric-range / enum validation with
// per-field revert, the section-3.3 manual-mode capability floor, env seeding,
// load-path fallback, and the PUT reject path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  takeSettingsNotices,
  manualModeMissingSources,
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

test('validateSettings: every bandMode of spec 15.2 is accepted', () => {
  for (const mode of ['pointInTime', 'fullSample', 'quantileRegression'] as const) {
    const { errors, resetFields, settings } = validateSettings(withDefaults({ bandMode: mode }));
    assert.deepEqual(errors, [], `bandMode=${mode}`);
    assert.deepEqual(resetFields, []);
    assert.equal(settings.bandMode, mode);
  }
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
      coinmetrics: true,
      blockstream: true,
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
      coinmetrics: true,
      blockstream: true,
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
      coinmetrics: true,
      blockstream: true,
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

test('seedSettingsFromEnv: BPL_BAND_MODE seeds quantileRegression (spec 15.2)', () => {
  const seeded = seedSettingsFromEnv({ BPL_BAND_MODE: 'quantileRegression' } as NodeJS.ProcessEnv);
  assert.equal(seeded.bandMode, 'quantileRegression');

  // An unknown mode still falls back to the default rather than persisting.
  const bogus = seedSettingsFromEnv({ BPL_BAND_MODE: 'quantile' } as NodeJS.ProcessEnv);
  assert.equal(bogus.bandMode, 'pointInTime');
});

test('SettingsStore: quantileRegression bandMode round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    assert.equal(store.update({ bandMode: 'quantileRegression' }).ok, true);
    assert.equal(store.get().bandMode, 'quantileRegression');
    // Persisted, and it survives a reload (the load path must accept it too).
    assert.equal(loadSettings(dir).bandMode, 'quantileRegression');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Holdings (spec section 13.2) — personal year-end-table what-if amounts.
// Same dual-path shape as every other field: a structural problem is reported
// (so PUT 400s) AND reverts the WHOLE holdings object to its default (so the
// load/seed/init path falls back).
// ---------------------------------------------------------------------------

/** Build a Settings whose holdings is `h` verbatim (bypassing the TS shape so
 *  the validator's own range/key checks are what we exercise). */
function withHoldings(h: unknown): Settings {
  return { ...defaultSettings(), holdings: h as Settings['holdings'] };
}

test('validateSettings: defaults ship holdings empty + disabled', () => {
  assert.deepEqual(defaultSettings().holdings, { enabled: false, globalBtc: 0, perYear: {} });
});

test('validateSettings: a valid holdings object passes unchanged', () => {
  const holdings = { enabled: true, globalBtc: 2.5, perYear: { '2025': 0.125, '2030': 21_000_000 } };
  const { errors, resetFields, settings } = validateSettings(withHoldings(holdings));
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
  assert.deepEqual(settings.holdings, holdings);
});

test('validateSettings: enabled is coerced to a real boolean', () => {
  const { settings } = validateSettings(withHoldings({ enabled: 1, globalBtc: 0, perYear: {} }));
  assert.equal(settings.holdings.enabled, true);
});

test('validateSettings: negative or >21M globalBtc reverts the whole holdings field', () => {
  for (const bad of [-1, 21_000_001, Number.NaN, Infinity, '5']) {
    const { errors, resetFields, settings } = validateSettings(
      withHoldings({ enabled: true, globalBtc: bad, perYear: { '2025': 1 } }),
    );
    assert.ok(errors.some((e) => e.includes('globalBtc')), `bad=${String(bad)}`);
    assert.ok(resetFields.includes('holdings'));
    assert.deepEqual(settings.holdings, defaultSettings().holdings);
  }
});

test('validateSettings: a negative or >21M perYear amount reverts holdings', () => {
  for (const bad of [-0.5, 21_000_001, '2']) {
    const { errors, resetFields, settings } = validateSettings(
      withHoldings({ enabled: true, globalBtc: 0, perYear: { '2025': bad } }),
    );
    assert.ok(errors.some((e) => e.includes('perYear')), `bad=${String(bad)}`);
    assert.ok(resetFields.includes('holdings'));
    assert.deepEqual(settings.holdings, defaultSettings().holdings);
  }
});

test('validateSettings: bad perYear year keys revert holdings', () => {
  for (const badKey of ['abc', '99', '2008', '2061', '20255']) {
    const { errors, resetFields, settings } = validateSettings(
      withHoldings({ enabled: false, globalBtc: 0, perYear: { [badKey]: 1 } }),
    );
    assert.ok(errors.some((e) => e.includes('year key')), `badKey=${badKey}`);
    assert.ok(resetFields.includes('holdings'));
    assert.deepEqual(settings.holdings, defaultSettings().holdings);
  }
});

test('validateSettings: the 2009..2060 year-key boundaries are accepted', () => {
  const holdings = { enabled: true, globalBtc: 0, perYear: { '2009': 1, '2060': 2 } };
  const { errors, resetFields } = validateSettings(withHoldings(holdings));
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
});

test('validateSettings: more than 60 perYear entries reverts holdings', () => {
  // The 2009..2060 window only admits 52 keys, so 61 entries necessarily spill
  // outside it — but the >60 count check runs before the per-key loop and fires
  // its own distinct 'exceed' error, which is what we assert here.
  const many: Record<string, number> = {};
  for (let y = 2001; y <= 2061; y++) many[String(y)] = 1; // 61 entries
  assert.equal(Object.keys(many).length, 61);
  const { errors, resetFields, settings } = validateSettings(
    withHoldings({ enabled: false, globalBtc: 0, perYear: many }),
  );
  assert.ok(errors.some((e) => e.includes('exceed')));
  assert.ok(resetFields.includes('holdings'));
  assert.deepEqual(settings.holdings, defaultSettings().holdings);
});

test('validateSettings: a non-object holdings (or perYear) reverts to default', () => {
  for (const garbage of ['nope', 42, [], null]) {
    const { errors, resetFields, settings } = validateSettings(withHoldings(garbage));
    assert.ok(errors.some((e) => e.includes('holdings')), `garbage=${JSON.stringify(garbage)}`);
    assert.ok(resetFields.includes('holdings'));
    assert.deepEqual(settings.holdings, defaultSettings().holdings);
  }
  const badPerYear = validateSettings(withHoldings({ enabled: true, globalBtc: 0, perYear: 'x' }));
  assert.ok(badPerYear.errors.some((e) => e.includes('perYear')));
  assert.ok(badPerYear.resetFields.includes('holdings'));
  assert.deepEqual(badPerYear.settings.holdings, defaultSettings().holdings);
});

test('SettingsStore.update: a valid holdings patch round-trips (enable, globalBtc, perYear)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    const res = store.update({ holdings: { enabled: true, globalBtc: 1.25, perYear: { '2025': 0.5 } } });
    assert.equal(res.ok, true);
    assert.deepEqual(store.get().holdings, { enabled: true, globalBtc: 1.25, perYear: { '2025': 0.5 } });
    // Reloading from disk yields the same persisted holdings.
    assert.deepEqual(loadSettings(dir).holdings, { enabled: true, globalBtc: 1.25, perYear: { '2025': 0.5 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SettingsStore.update: PUT replaces perYear wholesale (not a deep-merge union)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    assert.equal(store.update({ holdings: { enabled: true, globalBtc: 0, perYear: { '2024': 1, '2025': 2 } } }).ok, true);
    // A second PUT carrying a different perYear must REPLACE, never union.
    assert.equal(store.update({ holdings: { perYear: { '2030': 3 } } as unknown as Settings['holdings'] }).ok, true);
    assert.deepEqual(store.get().holdings.perYear, { '2030': 3 });
    // Untouched sibling fields survive the perYear-only patch.
    assert.equal(store.get().holdings.enabled, true);
    // Clearing perYear entirely is possible via an empty object.
    assert.equal(store.update({ holdings: { perYear: {} } as unknown as Settings['holdings'] }).ok, true);
    assert.deepEqual(store.get().holdings.perYear, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SettingsStore.update: invalid holdings is rejected, leaving current unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    assert.equal(store.update({ holdings: { enabled: true, globalBtc: 3, perYear: { '2025': 1 } } }).ok, true);
    const bad = store.update({ holdings: { globalBtc: -5 } as unknown as Settings['holdings'] });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes('globalBtc')));
    // No partial application: the last good holdings survives verbatim.
    assert.deepEqual(store.get().holdings, { enabled: true, globalBtc: 3, perYear: { '2025': 1 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: a legacy settings.json without holdings loads with holdings defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    // A file written before v0.1.3: every documented field EXCEPT holdings.
    const legacy = {
      refitIntervalHours: 24,
      spotPollMinutes: 10,
      projectionEndYear: 2050,
      bandMode: 'fullSample',
      sourceMode: 'auto',
      enabledSources: defaultSettings().enabledSources,
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(legacy), 'utf8');
    const loaded = loadSettings(dir);
    // The deep-merge-onto-defaults path supplies the whole holdings object.
    assert.deepEqual(loaded.holdings, defaultSettings().holdings);
    // Other legacy fields are preserved (holdings is a pure addition).
    assert.equal(loaded.refitIntervalHours, 24);
    assert.equal(loaded.projectionEndYear, 2050);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings: a hostile persisted holdings is reverted on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ...defaultSettings(), holdings: { enabled: true, globalBtc: -9, perYear: { bad: 1 } } }),
      'utf8',
    );
    assert.deepEqual(loadSettings(dir).holdings, defaultSettings().holdings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.2.0: the coinmetrics / blockstream block-height sources.
// ---------------------------------------------------------------------------

test('defaultSettings: coinmetrics and blockstream are on by default', () => {
  const d = defaultSettings();
  assert.equal(d.enabledSources.coinmetrics, true);
  assert.equal(d.enabledSources.blockstream, true);
});

test('loadSettings: a v0.1.8 settings.json without the two height sources loads them as true, no errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const old = defaultSettings() as unknown as Record<string, unknown>;
    const oldSources: Record<string, boolean> = { ...(old.enabledSources as Record<string, boolean>), mempoolSpace: false };
    delete oldSources.coinmetrics;
    delete oldSources.blockstream;
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...old, enabledSources: oldSources }), 'utf8');
    const loaded = loadSettings(dir);
    assert.equal(loaded.enabledSources.coinmetrics, true);
    assert.equal(loaded.enabledSources.blockstream, true);
    assert.equal(loaded.enabledSources.mempoolSpace, false, 'existing choices are preserved');
    // The merged result passes validation untouched (no reset fields).
    assert.deepEqual(validateSettings(loaded).resetFields, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateSettings: manual mode has no new floor — both height sources may be off', () => {
  const s = withDefaults({
    sourceMode: 'manual',
    enabledSources: { ...defaultSettings().enabledSources, coinmetrics: false, blockstream: false },
  });
  const { errors, resetFields, settings } = validateSettings(s);
  assert.deepEqual(errors, []);
  assert.deepEqual(resetFields, []);
  assert.equal(settings.enabledSources.coinmetrics, false);
  assert.equal(settings.enabledSources.blockstream, false);
});

test('SettingsStore.update: a partial PUT toggles one height source and coerces booleans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const store = new SettingsStore(dir, defaultSettings());
    const r = store.update({ enabledSources: { coinmetrics: false } as never });
    assert.equal(r.ok, true);
    assert.equal(store.get().enabledSources.coinmetrics, false);
    assert.equal(store.get().enabledSources.blockstream, true);
    assert.equal(store.get().enabledSources.blockchainInfo, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v0.2.0: the `model` setting (powerLaw | refraction), validated like bandMode.
// ---------------------------------------------------------------------------

test("model: defaults to 'powerLaw'; an old settings.json without it loads as 'powerLaw'", () => {
  assert.equal(defaultSettings().model, 'powerLaw');
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    const old: Record<string, unknown> = { ...defaultSettings() };
    delete old.model;
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(old), 'utf8');
    assert.equal(loadSettings(dir).model, 'powerLaw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model: BPL_MODEL seeds the first boot; a bad seed falls back to the default', () => {
  assert.equal(seedSettingsFromEnv({ BPL_MODEL: 'refraction' } as NodeJS.ProcessEnv).model, 'refraction');
  assert.equal(seedSettingsFromEnv({ BPL_MODEL: 'nope' } as NodeJS.ProcessEnv).model, 'powerLaw');
  assert.equal(seedSettingsFromEnv({} as NodeJS.ProcessEnv).model, 'powerLaw');
});

test('model: validateSettings reports and reverts a bad value; a good one passes', () => {
  const bad = validateSettings(withDefaults({ model: 'eqm' as never }));
  assert.ok(bad.errors.some((e) => e.includes('model')));
  assert.deepEqual(bad.resetFields, ['model']);
  assert.equal(bad.settings.model, 'powerLaw');
  assert.deepEqual(validateSettings(withDefaults({ model: 'refraction' })).errors, []);
});

test('model: a hostile persisted value is reverted on load; PUT rejects it without applying', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...defaultSettings(), model: 7 }), 'utf8');
    assert.equal(loadSettings(dir).model, 'powerLaw');
    const store = new SettingsStore(dir, defaultSettings());
    const bad = store.update({ model: 'x' as never });
    assert.equal(bad.ok, false);
    assert.equal(store.get().model, 'powerLaw');
    assert.equal(store.update({ model: 'refraction' }).ok, true);
    assert.equal(store.get().model, 'refraction');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review round 1, R11: manual mode keeps the new hosts OFF.
// ---------------------------------------------------------------------------

function writeOld(dir: string, sourceMode: string, enabledSources: Record<string, boolean>): void {
  const old: Record<string, unknown> = { ...defaultSettings(), sourceMode, enabledSources };
  delete old.model;
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(old), 'utf8');
}
const OLD_SOURCES = (() => {
  const e: Record<string, boolean> = { ...defaultSettings().enabledSources };
  delete e.coinmetrics;
  delete e.blockstream;
  return e;
})();

test('R11: an existing manual-mode settings.json without the new keys loads them OFF, persists that, and raises one notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    takeSettingsNotices();
    writeOld(dir, 'manual', OLD_SOURCES);
    assert.deepEqual(manualModeMissingSources(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))), ['coinmetrics', 'blockstream']);
    const s = loadSettings(dir);
    assert.equal(s.enabledSources.coinmetrics, false);
    assert.equal(s.enabledSources.blockstream, false);
    assert.equal(s.enabledSources.blockchainInfo, true);
    const notices = takeSettingsNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /coinmetrics and blockstream.*OFF.*Settings/);
    // Persisted: the next boot finds the keys and stays quiet.
    const again = loadSettings(dir);
    assert.equal(again.enabledSources.coinmetrics, false);
    assert.deepEqual(takeSettingsNotices(), []);
    // The user can switch them on afterwards and that sticks.
    const store = new SettingsStore(dir, again);
    assert.equal(store.update({ enabledSources: { coinmetrics: true } as never }).ok, true);
    assert.equal(loadSettings(dir).enabledSources.coinmetrics, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R11: auto mode, fresh installs and manual files that already have the keys keep their values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
  try {
    takeSettingsNotices();
    writeOld(dir, 'auto', OLD_SOURCES);
    assert.equal(loadSettings(dir).enabledSources.coinmetrics, true);
    writeOld(dir, 'manual', { ...OLD_SOURCES, coinmetrics: true });
    const partial = loadSettings(dir);
    assert.equal(partial.enabledSources.coinmetrics, true); // present: honoured
    assert.equal(partial.enabledSources.blockstream, false); // absent: off
    assert.equal(takeSettingsNotices().length, 1);
    const fresh = mkdtempSync(join(tmpdir(), 'bpl-settings-'));
    try {
      assert.equal(loadSettings(fresh, {} as NodeJS.ProcessEnv).enabledSources.coinmetrics, true);
      assert.deepEqual(takeSettingsNotices(), []);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
