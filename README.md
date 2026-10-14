# claude-skills

我自己的 Claude Code skill 库。仓库里每个带 `SKILL.md` 的文件夹就是一个 skill；装到本机时，`~/.claude/skills/<名字>` 只是一个指向本仓库的目录链接，所以在这里改代码立即生效，不用重新安装。

## 安装 / 更新

```bash
python install.py
```

查看安装状态：

```bash
python install.py --list
```

- 可以反复运行。只装某几个 skill：`python install.py claude-switch`。
- `bin/` 里的命令会复制到 `~/.local/bin`。
- `~/.claude/skills` 下如果已经有同名的普通目录（不是指向本仓库的链接），安装脚本不会动它，会提示你自己处理。

## Skill 列表

| Skill | 作用 | 依赖 |
| --- | --- | --- |
| [claude-switch](claude-switch/SKILL.md) | 一键切换 Claude 账号（CLI 和 Desktop 都切），所有账号共用同一份 Desktop 会话列表。带图形窗口「Claude 切号」。 | Python 3.12+；图形窗口需要 `pip install pywebview`（Windows 11 自带 WebView2） |

### claude-switch 首次使用

```bash
pip install pywebview
```

装好后在 Claude 里输入 `/claude-switch` 就会打开「Claude 切号」窗口；后面带参数（如 `/claude-switch use 名字`）则直接执行对应命令。账号快照存在 `~/.claude-switch/`，里面有登录凭据，**不在仓库里，也不要放进来**。

## 测试

```bash
python -I tests/claude-switch/test_switch.py
```

```bash
python -I tests/claude-switch/test_quit.py
```

都在系统临时目录的沙盒里运行，用假的 token 和假的 Desktop 目录，不会碰真实登录态，也不会关掉正在运行的 Claude Desktop。

## 新增 skill

1. 在仓库根目录建一个文件夹，放入 `SKILL.md`（开头的 `name` 和文件夹名一致）。
2. 运行 `python install.py`。
3. 在上面的 Skill 列表里加一行，提交。
