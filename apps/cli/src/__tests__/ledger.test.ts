import { describe, expect, test } from 'bun:test';
import { UsageLedger } from '../lib/ledger';

const u = (input: number, output: number, cacheRead = 0, w5 = 0, w1 = 0) => ({
  input, output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1,
});

describe('UsageLedger', () => {
  test('counts a response once when its blocks repeat the same usage', () => {
    const l = new UsageLedger();
    // Claude Code writes one line per content block, each with the full usage.
    expect(l.record('m1', '2026-09-01', u(2, 1456, 72385))!.delta.output).toBe(1456);
    expect(l.record('m1', '2026-09-01', u(2, 1456, 72385))).toBeNull();
    expect(l.record('m1', '2026-09-01', u(2, 1456, 72385))).toBeNull();
  });

  test('tops up when a later line finalises a still-streaming count', () => {
    const l = new UsageLedger();
    // Observed shape: an early line flushed with zeros, the real usage after.
    expect(l.record('m1', '2026-09-01', u(0, 0, 0))).toBeNull();
    const second = l.record('m1', '2026-09-01', u(2, 527, 150737, 396))!;
    expect(second.delta).toEqual(u(2, 527, 150737, 396));
  });

  test('takes the high-water mark per field, never moving backwards', () => {
    const l = new UsageLedger();
    l.record('m1', '2026-09-01', u(2, 1, 0, 25120));
    const next = l.record('m1', '2026-09-01', u(2, 269, 0, 25120))!;
    expect(next.delta).toEqual(u(0, 268, 0, 0));
    // a stale line arriving late must not subtract
    expect(l.record('m1', '2026-09-01', u(2, 1, 0, 25120))).toBeNull();
  });

  test('splitting a response across syncs totals the same as one sync', () => {
    const whole = new UsageLedger();
    whole.record('m1', '2026-09-01', u(2, 100, 500));
    const oneShot = whole.toJSON();

    let state = {};
    const first = new UsageLedger(state);
    first.record('m1', '2026-09-01', u(2, 40, 500));   // sync lands mid-stream
    state = first.toJSON();
    const second = new UsageLedger(state);
    second.record('m1', '2026-09-01', u(2, 100, 500)); // finalised next sync

    expect(second.toJSON()).toEqual(oneShot);
  });

  test('pins a response to the date first seen', () => {
    const l = new UsageLedger();
    l.record('m1', '2026-09-01', u(1, 1));
    expect(l.record('m1', '2026-09-02', u(1, 5))!.date).toBe('2026-09-01');
  });

  test('survives a round trip through state.json', () => {
    const l = new UsageLedger();
    l.record('m1', '2026-09-01', u(2, 1456, 72385, 0, 5046));
    const revived = new UsageLedger(JSON.parse(JSON.stringify(l.toJSON())));
    expect(revived.record('m1', '2026-09-01', u(2, 1456, 72385, 0, 5046))).toBeNull();
  });

  test('prunes relative to the newest bucket, not wall-clock now', () => {
    // A tool unused for months is still re-read inside its own lookback window;
    // expiring its entries on wall-clock time would let that re-read count twice.
    const stale = { '2020-01-01': { old: [1, 1, 0, 0, 0] as [number,number,number,number,number] } };
    expect(new UsageLedger(stale).record('old', '2020-01-01', u(1, 1))).toBeNull();
  });

  test('drops buckets far behind the newest', () => {
    const l = new UsageLedger({
      '2020-01-01': { ancient: [1, 1, 0, 0, 0] },
      '2026-09-01': { recent:  [1, 1, 0, 0, 0] },
    });
    expect(l.size).toBe(1);
    expect(l.record('recent', '2026-09-01', u(1, 1))).toBeNull();
  });
});
