// Tests for priceStore.ts (spec sections 3.1-3.3): reconcile paths, recent-fill
// quorum + unconfirmed flag, and >5% cross-check divergence flagging.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PriceStore, resolveRecentDay } from './priceStore.js';

// ---------------------------------------------------------------------------
// resolveRecentDay: quorum-of-2-within-1% vs unconfirmed.
// ---------------------------------------------------------------------------

test('resolveRecentDay: two sources within 1% agree -> no flag, median value', () => {
  const r = resolveRecentDay([
    { src: 'kraken', usd: 60_000 },
    { src: 'bitstamp', usd: 60_300 },
  ]);
  assert.ok(r);
  assert.deepEqual(r!.flags, []);
  assert.equal(r!.usd, 60_150);
  assert.ok(r!.src.includes('kraken') && r!.src.includes('bitstamp'));
});

test('resolveRecentDay: a lone responder is accepted but unconfirmed', () => {
  const r = resolveRecentDay([{ src: 'kraken', usd: 61_000 }]);
  assert.ok(r);
  assert.deepEqual(r!.flags, ['unconfirmed']);
  assert.equal(r!.usd, 61_000);
  assert.equal(r!.src, 'kraken');
});

test('resolveRecentDay: two sources disagreeing >1% take the median but stay unconfirmed', () => {
  const r = resolveRecentDay([
    { src: 'kraken', usd: 60_000 },
    { src: 'binance', usd: 66_000 },
  ]);
  assert.ok(r);
  assert.deepEqual(r!.flags, ['unconfirmed']);
  assert.equal(r!.usd, 63_000);
});

test('resolveRecentDay: no positive values -> null', () => {
  assert.equal(resolveRecentDay([]), null);
  assert.equal(resolveRecentDay([{ src: 'x', usd: 0 }]), null);
});

// ---------------------------------------------------------------------------
// reconcilePrimary: add new, update changed (clearing unconfirmed).
// ---------------------------------------------------------------------------

test('reconcilePrimary: adds missing days and updates changed values', () => {
  const store = new PriceStore();
  const first = store.reconcilePrimary(
    [
      { date: '2020-01-01', usd: 7000 },
      { date: '2020-01-02', usd: 6900 },
    ],
    'blockchainInfo',
  );
  assert.deepEqual(first, { added: 2, updated: 0 });

  const second = store.reconcilePrimary(
    [
      { date: '2020-01-01', usd: 7000 }, // unchanged
      { date: '2020-01-02', usd: 6950 }, // changed
      { date: '2020-01-03', usd: 7100 }, // new
    ],
    'blockchainInfo',
  );
  assert.deepEqual(second, { added: 1, updated: 1 });
  assert.equal(store.get('2020-01-02')!.usd, 6950);
});

test('reconcilePrimary: an authoritative update clears a stale unconfirmed flag', () => {
  const store = new PriceStore();
  store.set('2020-05-01', 9000, 'kraken', ['unconfirmed']);
  store.reconcilePrimary([{ date: '2020-05-01', usd: 9500 }], 'blockchainInfo');
  const rec = store.get('2020-05-01')!;
  assert.equal(rec.usd, 9500);
  assert.equal(rec.src, 'blockchainInfo');
  assert.equal(rec.flags, undefined);
});

// ---------------------------------------------------------------------------
// crossValidate: >5% divergence flags + reports; keeps stored value.
// ---------------------------------------------------------------------------

test('crossValidate: a >5% divergence flags the day and is reported, value kept', () => {
  const store = new PriceStore();
  store.reconcilePrimary(
    [
      { date: '2021-01-01', usd: 30_000 },
      { date: '2021-01-02', usd: 31_000 },
    ],
    'blockchainInfo',
  );
  const divergences = store.crossValidate(
    [
      { date: '2021-01-01', usd: 30_500 }, // ~1.6% -> ok
      { date: '2021-01-02', usd: 40_000 }, // ~29% -> divergent
    ],
    'bitstamp',
  );
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0]!.date, '2021-01-02');
  assert.equal(divergences[0]!.src, 'bitstamp');
  // Stored value is untouched; only a flag is added.
  assert.equal(store.get('2021-01-02')!.usd, 31_000);
  assert.deepEqual(store.get('2021-01-02')!.flags, ['divergent']);
  assert.equal(store.get('2021-01-01')!.flags, undefined);
});

// ---------------------------------------------------------------------------
// series(): chronological, priced-only.
// ---------------------------------------------------------------------------

test('series: returns priced days sorted chronologically', () => {
  const store = new PriceStore();
  store.set('2019-03-02', 3800, 'x');
  store.set('2019-03-01', 3700, 'x');
  store.set('2019-03-03', 3900, 'x');
  const s = store.series();
  assert.deepEqual(
    s.map((o) => o.date),
    ['2019-03-01', '2019-03-02', '2019-03-03'],
  );
  assert.equal(store.latestDate(), '2019-03-03');
  assert.equal(store.count(), 3);
});

test('applyRecentFill: upserts caller-resolved days with their flags', () => {
  const store = new PriceStore();
  const fill = new Map([
    ['2022-06-01', { usd: 31_000, src: 'kraken', flags: ['unconfirmed'] }],
    ['2022-06-02', { usd: 30_000, src: 'kraken+bitstamp', flags: [] }],
  ]);
  const n = store.applyRecentFill(fill);
  assert.equal(n, 2);
  assert.deepEqual(store.get('2022-06-01')!.flags, ['unconfirmed']);
  assert.equal(store.get('2022-06-02')!.flags, undefined);
});

// ---------------------------------------------------------------------------
// setMaxCommitDate: TODAY is never committed by any fold path (spec 3.3 / F2).
// ---------------------------------------------------------------------------

test('setMaxCommitDate: reconcilePrimary and applyRecentFill drop dates past the bound', () => {
  const store = new PriceStore();
  store.setMaxCommitDate('2026-07-10'); // yesterday; today = 2026-07-11
  const res = store.reconcilePrimary(
    [
      { date: '2026-07-09', usd: 61_000 }, // < bound -> kept
      { date: '2026-07-10', usd: 62_000 }, // == bound -> kept
      { date: '2026-07-11', usd: 63_000 }, // today -> dropped
    ],
    'blockchainInfo',
  );
  assert.deepEqual(res, { added: 2, updated: 0 });
  assert.equal(store.has('2026-07-11'), false);
  assert.equal(store.latestDate(), '2026-07-10');

  // The recent-fill path honours the same bound.
  const added = store.applyRecentFill(
    new Map([['2026-07-11', { usd: 64_000, src: 'kraken', flags: ['unconfirmed'] }]]),
  );
  assert.equal(added, 0);
  assert.equal(store.has('2026-07-11'), false);
});

// ---------------------------------------------------------------------------
// fillMissing: gap fill adds missing dates with `secondary`, skips existing (F3b).
// ---------------------------------------------------------------------------

test('fillMissing: adds only missing in-bound dates flagged secondary, leaves existing alone', () => {
  const store = new PriceStore();
  store.setMaxCommitDate('2026-07-10');
  store.set('2024-01-02', 45_000, 'blockchainInfo'); // pre-existing, unflagged
  const added = store.fillMissing(
    [
      { date: '2024-01-01', usd: 44_000 }, // missing -> added (secondary)
      { date: '2024-01-02', usd: 99_999 }, // existing -> untouched
      { date: '2024-01-03', usd: 46_000 }, // missing -> added (secondary)
      { date: '2026-07-11', usd: 70_000 }, // today -> dropped by the bound
    ],
    'bitstamp',
  );
  assert.equal(added, 2);
  assert.deepEqual(store.get('2024-01-01')!.flags, ['secondary']);
  assert.deepEqual(store.get('2024-01-03')!.flags, ['secondary']);
  assert.equal(store.get('2024-01-02')!.usd, 45_000); // stored value kept
  assert.equal(store.get('2024-01-02')!.flags, undefined);
  assert.equal(store.has('2026-07-11'), false);
});
