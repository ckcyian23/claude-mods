# claude-mods

我自己的 Claude Code 扩展库：插件放在 `mods/`，skill 放在仓库根目录（每个带 `SKILL.md` 的文件夹算一个）。

## 插件

| 插件 | 作用 | 依赖 |
| --- | --- | --- |
| [account-switch](mods/account-switch/README.md) | 一键切换 Claude 账号（CLI 和 Desktop 都切），切号时自动合并各账号的 Desktop 会话列表。在 Claude 里输入 `/claude-switch` 打开切号面板。 | Python 3.12+ |
| [caffeine-compact](mods/caffeine-compact/README.md) | 保活 + 自动压缩二合一：上下文不大不管；超过大小线时，没开保活就在 cache 过期前压缩，开了保活就保活一段时间，到点转入压缩。命令 `/caffeine`。 | 无 |

根目录的 `.claude-plugin/marketplace.json` 把本仓库登记成本地插件市场 `ckcyi-mods`。先把它加进来：

```bash
claude plugin marketplace add D:\Claude\Projects\claude-skills
```

再安装插件：

```bash
claude plugin install account-switch@ckcyi-mods --scope user
```

插件直接从仓库目录读取。改了代码以后，在会话里运行 `/reload-plugins` 就生效，不用重新安装。

## 终端命令和 skill

```bash
python install.py
```

这条命令做两件事：

- 把 `bin/` 里的命令装到 `~/.local/bin`。现在只有 `claude-switch`，它在终端里直接运行切号脚本，不带参数时显示编号菜单。
- 如果仓库里有 skill，就在 `~/.claude/skills/<名字>` 建一个指向本仓库的目录链接，所以改代码立即生效。目前仓库里没有 skill。

查看安装状态：

```bash
python install.py --list
```

## 测试

插件测试：

```bash
claude plugin test mods/account-switch
```

切号脚本的测试：

```bash
python -I mods/account-switch/tests/test_switch.py
```

```bash
python -I mods/account-switch/tests/test_quit.py
```

脚本测试都在系统临时目录的沙盒里运行，用的是假 token 和假的 Desktop 目录，不会碰真实的登录态，也不会关掉正在运行的 Claude Desktop。

## 新增 skill

1. 在仓库根目录建一个文件夹，放入 `SKILL.md`，开头的 `name` 要和文件夹名一致。
2. 运行 `python install.py`。
3. 在本文件里加一段介绍，然后提交。
