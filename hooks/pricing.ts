import type { CostSplit } from '../types'

// Anthropic first-party API rates in dollars per million tokens, checked against
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-28. On a
// Claude plan these are an API-rate estimate, not what the person is billed.
//
// This table is the one source of truth: scripts/today_cost.py receives it as
// JSON from the mod (PRICES_JSON) rather than keeping a copy of its own.
export type Rates = { input: number; write5m: number; write1h: number; read: number; output: number }

export type Price = Rates & {
  // A prompt (input, cache reads and writes together) over `tokens` pays `rates` instead.
  over?: { tokens: number; rates: Rates }
  // Fast mode's input and output; cache multipliers apply on top of them.
  fast?: { input: number; output: number }
  // Claude 4.6 and later: `inference_geo: "us"` costs 1.1x on every category.
  geo?: true
}

const r = (input: number, write5m: number, write1h: number, read: number, output: number): Rates => ({ input, write5m, write1h, read, output })

// Keyed by the model id without its `claude-` prefix, date or platform suffix.
// Exact keys only: a pattern for "sonnet-5" would also price Sonnet 5.5.
export const PRICES: Record<string, Price> = {
  'fable-5-1': { ...r(10, 12.5, 20, 0.25, 50), geo: true },
  'mythos-5-1': { ...r(10, 12.5, 20, 0.25, 50), geo: true },
  'fable-5': { ...r(10, 12.5, 20, 1, 50), geo: true },
  'mythos-5': { ...r(10, 12.5, 20, 1, 50), geo: true },
  'opus-5-5': { ...r(4, 5, 8, 0.2, 20), fast: { input: 8, output: 40 }, geo: true },
  'opus-5': { ...r(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 }, geo: true },
  'opus-4-8': { ...r(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 }, geo: true },
  'opus-4-7': { ...r(5, 6.25, 10, 0.5, 25), geo: true },
  'opus-4-6': { ...r(5, 6.25, 10, 0.5, 25), geo: true },
  'opus-4-5': r(5, 6.25, 10, 0.5, 25),
  'opus-4-1': r(15, 18.75, 30, 1.5, 75),
  'opus-4': r(15, 18.75, 30, 1.5, 75),
  'sonnet-5-5': { ...r(2, 2.5, 4, 0.1, 10), geo: true },
  'sonnet-5': { ...r(2, 2.5, 4, 0.2, 10), geo: true },
  'sonnet-4-6': { ...r(3, 3.75, 6, 0.3, 15), geo: true },
  'sonnet-4-5': r(3, 3.75, 6, 0.3, 15),
  'sonnet-4': r(3, 3.75, 6, 0.3, 15),
  'haiku-5-5': { ...r(0.1, 0.125, 0.2, 0.01, 0.5), over: { tokens: 100_000, rates: r(0.5, 0.625, 1, 0.05, 2.5) }, geo: true },
  'haiku-4-5': r(1, 1.25, 2, 0.1, 5),
  'haiku-3-5': r(0.8, 1, 1.6, 0.08, 4),
}

// Older ids put the version first.
const ALIASES: Record<string, string> = { '3-5-haiku': 'haiku-3-5' }

export const PRICES_JSON = JSON.stringify({ prices: PRICES, aliases: ALIASES })

// `claude-sonnet-4-5-20250929`, `us.anthropic.claude-haiku-4-5-v1:0`,
// `claude-opus-4-5@20251101` and `claude-opus-5-5[1m]` all name a table key.
export const modelKey = (model: string): string | undefined => {
  const id = model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .match(/claude-(.+)$/)?.[1]
    ?.replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
  if (!id) return undefined
  const key = ALIASES[id] ?? id
  return key in PRICES ? key : undefined
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null
  speed?: string | null
  inference_geo?: string | null
}

// Per token, for splitting a measured request cost into its input and output.
export const rateOf = (model: string): { input: number; output: number; cacheRead: number } | undefined => {
  const key = modelKey(model)
  const price = key ? PRICES[key] : undefined
  return price && { input: price.input / 1e6, output: price.output / 1e6, cacheRead: price.read / 1e6 }
}

// A request's API-rate cost by what it was billed for, in dollars, or undefined when no
// price is known for its model (or for fast mode on it): unknown is never counted as free.
export const costSplitOf = (model: string, usage: Usage): CostSplit | undefined => {
  const key = modelKey(model)
  const price = key ? PRICES[key] : undefined
  if (!price) return undefined

  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  let rates: Rates = price.over && prompt > price.over.tokens ? price.over.rates : price
  if (usage.speed === 'fast') {
    if (!price.fast) return undefined
    // Cache writes and reads keep their multiples of the input rate.
    const scale = price.fast.input / rates.input
    rates = { input: price.fast.input, output: price.fast.output, write5m: rates.write5m * scale, write1h: rates.write1h * scale, read: rates.read * scale }
  }
  // Without the split, a write is priced as the API's default 5-minute one.
  const longWrites = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, usage.cache_creation_input_tokens)
  const per = (price.geo && usage.inference_geo === 'us' ? 1.1 : 1) / 1_000_000
  return {
    input: usage.input_tokens * rates.input * per,
    cacheRead: usage.cache_read_input_tokens * rates.read * per,
    cacheWrite: (longWrites * rates.write1h + (usage.cache_creation_input_tokens - longWrites) * rates.write5m) * per,
    output: usage.output_tokens * rates.output * per,
  }
}

// A request's API-rate cost, or undefined when no price is known for its model.
export const costOf = (model: string, usage: Usage): number | undefined => {
  const split = costSplitOf(model, usage)
  return split && split.input + split.cacheRead + split.cacheWrite + split.output
}

// Dollars per token a 5-minute cache write costs on this model, or undefined with no known price:
// what new input, such as a tool's result, usually costs the request that first reads it.
export const writeRateOf = (model: string): number | undefined => {
  const key = modelKey(model)
  const price = key ? PRICES[key] : undefined
  return price && price.write5m / 1e6
}
