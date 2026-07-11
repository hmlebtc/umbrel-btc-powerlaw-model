/**
 * Entry point (spec section 2 boot order: settings -> store -> scheduler ->
 * server). Wires the settings store, event log, price/model stores, the source
 * registry (real HTTP sources or MOCK=1 fixture doubles), the spot aggregator,
 * the job runner and the background scheduler behind the HTTP server. Kicks off
 * an initial-sync when there is no data yet, then starts the timers. Shuts down
 * cleanly on SIGTERM/SIGINT (docker stop sends SIGTERM).
 */

import { EventLog } from './events.js';
import { JobRunner, JobStats, ModelStore } from './jobs.js';
import { log, logError } from './log.js';
import { PriceStore } from './priceStore.js';
import { Scheduler } from './scheduler.js';
import { createApiServer, type AppContext } from './server.js';
import { loadSettings, SettingsStore } from './settings.js';
import { createBinanceSource } from './sources/binance.js';
import { createBitstampSource } from './sources/bitstamp.js';
import { createBlockchainInfoSource } from './sources/blockchainInfo.js';
import { createCoinbaseSource } from './sources/coinbase.js';
import { createCoingeckoSource } from './sources/coingecko.js';
import { createKrakenSource } from './sources/kraken.js';
import { createMempoolSpaceSource } from './sources/mempoolSpace.js';
import { createMockSources, SourceRegistry, type PriceSource } from './sources/types.js';
import { SpotAggregator } from './spot.js';
import { APP_NAME, APP_VERSION, GIT_SHA } from './version.js';

/** Real, keyless HTTP sources in the order health rows should appear. */
function createRealSources(): PriceSource[] {
  return [
    createBlockchainInfoSource(),
    createBitstampSource(),
    createBinanceSource(),
    createKrakenSource(),
    createCoinbaseSource(),
    createMempoolSpaceSource(),
    createCoingeckoSource(),
  ];
}

function main(): void {
  const dataDir = process.env.BPL_DATA_DIR || './data';
  const port = Number(process.env.BPL_HTTP_PORT || '3013');
  const mock = process.env.MOCK === '1';

  const settings = new SettingsStore(dataDir, loadSettings(dataDir));
  const events = new EventLog(dataDir);
  const getSettings = (): ReturnType<SettingsStore['get']> => settings.get();

  const registry = new SourceRegistry(mock ? createMockSources() : createRealSources());
  const priceStore = new PriceStore(dataDir);
  const modelStore = new ModelStore(dataDir);
  const jobStats = new JobStats(dataDir);
  const spot = new SpotAggregator(registry, getSettings, events);
  const jobRunner = new JobRunner({
    registry,
    priceStore,
    spot,
    getSettings,
    modelStore,
    jobStats,
    events,
  });
  const scheduler = new Scheduler({ getSettings, jobRunner, spot, modelStore, events });

  const ctx: AppContext = {
    settings,
    priceStore,
    modelStore,
    spot,
    jobRunner,
    registry,
    events,
    scheduler,
    mock,
    startedAt: new Date().toISOString(),
    version: APP_VERSION,
    gitSha: GIT_SHA,
  };

  const server = createApiServer(ctx);

  // Never let a stray rejection/exception kill the process — log and carry on.
  process.on('unhandledRejection', (reason) => {
    logError(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    logError(`uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
  });

  server.listen(port, '0.0.0.0', () => {
    log(`${APP_NAME} v${APP_VERSION} (${GIT_SHA}) listening on 0.0.0.0:${port}`);
    log(`data dir: ${dataDir}${mock ? ' (MOCK mode)' : ''}`);
    if (priceStore.count() === 0 || modelStore.current() === null) {
      log('no prior data — starting initial sync');
      jobRunner.start('initial-sync');
    }
    scheduler.start();
    events.add('system', `${APP_NAME} started`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    scheduler.stop();
    server.close(() => {
      log('server closed, exiting');
      process.exit(0);
    });
    const t = setTimeout(() => process.exit(0), 5000);
    if (typeof t.unref === 'function') t.unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
