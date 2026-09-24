import { createAggMap, aggToRecords } from './aggregate';
import { parseClaude } from '../parsers/claude';
import { parseCodex } from '../parsers/codex';
import { parseOpencode } from '../parsers/opencode';
import type { AggregateRecord, State } from '../types';

export type Collected = {
  records: AggregateRecord[];
  state: Omit<State, 'last_sync_at'>;
  unpriced: string[];
};

const EPOCH = new Date(0).toISOString();

// Runs every parser against the given starting state and returns the records to
// push alongside the state to persist once the push succeeds. Passing an empty
// state rescans every source from the beginning, which is what the one-time
// migration in sync.ts does.
export async function collect(state: Partial<State> = {}): Promise<Collected> {
  const cursors = state.cursors ?? {};
  const counted = state.counted ?? {};
  const agg = createAggMap();

  const [claude, opencode, codex] = await Promise.all([
    parseClaude(agg, cursors.claude_code ?? {}, counted.claude_code),
    parseOpencode(agg, cursors.opencode?.last_timestamp ?? EPOCH, counted.opencode),
    parseCodex(agg, cursors.codex ?? {}),
  ]);

  return {
    records: aggToRecords(agg),
    state: {
      cursors: {
        claude_code: claude.cursors,
        opencode: { last_timestamp: opencode.lastTimestamp },
        codex: codex.cursors,
      },
      counted: {
        claude_code: claude.counted,
        opencode: opencode.counted,
      },
    },
    unpriced: [...new Set([...claude.unpriced, ...codex.unpriced, ...opencode.unpriced])],
  };
}

export function warnUnpriced(unpriced: string[]): void {
  if (unpriced.length === 0) return;

  console.warn(
    `Warning: no rate for ${unpriced.join(', ')} — those turns are counted as $0. ` +
      `Token counts are still accurate.`,
  );
}
