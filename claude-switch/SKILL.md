---
name: claude-switch
description: 快速切换 Claude 账号（Claude Code CLI 和 Claude Desktop 都切），并让所有账号共用同一份 Desktop 会话列表（目录链接，不占额外空间）。用于"切换账号"、"切到 xx 号"、"换个 Claude 账号"、"保存当前账号"、"添加新账号"、"同步会话"、"看看现在是哪个账号"等。
argument-hint: "[use|save <名字>] [login-new] [status] [rename <旧> <新>] [remove <名字>] [cancel]  可加 --only cli|desktop"
---

# Claude 账号切换（claude-switch）

入口脚本是本文件所在目录下的 `claude_switch.py`（下文写作 `<技能目录>/claude_switch.py`），只用 Python 标准库。账号快照、共享会话、备份、日志都在 `~/.claude-switch/`。

运行方式（Bash）：

```bash
python -I "<技能目录>/claude_switch.py" <命令>
```

## 被调用时的做法

**用户输入 `/claude-switch` 不带参数**：直接运行 `ui` 打开「Claude 切号」窗口，不要先查状态、不要弹选择器。回复只说一句"已打开切号窗口"，再附一行可用参数（`use <名字>`、`save <名字>`、`login-new`、`status`、`rename`、`remove`、`cancel`，都可加 `--only cli|desktop`）。

**带参数**（如 `/claude-switch use _ckcyi --only cli`）：把参数原样当作命令执行。名字和已保存的账号对不上时，先运行 `status --json` 看一下，问用户一句，不要猜。

**用户用自然语言说的**：
- 说清楚了切到哪个号（"切到 _ckcyi"），直接执行对应命令。
- 只说"切号"、"打开切号界面"之类，没说切到哪个号时，运行 `ui` 打开窗口。
- 问"现在是哪个号"时，运行 `status`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `ui` | 打开「Claude 切号」图形窗口（已经开着就切到最前面，只会有一个窗口） |
| `status [--json]` | 显示 CLI / Desktop 当前账号、已保存的账号、会话共享状态 |
| `use <名字> [--only cli\|desktop]` | 切换到某个账号（默认 CLI 和 Desktop 一起切，缺哪部分快照就跳过哪部分） |
| `save <名字> [--only cli\|desktop]` | 把当前登录的账号存成快照 |
| `login-new [--only cli\|desktop]` | 先保存当前账号，再清掉登录态，准备登录一个新账号 |
| `link-sessions` / `unlink-sessions` | 开启 / 撤销 Desktop 会话共享（`use`、`save` 会自动开启） |
| `cancel` | 取消正在等 Desktop 退出的切换（此时什么都还没改） |
| `rename <旧名字> <新名字>` | 给账号快照改名（只改名字，不影响登录态） |
| `remove <名字>` | 删除一个账号快照 |

`--only cli` 只处理 CLI，`--only desktop` 只处理 Desktop，不加就两边一起处理。账号名可以用下划线开头（如 `_ckcyi`），但不能以 `-` 或 `.` 开头，也不能包含 `\ / : * ? " < > |`。

图形窗口由 `claude_switch_ui.py` 起一个只监听本机的小服务器，界面是 `ui.html`，用 pywebview 独立窗口显示（底层是系统自带的 WebView2，依赖 `pip install pywebview`）。改样式时可以用 `claude_switch_ui.py --demo` 看演示数据。终端里直接运行 `claude-switch`（不带参数）会出现编号菜单。

## 使用时注意

- **凡是涉及 Desktop 的操作都要先退出 Claude Desktop**（`use`、`save`、`login-new`、`link-sessions`、`unlink-sessions`）。Desktop 正在运行时，这些命令**不带 `--yes` 会先停下**（退出码 3），并打印打开的会话数和最近 10 分钟用过的会话标题，此时什么都没改。你要：
  1. 把这段提醒原样转告用户（会话标题都列出来），并说明：如果是在 Desktop 里的对话调用的，这个对话也会被打断，重启后从侧边栏点回来即可。
  2. 用户明确同意后，才加 `--yes` 重新运行。不要自己替用户加 `--yes`。
- 退出 Desktop 只用正常关闭，**绝不强制结束**。Desktop 弹出"是否退出"时由用户决定；如果它缩到了托盘，会等用户右键托盘图标退出，最多等 3 分钟，等不到或用户运行了 `cancel` 就放弃，什么都不改。`--force`（退不掉时强制结束）只有用户明确要求时才能用。
- 进度在 `~/.claude-switch/job.json`，日志在 `~/.claude-switch/logs/claude-switch.log`，结果也可以用 `status` 查看。
- 只切 CLI（`--only cli`）不会重启 Desktop，立即生效；但已经打开的 `claude` 终端要重开才会用新账号。
- 不要在 Desktop 里点"退出登录"：那样会让服务器端的登录失效，快照也就用不了了。添加新账号请用 `login-new`。
- 脚本不会打印 token。不要去 cat `~/.claude-switch/accounts/` 下的文件，也不要把里面的内容输出到对话里。

## 添加新账号的流程

1. `login-new`：保存当前账号 → 清掉登录态 → 重启 Desktop（显示登录页）。
2. 用户在 Desktop 登录新账号；CLI 部分则让用户在终端运行 `claude` 并 `/login`。
3. `save <新名字>`（只登录了其中一边时，加 `--only`）。

## 原理（排查问题时看）

- CLI：替换 `~/.claude/.credentials.json` 里的 `claudeAiOauth`，以及 `~/.claude.json` 里的 `oauthAccount`。其它设置不动。
- Desktop：先退出 App，再替换 Cookies、Local Storage、IndexedDB 等登录相关文件，以及 `config.json` 里 `oauth:*` 和 `lastKnownAccountUuid` 这几项，然后重启。MCP 配置（`claude_desktop_config.json`）所有账号共用，不切换。
- 切走之前，会先把当前账号最新的登录态写回它自己的快照（token 会轮换，不这样做旧快照会失效）。
- 会话共享：`claude-code-sessions/<账号>/<组织>` 都做成 junction，指向 `~/.claude-switch/shared/claude-code-sessions`。对话记录本身在 `~/.claude/projects`，本来就是共用的。
- Desktop 的操作由 WMI 启动的独立进程完成，不在 Desktop 的进程树里，所以 Desktop 退出时它不会被一起结束。
- 每次切换前都会备份当前登录态到 `~/.claude-switch/backups/`（保留最近 5 份）；第一次开启共享前，原会话目录备份在 `backups/sessions-before-link/`。
