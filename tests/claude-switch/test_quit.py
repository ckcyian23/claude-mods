"""沙盒测试：用假的 HOME、假的 Desktop 目录和假 token 跑完整流程，不碰真实登录态，也不会关掉真实的 Desktop。

  python -I tests/claude-switch/test_quit.py
"""
import os, tempfile, sys, time, threading, importlib.util
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
root = Path(tempfile.gettempdir()) / "claude-switch-test" / "quit-sandbox"
import shutil; shutil.rmtree(root, ignore_errors=True)
os.environ.update(USERPROFILE=str(root), HOME=str(root), APPDATA=str(root / "appdata"))
(root / "appdata" / "Claude").mkdir(parents=True)
spec = importlib.util.spec_from_file_location("cs", str(Path(__file__).resolve().parents[2] / "claude-switch" / "claude_switch.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
calls = []
m.desktop_processes = lambda: [1234]          # Desktop 永远不退出
m.run_hidden = lambda args, **k: calls.append(args)
# 1. 用户点取消
threading.Timer(2, lambda: m.CANCEL_FILE.write_text("1")).start()
t = time.time()
try: m.desktop_quit(wait_user=60)
except SystemExit: pass
print("取消：", m.read_json(m.JOB_FILE)["state"], "用时 %.0fs" % (time.time() - t))
# 2. 一直等不到（把等待时间缩短到 2 秒测试）
m.desktop_quit.__defaults__ = (False, 2)
import time as _t
orig = _t.time
try: m.desktop_quit(wait_user=2)
except SystemExit: pass
print("超时：", m.read_json(m.JOB_FILE)["state"], m.read_json(m.JOB_FILE)["message"])
print("发出的命令：", [" ".join(c) for c in calls])
print("有没有强制结束：", any("/F" in c for c in calls))
