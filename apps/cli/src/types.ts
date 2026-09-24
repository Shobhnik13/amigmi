export type Agent = 'claude_code' | 'opencode' | 'codex';

export type AggregateRecord = {
  agent: Agent;
  date: string;   // YYYY-MM-DD
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;   // 5m + 1h combined; cost_usd prices them separately
  cost_usd: string;
};

// How the server should apply a batch of records.
//   append  — add the record's totals to whatever the (agent, date, model) row
//             already holds. Normal incremental sync: the client only ever sends
//             the delta it has not sent before.
//   replace — overwrite that row outright. Only used by `amigmi backfill`, which
//             rescans every transcript from byte 0 and therefore sends absolute
//             totals, not deltas.
export type SyncMode = 'append' | 'replace';

export type Cursors = {
  claude_code: Record<string, number>;  // file path → byte offset
  codex: Record<string, number>;        // file path → byte offset
  opencode: { last_timestamp: string }; // ISO timestamp of the newest row seen
};

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

// Usage already counted per billed response, bucketed by date so old buckets can
// be pruned. Stored as [input, output, cacheRead, cacheWrite5m, cacheWrite1h] to
// keep state.json compact. See lib/ledger.ts for why the counts are kept rather
// than just the ids.
export type LedgerEntry = [number, number, number, number, number];
export type LedgerState = Record<string, Record<string, LedgerEntry>>;

export type State = {
  cursors: Partial<Cursors>;
  counted?: { claude_code?: LedgerState; opencode?: LedgerState };
  last_sync_at: string | null;
};

export type Auth = {
  token: string;
  api_url: string;
  username: string;
};
