// claude-switch 的 mod 外壳：/claude-switch 由这里直接执行（不经过模型），面板里点按钮切号。
// 真正干活的是同一插件里的 scripts/claude_switch.py，这里只负责调用它、显示结果。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, Pending, Status, Usage } from '../types'

const COMMAND = 'claude-switch'
const PANE = 'claude-switch'
const HINT = '[use|save <名字>] [login-new] [status] [sync-sessions] [rename <旧> <新>] [remove <名字>] [cancel]  可加 --only cli|desktop'
// 这些命令会切 Desktop，Desktop 开着时脚本先停下（退出码 3）等用户确认
const NEEDS_CONFIRM = 3

const status = atom({ plugin: 'account-switch', key: 'status' } as const, null)
const pending = atom({ plugin: 'account-switch', key: 'pending' } as const, null)
const message = atom({ plugin: 'account-switch', key: 'message' } as const, '')
const busy = atom({ plugin: 'account-switch', key: 'busy' } as const, false)
const showSave = atom({ plugin: 'account-switch', key: 'showSave' } as const, false)
const renaming = atom({ plugin: 'account-switch', key: 'renaming' } as const, null)
const removing = atom({ plugin: 'account-switch', key: 'removing' } as const, null)
const showAdd = atom({ plugin: 'account-switch', key: 'showAdd' } as const, false)

type Run = { code: number; out: string }
type $ = EngineInterface

function script($: $): string {
  return `${$.plugin.root}\\scripts\\claude_switch.py`
}

async function run($: $, args: string[]): Promise<Run> {
  try {
    const r = await $.process.run(['python', '-I', script($), ...args], { timeoutMs: 120_000 })
    return { code: r.exitCode, out: `${r.stdout}${r.stderr}`.trim() }
  } catch (err) {
    return { code: -1, out: `运行 claude_switch.py 失败：${String(err)}` }
  }
}

async function refresh($: $) {
  const r = await run($, ['status', '--json'])
  if (r.code !== 0) return null
  try {
    const s = { ...(JSON.parse(r.out) as Status), fetchedAt: Date.now() }
    await update($, status, () => s)
    if (isRunning(s)) void watchJob($)
    return s
  } catch {
    return null
  }
}

// 执行一条命令；需要确认时记下来，等用户在面板里点确认
async function act($: $, args: string[], at?: string): Promise<Run> {
  await update($, busy, () => true)
  await update($, message, () => `正在执行：${args.join(' ')}…`)
  const r = await run($, args)
  if (r.code === NEEDS_CONFIRM) {
    // 提醒显示在点的按钮旁边：切某个号就在那张卡片里，其它操作在底部
    const where = at ?? (args[0] === 'use' && args[1] ? args[1] : 'footer')
    const p: Pending = { args, where, text: r.out.replace(/\n?确认没问题后，加 --yes 重新运行。?/, '') }
    await update($, pending, () => p)
    await update($, message, () => '')
  } else {
    await update($, pending, () => null)
    await update($, message, () => r.out || (r.code === 0 ? '完成' : `失败（退出码 ${r.code}）`))
  }
  await refresh($)
  await update($, busy, () => false)
  return r
}

const FINISHED = ['done', 'failed', 'cancelled', 'idle']
const isRunning = (s: Status | null) => !!s?.job && !FINISHED.includes(s.job.state)

// 报一次后台切换的结果（同一次只报一次，换了会话也不重复）
async function reportJob($: $, job: NonNullable<Status['job']>) {
  if ((await $.store.get('lastJobAt')) === job.at) return
  await $.store.set('lastJobAt', job.at)
  await update($, message, () => `切号：${job.message}`)
  $.ui.toast(`切号：${job.message}`)
}

let watching = false
// 后台切换（要退出、重开 Desktop）进行中时每 2 秒读一次进度，结束后报结果再停；
// 不然面板只在重绘时才读状态，会一直停在「准备退出…」
async function watchJob($: $) {
  if (watching) return
  watching = true
  try {
    for (let i = 0; i < 300; i++) { // 脚本最多等 Desktop 3 分钟，这里留到 10 分钟
      await $.clock.sleep(2000)
      const s = await refresh($)
      if (!s?.job) break
      if (!isRunning(s)) {
        await reportJob($, s.job)
        break
      }
    }
  } finally {
    watching = false
  }
}

let refreshing = false
// 面板显示的状态超过 30 秒就在后台重新读一次（mod 重新加载后、切号回来后都靠它更新）
function refreshIfStale($: $, s: Status | null) {
  if (refreshing || (s && Date.now() - (s.fetchedAt ?? 0) < 30_000)) return
  refreshing = true
  void refresh($).finally(() => {
    refreshing = false
  })
}

async function press($: $, args: string[], at?: string) {
  if (await read($, busy)) return
  await act($, args, at)
}

// ---------------------------------------------------------------- 显示用的小工具

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 「22:59」「昨天 21:09」「周三 08:00」「10-13 21:09」
function when(seconds: number): string {
  const d = new Date(seconds * 1000)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) return hm
  if (days === -1) return `昨天 ${hm}`
  if (days === 1) return `明天 ${hm}`
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

function barColor(pct: number): string {
  return pct >= 95 ? '#E24B4A' : pct >= 80 ? '#BA7517' : '#1D9E75'
}

function barSvg(pct: number): string {
  const w = Math.max(0, Math.min(100, pct)) * 1.6
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="6" viewBox="0 0 160 6" preserveAspectRatio="none">` +
    `<rect width="160" height="6" rx="3" fill="#8888882e"/>` +
    (w > 0 ? `<rect width="${Math.max(w, 6)}" height="6" rx="3" fill="${barColor(pct)}"/>` : '') +
    `</svg>`
  )
}

function barText(pct: number): string {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return '▓'.repeat(n) + '░'.repeat(10 - n)
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

// 一行额度：「5 小时  ▓▓▓░░  25%  23:40 重置」
function quotaRow(ui: Ui, key: string, label: string, u: Usage, which: 'fh' | 'sd') {
  const { Box, Text } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const isReset = u[`${which}IsReset`]
  const pct = isReset ? 0 : (u[which] ?? 0)
  const reset = u[`${which}Reset`]
  const note = isReset ? '已恢复' : reset ? `${when(reset)} 重置` : `${when(u.at)} 记录`
  return (
    <Box key={key} columnGap={1} alignItems="center" flexWrap="wrap">
      <Box width={6}>
        <Text dimColor>{label}</Text>
      </Box>
      {Svg ? <Svg source={barSvg(pct)} alt={`${label}已用 ${Math.round(pct)}%`} width={120} height={6} /> : <Text>{barText(pct)}</Text>}
      <Box width={5}>
        <Text>{`${Math.round(pct)}%`}</Text>
      </Box>
      <Text dimColor>{note}</Text>
    </Box>
  )
}

// 要退出 Desktop 的操作先停在这里，等用户点确认
function confirmBox($: $, ui: Ui, p: Pending) {
  const { Box, Text, Button } = ui
  return (
    <Box key="confirm-box" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
      <Text>{p.text}</Text>
      <Box columnGap={1} marginTop={1} flexWrap="wrap">
        <Button key="confirm" variant="primary" label="确认退出并继续" onPress={() => press($, [...p.args, '--yes'], p.where === 'footer' ? undefined : p.where)} />
        <Button key="dismiss" label="取消" onPress={() => update($, pending, () => null)} />
      </Box>
    </Box>
  )
}

// 删除快照前在卡片里再确认一次
function removeBox($: $, ui: Ui, name: string) {
  const { Box, Text, Button } = ui
  return (
    <Box key={`remove-box-${name}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginTop={1}>
      <Text>{`删除「${name}」的账号快照？只删快照（移到回收站），不会退出登录。`}</Text>
      <Box columnGap={1} marginTop={1} flexWrap="wrap">
        <Button
          key={`remove-confirm-${name}`}
          variant="primary"
          label="确认删除"
          onPress={() => update($, removing, () => null).then(() => press($, ['remove', name]))}
        />
        <Button key={`remove-cancel-${name}`} label="取消" onPress={() => update($, removing, () => null)} />
      </Box>
    </Box>
  )
}

// 调整顺序：不显示「执行中」之类的提示，挪完直接重读
async function moveCard($: $, name: string, direction: 'up' | 'down') {
  if (await read($, busy)) return
  await run($, ['move', name, direction])
  await refresh($)
}

// 卡片标题：账号名 + 当前标签 + 上下箭头；改名时换成输入框
function cardTitle($: $, ui: Ui, a: Account, isCli: boolean, isDesk: boolean, isRenaming: boolean, isFirst: boolean, isLast: boolean) {
  const { Box, Text, Button } = ui
  const Input = 'Input' in ui ? ui.Input : null
  if (isRenaming && Input) {
    return (
      <Box key={`title-${a.name}`} columnGap={1} alignItems="center" flexWrap="wrap">
        <Input
          key={`rename-${a.name}`}
          value={a.name}
          autoFocus
          submitLabel="改名"
          onSubmit={(name: string) => {
            const to = name.trim()
            void update($, renaming, () => null)
            if (to && to !== a.name) void press($, ['rename', a.name, to])
          }}
        />
        <Button key={`rename-cancel-${a.name}`} plain dimColor label="取消" onPress={() => update($, renaming, () => null)} />
      </Box>
    )
  }
  return (
    <Box key={`title-${a.name}`} columnGap={1} alignItems="center" flexWrap="wrap">
      <Text bold weight="medium" size="heading">{a.name}</Text>
      {Input && (
        <Button key={`ren-${a.name}`} plain dimColor label="改名" onPress={() => update($, renaming, () => a.name)} />
      )}
      <Button key={`del-${a.name}`} plain dimColor label="删除" onPress={() => update($, removing, () => a.name)} />
      <Box flexGrow={1} />
      {isCli && <Text color="suggestion">CLI</Text>}
      {isDesk && <Text color="suggestion">Desktop</Text>}
      {!isFirst && <Button key={`up-${a.name}`} plain dimColor label="↑" onPress={() => moveCard($, a.name, 'up')} />}
      {!isLast && <Button key={`down-${a.name}`} plain dimColor label="↓" onPress={() => moveCard($, a.name, 'down')} />}
    </Box>
  )
}

function accountCard($: $, ui: Ui, s: Status, a: Account, p: Pending | null, isRenaming: boolean, isRemoving: boolean, isFirst: boolean, isLast: boolean) {
  const { Box, Text, Button } = ui
  const isCli = s.cli.current === a.name
  const isDesk = s.desktop.current === a.name
  const isCurrent = isCli || isDesk
  const plan = a.plan ? ` · ${a.plan.charAt(0).toUpperCase()}${a.plan.slice(1)}` : ''
  return (
    <Box
      key={`card-${a.name}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={isCurrent ? 'suggestion' : 'inactive'}
      paddingX={1}
    >
      {cardTitle($, ui, a, isCli, isDesk, isRenaming, isFirst, isLast)}
      <Text dimColor size="footnote">{`${a.email ?? '邮箱未知'}${plan}`}</Text>
      {a.usage ? (
        <Box flexDirection="column" marginTop={1}>
          {quotaRow(ui, `fh-${a.name}`, '5 小时', a.usage, 'fh')}
          {quotaRow(ui, `sd-${a.name}`, '本周', a.usage, 'sd')}
        </Box>
      ) : (
        <Text dimColor>还没有额度记录</Text>
      )}
      {isRemoving ? (
        removeBox($, ui, a.name)
      ) : p?.where === a.name ? (
        confirmBox($, ui, p)
      ) : !(isCli && isDesk) && (
        <Box columnGap={2} marginTop={1} alignItems="center" flexWrap="wrap">
          {a.hasCli && a.hasDesktop && (
            <Button key={`use-${a.name}`} label="切换到这个号" onPress={() => press($, ['use', a.name])} />
          )}
          {a.hasCli && !isCli && (
            <Button key={`cli-${a.name}`} plain dimColor label="只切 CLI" onPress={() => press($, ['use', a.name, '--only', 'cli'])} />
          )}
          {a.hasDesktop && !isDesk && (
            <Button key={`desk-${a.name}`} plain dimColor label="只切 Desktop" onPress={() => press($, ['use', a.name, '--only', 'desktop'])} />
          )}
          {!a.hasDesktop && !isDesk && (
            <Button key={`login-desk-${a.name}`} plain label="登录 Desktop" onPress={() => press($, ['login-new', '--only', 'desktop'], a.name)} />
          )}
          {!a.hasCli && !isCli && (
            <Button key={`login-cli-${a.name}`} plain label="登录 CLI" onPress={() => press($, ['login-new', '--only', 'cli'], a.name)} />
          )}
        </Box>
      )}
      {isDesk && s.desktop.saved === false && <Text dimColor size="footnote">Desktop 已登录这个号，下次切号时自动保存</Text>}
      {isCli && s.cli.saved === false && <Text dimColor size="footnote">CLI 已登录这个号，下次切号时自动保存</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined) // 不在底部状态栏显示账号（清掉旧版本留下的那条）
    await $.command.register({
      name: COMMAND,
      description: '切换 Claude 账号：不带参数打开面板，带参数直接执行',
      argumentHint: HINT,
      immediate: true, // 任务进行中输入也立刻执行，不排队、不打断正在跑的任务
    })
    const s = await refresh($)
    // 上一次切号由后台进程完成（Desktop 重启了，原来的会话已经断开），在新会话里报一下结果
    const job = s?.job
    if (job && !isRunning(s)) {
      if (Date.now() / 1000 - job.at < 15 * 60) await reportJob($, job)
      else await $.store.set('lastJobAt', job.at)
    }
    return started
  })

  // 结果只显示在面板和提示条里，不作为命令输出写进对话：写进对话的内容下一轮会发给模型，白花 token
  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    if (args.length === 0 || args[0] === 'ui') {
      await refresh($)
    } else {
      const r = await act($, args) // 结果写在面板的提示行；要确认时提醒显示在面板里
      if (r.code !== NEEDS_CONFIRM) $.ui.toast(`切号：${(r.out || '完成').split('\n')[0]}`)
    }
    const opened = await $.ui.open({ id: PANE, title: 'Claude 切号' })
    return opened.isPlaced ? {} : { text: `切号面板没能显示：${opened.reason}` }
  }).catch(($, e, next) => (next.called ? next(e) : { text: '切号插件出错了，详情见调试日志' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : null // 手机端没有输入框
    const s = await read($, status)
    const p = await read($, pending)
    const msg = await read($, message)
    const isBusy = await read($, busy)
    const isSaveOpen = await read($, showSave)
    const editing = await read($, renaming)
    const toRemove = await read($, removing)
    const isAddOpen = await read($, showAdd)
    refreshIfStale($, s)

    if (!s) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>读取账号状态失败。</Text>
          <Button key="refresh" label="重试" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const job = isRunning(s) ? s.job : null
    const sync = s.sessions.links ? '会话目录需要修复' : `同步会话 · ${s.sessions.count} 个`
    // 脚本给出的顺序：Desktop 当前的号固定在第一（不显示箭头），其余按用户排的顺序
    const accounts = s.accounts
    const last = accounts.length - 1
    const first = accounts[0]?.name === s.desktop.current ? 1 : 0
    const isPinned = (a: Account) => a.name === s.desktop.current

    return (
      <Box flexDirection="column" gap={1}>
        {s.cli.loggedIn && s.cli.verified === false && (
          <Text color="warning">确认不了 CLI 当前凭证属于哪个号，CLI 标签可能不准</Text>
        )}

        {accounts.map((a, i) =>
          accountCard($, ui, s, a, p, editing === a.name, toRemove === a.name, isPinned(a) || i <= first, isPinned(a) || i === last),
        )}

        <Box columnGap={2} alignItems="center" flexWrap="wrap">
          <Button key="login-new" plain label={isAddOpen ? '收起' : '+ 添加账号…'} onPress={() => update($, showAdd, v => !v)} />
          <Button key="sync" plain label={`⇄ ${sync}`} onPress={() => press($, ['sync-sessions'])} />
          {Input && (
            <Button key="toggle-save" plain label={isSaveOpen ? '收起' : '保存当前账号…'} onPress={() => update($, showSave, v => !v)} />
          )}
        </Box>

        {isAddOpen && (
          <Box columnGap={2} alignItems="center" flexWrap="wrap">
            <Text dimColor>登录新账号：</Text>
            {(
              [
                ['add-both', 'CLI + Desktop', []],
                ['add-desktop', '只加 Desktop', ['--only', 'desktop']],
                ['add-cli', '只加 CLI', ['--only', 'cli']],
              ] as const
            ).map(([key, label, only]) => (
              <Button key={key} plain label={label} onPress={() => update($, showAdd, () => false).then(() => press($, ['login-new', ...only]))} />
            ))}
          </Box>
        )}

        {p && !accounts.some(a => a.name === p.where) && confirmBox($, ui, p)}

        {Input && isSaveOpen && (
          <Input
            key="save"
            label="保存为"
            placeholder="账号名，已存过的号会沿用原名"
            submitLabel="保存"
            onSubmit={(name: string) => {
              if (name.trim()) void press($, ['save', name.trim()]).then(() => update($, showSave, () => false))
            }}
          />
        )}

        {job && (
          <Box columnGap={1} alignItems="center" flexWrap="wrap">
            <Text color="warning">{job.message}</Text>
            <Button key="cancel-job" plain label="取消切换" onPress={() => press($, ['cancel'])} />
          </Box>
        )}

        {(isBusy || msg) && <Text dimColor>{isBusy ? '执行中…' : msg}</Text>}
      </Box>
    )
  })
}
