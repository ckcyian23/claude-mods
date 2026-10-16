// claude_switch.py status --json 的输出（只有账号名、邮箱、套餐、额度，没有 token）
export type Side = { current: string | null; email: string | null; loggedIn: boolean; verified?: boolean }
// 额度：fh = 5 小时窗口，sd = 本周窗口，百分比；Reset 是重置时间（秒），IsReset 表示已经到点恢复
export type Usage = {
  at: number
  fh: number | null
  fhReset: number | null
  fhIsReset: boolean
  sd: number | null
  sdReset: number | null
  sdIsReset: boolean
}
export type Account = {
  name: string
  hasCli: boolean
  hasDesktop: boolean
  email: string | null
  plan: string | null
  usage: Usage | null
}
export type Status = {
  cli: Side
  desktop: Side & { running: boolean; activity?: { open: number; recent: string[] } }
  job: { state: string; message: string; at: number } | null
  accounts: Account[]
  sessions: { accounts: number; count: number; inSync: boolean; links: number }
  fetchedAt?: number // mod 读到这份状态的时间（毫秒）
}
// 等用户确认退出 Desktop 的操作：确认后带 --yes 重新运行 args；where 是提醒显示的位置（账号名，或 footer）
export type Pending = { args: string[]; where: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'account-switch': {
      status: Status | null
      pending: Pending | null
      message: string
      busy: boolean
      showSave: boolean
      renaming: string | null // 正在改名的账号
    }
  }
}
