import { join } from 'path';
import { existsSync } from 'fs';
import { addToAgg, type AggMap } from '../lib/aggregate';
import { calcCost, isPriced, normalizeModel } from '../lib/pricing';

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface TurnContextEntry {
  type: 'turn_context';
  timestamp: string;
  payload: { model?: string; current_date?: string };
}

interface TokenCountEntry {
  type: 'event_msg';
  timestamp: string;
  payload: {
    type: 'token_count';
    info: {
      last_token_usage: TokenUsage;
      total_token_usage?: TokenUsage;
    };
  };
}

type CodexEntry = TurnContextEntry | TokenCountEntry | { type: string };

export type CodexResult = {
  cursors: Record<string, number>;
  unpriced: string[];
};

// Parses ~/.codex/sessions/**/*.jsonl
// Byte-offset cursors, same strategy as claude.ts
export async function parseCodex(
  agg: AggMap,
  cursors: Record<string, number>,
): Promise<CodexResult> {
  const newCursors: Record<string, number> = { ...cursors };
  const unpriced = new Set<string>();
  const baseDir = join(process.env.HOME!, '.codex', 'sessions');

  // Codex not installed — skip silently so other agents still sync
  if (!existsSync(baseDir)) return { cursors: newCursors, unpriced: [] };

  const glob = new Bun.Glob('**/*.jsonl');

  for await (const relative of glob.scan({ cwd: baseDir })) {
    const filePath = join(baseDir, relative);
    const file = Bun.file(filePath);
    const size = file.size;
    const cursor = newCursors[filePath] ?? 0;

    if (size <= cursor) continue;

    // Read from the beginning so `turn_context` and the running token total are
    // tracked correctly even when they sit before the cursor, but slice to the
    // `size` we recorded — reading the whole file would pick up bytes written
    // mid-sync and count them again on the next run once the cursor advances.
    const raw = await file.slice(0, size).text();

    // A sync can land mid-append, leaving a truncated final line. Stop at the
    // last newline and leave the remainder for the next run — advancing the
    // cursor past a partial line would drop that entry permanently.
    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline === -1) continue;
    const fullText = raw.slice(0, lastNewline + 1);
    newCursors[filePath] = Buffer.byteLength(fullText, 'utf8');

    let currentModel = 'codex';
    let alreadySeen = 0;
    let prevTotal: string | null = null;

    for (const rawLine of fullText.split('\n')) {
      const byteLen = Buffer.byteLength(rawLine + '\n', 'utf8');
      const isNew = alreadySeen >= cursor;
      alreadySeen += byteLen;

      const line = rawLine.trim();
      if (!line) continue;

      let entry: CodexEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'turn_context') {
        currentModel = (entry as TurnContextEntry).payload.model ?? currentModel;
        continue;
      }

      if (
        entry.type !== 'event_msg' ||
        (entry as TokenCountEntry).payload?.type !== 'token_count'
      ) {
        continue;
      }

      const e = entry as TokenCountEntry;
      const u = e.payload.info?.last_token_usage;
      if (!u) continue;

      // Codex occasionally retransmits a token_count event. A genuine turn always
      // advances total_token_usage, so an unchanged total means we are looking at
      // the same usage twice. Tracked across the whole file, including lines
      // before the cursor, so the check still works on an incremental read.
      const total = e.payload.info?.total_token_usage;
      const totalKey = total ? JSON.stringify(total) : null;
      const isRetransmit = totalKey !== null && totalKey === prevTotal;
      if (totalKey !== null) prevTotal = totalKey;

      if (!isNew || isRetransmit) continue;

      const date      = e.timestamp.slice(0, 10);
      const normModel = normalizeModel(currentModel);

      // OpenAI format: input_tokens includes cached_input_tokens, so subtract
      // to avoid billing cached tokens twice (unlike Claude, where they're separate).
      // reasoning_output_tokens is already part of output_tokens — do not add it.
      const cacheRead = u.cached_input_tokens ?? 0;
      const input     = Math.max(0, (u.input_tokens ?? 0) - cacheRead);
      const output    = u.output_tokens ?? 0;

      // Default 'codex' means no turn_context was seen yet; it has no rate, so
      // the turn would silently price at $0. Surface it instead of hiding it.
      if (!isPriced(normModel)) unpriced.add(normModel);

      addToAgg(agg, 'codex', date, normModel, {
        input,
        output,
        cache_read: cacheRead,
        cache_write: 0,
        cost_usd: calcCost(normModel, {
          input,
          output,
          cacheRead,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        }),
      });
    }
  }

  return { cursors: newCursors, unpriced: [...unpriced] };
}
