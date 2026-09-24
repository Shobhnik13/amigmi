import { join } from 'path';
import { addToAgg, type AggMap } from '../lib/aggregate';
import { calcCost, isPriced, normalizeModel } from '../lib/pricing';
import { UsageLedger } from '../lib/ledger';
import type { LedgerState } from '../types';

interface MessageData {
  role: string;
  modelID?: string;
  providerID?: string;
  tokens?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
  time?: { created?: number; completed?: number };
}

interface MessageRow {
  id: string;
  time_created: number;
  time_updated: number | null;
  data: string;
}

// opencode rewrites a message row as the response streams in — measured gaps
// between time_created and time_updated run to ~19s. Re-scan a window behind the
// watermark so a row that was still in flight last sync gets picked up with its
// final token counts; the ledger banks what was already counted, so the re-scan
// contributes only the increment.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type OpencodeResult = {
  lastTimestamp: string;
  counted: LedgerState;
  unpriced: string[];
};

// Parses ~/.local/share/opencode/opencode.db (SQLite)
export async function parseOpencode(
  agg: AggMap,
  lastTimestamp: string,
  counted: LedgerState = {},
): Promise<OpencodeResult> {
  const dbPath = join(process.env.HOME!, '.local', 'share', 'opencode', 'opencode.db');
  const ledger = new UsageLedger(counted);
  const unpriced = new Set<string>();

  if (!(await Bun.file(dbPath).exists())) {
    return { lastTimestamp, counted: ledger.toJSON(), unpriced: [] };
  }

  const { Database } = await import('bun:sqlite');
  const db = new Database(dbPath, { readonly: true, create: false });

  const cutoffMs = new Date(lastTimestamp).getTime();
  let maxSeen = cutoffMs;

  try {
    const rows = db
      .query<MessageRow, [number]>(
        `SELECT id, time_created, time_updated, data
           FROM message
          WHERE COALESCE(time_updated, time_created) > ?
          ORDER BY COALESCE(time_updated, time_created) ASC`,
      )
      .all(Math.max(0, cutoffMs - LOOKBACK_MS));

    for (const row of rows) {
      const watermark = row.time_updated ?? row.time_created;
      let msg: MessageData;
      try {
        msg = JSON.parse(row.data);
      } catch {
        continue;
      }

      if (msg.role !== 'assistant') continue;

      const model = msg.modelID ?? null;
      const tokens = msg.tokens;
      if (!model || !tokens) continue;

      const normModel  = normalizeModel(model);
      const input      = tokens.input ?? 0;
      const output     = tokens.output ?? 0;
      const cacheRead  = tokens.cache?.read ?? 0;
      const cacheWrite = tokens.cache?.write ?? 0;

      // A row read while still streaming carries partial counts and is rewritten
      // later. Bank the high-water mark and take only the increment, so an
      // in-flight row costs us nothing to re-read once it settles.
      const seenDate = new Date(row.time_created).toISOString().slice(0, 10);
      const entered = ledger.record(row.id, seenDate, {
        input,
        output,
        cacheRead,
        // opencode does not split cache writes by TTL; charge at the 5m rate.
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
      });
      if (!entered) {
        if (watermark > maxSeen) maxSeen = watermark;
        continue;
      }
      const { date, delta } = entered;

      // opencode writes cost: 0 on every row for providers it does not price, so
      // `??` would accept the zero and never reach calcCost. Only trust a cost it
      // actually reports, and fall back to our own rates otherwise.
      // opencode writes cost: 0 on every row for providers it does not price, so
      // `??` would accept the zero and never reach calcCost. Only trust a cost it
      // actually reports, and fall back to our own rates otherwise. A reported
      // cost is for the whole row, so scale it to the portion not yet counted.
      const reported = typeof msg.cost === 'number' && msg.cost > 0 ? msg.cost : null;
      const totalTok = input + output + cacheRead + cacheWrite;
      const deltaTok = delta.input + delta.output + delta.cacheRead + delta.cacheWrite5m;
      const cost = reported !== null
        ? reported * (totalTok > 0 ? deltaTok / totalTok : 1)
        : calcCost(normModel, delta);

      // A codename like `big-pickle` has no rate, so a $0 here is a gap in the
      // table rather than a free turn. Surface it instead of silently zeroing.
      if (reported === null && !isPriced(normModel)) unpriced.add(normModel);

      addToAgg(agg, 'opencode', date, normModel, {
        input: delta.input,
        output: delta.output,
        cache_read: delta.cacheRead,
        cache_write: delta.cacheWrite5m,
        cost_usd: cost,
      });

      if (watermark > maxSeen) maxSeen = watermark;
    }
  } finally {
    db.close();
  }

  return {
    lastTimestamp: new Date(maxSeen).toISOString(),
    counted: ledger.toJSON(),
    unpriced: [...unpriced],
  };
}
