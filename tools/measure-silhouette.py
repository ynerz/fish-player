# -*- coding: utf-8 -*-
"""轮廓测量：按**同一套量法**比出两张图的宽高比与宽度剖面。

用法：
  python tools/measure-silhouette.py --mine-dir <目录> [选项]
  python tools/measure-silhouette.py --mine-dir _tmp/mine --only fish,shark

选项：
  --ref-dir DIR   v9 参考图目录（默认 `docs/images/v9-ref`，文件名 `<体型>.jpg`）
  --mine-dir DIR  **待测图**目录（文件名 `<体型>.png`）—— 必给，见下面那条现状
  --only LIST     只量这几个体型（逗号分隔；默认 fish,shark,ray,squid,jelly,dragon）
  --thr-mine N    待测图的背景色距阈值（默认 30；参考图固定 70）
  --ffmpeg PATH   显式指定 ffmpeg（等价于设 `FFMPEG` 环境变量）

为什么要有这个脚本：体型比例**不能靠肉眼估**。

⚠️ 现状（2026-10-12 核过 —— 这里此前有三句不成立的话，都已改成真话）：
  · 「v9 参考」列**有**现成数据：`docs/images/v9-ref/<体型>.jpg`（6 张）。
  · 「我的」列**没有生产者**：原先的来源是 3D 预览页的「对比 v9」视图 →
    `docs/images/m3d/`（⚠️ 代码里从来是 `m3d`，不是旧文件头写的 `_m3d`，那个目录
    从未存在过），已随 3D 撤销一起删除 ⇒ 这一列**必须**用 `--mine-dir` 指。
  · 旧文件头写着「或改参数指定目录」，而那时**根本没有参数解析** —— 只能量写死的那两个目录。
  🔴 旧行为最坏的一点：两个目录都不在时，六行全印「测量失败」而**退出码 0**
     （一条数据都没有，命令却"成功"）⇒ 现在改成逐行说明原因 + 有任何失败就以 1 退出。
  现成的新用途（接上哪个都能让这列复活）：量 `fishart.js` 的矢量出图 / 量 AI 卡面的构图归一结果。

外部程序：ffmpeg 依次从 `--ffmpeg` → `FFMPEG` 环境变量 → `PATH` → 本机常见位置解析；
  一个都找不到就**明确报错退出 1**，不再写死某一台机器上的路径。解析只有 `resolve_ffmpeg()` 一处。

退出码：0 = 每个体型都量到了 / 1 = 有任何一个失败（原因逐行说明）/ 2 = 用法错。
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
W, H = 900, 600
SHAPES = ["fish", "shark", "ray", "squid", "jelly", "dragon"]
THR_REF = 70          # 参考图（白底 jpg）的背景色距阈值
THR_MINE = 30         # 待测图（透明或浅底 png）的背景色距阈值
# 本机常见安装位置：只当**候选**，逐个做存在性检查（找不到不算错，继续往下报）
# ⚠️ 候选表里允许出现别处的路径，但**唯一来源是 resolve_ffmpeg()** ——
#    旧版把这行写成模块级常量 `FF` 直接喂给 subprocess，换台机器只能崩在 FileNotFoundError。
CANDIDATES = [
    r"C:/Users/15001/miniconda3/Library/bin/ffmpeg.exe",
    r"E:/novels/ffmpeg-7.0.2-full_build-shared/bin/ffmpeg.exe",
]


def resolve_ffmpeg(explicit):
    """ffmpeg 的解析**唯一入口**：显式 → 环境变量 → PATH → 本机候选。找不到返回 (None, 原因)。"""
    for cmd in [explicit, os.environ.get("FFMPEG")]:
        if cmd:
            if _is_file(cmd):
                return cmd, ""
            return None, "指定的 ffmpeg 不存在：%s" % cmd
    found = shutil.which("ffmpeg")
    if found:
        return found, ""
    for cand in CANDIDATES:
        if _is_file(cand):
            return cand, ""
    return None, ("PATH 与常见位置里都没有 ffmpeg —— 装一个，或用 --ffmpeg / FFMPEG 指过去。"
                  "已找过：\n    " + "\n    ".join(CANDIDATES))


def _is_file(p):
    try:
        return os.path.isfile(p)
    except OSError:
        return False


def profile_of(ff, path, thr):
    """量一张图 —— 返回 (结果, 原因)。原因非空 = 这一张没量到，且要说清是哪一种没量到。

    三种原因分开报（此前一律印「测量失败」，看不出是图不在、ffmpeg 起不来、还是量不出轮廓）：
      · `missing` 文件不在盘上（贴出路径 —— 这一列没有生产者时就是这个）
      · `ffmpeg`  ffmpeg 起不来 / 返回非 0（贴 stderr 尾巴）
      · `empty`   图在、ffmpeg 也跑通了，但整张图都是背景色（量不出轮廓）
    """
    if not os.path.isfile(path):
        return None, "missing|图不在：%s" % path
    r = subprocess.run([ff, "-loglevel", "error", "-y", "-i", path,
                        "-vf", "scale=%d:%d:flags=neighbor" % (W, H),
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], capture_output=True)
    if r.returncode != 0:
        tail = (r.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        return None, "ffmpeg|ffmpeg 退出码 %d：%s" % (r.returncode, tail[-1] if tail else "(无 stderr)")
    b = r.stdout
    if len(b) < W * H * 3:
        return None, "ffmpeg|ffmpeg 只吐回 %d 字节（不足一帧 %d）" % (len(b), W * H * 3)
    bg = (b[0], b[1], b[2])
    cols = []
    for x in range(W):
        top = bot = -1
        base = x * 3
        for y in range(H):
            i = base + y * W * 3
            if (abs(b[i] - bg[0]) + abs(b[i + 1] - bg[1]) + abs(b[i + 2] - bg[2])) > thr:
                if top < 0:
                    top = y
                bot = y
        cols.append((top, bot))
    xs = [x for x, (t, bo) in enumerate(cols) if t >= 0]
    if not xs:
        return None, "empty|量不出轮廓（整张图都是背景色，阈值 %d）" % thr
    x0, x1 = xs[0], xs[-1]
    bh = max(cols[x][1] for x in xs) - min(cols[x][0] for x in xs) + 1
    bw = x1 - x0 + 1
    prof = []
    for k in range(12):
        a = x0 + int(bw * k / 12)
        c = max(a + 1, x0 + int(bw * (k + 1) / 12))
        seg = [cols[x][1] - cols[x][0] + 1 for x in range(a, c) if cols[x][0] >= 0]
        prof.append(round(max(seg) / bh, 2) if seg else 0.0)
    return dict(ar=round(bw / bh, 2), fill=round(bw / W, 2), prof=prof), ""


def parse_args(argv):
    ap = argparse.ArgumentParser(
        description="轮廓测量：按同一套量法比出两张图的宽高比与宽度剖面（口径见文件头）。")
    ap.add_argument("--ref-dir", default=os.path.join(ROOT, "docs", "images", "v9-ref"),
                    help="v9 参考图目录（默认 docs/images/v9-ref，文件名 <体型>.jpg）")
    ap.add_argument("--mine-dir", required=True,
                    help="待测图目录（文件名 <体型>.png）。⚠️ 本列**没有生产者**（3D 已撤销），"
                         "必须显式指定；只给文件头里的用法示例是跑不起来的")
    ap.add_argument("--only", default=",".join(SHAPES),
                    help="只量这几个体型（逗号分隔，默认 %s）" % ",".join(SHAPES))
    ap.add_argument("--thr-mine", type=int, default=THR_MINE,
                    help="待测图的背景色距阈值（默认 %d；参考图固定 %d）" % (THR_MINE, THR_REF))
    ap.add_argument("--ffmpeg", default=None, help="显式指定 ffmpeg（等价于设 FFMPEG 环境变量）")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    shapes = [s.strip() for s in args.only.split(",") if s.strip()]
    if not shapes:
        print("[!] --only 解析出 0 个体型", file=sys.stderr)
        return 2
    ff, why = resolve_ffmpeg(args.ffmpeg)
    if not ff:
        print("[!] " + why, file=sys.stderr)
        return 1
    print("ffmpeg：%s" % ff)
    print("%-9s %-30s %s" % ("体型", "v9 参考（宽高比 / 剖面）", "待测（宽高比 / 剖面）"))
    print("-" * 96)
    n_ok, n_bad = 0, 0
    for k in shapes:
        a, ra = profile_of(ff, os.path.join(args.ref_dir, k + ".jpg"), THR_REF)
        b, rb = profile_of(ff, os.path.join(args.mine_dir, k + ".png"), args.thr_mine)
        if ra or rb:
            n_bad += 1
            print("%-9s \u274c 这一行没量到 —— 逐侧说原因（不再只印一句「测量失败」）：" % k)
            if ra:
                print("          · 参考侧：%s" % ra.split("|", 1)[1])
            if rb:
                print("          · 待测侧：%s" % rb.split("|", 1)[1])
            continue
        n_ok += 1
        print("%-9s 比 %5.2f  %s" % (k, a["ar"], a["prof"]))
        print("%-9s 比 %5.2f  %s" % ("", b["ar"], b["prof"]))
        print()
    print("-" * 96)
    print("成功 %d / 失败 %d（%s，%s）" % (
        n_ok, n_bad, args.ref_dir, args.mine_dir))
    if n_bad:
        print("⚠️ 有待测侧为 `missing` 时：这一列**没有生产者**（3D 已撤销），"
              "用 --mine-dir 指向你自己出的图（fishart.js 矢量出图 / AI 卡面）。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
