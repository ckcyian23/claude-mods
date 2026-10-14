"""沙盒测试：用假的 HOME、假的 Desktop 目录和假 token 跑完整流程，不碰真实登录态，也不会关掉真实的 Desktop。

  python -I tests/claude-switch/test_switch.py
"""
import os, tempfile, sys, json, shutil, importlib.util
from pathlib import Path
root = Path(tempfile.gettempdir()) / "claude-switch-test" / "sandbox"
shutil.rmtree(root, ignore_errors=True)
home = root / "home"; appdata = root / "appdata"
os.environ.update(USERPROFILE=str(home), HOME=str(home), APPDATA=str(appdata))
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

spec = importlib.util.spec_from_file_location("ccs", str(Path(__file__).resolve().parents[2] / "claude-switch" / "claude_switch.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.desktop_processes = lambda: []
m.desktop_launch = lambda: m.log("(测试) 假装启动 Desktop")
def run(*args):
    print("\n$ claude_switch", *args); sys.argv = ["x", *args]
    try: m.main()
    except SystemExit as e: print("  -> exit", e.code)
def check(cond, msg):
    print(("  ✔ " if cond else "  ✘ 失败：") + msg)
    if not cond: check.fail = True
check.fail = False
rd = lambda p: json.loads(Path(p).read_text())

run("save", "__ckcyi")
run("link-sessions")
check(m.is_junction(dd/f"claude-code-sessions/{A}/{ORG_A}") and m.is_junction(dd/f"claude-code-sessions/{B}/{ORG_B}"), "两个账号目录都变成 junction")
check(sorted(os.listdir(dd/f"claude-code-sessions/{A}/{ORG_A}")) == ["local_s1.json", "local_s2.json"], "A 能看到 A、B 两个会话")
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
run("use", "_ckcyi")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKB" and rd(dd/"config.json")["lastKnownAccountUuid"] == B, "切到 B")
check((dd/f"claude-code-sessions/{B}/{ORG_B}/local_s3.json").exists(), "A 新建的会话在 B 下立刻可见")
run("use", "__ckcyi")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKA-NEW", "切回 A 时拿到轮换后的 CLI token")
check(rd(dd/"config.json")["oauth:tokenCache"] == "DTOKA-NEW", "切回 A 时拿到最新的 Desktop 登录态")
run("save", "_ckcyi")  # A 已存为 acctA，应拒绝
run("status")
run("unlink-sessions")
check(not m.is_junction(dd/f"claude-code-sessions/{A}/{ORG_A}") and len(os.listdir(dd/f"claude-code-sessions/{B}/{ORG_B}")) == 3, "撤销共享后恢复独立目录且内容完整")
check(not list((root).rglob("*.ccs-tmp")), "没有残留临时文件")
print("\n结果：", "有失败" if check.fail else "全部通过")
run("rename", "_ckcyi", "副号")
run("rename", "副号", "__ckcyi")
run("use", "副号", "--only", "cli")
check(rd(home/".claude/.credentials.json")["claudeAiOauth"]["accessToken"] == "TOKB" and rd(dd/"config.json")["lastKnownAccountUuid"] == A, "改名后能用新名字切换；--only cli 只切 CLI，Desktop 不动")
run("status")
print("\n最终：", "有失败" if check.fail else "全部通过")
