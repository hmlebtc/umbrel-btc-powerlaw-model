/**
 * Spot price aggregator (spec section 3.3).
 *
 * Every spotPollMinutes the scheduler calls poll(): fetch the enabled exchange
 * spot sources in parallel (4 s timeout via the registry), fall back to CoinGecko
 * only when the others yield <2 answers, reject any responder more than 2.5% from
 * the median-of-others, then require a quorum of >=2 to publish the median. Below
 * quorum the last-known-good value is served with stale:true. The pure
 * aggregateSpot() carries the median/quorum/outlier logic and is unit-tested.
 */

import type { EventLog } from './events.js';
import { isSourceEnabled, type SourceRegistry } from './sources/types.js';
import type { SpotResult, Settings } from './types.js';

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] as number) + (s[mid] as number)) / 2 : (s[mid] as number);
}

export interface SpotResponse {
  name: string;
  usd: number;
}

export interface SpotAggregate {
  /** Published median, or null when quorum (<2 accepted) is not met. */
  usd: number | null;
  quorum: number;
  accepted: SpotResponse[];
  rejected: SpotResponse[];
}

const OUTLIER_THRESHOLD = 0.025;

/**
 * Median-of-N with outlier rejection (spec section 3.3): drop any responder that
 * sits more than 2.5% from the median of the OTHER responders, then publish the
 * median of survivors when >=2 remain.
 */
export function aggregateSpot(responses: SpotResponse[]): SpotAggregate {
  const pos = responses.filter((r) => r.usd > 0);
  const accepted: SpotResponse[] = [];
  const rejected: SpotResponse[] = [];
  for (const r of pos) {
    const others = pos.filter((o) => o !== r).map((o) => o.usd);
    if (others.length === 0) {
      accepted.push(r);
      continue;
    }
    const m = median(others);
    if (m > 0 && Math.abs(r.usd - m) / m > OUTLIER_THRESHOLD) rejected.push(r);
    else accepted.push(r);
  }
  const quorum = accepted.length;
  const usd = quorum >= 2 ? median(accepted.map((a) => a.usd)) : null;
  return { usd, quorum, accepted, rejected };
}

interface Sample {
  name: string;
  usd: number;
  /** Fetch time in ms epoch. */
  at: number;
}

export class SpotAggregator {
  private latest: {
    usd: number;
    at: number;
    quorum: number;
    stale: boolean;
    samples: Sample[];
  } | null = null;

  constructor(
    private readonly registry: SourceRegistry,
    private readonly getSettings: () => Settings,
    private readonly events?: EventLog,
  ) {}

  /** Poll enabled spot sources, aggregate, update the cached value. */
  async poll(): Promise<SpotResult | null> {
    const settings = this.getSettings();
    const now = Date.now();
    const primary = this.registry
      .spotSources()
      .filter((s) => s.name !== 'coingecko' && isSourceEnabled(settings, s.name));

    const results: Sample[] = [];
    await Promise.all(
      primary.map(async (s) => {
        try {
          const usd = await this.registry.run(s, (x) => x.fetchSpot!());
          results.push({ name: s.name, usd, at: now });
        } catch {
          /* health recorded by the registry; fall through */
        }
      }),
    );

    // Last-resort CoinGecko only when the exchanges gave fewer than two answers.
    if (results.length < 2 && isSourceEnabled(settings, 'coingecko')) {
      const cg = this.registry.get('coingecko');
      if (cg && cg.fetchSpot) {
        try {
          const usd = await this.registry.run(cg, (x) => x.fetchSpot!());
          results.push({ name: 'coingecko', usd, at: now });
        } catch {
          /* ignore */
        }
      }
    }

    const agg = aggregateSpot(results.map((r) => ({ name: r.name, usd: r.usd })));
    if (agg.usd !== null) {
      const acceptedNames = new Set(agg.accepted.map((a) => a.name));
      this.latest = {
        usd: agg.usd,
        at: now,
        quorum: agg.quorum,
        stale: false,
        samples: results.filter((r) => acceptedNames.has(r.name)),
      };
      return this.snapshot();
    }

    // Below quorum: keep serving the last-known-good, now marked stale.
    if (this.latest) {
      if (!this.latest.stale) {
        this.events?.add('spot', `spot below quorum (${agg.quorum}); serving last-known-good`);
      }
      this.latest.stale = true;
      return this.snapshot();
    }
    return null;
  }

  /** Current spot with freshly recomputed ageSec, or null before first success. */
  snapshot(): SpotResult | null {
    if (!this.latest) return null;
    const now = Date.now();
    return {
      usd: this.latest.usd,
      at: new Date(this.latest.at).toISOString(),
      stale: this.latest.stale,
      quorum: this.latest.quorum,
      sources: this.latest.samples.map((s) => ({
        name: s.name,
        usd: s.usd,
        ageSec: Math.max(0, Math.round((now - s.at) / 1000)),
      })),
    };
  }
}
