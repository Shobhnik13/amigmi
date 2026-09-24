import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAggMap, aggToRecords } from '../lib/aggregate';
import { parseClaude } from '../parsers/claude';
import { parseCodex } from '../parsers/codex';

const REAL_HOME = process.env.HOME!;
const roots: string[] = [];
const newHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'amigmi-'));
  roots.push(d);
  return d;
};
afterAll(() => {
  process.env.HOME = REAL_HOME;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const totals = (map: ReturnType<typeof createAggMap>) =>
  aggToRecords(map).reduce(
    (a, r) => ({
      cost: a.cost + parseFloat(r.cost_usd),
      tokens: a.tokens + r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    }),
    { cost: 0, tokens: 0 },
  );

/** One assistant line as Claude Code writes it: one line per content block. */
const line = (
  id: string,
  block: string,
  usage: Partial<Record<'in' | 'out' | 'cr' | 'w5' | 'w1', number>>,
  model = 'claude-opus-5',
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T10:00:00.000Z',
    uuid: `${id}-${block}`,
    message: {
      id,
      model,
      content: [{ type: block }],
      usage: {
        input_tokens: usage.in ?? 0,
        output_tokens: usage.out ?? 0,
        cache_read_input_tokens: usage.cr ?? 0,
        cache_creation_input_tokens: (usage.w5 ?? 0) + (usage.w1 ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: usage.w5 ?? 0,
          ephemeral_1h_input_tokens: usage.w1 ?? 0,
        },
      },
    },
  });

const TRANSCRIPT = [
  line('msg_a', 'thinking', { in: 2, out: 1456, cr: 72385, w1: 5046 }),
  line('msg_a', 'text',     { in: 2, out: 1456, cr: 72385, w1: 5046 }),
  line('msg_a', 'tool_use', { in: 2, out: 1456, cr: 72385, w1: 5046 }),
  line('msg_a', 'tool_use', { in: 2, out: 1456, cr: 72385, w1: 5046 }),
  // a synthetic turn: Claude Code composed it locally, nothing was billed
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T10:00:01.000Z',
    uuid: 'synth',
    message: { id: 'msg_s', model: '<synthetic>', content: [{ type: 'text' }],
      usage: { input_tokens: 0, output_tokens: 0 } },
  }),
  // streamed: flushed early with a partial count, finalised on the next line
  line('msg_b', 'text',     { in: 2, out: 0 }),
  line('msg_b', 'text',     { in: 2, out: 527, cr: 150737, w1: 396 }),
  // replayed verbatim, as a resumed session does
  line('msg_a', 'thinking', { in: 2, out: 1456, cr: 72385, w1: 5046 }),
  line('msg_c', 'text',     { in: 5, out: 200, w5: 1000 }, 'claude-sonnet-5'),
].join('\n') + '\n';

function writeTranscript(home: string, body: string) {
  const dir = join(home, '.claude', 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), body);
}

describe('parseClaude', () => {
  test('counts each billed response once, at its final usage', async () => {
    process.env.HOME = newHome();
    writeTranscript(process.env.HOME, TRANSCRIPT);

    const agg = createAggMap();
    const res = await parseClaude(agg, {}, {});
    const t = totals(agg);

    // msg_a + msg_b + msg_c; the <synthetic> turn is not billed
    expect(Object.values(res.counted).flatMap(Object.keys).sort()).toEqual(['msg_a', 'msg_b', 'msg_c']);
    expect(t.tokens).toBe(
      (2 + 1456 + 72385 + 5046) +   // msg_a counted once despite 5 lines
      (2 + 527 + 150737 + 396) +    // msg_b at its finalised count, not the partial
      (5 + 200 + 1000),
    );
    // 1h writes at 2x input, 5m at 1.25x
    expect(t.cost).toBeCloseTo(
      (2 * 5 + 1456 * 25 + 72385 * 0.5 + 5046 * 10) / 1e6 +
      (2 * 5 + 527 * 25 + 150737 * 0.5 + 396 * 10) / 1e6 +
      (5 * 3 + 200 * 15 + 1000 * 3.75) / 1e6,
      9,
    );
  });

  test('an immediate re-sync adds nothing', async () => {
    process.env.HOME = newHome();
    writeTranscript(process.env.HOME, TRANSCRIPT);

    const first = createAggMap();
    const r1 = await parseClaude(first, {}, {});

    const second = createAggMap();
    await parseClaude(second, r1.cursors, r1.counted);
    expect(aggToRecords(second)).toEqual([]);
  });

  test('the same totals whether the file arrives whole or in pieces', async () => {
    process.env.HOME = newHome();
    writeTranscript(process.env.HOME, TRANSCRIPT);
    const whole = createAggMap();
    await parseClaude(whole, {}, {});
    const expected = totals(whole);

    // replay the file byte by byte in four chunks, cutting mid-line each time,
    // exactly as a sync racing an append would see it
    process.env.HOME = newHome();
    const buf = Buffer.from(TRANSCRIPT);
    let cursors = {}, counted = {}, cost = 0, tokens = 0;
    for (const pct of [0.31, 0.58, 0.79, 1]) {
      writeTranscript(process.env.HOME, buf.subarray(0, Math.floor(buf.length * pct)).toString());
      const agg = createAggMap();
      const res = await parseClaude(agg, cursors, counted);
      cursors = res.cursors;
      counted = res.counted;
      const t = totals(agg);
      cost += t.cost;
      tokens += t.tokens;
    }

    // Tokens must match exactly. Cost is sent as a 6dp string, so a response
    // split across four syncs rounds four times instead of once — a sub-cent
    // difference that the wire format makes unavoidable.
    expect(tokens).toBe(expected.tokens);
    expect(cost).toBeCloseTo(expected.cost, 5);
  });

  test('leaves a half-written trailing line for the next sync', async () => {
    process.env.HOME = newHome();
    const truncated = TRANSCRIPT.slice(0, TRANSCRIPT.length - 40);  // cuts mid-line
    writeTranscript(process.env.HOME, truncated);

    const agg = createAggMap();
    const res = await parseClaude(agg, {}, {});
    // the cursor must stop at the last complete line, or that entry is lost
    expect(res.cursors[join(process.env.HOME!, '.claude', 'projects', 'proj', 'session.jsonl')])
      .toBe(truncated.lastIndexOf('\n') + 1);

    writeTranscript(process.env.HOME, TRANSCRIPT);
    const rest = createAggMap();
    await parseClaude(rest, res.cursors, res.counted);
    expect(totals(rest).tokens).toBe(5 + 200 + 1000);   // msg_c, not dropped
  });
});

describe('parseCodex', () => {
  // Reconciliation against real sessions: summing every last_token_usage delta
  // must land exactly on the session's final cumulative total. This is the check
  // that caught Codex retransmitting a token_count event.
  const sessions = join(REAL_HOME, '.codex', 'sessions');
  const has = existsSync(sessions);

  test.skipIf(!has)('summed deltas reconcile to each session total', async () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.jsonl') ? [join(d, e.name)] : []);

    for (const file of walk(sessions)) {
      let sumIn = 0, sumOut = 0, finalIn = 0, finalOut = 0, prev: string | null = null;
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        let e: any;
        try { e = JSON.parse(raw); } catch { continue; }
        if (e.type !== 'event_msg' || e.payload?.type !== 'token_count') continue;
        const info = e.payload.info ?? {};
        const key = info.total_token_usage ? JSON.stringify(info.total_token_usage) : null;
        const retransmit = key !== null && key === prev;
        if (key !== null) prev = key;
        if (retransmit) continue;
        sumIn += info.last_token_usage?.input_tokens ?? 0;
        sumOut += info.last_token_usage?.output_tokens ?? 0;
        finalIn = info.total_token_usage?.input_tokens ?? finalIn;
        finalOut = info.total_token_usage?.output_tokens ?? finalOut;
      }
      expect({ file, sumIn, sumOut }).toEqual({ file, sumIn: finalIn, sumOut: finalOut });
    }
  });

  test.skipIf(!has)('an immediate re-sync adds nothing', async () => {
    const first = createAggMap();
    const r1 = await parseCodex(first, {});
    const second = createAggMap();
    await parseCodex(second, r1.cursors);
    expect(aggToRecords(second)).toEqual([]);
  });
});
