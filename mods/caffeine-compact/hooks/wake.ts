// Pure parts of the wake (formerly wakey): the window in the way, when to
// wake, and what Claude is told.

import { parseClock, parseDuration } from './brew'
import type { Limit } from './brew'

// What a wake is waiting out: the window, how full it is, and when it resets.
export type Block = { label: string; percent: number; resetsAt: number }

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' }

// The wake row shows from here: close enough to the line to plan a wake.
export const NEAR = { five_hour: 90, seven_day: 95 } as const

// Prefix on every wake prompt, so the transcript shows it as caffeine's.
export const MARK = '[caffeine]'
// What Claude is told on waking: after a limit reset, or at a set time.
export const DEFAULT_WAKE = 'The usage limit has reset. Pick up where you left off.'
export const DEFAULT_TIMER_WAKE = "Time's up. Pick up where you left off."

const minute = 60_000

function window(l: Limit): Block | null {
  const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
  if (Number.isNaN(resetsAt) || !(l.kind in LABELS)) {
    return null
  }
  return { label: LABELS[l.kind]!, percent: Math.round(l.percentUsed), resetsAt }
}

// The window to wait out: of the full ones, the one that resets last (a full
// week outlasts a 5-hour reset); with none full, the 5-hour one.
export function blocking(limits: readonly Limit[]): Block | null {
  const windows = limits.map(window).filter((w): w is Block => w !== null)
  const full = windows.filter(w => w.percent >= 100).sort((a, b) => b.resetsAt - a.resetsAt)
  return full[0] ?? windows.find(w => w.label === '5h') ?? null
}

export function isNear(limits: readonly Limit[]): boolean {
  return limits.some(l => {
    const line = NEAR[l.kind as keyof typeof NEAR]
    return line !== undefined && l.percentUsed >= line
  })
}

// A couple of minutes after the reset, so the window has surely turned over
// (and never on :00 or :30, the busiest minutes).
export function wakeAfter(resetsAt: number): number {
  let at = Math.ceil((resetsAt + 2 * minute) / minute) * minute
  const m = new Date(at).getMinutes()
  if (m === 0 || m === 30) {
    at += minute
  }
  return at
}

// When to wake, as people type it: a span from now (`1 min`, `in 20 minutes`,
// `+90m`, `2 hours`) or a clock time (`14:30`, `2:30pm`, `at 3pm`, `noon`).
export function parseWhen(text: string, now: number): number | null {
  const ms = parseDuration(text)
  return ms !== null ? now + ms : parseClock(text, now)
}

// A wake time and what to say: `20 min check the build` is 20 minutes from
// now, saying "check the build". The longest leading run of words that reads
// as a time is the time; the rest (maybe nothing) is the text.
export function parseWake(text: string, now: number): { at: number; text: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  for (let k = words.length; k > 0; k--) {
    const at = parseWhen(words.slice(0, k).join(' '), now)
    if (at !== null) {
      return { at, text: words.slice(k).join(' ') }
    }
  }
  return null
}
