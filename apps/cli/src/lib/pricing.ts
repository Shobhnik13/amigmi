import type { Usage } from '../types';

// All rates per 1M tokens in USD
// Source: https://anthropic.com/pricing

export type Rate = {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute TTL cache write — 1.25x base input */
  cacheWrite5m: number;
  /** 1-hour TTL cache write — 2x base input */
  cacheWrite1h: number;
};

// Anthropic cache writes are fixed multiples of the base input rate: 1.25x for
// the 5m TTL and 2x for the 1h TTL. Deriving them avoids transcription drift
// when a model is added.
//
// Cache reads are usually 0.1x input, but not always — Opus 5.5 reads at 0.05x —
// so pass cacheRead explicitly whenever the published rate is not a tenth.
const anthropic = (input: number, output: number, cacheRead = input * 0.1): Rate => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

// Providers that bill cache reads but not cache writes.
const flat = (input: number, output: number, cacheRead = 0): Rate => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});

const RATES: Record<string, Rate> = {
  // Claude Fable 5 / Mythos 5
  'claude-fable-5':    anthropic(10.00, 50.00),
  'claude-mythos-5':   anthropic(10.00, 50.00),

  // Claude Opus 5.5 — cache reads are 0.05x input, not the usual 0.1x
  'claude-opus-5-5':   anthropic(4.00, 20.00, 0.20),

  // Claude Opus 5
  'claude-opus-5':     anthropic(5.00, 25.00),

  // Claude Sonnet 5
  'claude-sonnet-5':   anthropic(3.00, 15.00),

  // Claude Opus 4.x
  'claude-opus-4-8':   anthropic(5.00, 25.00),
  'claude-opus-4-7':   anthropic(5.00, 25.00),
  'claude-opus-4-6':   anthropic(5.00, 25.00),
  'claude-opus-4-5':   anthropic(5.00, 25.00),

  // Claude Opus 4.1 / legacy
  'claude-opus-4-1':   anthropic(15.00, 75.00),
  'claude-opus-4-0':   anthropic(15.00, 75.00),

  // Claude Sonnet 4.x
  'claude-sonnet-4-6': anthropic(3.00, 15.00),
  'claude-sonnet-4-5': anthropic(3.00, 15.00),
  'claude-sonnet-4-0': anthropic(3.00, 15.00),

  // Claude Haiku
  'claude-haiku-4-5':  anthropic(1.00, 5.00),
  'claude-haiku-3-5':  anthropic(0.80, 4.00),
  'claude-3-5-haiku-20241022': anthropic(0.80, 4.00),

  // Legacy Claude 3
  'claude-3-5-sonnet-20241022': anthropic(3.00, 15.00),
  'claude-3-opus-20240229':     anthropic(15.00, 75.00),

  // OpenAI (source: developers.openai.com/api/docs/pricing)
  // GPT-5.6 family — 1.05M context. Requests over 272K input tokens bill at 2x input / 1.5x output.
  'gpt-5.6-sol':     flat(5.00,  30.00,  0.50),
  'gpt-5.6-terra':   flat(2.00,  12.00,  0.20),
  'gpt-5.6-luna':    flat(0.20,  1.20,   0.02),

  'gpt-5.5':         flat(5.00,  30.00,  0.50),
  'gpt-5.5-pro':     flat(30.00, 180.00, 0.00),
  'gpt-5.4':         flat(2.50,  15.00,  0.25),
  'gpt-5.4-mini':    flat(0.75,  4.50,   0.075),
  'gpt-5.4-nano':    flat(0.20,  1.25,   0.02),
  'gpt-5.3-codex':   flat(1.75,  14.00,  0.175),
  // Legacy OpenAI models
  'gpt-4o':          flat(2.50,  10.00,  1.25),
  'gpt-4o-mini':     flat(0.15,  0.60,   0.075),
  'o3':              flat(10.00, 40.00,  2.50),
  'o4-mini':         flat(1.10,  4.40,   0.275),

  // Google Gemini (source: ai.google.dev/pricing)
  'gemini-2.5-pro':          flat(1.25,  10.00, 0.31),
  'gemini-2.5-flash':        flat(0.15,  0.60,  0.0375),
  'gemini-2.5-flash-lite':   flat(0.10,  0.40,  0.025),
  'gemini-2.0-flash':        flat(0.10,  0.40,  0.025),
  'gemini-2.0-flash-lite':   flat(0.075, 0.30,  0.01875),
  'gemini-1.5-pro':          flat(1.25,  5.00,  0.3125),
  'gemini-1.5-flash':        flat(0.075, 0.30,  0.01875),

  // DeepSeek (source: api-docs.deepseek.com/quick_start/pricing)
  'deepseek-chat':      flat(0.27, 1.10, 0.07),
  'deepseek-reasoner':  flat(0.55, 2.19, 0.14),

  // Mistral (source: mistral.ai/pricing)
  'mistral-large-latest':   flat(2.00, 6.00),
  'mistral-medium-latest':  flat(0.40, 2.00),
  'mistral-small-latest':   flat(0.10, 0.30),
  'codestral-latest':       flat(0.20, 0.60),
  'ministral-8b-latest':    flat(0.10, 0.10),
  'ministral-3b-latest':    flat(0.04, 0.04),

  // xAI Grok (source: x.ai/api)
  'grok-3':         flat(3.00, 15.00),
  'grok-3-fast':    flat(0.60, 4.00),
  'grok-3-mini':    flat(0.30, 0.50),
  'grok-2':         flat(2.00, 10.00),
  'grok-2-mini':    flat(0.20, 0.50),

  // Alibaba Qwen (source: help.aliyun.com/qwen-api-pricing)
  'qwen-max':         flat(1.60, 6.40),
  'qwen-plus':        flat(0.40, 1.20),
  'qwen-turbo':       flat(0.05, 0.20),
  'qwen-long':        flat(0.05, 0.20),

  // Moonshot (Kimi) (source: platform.moonshot.cn/pricing)
  'moonshot-v1-8k':   flat(0.12, 0.12),
  'moonshot-v1-32k':  flat(0.24, 0.24),
  'moonshot-v1-128k': flat(0.90, 0.90),
  'kimi-k2':          flat(0.60, 2.50, 0.07),

  // Zhipu GLM (source: bigmodel.cn/pricing)
  'glm-4':            flat(0.14, 0.14),
  'glm-4-flash':      flat(0.00, 0.00),
  'glm-4-plus':       flat(0.70, 0.70),
  'glm-z1':           flat(0.14, 0.14),
};

// Models we know are genuinely free, so a $0 cost is correct rather than a
// missing rate. Keeps them out of the unpriced-model warning.
const FREE_MODELS = new Set(['glm-4-flash']);

// Strip trailing date suffix e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5
export function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function isPriced(model: string): boolean {
  const m = normalizeModel(model);
  return m in RATES || FREE_MODELS.has(m);
}

export function calcCost(model: string, u: Usage): number {
  const r = RATES[normalizeModel(model)];
  if (!r) return 0;
  return (
    (u.input        / 1_000_000) * r.input +
    (u.output       / 1_000_000) * r.output +
    (u.cacheRead    / 1_000_000) * r.cacheRead +
    (u.cacheWrite5m / 1_000_000) * r.cacheWrite5m +
    (u.cacheWrite1h / 1_000_000) * r.cacheWrite1h
  );
}
