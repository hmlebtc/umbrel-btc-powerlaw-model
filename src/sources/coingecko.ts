/**
 * CoinGecko — spot only, LAST RESORT (spec sections 3.3/3.4). Polled by the spot
 * aggregator only when the other exchanges yield fewer than two answers.
 * `simple/price?ids=bitcoin&vs_currencies=usd` -> { bitcoin: { usd } }.
 */

import { fetchJson, toUsd, type PriceSource } from './types.js';

interface SimplePriceResponse {
  bitcoin?: { usd?: number };
}

const SPOT_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

export function createCoingeckoSource(): PriceSource {
  return {
    name: 'coingecko',
    kinds: ['spot'],
    async fetchSpot(): Promise<number> {
      const r = await fetchJson<SimplePriceResponse>(SPOT_URL, { timeoutMs: 4000 });
      return toUsd(r.bitcoin?.usd);
    },
  };
}
