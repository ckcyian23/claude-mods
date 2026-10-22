import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { blocking, DEFAULT_TIMER_WAKE, DEFAULT_WAKE, isNear, MARK, parseWake, parseWhen, wakeAfter } from '../hooks/wake'
import { pokeWasCold, readTiming } from '../hooks/brew'
import { clock, defaultEvery, dollars, equivalents, readRate, sized, nextPokeAt, overLine, parseClock, parseDuration, span, TTL_1H, TTL_5M, ttlByPlan, ttlFromCost, ttlFromEnv, wasWarm } from '../hooks/brew'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

const MIN = 60_000
const at = (h: number, m: number, day = 4) => new Date(2026, 9, day, h, m).getTime()

test('durations, times and the cadence', () => {
  expect(parseDuration('2h')).toBe(120 * MIN)
  expect(parseDuration('90m')).toBe(90 * MIN)
  expect(parseDuration('1h30m')).toBe(90 * MIN)
  expect(parseDuration('2.5m')).toBe(150_000)
  expect(parseDuration('150s')).toBe(150_000)
  expect(parseDuration('soon')).toBeNull()
  expect(parseDuration('')).toBeNull()
  expect(parseDuration('1 min')).toBe(MIN)
  expect(parseDuration('1min')).toBe(MIN)
  expect(parseDuration('in 5 minutes')).toBe(5 * MIN)
  expect(parseDuration('2 hours')).toBe(120 * MIN)
  expect(parseDuration('1 hour 30 min')).toBe(90 * MIN)
  expect(parseDuration('1h, 30m')).toBe(90 * MIN)
  expect(parseDuration('+90m')).toBe(90 * MIN)
  expect(parseDuration('45 secs')).toBe(45_000)
  expect(parseDuration('5')).toBeNull()
  expect(parseDuration('5 mangoes')).toBeNull()
  expect(parseDuration('monday')).toBeNull()
  expect(parseClock('18:00', at(9, 0))).toBe(at(18, 0))
  expect(parseClock('6pm', at(9, 0))).toBe(at(18, 0))
  expect(parseClock('8:00', at(9, 0))).toBe(at(8, 0, 5))
  expect(parseClock('18', at(9, 0))).toBeNull()
  expect(parseClock('at 3pm', at(9, 0))).toBe(at(15, 0))
  expect(parseClock('6:30 p.m.', at(9, 0))).toBe(at(18, 30))
  expect(parseClock('noon', at(9, 0))).toBe(at(12, 0))
  expect(parseClock('midnight', at(9, 0))).toBe(at(0, 0, 5))
  expect(clock(at(14, 12), at(9, 0))).toBe('14:12')
  expect(span(125 * MIN)).toBe('2h 05m')
  expect(span(12 * MIN)).toBe('12m')
  expect(span(150_000)).toBe('2m 30s')
  expect(span(45_000)).toBe('45s')
  expect(defaultEvery(TTL_1H)).toBe(55 * MIN)
  expect(defaultEvery(TTL_5M)).toBe(4 * MIN)
  // Claude Code's order: FORCE_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting, ENABLE_1H
  expect(ttlFromEnv(undefined, undefined, undefined, '1')).toBe(TTL_1H)
  expect(ttlFromEnv('1', undefined, undefined, '1')).toBe(TTL_5M)
  expect(ttlFromEnv('1', '1h', '1h', undefined)).toBe(TTL_5M)
  expect(ttlFromEnv(undefined, '1h', '5m', undefined)).toBe(TTL_1H)
  expect(ttlFromEnv(undefined, '5m', '1h', '1')).toBe(TTL_5M)
  expect(ttlFromEnv(undefined, undefined, '5m', '1')).toBe(TTL_5M)
  expect(ttlFromEnv(undefined, undefined, '1h', undefined)).toBe(TTL_1H)
  expect(ttlFromEnv(undefined, undefined, 42, undefined)).toBeNull()
  expect(ttlFromEnv(undefined, undefined, undefined, undefined)).toBeNull()
  expect(ttlFromEnv(undefined, undefined, undefined, '0')).toBeNull()
  expect(ttlByPlan([{ kind: 'five_hour', percentUsed: 19 }])).toBe(TTL_1H)
  expect(ttlByPlan([{ kind: 'five_hour', percentUsed: 100 }])).toBe(TTL_5M)
  expect(ttlByPlan([])).toBe(TTL_5M)
  // two Haiku 1h writes (2x), too large for a web search's $0.01 to explain
  const haiku = 'claude-haiku-4-5-20251001'
  expect(ttlFromCost(0.242322, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000 }, haiku)).toBe(TTL_1H)
  expect(ttlFromCost(0.303015, { input_tokens: 10, output_tokens: 74, cache_read_input_tokens: 26348, cache_creation_input_tokens: 150_000 }, haiku)).toBe(TTL_1H)
  // 1.25x is a 5m write, or a 1h one priced at the 5m rate: proves nothing
  expect(ttlFromCost(0.152267, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000 }, haiku)).toBeNull()
  // a real Haiku 2x, but a 5.8k write: one web search moves its rate by 1.7, so proves nothing
  expect(ttlFromCost(0.013878, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 5778 }, haiku)).toBeNull()
  // too little written to tell, an unknown price, a subagent's cost mixed in
  expect(ttlFromCost(0.002, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 200 }, haiku)).toBeNull()
  expect(ttlFromCost(0.2423, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000 }, 'other')).toBeNull()
  expect(ttlFromCost(0.3, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000 }, haiku)).toBeNull()
  // US requests cost x1.1, unseen by the hook (no inference_geo): a 1h write (0.2510, US 0.2761)
  // proves 1h either way, a 5m one (0.1610, US 0.1771) proves nothing
  const sonnet = 'claude-sonnet-5-5'
  const us = { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 60_000 }
  expect(ttlFromCost(0.25102, us, sonnet)).toBe(TTL_1H)
  expect(ttlFromCost(0.276122, us, sonnet)).toBe(TTL_1H)
  expect(ttlFromCost(0.16102, us, sonnet)).toBeNull()
  expect(ttlFromCost(0.177122, us, sonnet)).toBeNull()
  // a write small against the read says nothing even at 2x: the x1.1 on the read alone could explain it
  expect(ttlFromCost(0.104, { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 3000 }, 'claude-opus-5-5')).toBeNull()
  expect(nextPokeAt(0, MIN)).toBeNull()
  expect(nextPokeAt(1000, MIN)).toBe(1000 + MIN)
  expect(wasWarm({ cache_read_input_tokens: 90_000, cache_creation_input_tokens: 200 })).toBe(true)
  expect(wasWarm({ cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 })).toBe(false)
  expect(wasWarm(undefined)).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 89 }])).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 91.4 }])).toEqual({ label: '5h', percent: 91 })
  expect(overLine([{ kind: 'seven_day', percentUsed: 95 }])?.label).toBe('weekly')
})

// The next request's usage, for the turn.step stand-in.
let stepResult: object | null = null
// Claude Code's running cost estimate, if a test sets one; each request adds `stepCost`
let sessionCost: number | undefined
let stepCost = 0
// the triggers of the compactions that ran
const compactions: string[] = []
const logs: string[] = []
const compactCommands: string[] = []
// when set, $.session.compact fails with this (a headless session has none)
let compactError: string | null = null
// what $.model.fork answers; null: nothing to fork
let forkUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null = null
let forks = 0

// The engine beneath caffeine: the UI ops, the prompts it submits, the turns.
function world(on: On, submitted: string[], crons: { cron: string; prompt: string }[] = [], pushed: string[] = []) {
  on('tool.call', ($, e) => {
    if (e.tool === 'CronCreate') {
      crons.push({ cron: String(e.cron), prompt: String(e.prompt) })
      return { result: { id: ['job1', 'job2', 'job3'][crons.length - 1] ?? 'job', humanSchedule: 'once', recurring: false } }
    }
    if (e.tool === 'CronDelete') return { result: { id: String(e.id) } }
    if (e.tool === 'CronList') return { result: { jobs: [] } }
    if (e.tool === 'PushNotification') {
      pushed.push(String(e.message))
      return { result: { message: String(e.message) } }
    }
    return { deny: 'unexpected' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  sessionCost = undefined
  stepCost = 0
  on('session.usage', () => ({ value: { rateLimits: [], context: { tokens: 250_000 }, ...(sessionCost === undefined ? {} : { cost: { usd: sessionCost } }) } }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('command.run', ($, e) => {
    if (e.command === 'compact') compactCommands.push(e.args)
    return { text: '' }
  })
  on('model.fork', () => {
    forks += 1
    if (!forkUsage) return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
    return { value: { isAnswered: true, text: '好', usage: forkUsage } } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.compact', ($, e) => {
    if (compactError) return { skip: compactError } as never
    compactions.push(String(e.trigger ?? 'plugin'))
    return { messages: e.messages ?? [{ role: 'user', text: 'the summary', toolUses: [] }] } as never
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    if (sessionCost !== undefined) sessionCost += stepCost
    return { turnId: e.turnId, index: e.index, answer: 'okay', toolUses: [], stopReason: 'end_turn', usage: stepResult } as never
  })
  // what another mod (clawd-buddy) or the engine draws in the band beneath caffeine
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
}

// One main-thread turn: its start, one request, its end.
async function turn($: Engine, id: string, text: string, usage?: object, stepUsage?: object, model = 'claude-opus-5-5') {
  await $.turn.start({ text, turnId: id })
  stepResult = stepUsage ?? null
  for await (const _ of $.turn.step({ turnId: id, index: 0, model, messageCount: 3 } as never)) {
    // nothing streams
  }
  await $.turn.complete({ answer: 'okay', durationMs: 900, isAborted: false, turnId: id, reason: 'answer', usage } as never)
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'caffeine', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('on, it pokes 55 minutes after the last request on a 1h cache, and not on a cold one', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await run($, 'compact off')

  expect((await run($, 'on')).text).toContain('until you turn it off, poking 55m after the last request (1h cache)')
  await turn($, 't1', 'fix the tests')
  await time.advance(54 * MIN)
  expect(submitted).toEqual([])
  await time.advance(1 * MIN + 5_000)
  expect(submitted).toEqual(['poke, just say okay'])

  // the poke's own turn: warm, counted, and the next one 55 minutes after it
  await turn($, 't2', 'poke, just say okay', { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' })
  expect((await run($, 'status')).text).toContain('1 poke')
  expect((await run($, 'status')).text).toContain('found the cache warm')
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(2)
  await turn($, 't3', 'poke, just say okay')

  // turned on again after the TTL ran out: no poke into a cold cache
  await run($, 'off')
  await time.advance(70 * MIN)
  await run($, 'on')
  await time.advance(10_000)
  expect(submitted.length).toBe(2)
  expect((await run($, 'status')).text).toContain('cache went cold')

  expect((await run($, 'off')).text).toBe('Caffeine off.')
})

test('the band toggles it, edits the message, and draws what is beneath', { options: { band: 'on' } }, async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  world(on, [])
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const mount = () => $.ui.mount({ plugin: 'caffeine-compact', surface, component: 'AbovePrompt', props: PROPS })
    let ui = await mount()
    expect(JSON.stringify(await ui.drawn())).toContain('caffeine off')
    expect(await ui.find({ key: 'beneath' })).toBeDefined()
    await ui.press({ key: 'caffeine-toggle' })
    await ui.unmount()
    ui = await mount()
    expect(JSON.stringify(await ui.drawn())).toContain('waits for the first reply')

    await ui.press({ key: 'caffeine-edit' })
    await ui.unmount()
    ui = await mount()
    expect(await ui.find({ key: 'caffeine-message' })).toBeDefined()
    await ui.input({ key: 'caffeine-message', text: `still there? (${surface})` })
    expect((await run($, 'message')).text).toBe(`The poke says: still there? (${surface})`)
    await ui.unmount()
    ui = await mount()
    expect(await ui.find({ key: 'caffeine-message' })).toBeUndefined()
    await ui.press({ key: 'caffeine-toggle' })
    await ui.unmount()
  }
  expect((await run($, 'message reset')).text).toBe('The poke now says: poke, just say okay')

  // bandless: the row steps aside for the other mods' rows
  expect((await run($, 'band off')).text).toContain('状态行')
  const ui = await $.ui.mount({ plugin: 'caffeine-compact', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).not.toContain('caffeine')
  expect(await ui.find({ key: 'beneath' })).toBeDefined()
})

test('it wears off, turns itself off when idle, and pauses near the usage limit', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await run($, 'compact off')

  expect((await run($, 'warm 1h')).text).toBe('Caffeine on, keeping the cache warm until 10:00.')
  await turn($, 't1', 'hello')
  await time.advance(4 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  await turn($, 't2', 'poke, just say okay')
  await time.advance(61 * MIN)
  expect((await run($, 'status')).text).toContain('caffeine off')

  // idle: off after 20 minutes with only pokes
  expect((await run($, 'idle 20m')).text).toContain('after 20m')
  await run($, 'on')
  for (let i = 0; i < 10; i++) {
    await time.advance(4 * MIN + 5_000)
    if (submitted.length > i + 1) await turn($, `p${i}`, 'poke, just say okay')
  }
  expect((await run($, 'status')).text).toContain('caffeine off')
  const sent = submitted.length

  // no end: asked first (no dialog here, so it says how to confirm); a yes removes the stop
  expect((await run($, 'forever')).text).toContain('/caffeine forever yes confirms it')
  expect((await run($, 'status')).text).toContain('Off by itself after 20m idle')
  expect((await run($, 'idle off yes')).text).toContain('Caffeine on with no end')
  expect((await run($, 'status')).text).toContain('until you turn it off\nCache TTL')
  expect((await run($, 'status')).text).toContain('No idle stop this time: on until you turn it off')
  // off, then on again: the idle stop is back
  await run($, 'off')
  await run($, 'on')
  expect((await run($, 'status')).text).toContain('until you turn it off (or 20m idle)')
  expect((await run($, 'status')).text).toContain('Off by itself after 20m idle')

  // near the 5-hour line: paused, no pokes
  await run($, 'idle off yes')
  await run($, 'on')
  await turn($, 't3', 'more work')
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 1000, max: 200000, percent: 0.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 93, resetsAt: new Date(at(14, 0)).toISOString() }],
  } as never)
  await time.advance(4 * MIN)
  expect(submitted.length).toBe(sent)
  expect((await run($, 'status')).text).toContain('paused · 5h limit 93%')

  // a subscription (it has rate-limit windows) defaults to the 1h cache
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (the subscription default)')
  expect((await run($, 'ttl 5m')).text).toContain('Cache TTL 5m')
  expect((await run($, 'every 10m')).text).toContain('past the 5m cache')
  expect((await run($, 'ttl 1h')).text).toContain('Cache TTL 1h')
  expect((await run($, 'every 10m')).text).toBe('Poking 10m after the last request.')
  expect((await run($, 'nonsense')).text).toContain('Not a caffeine command')
})

test('the wake: windows and times', () => {
  const five = { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(at(14, 10)).toISOString() }
  const week = { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(at(9, 0, 8)).toISOString() }
  expect(blocking([five, week])?.label).toBe('5h')
  expect(blocking([five, { ...week, percentUsed: 100 }])?.label).toBe('weekly')
  expect(isNear([{ ...five, percentUsed: 89 }])).toBe(false)
  expect(isNear([{ ...five, percentUsed: 90 }])).toBe(true)
  expect(new Date(wakeAfter(at(14, 10))).getMinutes()).toBe(12)
  expect(new Date(wakeAfter(at(14, 28))).getMinutes()).toBe(31)
  expect(parseWhen('+1h30m', at(9, 0))).toBe(at(10, 30))
  expect(parseWhen('2:30pm', at(9, 0))).toBe(at(14, 30))
  expect(parseWhen('soon', at(9, 0))).toBeNull()
  expect(parseWhen('1 min', at(9, 0))).toBe(at(9, 1))
  expect(parseWhen('in 20 minutes', at(9, 0))).toBe(at(9, 20))
  expect(parseWhen('at 3pm', at(9, 0))).toBe(at(15, 0))
  expect(parseWake('20 min check the build', at(9, 0))).toEqual({ at: at(9, 20), text: 'check the build' })
  expect(parseWake('1 hour 30 min', at(9, 0))).toEqual({ at: at(10, 30), text: '' })
  expect(parseWake('at 3pm run the tests', at(9, 0))).toEqual({ at: at(15, 0), text: 'run the tests' })
  expect(parseWake('20 min 5 things', at(9, 0))).toEqual({ at: at(9, 20), text: '5 things' })
  expect(parseWake('check the build', at(9, 0))).toBeNull()
})

test('cost: per-model cache read rates and the poke against a rewrite', () => {
  expect(readRate('claude-opus-5-5')).toBe(0.05)
  expect(readRate('claude-fable-5-1')).toBe(0.025)
  expect(readRate('claude-sonnet-5-5')).toBe(0.1)
  const poke = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 60 }
  expect(equivalents(poke, 'claude-opus-5-5', 3_600_000)).toBe(40 + 50 + 5000 + 120)
  expect(sized(284_000)).toBe('284k')
  expect(sized(7300)).toBe('7.3k')
  expect(dollars(1_000_000, 'claude-opus-5-5')).toBe('about $4.00')
  expect(dollars(100, 'claude-opus-5-5')).toBe('under $0.01')
  expect(dollars(100, 'some-other-model')).toBe('')
})

test('near the limit the band offers a wake; a press books it and keeps the cache warm until it fires', { options: { band: 'on' } }, async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const resetsAt = at(11, 0)
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 1000, max: 200000, percent: 0.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(resetsAt).toISOString() }],
  } as never)

  const mount = () => $.ui.mount({ plugin: 'caffeine-compact', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  let ui = await mount()
  expect(JSON.stringify(await ui.drawn())).toContain('5h limit 96%')
  expect(await ui.find({ key: 'beneath' })).toBeDefined()
  await ui.press({ key: 'caffeine-wake' })
  await time.advance(100)
  // caffeine came on with the wake, until it
  expect((await run($, 'status')).text).toContain(`until ${clock(wakeAfter(resetsAt), at(9, 0))}`)
  expect((await run($, 'status')).text).toContain(`Wake: Claude continues at ${clock(wakeAfter(resetsAt), at(9, 0))}`)
  await ui.unmount()
  ui = await mount()
  expect(JSON.stringify(await ui.drawn())).toContain('Claude continues at')

  // cancelling the wake turns off what it turned on
  await ui.press({ key: 'caffeine-wake-cancel' })
  expect((await run($, 'status')).text).toContain('caffeine off')
  expect((await run($, 'status')).text).toContain('Wake: none booked.')
  await ui.unmount()

  // a wake at a time: nothing before it, the wake prompt at it
  expect((await run($, 'wake prompt run the tests again')).text).toContain('run the tests again')
  expect((await run($, '90 minutes')).text).toContain('Booking the wake for 10:30 (in 1h 30m)')
  await time.advance(100)
  await time.advance(89 * MIN)
  expect(submitted.filter(t => t.startsWith(MARK))).toEqual([])
  await time.advance(1 * MIN + 5_000)
  expect(submitted.filter(t => t.startsWith(MARK))).toEqual([`${MARK} run the tests again`])
  expect((await run($, 'status')).text).toContain('Wake: none booked.')
  expect((await run($, 'wake auto on')).text).toContain('on.')
  expect((await run($, 'wake nonsense')).text).toContain('Not a time I know')
  expect((await run($, 'nonsense')).text).toContain('Not a caffeine command')
  expect((await run($, 'wake 1 min')).text).toContain('(in 1m)')
  expect((await run($, 'in 2 hours')).text).toContain('(in 2h 00m)')
})

test('a booked wake survives a reload of the mod', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  // the test host has no session id, which reads as ''
  mock.store(on, { wake: { session: '', at: at(12, 0), label: '5h' } })
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await time.advance(100)
  expect((await run($, 'status')).text).toContain('Wake: Claude continues at 12:00')
  // a limit wake says the limit reset
  for (let i = 0; i < 18; i++) await time.advance(10 * MIN)
  expect(submitted.filter(t => t.startsWith(MARK))).toEqual([`${MARK} ${DEFAULT_WAKE}`])
})

test('a wake at a time says so, unless it was given words of its own', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  expect((await run($, '1 min')).text).toContain('(in 1m)')
  await time.advance(100)
  await time.advance(1 * MIN)
  expect(submitted.filter(t => t.startsWith(MARK))).toEqual([`${MARK} ${DEFAULT_TIMER_WAKE}`])
  // the wake's own turn runs before the next prompt can go out
  await turn($, 'w1', submitted.at(-1)!)
  expect((await run($, '2 min check the build')).text).toContain('(in 2m), to say: check the build')
  await time.advance(100)
  expect((await run($, 'status')).text).toContain('told: check the build')
  // the 5s tick that comes after the wake time sends it
  await time.advance(2 * MIN + 5_000)
  expect(submitted.filter(t => t.startsWith(MARK))).toEqual([`${MARK} ${DEFAULT_TIMER_WAKE}`, `${MARK} check the build`])
  expect((await run($, 'wake prompt be brief')).text).toContain('be brief')
  expect((await run($, 'wake prompt default')).text).toContain('Back to the defaults')
})

test('auto turns it on past the context size, once; away 1h; cost reads the session', { options: { band: 'on' } }, async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  world(on, [])
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const measure = (n: number) =>
    $.session.measure({ changed: ['context'], context: { tokens: n, max: 1_000_000, percent: n / 1e4 }, rateLimits: [] } as never)

  expect((await run($, 'cost')).text).toContain('No reply yet')
  expect((await run($, 'auto 100k')).text).toContain('passes 100k tokens')
  await measure(90_000)
  expect((await run($, 'status')).text).toContain('caffeine off')
  await turn($, 't1', 'read the whole repo')
  await measure(250_000)
  expect((await run($, 'status')).text).toContain('caffeine on')
  // turned off by hand: auto leaves it off for the session
  await run($, 'off')
  await measure(130_000)
  expect((await run($, 'status')).text).toContain('caffeine off')

  const cost = (await run($, 'cost')).text
  expect(cost).toContain('Context 130k tokens on claude-opus-5-5, 1h cache')
  expect(cost).toContain('cache read at 0.05x')
  expect(cost).toContain('written again at 2x')
  expect(cost).toContain('A rewrite costs about 39 pokes')

  // on with no end the row says so; a set length says when it ends
  await run($, 'on')
  const ui = await $.ui.mount({ plugin: 'caffeine-compact', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('until you turn it off (or 24h idle)')
  expect(await ui.find({ key: 'caffeine-away' })).toBeUndefined()
  await ui.unmount()
  expect((await run($, 'warm')).text).toBe('Caffeine on, keeping the cache warm until 10:00.')
  expect((await run($, 'warm 30m')).text).toBe('Caffeine on, keeping the cache warm until 09:30.')
  expect((await run($, 'status')).text).toContain('until 09:30 (30m left)')
})

test('a 5m-rate cost leaves the subscription at 1h; a 1h-rate cost proves it', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  sessionCost = 0
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await run($, 'compact off')
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 250_000, max: 200_000, percent: 15 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(at(13, 0)).toISOString() }],
  } as never)
  const haiku = 'claude-haiku-4-5-20251001'
  const request = async (id: string, cost: number, usage: object) => {
    stepCost = cost
    await turn($, id, 'work', undefined, { ...usage, model: haiku }, haiku)
  }

  // a 1.25x write: the cost cannot tell, so the subscription's 1h stands
  await request('t1', 0.009781, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 6011 })
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (the subscription default)')
  await run($, 'on')
  await time.advance(4 * MIN + 5_000)
  expect(submitted.length).toBe(0)
  await time.advance(52 * MIN)
  expect(submitted.length).toBe(1)

  // a write priced at 2x proves 1h, whatever the plan says
  await run($, 'off')
  await request('t2', 0.290265, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 120_000 })
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from what requests cost)')
})

// A Haiku session with a 1h reading (a 120k write at 2x), 20 minutes before the next request.
async function measured1h($: Engine, on: On, time: ReturnType<typeof mock.clock>, submitted: string[]) {
  mock.store(on)
  mock.env(on, {})
  world(on, submitted)
  sessionCost = 0
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 250_000, max: 200_000, percent: 15 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(at(13, 0)).toISOString() }],
  } as never)
  const haiku = 'claude-haiku-4-5-20251001'
  const request = async (id: string, text: string, cost: number, usage: object) => {
    stepCost = cost
    await turn($, id, text, { ...usage, model: haiku }, { ...usage, model: haiku }, haiku)
  }
  await request('t1', 'work', 0.242322, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000 })
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from what requests cost)')
  await time.advance(20 * MIN)
  return request
}

test('a turn that finds the cache cold inside the hour, with no 1h reading of its own, takes the reading back', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  const request = await measured1h($, on, time, [])
  // rewritten 20 minutes in, at no cost caffeine can read: timing's 5m stands
  await request('t2', 'more', 0, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 89_000 })
  const status = (await run($, 'status')).text
  expect(status).toContain('Cache TTL 5m (measured from request timing)')
  expect(status).not.toContain('measured from what requests cost')
})

test('a rewrite inside the hour at the 1h rate keeps the reading: a prefix change, not an expiry', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  const request = await measured1h($, on, time, [])
  // an MCP reconnect changed the prefix: the rewrite prices at 2x again (0.240125), so 1h holds over timing's 5m
  await request('t2', 'more', 0.240125, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 120_000 })
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from what requests cost)')
})

test('a chance 1h cost reading is taken back by a cold cache inside the hour; pokes go back to 4 minutes', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  sessionCost = 0
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await run($, 'compact off')
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 250_000, max: 200_000, percent: 15 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(at(13, 0)).toISOString() }],
  } as never)
  const haiku = 'claude-haiku-4-5-20251001'
  const request = async (id: string, text: string, cost: number, usage: object) => {
    stepCost = cost
    await turn($, id, text, { ...usage, model: haiku }, { ...usage, model: haiku }, haiku)
  }

  // a 5m write (0.139767) plus a subagent's $0.0825 in the same delta (indistinguishable to the hook) reads as 1h
  await request('t1', 'work', 0.222267, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 110_000 })
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from what requests cost)')
  await run($, 'on')
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(1)

  // the poke finds the cache cold 55 minutes in: the reading is gone, timing says 5m, and caffeine is off
  await request('p1', 'poke, just say okay', 0, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 89_000 })
  const status = (await run($, 'status')).text
  expect(status).toContain('caffeine off')
  expect(status).toContain('Cache TTL 5m (measured from request timing)')
  expect(status).not.toContain('measured from what requests cost')

  // on again: the next request's poke comes 4 minutes after it
  await run($, 'on')
  await request('t2', 'back', 0, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40 })
  await time.advance(4 * MIN + 5_000)
  expect(submitted.length).toBe(2)
})

test('the environment outranks a cost reading: Claude Code reads it first', async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { FORCE_PROMPT_CACHING_5M: '1' })
  world(on, [])
  sessionCost = 0
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const haiku = 'claude-haiku-4-5-20251001'
  stepCost = 0.242322
  await turn($, 't1', 'work', undefined, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 120_000, model: haiku }, haiku)
  expect((await run($, 'status')).text).toContain('Cache TTL 5m (from the environment)')
  expect((await run($, 'on')).text).toContain('poking 4m after the last request (5m cache)')
})

test('the promptCacheTtl setting counts as the environment does, under CLAUDE_CODE_PROMPT_CACHE_TTL', async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  on('settings.read', () => ({ value: { promptCacheTtl: '5m' } }) as never)
  world(on, [])
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  expect((await run($, 'status')).text).toContain('Cache TTL 5m (from the environment)')
})

test('timing: a read after 5.5 minutes proves 1h, a rewrite under an hour means 5m, exempt after a compaction', () => {
  const read = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 300 }
  const wrote = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 88_000 }
  expect(readTiming(20 * MIN, read, false)).toEqual({ isCold: false, ttl: TTL_1H })
  expect(readTiming(4 * MIN, read, false)).toEqual({ isCold: false, ttl: null })
  expect(readTiming(20 * MIN, wrote, false)).toEqual({ isCold: true, ttl: TTL_5M })
  expect(readTiming(90 * MIN, wrote, false)).toEqual({ isCold: true, ttl: null })
  expect(readTiming(20 * MIN, wrote, true)).toEqual({ isCold: false, ttl: null })
  expect(readTiming(20 * MIN, { ...wrote, cache_creation_input_tokens: 8_000 }, false)).toEqual({ isCold: false, ttl: null })
  expect(pokeWasCold(read)).toBe(false)
  expect(pokeWasCold(wrote)).toBe(true)
})

test('a poke that finds the cache cold turns caffeine off; timing sets the TTL where cost cannot', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  await run($, 'compact off')
  const big = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 300, model: 'some-new-model' }

  // a request read the cache after 20 minutes: the TTL is 1h, measured from timing
  await turn($, 't1', 'hello', undefined, big)
  await time.advance(20 * MIN)
  await turn($, 't2', 'more', undefined, big)
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from request timing)')

  await run($, 'on')
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  const cold = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 89_000, model: 'some-new-model' }
  await turn($, 'p1', 'poke, just say okay', cold, cold)
  const status = (await run($, 'status')).text
  expect(status).toContain('caffeine off')
  expect(status).toContain('The last poke found the cache cold.')
  expect(status).toContain('The cache last went cold before 10:15, after 55m idle.')
})

const SUMMARY = [{ role: 'user', text: 'the summary', toolUses: [] }]

test('a compaction or a /clear holds the pokes until the next message, and its rewrite is not a cold poke', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  const wrote = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 57_000, model: 'claude-opus-5-5' }
  const read = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 57_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' }

  await run($, 'on')
  await turn($, 't1', 'fix the tests')
  await time.advance(10 * MIN)

  // a precompute and a subagent's compaction leave the cache alone
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY } as never)
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: SUMMARY } as never)
  expect((await run($, 'status')).text).toContain('poke at 09:55')

  // /compact: no poke pays for the rewrite
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  expect((await run($, 'status')).text).toContain('waits for your next message after the compaction')
  await time.advance(60 * MIN)
  expect(submitted).toEqual([])

  // the person's next message writes it, unremarked, and the pokes start again from there
  await turn($, 't2', 'where were we', wrote, wrote)
  await time.advance(55 * MIN + 5_000)
  expect(submitted).toEqual(['poke, just say okay'])
  await turn($, 'p1', 'poke, just say okay', read, read)
  expect((await run($, 'status')).text).toContain('found the cache warm')

  // /clear holds them the same way
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect((await run($, 'status')).text).toContain('waits for your next message after the /clear')
  await time.advance(60 * MIN)
  expect(submitted.length).toBe(1)
})

test('a poke that is the first request on another model writes the cache without turning off', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  const wrote = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 57_000, model: 'claude-sonnet-5-5' }

  await run($, 'on')
  await turn($, 't1', 'fix the tests')
  // /model while idle: no hook fires, so the poke is the first request on the new model
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  await turn($, 'p1', 'poke, just say okay', wrote, wrote, 'claude-sonnet-5-5')
  const status = (await run($, 'status')).text
  expect(status).toContain('caffeine on')
  expect(status).not.toContain('found the cache cold')
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(2)
})

test('the band is one row: the cache time left once there is a reply, cooling', { options: { band: 'on' } }, async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  world(on, [])
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  const mount = () => $.ui.mount({ plugin: 'caffeine-compact', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  let ui = await mount()
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('cache 剩')
  expect(drawn).not.toContain('°F')
  expect(drawn).not.toContain('c[_]')
  await ui.unmount()
  await turn($, 't1', 'hello')
  ui = await mount()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('cache 剩 1h 00m')
  await ui.unmount()
  await time.advance(30 * MIN)
  ui = await mount()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('cache 剩 30m')
  await ui.unmount()
  await time.advance(40 * MIN)
  ui = await mount()
  expect(JSON.stringify(await ui.drawn())).toContain('cache 已凉')
  await ui.unmount()
})

const measure = ($: Engine, tokens: number) =>
  $.session.measure({ changed: ['context'], context: { tokens, max: 1_000_000, percent: 1 }, rateLimits: [] } as never)

test('keep-alive off, past the size line: compacts shortly before the cache expires, once; below it, nothing', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  compactions.length = 0
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })

  // a small context: no compaction, no poke
  await measure($, 20_000)
  await turn($, 't1', 'hello')
  await time.advance(70 * MIN)
  expect(compactions).toEqual([])
  expect(submitted).toEqual([])

  // a big one: 5 minutes before the 1h cache expires (55 minutes after the request), once
  await measure($, 250_000)
  await turn($, 't2', 'work')
  expect((await run($, 'status')).text).toContain('自动压缩')
  await time.advance(54 * MIN)
  expect(compactions).toEqual([])
  await time.advance(2 * MIN)
  expect(compactions).toEqual(['plugin'])
  expect(submitted).toEqual([])
  // the compaction emptied the cache: nothing more until the next message
  await time.advance(30 * MIN)
  expect(compactions.length).toBe(1)

  // switched off with /caffeine compact off
  expect((await run($, 'compact off')).text).toContain('已关')
  await turn($, 't3', 'work')
  await time.advance(55 * MIN)
  expect(compactions.length).toBe(1)

  // the size line is adjustable
  expect((await run($, 'size 300k')).text).toContain('300k')
  await run($, 'compact on')
  await turn($, 't4', 'work')
  await time.advance(55 * MIN)
  expect(compactions.length).toBe(1)
})

test('keep-alive on: pokes for the hold, then turns off and compacts shortly before the cache expires', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  compactions.length = 0
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await run($, 'idle 2h')
  await run($, 'on')
  await measure($, 250_000)
  await turn($, 't1', 'work')

  // no compaction while keep-alive is on; a poke every 55 minutes
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  await turn($, 'p1', 'poke, just say okay', { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' })
  await time.advance(55 * MIN + 5_000)
  expect(submitted.length).toBe(2)
  await turn($, 'p2', 'poke, just say okay', { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' })
  expect(compactions).toEqual([])

  // the 2h hold ends 10 minutes after the second poke: keep-alive off; compaction is 55 minutes after that poke
  await time.advance(10 * MIN)
  expect((await run($, 'status')).text).toContain('caffeine off')
  expect(compactions).toEqual([])
  await time.advance(46 * MIN)
  expect(compactions).toEqual(['plugin'])
  expect(submitted.length).toBe(2)
})

test('keep-alive you turn on pokes whatever the size; /caffeine size and compact report', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await run($, 'on')
  await measure($, 20_000)
  await turn($, 't1', 'work')
  await time.advance(56 * MIN)
  expect(submitted.length).toBe(1)
  expect((await run($, 'size')).text).toContain('200k')
  expect((await run($, 'size 5')).text).toContain('Not a token count')
  expect((await run($, 'size 300k')).text).toContain('300k')
  expect((await run($, 'size default')).text).toContain('200k')
  // idle hold defaults to 24h
  expect((await run($, 'status')).text).toContain('Off by itself after 24h 00m idle')
})

test('band auto: hidden until there is something to show; on and off are fixed', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  world(on, [])
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  const drawn = async () => {
    const ui = await $.ui.mount({ plugin: 'caffeine-compact', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    const text = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return text
  }
  // nothing going on: no row
  await measure($, 250_000)
  await turn($, 't1', 'work')
  expect(await drawn()).not.toContain('caffeine')
  // the compaction is 10 minutes away (at 09:55): the row appears
  await time.advance(44 * MIN)
  expect(await drawn()).not.toContain('caffeine')
  await time.advance(2 * MIN)
  expect(await drawn()).toContain('自动压缩')
  // keep-alive on: the row stays
  await turn($, 't2', 'work')
  await run($, 'on')
  expect(await drawn()).toContain('caffeine on')
  await run($, 'off')
  expect(await drawn()).not.toContain('caffeine')
  expect((await run($, 'band')).text).toContain('auto')
  await run($, 'band on')
  expect(await drawn()).toContain('caffeine off')
  await run($, 'band off')
  expect(await drawn()).not.toContain('caffeine')
})

test('compact now: runs once through the plugin and reports', async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  compactions.length = 0
  world(on, [])
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await measure($, 250_000)
  await turn($, 't1', 'work')
  expect((await run($, 'compact now')).text).toContain('开始压缩')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await run($, 'help')).text).toContain('compact now')
})

test('where $.session.compact is not available, it runs /compact, without counting as your turn', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  compactions.length = 0
  compactError = '$.session.compact: not available in a headless (-p / SDK) session yet'
  world(on, submitted)
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await measure($, 250_000)
  await turn($, 't1', 'work')
  await time.advance(56 * MIN)
  expect(submitted.length).toBe(0)
  expect(compactCommands.length).toBe(1)
  expect(compactCommands[0]).toContain('压缩')
  // its own turn, then the compaction event: done, held until your next message
  compactError = null
  await $.turn.start({ text: 'summarize', turnId: 'c1' })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'the summary', toolUses: [] }] } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 900, isAborted: false, turnId: 'c1', reason: 'answer' } as never)
  expect((await run($, 'status')).text).toContain('已压缩 1 次')
  await time.advance(70 * MIN)
  expect(compactCommands.length).toBe(1)
})

test('log keeps every event; notify quiet and normal report through /caffeine', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  compactions.length = 0
  world(on, [])
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await measure($, 250_000)
  await turn($, 't1', 'work')
  await run($, 'compact now')
  await time.advance(100)
  expect((await run($, 'log')).text).toContain('压缩开始')
  expect((await run($, 'notify normal')).text).toContain('normal')
  expect((await run($, 'notify')).text).toContain('normal')
  expect((await run($, 'notify quiet')).text).toContain('quiet')
  expect((await run($, 'log clear')).text).toContain('清空')
  expect((await run($, 'log')).text).toContain('空')
})

test('fork poke: reads the prefix without a message in the transcript; a cold read turns it off; nothing to fork falls back to a message', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  forks = 0
  forkUsage = { input_tokens: 13, output_tokens: 3, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 20 }
  await $.session.start({ cwd: 'D:\work', surface: 'terminal', isInteractive: true })
  await measure($, 250_000)
  await turn($, 't1', 'work')
  await run($, 'on')
  await time.advance(56 * MIN)
  expect(forks).toBe(1)
  expect(submitted.length).toBe(0)
  expect((await run($, 'log')).text).toContain('fork 保活')
  // nothing to fork: a poke message goes out instead
  forkUsage = null
  await time.advance(56 * MIN)
  expect(forks).toBe(2)
  expect(submitted.length).toBe(1)
  // mode prompt: no fork at all
  expect((await run($, 'mode prompt')).text).toContain('prompt')
  expect((await run($, 'mode')).text).toContain('prompt')
  await run($, 'mode fork')
  forkUsage = null
})
