/**
 * Blockstream (esplora) — chain-tip height only (v0.2.0 spec 3.2).
 *
 * Tip: https://blockstream.info/api/blocks/tip/height -> plain-text integer
 * (a valid JSON number, so fetchJson parses it directly). One of three tip
 * sources whose median becomes the live tip the height store interpolates toward.
 */

import { fetchJson, toBlockCount, type PriceSource } from './types.js';

const TIP_URL = 'https://blockstream.info/api/blocks/tip/height';

export function createBlockstreamSource(): PriceSource {
  return {
    name: 'blockstream',
    kinds: ['height'],
    async fetchTipHeight(): Promise<number> {
      return toBlockCount(await fetchJson<unknown>(TIP_URL, { timeoutMs: 4000 }));
    },
  };
}
