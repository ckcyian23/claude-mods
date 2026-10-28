// Pure parts of caffeine: the cache TTL, when the next poke is due, the
// durations and times it parses and prints, and the usage lines it will not cross.

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export const DEFAULT_MESSAGE = 'poke, just say okay'

const second = 1000
const minute = 60 * second
const hour = 60 * minute

export const TTL_5M = 5 * minute
export const TTL_1H = hour

// The default poke delay after the last request: 55m of a 1h cache (5m to spare),
// 4m of a 5m one. Each poke restarts the TTL, so one late poke per lifetime is enough.
export function defaultEvery(ttl: number): number {
  return ttl >= TTL_1H ? 55 * minute : 4 * minute
}

// Keep-alive runs this long after your last message, then stops (compaction takes over).
export const DEFAULT_IDLE = 24 * hour

// Below this many tokens of context a cold cache is cheap: no automatic compaction.
export const DEFAULT_SIZE = 200_000

// Compaction starts this long before the cache expires: a big summary pass takes minutes,
// and it only reads the cache if it starts while the cache is still warm.
export function compactAt(lastAt: number, ttl: number, lead = 5 * minute): number | null {
  if (lastAt === 0) return null
  return lastAt + ttl - Math.min(lead, Math.round(ttl / 5))
}

// Pokes stop only when a window is full: no request goes through then. Below it a poke costs
// a twentieth of a cache rewrite, so they go on while the usage climbs.
export const LIMIT_LINE = { five_hour: 100, seven_day: 100 } as const
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' }

// The first window at its line (full), or null.
export function overLine(limits: readonly Limit[]): { label: string; percent: number } | null {
  for (const l of limits) {
    const line = LIMIT_LINE[l.kind as keyof typeof LIMIT_LINE]
    if (line !== undefined && l.percentUsed >= line) {
      return { label: LABELS[l.kind] ?? l.kind, percent: Math.round(l.percentUsed) }
    }
  }
  return null
}

// Compaction is skipped only when a window is this full: the summary pass itself costs a few percent.
export const COMPACT_STOP = 98

export function nearlyFull(limits: readonly Limit[]): boolean {
  return limits.some(l => l.kind in LIMIT_LINE && l.percentUsed >= COMPACT_STOP)
}

// A usage wall ahead: a window past this percent whose reset comes after the cache expires
// (`cacheEnds`, the last request plus the TTL). The cache will die before work can resume, so a
// big context is better shrunk while the cache is still warm (a rewrite costs 2x the context,
// a compaction a fraction of it).
export const WALL_PERCENT = 95
export const DEFAULT_WALL_SIZE = 220_000

// The window about to block, or null. Under 100%: at 100% no request goes through.
export function wallAhead(limits: readonly Limit[], cacheEnds: number, percent = WALL_PERCENT): { label: string; percent: number; resetsAt: number | null } | null {
  for (const l of limits) {
    if (!(l.kind in LIMIT_LINE) || l.percentUsed < percent || l.percentUsed >= 100) continue
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
    const resetsAt = Number.isNaN(reset) ? null : reset
    if (resetsAt === null || resetsAt > cacheEnds) {
      return { label: LABELS[l.kind] ?? l.kind, percent: Math.round(l.percentUsed), resetsAt }
    }
  }
  return null
}

// The TTL the environment or settings pin, or null if automatic, checked in
// Claude Code's (2.1.301) order: FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL
// ("5m" or "1h"), the `promptCacheTtl` setting, ENABLE_PROMPT_CACHING_1H.
// (Agent frontmatter sits before ENABLE_1H there, but only reaches subagents,
// whose requests caffeine does not read.)
export function ttlFromEnv(force5m: string | undefined, cacheTtl: string | undefined, settingTtl: unknown, enable1h: string | undefined): number | null {
  if (isSet(force5m)) return TTL_5M
  return parseTtl(cacheTtl) ?? parseTtl(settingTtl) ?? (isSet(enable1h) ? TTL_1H : null)
}

const parseTtl = (v: unknown): number | null => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return t === '1h' ? TTL_1H : t === '5m' ? TTL_5M : null
}

const isSet = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

// Claude Code's automatic choice: 1h on a subscription under its limits (only
// subscriptions have rate-limit windows), else 5m.
export function ttlByPlan(limits: readonly Limit[]): number {
  return limits.length > 0 && limits.every(l => l.percentUsed < 100) ? TTL_1H : TTL_5M
}

// 1h when one request's cost proves it: the session cost rose by `delta`
// dollars for `u`, and only the cache write's rate is unknown. The cost is
// Claude Code's estimate, not the bill: it prices a write at the 1h 2x only
// for tokens the API reported under a 1h TTL (and only if its price table has
// a 1h rate for the model), every other write at the 5m 1.25x. So 2x proves
// 1h, and 1.25x proves nothing (a 5m write, or a 1h one priced as 5m).
// Null when the write is too small to tell, the price is unknown, or the rate
// is not 2x (1.25x, or a subagent's request landed in between).
// Two charges never reach the hook, which gets only the four token counts and
// the model (no inference_geo, no web search count): a web search ($0.01
// each) and the US multiplier. So the cost is read as is and with the
// multiplier off, and 2x from either is 1h. The write must be at least a
// quarter of the rest of the request so the two readings cannot meet (a US 5m
// write reads under 1.8x as is, a 1h write elsewhere under 1.85x with the
// multiplier off), and large enough that one search moves its rate by less
// than the tolerance, so a search cannot carry a 5m write to 2x: over 100k
// tokens on Haiku ($1), 50k on Sonnet 5, 25k on Opus 5.5, 10k on Fable.
// Several searches or a subagent's cost can still land on 2x by chance; a cold
// cache inside the hour with no 2x reading of its own takes it back (register.tsx).
export function ttlFromCost(delta: number, u: Usage, model: string): number | null {
  const price = inputPrice(model)
  if (price === null || u.cache_creation_input_tokens < 1000 || !(delta > 0)) {
    return null
  }
  const rest = u.input_tokens + u.output_tokens * 5 + u.cache_read_input_tokens * readRate(model)
  if (rest > 4 * u.cache_creation_input_tokens || (u.cache_creation_input_tokens * price * RATE_TOLERANCE) / 1e6 <= WEB_SEARCH_USD) {
    return null
  }
  const rateOf = (usd: number) => ((usd * 1e6) / price - rest) / u.cache_creation_input_tokens
  return [delta, delta / US_MULTIPLIER].some(usd => Math.abs(rateOf(usd) - 2) < RATE_TOLERANCE) ? TTL_1H : null
}

// how far from 2x a write's rate may read and still count as 1h
const RATE_TOLERANCE = 0.1

// Claude Code's flat charge per web search (never multiplied by the US x1.1)
const WEB_SEARCH_USD = 0.01

// Claude Code's estimate (2.1.301) multiplies a request's whole cost by 1.1
// when usage says inference_geo "us"; no other region has one.
export const US_MULTIPLIER = 1.1

// When the next poke is due, or null before the first request.
export function nextPokeAt(lastAt: number, every: number): number | null {
  return lastAt > 0 ? lastAt + every : null
}

// A cache read larger than what the request had to write again: still warm.
export function wasWarm(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined): boolean | null {
  if (!usage) return null
  return usage.cache_read_input_tokens > usage.cache_creation_input_tokens
}

const UNITS: Record<string, number> = { h: hour, m: minute, s: second }

// A span of time as people type it: `2h`, `90m`, `1h30m`, `2.5m`, `150s`,
// `1 min`, `5 minutes`, `2 hours`, `1 hour 30 min`, `in 20 minutes`, `+90m`.
// Milliseconds, or null.
export function parseDuration(text: string): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^(in|for)\s+/, '')
    .replace(/^\+/, '')
    .replace(/,|\band\b/g, ' ')
  const part = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/g
  let ms = 0
  let rest = t
  for (const m of t.matchAll(part)) {
    ms += Number(m[1]) * UNITS[m[2]![0]!]!
    rest = rest.replace(m[0], '')
  }
  return ms > 0 && rest.trim() === '' ? Math.round(ms) : null
}

// `18:00`, `6pm`, `6:30 pm`, `at 3pm`, `noon`, `midnight`: the next such time
// after `now`, or null.
export function parseClock(word: string, now: number): number | null {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/^at\s+/, '')
    .replace(/^noon$/, '12:00')
    .replace(/^midnight$/, '0:00')
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(w)
  if (!time || (!time[2] && !time[3])) {
    return null
  }
  let h = Number(time[1])
  const m = Number(time[2] ?? 0)
  if (time[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (time[3].startsWith('p') ? 12 : 0)
  }
  if (h > 23 || m > 59) {
    return null
  }
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  return d.getTime() <= now ? d.getTime() + 24 * hour : d.getTime()
}

const two = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// 14:12 today, `Sat 14:12` on another day.
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? time : `${DAYS[d.getDay()]} ${time}`
}

// 2h 05m, 12m, 2m 30s, 45s.
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / second))
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
  if (s >= 600) return `${Math.round(s / 60)}m`
  if (s >= 60) return s % 60 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${s / 60}m`
  return `${s}s`
}

// Request cost in input-token equivalents (base input = 1), by the API's
// ratios: output 5x, cache writes 1.25x (5m) or 2x (1h), cache reads 0.1x,
// except 0.05x on Opus 5.5 and 0.025x on Fable 5.1 and Mythos 5.1.
export function readRate(model: string): number {
  if (/fable-5-1|mythos-5-1/.test(model)) return 0.025
  if (/opus-5-5/.test(model)) return 0.05
  return 0.1
}

export const writeRate = (ttl: number) => (ttl >= TTL_1H ? 2 : 1.25)

// API list input price, $ per million tokens, for the models caffeine knows.
const PRICES: [RegExp, number][] = [
  [/fable-5|mythos-5/, 10],
  [/opus-5-5/, 4],
  [/opus-[45]/, 5],
  [/sonnet-5/, 2],
  [/sonnet-4-6/, 3],
  [/haiku-4-5/, 1],
]

export function inputPrice(model: string): number | null {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function equivalents(u: Usage, model: string, ttl: number): number {
  return u.input_tokens + u.output_tokens * 5 + u.cache_read_input_tokens * readRate(model) + u.cache_creation_input_tokens * writeRate(ttl)
}

// A poke over `context` cached tokens: the read, plus a short exchange.
export const pokeGuess = (context: number): Usage => ({ input_tokens: 40, output_tokens: 10, cache_read_input_tokens: context, cache_creation_input_tokens: 60 })

// 7.3k, 284k, 1.2M.
export function sized(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export function dollars(equiv: number, model: string): string {
  const price = inputPrice(model)
  if (price === null) return ''
  const usd = (equiv * price) / 1e6
  return usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`
}

// What one main-thread request's timing says about the cache, as Cache Keeper
// reads it: the gap since the last request, and the prompt's read/write split.
// Past 5.5 minutes a 5m cache has expired, so a mostly-read prompt proves 1h,
// and a mostly-written one means the cache went cold (under an hour: a 5m TTL,
// unless `isExempt`, the first request after a compaction or model switch).
// Small prompts say nothing.
export type Reading = { isCold: boolean; ttl: number | null }

export const GAP = 5.5 * minute

export function readTiming(gap: number, u: Usage, isExempt: boolean): Reading {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (total < 30_000 || gap < GAP) {
    return { isCold: false, ttl: null }
  }
  if (u.cache_read_input_tokens / total > 0.8) {
    return { isCold: false, ttl: TTL_1H }
  }
  if (u.cache_creation_input_tokens / total > 0.5 && !isExempt) {
    return { isCold: true, ttl: gap < TTL_1H ? TTL_5M : null }
  }
  return { isCold: false, ttl: null }
}

// A poke that wrote more than a tenth of what it read found the cache cold:
// the pokes are not keeping it warm.
export function pokeWasCold(u: Usage): boolean {
  return u.cache_creation_input_tokens > 0.1 * u.cache_read_input_tokens
}
