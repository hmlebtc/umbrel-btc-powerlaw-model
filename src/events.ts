/**
 * Activity history (spec section 6, /api/events).
 *
 * A capped, newest-first ring of events (refits with old->new deltas, divergence
 * flags, spot quorum loss, settings changes). Persisted to
 * ${BPL_DATA_DIR}/events.json (atomic tmp+rename) when a data dir is provided;
 * purely in-memory otherwise (unit tests). Never throws on IO problems.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ActivityEvent } from './types.js';

const CAP = 500;

export class EventLog {
  private events: ActivityEvent[] = [];

  constructor(private readonly dataDir?: string) {
    if (dataDir) this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, 'events.json') : null;
  }

  private load(): void {
    const path = this.path();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.events = (parsed as ActivityEvent[]).slice(0, CAP);
      }
    } catch {
      /* corrupt file -> start empty rather than crash */
    }
  }

  private persist(): void {
    const path = this.path();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.events), 'utf8');
      renameSync(tmp, path);
    } catch {
      /* best-effort persistence */
    }
  }

  add(kind: string, msg: string): void {
    this.events.unshift({ at: new Date().toISOString(), kind, msg });
    if (this.events.length > CAP) this.events.length = CAP;
    this.persist();
  }

  /** Newest-first, optionally truncated to `limit`. */
  list(limit?: number): ActivityEvent[] {
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      return this.events.slice(0, Math.floor(limit));
    }
    return this.events;
  }
}
