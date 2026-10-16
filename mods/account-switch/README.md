# account-switch：Claude 账号切换插件

在 Claude Code 里切换 Claude 账号：CLI 和 Claude Desktop 都能切，切号时会自动合并各账号的 Desktop 会话列表。

在 Claude 里输入 `/claude-switch`：
- **不带参数**：打开「Claude 切号」面板，在面板里点按钮切号。
- **带参数**（如 `/claude-switch use 1 --only cli`）：直接执行这条命令。

这两种用法都不经过模型，不花 token。

## 文件

| 路径 | 作用 |
| --- | --- |
| `hooks/register.tsx` | 插件本体：注册 `/claude-switch`，画面板，调用脚本 |
| `scripts/claude_switch.py` | 真正干活的脚本，只用 Python 标准库；也可以在终端里直接运行 |
| `types/index.d.ts` | 面板状态和脚本 `status --json` 输出的类型 |
| `hooks/switch.test.ts` | 插件测试：`claude plugin test mods/account-switch` |
| `tests/*.py` | 脚本测试，在临时目录的沙盒里运行，不会碰真实登录态，也不会关掉 Desktop |

账号快照、会话合并副本、备份、日志都放在 `~/.claude-switch/`。这个目录里有登录凭据，**不在仓库里，也不要放进来**。

## 安装

本仓库根目录的 `.claude-plugin/marketplace.json` 把本仓库登记成一个本地插件市场：

```bash
claude plugin marketplace add D:\Claude\Projects\claude-skills
```

```bash
claude plugin install account-switch@ckcyi-mods --scope user
```

插件直接从本目录读取，改了代码以后，在会话里运行 `/reload-plugins` 就生效，不用重新安装。

终端命令 `claude-switch`（不带参数时显示编号菜单）由仓库根目录的 `python install.py` 装到 `~/.local/bin`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `status [--json]` | 显示 CLI 和 Desktop 当前的账号、已保存的账号、额度和会话同步状态 |
| `use <名字> [--only cli\|desktop]` | 切换到某个账号。默认 CLI 和 Desktop 一起切，缺哪边的快照就跳过哪边 |
| `save <名字> [--only cli\|desktop]` | 把当前登录的账号存成快照 |
| `login-new [--only cli\|desktop]` | 先保存当前账号，再清掉登录态，准备登录新账号 |
| `sync-sessions` | 手动合并所有账号的 Desktop 会话列表（`use`、`save`、`login-new` 会自动合并） |
| `cancel` | 取消正在等 Desktop 退出的切换（这时还什么都没改） |
| `rename <旧名字> <新名字>` | 给账号快照改名（只改名字，不影响登录态） |
| `remove <名字>` | 删除一个账号快照 |
| `move <名字> up\|down` | 调整账号在面板里的顺序（Desktop 当前的号固定排在第一个） |

`--only cli` 只处理 CLI，`--only desktop` 只处理 Desktop，不加就两边一起处理。账号名可以用下划线开头，但不能以 `-` 或 `.` 开头，也不能包含 `\ / : * ? " < > |`。

## 使用时注意

- **涉及 Desktop 的操作都要先退出 Claude Desktop**（`use`、`save`、`login-new`、`sync-sessions`）。Desktop 正在运行时，这些命令不带 `--yes` 会先停下（退出码 3），列出打开的会话数和最近 10 分钟用过的会话标题，这时什么都没改。面板会在你点的按钮旁边显示这段提醒，你点「确认」后才会带上 `--yes` 重新运行。在 Desktop 里的对话会跟着断开，Desktop 重启后从侧边栏点回去即可。
- **退出 Desktop 只用正常关闭，绝不强制结束。** 脚本会给 Desktop 发 Windows 注销时的"会话即将结束"通知，Desktop 收到后走自己的退出流程，和右键托盘图标点「退出」一样。如果 Desktop 弹窗询问，由你决定；最多等 3 分钟，等不到或者运行了 `cancel` 就放弃，什么都不改。`--force`（退不掉时强制结束）只有你明确要求时才用。
- 进度在 `~/.claude-switch/job.json`，日志在 `~/.claude-switch/logs/claude-switch.log`。后台切换进行时，面板每 2 秒读一次进度，完成后会提示结果。
- 只切 CLI（`--only cli`）不会重启 Desktop，立即生效；但已经打开的 `claude` 终端要重开才会用新账号。
- **切号会让当前会话的提示缓存失效。** 缓存按组织隔离，每个号是一个单独的组织，切号后第一次请求要在新账号下把整段对话重新写进缓存。长会话最好先 `/compact` 再切，或者切号后开新会话。
- 不要在 Desktop 里点"退出登录"：那样会让服务器端的登录失效，快照也就用不了了。添加新账号请用 `login-new`。
- 脚本不会打印 token。不要去看 `~/.claude-switch/accounts/` 下的文件，也不要把里面的内容贴出来。

## 添加新账号

1. 运行 `login-new`：保存当前账号，清掉登录态，然后重启 Desktop，显示登录页。
2. 在 Desktop 里登录新账号；CLI 那边在终端运行 `claude`，再用 `/login` 登录。
3. 运行 `save <新名字>`。如果只登录了其中一边，加上 `--only`。

## 原理（排查问题时看）

- **CLI**：替换 `~/.claude/.credentials.json` 里的 `claudeAiOauth`，以及 `~/.claude.json` 里的 `oauthAccount`，其它设置不动。
- **Desktop**：先退出 App，再替换 Cookies、Local Storage、IndexedDB 等登录相关的文件，以及 `config.json` 里的 `oauth:*` 和 `lastKnownAccountUuid`，然后重启。MCP 配置（`claude_desktop_config.json`）所有账号共用，不切换。
- **切走之前先写回快照**：token 会轮换，所以切走前会把当前账号最新的登录态写回它自己的快照，否则旧快照会失效。
- **怎么判断 CLI 当前是哪个号**：看凭证本身，不看 `~/.claude.json` 里的账号信息，因为 Desktop 托管的会话会把它改成 Desktop 的账号。依次这样判断：
  1. 刷新 token 和某个快照一样，就是那个号；
  2. 否则问一次服务器，结果按凭证指纹缓存在 `cli-owner.json`（只存指纹，不存凭证）。

  确认不了时不往任何快照写，只做备份，避免把 A 的凭证写进 B 的快照。`save` 时如果发现两边对不上，会把 `~/.claude.json` 改成凭证所属的账号。
- **`save` 的名字有容错**：这个账号已经存过（CLI 或 Desktop 任一边），就沿用原来的名字并提示；名字被另一个账号占了，就拒绝。
- **额度**：显示每个号最后一次记录的值，不联网刷新。数据有两个来源：
  - Desktop 自己的记录 `plan-usage-history.json`；
  - 保存快照时顺便查的一次，存在 `usage.json`，带重置时间。

  到了重置时间就显示为已恢复；不知道重置时间时，按 5 小时 / 7 天推算。
- **怎样退出 Desktop**：点关闭按钮，或者用不带 `/F` 的 `taskkill`，Desktop 只会缩到托盘。它只在收到 Windows 的 `WM_ENDSESSION` 时才调用自己的退出流程，所以脚本先发 `WM_QUERYENDSESSION`，窗口同意后再发 `WM_ENDSESSION`。找不到 Desktop 的窗口时，才退回用不带 `/F` 的 `taskkill`。
- **会话同步的做法**：Desktop 的会话列表在 `claude-code-sessions/<账号>/<组织>/local_*.json`。每次 Desktop 退出后（切号、保存、`sync-sessions`），把所有账号的目录合并：
  - 同名文件取修改时间最新的；
  - 有 `deleted_<id>` 标记的会话，在所有账号里都删掉；
  - 合并后的副本另存在 `~/.claude-switch/shared/claude-code-sessions`。

  对话记录本身在 `~/.claude/projects`，本来就是各账号共用的。
- **会话同步为什么用复制，不用硬链接**：Desktop 保存会话的方式是"先写临时文件，再改名覆盖"，硬链接在第一次保存时就会断开，另一个账号会悄悄留着旧内容。复制全部会话不到 0.1 秒，所以直接复制合并。
- **会话目录绝不能做成链接（junction / symlink）**：Desktop 发现是链接会拒绝写入，日志里显示 `Refusing non-directory at private dir path (symlink/file plant)`。这样会话的新建、改名、续写都存不下来，重启后会话会丢失或内容回退。旧版本留下的链接，`sync-sessions` 会自动换回真实目录。
- **后台进程**：Desktop 相关的操作由 WMI 启动的独立进程完成。它不在 Desktop 的进程树里，所以 Desktop 退出时不会被一起结束。
- **备份**：
  - 每次切换前，当前登录态会备份到 `~/.claude-switch/backups/`；
  - 每次合并会话前，各账号的会话目录会备份到 `backups/sessions-<时间>/`。

  两者都只保留最近 5 份。
