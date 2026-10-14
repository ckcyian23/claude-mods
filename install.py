"""把本仓库里的 skill 装到 ~/.claude/skills（目录链接，改仓库立即生效），并安装 bin/ 下的命令。

  python install.py            安装全部 skill
  python install.py NAME ...   只安装指定的 skill
  python install.py --list     查看各 skill 的安装状态

只用标准库，可以反复运行。已经存在、但不是指向本仓库的同名 skill 不会被动，会提示你自己处理。
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = Path(__file__).resolve().parent
SKILLS_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "skills"
BIN_DIR = Path.home() / ".local" / "bin"


def repo_skills():
    return sorted(p for p in REPO.iterdir() if p.is_dir() and (p / "SKILL.md").exists())


def is_link(p):
    return os.path.islink(p) or (hasattr(os.path, "isjunction") and os.path.isjunction(p))


def link_dir(link, target):
    if os.name == "nt":
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
        if r.returncode != 0:
            raise OSError(r.stderr.decode("gbk", "replace").strip())
    else:
        os.symlink(target, link, target_is_directory=True)


def status(skill):
    link = SKILLS_DIR / skill.name
    if not os.path.lexists(link):
        return "未安装"
    if is_link(link):
        return "已安装" if os.path.realpath(link) == os.path.realpath(skill) else f"链接到别处：{os.path.realpath(link)}"
    return "已存在同名的普通目录（不是本仓库的）"


def install(skill):
    link = SKILLS_DIR / skill.name
    st = status(skill)
    if st == "已安装":
        print(f"  {skill.name}：已安装")
        return
    if os.path.lexists(link) and not is_link(link):
        print(f"  {skill.name}：跳过，{link} 是一个普通目录。确认不需要后，把它删掉或改名再运行一次。")
        return
    if is_link(link):
        os.rmdir(link) if os.name == "nt" else os.unlink(link)
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    link_dir(link, skill)
    print(f"  {skill.name}：已安装 -> {skill}")


def install_bin():
    src = REPO / "bin"
    if not src.exists():
        return
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        shutil.copy2(f, BIN_DIR / f.name)
        print(f"  命令：{f.name} -> {BIN_DIR}")


def main():
    ap = argparse.ArgumentParser(description="安装本仓库的 Claude skill")
    ap.add_argument("names", nargs="*")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    skills = repo_skills()
    if a.list:
        for s in skills:
            print(f"  {s.name}：{status(s)}")
        return
    if a.names:
        unknown = set(a.names) - {s.name for s in skills}
        if unknown:
            sys.exit(f"仓库里没有这些 skill：{', '.join(sorted(unknown))}")
        skills = [s for s in skills if s.name in a.names]
    print(f"安装到 {SKILLS_DIR}")
    for s in skills:
        install(s)
    install_bin()


if __name__ == "__main__":
    main()
