import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brew } from '../types'
import {
  clock,
  compactAt,
  DEFAULT_IDLE,
  DEFAULT_MESSAGE,
  DEFAULT_SIZE,
  DEFAULT_WALL_SIZE,
  defaultEvery,
  dollars,
  equivalents,
  nearlyFull,
  nextPokeAt,
  overLine,
  parseClock,
  parseDuration,
  pokeGuess,
  pokeWasCold,
  readTiming,
  readRate,
  sized,
  span,
  TTL_1H,
  TTL_5M,
  ttlByPlan,
  ttlFromCost,
  ttlFromEnv,
  wallAhead,
  WALL_PERCENT,
  writeRate,
} from './brew'
import type { Limit, Usage } from './brew'
import { blocking, DEFAULT_TIMER_WAKE, DEFAULT_WAKE, isNear, MARK, parseWake, wakeAfter } from './wake'
import type { Block } from './wake'

// The session's switch, kept by the host so a reload of the mod finds it.
const brew = atom({ plugin: 'caffeine-compact', key: 'brew' } as const, {
  isOn: false,
  until: 0,
  lastAt: 0,
  activeAt: 0,
  isAutoDeclined: false,
  isForever: false,
})

// A booked wake: when it fires, and what it waits out.
type Armed = { at: number; label: string; text: string }

// The booked wake as the store keeps it, so `--resume` finds it again.
type KeptWake = { session: string; at: number; label: string; text?: string }

type Caffeine = Brew & {
  // a main-thread turn is running; its own requests keep the cache warm
  isBusy: boolean
  // a poke submitted, then running in its own turn
  poke: 'none' | 'sent' | 'running'
  pokeTurnId: string
  sentAt: number
  pokes: number
  // what the pokes cost this session, in input-token equivalents
  spent: number
  lastPoke: Usage | null
  // whether the last poke found the cache still warm
  lastWarm: boolean | null
  limits: Limit[]
  context: number
  model: string
  // the TTL sources, in ttlOf's order: the person's override, the environment, a 1h cost
  // reading, request timing; else Claude Code's choice by plan
  ttl: number | null
  envTtl: number | null
  // only ever 1h (a 1.25x cost cannot tell 5m from 1h); cleared by a cache found cold
  // inside the hour, unless that request priced at 1h itself
  measuredTtl: number | null
  // the running turn's last request priced at 1h: its cold cache was a prefix change, not an expiry
  isPriced: boolean
  // what request timing says, for models caffeine has no price for
  timedTtl: number | null
  // what emptied the cache (compaction, /clear); pokes wait for the next request to rewrite it
  heldBy: string
  // the running poke was a first request (after a compaction or on another model),
  // so its write says nothing about the pokes before it
  isPokeExempt: boolean
  // the last time a request found the cache cold, and the gap before it
  coldAt: number
  coldGap: number
  // settings kept across sessions
  message: string
  every: number | null
  // the row above the prompt: auto shows it only when there is something to show
  band: 'auto' | 'on' | 'off'
  idle: number
  // turn on by itself once the context passes this many tokens; 0 is never
  autoAt: number
  // the band's message field is open
  isEditing: boolean
  bandId: string
  // compaction before the cache expires: on or off, the context size it starts at,
  // a compaction running, the cache epoch (lastAt) it was last tried for, and how many ran
  isCompacting: boolean
  // this session cannot call $.session.compact (headless/desktop): compact by running /compact
  compactAsPrompt: boolean
  // that /compact prompt is submitted and not finished yet
  compactSent: boolean
  compactSentAt: number
  // the /compact turn has started (the first turn after it was sent)
  compactTurn: boolean
  compactManual: boolean
  compactOn: boolean
  size: number
  // the size line for compacting ahead of a usage wall (a window past 95%, its reset beyond the cache's life)
  wallSize: number
  compactTried: number
  compacts: number
  // a resumed session's last reply, as the engine reported it before session.start; 0 for none
  resumedAt: number
  // session.start has run, so the saved state is read
  isStarted: boolean
  // the wake
  armed: Armed | null
  // the last reply failed on the usage limit
  isHit: boolean
  // the reset someone said "not now" to; the wake row stays down until it passes
  dismissed: number
  // caffeine was off when the wake was booked, and comes off with it
  isWakeLit: boolean
}

const MINUTE = 60_000
// `/caffeine warm` alone
const WARM = 60 * MINUTE

// env and settings first (Claude Code reads them before picking by plan, so a cost that
// contradicts them is a misread), then a 1h-priced request, then timing, then the plan
const ttlOf = (c: Caffeine) => c.ttl ?? c.envTtl ?? c.measuredTtl ?? c.timedTtl ?? ttlByPlan(c.limits)

// Where the TTL comes from, for /caffeine status.
function ttlSource(c: Caffeine): string {
  if (c.ttl !== null) return 'set with /caffeine ttl'
  if (c.envTtl !== null) return 'from the environment'
  if (c.measuredTtl !== null) return 'measured from what requests cost'
  if (c.timedTtl !== null) return 'measured from request timing'
  if (c.limits.length) return 'the subscription default'
  return c.lastAt ? 'the API-key default' : 'a guess until the first reply shows the plan'
}
const everyOf = (c: Caffeine) => c.every ?? defaultEvery(ttlOf(c))
const ttlLabel = (ms: number) => (ms >= TTL_1H ? '1h' : '5m')

// Every message lands in a kept log (/caffeine log). Only alerts (a failure, a keep-alive that
// ended, a finished compaction) toast in quiet mode; normal mode toasts everything.
const LOG_MAX = 300
let notifyMode: 'quiet' | 'normal' = 'quiet'
let logBuf: string[] = []

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function record($: EngineInterface, text: string): void {
  logBuf.push(`${stamp()} ${text}`)
  if (logBuf.length > LOG_MAX) logBuf = logBuf.slice(-LOG_MAX)
  void Promise.resolve($.store.set('log', logBuf)).catch(() => undefined)
}

function tell($: EngineInterface, text: string, isAlert = false): void {
  record($, text)
  if (isAlert || notifyMode === 'normal') {
    $.ui.toast(`caffeine: ${text}`)
    $.ui.log(`caffeine: ${text}`)
  }
}

// One $.model.fork over the main thread's cached prefix; the usage says whether the cache still held it.
async function forkProbe($: EngineInterface, c: Caffeine, label: string, since: string): Promise<boolean> {
  try {
    const r = await $.model.fork({ prompt: '只回一个字：好' })
    const u = r.isAnswered || 'usage' in r ? r.usage : null
    const usage = u ? `读缓存 ${sized(u.cache_read_input_tokens)}，写缓存 ${sized(u.cache_creation_input_tokens)}，未缓存输入 ${u.input_tokens}，输出 ${u.output_tokens}` : ''
    const head = r.isAnswered ? `回复「${r.text.trim().slice(0, 20)}」` : `没有回复：${r.reason}`
    tell($, `${label}（离上次请求 ${since}，上下文 ${sized(c.context)}）：${head}；${usage}`, true)
    // part of the prefix (system prompt, tools) is shared with other sessions, so any read proves
    // little: it counts as warm only when most of the input came from the cache
    return !!u && u.cache_read_input_tokens >= 0.8 * (u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens)
  } catch (err) {
    tell($, `${label}出错：${err instanceof Error ? err.message : String(err)}`, true)
    return false
  }
}

// forkexp: after the next reply, fork at 50 min (should refresh the entry) and at 65 min (hit only if it did)
let expState: 'off' | 'armed' | 'running' = 'off'
let expToken = 0
let expControl = false

async function setting<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  try {
    const value = await $.store.get(key)
    return value === undefined || value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

async function load($: EngineInterface, c: Caffeine): Promise<void> {
  c.message = await setting($, 'message', DEFAULT_MESSAGE)
  c.every = (await setting($, 'every', null)) as number | null
  c.idle = (await setting($, 'idle', DEFAULT_IDLE)) || DEFAULT_IDLE
  c.ttl = (await setting($, 'ttl', null)) as number | null
  c.autoAt = await setting($, 'autoAt', 0)
  c.compactOn = await setting($, 'compact', true)
  const savedMode = await setting<string | null>($, 'pokeMode', null)
  if (savedMode === 'fork' || savedMode === 'prompt') pokeMode = savedMode
  const savedNotify = await setting<string | null>($, 'notify', null)
  if (savedNotify === 'quiet' || savedNotify === 'normal') notifyMode = savedNotify
  logBuf = await setting<string[]>($, 'log', [])
  c.size = (await setting($, 'size', DEFAULT_SIZE)) || DEFAULT_SIZE
  c.wallSize = (await setting($, 'wallSize', DEFAULT_WALL_SIZE)) || DEFAULT_WALL_SIZE
  // merged settings, as Claude Code reads them; a failed read leaves the key unset
  let promptCacheTtl: unknown
  try {
    promptCacheTtl = (await $.settings.read()).promptCacheTtl
  } catch {
    promptCacheTtl = undefined
  }
  try {
    c.envTtl = ttlFromEnv(
      await $.env.get('FORCE_PROMPT_CACHING_5M'),
      await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      promptCacheTtl,
      await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    )
  } catch {
    c.envTtl = null
  }
}

async function keep($: EngineInterface, c: Caffeine): Promise<void> {
  const kept: Brew = { isOn: c.isOn, until: c.until, lastAt: c.lastAt, activeAt: c.activeAt, isAutoDeclined: c.isAutoDeclined, isForever: c.isForever }
  await update($, brew, () => kept).catch(() => undefined)
}

// How long caffeine stays on: to a set time, or until turned off.
function howLong(c: Caffeine, now: number): string {
  if (c.until) {
    return `until ${clock(c.until, now)} (${span(c.until - now)} left)`
  }
  return c.isForever || c.armed ? 'until you turn it off' : `until you turn it off (or ${span(c.idle).replace(' 00m', '')} idle)`
}

// What the compaction does while keep-alive is off, for the band and /caffeine status.
function standby(c: Caffeine, now: number): string {
  if (!c.compactOn) return ''
  if (c.isCompacting) return ' · 正在压缩…'
  if (c.lastAt === 0) return ' · 压缩待命'
  if (c.context < c.size) return ` · 压缩待命（上下文 ${sized(c.context)}，到 ${sized(c.size)} 才自动压缩）`
  const at = compactAt(c.lastAt, ttlOf(c))!
  if (c.compactTried === c.lastAt || now >= c.lastAt + ttlOf(c)) return ' · cache 已过期，不压缩'
  return ` · ${clock(at, now)} 自动压缩（${span(Math.max(0, at - now))}后）`
}

// One line for the band, the status line and /caffeine status.
function describe(c: Caffeine, now: number): { text: string; color?: string; isDim?: boolean } {
  if (!c.isOn) {
    return { text: `caffeine off${standby(c, now)}`, isDim: true }
  }
  const tail = [c.pokes ? `${c.pokes} poke${c.pokes === 1 ? '' : 's'}` : '', howLong(c, now)]
    .filter(Boolean)
    .map(t => ` · ${t}`)
    .join('')
  const over = overLine(c.limits)
  if (over) {
    return { text: `caffeine paused · ${over.label} limit ${over.percent}%${tail}`, color: 'yellow' }
  }
  if (c.lastAt === 0) {
    const why = c.heldBy ? `waits for your next message after the ${c.heldBy}` : 'waits for the first reply'
    return { text: `caffeine on · ${why}${tail}`, color: 'green' }
  }
  if (c.isBusy || c.poke !== 'none') {
    return { text: `caffeine on · cache warm${tail}`, color: 'green' }
  }
  if (now - c.lastAt >= ttlOf(c)) {
    return { text: `caffeine on · cache went cold, waits for your next turn${tail}`, color: 'yellow' }
  }
  const at = nextPokeAt(c.lastAt, everyOf(c))!
  return { text: `caffeine on · poke at ${clock(at, now)} (in ${span(at - now)})${tail}`, color: 'green' }
}

async function costNow($: EngineInterface): Promise<number | null> {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return typeof usd === 'number' ? usd : null
  } catch {
    return null
  }
}

// How long the cache has left, for the band; '' before the first reply.
function cacheLeft(c: Caffeine, now: number): { text: string; color: string } | null {
  if (!c.lastAt) return null
  const left = c.lastAt + ttlOf(c) - now
  if (left <= 0) return { text: 'cache 已凉', color: 'blue' }
  return { text: `cache 剩 ${span(left)}`, color: left > ttlOf(c) / 2 ? 'green' : left > ttlOf(c) / 5 ? 'yellow' : 'red' }
}

// Auto: the row shows while keep-alive is on, a compaction is running or due within 10 minutes,
// or the message is being edited; otherwise it steps aside.
function showBand(c: Caffeine, now: number): boolean {
  if (c.band !== 'auto') return c.band === 'on'
  if (c.isOn || c.isCompacting || c.isEditing) return true
  if (!c.compactOn || c.lastAt === 0 || c.context < c.size || c.compactTried === c.lastAt) return false
  const at = compactAt(c.lastAt, ttlOf(c))!
  return now >= at - 10 * MINUTE && now < c.lastAt + ttlOf(c)
}

async function refresh($: EngineInterface, c: Caffeine): Promise<void> {
  const now = await $.clock.now()
  if (showBand(c, now) || !c.isOn) {
    $.ui.status(undefined)
  } else {
    const w = cacheLeft(c, now)
    $.ui.status(`${w ? `${w.text} · ` : ''}${describe(c, now).text}`)
  }
  $.ui.invalidate('ui.render')
}

async function switchOn($: EngineInterface, c: Caffeine, isOn: boolean, until = 0): Promise<void> {
  c.isOn = isOn
  c.until = isOn ? until : 0
  c.isWakeLit = false
  c.isForever = false
  if (isOn) {
    c.activeAt = await $.clock.now()
  } else if (c.poke === 'sent') {
    c.poke = 'none'
  }
  await keep($, c)
  await refresh($, c)
}

// Sends the poke. fork (default): one request over the main thread's cached prefix that never enters
// the transcript, so the context does not grow. prompt: a message of its own, run once the session is idle.
let pokeMode: 'fork' | 'prompt' = 'fork'

function pokeByPrompt($: EngineInterface, c: Caffeine, now: number): void {
  c.poke = 'sent'
  c.sentAt = now
  record($, `保活 poke（上下文 ${sized(c.context)}）`)
  void $.prompt.submit({ text: c.message }).catch(() => {
    c.poke = 'none'
  })
}

function poke($: EngineInterface, c: Caffeine, now: number): void {
  if (pokeMode === 'prompt') {
    pokeByPrompt($, c, now)
    return
  }
  c.poke = 'sent'
  c.sentAt = now
  void $.model
    .fork({ prompt: '只回一个字：好' })
    .then(async r => {
      if (!r.isAnswered) {
        // nothing to fork, an API error or an abort: no warm cache was proven, send a poke the old way
        record($, `fork 保活没成（${r.reason}），改发 poke 消息`)
        pokeByPrompt($, c, now)
        return
      }
      const u = r.usage
      const at = await $.clock.now()
      c.poke = 'none'
      c.pokes += 1
      c.lastPoke = u
      c.spent += equivalents(u, c.model, ttlOf(c))
      const total = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
      if (u.cache_read_input_tokens >= 0.8 * total) {
        c.lastWarm = true
        c.lastAt = at
        record($, `fork 保活（读缓存 ${sized(u.cache_read_input_tokens)}，写 ${sized(u.cache_creation_input_tokens)}）`)
      } else {
        c.lastWarm = false
        await switchOn($, c, false)
        tell($, `保活已关闭：fork 发现缓存已经冷了（读 ${sized(u.cache_read_input_tokens)}，要重新计费 ${sized(u.cache_creation_input_tokens + u.input_tokens)}），之前的保活没有守住它。`, true)
      }
      await refresh($, c)
    })
    .catch(() => {
      record($, 'fork 保活出错，改发 poke 消息')
      pokeByPrompt($, c, now)
    })
}

const KEEP_NOTE = '摘要开头先说明这一点。保留未完成的任务、决定及其理由、带日期的待办、改过的文件路径，以及用户要求记住的内容。'
const COMPACT_NOTE = (at: string, idleMin: number) =>
  `这次压缩是自动的：${at}，离开 ${idleMin} 分钟后、prompt cache 过期前触发。${KEEP_NOTE}`
const WALL_NOTE = (at: string, wall: string) => `这次压缩是自动的：${at}，${wall}，趁 prompt cache 还热先压缩。${KEEP_NOTE}`

// "5h 用量 96%，Sat 03:00 重置"
function wallText(w: { label: string; percent: number; resetsAt: number | null }, now: number): string {
  return `${w.label} 用量已到 ${w.percent}%${w.resetsAt === null ? '' : `，${clock(w.resetsAt, now)} 才重置`}`
}

// Compacts while the cache is still warm, so the summary pass reads it instead of writing it.
// Where the host has no $.session.compact (the desktop app, -p, the SDK), it submits a /compact
// command instead (a prompt may not begin with /); that runs as a turn of its own and ends with the session.compact event.
function compactNow($: EngineInterface, c: Caffeine, now: number, isManual = false, wall = ''): void {
  c.compactTried = c.lastAt
  c.isCompacting = true
  c.compactManual = isManual
  const idleMin = c.lastAt ? Math.round((now - c.lastAt) / MINUTE) : 0
  const instructions = isManual
    ? '这次压缩是用户用 /caffeine compact now 手动触发的。保留未完成的任务、决定及其理由、改过的文件路径，以及用户要求记住的内容。'
    : wall
      ? WALL_NOTE(clock(now, now), wall)
      : COMPACT_NOTE(clock(now, now), idleMin)
  const what = isManual ? '手动压缩' : wall ? '提前压缩' : '自动压缩'
  record($, `${what}开始（上下文 ${sized(c.context)}，离上次请求 ${idleMin} 分钟${wall ? `；${wall}` : ''}）`)
  const failed = (err: unknown) => {
    tell($, `${what}失败：${err instanceof Error ? err.message : String(err)}`, true)
    c.isCompacting = false
    c.compactSent = false
    void refresh($, c)
  }
  const asPrompt = () => {
    c.compactSent = true
    c.compactTurn = false
    c.compactSentAt = now
    void refresh($, c)
    void $.command.run({ command: 'compact', args: instructions }).catch(failed)
  }
  if (c.compactAsPrompt) {
    asPrompt()
    return
  }
  void $.session
    .compact({ instructions })
    .then(result => {
      if (result.messages === undefined) {
        // vetoed (a PreCompact hook, or no compaction in this session): fall back or say why
        const why = 'skip' in result && typeof result.skip === 'string' ? result.skip : '压缩被跳过'
        if (/headless|not available/i.test(why)) {
          c.compactAsPrompt = true
          asPrompt()
        } else {
          failed(new Error(why))
        }
        return
      }
      c.compacts += 1
      const before = result.tokensBefore ?? c.context
      const after = result.tokensAfter === undefined ? '' : ` → 摘要 ${sized(result.tokensAfter)}`
      tell($, `${what}完成（${sized(before)} tokens${after}）。`, true)
      c.isCompacting = false
      void refresh($, c)
    })
    .catch((err: unknown) => {
      if (/headless|not available/i.test(err instanceof Error ? err.message : String(err))) {
        c.compactAsPrompt = true
        asPrompt()
        return
      }
      failed(err)
    })
}

async function tick($: EngineInterface, c: Caffeine): Promise<void> {
  const now = await $.clock.now()
  if (c.armed && now >= c.armed.at) {
    await fire($, c, c.armed)
  }
  if (c.compactSent && now - c.compactSentAt > 15 * MINUTE) {
    c.compactSent = false
    c.isCompacting = false
    tell($, '压缩提示 15 分钟内没有执行，已放弃这次。', true)
  }
  // a usage wall ahead (a window past 95%, its reset beyond the cache's life): the cache dies before
  // work can resume, so shrink a big context now while it is warm, keep-alive on or off
  const wall = wallAhead(c.limits, c.lastAt + ttlOf(c))
  if (
    wall && c.compactOn && c.lastAt !== 0 && now < c.lastAt + ttlOf(c) && c.context >= c.wallSize &&
    c.compactTried !== c.lastAt && !c.isCompacting && !c.isBusy && c.poke === 'none'
  ) {
    compactNow($, c, now, false, wallText(wall, now))
    return
  }
  if (!c.isOn) {
    // keep-alive is off: past the size line, compact shortly before the cache expires
    const ttl = ttlOf(c)
    const at = compactAt(c.lastAt, ttl)
    if (
      c.compactOn && at !== null && now >= at && now < c.lastAt + ttl &&
      c.compactTried !== c.lastAt && !c.isCompacting && !c.isBusy && c.poke === 'none' && !c.armed &&
      c.context >= c.size && !nearlyFull(c.limits)
    ) {
      compactNow($, c, now)
    }
    return
  }
  // keep-alive ends (a set time, or the hold after your last message): compaction takes over,
  // and compacts shortly before the warm cache would expire
  const handOver = c.compactOn && c.context >= c.size ? '，之后在 cache 过期前自动压缩' : ''
  if (c.until && now >= c.until) {
    const wasWake = c.isWakeLit
    await switchOn($, c, false)
    if (!wasWake) tell($, `保活到时间了，已关闭${handOver}。`, true)
    return
  }
  if (!c.isForever && !c.armed && now - c.activeAt >= c.idle) {
    await switchOn($, c, false)
    tell($, `${span(c.idle)} 内你没有发过新消息，保活已关闭${handOver}。`, true)
    return
  }
  if (c.poke !== 'none') {
    // a poke that never got its turn (a dialog, a closed prompt) stops blocking the rest
    if (c.poke === 'sent' && now - c.sentAt > 10 * MINUTE) c.poke = 'none'
    return
  }
  // a poke into a cold cache would only write it again; you turned it on, so it pokes whatever the size
  if (c.isBusy || c.isCompacting || c.lastAt === 0 || overLine(c.limits) || now - c.lastAt >= ttlOf(c)) {
    return
  }
  const due = nextPokeAt(c.lastAt, everyOf(c))
  if (due !== null && now >= due) {
    poke($, c, now)
  }
}

async function setMessage($: EngineInterface, c: Caffeine, text: string): Promise<string> {
  c.message = text.trim() || DEFAULT_MESSAGE
  c.isEditing = false
  await $.store.set('message', c.message)
  await refresh($, c)
  return c.message
}

async function editInBand($: EngineInterface, c: Caffeine): Promise<void> {
  c.isEditing = true
  $.ui.invalidate('ui.render')
  if (c.bandId) {
    await $.ui.focus({ requestId: c.bandId, key: 'caffeine-message' }).catch(() => undefined)
  }
}

// What the pokes cost against one cache rewrite.
function costLines(c: Caffeine): string[] {
  const ttl = ttlOf(c)
  const model = c.model
  if (!model || c.context === 0) {
    return ['No reply yet this session: the cost comes with the first one.']
  }
  const poked = c.lastPoke ?? pokeGuess(c.context)
  const each = equivalents(poked, model, ttl)
  const rewrite = c.context * writeRate(ttl)
  const ratio = rewrite / each
  const usd = (n: number) => {
    const d = dollars(n, model)
    return d ? `, ${d}` : ''
  }
  return [
    `Context ${sized(c.context)} tokens on ${model}, ${ttlLabel(ttl)} cache, a poke ${span(everyOf(c))} after the last request.`,
    `One poke: ${sized(each)} input-token equivalents${usd(each)}${c.lastPoke ? ' (the last one, measured)' : ` (cache read at ${readRate(model)}x)`}.`,
    `One cache rewrite: ${sized(rewrite)} (written again at ${writeRate(ttl)}x)${usd(rewrite)}.`,
    `A rewrite costs about ${Math.round(ratio)} pokes: caffeine pays off if you are back within ${span(ratio * everyOf(c))}.`,
    c.pokes ? `This session: ${c.pokes} poke${c.pokes === 1 ? '' : 's'}, ${sized(c.spent)}${usd(c.spent)}.` : '',
    'At API list prices; on a Pro or Max plan the same tokens count against your usage limits instead.',
  ].filter(Boolean)
}

// The wake: caffeine's own timer submits the wake prompt at a set time (once
// the session is idle), like a poke. Stored under the session id, so
// `--resume` picks it up again.

async function arm($: EngineInterface, c: Caffeine, at: number, label: string, text = ''): Promise<void> {
  await disarm($, c)
  c.armed = { at, label, text }
  const kept: KeptWake = { session: await sessionKey($), at, label, text }
  await $.store.set('wake', kept).catch(() => undefined)
  // the cache stays warm until Claude picks the work back up
  if (!c.isOn) {
    await switchOn($, c, true, at)
    c.isWakeLit = true
  }
  const now = await $.clock.now()
  tell($, `Claude continues at ${clock(at, now)} (in ${span(at - now)})${label ? `, after the ${label} reset` : ''}, told: ${await wakeText($, c.armed)}. Keep this session open.`)
  $.ui.invalidate('ui.render')
}

async function disarm($: EngineInterface, c: Caffeine): Promise<boolean> {
  const armed = c.armed
  c.armed = null
  await $.store.delete('wake').catch(() => undefined)
  if (c.isWakeLit) {
    await switchOn($, c, false)
  }
  $.ui.invalidate('ui.render')
  return armed !== null
}

// The session's id, which a kept wake belongs to; '' where there is none.
async function sessionKey($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

// What Claude is told: the wake's own text, else the set wake prompt, else the
// default for its kind (after a limit reset, or at a time).
async function wakeText($: EngineInterface, armed: Armed): Promise<string> {
  const mine = (await setting($, 'wakePrompt', null)) as string | null
  return armed.text || mine || (armed.label ? DEFAULT_WAKE : DEFAULT_TIMER_WAKE)
}

// Sends the wake prompt: the wake is spent.
async function fire($: EngineInterface, c: Caffeine, armed: Armed): Promise<void> {
  c.armed = null
  c.isHit = false
  await $.store.delete('wake').catch(() => undefined)
  $.ui.invalidate('ui.render')
  const prompt = `${MARK} ${await wakeText($, armed)}`
  void $.prompt.submit({ text: prompt }).catch(() => undefined)
}

// After `--resume` or a mod reload, take back this session's wake if still ahead.
async function adopt($: EngineInterface, c: Caffeine): Promise<void> {
  try {
    const kept = (await $.store.get('wake')) as KeptWake | null | undefined
    if (!kept || c.armed || kept.session !== (await sessionKey($))) {
      return
    }
    if (kept.at > (await $.clock.now())) {
      c.armed = { at: kept.at, label: kept.label, text: kept.text ?? '' }
      $.ui.invalidate('ui.render')
    } else {
      await $.store.delete('wake')
    }
  } catch {
    // nothing kept; nothing booked
  }
}

// Books the wake at the reset of the window in the way.
async function armAtReset($: EngineInterface, c: Caffeine): Promise<void> {
  const block = blocking(c.limits)
  if (!block) {
    tell($, 'no reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.')
    return
  }
  await arm($, c, wakeAfter(block.resetsAt), block.label)
}

const NO_RESET = 'No reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.'

async function wakeCommand($: EngineInterface, c: Caffeine, args: string): Promise<{ text: string }> {
  const [word = '', ...rest] = args.split(/\s+/)
  const arg = word.toLowerCase()
  const value = rest.join(' ').trim()
  const now = await $.clock.now()
  const flip = async (key: string, name: string, fallback: boolean) => {
    const v = value.toLowerCase()
    const next = v === 'on' ? true : v === 'off' ? false : !(await setting($, key, fallback))
    await $.store.set(key, next)
    return { text: `${name} ${next ? 'on' : 'off'}.` }
  }
  switch (arg) {
    case '': {
      if (!blocking(c.limits)) return { text: NO_RESET }
      $.clock.after(50, () => void armAtReset($, c))
      return { text: 'Booking the wake…' }
    }
    case 'off':
    case 'cancel':
      $.clock.after(50, () => void disarm($, c).then(was => tell($, was ? 'wake cancelled.' : 'no wake was booked.')))
      return { text: 'Cancelling the wake…' }
    case 'prompt': {
      if (value.toLowerCase() === 'default') {
        await $.store.delete('wakePrompt')
        return { text: `Back to the defaults: "${DEFAULT_WAKE}" after a limit reset, "${DEFAULT_TIMER_WAKE}" at a time.` }
      }
      if (!value) {
        const mine = (await setting($, 'wakePrompt', null)) as string | null
        return {
          text: mine
            ? `On waking Claude is told: ${mine} (prompt default goes back to the defaults)`
            : `On waking Claude is told "${DEFAULT_WAKE}" after a limit reset, "${DEFAULT_TIMER_WAKE}" at a time.`,
        }
      }
      await $.store.set('wakePrompt', value)
      return { text: `On waking Claude will be told: ${value}${c.armed ? ' (from the next wake you book)' : ''}` }
    }
    case 'auto':
      return flip('wakeAuto', 'Booking a wake whenever the limit hits:', false)
    default: {
      const wake = parseWake(args, now)
      if (wake === null) return { text: `Not a time I know: ${args}. Try 1 min, in 20 minutes, 14:30 or 3pm.` }
      const { at, text } = wake
      $.clock.after(50, () => void arm($, c, at, '', text))
      return { text: `Booking the wake for ${clock(at, now)} (in ${span(at - now)})${text ? `, to say: ${text}` : ''}…` }
    }
  }
}

const FOREVER = 'Yes, no end'
const KEEP_STOP = 'Keep the idle stop'

// No end, but only once confirmed: the dialog spells out the cost; with no one
// to ask, a trailing "yes" confirms.
async function forever($: EngineInterface, c: Caffeine, isSure: boolean): Promise<{ text: string }> {
  const perDay = Math.round((24 * 60 * MINUTE) / everyOf(c))
  if (!isSure) {
    let answer: string
    try {
      answer = await $.ui.ask(
        `Keep the cache warm with no end this time? Caffeine pokes ${span(everyOf(c))} after the last request until you turn it off: about ${perDay} pokes a day while you are away, each using your plan's usage. Turning it off brings the idle stop back.`,
        { header: 'caffeine', options: [FOREVER, KEEP_STOP] },
      )
    } catch {
      return { text: 'No one to ask here. /caffeine forever yes confirms it.' }
    }
    if (answer !== FOREVER) {
      return { text: `Kept: caffeine still turns itself off after ${span(c.idle)} without a turn of your own.` }
    }
  }
  if (!c.isOn || c.until) {
    await switchOn($, c, true)
  }
  c.isForever = true
  await keep($, c)
  await refresh($, c)
  return { text: `Caffeine on with no end, until you turn it off. Next time you turn it on, the ${span(c.idle)} idle stop is back.` }
}

const help = [
  'caffeine-compact：保活 + 自动压缩。命令都是 /caffeine …',
  '',
  '【离开前 / 回来后】',
  '/caffeine                开或关保活（开着时每 55 分钟读一次缓存续命）',
  '/caffeine on | off        同上，明确指定',
  '/caffeine warm 2h         保活 2 小时，到点关（90m、1h30m 也行；不写时长默认 1h）',
  '/caffeine until 18:00     保活到 18:00（6pm 也行）',
  '/caffeine idle 8h         从你最后一条消息算起，这么久没发新消息就关保活（默认 24h）',
  '/caffeine forever         这次保活不设终点，会先让你确认（idle off 同效）；关掉后恢复 idle 终点',
  '',
  '【自动压缩】',
  '/caffeine compact on|off  自动压缩开关（默认开）',
  '/caffeine compact now     立刻压缩一次，用来测试；结果或失败原因以提示显示',
  '/caffeine size 180k       大小线：没开保活时，上下文到这个值以上才会在 cache 过期前（最后一次请求后 55 分钟）压缩（default 恢复 200k）',
  '/caffeine limitsize 220k  限额前提前压缩的大小线：5h 或周用量到 95% 且重置晚于 cache 过期时，上下文到这个值以上就立刻压缩（default 恢复 220k）',
  '',
  '【保活怎么做】',
  '/caffeine mode fork|prompt  fork（默认）：后台读缓存续命，对话里没有 poke 消息；prompt：发一条 poke 消息',
  '/caffeine poke            现在就戳一次',
  '/caffeine message …       poke 说的话（不带内容：看当前；reset：恢复默认）。只在 prompt 模式用',
  '/caffeine every 10m       上次请求后多久戳一次（不带时长：恢复自动）',
  '/caffeine ttl 1h|5m       固定 cache 寿命（auto：恢复自动检测）',
  '/caffeine auto 100k       上下文超过 100k 自动开保活（off：不自动开）',
  '/caffeine cost            戳一次的花费和重写一次 cache 的花费对比',
  '',
  '【用量限额后自动唤醒】',
  '/caffeine wake            用量限额重置后，唤醒 Claude 接着干',
  '/caffeine wake 14:30      在指定时间唤醒（也可 20 min、2 hours、3pm；wake off 取消）',
  '/caffeine wake auto on|off  限额撞到时自动排唤醒',
  '/caffeine wake prompt …   唤醒时对 Claude 说的话（wake prompt default 恢复默认）',
  '',
  '【看状态 / 提示】',
  '/caffeine status          当前状态：保活、压缩计划、用量、已压缩次数',
  '/caffeine log [n]         最近 n 条事件日志（默认 30）；log clear 清空。重启后还在，最多 300 条',
  '/caffeine notify quiet|normal  弹窗多少：quiet（默认）只弹失败、压缩完成、保活结束；normal 全弹。日志不受影响',
  '/caffeine band auto|on|off  输入框上方那一行：auto 有事才显示，on 一直显示，off 不显示',
  '',
  '【诊断】',
  '/caffeine forktest        测一次 fork 能不能读到缓存，结果弹出并写进日志',
  '/caffeine forkexp [control|cancel]  1 小时对比实验：验证 fork 能不能续命（先 control，再不带参数；中途别发消息）',
].join('\n')

// A resumed session (the process came back, or you reopened it) starts with no memory of its last
// request. The engine says how long ago the last reply was; the cache stays warm for the rest of its
// TTL. Claude Code sends that before session.start, so it waits in c.resumedAt until the saved state is read.
async function adoptResume($: EngineInterface, c: Caffeine): Promise<void> {
  if (!c.resumedAt || c.resumedAt <= c.lastAt) return
  c.lastAt = c.resumedAt
  c.resumedAt = 0
  c.heldBy = ''
  await keep($, c)
  await refresh($, c)
}

async function hold($: EngineInterface, c: Caffeine, by: string): Promise<void> {
  c.lastAt = 0
  c.heldBy = by
  await keep($, c)
  await refresh($, c)
}

export const register: Register = (on, options) => {
  const bandOption = options?.band
  if (options?.notify === 'normal' || options?.notify === 'quiet') notifyMode = options.notify
  const c: Caffeine = {
    isOn: false,
    until: 0,
    lastAt: 0,
    activeAt: 0,
    isAutoDeclined: false,
    isForever: false,
    isBusy: false,
    poke: 'none',
    pokeTurnId: '',
    sentAt: 0,
    pokes: 0,
    spent: 0,
    lastPoke: null,
    lastWarm: null,
    limits: [],
    context: 0,
    model: '',
    ttl: null,
    envTtl: null,
    measuredTtl: null,
    isPriced: false,
    timedTtl: null,
    heldBy: '',
    isPokeExempt: false,
    coldAt: 0,
    coldGap: 0,
    message: DEFAULT_MESSAGE,
    every: null,
    band: bandOption === 'on' || bandOption === 'off' ? bandOption : 'auto',
    idle: DEFAULT_IDLE,
    autoAt: 0,
    isEditing: false,
    bandId: '',
    armed: null,
    isHit: false,
    dismissed: 0,
    isWakeLit: false,
    isCompacting: false,
    compactAsPrompt: false,
    compactSent: false,
    compactSentAt: 0,
    compactTurn: false,
    compactManual: false,
    compactOn: true,
    size: DEFAULT_SIZE,
    wallSize: DEFAULT_WALL_SIZE,
    compactTried: 0,
    compacts: 0,
    resumedAt: 0,
    isStarted: false,
  }

  on('classic.SessionStart', async ($, e, next) => {
    const gap = e.seconds_since_last_response
    if ((e.source === 'resume' || e.source === 'fork') && typeof gap === 'number' && e.prompt_cache_likely_expired !== true) {
      c.resumedAt = (await $.clock.now()) - gap * 1000
      if (c.isStarted) await adoptResume($, c)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'caffeine',
      description: 'Keep the prompt cache warm while you step away, and wake Claude when the usage limit resets',
      argumentHint: '[on|off|status|warm|until|wake|ttl|every|idle|auto|cost|poke|message|band|compact|size|limitsize|mode|notify|log|forever|help]',
    })
    const started = await next(e)
    await load($, c)
    try {
      Object.assign(c, await read($, brew))
    } catch {
      // a fresh session: off
    }
    try {
      const usage = await $.session.usage()
      c.limits = [...usage.rateLimits]
      c.context = usage.context?.tokens ?? c.context
    } catch {
      // the first reply brings them
    }
    c.isStarted = true
    await adoptResume($, c)
    $.clock.after(50, () => void adopt($, c))
    $.clock.every(5_000, () => void tick($, c))
    // the countdowns
    $.clock.every(30_000, () => {
      if (c.isOn || c.armed || c.compactOn || isNear(c.limits) || c.lastAt) void refresh($, c)
    })
    await refresh($, c)
    return started
  })

  on('session.measure', async ($, e, next) => {
    const wasNear = isNear(c.limits)
    c.limits = [...e.rateLimits]
    c.context = e.context?.tokens ?? c.context
    if (c.autoAt && !c.isOn && !c.isAutoDeclined && c.context >= c.autoAt) {
      await switchOn($, c, true)
      tell($, `on: the context passed ${sized(c.autoAt)} tokens. /caffeine off turns it off for this session.`)
    }
    const block = blocking(c.limits)
    if (block && block.percent >= 100 && !c.armed && (await setting($, 'wakeAuto', false))) {
      await armAtReset($, c)
    } else if (!wasNear && isNear(c.limits) && block) {
      $.ui.toast(`caffeine: ${block.label} limit at ${block.percent}%, resets ${clock(block.resetsAt, await $.clock.now())}. /caffeine wake books a wake.`)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') {
      c.isHit = true
      if (!c.armed && (await setting($, 'wakeAuto', false))) {
        await armAtReset($, c)
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Each main-thread request reads the cache and restarts its TTL. Its cost can
  // prove a 1h write; a cache found cold inside the believed TTL takes that
  // back, unless the rewrite priced at 1h itself: then the prefix changed (a
  // tool list, an MCP reconnect, a resume), the cache did not expire.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    const at = await $.clock.now()
    const gap = c.lastAt ? at - c.lastAt : 0
    const believed = ttlOf(c)
    // a first request (lastAt is 0 after a compaction or /clear) or another model
    // writes the cache whatever the TTL
    const isExempt = c.lastAt === 0 || (c.model !== '' && c.model !== e.model)
    if (isExempt && c.poke === 'running') c.isPokeExempt = true
    c.model = e.model
    c.lastAt = at
    c.heldBy = ''
    void keep($, c)
    const before = await costNow($)
    const result = yield* next(e)
    const after = await costNow($)
    if (result.usage) {
      const priced = before !== null && after !== null ? ttlFromCost(after - before, result.usage, result.usage.model || e.model) : null
      c.isPriced = priced !== null
      if (priced !== null) c.measuredTtl = priced
      const timing = readTiming(gap, result.usage, isExempt)
      // a rewrite priced at 1h was no expiry, so it says nothing about a 5m TTL
      if (timing.ttl !== null && !(timing.isCold && priced !== null)) c.timedTtl = timing.ttl
      if (timing.isCold) {
        c.coldAt = at
        c.coldGap = gap
        // cold inside the believed TTL with no 1h reading of its own: an earlier 1h reading was wrong
        if (gap < believed && priced === null) c.measuredTtl = null
        if (c.isOn && c.poke !== 'running') {
          tell($, `the cache had gone cold after ${span(gap)} idle; this request wrote it again.`)
        }
      }
      if (priced !== null || timing.ttl !== null || timing.isCold) void refresh($, c)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    c.isBusy = true
    if (c.compactSent && !c.compactTurn) {
      // caffeine's own /compact turn is no turn of yours: the keep-alive hold keeps running
      c.compactTurn = true
    } else if (c.poke === 'sent' && e.text.includes(c.message)) {
      c.poke = 'running'
      c.pokeTurnId = e.turnId
      c.isPokeExempt = false
    } else {
      c.activeAt = await $.clock.now()
      if (expState === 'running') {
        expState = 'off'
        expToken += 1
        tell($, 'fork 实验被你的新消息打断，作废。重新 /caffeine forkexp。', true)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      c.isBusy = false
      if (expState === 'armed' && c.poke === 'none' && !c.compactSent) {
        expState = 'running'
        const token = ++expToken
        const group = expControl ? '对照' : '实验'
        tell($, expControl ? 'fork 对照开始计时：中间不续命，65 分钟时 fork 一次。' : 'fork 实验开始计时：50 分钟后 fork 续命，65 分钟后再 fork 验证。')
        if (!expControl) {
          $.clock.after(50 * MINUTE, () => {
            if (token === expToken) void forkProbe($, c, 'fork 实验 50 分钟（续命）', '50 分钟')
          })
        }
        $.clock.after(65 * MINUTE, () => {
          if (token !== expToken) return
          void forkProbe($, c, `fork ${group} 65 分钟（验证）`, '65 分钟').then(hit => {
            expState = 'off'
            tell($, `${group}结果：65 分钟时缓存${hit ? '仍命中' : '已冷'}。`, true)
          })
        })
      }
      if (c.compactSent) {
        c.compactSent = false
        if (c.isCompacting) {
          c.isCompacting = false
          tell($, `${c.compactManual ? '手动' : '自动'}压缩没有执行（对话没有变短）。`, true)
        }
      }
      if (c.poke === 'running' && e.turnId === c.pokeTurnId) {
        c.poke = 'none'
        c.pokes += 1
        if (e.usage) {
          c.lastPoke = e.usage
          c.spent += equivalents(e.usage, e.usage.model || c.model, ttlOf(c))
        }
        const isExempt = c.isPokeExempt
        c.isPokeExempt = false
        // a poke that had to write the cache anyway says nothing about the pokes before it
        if (e.usage && !isExempt && pokeWasCold(e.usage)) {
          c.lastWarm = false
          // a poke inside the TTL found it cold: not 1h, unless the poke's own cost says so
          if (!c.isPriced) c.measuredTtl = null
          await switchOn($, c, false)
          tell(
            $,
            `turned off: its poke found the cache cold (rewrote ${sized(e.usage.cache_creation_input_tokens)} tokens), so pokes were not keeping it warm. /caffeine status may say why; turn it on again to retry.`,
            true,
          )
        } else if (e.usage && !isExempt) {
          c.lastWarm = true
        }
      }
      await keep($, c)
      await refresh($, c)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') {
      c.isHit = false
    }
    return next(e)
  })

  // A compaction or /clear empties the cache: no pokes until the person's next
  // request (or the turn carrying on) writes it again.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in done && done.skip)) {
      await hold($, c, 'compaction')
      if (c.isCompacting && c.compactSent) {
        c.compacts += 1
        c.isCompacting = false
        c.compactSent = false
        tell($, `${c.compactManual ? '手动' : 'cache 过期前自动'}压缩完成。`, true)
        void refresh($, c)
      }
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await hold($, c, '/clear')
    return next(e)
  })

  on('command.run', { command: 'caffeine' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const arg = word.toLowerCase()
    const value = rest.join(' ').trim()
    const now = await $.clock.now()
    switch (arg) {
      case 'help':
        return { text: help }
      case '':
        if (c.isOn) c.isAutoDeclined = true
        await switchOn($, c, !c.isOn)
        return { text: c.isOn ? `Caffeine on: ${describe(c, now).text.replace(/^caffeine on · /, '')}.` : 'Caffeine off.' }
      case 'on':
        await switchOn($, c, true)
        return { text: `Caffeine on until you turn it off, poking ${span(everyOf(c))} after the last request (${ttlLabel(ttlOf(c))} cache).` }
      case 'off':
        c.isAutoDeclined = true
        await switchOn($, c, false)
        return { text: 'Caffeine off.' }
      case 'for':
      case 'warm': {
        const ms = value ? parseDuration(value) : WARM
        if (ms === null) return { text: `Not a duration I know: ${value}. Try 2h, 90m or 1h30m.` }
        await switchOn($, c, true, now + ms)
        return { text: `Caffeine on, keeping the cache warm until ${clock(now + ms, now)}.` }
      }
      case 'until': {
        const at = parseClock(value, now)
        if (at === null) return { text: `Not a time I know: ${value || '(none)'}. Try 18:00 or 6pm.` }
        await switchOn($, c, true, at)
        return { text: `Caffeine on, keeping the cache warm until ${clock(at, now)}.` }
      }
      case 'poke':
        if (c.poke !== 'none') return { text: 'A poke is already on its way.' }
        // a prompt submitted from inside this command would wait on the turn it holds
        $.clock.after(50, () => void $.clock.now().then(t => poke($, c, t)))
        return { text: `Poking: ${c.message}` }
      case 'message':
      case 'say': {
        if (!value) return { text: `The poke says: ${c.message}` }
        const saved = await setMessage($, c, value.toLowerCase() === 'reset' ? '' : value)
        return { text: `The poke now says: ${saved}` }
      }
      case 'auto': {
        const v = value.toLowerCase()
        if (!v) return { text: c.autoAt ? `Caffeine turns on by itself past ${sized(c.autoAt)} tokens of context.` : 'Auto is off. /caffeine auto 100k turns it on.' }
        const n = v === 'off' ? 0 : v === 'on' ? 100_000 : /^(\d+(?:\.\d+)?)(k|m)?$/.test(v) ? Math.round(Number.parseFloat(v) * (v.endsWith('m') ? 1e6 : v.endsWith('k') ? 1e3 : 1)) : null
        if (n === null || (n > 0 && n < 1000)) return { text: `Not a token count I know: ${value}. Try 100k, or off.` }
        c.autoAt = n
        await $.store.set('autoAt', n)
        return { text: n ? `Caffeine turns on by itself once the context passes ${sized(n)} tokens (now ${sized(c.context)}).` : 'Auto off.' }
      }
      case 'compact': {
        const v = value.toLowerCase()
        if (v === 'now') {
          if (c.isCompacting) return { text: '正在压缩，稍等。' }
          // a compaction started from inside this command would wait on the turn it holds
          $.clock.after(50, () => void $.clock.now().then(t => compactNow($, c, t, true)))
          return { text: '开始压缩，结果稍后以提示显示（成功或失败原因）。' }
        }
        c.compactOn = v === 'on' ? true : v === 'off' ? false : !c.compactOn
        await $.store.set('compact', c.compactOn)
        await refresh($, c)
        return {
          text: c.compactOn
            ? `自动压缩已开：上下文到 ${sized(c.size)} 以上、保活关闭（或保活到时）时，在 cache 过期前压缩一次。`
            : '自动压缩已关。',
        }
      }
      case 'size': {
        const v = value.toLowerCase()
        if (!v) return { text: `上下文不到 ${sized(c.size)} 时不自动压缩（手动开的保活不受影响）。/caffeine size 60k 可改。` }
        const n = v === 'default' ? DEFAULT_SIZE : /^(\d+(?:\.\d+)?)(k|m)?$/.test(v) ? Math.round(Number.parseFloat(v) * (v.endsWith('m') ? 1e6 : v.endsWith('k') ? 1e3 : 1)) : null
        if (n === null || n < 1000) return { text: `Not a token count I know: ${value}. Try 300k, or default.` }
        c.size = n
        await $.store.set('size', n)
        await refresh($, c)
        return { text: `上下文到 ${sized(n)} 以上才自动压缩（现在 ${sized(c.context)}）。` }
      }
      case 'limitsize': {
        const v = value.toLowerCase()
        if (!v) return { text: `5h 或周用量到 ${WALL_PERCENT}%、离重置超过 cache 寿命时，上下文到 ${sized(c.wallSize)} 以上就提前压缩。/caffeine limitsize 250k 可改。` }
        const n = v === 'default' ? DEFAULT_WALL_SIZE : /^(\d+(?:\.\d+)?)(k|m)?$/.test(v) ? Math.round(Number.parseFloat(v) * (v.endsWith('m') ? 1e6 : v.endsWith('k') ? 1e3 : 1)) : null
        if (n === null || n < 1000) return { text: `Not a token count I know: ${value}. Try 250k, or default.` }
        c.wallSize = n
        await $.store.set('wallSize', n)
        await refresh($, c)
        return { text: `用量到 ${WALL_PERCENT}% 时，上下文到 ${sized(n)} 以上就提前压缩（现在 ${sized(c.context)}）。` }
      }
      case 'log': {
        const v = value.toLowerCase()
        if (v === 'clear') {
          logBuf = []
          await $.store.set('log', [])
          return { text: '日志已清空。' }
        }
        const n = /^\d+$/.test(v) ? Number(v) : 30
        return { text: logBuf.length ? logBuf.slice(-n).join('\n') : '日志是空的。' }
      }
      case 'mode': {
        const v = value.toLowerCase()
        if (v !== 'fork' && v !== 'prompt') {
          return { text: `保活方式：${pokeMode}。/caffeine mode fork（默认：后台读缓存续命，不进对话）| prompt（发一条 poke 消息，会留在对话里）` }
        }
        pokeMode = v
        await $.store.set('pokeMode', v)
        return { text: v === 'fork' ? '保活方式：fork，后台读缓存续命，对话里没有 poke 消息；fork 失败时自动改发 poke。' : '保活方式：prompt，每次发一条 poke 消息。' }
      }
      case 'notify': {
        const v = value.toLowerCase()
        if (v !== 'quiet' && v !== 'normal') {
          return { text: `提示：${notifyMode}。/caffeine notify quiet（只弹失败、完成、保活结束）| normal（什么都弹）。所有事件都记在 /caffeine log 里。` }
        }
        notifyMode = v
        await $.store.set('notify', v)
        void $.config.set({ key: 'caffeine-compact.notify', value: v }).catch(() => undefined)
        return { text: v === 'quiet' ? '提示：quiet，只弹失败、压缩完成、保活结束。' : '提示：normal，所有消息都弹。' }
      }
      case 'forktest': {
        // diagnostic: does $.model.fork read the main thread's cached prefix without touching the transcript?
        $.clock.after(50, () => void forkProbe($, c, 'fork 测试', c.lastAt ? span(now - c.lastAt) : '（还没有请求）'))
        return { text: 'fork 测试已发出，结果稍后以提示显示，也记在 /caffeine log。' }
      }
      case 'forkexp': {
        if (value.toLowerCase() === 'cancel') {
          expState = 'off'
          expToken += 1
          return { text: '实验已取消。' }
        }
        expControl = value.toLowerCase() === 'control'
        if (c.isOn) return { text: '先 /caffeine off 关掉保活，否则 poke 会干扰实验。' }
        expState = 'armed'
        expToken += 1
        return { text: (expControl ? '【对照组：中间不续命】' : '【实验组：50 分钟时续命】') + '已就位：你发下一条消息、Claude 回复完后开始计时。之后 65 分钟内不要再发消息（会中断实验），也不要关会话。结果会弹出并写进 /caffeine log。取消：/caffeine forkexp cancel。先跑 control，再跑不带参数的实验组。' }
      }
      case 'cost':
        return { text: costLines(c).join('\n') }
      case 'every': {
        if (!value || value === 'auto') {
          c.every = null
          await $.store.set('every', null)
          await refresh($, c)
          return { text: `Poking ${span(everyOf(c))} after the last request (auto, ${ttlLabel(ttlOf(c))} cache).` }
        }
        const ms = parseDuration(value)
        if (ms === null || ms < 30_000) return { text: `Not a duration I know (30s or more): ${value}.` }
        if (ms >= ttlOf(c)) return { text: `${span(ms)} is past the ${ttlLabel(ttlOf(c))} cache: it would be cold by then.` }
        c.every = ms
        await $.store.set('every', ms)
        await refresh($, c)
        return { text: `Poking ${span(ms)} after the last request.` }
      }
      case 'ttl': {
        const v = value.toLowerCase()
        const ttl = v === '1h' ? TTL_1H : v === '5m' ? TTL_5M : null
        if (ttl === null && v && v !== 'auto') return { text: 'The TTL is 1h, 5m or auto.' }
        c.ttl = ttl
        await $.store.set('ttl', ttl)
        await refresh($, c)
        return { text: `Cache TTL ${ttlLabel(ttlOf(c))} (${ttlSource(c)}); poking ${span(everyOf(c))} after the last request.` }
      }
      case 'forever':
        return forever($, c, value.toLowerCase() === 'yes')
      case 'idle': {
        const [first = '', second = ''] = value.toLowerCase().split(/\s+/)
        if (first === 'off' || first === 'never') {
          return forever($, c, second === 'yes')
        }
        const ms = parseDuration(value)
        if (ms === null) return { text: `Not a duration I know: ${value || '(none)'}. Try 8h, or off for no end this time.` }
        c.idle = ms
        await $.store.set('idle', ms)
        return { text: `Caffeine turns itself off after ${span(ms)} without a turn of your own.` }
      }
      case 'band': {
        const v = value.toLowerCase()
        if (v !== 'auto' && v !== 'on' && v !== 'off') {
          return { text: `状态栏：${c.band}。/caffeine band auto（有事才显示）| on（一直显示）| off（不显示，保活开着时改显示在状态行）` }
        }
        c.band = v
        // the config row is the default for new sessions; the write reloads the module with it
        void $.config.set({ key: 'caffeine-compact.band', value: v }).catch(() => undefined)
        await refresh($, c)
        return { text: v === 'auto' ? '状态栏：auto，有事才显示（保活开着、压缩快到点或正在压缩时）。' : v === 'on' ? '状态栏：一直显示。' : '状态栏：不显示；保活开着时信息改放在状态行。' }
      }
      case 'wake':
        return wakeCommand($, c, value)
      case 'status': {
        const block = blocking(c.limits)
        const lines = [
          describe(c, now).text,
          `Cache TTL ${ttlLabel(ttlOf(c))} (${ttlSource(c)}) · poke ${span(everyOf(c))} after the last request${c.every === null ? ' (auto)' : ''}`,
          `${c.isForever ? 'No idle stop this time: on until you turn it off' : `Off by itself after ${span(c.idle)} idle`} · auto ${c.autoAt ? `past ${sized(c.autoAt)}` : 'off'} · band ${c.band}`,
          `自动压缩 ${c.compactOn ? '开' : '关'} · 大小线 ${sized(c.size)}（现在 ${sized(c.context)}）· 已压缩 ${c.compacts} 次${c.isOn ? '' : standby(c, now)}`,
          `限额前提前压缩：用量到 ${WALL_PERCENT}% 且上下文到 ${sized(c.wallSize)} 以上`,
          c.lastWarm === null ? '' : `The last poke found the cache ${c.lastWarm ? 'warm' : 'cold'}.`,
          c.coldAt ? `The cache last went cold before ${clock(c.coldAt, now)}, after ${span(c.coldGap)} idle.` : '',
          `The poke says: ${c.message}`,
          c.armed ? `Wake: Claude continues at ${clock(c.armed.at, now)} (in ${span(c.armed.at - now)}), told: ${await wakeText($, c.armed)}.` : 'Wake: none booked.',
          block ? `${block.label} limit ${block.percent}%, resets ${clock(block.resetsAt, now)}.` : '',
        ]
        return { text: lines.filter(Boolean).join('\n') }
      }
      default: {
        // a bare time is a wake: /caffeine 1 min, /caffeine at 3pm
        if (parseWake(args, now) !== null) {
          return wakeCommand($, c, args)
        }
        return { text: `Not a caffeine command: ${word}\n${help}` }
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    c.bandId = e.requestId

    // the wake row: near the limit an offer, once booked a countdown
    const block: Block | null = blocking(c.limits)
    const isOffered = !c.armed && block !== null && (isNear(c.limits) || c.isHit) && c.dismissed !== block.resetsAt
    const armed = c.armed
    const wakeRow = armed ? (
      <Box key="caffeine-wake-row" flexDirection="row" columnGap={2}>
        <Text key="wake-text" color="cyan" wrap="truncate-end">
          {`caffeine · Claude continues at ${clock(armed.at, now)} (in ${span(armed.at - now)})`}
        </Text>
        <Button key="caffeine-wake-cancel" plain dimColor hotkey="n" onPress={() => void disarm($, c).then(() => tell($, 'wake cancelled.'))}>
          cancel
        </Button>
      </Box>
    ) : isOffered ? (
      <Box key="caffeine-wake-row" flexDirection="row" columnGap={2}>
        <Text key="wake-text" color={block!.percent >= 100 ? 'red' : 'yellow'} wrap="truncate-end">
          {`${block!.label} limit ${block!.percent}% · resets ${clock(block!.resetsAt, now)} (in ${span(block!.resetsAt - now)})`}
        </Text>
        <Button key="caffeine-wake" plain hotkey="u" onPress={() => void armAtReset($, c)}>
          {`wake Claude at ${clock(wakeAfter(block!.resetsAt), now)}`}
        </Button>
        <Button
          key="caffeine-wake-dismiss"
          plain
          dimColor
          hotkey="n"
          onPress={() => {
            c.dismissed = block!.resetsAt
            $.ui.invalidate('ui.render')
          }}
        >
          not now
        </Button>
      </Box>
    ) : null

    // the switch row
    const line = describe(c, now)
    const warm = cacheLeft(c, now)
    const row = !showBand(c, now) ? null : c.isEditing ? (
      <Box key="caffeine" flexDirection="row" columnGap={2}>
        <Input
          key="caffeine-message"
          label="caffeine says: "
          value={c.message}
          placeholder={DEFAULT_MESSAGE}
          submitLabel="save"
          autoFocus
          onSubmit={text => void setMessage($, c, text).then(saved => tell($, `the poke now says: ${saved}`))}
        />
        <Button
          key="caffeine-cancel"
          plain
          dimColor
          hotkey="q"
          onPress={() => {
            c.isEditing = false
            $.ui.invalidate('ui.render')
          }}
        >
          cancel
        </Button>
      </Box>
    ) : (
      <Box key="caffeine" flexDirection="row" columnGap={2}>
        {warm ? (
          <Box key="caffeine-cache" flexShrink={0}>
            <Text key="cache" color={warm.color}>
              {warm.text}
            </Text>
          </Box>
        ) : null}
        <Box key="caffeine-line" flexShrink={1} minWidth={0}>
          <Text key="text" color={line.color} dimColor={line.isDim} wrap="truncate-end">
            {line.text}
          </Text>
        </Box>
        <Box key="caffeine-buttons" flexDirection="row" columnGap={2} flexShrink={0}>
          <Button
            key="caffeine-toggle"
            plain
            hotkey="t"
            onPress={() => {
              if (c.isOn) c.isAutoDeclined = true
              void switchOn($, c, !c.isOn)
            }}
          >
            {c.isOn ? 'turn off' : 'turn on'}
          </Button>
          <Button key="caffeine-edit" plain dimColor hotkey="e" onPress={() => void editInBand($, c)}>
            message
          </Button>
        </Box>
      </Box>
    )

    if (!wakeRow && !row) {
      return next(e)
    }
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {wakeRow}
        {row}
        {below}
      </Box>
    )
  })
}
