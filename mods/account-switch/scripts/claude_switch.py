"""claude-switch: Claude 账号快速切换（CLI + Desktop）与 Desktop 会话同步。

只用标准库。账号快照、会话合并副本、备份、日志都放在 ~/.claude-switch/ 下。
任何输出都不打印 token / cookie 内容。

用法:
  claude_switch.py                                      交互菜单（选编号切换）
  claude_switch.py status [--json]
  claude_switch.py save <名字> [--only cli|desktop]      把当前登录的账号存成快照
  claude_switch.py use <名字>  [--only cli|desktop]      切换到某个账号
  claude_switch.py login-new   [--only cli|desktop]      清掉当前登录态，准备登录一个新账号
  claude_switch.py sync-sessions                        合并所有账号的 Desktop 会话列表（切号时会自动做）
  claude_switch.py rename <旧名字> <新名字>             给账号快照改名
  claude_switch.py remove <名字>                        删除一个账号快照

Desktop 相关操作需要先退出 Claude Desktop；如果 Desktop 正在运行，会交给一个
独立的后台进程执行（退出 → 处理 → 重新启动），所以从 Desktop 会话里调用也没问题。
"""

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HOME = Path.home()
DATA = HOME / ".claude-switch"
ACCOUNTS = DATA / "accounts"
SHARED_SESSIONS = DATA / "shared" / "claude-code-sessions"  # 所有账号会话条目的合并副本
BACKUPS = DATA / "backups"
LOG_FILE = DATA / "logs" / "claude-switch.log"
LOCK_FILE = DATA / "switch.lock"
CONFIG_FILE = DATA / "config.json"
JOB_FILE = DATA / "job.json"      # 后台切换的进度，切号面板读它显示
CANCEL_FILE = DATA / "cancel"     # 存在就表示用户点了取消
OWNER_CACHE = DATA / "cli-owner.json"  # 当前 CLI 凭证属于哪个账号（只存凭证的指纹，不存凭证本身）
USAGE_FILE = DATA / "usage.json"  # 各账号离开时的额度
API = "https://api.anthropic.com"
KEEP_BACKUPS = 5
FIVE_HOURS, SEVEN_DAYS = 5 * 3600, 7 * 86400

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


NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW：从切号面板调用时不弹出命令框


def run_hidden(args, **kw):
    return subprocess.run(args, capture_output=True, creationflags=NO_WINDOW, **kw)


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
    """所有账号，按用户排好的顺序（config.json 的 order）；没排过的按名字放在后面。"""
    if not ACCOUNTS.exists():
        return []
    out = []
    for d in sorted(ACCOUNTS.iterdir()):
        m = read_json(d / "meta.json", None)
        if m:
            out.append(m)
    order = (read_json(CONFIG_FILE, {}) or {}).get("order") or []
    rank = {n: i for i, n in enumerate(order)}
    return sorted(out, key=lambda m: (rank.get(m["name"], len(order)), m["name"]))


def set_order(names):
    conf = read_json(CONFIG_FILE, {}) or {}
    conf["order"] = names
    write_json(CONFIG_FILE, conf)


def pinned_account():
    """Desktop 当前登录的账号，显示时固定在第一位。"""
    return find_account("desktop", desktop_live_uuid())


def ordered_accounts():
    """显示用的顺序：Desktop 当前的号固定在第一，其余按用户排的顺序。"""
    accts, pin = all_accounts(), pinned_account()
    return [m for m in accts if m["name"] == pin] + [m for m in accts if m["name"] != pin]


def move_account(name, step):
    names = [m["name"] for m in ordered_accounts()]
    if name not in names:
        die(f"没有账号「{name}」")
    pin = pinned_account()
    if name == pin:
        return  # 固定在第一的号不参与排序
    lo = 1 if pin else 0
    i = names.index(name)
    j = max(lo, min(len(names) - 1, i + step))
    names.insert(j, names.pop(i))
    set_order(names)


def find_account(kind, uuid):
    if not uuid:
        return None
    for m in all_accounts():
        if (m.get(kind) or {}).get("accountUuid") == uuid:
            return m["name"]
    return None


def name_for_save(requested, uuid, email):
    """保存时实际用的名字：这个账号已经存过（CLI、Desktop 任一边）就沿用原来的名字；
    名字已经被别的账号占了就报错。"""
    for m in all_accounts():
        if uuid in ((m.get("cli") or {}).get("accountUuid"), (m.get("desktop") or {}).get("accountUuid")):
            if m["name"] != requested:
                log(f"这个账号（{email or '邮箱未知'}）已经存为「{m['name']}」，沿用原来的名字，没有另存为「{requested}」")
            return m["name"]
    meta = load_meta(requested) or {}
    taken = {k: v for k in ("cli", "desktop") if (v := meta.get(k)) and v.get("accountUuid") not in (None, uuid)}
    if taken:
        other = next(iter(taken.values())).get("email")
        die(f"名字「{requested}」已经被另一个账号（{other or '邮箱未知'}）用了，换个名字再保存")
    return requested


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


def api_get(path, token, timeout=8):
    req = urllib.request.Request(API + path, headers={
        "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-switch"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def token_valid(oauth):
    return bool(oauth.get("accessToken")) and (oauth.get("expiresAt") or 0) / 1000 > time.time() + 60


def cli_owner(online=True):
    """当前 CLI 凭证真正属于哪个账号：{accountUuid, email, organizationUuid}，确认不了时返回 None。

    ~/.claude.json 里的账号信息会被 Desktop 托管的会话改成 Desktop 的账号，不能拿来判断，所以看凭证本身：
    刷新 token 和某个快照完全一样就是那个号；否则看缓存；再不行就问一次服务器（凭证换了才会再问）。"""
    oauth, _ = cli_live()
    if not oauth:
        return None
    rt = oauth.get("refreshToken")
    for m in all_accounts():
        snap = (read_json(ACCOUNTS / m["name"] / "cli" / "credentials.json", {}) or {}).get("claudeAiOauth") or {}
        if rt and snap.get("refreshToken") == rt and m.get("cli"):
            acc = read_json(ACCOUNTS / m["name"] / "cli" / "oauthAccount.json", {}) or {}
            return {"accountUuid": m["cli"].get("accountUuid"), "email": m["cli"].get("email"),
                    "organizationUuid": acc.get("organizationUuid")}
    fp = hashlib.sha256((oauth.get("accessToken") or "").encode()).hexdigest()[:16]
    cache = read_json(OWNER_CACHE, {}) or {}
    if cache.get("fp") == fp and cache.get("accountUuid"):
        return {k: cache.get(k) for k in ("accountUuid", "email", "organizationUuid")}
    if not online or not token_valid(oauth):
        return None
    try:
        p = api_get("/api/oauth/profile", oauth["accessToken"])
    except Exception:
        return None
    acc, org = p.get("account") or {}, p.get("organization") or {}
    owner = {"accountUuid": acc.get("uuid"), "email": acc.get("email"), "organizationUuid": org.get("uuid")}
    if not owner["accountUuid"]:
        return None
    write_json(OWNER_CACHE, {"fp": fp, **owner, "checkedAt": now_stamp()})
    return owner


def cli_account_for(owner):
    """要存进快照的账号信息（oauthAccount），保证和凭证是同一个账号。"""
    _, live = cli_live()
    if live and live.get("accountUuid") == owner["accountUuid"]:
        return live
    name = find_account("cli", owner["accountUuid"])
    snap = read_json(ACCOUNTS / name / "cli" / "oauthAccount.json", None) if name else None
    if snap:
        return snap
    return {"accountUuid": owner["accountUuid"], "emailAddress": owner["email"],
            "organizationUuid": owner["organizationUuid"]}


def usage_record(name, oauth):
    """记下这个号此刻的额度（存快照时顺便查一次，只查这一个号）；查不到就算了。"""
    if not token_valid(oauth):
        return
    try:
        u = api_get("/api/oauth/usage", oauth["accessToken"])
    except Exception:
        return

    def window(key):
        w = u.get(key) or {}
        reset = w.get("resets_at")
        try:
            reset = _dt.datetime.fromisoformat(reset).timestamp() if reset else None
        except ValueError:
            reset = None
        return w.get("utilization"), reset

    fh, fh_reset = window("five_hour")
    sd, sd_reset = window("seven_day")
    data = read_json(USAGE_FILE, {}) or {}
    data[name] = {"fh": fh, "fhReset": fh_reset, "sd": sd, "sdReset": sd_reset, "at": time.time()}
    write_json(USAGE_FILE, data)


def cli_save(name):
    oauth, _ = cli_live()
    owner = cli_owner() if oauth else None
    if not owner:
        die("确认不了 CLI 当前登录的是哪个账号（没有登录，或者凭证已过期又没法联网确认）。"
            "先运行一次 claude（没登录就 /login），再保存。")
    account = cli_account_for(owner)
    name = name_for_save(name, owner["accountUuid"], owner["email"])
    d = account_dir(name)
    write_json(d / "cli" / "credentials.json", {"claudeAiOauth": oauth})
    write_json(d / "cli" / "oauthAccount.json", account)
    meta = load_meta(name) or {}
    meta["cli"] = {
        "accountUuid": owner["accountUuid"],
        "email": account.get("emailAddress") or owner["email"],
        "subscriptionType": oauth.get("subscriptionType"),
        "savedAt": now_stamp(),
    }
    save_meta(name, meta)
    cfg_path = cli_global_config_path()
    cfg = read_json(cfg_path, {}) or {}
    if (cfg.get("oauthAccount") or {}).get("accountUuid") != owner["accountUuid"]:
        cfg["oauthAccount"] = account  # 账号信息和凭证对不上时，改成凭证真正所属的账号
        write_json(cfg_path, cfg)
        log(f"CLI：{cfg_path.name} 里的账号信息和登录凭证对不上，已改成「{name}」")
    usage_record(name, oauth)
    log(f"CLI：已保存当前账号为「{name}」（{meta['cli']['email']}）")
    return name


def cli_refresh_current():
    """切走之前，把当前 CLI 账号最新的 token 写回它自己的快照（token 会轮换）。
    确认不了凭证属于哪个号时不写任何快照，只备份，避免把 A 的凭证写进 B 的快照。"""
    oauth, account = cli_live()
    if not oauth:
        return None
    owner = cli_owner()
    cur = find_account("cli", owner["accountUuid"]) if owner else None
    if cur:
        cli_save(cur)
    else:
        bk = BACKUPS / f"cli-{now_stamp()}"
        write_json(bk / "credentials.json", {"claudeAiOauth": oauth})
        write_json(bk / "oauthAccount.json", account or {})
        why = "当前登录的账号还没存过快照" if owner else "确认不了当前凭证属于哪个账号，没有写回任何快照"
        log(f"CLI：{why}，已备份到 {bk}")
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


def desktop_windows(pids):
    """Desktop 进程的顶层窗口（包括缩到托盘后隐藏的那些）。"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    targets, found = set(pids), []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def collect(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in targets:
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value.startswith("Chrome_WidgetWin"):  # Electron 的窗口
                found.append(hwnd)
        return True

    user32.EnumWindows(collect, 0)
    return found


def desktop_end_session(pids):
    """像 Windows 注销时那样通知 Desktop 的窗口（WM_QUERYENDSESSION → WM_ENDSESSION）。

    点关闭按钮或 taskkill（不带 /F）只会让 Desktop 缩到托盘；它只在收到"会话结束"时调用自己的退出流程，
    和右键托盘点「退出」一样，不是强制结束。返回通知到的窗口数。"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    send = user32.SendMessageTimeoutW
    send.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                     wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    send.restype = ctypes.c_ssize_t
    WM_QUERYENDSESSION, WM_ENDSESSION, ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG = 0x11, 0x16, 0x1, 0x2
    hwnds = desktop_windows(pids)
    for hwnd in hwnds:
        answer = ctypes.c_size_t()
        if send(hwnd, WM_QUERYENDSESSION, 0, ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG, 3000, ctypes.byref(answer)) \
                and answer.value:  # 窗口同意结束才发 WM_ENDSESSION
            send(hwnd, WM_ENDSESSION, 1, ENDSESSION_CLOSEAPP, SMTO_ABORTIFHUNG, 3000, ctypes.byref(answer))
    return len(hwnds)


def desktop_quit(force=False, wait_user=180):
    """正常退出 Claude Desktop；默认绝不强制结束。退不掉就等用户自己退出，超时或取消则什么都不改。"""
    pids = desktop_processes()
    if not pids:
        return
    msg = "正在正常退出 Claude Desktop（不会强制结束）…"
    log("Desktop：" + msg)
    set_job("quitting", msg)
    if not desktop_end_session(pids):
        args = ["taskkill"]
        for pid in pids:
            args += ["/PID", str(pid)]
        run_hidden(args)  # 找不到窗口时退回老办法：不带 /F，相当于点窗口的关闭按钮
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
    known = next(((m.get(k) or {}).get("email") for m in all_accounts() for k in ("desktop", "cli")
                  if (m.get(k) or {}).get("accountUuid") == uuid and (m.get(k) or {}).get("email")), None)
    name = name_for_save(name, uuid, known)
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
    email = known or (meta.get("desktop") or {}).get("email") or find_desktop_email(final, uuid)
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
    for prefix in ("desktop-", "cli-", "sessions-"):
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


# ---------------------------------------------------------------- 会话同步

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


def sessions_backup(orgs):
    bk = BACKUPS / f"sessions-{now_stamp()}"
    for org in orgs:
        if org.exists():
            shutil.copytree(org, bk / org.parent.name / org.name, dirs_exist_ok=True)
    prune_backups()


def sync_sessions(quiet=False):
    """把所有账号的 Desktop 会话条目合并成同一份，写回每个账号目录（Desktop 必须已退出）。

    不能用目录链接：Desktop 发现会话目录是链接（junction/symlink）时会拒绝写入，
    会话的任何改动都存不下来。所以改成在切号时复制合并：同名文件取修改时间最新的，
    有 deleted_<id> 标记的会话在所有账号里都删掉。合并前先备份。
    """
    orgs = org_dirs()
    SHARED_SESSIONS.mkdir(parents=True, exist_ok=True)
    fixed = 0
    for org in orgs:  # 早期版本留下的链接：换回真实目录
        if is_junction(org):
            os.rmdir(org)
            shutil.copytree(SHARED_SESSIONS, org)
            fixed += 1
    sessions_backup(orgs)
    newest = {}  # 文件名 -> 最新版本所在路径
    for d in orgs + [SHARED_SESSIONS]:
        for f in d.iterdir():
            if f.is_file() and (f.name not in newest or f.stat().st_mtime > newest[f.name].stat().st_mtime):
                newest[f.name] = f
    deleted = {n[len("deleted_"):] for n in newest if n.startswith("deleted_")}
    gone = {f"local_{i}.json" for i in deleted}
    copied = removed = 0
    for d in orgs + [SHARED_SESSIONS]:
        for name, src in newest.items():
            t = d / name
            if name in gone:
                if t.exists():
                    remove_path(t)
                    removed += 1
                continue
            if src.parent == d or (t.exists() and t.stat().st_mtime >= src.stat().st_mtime):
                continue
            copy_path(src, t)
            copied += 1
    total = len([n for n in newest if n.startswith("local_") and n not in gone])
    if fixed:
        log(f"会话同步：已把 {fixed} 个目录链接换回真实目录（Desktop 不允许会话目录是链接）")
    if copied or removed or not quiet:
        log(f"会话同步：{len(orgs)} 个账号目录已合并，共 {total} 个会话（复制 {copied} 个文件，删除 {removed} 个）")


def sessions_status():
    orgs = [o for o in org_dirs() if o.is_dir() and not is_junction(o)]
    names = [{f.name: int(f.stat().st_mtime) for f in o.iterdir() if f.name.startswith("local_")} for o in orgs]
    allnames = set().union(*names) if names else set()
    return {"accounts": len(orgs), "count": len(allnames),
            "inSync": all(n == names[0] for n in names),
            "links": sum(1 for o in org_dirs() if is_junction(o))}


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
        if job in ("save", "use", "login-new", "sync-sessions"):
            sync_sessions(quiet=job != "sync-sessions")
    finally:
        if was_running or job in ("use", "login-new"):
            desktop_launch()


def pythonw():
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    return pyw if pyw.exists() else exe


def wmi_launch(cmd):
    """用 WMI 启动进程：父进程是 WmiPrvSE，不在 Claude Desktop 的进程树里，Desktop 退出时不会被一起结束。"""
    env = dict(os.environ, CCS_CMD=cmd)
    code, out = powershell(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
        "-Arguments @{CommandLine=$env:CCS_CMD}; $r.ReturnValue", env=env)
    if out.strip() != "0":
        die(f"启动后台进程失败：{out}")


def spawn_worker(job, name, delay, force=False):
    """用 WMI 启动一个脱离 Claude Desktop 进程树的后台进程，Desktop 退出时不会被一起结束。"""
    cmd = f'"{pythonw()}" -I "{Path(__file__).resolve()}" _worker {job} --delay {delay}'
    if name:
        cmd += f' --name "{name}"'
    if force:
        cmd += " --force"
    if CANCEL_FILE.exists():
        CANCEL_FILE.unlink()
    set_job("starting", "准备退出 Claude Desktop…")
    wmi_launch(cmd)
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


def desktop_usage_records():
    """Desktop 自己记的额度（plan-usage-history.json）：每个组织最后一条，{org: {fh, sd, at}}。"""
    try:
        with open(desktop_dir() / "plan-usage-history.json", encoding="utf-8") as f:
            hist = json.load(f)
    except (OSError, ValueError, SystemExit):
        return {}
    last = {}
    for s in hist.get("samples") or []:
        org, t = s.get("org"), s.get("t") or 0
        if org and t >= last.get(org, {}).get("t", 0):
            last[org] = s
    return {org: {"fh": (s.get("u") or {}).get("fh"), "sd": (s.get("u") or {}).get("sd"), "at": s["t"] / 1000}
            for org, s in last.items()}


def account_orgs(m):
    orgs = set()
    acc = read_json(ACCOUNTS / m["name"] / "cli" / "oauthAccount.json", {}) or {}
    if acc.get("organizationUuid"):
        orgs.add(acc["organizationUuid"])
    d_uuid = (m.get("desktop") or {}).get("accountUuid")
    orgs.update(o.name for o in org_dirs() if o.parent.name == d_uuid)
    return orgs


def usage_for(m, records, saved):
    """这个号最近一次知道的额度。额度窗口到点了就当作已恢复（显示 0），不联网。"""
    cands = [records[o] for o in account_orgs(m) if o in records]
    api = saved.get(m["name"])
    if api:
        cands.append(api)
    if not cands:
        return None
    best = max(cands, key=lambda c: c["at"])
    now, out = time.time(), {"at": best["at"]}
    for key, span in (("fh", FIVE_HOURS), ("sd", SEVEN_DAYS)):
        reset = api.get(key + "Reset") if api and (api.get(key + "Reset") or 0) > best["at"] else None
        is_reset = now >= reset if reset else now - best["at"] >= span
        out[key] = 0 if is_reset else best.get(key)
        out[key + "Reset"] = None if is_reset else reset
        out[key + "IsReset"] = is_reset
    return out


def status_data():
    owner = cli_owner()
    _, cli_acc = cli_live()
    cli_acc = cli_acc or {}
    cli_uuid = owner["accountUuid"] if owner else cli_acc.get("accountUuid")
    d_uuid = desktop_live_uuid()
    records, saved = desktop_usage_records(), read_json(USAGE_FILE, {}) or {}
    accounts = []
    for m in ordered_accounts():
        c, d = m.get("cli") or {}, m.get("desktop") or {}
        accounts.append({
            "name": m["name"],
            "hasCli": bool(c),
            "hasDesktop": bool(d),
            "email": c.get("email") or d.get("email"),
            "cliEmail": c.get("email"),
            "desktopEmail": d.get("email"),
            "plan": c.get("subscriptionType"),
            "usage": usage_for(m, records, saved),
        })
    running = bool(desktop_processes())
    return {
        "cli": {"current": find_account("cli", cli_uuid),
                "email": owner["email"] if owner else cli_acc.get("emailAddress"),
                "loggedIn": bool(cli_live()[0]), "verified": bool(owner)},
        "desktop": {"current": find_account("desktop", d_uuid), "email": desktop_email_for(d_uuid),
                    "loggedIn": bool(d_uuid), "running": running,
                    "activity": desktop_activity() if running else {"open": 0, "recent": []}},
        "job": read_json(JOB_FILE, None),
        "accounts": accounts,
        "sessions": sessions_status(),
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
        u = a.get("usage")
        if u:
            fmt = lambda k: "已恢复" if u[k + "IsReset"] else f"{round(u[k] or 0)}%"
            print(f"     额度：5 小时 {fmt('fh')} · 本周 {fmt('sd')}"
                  f"（记录于 {_dt.datetime.fromtimestamp(u['at']):%m-%d %H:%M}）")
    if c["loggedIn"] and not c.get("verified", True):
        print("注意：确认不了 CLI 当前凭证属于哪个账号（凭证已过期且没法联网），上面的 CLI 当前按 ~/.claude.json 显示，可能不准")
    s = st["sessions"]
    if s["links"]:
        state = "还有旧版的目录链接，Desktop 存不了会话，请运行 sync-sessions 修复"
    elif s["inSync"]:
        state = "各账号一致"
    else:
        state = "当前账号有新改动，下次切号时自动合并"
    print(f"会话同步：{s['accounts']} 个账号目录，共 {s['count']} 个会话，{state}")


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


def main():
    ap = argparse.ArgumentParser(description="Claude 账号快速切换 + Desktop 会话同步")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
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
    desktop_flags(sub.add_parser("sync-sessions"))
    sub.add_parser("cancel")
    p = sub.add_parser("rename")
    p.add_argument("old")
    p.add_argument("new")
    p = sub.add_parser("remove")
    p.add_argument("name")
    p = sub.add_parser("move")
    p.add_argument("name")
    p.add_argument("direction", choices=["up", "down"])
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
        usage = read_json(USAGE_FILE, {}) or {}
        if a.old in usage:  # 额度记录按名字存，跟着改
            usage[a.new] = usage.pop(a.old)
            write_json(USAGE_FILE, usage)
        order = (read_json(CONFIG_FILE, {}) or {}).get("order") or []
        if a.old in order:  # 排序也跟着改
            set_order([a.new if n == a.old else n for n in order])
        log(f"已把账号「{a.old}」改名为「{a.new}」")
    elif a.cmd == "move":
        move_account(a.name, -1 if a.direction == "up" else 1)
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
    elif a.cmd == "sync-sessions":
        confirm_desktop_or_exit(a.yes)
        desktop_dispatch(a.cmd, None, force=a.force)
    else:
        name = getattr(a, "name", None)
        if name:
            account_dir(name)
        parts = [a.only] if a.only else ["cli", "desktop"]
        if a.cmd == "save" and not a.only:
            cli_uuid = (cli_owner() or {}).get("accountUuid") if cli_live()[0] else None
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
