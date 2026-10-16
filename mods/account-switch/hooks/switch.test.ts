// 用假的 claude_switch.py 输出测试：不会真的切号
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Status } from '../types'

const STATUS: Status = {
  cli: { current: 'a', email: 'a@example.com', loggedIn: true },
  desktop: { current: 'a', email: 'a@example.com', loggedIn: true, running: true },
  job: null,
  accounts: [
    { name: 'a', hasCli: true, hasDesktop: true, email: 'a@example.com', plan: 'pro',
      usage: { at: 1_700_000_000, fh: 25, fhReset: 1_700_003_600, fhIsReset: false, sd: 16, sdReset: null, sdIsReset: false } },
    { name: 'b', hasCli: true, hasDesktop: true, email: 'b@example.com', plan: 'pro', usage: null },
  ],
  sessions: { accounts: 2, count: 3, inSync: true, links: 0 },
}
const PANE = {
  title: 'Claude 切号',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const slash = (args: string) =>
  ({ command: 'claude-switch', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

function fakeScript(on: On, calls: string[][], opened: string[] = []) {
  mock.store(on)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', async (_$, e) => {
    expect(String(e.argv[2])).toMatch(/[\\/]scripts[\\/]claude_switch\.py$/) // 用插件自己目录里的脚本
    const args = e.argv.slice(3)
    calls.push([...args])
    const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'status') return out(0, JSON.stringify(STATUS))
    if (args[0] === 'use' && !args.includes('--yes') && !args.includes('cli')) {
      return out(3, '需要确认：这个操作要先退出 Claude Desktop。\n确认没问题后，加 --yes 重新运行。')
    }
    return out(0, `ok ${args.join(' ')}`)
  })
}

test('/claude-switch 带参数直接执行，结果只进提示条和面板，不写进对话', async ($, on) => {
  const calls: string[][] = []
  const toasts: string[] = []
  fakeScript(on, calls)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const r = await $.command.run(slash('use b --only cli'))
  expect(r.text).toBeUndefined()
  expect(calls[0]).toEqual(['use', 'b', '--only', 'cli'])
  expect(toasts).toEqual(['切号：ok use b --only cli'])
  const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
  expect(await ui.find({ type: 'Text', text: /ok use b --only cli/ })).toBeDefined()
})

test('要退出 Desktop 时先停下，面板里点确认才带 --yes 重跑', async ($, on) => {
  const calls: string[][] = []
  fakeScript(on, calls)
  const r = await $.command.run(slash('use b'))
  expect(r.text).toBeUndefined()
  expect(calls.some(c => c.includes('--yes'))).toBe(false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'account-switch', surface, component: 'Pane', requestId: 'claude-switch', props: PANE })
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
  // 提醒出现在 b 的卡片里，代替原来的切换按钮
  expect(await ui.find({ key: 'use-b' })).toBeUndefined()
  await ui.press({ key: 'confirm' })
  expect(calls.at(-2)).toEqual(['use', 'b', '--yes'])
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
})

test('面板列出账号，当前账号没有切换按钮', async ($, on) => {
  fakeScript(on, [])
  await $.command.run(slash(''))
  const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
  expect(await ui.find({ key: 'use-b' })).toBeDefined()
  expect(await ui.find({ key: 'use-a' })).toBeUndefined()
  await ui.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const t = await $.ui.mount({ plugin: 'account-switch', surface, component: 'Pane', requestId: 'claude-switch', props: PANE })
    expect(await t.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await t.find({ type: 'Text', text: /还没有额度记录/ })).toBeDefined()
    await t.unmount()
  }
})

test('卡片上点改名，输入新名字后运行 rename', async ($, on) => {
  const calls: string[][] = []
  fakeScript(on, calls)
  await $.command.run(slash(''))
  const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
  await ui.press({ key: 'ren-b' })
  await ui.input({ key: 'rename-b', text: 'work' })
  expect(calls.some(c => c.join(' ') === 'rename b work')).toBe(true)
  expect(await ui.find({ key: 'rename-b' })).toBeUndefined()
})

test('Desktop 当前的号固定在第一、没有箭头；其余的号之间用箭头排序', async ($, on) => {
  const calls: string[][] = []
  fakeScript(on, calls)
  STATUS.accounts.push({ name: 'c', hasCli: true, hasDesktop: true, email: 'c@example.com', plan: 'pro', usage: null })
  try {
    await $.command.run(slash(''))
    const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
    expect(await ui.find({ key: 'up-a' })).toBeUndefined() // a 是 Desktop 当前，固定在第一
    expect(await ui.find({ key: 'down-a' })).toBeUndefined()
    expect(await ui.find({ key: 'up-b' })).toBeUndefined() // b 是其余里的第一个
    expect(await ui.find({ key: 'down-b' })).toBeDefined()
    expect(await ui.find({ key: 'down-c' })).toBeUndefined()
    await ui.press({ key: 'up-c' })
    expect(calls.some(c => c.join(' ') === 'move c up')).toBe(true)
  } finally {
    STATUS.accounts.pop()
  }
})

test('后台切换进行中时自动读进度，结束后换成结果并提示', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  fakeScript(on, [])
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  STATUS.job = { state: 'quitting', message: '正在正常退出 Claude Desktop…', at: 100 }
  try {
    await $.command.run(slash(''))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'account-switch', surface, component: 'Pane', requestId: 'claude-switch', props: PANE })
      expect(await ui.find({ type: 'Text', text: /正在正常退出/ })).toBeDefined()
      await ui.unmount()
    }
    STATUS.job = { state: 'done', message: '完成：已切换到「b」', at: 101 }
    await clock.advance(2000)
    const ui = await $.ui.mount({ plugin: 'account-switch', surface: 'desktop', component: 'Pane', requestId: 'claude-switch', props: PANE })
    expect(await ui.find({ type: 'Text', text: /正在正常退出/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /已切换到「b」/ })).toBeDefined()
    expect(toasts).toEqual(['切号：完成：已切换到「b」'])
    await clock.advance(10_000) // 结束后不再轮询，也不重复提示
    expect(toasts.length).toBe(1)
  } finally {
    STATUS.job = null
  }
})
