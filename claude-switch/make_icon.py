"""生成 icon.ico：珊瑚色圆角方块 + 白色星形（与界面里的 logo 一致）。只用标准库。"""

import math
import struct
import zlib
from pathlib import Path

CORAL = (217, 119, 87)
WHITE = (255, 255, 255)


def coverage(x, y, size):
    """返回 (方块覆盖率, 星形覆盖率)，用 4x4 超采样抗锯齿。"""
    box = star = 0
    s = size / 24.0  # 按 24 单位的 SVG 坐标绘制
    r = 5.5 * s
    for i in range(4):
        for j in range(4):
            px, py = x + (i + .5) / 4, y + (j + .5) / 4
            # 圆角方块
            dx = max(abs(px - size / 2) - (size / 2 - r), 0)
            dy = max(abs(py - size / 2) - (size / 2 - r), 0)
            if dx * dx + dy * dy <= r * r:
                box += 1
                # 星形：4 条穿过中心的线段（与 ui.html 的 svg 路径相同）
                ux, uy = px / s - 12, py / s - 12
                hw = 1.15
                for ang in (0, 90, 45, 135):
                    a = math.radians(ang)
                    along = ux * math.cos(a) + uy * math.sin(a)
                    across = -ux * math.sin(a) + uy * math.cos(a)
                    lim = 6.6 if ang in (0, 90) else 6.4
                    d = max(abs(along) - lim, 0)
                    if d * d + across * across <= hw * hw:
                        star += 1
                        break
    return box / 16, star / 16


def render_png(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            b, st = coverage(x, y, size)
            st = min(st, b)
            col = tuple(round(CORAL[k] * (1 - st / b) + WHITE[k] * (st / b)) if b else 0 for k in range(3))
            row += bytes(col) + bytes([round(255 * b)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    sizes = [16, 24, 32, 48, 64, 256]
    pngs = [render_png(s) for s in sizes]
    out = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for s, p in zip(sizes, pngs):
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(p), offset)
        offset += len(p)
    out += b"".join(pngs)
    path = Path(__file__).with_name("icon.ico")
    path.write_bytes(out)
    print(path)


if __name__ == "__main__":
    main()
