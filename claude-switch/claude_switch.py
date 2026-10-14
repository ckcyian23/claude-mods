"""claude-switch: Claude 账号快速切换（CLI + Desktop）与 Desktop 会话共享。

只用标准库。账号快照、共享会话、备份、日志都放在 ~/.claude-switch/ 下。
任何输出都不打印 token / cookie 内容。

用法:
  claude_switch.py                                      交互菜单（选编号切换）
  claude_switch.py status [--json]
  claude_switch.py save <名字> [--only cli|desktop]      把当前登录的账号存成快照
  claude_switch.py use <名字>  [--only cli|desktop]      切换到某个账号
  claude_switch.py login-new   [--only cli|desktop]      清掉当前登录态，准备登录一个新账号
  claude_switch.py link-sessions                        让所有账号共用同一份 Desktop 会话列表
  claude_switch.py unlink-sessions                      撤销共享，各账号恢复成独立的真实目录
  claude_switch.py rename <旧名字> <新名字>             给账号快照改名
  claude_switch.py remove <名字>                        删除一个账号快照
  claude_switch.py shortcut                             创建「Claude 切号」图形窗口的快捷方式

Desktop 相关操作需要先退出 Claude Desktop；如果 Desktop 正在运行，会交给一个
独立的后台进程执行（退出 → 处理 → 重新启动），所以从 Desktop 会话里调用也没问题。
"""

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HOME = Path.home()
DATA = HOME / ".claude-switch"
ACCOUNTS = DATA / "accounts"
SHARED_SESSIONS = DATA / "shared" / "claude-code-sessions"
BACKUPS = DATA / "backups"
LOG_FILE = DATA / "logs" / "claude-switch.log"
LOCK_FILE = DATA / "switch.lock"
CONFIG_FILE = DATA / "config.json"
JOB_FILE = DATA / "job.json"      # 后台切换的进度，图形窗口读它显示
CANCEL_FILE = DATA / "cancel"     # 存在就表示用户点了取消
KEEP_BACKUPS = 5

# Desktop 登录态相关的条目（参考 cockpit-tools 的 CLAUDE_DESKTOP_PROFILE_ITEMS）。
# claude_desktop_config.json（MCP 配置）故意不切换，所有账号共用。
DESKTOP_ITEMS = [
    "Local State",
    "Preferences",
    "Cookies",
    "Cookies-journal",
    "Network",
    "DIPS",
    "DIPS-wal",
    "SharedStorage",
    "SharedStorage-wal",
    "WebStorage",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
    "Service Worker",
    "ant-did",
]
# 快照里没有时也保留现状的条目（其余条目快照里没有就删掉，避免两个账号的登录态混在一起）
DESKTOP_KEEP_IF_MISSING = {"Local State", "Preferences", "ant-did"}
DESKTOP_CONFIG_AUTH_PREFIX = "oauth:"
DESKTOP_CONFIG_AUTH_KEYS = {"lastKnownAccountUuid"}


# ---------------------------------------------------------------- 基础工具

def log(msg):
    line = f"[{_dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(msg)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


LAST_ERROR = [None]


def die(msg):
    LAST_ERROR[0] = msg
    log("错误：" + msg)
    sys.exit(1)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        die(f"{path} 不是合法 JSON：{e}")


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".ccs-tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def now_stamp():
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def retry(fn, what, attempts=12, delay=0.5):
    for i in range(attempts):
        try:
            return fn()
        except PermissionError as e:
            if i == attempts - 1:
                die(f"{what} 失败（文件被占用，Claude Desktop 可能还没完全退出）：{e}")
            time.sleep(delay)


def remove_path(p):
    p = Path(p)
    if is_junction(p):
        os.rmdir(p)
    elif p.is_symlink():
        p.unlink()
    elif p.is_dir():
        retry(lambda: shutil.rmtree(p), f"删除 {p}")
    elif p.exists():
        retry(lambda: p.unlink(), f"删除 {p}")


def copy_path(src, dst):
    src, dst = Path(src), Path(dst)
    remove_path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        retry(lambda: shutil.copytree(src, dst, ignore=shutil.ignore_patterns("LOCK")),
              f"复制 {src}")
    else:
        retry(lambda: shutil.copy2(src, dst), f"复制 {src}")


def is_junction(p):
    try:
        return os.path.isjunction(p)
    except AttributeError:  # Python < 3.12
        try:
            return bool(os.lstat(p).st_file_attributes & 0x400) and not os.path.islink(p)
        except OSError:
            return False


NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW：从图形窗口调用时不弹出命令框


def run_hidden(args, **kw):
    return subprocess.run(args, capture_output=True, creationflags=NO_WINDOW, **kw)


def make_junction(link, target):
    r = run_hidden(["cmd", "/c", "mklink", "/J", str(link), str(target)])
    if r.returncode != 0:
        die(f"创建目录链接失败：{link} -> {target}："
            + r.stderr.decode("gbk", "replace").strip())


def powershell(cmd, env=None):
    r = run_hidden(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], env=env)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip()


def list_processes():
    """[(pid, 可执行文件完整路径)]，直接调用 Windows API，不启动任何外部程序。"""
    import ctypes
    from ctypes import wintypes
    psapi, k32 = ctypes.WinDLL("psapi"), ctypes.WinDLL("kernel32")
    k32.OpenProcess.restype = wintypes.HANDLE
    arr = (wintypes.DWORD * 8192)()
    needed = wintypes.DWORD()
    if not psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
        return []
    buf = ctypes.create_unicode_buffer(1024)
    res = []
    for pid in arr[:needed.value // ctypes.sizeof(wintypes.DWORD)]:
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            continue
        size = wintypes.DWORD(len(buf))
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            res.append((pid, buf.value))
        k32.CloseHandle(h)
    return res


class Lock:
    def __enter__(self):
        DATA.mkdir(parents=True, exist_ok=True)
        if LOCK_FILE.exists() and time.time() - LOCK_FILE.stat().st_mtime < 300:
            die("另一个切换操作正在进行（如果确认没有，删除 ~/.claude-switch/switch.lock 后重试）")
        LOCK_FILE.write_text(str(os.getpid()))
        return self

    def __exit__(self, *a):
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------- 账号快照

def account_dir(name):
    if not name or any(c in name for c in '\\/:*?"<>|') or name.startswith((".", "-")):
        die(f"账号名不合法：{name!r}")
    return ACCOUNTS / name


def load_meta(name):
    return read_json(account_dir(name) / "meta.json", None)


def save_meta(name, meta):
    meta["name"] = name
    write_json(account_dir(name) / "meta.json", meta)


def all_accounts():
    if not ACCOUNTS.exists():
        return []
    out = []
    for d in sorted(ACCOUNTS.iterdir()):
        m = read_json(d / "meta.json", None)
        if m:
            out.append(m)
    return out


def find_account(kind, uuid):
    if not uuid:
        return None
    for m in all_accounts():
        if (m.get(kind) or {}).get("accountUuid") == uuid:
            return m["name"]
    return None


# ---------------------------------------------------------------- CLI

def cli_dir():
    env = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(env) if env else HOME / ".claude"


def cli_creds_path():
    return cli_dir() / ".credentials.json"


def cli_global_config_path():
    # 与 Claude Code / cockpit-tools 一致：优先 <config_dir>/.config.json；
    # 默认目录时用 ~/.claude.json，自定义目录时用 <config_dir>/.claude.json
    d = cli_dir()
    if (d / ".config.json").exists():
        return d / ".config.json"
    if os.environ.get("CLAUDE_CONFIG_DIR", "").strip():
        return d / ".claude.json"
    return HOME / ".claude.json"


def cli_live():
    creds = read_json(cli_creds_path(), {}) or {}
    cfg = read_json(cli_global_config_path(), {}) or {}
    return creds.get("claudeAiOauth"), cfg.get("oauthAccount")


def cli_save(name):
    oauth, account = cli_live()
    if not oauth or not account:
        die("CLI 当前没有登录（缺少 claudeAiOauth 或 oauthAccount）。先运行 claude 并 /login。")
    other = find_account("cli", account.get("accountUuid"))
    if other and other != name:
        die(f"CLI 当前账号已经存为「{other}」了，不能再存成「{name}」")
    d = account_dir(name)
    write_json(d / "cli" / "credentials.json", {"claudeAiOauth": oauth})
    write_json(d / "cli" / "oauthAccount.json", account)
    meta = load_meta(name) or {}
    meta["cli"] = {
        "accountUuid": account.get("accountUuid"),
        "email": account.get("emailAddress"),
        "subscriptionType": oauth.get("subscriptionType"),
        "savedAt": now_stamp(),
    }
    save_meta(name, meta)
    log(f"CLI：已保存当前账号为「{name}」（{account.get('emailAddress')}）")


def cli_refresh_current():
    """切走之前，把当前 CLI 账号最新的 token 写回它自己的快照（token 会轮换）。"""
    oauth, account = cli_live()
    if not oauth or not account:
        return None
    cur = find_account("cli", account.get("accountUuid"))
    if cur:
        cli_save(cur)
    else:
        bk = BACKUPS / f"cli-{now_stamp()}"
        write_json(bk / "credentials.json", {"claudeAiOauth": oauth})
        write_json(bk / "oauthAccount.json", account)
        log(f"CLI：当前登录的账号还没存过快照，已备份到 {bk}")
    return cur


def cli_use(name):
    d = account_dir(name) / "cli"
    snap_creds = read_json(d / "credentials.json")
    snap_account = read_json(d / "oauthAccount.json")
    if not snap_creds or not snap_account:
        die(f"账号「{name}」没有 CLI 快照。先登录该账号后运行：save {name} --only cli")
    cur = cli_refresh_current()
    if cur == name:
        log(f"CLI：当前已经是「{name}」")
        return
    creds = read_json(cli_creds_path(), {}) or {}
    creds["claudeAiOauth"] = snap_creds["claudeAiOauth"]
    write_json(cli_creds_path(), creds)
    cfg_path = cli_global_config_path()
    cfg = read_json(cfg_path, {}) or {}
    cfg["oauthAccount"] = snap_account
    cfg["hasCompletedOnboarding"] = True
    write_json(cfg_path, cfg)
    log(f"CLI：已切换到「{name}」（{snap_account.get('emailAddress')}）。"
        "已经打开的 claude 终端需要重开才会用新账号。")


def cli_clear():
    cli_refresh_current()
    creds = read_json(cli_creds_path(), {}) or {}
    creds.pop("claudeAiOauth", None)
    write_json(cli_creds_path(), creds)
    cfg_path = cli_global_config_path()
    cfg = read_json(cfg_path, {}) or {}
    cfg.pop("oauthAccount", None)
    write_json(cfg_path, cfg)
    log("CLI：已清除当前登录态（没有调用 logout，原账号的 token 仍然有效）。"
        "现在运行 claude 并 /login 登录新账号，然后 save <名字> --only cli。")


# ---------------------------------------------------------------- Desktop

def desktop_dir():
    env = os.environ.get("CLAUDE_DESKTOP_USER_DATA_DIR", "").strip()
    if env:
        return Path(env)
    appdata = Path(os.environ.get("APPDATA", HOME / "AppData" / "Roaming"))
    p = appdata / "Claude"
    if p.exists():
        return Path(os.path.realpath(p))
    local = Path(os.environ.get("LOCALAPPDATA", HOME / "AppData" / "Local"))
    for pkg in (local / "Packages").glob("Claude_*"):
        q = pkg / "LocalCache" / "Roaming" / "Claude"
        if q.exists():
            return q
    die("找不到 Claude Desktop 的数据目录")


def desktop_config():
    return read_json(desktop_dir() / "config.json", {}) or {}


def desktop_live_uuid():
    return desktop_config().get("lastKnownAccountUuid")


EMAIL_RE = re.compile(rb"[A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}")
EMAIL_IGNORE = ("example", "noreply", "no-reply", "placeholder", "sentry", "w3.org", "schema.org", "chromium.org")


def find_desktop_email(profile_dir, uuid):
    """Desktop 的配置里没有邮箱；在它的本地存储里找紧挨着账号 ID 的那个邮箱（只读）。"""
    if not uuid:
        return None
    key = uuid.encode()
    best = (None, 10 ** 9)
    for sub in ("Local Storage", "IndexedDB", "Session Storage"):
        root = Path(profile_dir) / sub
        if not root.exists():
            continue
        for f in root.rglob("*"):
            try:
                if not f.is_file() or f.stat().st_size > 20_000_000:
                    continue
                b = f.read_bytes()
            except OSError:
                continue
            for m in re.finditer(re.escape(key), b):
                lo = max(0, m.start() - 3000)
                for e in EMAIL_RE.finditer(b[lo:m.end() + 3000]):
                    email = e.group().decode("ascii", "ignore")
                    dist = abs(lo + e.start() - m.start())
                    if dist < best[1] and not any(x in email.lower() for x in EMAIL_IGNORE):
                        best = (email, dist)
    return best[0]


def desktop_email_for(uuid):
    """当前 Desktop 账号的邮箱：先看已保存的快照，再看缓存，最后扫描本地存储并缓存。"""
    if not uuid:
        return None
    for m in all_accounts():
        d = m.get("desktop") or {}
        if d.get("accountUuid") == uuid and d.get("email"):
            return d["email"]
        c = m.get("cli") or {}
        if c.get("accountUuid") == uuid and c.get("email"):
            return c["email"]
    conf = read_json(CONFIG_FILE, {}) or {}
    cache = conf.setdefault("desktopEmails", {})
    if uuid not in cache:
        email = find_desktop_email(desktop_dir(), uuid)
        if not email:
            return None
        cache[uuid] = email
        write_json(CONFIG_FILE, conf)
    return cache[uuid]


def is_auth_key(k):
    return k.startswith(DESKTOP_CONFIG_AUTH_PREFIX) or k in DESKTOP_CONFIG_AUTH_KEYS


def desktop_processes():
    res = []
    for pid, path in list_processes():
        p = path.lower()
        if "\\windowsapps\\claude_" in p or "\\anthropicclaude\\" in p:
            res.append(pid)
    return res


def desktop_activity():
    """Desktop 里打开着的会话数（各自有一个 claude-code 进程），以及最近 10 分钟用过的会话标题。"""
    open_count = sum(1 for _, p in list_processes()
                     if "\\claude\\claude-code\\" in p.lower() and p.lower().endswith("claude.exe"))
    recent, seen = [], set()
    root = sessions_root()
    if root.exists():
        now = time.time()
        for f in root.glob("*/*/local_*.json"):
            if f.name in seen:
                continue
            seen.add(f.name)
            try:
                if now - f.stat().st_mtime > 600:
                    continue
                meta = read_json(f, {}) or {}
            except (OSError, SystemExit):
                continue
            last = max(meta.get("lastActivityAt") or 0, meta.get("latestUserFrameAt") or 0,
                       meta.get("lastFocusedAt") or 0) / 1000 or f.stat().st_mtime
            if not meta.get("isArchived") and now - last <= 600:
                recent.append((last, meta.get("title") or "未命名会话"))
    recent = [t for _, t in sorted(recent, reverse=True)]
    return {"open": open_count, "recent": recent}


def set_job(state, message=""):
    write_json(JOB_FILE, {"state": state, "message": message, "at": time.time()})


def cancel_requested():
    if CANCEL_FILE.exists():
        CANCEL_FILE.unlink()
        return True
    return False


def desktop_quit(force=False, wait_user=180):
    """正常退出 Claude Desktop；默认绝不强制结束。退不掉就等用户自己退出，超时或取消则什么都不改。"""
    pids = desktop_processes()
    if not pids:
        return
    msg = "正在正常退出 Claude Desktop（不会强制结束）…"
    log("Desktop：" + msg)
    set_job("quitting", msg)
    args = ["taskkill"]
    for pid in pids:
        args += ["/PID", str(pid)]
    run_hidden(args)  # 不带 /F：相当于点窗口的关闭按钮，Desktop 可以自己询问是否退出
    deadline = time.time() + 15
    while time.time() < deadline and desktop_processes():
        if cancel_requested():
            set_job("cancelled", "已取消，什么都没改")
            die("已取消，什么都没改")
        time.sleep(0.5)
    if desktop_processes():
        if force:
            args = ["taskkill", "/F", "/T"]
            for pid in desktop_processes():
                args += ["/PID", str(pid)]
            run_hidden(args)
            time.sleep(2)
        else:
            msg = ("Claude Desktop 还没退出（可能缩到了托盘，或者正在问你是否确认退出）。"
                   f"请在 Desktop 里确认退出，或右键托盘图标选「退出」；退出后会自动继续，最多等 {wait_user // 60} 分钟。")
            log("Desktop：" + msg)
            set_job("waiting", msg)
            deadline = time.time() + wait_user
            while desktop_processes():
                if cancel_requested():
                    set_job("cancelled", "已取消，什么都没改")
                    die("已取消，什么都没改")
                if time.time() > deadline:
                    set_job("failed", "Claude Desktop 一直没有退出，已取消切换，什么都没改")
                    die("Claude Desktop 一直没有退出，已取消切换，什么都没改")
                time.sleep(1)
    if desktop_processes():
        set_job("failed", "Claude Desktop 无法退出，什么都没改")
        die("Claude Desktop 无法退出，什么都没改")
    set_job("working", "Desktop 已退出，正在切换…")
    time.sleep(1.5)  # 等文件句柄释放


def desktop_launch():
    conf = read_json(CONFIG_FILE, {}) or {}
    aumid = conf.get("desktopAumid")
    if not aumid:
        _, aumid = powershell(
            "(Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID")
        if aumid:
            conf["desktopAumid"] = aumid
            write_json(CONFIG_FILE, conf)
    if aumid:
        subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{aumid}"])
        log("Desktop：已重新启动 Claude Desktop")
        return
    exe = Path(os.environ.get("LOCALAPPDATA", "")) / "AnthropicClaude" / "claude.exe"
    if exe.exists():
        subprocess.Popen([str(exe)])
        log("Desktop：已重新启动 Claude Desktop")
    else:
        log("Desktop：没找到启动方式，请手动打开 Claude Desktop")


def desktop_save(name):
    """把当前 Desktop 登录态存成快照。调用前 Desktop 必须已退出。"""
    src = desktop_dir()
    cfg = desktop_config()
    uuid = cfg.get("lastKnownAccountUuid")
    if not uuid or not any(k.startswith(DESKTOP_CONFIG_AUTH_PREFIX) for k in cfg):
        die("Desktop 当前没有登录")
    other = find_account("desktop", uuid)
    if other and other != name:
        die(f"Desktop 当前账号已经存为「{other}」了，不能再存成「{name}」")
    d = account_dir(name)
    tmp = d / "desktop.ccs-tmp"
    remove_path(tmp)
    tmp.mkdir(parents=True)
    for item in DESKTOP_ITEMS:
        if (src / item).exists():
            copy_path(src / item, tmp / item)
    write_json(tmp / "config-auth.json", {k: v for k, v in cfg.items() if is_auth_key(k)})
    final = d / "desktop"
    remove_path(final)
    os.replace(tmp, final)
    meta = load_meta(name) or {}
    cli_acc = cli_live()[1] or {}
    email = (cli_acc.get("emailAddress") if cli_acc.get("accountUuid") == uuid else None) \
        or (meta.get("desktop") or {}).get("email") or find_desktop_email(final, uuid)
    meta["desktop"] = {"accountUuid": uuid, "email": email, "savedAt": now_stamp()}
    save_meta(name, meta)
    log(f"Desktop：已保存当前账号为「{name}」（{email or '邮箱未知'}）")


def desktop_backup_live(tag):
    src = desktop_dir()
    bk = BACKUPS / f"desktop-{now_stamp()}-{tag}"
    bk.mkdir(parents=True, exist_ok=True)
    for item in DESKTOP_ITEMS:
        if (src / item).exists():
            copy_path(src / item, bk / item)
    cfg = desktop_config()
    write_json(bk / "config-auth.json", {k: v for k, v in cfg.items() if is_auth_key(k)})
    prune_backups()
    return bk


def prune_backups():
    if not BACKUPS.exists():
        return
    for prefix in ("desktop-", "cli-"):
        olds = sorted(p for p in BACKUPS.iterdir() if p.name.startswith(prefix))
        for p in olds[:-KEEP_BACKUPS]:
            remove_path(p)


def desktop_refresh_current():
    """切走之前，把当前 Desktop 账号最新的登录态写回它自己的快照。"""
    cur = find_account("desktop", desktop_live_uuid())
    if cur:
        desktop_save(cur)
    elif desktop_live_uuid():
        bk = desktop_backup_live("unsaved")
        log(f"Desktop：当前登录的账号还没存过快照，已备份到 {bk}")
    return cur


def desktop_write_auth(snap_dir, cfg_auth):
    dst = desktop_dir()
    for item in DESKTOP_ITEMS:
        s = snap_dir / item if snap_dir else None
        if s is not None and s.exists():
            copy_path(s, dst / item)
        elif item not in DESKTOP_KEEP_IF_MISSING:
            remove_path(dst / item)
    cfg = desktop_config()
    cfg = {k: v for k, v in cfg.items() if not is_auth_key(k)}
    cfg.update(cfg_auth)
    write_json(dst / "config.json", cfg)


def desktop_use(name):
    snap = account_dir(name) / "desktop"
    cfg_auth = read_json(snap / "config-auth.json")
    if not cfg_auth:
        die(f"账号「{name}」没有 Desktop 快照。先在 Desktop 登录该账号后运行：save {name} --only desktop")
    cur = desktop_refresh_current()
    if cur == name:
        log(f"Desktop：当前已经是「{name}」")
        return
    desktop_backup_live("before-use")
    desktop_write_auth(snap, cfg_auth)
    meta = load_meta(name)
    meta.setdefault("desktop", {})["lastUsedAt"] = now_stamp()
    save_meta(name, meta)
    log(f"Desktop：已切换到「{name}」（{meta['desktop'].get('email') or '邮箱未知'}）")


def desktop_clear():
    desktop_refresh_current()
    desktop_backup_live("before-clear")
    desktop_write_auth(None, {})
    log("Desktop：已清除当前登录态（没有调用退出登录，原账号仍然有效）。"
        "Desktop 启动后登录新账号，然后 save <名字> --only desktop。")


# ---------------------------------------------------------------- 会话共享

def sessions_root():
    return desktop_dir() / "claude-code-sessions"


def org_dirs():
    root = sessions_root()
    if not root.exists():
        return []
    res = []
    for acct in root.iterdir():
        if acct.is_dir() and not is_junction(acct) and len(acct.name) == 36:
            for org in acct.iterdir():
                if len(org.name) == 36 and (org.is_dir() or is_junction(org)):
                    res.append(org)
    return res


def merge_into(src_dir, dst_dir):
    n = 0
    for f in src_dir.iterdir():
        t = dst_dir / f.name
        if t.exists():
            if f.stat().st_mtime <= t.stat().st_mtime:
                continue
            remove_path(t)
        copy_path(f, t)
        n += 1
    return n


def link_sessions(quiet=False):
    SHARED_SESSIONS.mkdir(parents=True, exist_ok=True)
    shared_real = os.path.realpath(SHARED_SESSIONS)
    linked = merged = 0
    for org in org_dirs():
        if is_junction(org):
            if os.path.realpath(org) == shared_real:
                continue
            os.rmdir(org)
        else:
            bk = BACKUPS / "sessions-before-link" / org.parent.name / org.name
            if not bk.exists():
                bk.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(org, bk)
            merged += merge_into(org, SHARED_SESSIONS)
            remove_path(org)
        make_junction(org, SHARED_SESSIONS)
        linked += 1
    total = len([p for p in SHARED_SESSIONS.iterdir() if p.name.startswith("local_")])
    if linked or not quiet:
        log(f"会话共享：新链接 {linked} 个账号目录，合并 {merged} 个文件，共享列表现有 {total} 个会话")


def unlink_sessions():
    n = 0
    for org in org_dirs():
        if is_junction(org):
            os.rmdir(org)
            shutil.copytree(SHARED_SESSIONS, org)
            n += 1
    log(f"会话共享：已撤销 {n} 个链接，各账号恢复为独立目录（内容为当前共享列表的副本）")


# ---------------------------------------------------------------- 调度

def run_desktop_job(job, name, force=False):
    """在 Desktop 已退出的状态下执行 job，然后重新启动 Desktop。"""
    was_running = bool(desktop_processes())
    desktop_quit(force=force)  # 退不掉会直接结束，此时什么都没改，也不会重启 Desktop
    try:
        if job == "save":
            desktop_save(name)
        elif job == "use":
            desktop_use(name)
        elif job == "login-new":
            desktop_clear()
        if job in ("save", "use", "link-sessions"):
            link_sessions(quiet=True)
        elif job == "unlink-sessions":
            unlink_sessions()
    finally:
        if was_running or job in ("use", "login-new"):
            desktop_launch()


def spawn_worker(job, name, delay, force=False):
    """用 WMI 启动一个脱离 Claude Desktop 进程树的后台进程，Desktop 退出时不会被一起结束。"""
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    exe = pyw if pyw.exists() else exe
    cmd = f'"{exe}" -I "{Path(__file__).resolve()}" _worker {job} --delay {delay}'
    if name:
        cmd += f' --name "{name}"'
    if force:
        cmd += " --force"
    if CANCEL_FILE.exists():
        CANCEL_FILE.unlink()
    set_job("starting", "准备退出 Claude Desktop…")
    env = dict(os.environ, CCS_CMD=cmd)
    code, out = powershell(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        "-Arguments @{CommandLine=$env:CCS_CMD}; $r.ReturnValue", env=env)
    if out.strip() != "0":
        die(f"启动后台进程失败：{out}")
    log(f"Desktop：已交给后台进程处理，约 {delay} 秒后会正常退出 Claude Desktop（不强制），"
        f"换好后自动重新打开。如果 Desktop 问你是否退出，请确认。进度写在 {LOG_FILE}")


def confirm_desktop_or_exit(yes):
    """Desktop 正在运行时，先把打开的会话列出来提醒；没有 --yes 就停下，什么都不改。"""
    if yes or not desktop_processes():
        return
    act = desktop_activity()
    lines = ["需要确认：这个操作要先退出 Claude Desktop（正常退出，不会强制结束），Desktop 里进行中的对话会被打断。"]
    if act["open"]:
        lines.append(f"Desktop 现在有 {act['open']} 个打开的会话。")
    if act["recent"]:
        lines.append("最近 10 分钟用过的会话：" + "、".join(act["recent"][:6]))
    lines.append("确认没问题后，加 --yes 重新运行。")
    print("\n".join(lines))
    sys.exit(3)


def desktop_dispatch(job, name, force=False):
    if desktop_processes():
        spawn_worker(job, name, delay=4, force=force)
    else:
        with Lock():
            run_desktop_job(job, name)


def status_data():
    _, cli_acc = cli_live()
    cli_acc = cli_acc or {}
    d_uuid = desktop_live_uuid()
    orgs = org_dirs()
    shared_real = os.path.realpath(SHARED_SESSIONS) if SHARED_SESSIONS.exists() else None
    linked = sum(1 for o in orgs if is_junction(o) and os.path.realpath(o) == shared_real)
    accounts = []
    for m in all_accounts():
        c, d = m.get("cli") or {}, m.get("desktop") or {}
        accounts.append({
            "name": m["name"],
            "hasCli": bool(c),
            "hasDesktop": bool(d),
            "email": c.get("email") or d.get("email"),
            "cliEmail": c.get("email"),
            "desktopEmail": d.get("email"),
            "plan": c.get("subscriptionType"),
        })
    running = bool(desktop_processes())
    return {
        "cli": {"current": find_account("cli", cli_acc.get("accountUuid")),
                "email": cli_acc.get("emailAddress"), "loggedIn": bool(cli_acc)},
        "desktop": {"current": find_account("desktop", d_uuid), "email": desktop_email_for(d_uuid),
                    "loggedIn": bool(d_uuid), "running": running,
                    "activity": desktop_activity() if running else {"open": 0, "recent": []}},
        "job": read_json(JOB_FILE, None),
        "accounts": accounts,
        "sessions": {"linked": linked, "total": len(orgs),
                     "shared": len([p for p in SHARED_SESSIONS.iterdir() if p.name.startswith("local_")])
                     if SHARED_SESSIONS.exists() else 0},
    }


def who(side):
    """「名字（邮箱）」；还没保存过的账号只显示邮箱。"""
    if not side["loggedIn"]:
        return "未登录"
    email = side["email"] or "邮箱未知"
    return f"{side['current']}（{email}）" if side["current"] else f"{email}（还没保存）"


def print_status(st):
    c, d = st["cli"], st["desktop"]
    print(f"CLI 当前：{who(c)}")
    print(f"Desktop 当前：{who(d)}{'，运行中' if d['running'] else '，未运行'}")
    print("已保存的账号：" if st["accounts"] else "已保存的账号：无")
    for i, a in enumerate(st["accounts"], 1):
        parts = [x for x, ok in (("CLI", a["hasCli"]), ("Desktop", a["hasDesktop"])) if ok]
        mark = [x for x, k in (("CLI 当前", c["current"]), ("Desktop 当前", d["current"])) if a["name"] == k]
        print(f"  {i}. {a['name']}  {a['email'] or '邮箱未知'}"
              f"{'  ' + a['plan'] if a['plan'] else ''}  [已保存：{'、'.join(parts)}]"
              f"{'  ← ' + '、'.join(mark) if mark else ''}")
    s = st["sessions"]
    print(f"会话共享：{s['linked']}/{s['total']} 个账号目录已共享，共享列表里有 {s['shared']} 个会话"
          + ("" if s["linked"] == s["total"] else "（运行 link-sessions 补上）"))


def interactive_menu():
    """不带参数运行时的菜单，像 /resume 一样选。"""
    st = status_data()
    print_status(st)
    accts = st["accounts"]
    print()
    print("输入编号切换到该账号（CLI + Desktop 一起切）；编号后加 c 只切 CLI、加 d 只切 Desktop，例如 2c")
    print("其它：n = 添加新账号   r = 改名   q = 退出")
    choice = input("> ").strip().lower()
    if not choice or choice == "q":
        return
    if choice == "n":
        sys.argv = [sys.argv[0], "login-new"]
        return main()
    if choice == "r":
        old = input("要改名的账号编号或名字：").strip()
        if old.isdigit() and 1 <= int(old) <= len(accts):
            old = accts[int(old) - 1]["name"]
        new = input("新名字：").strip()
        sys.argv = [sys.argv[0], "rename", old, new]
        return main()
    only = None
    if choice[-1] in "cd" and choice[:-1].isdigit():
        only = {"c": "cli", "d": "desktop"}[choice[-1]]
        choice = choice[:-1]
    if not choice.isdigit() or not 1 <= int(choice) <= len(accts):
        die("没有这个选项")
    sys.argv = [sys.argv[0], "use", accts[int(choice) - 1]["name"]] + (["--only", only] if only else [])
    main()


def make_shortcut():
    """在开始菜单和桌面放一个「Claude 切号」快捷方式，打开图形窗口。"""
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    ui = Path(__file__).resolve().with_name("claude_switch_ui.py")
    env = dict(os.environ, CCS_TARGET=str(pyw if pyw.exists() else exe),
               CCS_ARGS=f'-I "{ui}"', CCS_ICON=str(ui.with_name("icon.ico")))
    ps = (
        "$s = New-Object -ComObject WScript.Shell; "
        "foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) { "
        "  $l = $s.CreateShortcut((Join-Path $dir 'Claude 切号.lnk')); "
        "  $l.TargetPath = $env:CCS_TARGET; $l.Arguments = $env:CCS_ARGS; $l.IconLocation = $env:CCS_ICON; "
        "  $l.Description = 'Claude 账号切换'; $l.Save(); $dir }")
    code, out = powershell(ps, env=env)
    if code != 0:
        die("创建快捷方式失败：" + out)
    log("已创建「Claude 切号」快捷方式：\n" + out)


def main():
    ap = argparse.ArgumentParser(description="Claude 账号快速切换 + Desktop 会话共享")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
    sub.add_parser("shortcut")
    def desktop_flags(p):
        p.add_argument("--yes", action="store_true", help="确认要退出 Claude Desktop")
        p.add_argument("--force", action="store_true", help="Desktop 退不掉时强制结束（默认绝不强制）")
    for c in ("save", "use"):
        p = sub.add_parser(c)
        p.add_argument("name")
        p.add_argument("--only", choices=["cli", "desktop"])
        desktop_flags(p)
    p = sub.add_parser("login-new")
    p.add_argument("--only", choices=["cli", "desktop"])
    desktop_flags(p)
    desktop_flags(sub.add_parser("link-sessions"))
    desktop_flags(sub.add_parser("unlink-sessions"))
    sub.add_parser("cancel")
    p = sub.add_parser("rename")
    p.add_argument("old")
    p.add_argument("new")
    p = sub.add_parser("remove")
    p.add_argument("name")
    p = sub.add_parser("_worker")
    p.add_argument("job")
    p.add_argument("--name")
    p.add_argument("--delay", type=float, default=0)
    p.add_argument("--force", action="store_true")
    a = ap.parse_args()

    if a.cmd is None:
        if sys.stdin.isatty():
            interactive_menu()
        else:
            print_status(status_data())
    elif a.cmd == "status":
        st = status_data()
        print(json.dumps(st, ensure_ascii=False)) if a.json else print_status(st)
    elif a.cmd == "shortcut":
        make_shortcut()
    elif a.cmd == "cancel":
        DATA.mkdir(parents=True, exist_ok=True)
        CANCEL_FILE.write_text("1")
        log("已请求取消：如果还在等 Claude Desktop 退出，会停下来，什么都不改")
    elif a.cmd == "rename":
        src, dst = account_dir(a.old), account_dir(a.new)
        if not src.exists():
            die(f"没有账号「{a.old}」")
        if dst.exists():
            die(f"已经有账号叫「{a.new}」了")
        os.replace(src, dst)
        meta = load_meta(a.new)
        save_meta(a.new, meta)
        log(f"已把账号「{a.old}」改名为「{a.new}」")
    elif a.cmd == "remove":
        d = account_dir(a.name)
        if not d.exists():
            die(f"没有账号「{a.name}」")
        shutil.rmtree(d)
        log(f"已删除账号快照「{a.name}」")
    elif a.cmd == "_worker":
        time.sleep(a.delay)
        try:
            with Lock():
                log(f"后台进程开始：{a.job} {a.name or ''}")
                run_desktop_job(a.job, a.name, force=a.force)
                log("后台进程完成")
                set_job("done", "完成" + (f"：已切换到「{a.name}」" if a.job == "use" else ""))
        except SystemExit:
            job = read_json(JOB_FILE, {}) or {}
            if job.get("state") not in ("failed", "cancelled"):
                set_job("failed", LAST_ERROR[0] or "失败，详情见日志")
            raise
        except BaseException:
            import traceback
            log("后台进程异常：\n" + traceback.format_exc())
            raise
    elif a.cmd in ("link-sessions", "unlink-sessions"):
        confirm_desktop_or_exit(a.yes)
        desktop_dispatch(a.cmd, None, force=a.force)
    else:
        name = getattr(a, "name", None)
        if name:
            account_dir(name)
        parts = [a.only] if a.only else ["cli", "desktop"]
        if a.cmd == "save" and not a.only:
            cli_uuid = (cli_live()[1] or {}).get("accountUuid")
            d_uuid = desktop_live_uuid()
            if cli_uuid and d_uuid and cli_uuid != d_uuid:
                die("CLI 和 Desktop 当前登录的不是同一个账号，请分别用 --only cli / --only desktop 保存")
            if not cli_uuid:
                log("CLI 未登录，跳过 CLI")
                parts.remove("cli")
            if not d_uuid:
                log("Desktop 未登录，跳过 Desktop")
                parts.remove("desktop")
        if a.cmd == "use" and not a.only:
            d = account_dir(name)
            if not d.exists():
                die(f"没有账号「{name}」，先用 save 保存")
            for part, f in (("cli", "cli/credentials.json"), ("desktop", "desktop/config-auth.json")):
                if not (d / f).exists():
                    log(f"账号「{name}」没有 {part.upper()} 快照，跳过 {part.upper()}")
                    parts.remove(part)
        if a.cmd == "use" and "desktop" in parts and find_account("desktop", desktop_live_uuid()) == name:
            log(f"Desktop：当前已经是「{name}」，不用重启")
            parts.remove("desktop")
        if not parts:
            die("没有可执行的部分")
        if "desktop" in parts:
            confirm_desktop_or_exit(a.yes)  # 先确认再动手，避免 CLI 换了而 Desktop 没换
        if "cli" in parts:
            if a.cmd == "save":
                cli_save(name)
            elif a.cmd == "use":
                cli_use(name)
            else:
                cli_clear()
        if "desktop" in parts:
            desktop_dispatch(a.cmd, name, force=a.force)


if __name__ == "__main__":
    main()
