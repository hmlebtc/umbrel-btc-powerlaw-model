// Tests for the v0.2.0 block-height source capabilities: response parsers for each
// endpoint shape, the sources' URLs / pagination (global fetch stubbed — the
// network is never touched), the registry capability helpers and the MOCK doubles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SNAPSHOT_HEIGHT_OFFSET, heightsFromSnapshot } from './fixtures/heights.js';
import { crossCheckEpochs } from './heightStore.js';
import { createBlockchainInfoSource } from './sources/blockchainInfo.js';
import { createBlockstreamSource } from './sources/blockstream.js';
import { blockCountsUrl, createCoinMetricsSource, parseBlockCounts } from './sources/coinmetrics.js';
import { createMempoolSpaceSource, parseBlockLookup, parseEpochs } from './sources/mempoolSpace.js';
import {
  MAX_ERROR_CHARS,
  createMockSources,
  parseBlockCount,
  SourceRegistry,
  toBlockCount,
  type PriceSource,
} from './sources/types.js';
import { defaultSettings } from './settings.js';

/** Run `fn` with global fetch replaced by `handler(url)`; always restored. */
async function withFetch<T>(handler: (url: string) => string, fn: (urls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return new Response(handler(url), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

// --- Coin Metrics -----------------------------------------------------------

test('parseBlockCounts: string numbers parsed, missing/empty/garbage counts dropped, sorted, last duplicate wins', () => {
  const rows = parseBlockCounts({
    data: [
      { time: '2026-11-24T00:00:00.000000000Z', BlkCnt: '142' },
      { time: '2026-11-23T00:00:00.000000000Z', BlkCnt: '168' },
      { time: '2026-11-22T00:00:00.000000000Z' }, // key missing
      { time: '2026-11-21T00:00:00.000000000Z', BlkCnt: '' }, // empty
      { time: '2026-11-20T00:00:00.000000000Z', BlkCnt: 'n/a' },
      { time: '2026-11-19T00:00:00.000000000Z', BlkCnt: '-3' },
      { time: '2026-11-18T00:00:00.000000000Z', BlkCnt: 150 }, // a real number is fine too
      { time: 'garbage', BlkCnt: '1' },
      { time: '2026-11-23T00:00:00.000000000Z', BlkCnt: '170' },
    ],
  });
  assert.deepEqual(rows, [
    { date: '2026-11-18', count: 150 },
    { date: '2026-11-23', count: 170 },
    { date: '2026-11-24', count: 142 },
  ]);
  assert.deepEqual(parseBlockCounts({}), []);
});

test('coinmetrics source: spec URL, follows next_page_url, merges pages ascending', async () => {
  const page2 = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?next_page_token=abc';
  const bodies: Record<string, unknown> = {
    first: {
      data: [{ time: '2026-11-23T00:00:00.000000000Z', BlkCnt: '168' }, { time: '2026-11-24T00:00:00.000000000Z', BlkCnt: '142' }],
      next_page_url: page2,
    },
    second: { data: [{ time: '2026-11-21T00:00:00.000000000Z', BlkCnt: '130' }, { time: '2026-11-22T00:00:00.000000000Z', BlkCnt: '140' }] },
  };
  await withFetch(
    (url) => JSON.stringify(url === page2 ? bodies.second : bodies.first),
    async (urls) => {
      const src = createCoinMetricsSource();
      assert.deepEqual(src.kinds, ['height']);
      const rows = await src.fetchBlockCounts!();
      assert.deepEqual(rows.map((r) => r.date), ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
      assert.equal(urls.length, 2);
      assert.equal(
        urls[0],
        'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=BlkCnt,PriceUSD&frequency=1d&page_size=10000',
      );
    },
  );
});

test('coinmetrics source: a next_page_url on another host is not followed', async () => {
  await withFetch(
    () => JSON.stringify({ data: [{ time: '2026-11-23T00:00:00Z', BlkCnt: '1' }], next_page_url: 'https://evil.example/x' }),
    async (urls) => {
      const rows = await createCoinMetricsSource().fetchBlockCounts!();
      assert.equal(rows.length, 1);
      assert.equal(urls.length, 1);
    },
  );
});

// --- mempool.space ----------------------------------------------------------

test('parseEpochs: [time, height, difficulty, change] rows -> {time, height}, oldest first, junk dropped', () => {
  const rows = parseEpochs([
    [1794632570, 975744, 134823837323272.7, 0.908733],
    [1793301298, 973728, 148364561003867.4, 1.05539],
    [1262153464, 32256, 1.182899534312841, 1.1829],
    [1231006505, 0, 1, 0],
    ['1700000000', '800000', 1, 1],
    [1793301298, 973728, 0, 0], // duplicate height
    [NaN, 5],
    ['x'],
    null,
    { time: 1500000000, height: 480000 },
  ]);
  assert.deepEqual(rows.map((r) => r.height), [0, 32256, 480000, 800000, 973728, 975744]);
  assert.deepEqual(rows[0], { time: 1231006505, height: 0 });
  assert.deepEqual(parseEpochs({ not: 'an array' }), []);
});

test('mempoolSpace source: epochs and tip endpoints and parsing', async () => {
  await withFetch(
    (url) => (url.endsWith('/tip/height') ? '977627' : JSON.stringify([[1794632570, 975744, 1, 1]])),
    async (urls) => {
      const src = createMempoolSpaceSource();
      assert.ok(src.kinds.includes('height'));
      assert.deepEqual(await src.fetchEpochs!(), [{ time: 1794632570, height: 975744 }]);
      assert.equal(await src.fetchTipHeight!(), 977_627);
      assert.deepEqual(urls, [
        'https://mempool.space/api/v1/mining/difficulty-adjustments',
        'https://mempool.space/api/blocks/tip/height',
      ]);
    },
  );
});

// --- tip sources -----------------------------------------------------------

test('blockstream + blockchain.info tip endpoints (plain-text integer bodies)', async () => {
  await withFetch(
    () => '977676',
    async (urls) => {
      const bs = createBlockstreamSource();
      assert.deepEqual(bs.kinds, ['height']);
      assert.equal(await bs.fetchTipHeight!(), 977_676);
      const bci = createBlockchainInfoSource();
      assert.ok(bci.kinds.includes('history') && bci.kinds.includes('height'));
      assert.equal(await bci.fetchTipHeight!(), 977_676);
      assert.deepEqual(urls, ['https://blockstream.info/api/blocks/tip/height', 'https://blockchain.info/q/getblockcount']);
    },
  );
});

test('tip parsing: numeric strings accepted, anything else rejected', async () => {
  assert.equal(toBlockCount('977627'), 977_627);
  assert.equal(toBlockCount(977_627), 977_627);
  for (const bad of ['abc', '', null, undefined, -1, 1.5, NaN]) assert.throws(() => toBlockCount(bad));
  assert.equal(parseBlockCount('0'), 0);
  assert.equal(parseBlockCount('  '), null);
  await withFetch(
    () => JSON.stringify({ error: 'nope' }),
    async () => {
      await assert.rejects(() => createBlockstreamSource().fetchTipHeight!());
    },
  );
});

// --- registry + mocks -------------------------------------------------------

test('MOCK sources: height capabilities are served by the right doubles; nine sources in all', async () => {
  const reg = new SourceRegistry(createMockSources());
  assert.equal(reg.sources.length, 9);
  assert.deepEqual(reg.blockCountSources().map((s) => s.name), ['coinmetrics']);
  assert.deepEqual(reg.epochSources().map((s) => s.name), ['mempoolSpace']);
  assert.deepEqual(reg.tipSources().map((s) => s.name).sort(), ['blockchainInfo', 'blockstream', 'mempoolSpace']);

  const snap = heightsFromSnapshot();
  const last = snap[snap.length - 1]!;
  const counts = await reg.get('coinmetrics')!.fetchBlockCounts!();
  assert.equal(counts.length, snap.length);
  const tips = await Promise.all(reg.tipSources().map((s) => s.fetchTipHeight!()));
  for (const t of tips) assert.ok(t >= last.h);
  // The mock epochs come from the same series, so the 50-block cross-check is quiet.
  const epochs = await reg.get('mempoolSpace')!.fetchEpochs!();
  assert.ok(epochs.length > 400);
  assert.deepEqual(crossCheckEpochs(snap, epochs), []);
});

// --- v0.2.0: Coin Metrics closes + last-block lookup -----------------------

test('parseBlockCounts: PriceUSD string parsed when present; absent/empty/zero/garbage never drops the row', () => {
  const rows = parseBlockCounts({
    data: [
      { time: '2010-07-17T00:00:00.000000000Z', BlkCnt: '170' }, // before pricing starts
      { time: '2010-07-18T00:00:00.000000000Z', BlkCnt: '172', PriceUSD: '0.08584' },
      { time: '2026-11-23T00:00:00.000000000Z', BlkCnt: '168', PriceUSD: '61253.2168786616' },
      { time: '2026-11-24T00:00:00.000000000Z', BlkCnt: '142', PriceUSD: '' },
      { time: '2026-11-25T00:00:00.000000000Z', BlkCnt: '160', PriceUSD: '0' },
      { time: '2026-11-26T00:00:00.000000000Z', BlkCnt: '135', PriceUSD: 'x' },
    ],
  });
  assert.deepEqual(rows, [
    { date: '2010-07-17', count: 170 },
    { date: '2010-07-18', count: 172, usd: 0.08584 },
    { date: '2026-11-23', count: 168, usd: 61253.2168786616 },
    { date: '2026-11-24', count: 142 },
    { date: '2026-11-25', count: 160 },
    { date: '2026-11-26', count: 135 },
  ]);
});

test('coinmetrics source passes the close through across pages', async () => {
  const page2 = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?next_page_token=t';
  await withFetch(
    (url) =>
      JSON.stringify(
        url === page2
          ? { data: [{ time: '2026-11-21T00:00:00Z', BlkCnt: '1', PriceUSD: '10' }] }
          : { data: [{ time: '2026-11-22T00:00:00Z', BlkCnt: '2' }], next_page_url: page2 },
      ),
    async () => {
      assert.deepEqual(await createCoinMetricsSource().fetchBlockCounts!(), [
        { date: '2026-11-21', count: 1, usd: 10 },
        { date: '2026-11-22', count: 2 },
      ]);
    },
  );
});

test('mempoolSpace last-block lookup: URL, parse, and rejection of a bad body', async () => {
  assert.equal(parseBlockLookup({ height: 977595, hash: 'ab', timestamp: '2026-11-25T23:59:09.000Z' }), 977_595);
  assert.throws(() => parseBlockLookup({}));
  assert.throws(() => parseBlockLookup(null));
  await withFetch(
    () => JSON.stringify({ height: 977595, hash: 'ab', timestamp: '2026-11-25T23:59:09.000Z' }),
    async (urls) => {
      assert.equal(await createMempoolSpaceSource().fetchLastBlockHeightBefore!(1795651200), 977_595);
      assert.deepEqual(urls, ['https://mempool.space/api/v1/mining/blocks/timestamp/1795651200']);
    },
  );
});

test('MOCK: coinmetrics serves raw counts + fixture closes; the mock lookup agrees with the snapshot offset', async () => {
  const reg = new SourceRegistry(createMockSources());
  assert.deepEqual(reg.blockLookupSources().map((s) => s.name), ['mempoolSpace']);
  const counts = await reg.get('coinmetrics')!.fetchBlockCounts!();
  assert.equal(counts.reduce((a, c) => a + c.count, 0), 977_600); // raw, unshifted
  const priced = counts.filter((c) => c.usd !== undefined);
  assert.ok(priced.length > 5000);
  assert.equal(counts.find((c) => c.date === '2010-08-17')!.usd, undefined);
  assert.equal(counts.find((c) => c.date === '2026-11-25')!.usd, undefined); // beyond the price fixture
  // Lookup at 00:00Z of 2026-11-26 = last block of 2026-11-25 = snapshot true height.
  const snap = heightsFromSnapshot();
  const h = await reg.get('mempoolSpace')!.fetchLastBlockHeightBefore!(Date.parse('2026-11-26T00:00:00Z') / 1000);
  assert.equal(h, snap[snap.length - 1]!.h);
  assert.equal(977_600 - h, SNAPSHOT_HEIGHT_OFFSET);
});

// --- Review round 1: R1 (health), R4 (live shapes, URLs), R9 (bounds) ----------

test('R1: height calls never touch price health; a failing history stays failing while its tip succeeds', async () => {
  let historyOk = false;
  const src: PriceSource = {
    name: 'blockchainInfo',
    kinds: ['history', 'height'],
    fetchDailyHistory: async () => {
      if (!historyOk) throw new Error('HTTP 503');
      return [];
    },
    fetchTipHeight: async () => 977_000,
  };
  const reg = new SourceRegistry([src]);
  for (let i = 0; i < 4; i++) {
    await reg.runHeight(src, (s) => s.fetchTipHeight!());
    await assert.rejects(() => reg.run(src, (s) => s.fetchDailyHistory!()));
  }
  const row = reg.statusRows(defaultSettings())[0]!;
  assert.equal(row.consecutiveFailures, 4); // the price chip reaches "fail" (>= 3)
  assert.equal(row.lastOkAt, null); // the tip success is NOT advertised as price health
  assert.equal(row.lastError, 'HTTP 503');
  assert.equal(row.heightHealth!.consecutiveFailures, 0);
  assert.ok(row.heightHealth!.lastOkAt);
  // Price recovery resets only the price counter.
  historyOk = true;
  await reg.run(src, (s) => s.fetchDailyHistory!());
  assert.equal(reg.statusRows(defaultSettings())[0]!.consecutiveFailures, 0);
});

test('R1: height-only sources report their height health as the main row; price-only sources have no heightHealth', async () => {
  const reg = new SourceRegistry(createMockSources());
  const cm = reg.get('coinmetrics')!;
  await reg.runHeight(cm, (s) => s.fetchBlockCounts!({ startDate: '2026-11-01' }));
  await assert.rejects(() => reg.runHeight(reg.get('blockstream')!, async () => { throw new Error('x'.repeat(500)); }));
  const rows = reg.statusRows(defaultSettings());
  const byName = (n: string) => rows.find((r) => r.name === n)!;
  assert.ok(byName('coinmetrics').lastOkAt);
  assert.equal(byName('coinmetrics').heightHealth, undefined);
  assert.equal(byName('blockstream').consecutiveFailures, 1);
  assert.equal(byName('blockstream').lastError!.length, MAX_ERROR_CHARS); // R9 truncation
  assert.equal(byName('coinbase').heightHealth, undefined);
  assert.ok(byName('mempoolSpace').heightHealth);
  // Mock coinmetrics honours the incremental window.
  const rowsInc = await cm.fetchBlockCounts!({ startDate: '2026-11-20' });
  assert.equal(rowsInc[0]!.date, '2026-11-20');
});

test('R9: epoch times and heights are bounded; huge or pre-genesis values are dropped, not thrown on', () => {
  const now = Date.parse('2026-11-27T00:00:00Z');
  const rows = parseEpochs(
    [
      [1794632570, 975744, 1, 1], // fine
      [9e12, 5, 1, 1], // year 285,000: new Date().toISOString() would throw downstream
      [100, 5, 1, 1], // before genesis
      [Math.floor(now / 1000) + 3 * 86_400, 977_000, 1, 1], // three days ahead
      [1700000000, 1e9, 1, 1], // absurd height
      [1700000000, -1, 1, 1],
    ],
    now,
  );
  assert.deepEqual(rows, [{ time: 1794632570, height: 975_744 }]);
});

test('R9: oversized or garbage upstream values are rejected and error strings are capped', () => {
  assert.equal(parseBlockCount(1e8), 1e8);
  assert.equal(parseBlockCount(1e8 + 1), null);
  assert.equal(parseBlockCount('2000000000'), null);
  try {
    toBlockCount('x'.repeat(5000));
    assert.fail('should throw');
  } catch (e) {
    assert.ok((e as Error).message.length <= MAX_ERROR_CHARS);
  }
});

test('R4 live shape: PriceUSD null on unpriced days, numbers as JSON strings, full history ascending in one page', () => {
  const body = JSON.parse(
    '{"data":[' +
      '{"asset":"btc","time":"2009-01-03T00:00:00.000000000Z","BlkCnt":"0","PriceUSD":null},' +
      '{"asset":"btc","time":"2009-01-09T00:00:00.000000000Z","BlkCnt":"14","PriceUSD":null},' +
      '{"asset":"btc","time":"2010-07-18T00:00:00.000000000Z","BlkCnt":"172","PriceUSD":"0.08584"},' +
      '{"asset":"btc","time":"2026-11-26T00:00:00.000000000Z","BlkCnt":"135","PriceUSD":null}]}',
  );
  const rows = parseBlockCounts(body);
  assert.deepEqual(rows, [
    { date: '2009-01-03', count: 0 },
    { date: '2009-01-09', count: 14 },
    { date: '2010-07-18', count: 172, usd: 0.08584 },
    { date: '2026-11-26', count: 135 },
  ]);
  assert.equal(body.next_page_url, undefined);
});

test('R4: URLs — full history, and incremental with start_time', () => {
  assert.equal(
    blockCountsUrl('BlkCnt,PriceUSD'),
    'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=BlkCnt,PriceUSD&frequency=1d&page_size=10000',
  );
  assert.ok(blockCountsUrl('BlkCnt', '2026-11-18').endsWith('metrics=BlkCnt&frequency=1d&page_size=10000&start_time=2026-11-18'));
});

test('R4: if the combined request fails the source retries with BlkCnt alone (rows carry no close)', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes('PriceUSD')) return new Response('forbidden', { status: 403 });
    return new Response(JSON.stringify({ data: [{ time: '2026-11-25T00:00:00Z', BlkCnt: '160' }] }), { status: 200 });
  }) as typeof fetch;
  const keepAlive = setInterval(() => undefined, 50); // fetchJson's retry delay timer is unref'd
  try {
    const rows = await createCoinMetricsSource().fetchBlockCounts!({ startDate: '2026-11-18' });
    assert.deepEqual(rows, [{ date: '2026-11-25', count: 160 }]);
    assert.ok(urls.some((u) => u.includes('metrics=BlkCnt,PriceUSD')) && urls.some((u) => u.includes('metrics=BlkCnt&')));
    assert.ok(urls.every((u) => u.includes('start_time=2026-11-18')));
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = original;
  }
});
