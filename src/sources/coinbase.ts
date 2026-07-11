/**
 * Coinbase — spot only (spec section 3.4). `prices/spot?currency=USD` returns
 * { data: { amount, base, currency } }. (A >=2016 daily history cross-check is
 * optional in the spec and intentionally omitted to keep this source lean.)
 */

import { fetchJson, toUsd, type PriceSource } from './types.js';

interface SpotResponse {
  data?: { amount?: string };
}

const SPOT_URL = 'https://api.coinbase.com/v2/prices/spot?currency=USD';

export function createCoinbaseSource(): PriceSource {
  return {
    name: 'coinbase',
    kinds: ['spot'],
    async fetchSpot(): Promise<number> {
      const r = await fetchJson<SpotResponse>(SPOT_URL, { timeoutMs: 4000 });
      return toUsd(r.data?.amount);
    },
  };
}
