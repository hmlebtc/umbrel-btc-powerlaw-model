// Tests for spot.ts (spec section 3.3): median/quorum/outlier aggregation and
// the SpotAggregator's quorum + stale + CoinGecko-last-resort behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSettings } from './settings.js';
import { SourceRegistry, type PriceSource } from './sources/types.js';
import { aggregateSpot, SpotAggregator } from './spot.js';

// ---------------------------------------------------------------------------
// Pure aggregateSpot.
// ---------------------------------------------------------------------------

test('aggregateSpot: a tight cluster publishes the median with full quorum', () => {
  const agg = aggregateSpot([
    { name: 'coinbase', usd: 100 },
    { name: 'kraken', usd: 100.5 },
    { name: 'bitstamp', usd: 101 },
  ]);
  assert.equal(agg.quorum, 3);
  assert.equal(agg.usd, 100.5);
  assert.equal(agg.rejected.length, 0);
});

test('aggregateSpot: a single wild outlier is rejected from a robust pool', () => {
  const agg = aggregateSpot([
    { name: 'a', usd: 100 },
    { name: 'b', usd: 100.5 },
    { name: 'c', usd: 101 },
    { name: 'd', usd: 99.5 },
    { name: 'e', usd: 200 }, // >2.5% from median-of-others
  ]);
  assert.equal(agg.rejected.length, 1);
  assert.equal(agg.rejected[0]!.name, 'e');
  assert.equal(agg.quorum, 4);
  assert.equal(agg.usd, 100.25);
});

test('aggregateSpot: below quorum (1 responder) publishes null', () => {
  const agg = aggregateSpot([{ name: 'a', usd: 100 }]);
  assert.equal(agg.quorum, 1);
  assert.equal(agg.usd, null);
});

test('aggregateSpot: two responders far apart reject each other -> no quorum', () => {
  const agg = aggregateSpot([
    { name: 'a', usd: 100 },
    { name: 'b', usd: 130 },
  ]);
  assert.equal(agg.usd, null);
  assert.equal(agg.quorum, 0);
});

// ---------------------------------------------------------------------------
// SpotAggregator orchestration.
// ---------------------------------------------------------------------------

function fakeSource(name: string, get: () => Promise<number>): PriceSource {
  return { name, kinds: ['spot'], fetchSpot: get };
}

test('SpotAggregator.poll: publishes a quorum median with stale:false', async () => {
  const registry = new SourceRegistry([
    fakeSource('coinbase', async () => 60_000),
    fakeSource('kraken', async () => 60_200),
    fakeSource('bitstamp', async () => 60_100),
  ]);
  const agg = new SpotAggregator(registry, () => defaultSettings());
  const result = await agg.poll();
  assert.ok(result);
  assert.equal(result!.stale, false);
  assert.equal(result!.quorum, 3);
  assert.equal(result!.usd, 60_100);
  assert.equal(result!.sources.length, 3);
});

test('SpotAggregator.poll: below quorum serves the last-known-good as stale', async () => {
  let working = true;
  const registry = new SourceRegistry([
    fakeSource('coinbase', async () => {
      if (!working) throw new Error('down');
      return 60_000;
    }),
    fakeSource('kraken', async () => {
      if (!working) throw new Error('down');
      return 60_100;
    }),
  ]);
  const agg = new SpotAggregator(registry, () => defaultSettings());
  const good = await agg.poll();
  assert.ok(good && good.stale === false);

  working = false;
  const stale = await agg.poll();
  assert.ok(stale);
  assert.equal(stale!.stale, true);
  assert.equal(stale!.usd, good!.usd); // last-known-good retained
});

test('SpotAggregator.poll: CoinGecko is used only when exchanges yield <2 answers', async () => {
  const registry = new SourceRegistry([
    fakeSource('coinbase', async () => {
      throw new Error('down');
    }),
    fakeSource('kraken', async () => 60_000),
    fakeSource('bitstamp', async () => {
      throw new Error('down');
    }),
    fakeSource('coingecko', async () => 60_050),
  ]);
  const agg = new SpotAggregator(registry, () => defaultSettings());
  const result = await agg.poll();
  assert.ok(result);
  assert.equal(result!.quorum, 2);
  assert.ok(result!.sources.some((s) => s.name === 'coingecko'));
});

test('SpotAggregator.snapshot: null before any successful poll', () => {
  const registry = new SourceRegistry([]);
  const agg = new SpotAggregator(registry, () => defaultSettings());
  assert.equal(agg.snapshot(), null);
});
