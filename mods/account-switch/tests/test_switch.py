"""沙盒测试：用假的 HOME、假的 Desktop 目录和假 token 跑完整流程，不碰真实登录态，也不会关掉真实的 Desktop。

  python -I mods/account-switch/tests/test_switch.py
"""
import os, tempfile, sys, json, shutil, importlib.util
from pathlib import Path
root = Path(tempfile.gettempdir()) / "claude-switch-test" / "sandbox"
shutil.rmtree(root, ignore_errors=True)
home = root / "home"; appdata = root / "appdata"; localappdata = root / "localappdata"
os.environ.update(USERPROFILE=str(home), HOME=str(home), APPDATA=str(appdata), LOCALAPPDATA=str(localappdata))
os.environ.pop("CLAUDE_DESKTOP_USER_DATA_DIR", None)
os.environ.pop("CLAUDE_CONFIG_DIR", None)
def w(p, d):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(d), encoding="utf-8")
A, B = "a" * 8 + "-1111-1111-1111-111111111111", "b" * 8 + "-2222-2222-2222-222222222222"
ORG_A, ORG_B = "0" * 8 + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "0" * 8 + "-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
def login_cli(uuid, email, tok):
    w(home/".claude/.credentials.json", {"claudeAiOauth": {"accessToken": tok, "refreshToken": tok+"r"}, "other": 1})
    cfg = json.loads((home/".claude.json").read_text()) if (home/".claude.json").exists() else {"projects": {"x": 1}}
    cfg["oauthAccount"] = {"accountUuid": uuid, "emailAddress": email}; w(home/".claude.json", cfg)
dd = appdata / "Claude"
def login_desktop(uuid, tok):
    w(dd/"config.json", {"locale": "zh", "oauth:tokenCache": tok, "oauth:tokenCacheV2": tok+"2", "lastKnownAccountUuid": uuid})
    w(dd/"Network/Cookies", {"c": tok}); w(dd/"Local Storage/leveldb/x.log", {"t": tok}); (dd/"Local Storage/leveldb/LOCK").write_text("")
    w(dd/"Local State", {"k": 1})
login_cli(A, "a@x.com", "TOKA"); login_desktop(A, "DTOKA")
w(dd/f"claude-code-sessions/{A}/{ORG_A}/local_s1.json", {"t": "A1"})
w(dd/f"claude-code-sessions/{B}/{ORG_B}/local_s2.json", {"t": "B1"})
w(dd/"claude_desktop_config.json", {"mcp": "shared"})

spec = importlib.util.spec_from_file_location("ccs", str(Path(__file__).resolve().parents[1] / "scripts" / "claude_switch.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.desktop_processes = lambda: []
m.desktop_launch = lambda: m.log("(测试) 假装启动 Desktop")
# 不联网：假的服务器按 token 前缀回答账号归属和额度
OWNERS = {"TOKA": (A, "a@x.com", ORG_A), "TOKB": (B, "b@x.com", ORG_B), "TOKC": ("c" * 8 + "-3333-3333-3333-333333333333", "c@x.com", ORG_B)}
API_CALLS = []
def fake_api(path, token, timeout=8):
    API_CALLS.append(path)
    uuid, email, org = OWNERS[token[:4]]
    if path == "/api/oauth/profile":
        return {"account": {"uuid": uuid, "email": email}, "organization": {"uuid": org}}
    return {"five_hour": {"utilization": 40.0, "resets_at": "2099-01-01T00:00:00+00:00"},
            "seven_day": {"utilization": 12.0, "resets_at": "2000-01-01T00:00:00+00:00"}}
m.api_get = fake_api
m.token_valid = lambda oauth: bool(oauth.get("accessToken"))
def run(*args):
    print("\n$ claude_switch", *args); sys.argv = ["x", *args]
    try: m.main()
    except SystemExit as e: print("  -> exit", e.code)
def check(cond, msg):
    print(("  ✔ " if cond else "  ✘ 失败：") + msg)
    if not cond: check.fail = True
check.fail = False
rd = lambda p: json.loads(Path(p).read_text(encoding="utf-8"))

# 早期版本留下的 junction：同步时应换回真实目录（Desktop 拒绝往链接里写）
legacy = home/".claude-switch/shared/claude-code-sessions"; w(legacy/"local_s0.json", {"t": "old-shared"})
shutil.move(str(dd/f"claude-code-sessions/{B}/{ORG_B}/local_s2.json"), str(legacy/"local_s2.json"))
os.rmdir(dd/f"claude-code-sessions/{B}/{ORG_B}")
import subprocess; subprocess.run(["cmd", "/c", "mklink", "/J", str(dd/f"claude-code-sessions/{B}/{ORG_B}"), str(legacy)], capture_output=True)
check(m.is_junction(dd/f"claude-code-sessions/{B}/{ORG_B}"), "（准备）B 目录是旧版 junction")
run("save", "__ckcyi")
run("sync-sessions")
check(not m.is_junction(dd/f"claude-code-sessions/{A}/{ORG_A}") and not m.is_junction(dd/f"claude-code-sessions/{B}/{ORG_B}"), "同步后两个账号目录都是真实目录，不是链接")
check(sorted(os.listdir(dd/f"claude-code-sessions/{A}/{ORG_A}")) == ["local_s0.json", "local_s1.json", "local_s2.json"], "A 能看到所有会话")
check(sorted(os.listdir(dd/f"claude-code-sessions/{B}/{ORG_B}")) == ["local_s0.json", "local_s1.json", "local_s2.json"], "B 也能看到所有会话")
check(any(p.name.startswith("sessions-") for p in (home/".claude-switch/backups").iterdir()), "同步前做了备份")
# 模拟登录 B（login-new 后重新登录）
run("login-new")
check("oauthAccount" not in rd(home/".claude.json") and "claudeAiOauth" not in rd(home/".claude/.credentials.json"), "CLI 登录态被清掉")
check("oauth:tokenCache" not in rd(dd/"config.json") and rd(dd/"config.json")["locale"] == "zh", "Desktop 登录态清掉，其它配置保留")
check(not (dd/"Network").exists() and (dd/"Local State").exists(), "Desktop 网络/Cookie 清掉，Local State 保留")
login_cli(B, "b@x.com", "TOKB"); login_desktop(B, "DTOKB")
run("save", "_ckcyi")
# A 的 token 在使用中轮换过：模拟 A 的快照已旧
run("use", "__ckcyi")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKA", "CLI 切回 A")
check(rd(home/".claude/.credentials.json")["other"] == 1 and rd(home/".claude.json")["projects"] == {"x": 1}, "CLI 其它配置没被动")
check(rd(dd/"config.json")["oauth:tokenCache"] == "DTOKA" and rd(dd/"Network/Cookies")["c"] == "DTOKA", "Desktop 切回 A")
check(rd(dd/"claude_desktop_config.json")["mcp"] == "shared", "MCP 配置不随账号切换")
# 在 A 下 token 轮换，然后切到 B 再切回 A，应拿到轮换后的 token
w(home/".claude/.credentials.json", {"claudeAiOauth": {"accessToken": "TOKA-NEW"}, "other": 1})
c = rd(dd/"config.json"); c["oauth:tokenCache"] = "DTOKA-NEW"; w(dd/"config.json", c)
w(dd/f"claude-code-sessions/{A}/{ORG_A}/local_s3.json", {"t": "A-new"})
w(dd/f"claude-code-sessions/{A}/{ORG_A}/local_s1.json", {"t": "A1-updated"})
os.utime(dd/f"claude-code-sessions/{A}/{ORG_A}/local_s1.json", (2e9, 2e9))
(dd/f"claude-code-sessions/{A}/{ORG_A}/local_s0.json").unlink(); w(dd/f"claude-code-sessions/{A}/{ORG_A}/deleted_s0", {})
run("use", "_ckcyi")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKB" and rd(dd/"config.json")["lastKnownAccountUuid"] == B, "切到 B")
check((dd/f"claude-code-sessions/{B}/{ORG_B}/local_s3.json").exists(), "A 新建的会话切到 B 后可见")
check(rd(dd/f"claude-code-sessions/{B}/{ORG_B}/local_s1.json")["t"] == "A1-updated", "A 里改过的会话，B 拿到的是新版本")
check(not (dd/f"claude-code-sessions/{B}/{ORG_B}/local_s0.json").exists() and (dd/f"claude-code-sessions/{B}/{ORG_B}/deleted_s0").exists(), "A 里删掉的会话，B 里也删掉")
check(not m.is_junction(dd/f"claude-code-sessions/{B}/{ORG_B}"), "切号后仍是真实目录")
run("use", "__ckcyi")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKA-NEW", "切回 A 时拿到轮换后的 CLI token")
check(rd(dd/"config.json")["oauth:tokenCache"] == "DTOKA-NEW", "切回 A 时拿到最新的 Desktop 登录态")
run("save", "_ckcyi", "--only", "cli")  # A 已经存为 __ckcyi：沿用原来的名字，不能把 A 存进 B 的名字
check(m.load_meta("_ckcyi")["cli"]["accountUuid"] == B and m.load_meta("__ckcyi")["cli"]["accountUuid"] == A,
      "保存时名字写错了：已有的账号沿用原来的名字，不会覆盖别的号")
import time
check(rd(home/".claude-switch/usage.json")["__ckcyi"]["fh"] == 40.0, "保存时顺便记下了这个号的额度")
now = time.time()  # 两小时前记的：5 小时窗口还没到点，本周窗口一分钟前刚重置
w(home/".claude-switch/usage.json", {"__ckcyi": {"fh": 40.0, "fhReset": now + 3600, "sd": 12.0, "sdReset": now - 60, "at": now - 7200}})
u = m.status_data()["accounts"][0]["usage"]
check(u["fh"] == 40.0 and not u["fhIsReset"] and u["sd"] == 0 and u["sdIsReset"], "额度：没到点的照常显示，到点重置的显示为已恢复")
# Desktop 托管的会话把 ~/.claude.json 改成了别的号：CLI 当前要按凭证本身判断，切走时不能把 A 的凭证写进 B 的快照
cfg = rd(home/".claude.json"); cfg["oauthAccount"] = {"accountUuid": B, "emailAddress": "b@x.com"}; w(home/".claude.json", cfg)
w(home/".claude/.credentials.json", {"claudeAiOauth": {"accessToken": "TOKA-ROTATED"}, "other": 1})
check(m.status_data()["cli"]["current"] == "__ckcyi", "账号信息和凭证对不上时，按凭证认出 CLI 当前是 A")
run("use", "_ckcyi", "--only", "cli")
check(rd(home/".claude-switch/accounts/_ckcyi/cli/credentials.json")["claudeAiOauth"]["accessToken"] == "TOKB"
      and rd(home/".claude-switch/accounts/__ckcyi/cli/credentials.json")["claudeAiOauth"]["accessToken"] == "TOKA-ROTATED",
      "错位时切号：A 的新凭证写回 A，B 的快照不受影响")
# 新账号 C 想用已经被 B 占用的名字：要提醒并拒绝
login_cli("c" * 8 + "-3333-3333-3333-333333333333", "c@x.com", "TOKC")
run("save", "_ckcyi", "--only", "cli")
check(m.load_meta("_ckcyi")["cli"]["accountUuid"] == B, "名字被别的号占用时拒绝保存")
run("use", "__ckcyi", "--only", "cli")
names = lambda: [a["name"] for a in m.status_data()["accounts"]]
check(m.pinned_account() == "__ckcyi" and names() == ["__ckcyi", "_ckcyi"], "Desktop 当前的号排在第一")
w(home/".claude-switch/accounts/甲/meta.json", {"name": "甲"})
check(names() == ["__ckcyi", "_ckcyi", "甲"], "（准备）第三个号排在后面")
run("move", "甲", "up")
check(names() == ["__ckcyi", "甲", "_ckcyi"], "其余的号之间可以调整顺序")
run("move", "甲", "up")
check(names() == ["__ckcyi", "甲", "_ckcyi"], "不能挪到 Desktop 当前的号前面")
run("move", "__ckcyi", "down")
check(names()[0] == "__ckcyi", "Desktop 当前的号固定在第一，不参与排序")
shutil.rmtree(home/".claude-switch/accounts/甲")
run("status")
check(not list((root).rglob("*.ccs-tmp")), "没有残留临时文件")
print("\n结果：", "有失败" if check.fail else "全部通过")
run("rename", "_ckcyi", "副号")
run("rename", "副号", "__ckcyi")
run("use", "副号", "--only", "cli")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKB" and rd(dd/"config.json")["lastKnownAccountUuid"] == A, "改名后能用新名字切换；--only cli 只切 CLI，Desktop 不动")
run("status")
# 只存过 CLI 的号丙补登 Desktop：认出是同一个号，切走时自动把 Desktop 补存进「丙」
C = "c" * 8 + "-3333-3333-3333-333333333333"
login_cli(C, "c@x.com", "TOKC"); run("save", "丙", "--only", "cli")
login_desktop(C, "DTOKC")
st = m.status_data()
check(st["desktop"]["current"] == "丙" and st["desktop"]["saved"] is False, "Desktop 登录了只存过 CLI 的号：认出是「丙」，标记为还没保存")
run("use", "副号")
check(m.load_meta("丙")["desktop"]["accountUuid"] == C and rd(home/".claude-switch/accounts/丙/desktop/config-auth.json")["oauth:tokenCache"] == "DTOKC",
      "切走时把 Desktop 自动补存进「丙」")
# CLI 和 Desktop 不是同一个号：存过的那边沿用原名，新号用这次的名字
D = "d" * 8 + "-4444-4444-4444-444444444444"
login_desktop(D, "DTOKD")
run("save", "副号")
check(m.load_meta("副号")["desktop"]["accountUuid"] == B, "（新号不能用另一边的名字）副号的 Desktop 没被覆盖")
run("save", "丁")
check(m.load_meta("丁")["desktop"]["accountUuid"] == D and "cli" not in m.load_meta("丁") and m.load_meta("副号")["cli"]["accountUuid"] == B,
      "两边不同号时各存各的：Desktop 新号存为「丁」，CLI 沿用「副号」")
run("remove", "丙"); run("remove", "丁")
w(home/".claude-switch/accounts/乙/meta.json", {"name": "乙"}); m.set_order(["乙", "__ckcyi"])
w(home/".claude-switch/usage.json", {**rd(home/".claude-switch/usage.json"), "乙": {"fh": 1}})
run("remove", "乙")
check(not (home/".claude-switch/accounts/乙").exists() and "乙" not in rd(home/".claude-switch/usage.json")
      and "乙" not in rd(home/".claude-switch/config.json")["order"], "remove：快照移到回收站，额度和排序记录也清掉")
# Desktop 把数据搬到 %LOCALAPPDATA%\Claude-Data\<包名>，旧目录留下标记：之后都要操作新目录
moved = localappdata / "Claude-Data" / "claude_testpkg"
shutil.copytree(dd, moved)
(dd/".user-data-left.claude_testpkg").write_text("")
check(m.desktop_dir() == moved, "Desktop 数据搬家后，找到新的数据目录")
run("login-new", "--only", "desktop")
check("oauth:tokenCache" not in rd(moved/"config.json") and not (moved/"Network").exists(), "login-new 清掉的是新目录里的登录态")
check("oauth:tokenCache" in rd(dd/"config.json"), "旧目录不动")
# 后台进程在 MSIX 包外：看不到 %APPDATA%\Claude，只能找到包目录，包目录里的搬家标记也要认
pkgdir = localappdata / "Packages" / "Claude_testpkg" / "LocalCache" / "Roaming" / "Claude"
pkgdir.parent.mkdir(parents=True); shutil.move(str(dd), str(pkgdir))
check(m.desktop_dir() == moved, "在包外运行时，也能从包目录的标记找到新的数据目录")
shutil.move(str(pkgdir), str(dd))
print("\n最终：", "有失败" if check.fail else "全部通过")
