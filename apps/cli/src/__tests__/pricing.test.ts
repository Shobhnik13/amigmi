import { describe, expect, test } from 'bun:test';
import { calcCost, isPriced, normalizeModel } from '../lib/pricing';

const M = 1_000_000;
const u = (o: Partial<Parameters<typeof calcCost>[1]>) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o,
});

describe('pricing', () => {
  test('strips a date suffix from a model id', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModel('claude-opus-5')).toBe('claude-opus-5');
  });

  test('prices a 1h cache write at 2x input, not the 5m 1.25x', () => {
    // 99% of Claude Code cache writes are 1h; charging them at 1.25x understated
    // the total by ~12%.
    expect(calcCost('claude-opus-5', u({ cacheWrite1h: M }))).toBeCloseTo(10.0, 9);
    expect(calcCost('claude-opus-5', u({ cacheWrite5m: M }))).toBeCloseTo(6.25, 9);
  });

  test('anthropic cache reads are a tenth of input', () => {
    expect(calcCost('claude-opus-5', u({ cacheRead: M }))).toBeCloseTo(0.5, 9);
    expect(calcCost('claude-sonnet-5', u({ cacheRead: M }))).toBeCloseTo(0.3, 9);
  });

  test('opus 5.5 reads cache at 0.05x input, not the usual 0.1x', () => {
    // The one current Anthropic model where the ratio does not hold, so the
    // derived default would overcharge cache reads by 2x.
    expect(calcCost('claude-opus-5-5', u({ cacheRead: M }))).toBeCloseTo(0.20, 9);
    expect(calcCost('claude-opus-5-5', u({ input: M }))).toBeCloseTo(4.0, 9);
    expect(calcCost('claude-opus-5-5', u({ output: M }))).toBeCloseTo(20.0, 9);
    expect(calcCost('claude-opus-5-5', u({ cacheWrite1h: M }))).toBeCloseTo(8.0, 9);
  });

  test('providers without cache-write billing charge nothing for it', () => {
    expect(calcCost('gpt-5.5', u({ cacheWrite5m: M, cacheWrite1h: M }))).toBe(0);
  });

  test('an unknown model is reported unpriced rather than silently zeroed', () => {
    expect(calcCost('big-pickle', u({ input: M, output: M }))).toBe(0);
    expect(isPriced('big-pickle')).toBe(false);
    expect(isPriced('codex')).toBe(false);      // the no-turn_context default
    expect(isPriced('claude-opus-5')).toBe(true);
    expect(isPriced('glm-4-flash')).toBe(true); // genuinely free, not missing
  });

  test('cost is linear, so summing deltas equals pricing the whole', () => {
    const whole = calcCost('claude-opus-5', u({ input: 100, output: 900, cacheWrite1h: 500 }));
    const a = calcCost('claude-opus-5', u({ input: 100, output: 400, cacheWrite1h: 500 }));
    const b = calcCost('claude-opus-5', u({ output: 500 }));
    expect(a + b).toBeCloseTo(whole, 12);
  });
});
