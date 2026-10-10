# -*- coding: utf-8 -*-
"""tools/rerender.py —— 「双击一下就开跑」的**编排层**。

为什么不把逻辑写在 `.cmd` 里：
  ① `cmd.exe` 用**系统 ANSI 码页**读 `.cmd` ⇒ 脚本里只能写 ASCII（中文会被撕碎成乱命令），
     而这里要打的提示全是中文；
  ② 更要紧的是**本项目的会话里执行不了 `cmd.exe`**（被工具安全策略挡掉），
     逻辑写在 `.cmd` 里就等于「写完没验证」。⇒ `.cmd` 只留一行：调这个模块。
     **所有判断都在这里，可以真跑、可以测**（`--check` 就是为验证它而留的）。

⚠️ 它**不碰出图口径**：该出哪张、跳过哪张，判据全在 `tools/gen-art.py` 的 `card_state()`
   （`--skip-existing` 与 `--stale` 共用同一份）。这里只负责
   「自检 → 报数 → 反复调 gen-art → 提示下一步」。

用法：
    python tools/rerender.py                 # 自检 → 报数 → 开跑（不限时长）
    python tools/rerender.py --check         # **只自检 + 报数**，一张都不出（安全）
    python tools/rerender.py -m 30           # 每 30 分钟收一次工，然后接着跑
"""
import argparse
import io
import os
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(ROOT, 'tools', 'gen-art.py')
CARDS = os.path.join(ROOT, 'assets', 'cards')
COMFY = ('127.0.0.1', 8188)


def say(msg=''):
    print(msg, flush=True)


def head(title):
    say('=' * 59)
    say('  ' + title)
    say('=' * 59)


def comfy_up(timeout=3.0):
    """ComfyUI 在不在。**用 TCP 连一下**，不依赖 HTTP 状态码的细节。"""
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect(COMFY)
        return True
    except OSError:
        return False
    finally:
        s.close()


def preflight():
    """三项硬自检。返回 True 才允许开跑。

    🔴 **锁的判据不在本文件里** —— 去问 `gen-art.py --who`（它读的是模块级的
       `lock_state()`，与出图时决定「要不要接管」的是**同一份**）。
       为什么必须这样：启动器自己写一份「看到锁就拦住」，必然**比出图脚本更严** ——
       上一轮非正常退出留下的陈旧锁（pid 已死 / 心跳过期）明明可以接管，
       却把用户白挡一轮；而这在本环境是**常态**（进程会被回收，锁留下）。
       实测就是这么栽的：第一版 preflight 真拦住了一次「其实可以开跑」的启动。
    """
    say('[1/4] 自检')
    ok = True
    r = subprocess.run([sys.executable, '-u', GEN, '--who'], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    # ⚠️ 取**最后一行**：`gen-art.py` 在 import 期会打一句加载自检的横幅
    #    （`check_deep_motifs()`），那不是答案。
    out = [x.strip() for x in (r.stdout or '').split('\n') if x.strip()]
    line = out[-1] if out else '(没有输出)'
    if r.returncode == 0:
        say('  [ok] 没有别的批次在跑 —— %s' % line)
    else:
        say('  [!] %s' % line)
        say('      **不要同时跑两个批次**（它们会抢同一份台账与同一批文件）。')
        say('      真确认没在跑的话，删掉 assets/cards/.gen-art.lock 再双击本脚本。')
        ok = False
    if comfy_up():
        say('  [ok] ComfyUI 在线（%s:%d）' % COMFY)
    else:
        say('  [!] 连不上 ComfyUI（%s:%d）—— 先把 ComfyUI Desktop 开起来再跑' % COMFY)
        ok = False
    if not os.path.isdir(CARDS):
        say('  [!] 找不到 %s' % os.path.relpath(CARDS, ROOT))
        ok = False
    say()
    return ok


def summary():
    """调 `gen-art.py --stale --brief` 报数（**只读**）。"""
    say('[2/4] 有多少张要重出')
    r = subprocess.call([sys.executable, '-u', GEN, '--stale', '--brief'], cwd=ROOT)
    say()
    return r


def render(budget_min):
    """反复调 `--skip-existing --budget-min N`，直到「不限时长」那一轮跑完。

    ⚠️ `--skip-existing` 的判据与 `--stale` **同源**（`card_state()`）⇒
       过期的卡不会被静默跳过（2026-10-10 之前会，那时它只看文件在不在）。
    """
    say('[3/4] 开始出图（关掉窗口就停；随时可以重跑续上）')
    say()
    n = 0
    while True:
        n += 1
        cmd = [sys.executable, '-u', GEN, '--skip-existing', '--budget-min', str(budget_min)]
        rc = subprocess.call(cmd, cwd=ROOT)
        say()
        if rc != 0:
            say('[!] 这一段退出码 = %d（下一段继续；反复失败就去看上面的输出）' % rc)
        if budget_min <= 0:
            return rc
        say('第 %d 段结束，2 秒后继续…' % n)
        try:
            import time
            time.sleep(2)
        except KeyboardInterrupt:
            return 0


def next_steps():
    say('=' * 59)
    say('[4/4] 跑完了，接下来做这几件')
    say('  图    ：assets/cards/     台账：assets/cards/manifest.json')
    say('  确认  ：python tools/gen-art.py --stale --brief   （应当报 0 张）')
    say()
    say('  ① 挑传说的闪光（**只有传说档**有 2 版可选，27 条）')
    say('     双击 tools/pick-shiny.cmd 看候选，再 pick-shiny.cmd A44 2 换上去')
    say('  ② 机器验收（要带 PIL 的那个 python）')
    say('     C:/Users/15001/miniconda3/python.exe tools/check-cards.py')
    say('  ③ 门禁')
    say('     node tools/test.js  &&  node tools/verify.js')
    say('  ④ 用眼睛看图：双击 tools/review-desk.cmd')
    say('=' * 59)


def main():
    ap = argparse.ArgumentParser(description='一键重出（编排层，判据在 gen-art.py）')
    ap.add_argument('--check', action='store_true', help='只自检 + 报数，一张都不出')
    ap.add_argument('-m', '--budget-min', type=float, default=0,
                    help='每段多少分钟（0 = 不限，一口气跑完）')
    args = ap.parse_args()

    head('钓鱼人生 · 重出卡片（过期的那些）')
    say('工作目录：%s' % ROOT)
    say('时长    ：%s' % ('不限' if args.budget_min <= 0 else '%g 分钟一段（跑完接着下一段）'
                          % args.budget_min))
    say('提示    ：每条鱼 6 张（母版 + 四档）；**传说档多 1 张** —— 传说的闪光出 2 版供人挑')
    say('          旧图会归档到 assets/cards/_superseded/（不会丢）')
    say()

    if not preflight():
        say('自检没过 —— 先按上面的提示处理，再重跑。')
        return 1
    summary()
    if args.check:
        say('（--check：只自检 + 报数，**一张都没出**。去掉 --check 就是真跑。）')
        return 0
    rc = render(args.budget_min)
    say()
    next_steps()
    return rc


if __name__ == '__main__':
    sys.exit(main())
