"""claude-switch 的图形界面：独立窗口（pywebview + 系统自带的 WebView2）显示 ui.html。

界面背后是一个只监听 127.0.0.1 的小服务器，每个请求都要带随机口令，并用 CSP 禁止页面
连接本机服务以外的任何地址。界面只拿得到账号名、邮箱、套餐，拿不到 token；实际操作全部交给
claude_switch.py。窗口关闭后程序退出。

  claude_switch_ui.py            打开窗口
  claude_switch_ui.py --demo     演示数据，不执行任何真实操作（调样式用）
  claude_switch_ui.py --no-open  只启动服务器并打印地址
"""

import argparse
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "claude_switch.py"
PYTHON = Path(sys.executable).with_name("python.exe")
if not PYTHON.exists():
    PYTHON = Path(sys.executable)
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW
ALLOWED = {"use", "save", "login-new", "rename", "remove", "cancel"}
TOKEN = secrets.token_urlsafe(24)
DEMO = False
last_seen = time.time()

DEMO_STATUS = {
    "cli": {"current": "__ckcyi", "email": "main@example.com", "loggedIn": True},
    "desktop": {"current": "__ckcyi", "email": "main@example.com", "loggedIn": True, "running": True,
                "activity": {"open": 3, "recent": ["Claude 多账号代码会话同步", "周报整理"]}},
    "job": None,
    "accounts": [
        {"name": "__ckcyi", "hasCli": True, "hasDesktop": True, "email": "main@example.com",
         "cliEmail": "main@example.com", "desktopEmail": "main@example.com", "plan": "pro"},
        {"name": "_ckcyi", "hasCli": True, "hasDesktop": True, "email": "second@example.com",
         "cliEmail": "second@example.com", "desktopEmail": "second@example.com", "plan": "pro"},
        {"name": "work", "hasCli": False, "hasDesktop": True, "email": "work@example.com",
         "cliEmail": None, "desktopEmail": "work@example.com", "plan": None},
    ],
    "sessions": {"accounts": 2, "count": 14, "inSync": True, "links": 0},
}


def run_script(*args):
    r = subprocess.run([str(PYTHON), "-I", str(SCRIPT), *args], capture_output=True,
                       creationflags=NO_WINDOW)
    return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace").strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        # 只允许连回本机这个服务；其它任何网络连接（外部请求、图片、字体等）都被内核直接拦截
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                         "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; "
                         "frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        q = parse_qs(urlparse(self.path).query)
        return secrets.compare_digest(self.headers.get("X-Token") or (q.get("t") or [""])[0], TOKEN)

    def do_GET(self):
        global last_seen
        path = urlparse(self.path).path
        if path == "/":
            if not self.authed():
                return self.send(403, "forbidden", "text/plain")
            html = (HERE / "ui.html").read_text(encoding="utf-8").replace("__TOKEN__", TOKEN)
            return self.send(200, html, "text/html; charset=utf-8")
        if not self.authed():
            return self.send(403, '{"error":"forbidden"}')
        last_seen = time.time()
        if path == "/api/status":
            if DEMO:
                return self.send(200, json.dumps(DEMO_STATUS, ensure_ascii=False))
            code, out = run_script("status", "--json")
            return self.send(200 if code == 0 else 500, out if code == 0 else json.dumps({"error": out}))
        self.send(404, "{}")

    def do_POST(self):
        global last_seen
        path = urlparse(self.path).path
        if not self.authed():
            return self.send(403, '{"error":"forbidden"}')
        last_seen = time.time()
        if path == "/api/ping":
            return self.send(200, "{}")
        if path == "/api/bye":
            last_seen = 0
            return self.send(200, "{}")
        if path == "/api/run":
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            args = body.get("args") or []
            if not args or args[0] not in ALLOWED or not all(isinstance(x, str) for x in args):
                return self.send(400, json.dumps({"code": 2, "out": "不支持的操作"}, ensure_ascii=False))
            if DEMO:
                if "--yes" in args:  # 模拟后台进度：正在退出 → 等用户确认退出 → 完成
                    def fake_job():
                        for st, msg, wait in (
                                ("quitting", "正在正常退出 Claude Desktop（不会强制结束）…", 2),
                                ("waiting", "Claude Desktop 还没退出（可能缩到了托盘，或者正在问你是否确认退出）。"
                                            "请在 Desktop 里确认退出，或右键托盘图标选「退出」。", 4),
                                ("done", "完成（演示）", 0)):
                            DEMO_STATUS["job"] = {"state": st, "message": msg, "at": time.time()}
                            time.sleep(wait)
                    threading.Thread(target=fake_job, daemon=True).start()
                time.sleep(0.8)
                return self.send(200, json.dumps({"code": 0, "out": f"（演示）{' '.join(args)} 完成"},
                                                 ensure_ascii=False))
            code, out = run_script(*args)
            return self.send(200, json.dumps({"code": code, "out": out}, ensure_ascii=False))
        self.send(404, "{}")


ICON = HERE / "icon.ico"


def set_window_icon(window):
    """WinForms 窗体默认用 pythonw.exe 的图标，这里换成 icon.ico。"""
    try:
        from System import Action
        from System.Drawing import Icon
        form = window.native
        icon = Icon(str(ICON))
        form.Invoke(Action(lambda: setattr(form, "Icon", icon)))  # 必须在 UI 线程里改
    except Exception:
        pass


TITLE = "Claude 切号"
_mutex = None


def already_running():
    """已经有一个窗口开着时，把它叫到最前面并返回 True（只允许开一个）。"""
    global _mutex
    import ctypes
    from ctypes import wintypes
    k32, u32 = ctypes.WinDLL("kernel32", use_last_error=True), ctypes.WinDLL("user32")
    k32.CreateMutexW.restype = wintypes.HANDLE
    u32.FindWindowW.restype = wintypes.HWND
    _mutex = k32.CreateMutexW(None, False, "Local\\ckcyi.claude-switch.ui")
    if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
        return False
    for _ in range(50):  # 另一个可能刚启动、窗口还没出来，最多等 5 秒
        hwnd = u32.FindWindowW(None, TITLE)
        if hwnd:
            # 先最小化再还原：没有前台权限时 SetForegroundWindow 只会闪任务栏，这样能保证窗口弹到前面
            if not u32.IsIconic(hwnd):
                u32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
            u32.ShowWindow(hwnd, 9)  # SW_RESTORE
            u32.SetForegroundWindow(hwnd)
            return True
        time.sleep(0.1)
    return True


def open_window(url):
    """独立窗口（pywebview + 系统自带的 WebView2），窗口关闭时返回。"""
    import webview
    # 在浏览器内核层面也关掉 WebRTC 的非代理 UDP，彻底不会经 WebRTC 暴露本机 IP
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp "
        "--webrtc-ip-handling-policy=disable_non_proxied_udp")
    window = webview.create_window(TITLE, url, width=780, height=700, min_size=(600, 520),
                                   background_color="#F5F4EE")
    window.events.shown += lambda: set_window_icon(window)
    webview.start(private_mode=True)


def main():
    global DEMO
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--port", type=int, default=0)
    a = ap.parse_args()
    DEMO = a.demo
    if not (a.demo or a.no_open) and already_running():
        return
    try:  # 任务栏上单独成组、显示自己的图标，而不是和 Python 混在一起
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ckcyi.claude-switch")
    except Exception:
        pass
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{srv.server_address[1]}/?t={TOKEN}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    if a.no_open:
        print(url, flush=True)
        while time.time() - last_seen < 600:
            time.sleep(1)
    else:
        open_window(url)
    srv.shutdown()


if __name__ == "__main__":
    main()
