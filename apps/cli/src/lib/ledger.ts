import type { LedgerState, Usage } from '../types';

// Drop buckets more than this far behind the newest one. An id only reappears
// while its session is still live enough to be resumed, forked or amended, so
// this is well clear of any realistic replay window while keeping state.json
// bounded.
//
// Measured against the newest bucket rather than today: a tool that has not been
// used in months still gets re-read inside its own lookback window, and pruning
// on wall-clock time would expire those entries and let the re-read count twice.
const RETENTION_DAYS = 90;

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

const ZERO: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
};

/**
 * Tracks how much usage has already been counted for each billed response.
 *
 * Sources present the same response more than once, and not always with the same
 * numbers: Claude Code writes one JSONL line per content block and can flush a
 * line mid-stream with a partial (occasionally zero) output count before the
 * final line lands, replays lines into forked sessions, and opencode rewrites
 * its rows in place as a response streams.
 *
 * Counting the first sighting undercounts a still-streaming response; counting
 * every sighting multiplies it. So bank the per-field high-water mark per id and
 * report only the increment, which makes the result identical whether a response
 * arrives in one sync or is split across several.
 */
export class UsageLedger {
  private readonly banked = new Map<string, Usage>();
  private readonly dates = new Map<string, string>();

  constructor(previous: LedgerState = {}) {
    const dates = Object.keys(previous);
    const newest = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    const cutoff = newest
      ? new Date(Date.parse(newest) - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
      : '';

    for (const [date, ids] of Object.entries(previous)) {
      if (date < cutoff) continue;
      for (const [id, v] of Object.entries(ids)) {
        this.banked.set(id, {
          input: v[0] ?? 0,
          output: v[1] ?? 0,
          cacheRead: v[2] ?? 0,
          cacheWrite5m: v[3] ?? 0,
          cacheWrite1h: v[4] ?? 0,
        });
        this.dates.set(id, date);
      }
    }
  }

  /**
   * Returns the usage not yet counted for `id`, or null if this sighting adds
   * nothing. `date` is taken from the first sighting so a response cannot drift
   * between days as later lines arrive.
   */
  record(id: string, date: string, seen: Usage): { date: string; delta: Usage } | null {
    const prior = this.banked.get(id) ?? ZERO;
    const bucket = this.dates.get(id) ?? date;

    const delta = { ...ZERO };
    const next = { ...ZERO };
    let changed = false;

    for (const f of FIELDS) {
      // Per-field high-water mark: a later line may finalise one counter while
      // another is unchanged, and no counter should ever move backwards.
      const hi = Math.max(prior[f], seen[f]);
      next[f] = hi;
      delta[f] = hi - prior[f];
      if (delta[f] !== 0) changed = true;
    }

    this.banked.set(id, next);
    this.dates.set(id, bucket);

    return changed ? { date: bucket, delta } : null;
  }

  get size(): number {
    return this.banked.size;
  }

  toJSON(): LedgerState {
    const out: LedgerState = {};
    for (const [id, u] of this.banked) {
      const date = this.dates.get(id)!;
      (out[date] ??= {})[id] = [
        u.input, u.output, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h,
      ];
    }
    return out;
  }
}
