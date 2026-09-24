import type { Agent, AggregateRecord } from '../types';

// Cost is kept as a number while aggregating and only formatted on the way out.
// Rounding to 6dp on every add re-rounds the running total once per response,
// which drifts by a cent or so across a few thousand of them.
type AggRow = Omit<AggregateRecord, 'cost_usd'> & { cost_usd: number };

export type AggMap = Map<string, AggRow>;

export function createAggMap(): AggMap {
  return new Map();
}

export function addToAgg(
  map: AggMap,
  agent: Agent,
  date: string,
  model: string,
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cost_usd: number;
  },
): void {
  const key = `${agent}::${date}::${model}`;
  const existing = map.get(key);

  if (existing) {
    existing.input_tokens += tokens.input;
    existing.output_tokens += tokens.output;
    existing.cache_read_tokens += tokens.cache_read;
    existing.cache_write_tokens += tokens.cache_write;
    existing.cost_usd += tokens.cost_usd;
  } else {
    map.set(key, {
      agent,
      date,
      model,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cache_read,
      cache_write_tokens: tokens.cache_write,
      cost_usd: tokens.cost_usd,
    });
  }
}

export function aggToRecords(map: AggMap): AggregateRecord[] {
  return Array.from(map.values(), (r) => ({ ...r, cost_usd: r.cost_usd.toFixed(6) }));
}
