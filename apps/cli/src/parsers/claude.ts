import { join } from 'path';
import { existsSync } from 'fs';
import { addToAgg, type AggMap } from '../lib/aggregate';
import { calcCost, isPriced, normalizeModel } from '../lib/pricing';
import type { LedgerState } from '../types';
import { UsageLedger } from '../lib/ledger';

interface ClaudeEntry {
  type: string;
  timestamp: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

export type ClaudeResult = {
  cursors: Record<string, number>;
  counted: LedgerState;
  unpriced: string[];
};

// Parses ~/.claude/projects/**/*.jsonl
// Only reads bytes past the saved cursor for each file
export async function parseClaude(
  agg: AggMap,
  cursors: Record<string, number>,
  counted: LedgerState = {},
): Promise<ClaudeResult> {
  const newCursors: Record<string, number> = { ...cursors };
  const baseDir = join(process.env.HOME!, '.claude', 'projects');

  const ledger = new UsageLedger(counted);
  const unpriced = new Set<string>();

  // Claude Code not installed — skip silently so other agents still sync
  if (!existsSync(baseDir)) {
    return { cursors: newCursors, counted: ledger.toJSON(), unpriced: [] };
  }

  const glob = new Bun.Glob('**/*.jsonl');

  for await (const relative of glob.scan({ cwd: baseDir })) {
    const filePath = join(baseDir, relative);
    const file = Bun.file(filePath);
    const size = file.size;
    const cursor = newCursors[filePath] ?? 0;

    if (size <= cursor) continue;

    // Bounded to `size` so anything written mid-sync is left for the next run
    // rather than being counted now and again after the cursor advances.
    const raw = await file.slice(cursor, size).text();

    // A sync can land mid-append, leaving a truncated final line. Stop at the
    // last newline and leave the remainder for the next run — advancing the
    // cursor past a partial line would drop that entry permanently.
    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline === -1) continue;
    const text = raw.slice(0, lastNewline + 1);
    newCursors[filePath] = cursor + Buffer.byteLength(text, 'utf8');

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      let entry: ClaudeEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'assistant') continue;

      const usage = entry.message?.usage;
      const model = entry.message?.model;
      if (!model || !usage || model === '<synthetic>') continue;

      const seenDate  = entry.timestamp.slice(0, 10);
      const normModel = normalizeModel(model);
      const input     = usage.input_tokens ?? 0;
      const output    = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;

      // cache_creation_input_tokens is the 5m + 1h total, but the two TTLs bill
      // at different rates (1.25x vs 2x input). Prefer the per-TTL breakdown and
      // fall back to charging the whole lot at the 5m rate if it is absent.
      const cacheTotal = usage.cache_creation_input_tokens ?? 0;
      const split      = usage.cache_creation;
      const write1h    = split?.ephemeral_1h_input_tokens ?? 0;
      const write5m    = split
        ? (split.ephemeral_5m_input_tokens ?? 0)
        : cacheTotal;

      // Claude Code writes one line per content block (thinking / text / each
      // tool_use) and repeats the usage object on every one, replays lines into
      // resumed and forked sessions, and can flush a line mid-stream with a
      // partial (sometimes zero) output count before the final one lands. The
      // billed unit is the API response, so bank the high-water mark per message
      // id and aggregate only the increment — that way the total does not depend
      // on how many lines a response took or where a sync boundary fell.
      const id = entry.message?.id;
      const entered = id
        ? ledger.record(id, seenDate, {
            input, output, cacheRead, cacheWrite5m: write5m, cacheWrite1h: write1h,
          })
        : { date: seenDate, delta: {
            input, output, cacheRead, cacheWrite5m: write5m, cacheWrite1h: write1h,
          } };
      if (!entered) continue;

      const { date, delta } = entered;
      if (!isPriced(normModel)) unpriced.add(normModel);

      addToAgg(agg, 'claude_code', date, normModel, {
        input: delta.input,
        output: delta.output,
        cache_read: delta.cacheRead,
        cache_write: delta.cacheWrite5m + delta.cacheWrite1h,
        cost_usd: calcCost(normModel, delta),
      });
    }
  }

  return { cursors: newCursors, counted: ledger.toJSON(), unpriced: [...unpriced] };
}
