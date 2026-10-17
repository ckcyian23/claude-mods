// Session state a reload of the mod finds again: on or off, when it wears off
// (0 for never), the last main-thread request, the last non-poke turn, whether
// the person turned off what auto turned on, and whether this run has no idle
// stop (`/caffeine forever`, cleared when caffeine turns off).
export type Brew = { isOn: boolean; until: number; lastAt: number; activeAt: number; isAutoDeclined: boolean; isForever: boolean }

declare module 'claude-code' {
  interface PluginState {
    'caffeine-compact': { brew: Brew }
  }
}
