# -*- coding: utf-8 -*-
"""卡片评审台「重出」链路的测试（`tools/review-cards.py`）。

为什么要单独一个测试文件：
  这条链路上有两处**「错了就出事」**的地方，而它们都不在游戏运行时里、`tools/test.js`
  够不着：
    · `clean_groups()` —— 浏览器送来的 id / 档名会被**写进 .cmd 文件**再交给 cmd.exe
      以用户权限执行。少挡一个字符就是命令注入（`C01 & del /f /q …`）。
      这种判据必须**反向验证**：喂进坏样本，断言它真的被拒。
    · `build_console_script()` —— 生成的 .cmd 必须**全 ASCII**（cmd.exe 按系统 ANSI
      代码页读 .cmd，UTF-8 中文会被拆成乱命令；`tools/gen-art-loop.cmd` 的注释就是
      这条教训），且 master（母版）那一路**不能**带 `--only-morph`。

用法：
  python tools/test-review-cards.py            # 常规：不弹任何窗口
  python tools/test-review-cards.py --window   # 额外真开一个窗口验证「开窗口」这条路
                                               # （会闪一个控制台，几秒后自己关）
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = os.path.join(ROOT, "_tmp")
sys.path.insert(0, HERE)
import pydeps  # noqa: E402  —— 缺依赖的唯一出口（第 63 轮）
pydeps.need_pil("test-review-cards.py")   # 抢在 `from PIL import` 前面：缺 PIL 给一行话，不抛 traceback
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat
import wash  # noqa: E402  —— 洗注释的**唯一实现**（py 侧；Q95）
fails = []


# `tools/` 目录（[14] 节要按文件名去读几份启动器与 `gen-art.py`）——
# ⚠️ 就是上面那个 `HERE`，别另起一份「同一个事实写两遍」。
TOOLS = HERE


def ok(msg):
    print("  \u2714 " + msg)


def check(cond, msg):
    if cond:
        ok(msg)
    else:
        fails.append(msg)
        print("  \u2716 " + msg)


def load_review():
    """按路径加载 `tools/review-cards.py`（文件名带短横，不能直接 import）。"""
    spec = importlib.util.spec_from_file_location(
        "review_cards", os.path.join(HERE, "review-cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_genart():
    """把 `tools/gen-art.py` 当模块载入（文件名带连字符，不能直接 import）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("gen_art", os.path.join(TOOLS, "gen-art.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_check():
    """按路径加载 `tools/check-cards.py`（同因：文件名带短横）。

    ⚠️ 本文件的文件名只写了 review-cards，但它是 `tools/` 下**唯一**的 python 测试宿主
       （`test.js` 够不着 python，`verify.js` 也跑不了外部命令 —— 见开发者文档 §8 的 EBUSY 那条）。
       第 [10] 节测的就是 check-cards 的跨档判据（构造数值，不依赖真实卡面）。
    """
    spec = importlib.util.spec_from_file_location(
        "check_cards", os.path.join(HERE, "check-cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_prep():
    """按路径加载 `tools/prep-cards.py`（第 [16] 节：卡面后处理）。"""
    spec = importlib.util.spec_from_file_location(
        "prep_cards", os.path.join(HERE, "prep-cards.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", action="store_true", help="额外真开一个窗口验证（会闪一下）")
    args = ap.parse_args()

    R = load_review()
    print("\n[1] clean_groups：白名单挡得住命令注入（喂坏样本，必须被拒）")
    bad_ids = [
        "C01 & del /f /q C:\\",     # cmd 的连接符 + 删除
        "C01|calc",                  # 管道
        "C01>out.txt",               # 重定向
        "../../etc/passwd",          # 路径穿越
        "C01'",                      # 引号
        "C01\"D07\"",                # 双引号（.cmd 里是定界符）
        "C01\nD07",                  # 换行（能插进一行新命令）
        "A" * 40,                    # 超长
        "",                          # 空
        "C01 D07",                   # 空白（会被当成两个参数）
    ]
    for x in bad_ids:
        got, rej = R.clean_groups([{"morph": "shiny", "ids": [x]}])
        check(not got and len(rej) == 1, "拒绝非法 id：%r" % x[:24])

    print("\n[2] clean_groups：合法输入照常通过（别把白名单写成拦路虎）")
    got, rej = R.clean_groups([{"morph": "shiny", "ids": ["D07", "A01", "SS77"]},
                               {"morph": "master", "ids": ["C02"]}])
    check(len(got) == 2 and not rej, "两个组合法通过（被拒 %d 项）" % len(rej))
    check(got[0]["ids"] == ["D07", "A01", "SS77"], "id 顺序与去重都对：%s" % got[0]["ids"])
    check(R.clean_groups([{"morph": "nope", "ids": ["D07"]}])[0] == [],
          "不认识的档名被拒（不许凭猜写进命令行）")
    check(R.clean_groups([{"morph": "shiny", "ids": ["D07", "D07"]}])[0][0]["ids"] == ["D07"],
          "重复 id 自动去重（同一张不跑两遍）")
    check(R.clean_groups("不是列表")[0] == [] and R.clean_groups(None)[0] == [],
          "畸形输入不抛异常、只当空（服务端不许被一个怪请求带崩）")

    print("\n[3] regen_argv：母版那一路**不能**带 --only-morph")
    m = R.regen_argv("master", ["C02"])
    check("--only-morph" not in m, "master：没有 --only-morph（母版是独立出图，带了会漏）")
    s = R.regen_argv("shiny", ["D07"])
    check(m.count("--list") == 1 and s.count("--list") == 1, "两种都有 --list")
    check(s[s.index("--only-morph") + 1] == "shiny", "shiny：--only-morph shiny")
    check(m[m.index("--list") + 1] == "C02", "master：--list C02")

    print("\n[4] build_console_script：.cmd 内容必须全 ASCII、且指向真命令")
    groups, _ = R.clean_groups([{"morph": "shiny", "ids": ["D07"]},
                                {"morph": "master", "ids": ["C02", "C03"]}])
    txt = R.build_console_script(groups)
    try:
        txt.encode("ascii")
        ok("全 ASCII（cmd.exe 按 ANSI 码页读 .cmd，中文会被拆成乱命令）")
    except UnicodeEncodeError as e:
        check(False, "出现非 ASCII 字符：%r" % str(e)[:80])
    check(txt.startswith("@echo off"), "以 @echo off 开头")
    check("chcp 65001" in txt and "PYTHONUTF8=1" in txt, "带上 chcp 65001 与 PYTHONUTF8=1（Python 侧中文才算能看）")
    check("gen-art.py" in txt and '"--list" D07' .replace('"', "") in txt.replace('"', ""),
          "含闪光档那条命令（--list D07 --only-morph shiny）")
    check("--only-morph shiny" in txt, "闪光档带 --only-morph")
    check("--list C02,C03" in txt and "--only-morph" not in txt.split("--list C02,C03")[1][:40],
          "母版那条不带 --only-morph、且把两张收成一次调用")
    check("--prompt-only" not in txt, "非干跑：不带 --prompt-only")
    check("--prompt-only" in R.build_console_script(groups, dry=True), "干跑：带 --prompt-only")
    check(txt.rstrip().endswith("pause"), "结尾 pause（窗口不会一跑完就没了、看不清）")
    check("\r\n" in txt and "\n\n" not in txt.replace("\r\n", ""), "用 CRLF 换行（.cmd 的规矩）")
    # 🔴 echo 文本里不许有 cmd 的控制字符 —— 2026-10-08 真栽过：
    #    第一版写了 `echo [1/4] glitter x1  ->  C01,D12`，`>` 是**重定向**、`,` 是分隔符
    #    ⇒ 效果是「在仓库根写出一个叫 `C01` 的文件」，而且不报错（用户跑完才发现根目录多了垃圾）。
    #    ⚠️ 必须**只看 echo 行**：`chcp 65001 >nul` 里的 `>` 是正当用法。
    bad_echo = [l for l in txt.split("\r\n")
                if l.strip().startswith("echo") and any(c in l for c in "><&|^")]
    check(not bad_echo, "所有 echo 行都没有 cmd 控制字符（`>` `<` `&` `|` `^`），"
                        "要分隔用 `:` 不要用箭头 —— 实得 %r" % (bad_echo[:1] or "无"))
    # 反向自检：这条判据必须真能抓到原来的写法
    SYN_ECHO = "echo [1/4] glitter x1  ->  C01,D12"
    check(any(c in SYN_ECHO for c in "><&|^"),
          "判据自检：原来那个 `->` 写法会被上面这条抓到")

    print("\n[5] write_console_script：真的落一个文件，且能双击重跑")
    p = R.write_console_script(groups)
    check(os.path.exists(p), "文件已写出：%s" % os.path.relpath(p, ROOT))
    raw = io.open(p, "rb").read()
    # 🔴 踩过：写文件用 `newline="\r\n"` 会把已经是 CRLF 的文本**再转一遍**成 `\r\r\n`，
    #    盘上 33 行全中。cmd 会把多余的 `\r` 当行内容，而且「删掉结尾 pause 再跑」会静默失配。
    check(raw.count(b"\r\r\n") == 0,
          "盘上没有 CRCRLF（newline='\\r\\n' 的二次转换）—— 实得 %d 处"
          % raw.count(b"\r\r\n"))
    check(raw.count(b"\r\n") == txt.count("\r\n"),
          "盘的 CRLF 数（%d）与生成器一致（%d）" % (raw.count(b"\r\n"), txt.count("\r\n")))
    check(raw.count(b"\n") == raw.count(b"\r\n"), "没有裸 LF 行尾")
    check(os.path.abspath(p).startswith(os.path.abspath(TMP)),
          "写在 _tmp/ 下（.gitignore 已忽略，不会把仓库弄脏）")

    print("\n[6] launch_console：测试钩子不许真的开窗口")
    os.environ["REVIEW_NO_LAUNCH"] = "1"
    try:
        check(R.launch_console(p) is False, "REVIEW_NO_LAUNCH=1 时只返回 False、不开窗口")
    finally:
        del os.environ["REVIEW_NO_LAUNCH"]

    if args.window:
        print("\n[7] launch_console：真开一个窗口，验证「点击后自动打开」这条真能跑")
        marker = os.path.join(TMP, "launch-probe.txt")
        if os.path.exists(marker):
            os.remove(marker)
        probe = os.path.join(TMP, "launch-probe.cmd")
        # 写标记后自己退出（不 pause）—— 免得测试在桌面上留一个窗口
        io.open(probe, "w", encoding="ascii", newline="").write(
            "@echo off\r\necho launched-ok > \"%s\"\r\nexit /b 0\r\n" % marker)
        R.launch_console(probe)
        for _ in range(30):
            if os.path.exists(marker):
                break
            time.sleep(0.5)
        got = io.open(marker, encoding="utf-8").read().strip() if os.path.exists(marker) else ""
        check(got == "launched-ok", "新窗口真的把脚本跑起来了（读到标记文件 %r）" % got)
        check(subprocess.run(["tasklist", "/fi", "imagename eq cmd.exe"],
                             capture_output=True, text=True).returncode == 0,
              "（顺带）cmd.exe 可查 —— 窗口是不可见状态时也能被查")
    else:
        print("\n[7] 跳过「真开窗口」验证（要跑加 --window）")

    print("\n[8] 真跑一遍生成的脚本：仓库根**不许**多出垃圾文件")
    # 为什么值得真跑：上面第 4 节只拦「已知的控制字符」。而 2026-10-08 那次事故的形态是
    # 「echo 里的 `>` 变成重定向、在**仓库根**写了个文件，还一点错都不报」——
    # 脚本里 `cd /d ROOT` 是写死的，所以任何重定向都会落在仓库根。
    # 判据：跑一遍（干跑模式，几秒）前后**对比仓库根的文件清单**。
    before = set(os.listdir(ROOT))
    dry_script = R.write_console_script(groups, dry=True)
    # ⚠️ 读的时候必须 `newline=""`：默认的「通用换行」会把 CRLF 翻成 LF，
    #    于是下面删 pause 的正则静默失配 → 脚本停在 pause 上 → 测试挂死（我栽过一次）。
    body = io.open(dry_script, encoding="ascii", newline="").read()
    # 去掉结尾的 pause（不然要等按键），其余原样跑 —— 要测的就是原样那条脚本
    body = re.sub(r"\r?\npause\r?\n?$", "\r\n", body)
    check("pause" not in body.split("\r\n")[-2:], "测试用的脚本已去掉 pause（不会挂死）")
    runnable = os.path.join(TMP, "dry-run.cmd")
    io.open(runnable, "w", encoding="ascii", newline="").write(body)
    try:
        p = subprocess.run(["cmd", "/c", runnable], capture_output=True, text=True,
                           errors="replace", cwd=ROOT, timeout=60)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        rc = None
        check(False, "干跑脚本 60 秒没跑完 —— 多半是脚本里有 pause / 在等输入")
    after = set(os.listdir(ROOT))
    added = sorted(after - before)
    check(not added, "跑完仓库根没多出文件（多出来的是 %r）" % (added or "无"))
    if rc is not None:
        check(rc == 0, "干跑脚本退出码 0（实得 %d）" % rc)
    # 反向自检：把 `:` 换回 `->` 再跑一次，**必须**多出文件 —— 否则这条判据是摆设
    bad_body = body.replace("   :   ", "  ->  ")
    if bad_body == body:
        check(False, "反向自检没造出差异（分隔符写法变了？判据要跟着改）")
    else:
        # 🔴 2026-10-12（第 59 轮）实测的坑：这条自检**不是幂等的**。
        #   它会故意在仓库根写出垃圾文件（`C02` / `D07`），而清理只对「本次新增的」生效
        #    ⇒ 上一轮中途挂掉 / 判据本身报红（`added2` 为空 ⇒ 清理什么都没删）时，
        #    垃圾留在仓库根：`git status` 从此一直脏，**而下一次跑这条自检会因为
        #    「它已经在那儿了」而判红 —— 自证其罪、且永远不会自愈**（本轮真撞上：
        #    根目录躺着 22:57 生成的 `C02` / `D07`，这一节直接红）。
        #    修法三件：① 垃圾名**从坏脚本现算**（`>` 之后那个分词）；② 跑之前先把
        #    同名残留删掉并**如实报出来**（上一轮的锅不许算这一轮）；③ 放进 `finally` 清理。
        # ⚠️ 只从**带 `->` 的那几行**里现算垃圾名，而且只认合法文件名字符 ——
        #    否则会把脚本里别处的 `>nul`（设备名）与路径分隔符也当成垃圾名
        #    （第一版就中招：`junk_names` 里混进 `\` 与 `nul`，而 `ROOT/nul` 在 Windows 上
        #    `os.path.exists()` 竟然为真 ⇒ 最后那条「清干净了」永远报红）。
        junk_names = []
        for _ln in bad_body.split("\r\n"):
            if "->" not in _ln:
                continue
            for _m in re.finditer(r"->\s*([A-Za-z0-9_.-]+)", _ln):
                if _m.group(1) not in junk_names:
                    junk_names.append(_m.group(1))
        check(bool(junk_names),
              "坏脚本的重定向目标能现算出来（%r）—— 算不出来说明这节的自检要跟着改"
              % (junk_names or "无"))
        stale = [j for j in junk_names if os.path.exists(os.path.join(ROOT, j))]
        if stale:
            # 如实报告 + 清掉：这是**上一轮**留下的（本轮这一节的自检产物在 finally 里清）
            check(False, "仓库根有上一轮自检残留的垃圾文件 %r —— 已清掉；"
                         "它会让 `git status` 一直脏、并让本节自检永远报红（本轮已加幂等保护）"
                  % (stale,))
            for j in stale:
                try:
                    os.remove(os.path.join(ROOT, j))
                except OSError:
                    pass
        bad_cmd = os.path.join(TMP, "dry-run-bad.cmd")
        io.open(bad_cmd, "w", encoding="ascii", newline="").write(bad_body)
        before2 = set(os.listdir(ROOT))
        try:
            try:
                subprocess.run(["cmd", "/c", bad_cmd], capture_output=True, text=True,
                               errors="replace", cwd=ROOT, timeout=60)
            except subprocess.TimeoutExpired:
                pass
            added2 = sorted(set(os.listdir(ROOT)) - before2)
            check(bool(added2), "判据自检：改回 `->` 的写法**确实**会在仓库根写出文件（%r）"
                                "—— 这正是要拦的那个 bug" % (added2[:3] or "居然没写出来"))
        finally:
            # 清理一律走 finally（中途抛异常 / 判红也不留垃圾；口径同 `verify [32-y]`）
            for junk in set(added2 if "added2" in dir() else []) | set(junk_names):
                p_junk = os.path.join(ROOT, junk)
                if os.path.exists(p_junk):
                    try:
                        os.remove(p_junk)
                    except OSError:
                        pass
        check(not [j for j in junk_names if os.path.exists(os.path.join(ROOT, j))],
              "自检产物清干净了（仓库根不留垃圾：%r）" % (junk_names,))

    print("\n[9] shape_note：内部形态模板键翻成中文；交叉提示只提示不报错")
    # 为什么这条要有测试：评审页以前把 `fish.js` 第 4 参**裸印**在卡片上（`A03 · 稀有 · fish`），
    # 第一眼看成占位符 / 脏数据。改法有两半，都必须能被反向验证：
    #   ① 标签表（SHAPE_CN）的键集与 `fishart.js` 的 `TPL.<键>` **同源**；
    #   ② 交叉提示**只提示不报错** —— 模板是画法不是分类（八爪鱼用 squid 模板是合理的）。
    check(R.shape_note("shark", "皱鳃鲨") == ("鲨", ""),
          "鲨模板 + 名字带「鲨」→ 标签「鲨」、无提示")
    lb, hint = R.shape_note("fish", "深海龙鱼")
    check(lb == "通用鱼形" and u"龙鱼" in hint,
          "名字带「龙鱼」却用通用鱼形 → 出一句提示（%r）" % hint)
    lb, hint = R.shape_note("squid", "蓝环章鱼")
    check(lb == u"鱿/章鱼" and hint == "",
          "章鱼用 squid 模板 = **合理** ⇒ 不许提示（否则是假警报）")
    lb, hint = R.shape_note("blob", "某鱼")
    check(lb == "blob" and u"回落" in hint,
          "认不出的模板键：标签回落成键本身，且提示「画面上会回落成通用鱼形」")
    art = io.open(os.path.join(ROOT, "src", "render", "fishart.js"), encoding="utf-8").read()
    tpl = sorted(set(re.findall(r"\bTPL\.([A-Za-z][A-Za-z0-9]*)\s*=", art)))
    check(sorted(R.SHAPE_CN.keys()) == tpl,
          "SHAPE_CN 的键 == fishart.js 的 TPL 键（%d 个：%s）" % (len(tpl), "/".join(tpl)))
    fish = R.load_fish()
    names = [f["name"] for f in fish]
    dead = [w for _, ws in R.SHAPE_NAME_HINTS for w in ws
            if not any(w in n for n in names)]
    check(not dead, "提示词表里没有零命中的死词（实得 %r）" % (dead or "无"))
    hinted = [f["id"] for f in fish if R.shape_note(f["shape"], f["name"])[1]]
    print("      · 现算：%d 条名字里 %d 条出提示 %r"
          % (len(fish), len(hinted), hinted[:6]))
    rows = R.build_rows()
    if not rows:
        check(False, "build_rows() 一条都没有 —— assets/cards 里没有母版？本项跑不了")
    else:
        miss = [r["id"] for r in rows if not r.get("shapeCn")]
        check(not miss, "build_rows() 每行都带中文标签（%d 行，缺 %d 行）" % (len(rows), len(miss)))
    html, _n = R.build_page(None)
    check('"shapeCn"' in html, "产物里嵌了 shapeCn 字段（页内 JS 靠它渲染标签）")
    check("' · ' + d.shape +" not in html,
          "产物里不再把内部键裸印（应为 shapeTag(d)）")

    print("\n[10] check-cards 的跨档判据：提示级、指得准、阈值真的在比、同档多版只投一票")
    # 为什么放在本文件：`tools/` 下只有这一个 python 测试宿主（`test.js` 够不着 python）。
    # 判据本身在 `check-cards.py`（⑦ 跨档一致性，2026-10-08 做 Q30 时加）。
    # ⚠️ 全部用**构造的数值**喂进去，不依赖真实卡面 —— 用户随时在重出图，
    #    用真图当样本的测试会跟着烂掉。
    C = load_check()

    def slot(k, area, wh, cx, ok=True, hard=()):
        return (k, {"ok": ok, "area": area, "wh": wh, "cx": cx, "bg_drift": 0,
                    "clipped": False, "reasons": list(hard)})

    KEYS = ("master", "bright", "albino", "golden", "shiny")
    same = [slot(k, 0.20, 3.0, 0.50) for k in KEYS]
    check(C.drift_warnings(same) == {}, "五档本来就一致 ⇒ 0 提示（不误报是最基本的要求）")

    # 一张掉队：占比 0.13 vs 其它 0.20（相对差 35% > 阈值 30%）⇒ **只**标它
    one = [slot(k, 0.13 if k == "golden" else 0.20, 3.0, 0.50) for k in KEYS]
    w = C.drift_warnings(one)
    check(sorted(w.keys()) == ["golden"], "只有掉队的那一档被标出来（实得 %s）" % sorted(w.keys()))
    check(bool(w) and w["golden"][0].startswith(C.DRIFT_TAG),
          "文案带主词 %r（接触表只显示原文，不自己拼）：%r" % (C.DRIFT_TAG, w.get("golden")))
    check("中位" in "".join(w.get("golden") or []), "文案里写清「跟谁比」（同鱼中位）")

    # 阈值真的在比：差一点点（0.24 相对 0.20 = 20% < 30%）不许报，刚过（0.27 = 35%）必须报
    near = [slot(k, 0.24 if k == "shiny" else 0.20, 3.0, 0.50) for k in KEYS]
    check(C.drift_warnings(near) == {}, "差不到阈值 ⇒ 不报（相对差 20%% < %.0f%%）"
          % (C.DRIFT_AREA * 100))
    over = [slot(k, 0.27 if k == "shiny" else 0.20, 3.0, 0.50) for k in KEYS]
    check(sorted(C.drift_warnings(over).keys()) == ["shiny"],
          "过了阈值就报（相对差 35%% > %.0f%%）" % (C.DRIFT_AREA * 100))
    # 反向自检：把阈值抬到天上，同一个输入必须不再报 —— 证明**确实在读这个常量**
    _saved = (C.DRIFT_AREA, C.DRIFT_WH, C.DRIFT_CX)
    try:
        C.DRIFT_AREA, C.DRIFT_WH, C.DRIFT_CX = 9.9, 9.9, 9.9
        check(C.drift_warnings(one) == {} and C.drift_warnings(over) == {},
              "把阈值抬到 9.9 ⇒ 同一个输入不再报（证明判据真的在比阈值）")
    finally:
        C.DRIFT_AREA, C.DRIFT_WH, C.DRIFT_CX = _saved

    check(C.drift_warnings([slot("master", 0.20, 3.0, 0.5)]) == {},
          "只有 1 个可用档 ⇒ 不比（中位就是它自己）")
    check(C.drift_warnings([slot("master", 0.20, 3.0, 0.5),
                            slot("bright", 0.20, 3.0, 0.5, ok=False)]) == {},
          "另一档不可用（空图）⇒ 也不比（挑不出「谁掉队」）")

    # `judge_group`：① 提示只进 soft，最多把 ok 抬成 warn；② **永不**产生 hard
    gj = C.judge_group(one)
    check(all(gj[k]["hard"] == [] for k in gj), "跨档提示**不进** hard（提示级）")
    check(gj["golden"]["verdict"] == "warn" and gj["shiny"]["verdict"] == "ok",
          "掉队那档 ok → warn，其余不受影响（实得 %s / %s）"
          % (gj["golden"]["verdict"], gj["shiny"]["verdict"]))
    check(bool(gj["golden"]["soft"]) and bool(gj["shiny"]["soft"]) is False,
          "提示文案只挂在掉队那档上")
    # 已经 FAIL 的卡不必再叠提示（它已经够忙了），且 verdict 不许被跨档判据改动
    bad = [slot(k, 0.13 if k == "golden" else 0.20, 3.0, 0.50,
                hard=("贴边裁切",) if k == "golden" else ()) for k in KEYS]
    bad[3] = ("golden", dict(bad[3][1], clipped=True))
    gb = C.judge_group(bad)
    check(gb["golden"]["verdict"] == "fail" and gb["golden"]["soft"] == [],
          "已 FAIL 的档：verdict 仍是 fail、也不叠跨档提示（不添乱）")
    check(all(C.DRIFT_TAG not in x for k in gb for x in gb[k]["hard"]),
          "跨档主词不许出现在 hard 里")
    # 与单张判定的口径一致性：没有跨档提示时，judge_group 的结果必须与 judge 逐项相同
    plain = [slot(k, 0.20, 3.0, 0.50) for k in KEYS]
    same_as_judge = all(C.judge_group(plain)[k] == C.judge(plain[i][1])
                        for i, k in enumerate(KEYS))
    check(same_as_judge, "没有跨档提示时，judge_group 与 judge 的结果逐项相同（没偷偷改口径）")

    # ── 样本口径：同档多版只许投一票（Q33，2026-10-08）──────────────────────
    # 为什么单列：传说档的闪光会出 2 版（`<id>-shiny-2.png`），而评审台自 Q32 起
    #   **每一版一个槽位**、接触表把**槽位键**原样喂进来 ⇒ 组里 6 个样本、其中 2 个同档。
    #   两版本来就是「都给我看」的候选，若按样本算中位，中位被**候选数**拽走 ——
    #   症状是**别的档被误标「掉队」**（谁掉队认错人）。⚠️ 4 条多版鱼当前恰好都没触发
    #   ⇒ 属于「不报错的静默口径错」，只能用构造数值钉住（真图会跟着用户重出而变）。
    check(C.morph_key("shiny-2") == "shiny" and C.morph_key("shiny") == "shiny"
          and C.morph_key("master") == "master" and C.morph_key("") == "",
          "morph_key()：槽位键 → 档键（第 N 版折回同一档，别的键原样）")
    check(C.slot_of("x/D16-shiny-2.png")[1] == "shiny" == C.morph_key("shiny-2"),
          "slot_of()（从文件名推）与喂进来的槽位键用**同一条**折版规则")
    # 五个档铺开成一列，**第 3、4 位之间**留有间隔 —— 只有这种分布才看得出「多一个样本
    # 会不会挪中位」（同档多版全挤在两端时两种口径算出来一样，测不出东西）。
    spread = [slot("master", 0.10, 3.0, 0.5),
              slot("bright", 0.20, 3.0, 0.5),
              slot("albino", 0.30, 3.0, 0.5),
              slot("golden", 0.40, 3.0, 0.5),
              slot("shiny", 0.40, 3.0, 0.5)]
    w5 = C.drift_warnings(spread)
    w6 = C.drift_warnings(spread + [slot("shiny-2", 0.40, 3.0, 0.5)])
    m5 = sorted(set(C.morph_key(k) for k in w5))
    m6 = sorted(set(C.morph_key(k) for k in w6))
    check(bool(w6) and m6 == m5,
          "多一版候选**不许改变别的档的判定**（5 档 %s → 6 槽 %s）—— 中位被候选数拽走就会改判"
          % (m5, m6))
    check(sorted(k for k in w6 if C.morph_key(k) == "shiny") == ["shiny", "shiny-2"],
          "归并只影响「投几票」、**不减少覆盖**：第 2 版照样被比、照样被点名（实得 %s）"
          % sorted(k for k in w6 if C.morph_key(k) == "shiny"))
    check(C.drift_warnings([slot("shiny", 0.10, 3.0, 0.5),
                            slot("shiny-2", 0.40, 3.0, 0.5)]) == {},
          "只有 1 个**档**（哪怕有 2 版）⇒ 不比：同一个档的两个候选之间没有「谁掉队」")

    print("\n[11] morph_slots：槽位按磁盘文件枚举（一档出了几版就占几槽）")
    # 为什么这条要有测试：槽位原来是**写死 5 个**（`MORPH_CN`）。2026-10-08 传说档的闪光
    # 开始出第 2 版（`<id>-shiny-2.png`）⇒ 那一版**在评审页上不存在**：图出了、没人看过、
    # 也没法标记重出。同型漏口在 gen-art 的清单勾选与 check-cards 的 MORPH_RE 上
    # 各修过一次，这是第三处（用户自己发现了它）。
    # ⚠️ 全部用**构造的文件名**，不依赖真实卡面 —— 用户随时在重出图，真图当样本会跟着烂。
    LEG = ["D16", "D16-normal", "D16-bright", "D16-albino", "D16-golden",
           "D16-shiny", "D16-shiny-2"]
    s = R.morph_slots("D16", LEG)
    keys = [x["k"] for x in s]
    check(keys == ["master", "bright", "albino", "golden", "shiny", "shiny-2"],
          "传说那条鱼：母版 + 4 档 + 闪光第 2 版 = 6 槽，顺序「先按档、再按版」（实得 %s）" % keys)
    check([x["label"] for x in s][-2:] == [u"闪光", u"闪光·第2版"],
          "第 1 版沿用档名标签、第 N 版加「·第N版」（实得 %r）" % [x["label"] for x in s][-2:])
    check([x["morph"] for x in s][-2:] == ["shiny", "shiny"],
          "多版共用一个 morph —— 重出命令的粒度是**档**（--only-morph shiny）")
    check([x["file"] for x in s][-2:] == ["D16-shiny.png", "D16-shiny-2.png"],
          "每一版指向自己的文件（两槽同图 = 后一版被前一版盖住）")
    check(all(x["morph"] in R.MORPH_KEYS for x in s),
          "morph 全在重出白名单里（否则点了重出会被 clean_groups 拒掉）")
    check(s[0]["file"] == "D16-normal.png",
          "母版那一槽用**抠图**（那才是游戏里真正显示的图）")
    check("normal" not in keys,
          "原色档不单独占槽（它就是母版抠图，列了会逼人判同一个东西两次）")
    # 判据自检：这份样本必须能分出「写死 5 档」的旧口径 —— 否则这条测试是摆设
    check(len(s) == 6 and "shiny-2" in keys,
          "判据自检：样本分得出旧口径（写死 5 档 ⇒ 没有 shiny-2）与新口径（%d 槽）" % len(s))

    # 版本维度：**盘上真有几版**就列几版，不问生成器「打算出几版」
    s3 = R.morph_slots("A01", ["A01", "A01-shiny", "A01-shiny-3"])
    check([x["k"] for x in s3] == ["master", "shiny", "shiny-3"],
          "第 3 版也列出来（生成器以后加第 3 版，页面自动跟上）")
    sg = R.morph_slots("A01", ["A01", "A01-shiny", "A01-shiny-4"])
    check([x["k"] for x in sg] == ["master", "shiny", "shiny-4"],
          "版号有缺口也照列（不当成「下一版没了」就停下）：%s" % [x["k"] for x in sg])
    so = R.morph_slots("A01", ["A01", "A01-shiny-2"])
    check([x["k"] for x in so] == ["master", "shiny-2"],
          "只有第 2 版（第 1 版被手删）也列 —— 不许因为第 1 版缺席就把第 2 版藏起来：%s"
          % [x["k"] for x in so])
    s10 = R.morph_slots("A01", ["A01", "A01-shiny-10", "A01-shiny-2"])
    check([x["k"] for x in s10] == ["master", "shiny-2", "shiny-10"],
          "版号按**数字**排（shiny-2 在 shiny-10 前面）：%s" % [x["k"] for x in s10])
    sn = R.morph_slots("A01", ["A01", "A01-copy", "A01-shiny-x", "A01-shiny"])
    check([x["k"] for x in sn] == ["master", "shiny"],
          "认不出「档名 + 数字后缀」的文件不许混进来：%s" % [x["k"] for x in sn])
    check([x["k"] for x in R.morph_slots("ZZ99", ["ZZ99-bright"])] == ["bright"],
          "（口径说明）纯函数只看文件名；「没母版就不进评审页」由 build_rows 过滤")
    # 真实数据上的结构不变量（与「是哪几张图」无关，任何一批数据都该成立）
    dup = [r["id"] for r in rows if len({x["k"] for x in r["slots"]}) != len(r["slots"])]
    check(not dup, "每条鱼的槽位键互不重复（重复会让两个槽共用一份结论）：%r" % (dup or "无"))
    check(all(r["slots"] and r["slots"][0]["k"] == "master" for r in rows),
          "评审页里每条鱼的第一槽都是母版（没母版的鱼不进这一页）")
    badlab = [x["k"] for r in rows for x in r["slots"]
              if "-" in x["k"] and not re.search(u"·第\\d+版$", x["label"])]
    check(not badlab, "真实数据里每个多版槽位的标签都带「·第N版」（实得 %r）" % (badlab or "无"))
    print("      · 现算：%d 条鱼里 %d 条有多个版本（%s）"
          % (len(rows), len([r for r in rows if any("-" in x["k"] for x in r["slots"])]),
             "、".join(r["id"] for r in rows if any("-" in x["k"] for x in r["slots"])) or "无"))

    print("\n[12] slot_verdicts：判定的单位是**槽位**（每版各自判 / 原色档一对共用一份）")
    # 为什么要有这一节（Q34，2026-10-09）：`main()` 原来按**档**归并 —— 同一档出 2 版时
    #   只有其中一个文件真的被判过，另一个「沿用」它的判定，而报表里印的仍是**自己的数字**
    #   ⇒ 出现「自己的数字 + 别人的判定」。留下的那张 ok、被挤掉的那张若单独判本该 fail，
    #   **报表照样写 ok**：验收工具里的一条**假阴性通道**（真实数据当前 100% 命中「两张结论
    #   相同」，所以真图测不出来 —— 必须用构造数值，见本节末尾的判据自检）。
    # ⚠️ 全部用**构造的 per_path**（假文件名 + 假数值），不读磁盘 —— 用户随时在重出图。
    def rp(ok=True, area=0.20, wh=3.0, cx=0.50, clipped=False):
        return {"ok": ok, "area": area, "wh": wh, "cx": cx, "bg_drift": 0,
                "clipped": clipped, "reasons": []}

    # 一条传说鱼：母版（原图 + 抠图）+ 4 档，其中**闪光出 2 版**、第 1 版贴边裁切（该 FAIL）
    base = {"C24.png": rp(), "C24-normal.png": rp(), "C24-bright.png": rp(),
            "C24-albino.png": rp(), "C24-golden.png": rp(),
            "C24-shiny.png": rp(clipped=True), "C24-shiny-2.png": rp()}
    res, slots = C.slot_verdicts(base)

    check(sorted(slots["C24"]) == ["albino", "bright", "golden", "master", "shiny", "shiny-2"],
          "多版各占一个槽位（母版 + 4 档 + 闪光第 2 版 = 6 槽，实得 %s）" % sorted(slots["C24"]))
    check(slots["C24"]["master"] == "C24-normal.png",
          "母版那一槽的代表是**游戏里真正显示的那张**（抠图）：%r" % slots["C24"]["master"])
    check(res["C24-shiny.png"]["verdict"] == "fail",
          "被新加的那一版**不再沿用别人的判定**：第 1 版贴边该 FAIL（实得 %s）"
          % res["C24-shiny.png"]["verdict"])
    check(res["C24-shiny-2.png"]["verdict"] == "ok",
          "第 2 版仍是它自己的结论（ok），不受第 1 版影响：%s" % res["C24-shiny-2.png"]["verdict"])
    check(res["C24.png"] == res["C24-normal.png"] and res["C24.png"] is res["C24-normal.png"],
          "原色档那一对吧**共用同一份判定**（同一个槽位 —— 一槽一张图，不许判出两种结论）")
    check(len(res) == len(base), "每个文件都有一行自己的判定（%d 文件 → %d 行，「共 N 张」口径不变）"
          % (len(base), len(res)))
    check(res["C24-normal.png"]["verdict"] == "ok",
          "抠图那一版自己判出来仍是 ok（共用不会把「谁的数字」也换掉）")

    # 判据自检：这份样本必须能分出**旧口径**（按档归并 + 其余沿用）—— 否则这条测试是摆设
    def old_style(per_path):
        """复刻 Q34 之前的 `main()` 归组口径（按 `slot_of()` 折，只判代表、其余沿用）。"""
        groups = {}
        for p in sorted(per_path):
            fid, k = C.slot_of(p)
            g = groups.setdefault(fid, {})
            if k not in g or p.endswith("-normal.png"):
                g[k] = p
        out = {}
        for fid, g in groups.items():
            gj = C.judge_group([(k, per_path[pp]) for k, pp in g.items()])
            for k, pp in g.items():
                out[pp] = gj[k]
        for p in per_path:
            if p not in out:
                fid, k = C.slot_of(p)
                out[p] = out[groups[fid][k]]
        return out

    old = old_style(base)
    check(old["C24-shiny.png"]["verdict"] == "ok",
          "判据自检：旧口径真的把那一版藏起来了（第 1 版贴边却报 %s —— 正是要堵的假阴性通道）"
          % old["C24-shiny.png"]["verdict"])
    check(res["C24-shiny.png"]["verdict"] != old["C24-shiny.png"]["verdict"],
          "新口径与旧口径在这份样本上**结论不同**（否则本节的断言证明不了任何事）")

    # 档键（给中位用）与槽位键（给判定用）是同一条折版规则的两种用法
    check(C.slot_of("x/C24-shiny-2.png") == ("C24", C.morph_key("shiny-2")),
          "slot_of() = morph_key(slot_key())（折版规则只有 morph_key() 一处）")
    check(C.slot_key("x/C24-normal.png") == ("C24", "master")
          and C.slot_key("x/C24.png") == ("C24", "master")
          and C.slot_key("x/C24-shiny-2.png") == ("C24", "shiny-2"),
          "slot_key()：原色档那一对折成同一槽、版本后缀原样保留（判定才按槽位）")

    print("\n[13] slot_tally：FAIL 清单 / 跨档提示段都按**槽位**一行（同一个坏槽只印一次）")
    # 为什么要有这一节（Q35，2026-10-09）：这两段原来是**两处各写一遍**的遍历 ——
    #   FAIL 清单在 `for p in order`（按**文件**）里累加、跨档提示段按**槽位**累加。
    #   原色档那一对（`<id>.png` / `<id>-normal.png`）是**同一个槽位、两个文件** ⇒
    #   一个坏槽被印成两行、头条「硬性不合格 N 张」也双计
    #   （实测把母版与抠图都裁到贴边 ⇒ 报「硬性不合格 2 张」+ 两行 ✗，而两行数字逐项相同）。
    # ⚠️ 全部用**构造的 per_path**（假文件名 + 假数值），不读磁盘 —— 用户随时在重出图。
    KEYS5 = ("bright", "albino", "golden", "shiny")

    # ① FAIL：母版那一对**都**贴边 —— 同一个槽位（游戏里真显示的是抠图那张）
    pair_fail = {"A01.png": rp(clipped=True), "A01-normal.png": rp(clipped=True)}
    pair_fail.update({("A01-%s.png" % k): rp() for k in KEYS5})
    res2, slots2 = C.slot_verdicts(pair_fail)
    fails2, drift2 = C.slot_tally(slots2, res2)
    by_file = sum(1 for p in pair_fail if res2[p]["hard"])
    check(by_file == 2, "（对照）按**文件**数确实 2 个带 hard —— 旧口径就是照它计数")
    check(len(fails2) == 1 and fails2[0][0] == "A01-normal",
          "FAIL 清单按**槽位**去重：一个坏槽只一行（取游戏里真显示的那张）：%r" % (fails2,))
    check(len(fails2) != by_file,
          "判据自检：这份样本分得出旧口径（%d 行）与新口径（%d 行）" % (by_file, len(fails2)))
    check(not drift2, "这份样本没有跨档漂移 ⇒ 提示段为空（FAIL 的槽不重复出现在提示段）")

    # ② 跨档提示：掉队的是**母版那一槽**（两个文件）⇒ 提示也只一行
    drift_pair = {"A01.png": rp(area=0.10), "A01-normal.png": rp(area=0.10)}
    drift_pair.update({("A01-%s.png" % k): rp(area=0.30) for k in KEYS5})
    res3, slots3 = C.slot_verdicts(drift_pair)
    fails3, drift3 = C.slot_tally(slots3, res3)
    check(len(drift3) == 1 and drift3[0][0] == "A01-normal"
          and drift3[0][1][0].startswith(C.DRIFT_TAG),
          "掉队的是母版那一槽 ⇒ 提示只一行（不是 <id>.png / <id>-normal.png 各一行）：%r" % (drift3,))
    check(not fails3, "这份样本没什么该 FAIL 的（提示级不许混进 FAIL 清单）")

    # ③ 多版是**两个槽位** ⇒ 各自一行（归并不许减少覆盖）—— 与 ① 的「同槽去重」是两件事
    multi = {"B33.png": rp(), "B33-normal.png": rp(), "B33-bright.png": rp(),
             "B33-albino.png": rp(), "B33-golden.png": rp(),
             "B33-shiny.png": rp(clipped=True), "B33-shiny-2.png": rp(clipped=True)}
    res4, slots4 = C.slot_verdicts(multi)
    fails4, _d4 = C.slot_tally(slots4, res4)
    check(sorted(n for n, _ in fails4) == ["B33-shiny", "B33-shiny-2"],
          "同一档的多版**各占一槽** ⇒ 各自一行（与「同槽去重」互不冲突）：%r" % (fails4,))

    print("\n[13] 条件筛选的数据口径：钓场 / 色相带 / 体型标签都必须同源")
    # 为什么这条要有测试（2026-10-10 用户口径「筛选同一个条件下的所有鱼」）：
    # 评审页给每条鱼补了 `field` / `hue` / `hueBand` 三个筛选维度，而它们的**真相都在别处**：
    #   · `field` —— 游戏里是 `fish.js` 的 `F()` 用 `id.slice(0, id.search(/\d/))` 算的；
    #     评审页是 `field_of()` 用正则算的 ⇒ **两处实现**，漂了不会报错，只会「筛出来的鱼不对」。
    #   · 色相带 —— 分箱边界（30°）在 `HUE_BANDS`，页内 JS 不许再写一遍。
    # 这里就钉这两件事。
    # ⚠️ 钓场那条走**真身**（node 起 `fish.js` 读 `G.FISH[i].field`），不构造样本 ——
    #    构造样本只能证明「我的正则与我自己一致」。
    import json as _json
    import subprocess as _sp
    _node = "node"
    # ⚠️ 必须挂**真全局**（`global.window` / `global.G`）：`fish.js` 里写的是裸 `G.FISH = …`，
    #    它按作用域链找全局，`.call({...})` 传的那个 `this` 它**看不见**
    #    （第一版就是这么写的，node 抛 ReferenceError，而我把它读成了「node 起不来」）。
    _js = ("global.window={};global.G={};"
           "new Function(require('fs').readFileSync('src/data/fish.js','utf8')).call(global);"
           "var o={};global.G.FISH.forEach(function(f){o[f.id]=f.field;});"
           "console.log(JSON.stringify(o));")
    try:
        _r = _sp.run([_node, "-e", _js], capture_output=True, text=True, cwd=ROOT,
                     timeout=60, errors="replace")
        _game = _json.loads((_r.stdout or "").strip().splitlines()[-1])
    except Exception as e:
        _game = None
        print("   ✖ 真身交叉校验跑不起来：%s" % str(e)[:160])
        print("     node stderr：%s" % str((_r.stderr or "").strip()[:200]))
    if _game:
        _mine = {f["id"]: f["field"] for f in R.load_fish()}
        _bad = sorted(k for k in _game if _mine.get(k) != _game[k])
        check(not _bad,
              "`field_of()` 与游戏自己算的 field 逐条一致（%d 条；不一致 %d 条 %s）"
              % (len(_game), len(_bad), _bad[:6]))
    # 色相带：分箱边界只有一处（HUE_BANDS），且首尾必须接得上
    check(len(R.HUE_BANDS) == 12 and R.HUE_BANDS[0][2] == 0
          and [b[3] for b in R.HUE_BANDS] == [b[2] for b in R.HUE_BANDS[1:]] + [360],
          "HUE_BANDS 是 12 档 30°、首尾相接（实得 %d 档）" % len(R.HUE_BANDS))
    check(R.hue_of("#ff0000") == 0 and R.hue_of("#00ff00") == 120
          and R.hue_of("") == -1 and R.hue_of("#zzzzzz") == -1,
          "hue_of：红=0 / 绿=120 / 空与脏值=-1（实得 %s / %s / %s / %s）"
          % (R.hue_of("#ff0000"), R.hue_of("#00ff00"), R.hue_of(""), R.hue_of("#zzzzzz")))
    _fish = R.load_fish()
    check(all(re.match(r"^#[0-9A-Fa-f]{6}$", f.get("body") or "") for f in _fish),
          "每条鱼都解析出了主色 hex（%d 条）—— 色相带就是拿它算的" % len(_fish))
    check(all(R.hue_of(f["body"]) >= 0 for f in _fish),
          "每条鱼的主色都能算出色相（%d 条；算不出的会落进「全部色相」）"
          % sum(1 for f in _fish if R.hue_of(f["body"]) < 0))

    print("\n[14] 闪光两版口径（只传说档）+ 互斥锁判据 + 一键启动器")
    GA = load_genart()
    a_fish = {f["id"]: f for f in GA.load_fish()}
    leg = [f for f in a_fish.values() if f["rar"] == 3]
    oth = [f for f in a_fish.values() if f["rar"] != 3]
    check(all(GA.morph_version_count(3, "shiny") == 2 for _ in [0]),
          "传说档闪光是 2 版（用户口径「只有传说档闪光才需要两档让我选一档」；实得 %d）"
          % GA.morph_version_count(3, "shiny"))
    check(GA.morph_version_count(0, "shiny") == 1,
          "非传说档闪光只有 1 版（实得 %d）—— 全铺开 = 白跑 392 张" % GA.morph_version_count(0, "shiny"))
    check(leg and all([v[3] for v in GA.morph_versions(f, "shiny")] == ["", "-2"] for f in leg),
          "传说档闪光的两个后缀是 ['', '-2']（第 1 版必须落在主文件名上）；%d 条传说鱼" % len(leg))
    check(oth and all([v[3] for v in GA.morph_versions(f, "shiny")] == [""] for f in oth),
          "非传说档只有第 1 版（%d 条）" % len(oth))
    check(all([v[3] for v in GA.morph_versions(f, "bright")] == [""] for f in a_fish.values()),
          "其余档都不出多版（多版是全项目唯一的例外，只给传说闪光）")
    # 版数判据只此一处：出图与清单排期必须给出同一个数
    n_plan = sum(GA.morph_version_count(f["rar"], k) for f in a_fish.values()
                 for k, _d in GA.MORPHS)
    n_jobs = sum(len(GA.card_jobs_of(f)) for f in a_fish.values())
    check(n_jobs - len(a_fish) == n_plan,
          "出图任务数（%d）与「排期口径」一致：每条鱼 1 母版 + 版数之和（实得 %d）"
          % (n_jobs, len(a_fish) + n_plan))

    # 互斥锁：`lock_state()` 是唯一判据；返回 None（没锁）或带 busy/age 的 dict
    check(GA.lock_path().endswith(".gen-art.lock"),
          "`lock_path()` 指向 .gen-art.lock（实得 %s）" % os.path.basename(GA.lock_path()))
    live = GA.lock_state()
    check(live is None or (isinstance(live, dict) and isinstance(live.get("busy"), bool)
                           and isinstance(live.get("age"), int)),
          "`lock_state()` 要么 None（没锁），要么是带 busy(bool)/age(int) 的 dict（实得 %r）" % (live,))
    if live is None:
        print("      · 当前没有锁文件 ⇒ lock_state() = None（free）")
    else:
        print("      · 当前有锁：pid=%s / 心跳停在 %d 秒前 / busy=%s"
              % (live.get("pid"), live.get("age"), live.get("busy")))

    # 启动器：`--who` 是启动器唯一的判断入口，`.cmd` 只是薄壳
    r = subprocess.run([sys.executable, "-u", os.path.join(TOOLS, "gen-art.py"), "--who"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    last = [x for x in (r.stdout or "").split("\n") if x.strip()][-1:]
    check(r.returncode in (0, 3) and last and (last[0].startswith("free") or last[0].startswith("busy")),
          "--who 输出 free / busy 且退出码是 0 / 3（实得 rc=%d，末行 %r）"
          % (r.returncode, (last or [""])[0][:60]))
    for name in ("gen-art-loop.cmd", "pick-shiny.cmd", "review-desk.cmd"):
        p = os.path.join(TOOLS, name)
        check(os.path.exists(p), "启动器在：%s" % name)
        if os.path.exists(p):
            body = io.open(p, encoding="utf-8", errors="replace").read()
            check(all(ord(c) < 128 for c in body),
                  "%s 是纯 ASCII（cmd.exe 用系统码页读脚本，中文会被撕碎）" % name)
    loop = os.path.join(TOOLS, "gen-art-loop.cmd")
    if os.path.exists(loop):
        code = "\n".join(l for l in io.open(loop, encoding="utf-8").read().split("\n")
                          if not l.strip().lower().startswith("rem"))
        check("rerender.py" in code, "gen-art-loop.cmd 的**可执行行**里调的是 rerender.py")
    rr = os.path.join(TOOLS, "rerender.py")
    check(os.path.exists(rr), "编排层在：tools/rerender.py")
    if os.path.exists(rr):
        src = io.open(rr, encoding="utf-8").read()
        check("--who" in src, "rerender.py 的 preflight 走 --who 问主流程（不自备锁判据）")
        check(".gen-art.lock" not in "\n".join(
            l for l in src.split("\n") if ("say(" not in l and "print(" not in l)),
            "rerender.py 的**代码行**里不碰锁路径（提示句里提一下是允许的）")

    print("\n[15] 形态档案：大小档（maxKg）两条路都要写（Q13）")
    GA = load_genart()
    _f = GA.load_fish()
    _ver = [f for f in _f if GA.trait_of(f["id"], "form")]
    # ① 行为判据（真判据）：362 条（全都有查证过的 form）的形态档案里都必须能读出自己的大小档
    _miss = [f["id"] for f in _f if GA.size_band(f) not in GA.form_profile(f)]
    check(_f and _ver and not _miss,
          "每条鱼的形态档案都含自己的大小档（有 form 的 %d 条；缺 %d 条%s）"
          % (len(_ver), len(_miss), ("：%s" % ", ".join(_miss[:6])) if _miss else ""))
    check([f for f in _f if not GA.form_profile(f).startswith(GA.size_band(f))] == [],
          "大小档排在形态档案**最前**（原来的推导路径也是这个次序 —— 别塞到尾巴上）")
    # ② 名词要跟着体型族走：非鱼不许写 fish
    _nonfish = [f for f in _f if f.get("shape", "fish") not in GA.FISH_SHAPES]
    _fishy = [f for f in _f if f.get("shape", "fish") in GA.FISH_SHAPES]
    check(_nonfish and _fishy, "体型集合两侧都非空（非鱼 %d 条 / 鱼形 %d 条）"
          % (len(_nonfish), len(_fishy)))
    check(all("fish" not in GA.size_band(f) for f in _nonfish),
          "非鱼体型（螺 / 蟹 / 水母…）的大小档不写 fish（写 creature）—— 写 fish 是类别错误")
    check(all(GA.size_band(f).endswith("fish") for f in _fishy), "鱼形家族的大小档以 fish 结尾")
    # ③ 五档边界 + 超界兜底（空集 ⇒ 恒真，所以两处都先证明非空）
    _bands = [GA.size_band({"maxKg": kg, "shape": "fish"}) for kg in (0.3, 1.0, 5.0, 50.0, 1e6)]
    check(len(set(_bands)) == 5, "5 个档位各命中一句（实得 %r）" % (_bands,))
    _over = [f for f in _f if (f.get("maxKg") or 0) >= GA.SIZE_BANDS[-1][0]]
    check(_over and all(GA.size_band(f).startswith("a huge massive ") for f in _over),
          "maxKg 超出最后一档的 %d 条走兜底（不兜底 = 不报错、只是静默少一句）" % len(_over))
    # ④ 唯一实现：form_profile 体内不许再摸 SIZE_BANDS（判据剥注释与 docstring —— 散文里提到不算）
    _src = wash.read_washed(os.path.join(TOOLS, "gen-art.py"))
    _body = _src.split("def form_profile(f):")[1].split("\ndef ")[0]
    # 洗注释走共用实现（Q95）：`wash.read_washed()` 已剥 docstring + 整行/行尾 `#`，
    # 所以这里不再自己 re.sub 一遍（原先那份是**不看引号**的裸正则，口径与顶层分家）。
    _code = _body
    check(len(_code) > 200 and "size_band(f)" in _code,
          "form_profile 体内确实调了 size_band(f)（取不到函数体就报这里的红）")
    check("SIZE_BANDS" not in _code,
          "form_profile 体内不再出现 SIZE_BANDS —— 大小档只有 size_band() 一处实现")

    print("\n[16] 卡面后处理：补边几何 / 母版拦截 / 两档规格 / 锐化只打 RGB / 确定性（Q8）")
    P = load_prep()
    # ① 补边几何（纯函数，**绝不裁切 / 绝不拉伸**）
    check(P.pad_canvas(1152, 768) == (1536, 768, 192, 0),
          "1152×768（3:2）→ 左右各补 192，中置（实得 %r）" % (P.pad_canvas(1152, 768),))
    check(P.pad_canvas(1024, 512) == (1024, 512, 0, 0),
          "已经是 2:1 ⇒ **零补边**（幂等：再跑一次不该再长一层）")
    _w, _h, _ox, _oy = P.pad_canvas(500, 500)
    check((_w, _h) == (1000, 500) and _ox == 250 and _oy == 0, "1:1 太窄 ⇒ 左右补到 2:1")
    _w, _h, _ox, _oy = P.pad_canvas(1200, 300)
    check((_w, _h) == (1200, 600) and _ox == 0 and _oy == 150, "4:1 太宽 ⇒ 上下补到 2:1")
    _cases = [(1152, 768), (1024, 512), (500, 500), (1200, 300), (37, 401)]
    check(all(P.pad_canvas(a, b)[0] >= a and P.pad_canvas(a, b)[1] >= b for a, b in _cases),
          "五种尺寸都不裁切（画布绝不小于源图）")
    check(all(abs(P.pad_canvas(a, b)[0] / float(P.pad_canvas(a, b)[1]) - P.SPEC["padAspect"]) < 0.01
              for a, b in _cases), "补出来的画布宽高比都落到 padAspect（±1% 取整误差内）")
    # ② 源守卫：母版（无 `-`）必须被拦掉 —— 它是灰底不透明图（实测四角 alpha = 255）
    check(P.is_cutout("A01-normal") and P.is_cutout("A01-shiny-2") and P.is_cutout("SS07-bright"),
          "透明抠图（带 -档[-N]）被判为可派生")
    check(not P.is_cutout("A01") and not P.is_cutout("SS07"),
          "母版 `<id>` 被拦掉（垫透明边会在两侧留两条灰棒）")
    _sl = P.plan_slots(["A01"])
    check(_sl and all("-" in s["name"] for s in _sl),
          "真数据：plan_slots 排出来的 %d 张**全**是抠图（含 -normal）" % len(_sl))
    # ③ 行为：造一张已知图，真渲染一遍到 _tmp（不碰 assets/cards/）
    TMPDIR = os.path.join(TMP, "q8")
    if not os.path.isdir(TMPDIR):
        os.makedirs(TMPDIR)
    _im = Image.new("RGBA", (1152, 768), (0, 0, 0, 0))
    ImageDraw.Draw(_im).rectangle([300, 250, 900, 520], fill=(100, 100, 100, 255))
    _src = os.path.join(TMPDIR, "syn-normal.png")
    _im.save(_src)
    _slot = {"id": "SYN", "slot": "normal", "morph": "normal", "name": "syn-normal", "src": _src}
    _det, _lst, _pad = P.render(_slot)
    check(_det.size == tuple(P.SPEC["detail"]) and _lst.size == tuple(P.SPEC["list"]),
          "两档尺寸 = 规格现算值（实得 %r / %r）" % (_det.size, _lst.size))
    check(_pad["padSize"] == [1536, 768] and _pad["padOffset"] == [192, 0],
          "补边信息随图返回（写进 index.json 的就是它，不在别处再算一遍）")
    check(_det.getpixel((0, 0))[3] == 0 and _lst.getpixel((0, 0))[3] == 0,
          "补出来的是**透明**边（贴在任何底色上都不留痕）")
    _al = _det.getchannel("A").getbbox()
    # 期望值现算：源 (300,250)-(900,520) → 补边 +192 → 缩放 1024/1536 = 2/3
    _exp = (int(492 * 2 / 3.0), int(250 * 2 / 3.0), int(1092 * 2 / 3.0), int(520 * 2 / 3.0))
    check(all(abs(_al[i] - _exp[i]) <= 5 for i in range(4)),
          "主体包围盒落在预期位置（现算 %r / 实得 %r；±5px 容 LANCZOS 振铃）" % (_exp, _al))
    # ④ 度量入口唯一：index.json 的那些数只能从 stats_of() 出来
    _dp = os.path.join(TMPDIR, "syn-normal-detail.png")
    _det.save(_dp)
    _st = P.stats_of(_dp)
    check(_st and set(("area", "wh", "cx", "cy", "bbox", "long")) <= set(_st),
          "stats_of() 给全了 index.json 要的六个度量（缺一个 = Q9 那边会读不到）")
    check(_st and _st["long"] == max(_st["bbox"][2] - _st["bbox"][0], _st["bbox"][3] - _st["bbox"][1]),
          "long 就是包围盒的长边（不是另算一个数）")
    check(_st and 0.0 <= _st["cx"] <= 1.0 and 0.0 <= _st["cy"] <= 1.0,
          "重心是归一化到 0~1 的（不要像素坐标 —— 换档位尺寸就失效）")
    # ④ 锐化只打 RGB：**alpha 必须与未锐化的那一份逐字节相同**
    _nw, _nh, _ox, _oy = P.pad_canvas(1152, 768)
    _canvas = Image.new("RGBA", (_nw, _nh), (0, 0, 0, 0))
    _canvas.paste(_im, (_ox, _oy))
    _small = _canvas.resize(P.SPEC["list"], Image.LANCZOS)
    check(_lst.getchannel("A").tobytes() == _small.getchannel("A").tobytes(),
          "列表档的 alpha 用**未锐化**的那一份（锐化 alpha 会在边缘振出半透明光晕）")

    def _hf(img):
        """高频能量：与左 / 上邻居的绝对差之和 ÷ 采样数。锐化会把它顶上去。"""
        px = img.convert("L").load()
        w, h = img.size
        s = 0
        for y in range(1, h, 2):
            for x in range(1, w, 2):
                s += abs(px[x, y] - px[x - 1, y]) + abs(px[x, y] - px[x, y - 1])
        return s / float((w // 2) * (h // 2))

    _plain, _sharp = _hf(_small), _hf(_lst)
    check(_sharp > _plain * 1.05,
          "列表档确实锐化了（高频能量 %.2f > 未锐化 %.2f）" % (_sharp, _plain))
    # ⑤ 确定性（同进程两次；跨进程的逐字节对拍是收尾那次真跑）
    _det2, _lst2, _ = P.render(_slot)
    check(hashlib.md5(_det.tobytes()).hexdigest() == hashlib.md5(_det2.tobytes()).hexdigest()
          and hashlib.md5(_lst.tobytes()).hexdigest() == hashlib.md5(_lst2.tobytes()).hexdigest(),
          "同一输入渲染两次逐字节相同（无随机 / 无时间戳）")
    # ⑥ 索引按**现状**枚举：喂一个「盘上有、本次没写」的名字，必须沿用上一份而不是丢掉
    check(callable(getattr(P, "on_disk", None)) and callable(getattr(P, "load_index", None)),
          "索引有两个入口：on_disk()（按现状枚举）/ load_index()（沿用上一份）")

    print("\n[17] 提示词里的物种名（Q17 收口）：口径 / 真数据 / 五档同源 / A-B 开关 / 深层骨架留痕")
    GA2 = load_genart()
    _fish = GA2.load_fish()
    _tags = [GA2.species_tag(x) for x in _fish]
    # ① 口径：正式默认 cn_latin，且 `NAME_MODE =` 只有一处（A/B 三挡只是开关）
    check(GA2.NAME_MODE == "cn_latin",
          "正式默认是 cn_latin（A/B 对拍定稿后的口径）—— 实得 %r" % (GA2.NAME_MODE,))
    # ⚠️ 洗注释走共用实现 `wash.strip_py()`（Q95）：整行 + 行尾 `#` 都剥、且**引号里的 `#` 不动**。
    #    原先这里是 `re.sub(r"(?m)^\s*#.*$", "", …)` —— 只剥整行，行尾注释会留下喂饱这条计数判据
    #    （第 55 轮 Q83 在 JS 侧修过同一个坑，这里是 py 侧那一半）。
    _gacode = wash.read_washed(os.path.join(TOOLS, "gen-art.py"))
    check(len(re.findall(r"^NAME_MODE = ", _gacode, re.M)) == 1,
          "`NAME_MODE =` 只有一处定义（另起一份 = 两个默认值）")
    # ② 真数据：362 条全都带得出名字；有 species 的条必须带拉丁名，没有的不许自己补括号
    check(_fish and all(t.strip() for t in _tags),
          "每条鱼都带得出物种名（%d 条；空名会让主语退回类目词）" % len(_fish))
    _lat = [x for x in _fish if (GA2.trait_of(x["id"], "species") or "").strip()]
    _nolat = [x for x in _fish if not (GA2.trait_of(x["id"], "species") or "").strip()]
    check(_lat and _nolat and all("(" in GA2.species_tag(x) and ")" in GA2.species_tag(x)
                                  for x in _lat),
          "有拉丁名的 %d 条都写成「中文名 (Latin)」" % len(_lat))
    check(all("(" not in GA2.species_tag(x) for x in _nolat),
          "没有拉丁名的 %d 条**不许**自己补一个空括号" % len(_nolat))
    # ③ 前五场（走 build_prompt）：名字必须当**主语名词**（"a <名字>, "），且 `·` 前缀不许进提示词
    _前 = [x for x in _fish if x.get("field") not in GA2.DEEP_FIELDS]
    _miss = [x["id"] for x in _前 if ("a " + GA2.species_tag(x) + ", ") not in GA2.build_prompt(x)]
    check(_前 and not _miss,
          "常规五场的 %d 条都把名字放在主语位（缺 %d 条%s）"
          % (len(_前), len(_miss), ("：" + ", ".join(_miss[:6])) if _miss else ""))
    _dot = [x for x in _前 if "·" in (x.get("name") or "")]
    check(_dot and all(x["name"].split("·")[0] not in GA2.build_prompt(x) for x in _dot),
          "常规场里 %d 条带 `·` 的**游戏造名前缀**没被写进提示词（写进去会被当成画面内容）" % len(_dot))
    # ④ 五档同源：`build_morph_prompt` 只是换颜色半句，物种名必须还在
    _d = _前[0]
    _mp = GA2.build_morph_prompt(_d, "shiny", "bright specular highlights")
    check(GA2.species_tag(_d) in _mp,
          "五档提示词里名字还在（母版与五档不许分家）")
    # ⑤ A/B 开关仍然可用：off 挡一律不加名字（跑完还原，别把模块状态留在 off）
    #    ⚠️ 判据不能写 `species_tag(...) not in prompt` —— off 挡下 tag 是**空串**，
    #       而 `"" in 任何字符串` 恒真 ⇒ 那种写法会**永远红**（第一版就是这么栽的）。
    _keep = GA2.NAME_MODE
    try:
        GA2.NAME_MODE = "off"
        check(GA2.species_tag(_d) == "" and _d["name"].split("·")[-1] not in GA2.build_prompt(_d),
              "NAME_MODE = off 时一律不加名字（A/B 三挡还能用）")
    finally:
        GA2.NAME_MODE = _keep
    # ⑥ 深层骨架（SS / SSS 180 条）走另一条路：`named <名字>` —— 名字确实在，但形态不同
    _deep = [x for x in _fish if x.get("field") in GA2.DEEP_FIELDS]
    _dmiss = [x["id"] for x in _deep if ("named " + x["name"]) not in GA2.build_deep_prompt(x)]
    check(_deep and not _dmiss,
          "SS / SSS 的 %d 条走深层骨架、名字写在 `named <名字>` 里（缺 %d 条）"
          % (len(_deep), len(_dmiss)))
    # ⚠️ **现状留痕，不是口径认可**：深层场里带 `·` 的那些**用的是全名（含前缀）** ——
    #    与 `species_tag()` 的「剥离前缀」口径不一致。这 17 条要不要一起剥是**观感取舍**，
    #    已登记 ⛔（队列 Q17 / 待办「自动化发现」），别拿本判据当「已经对了」。
    _ddot = [x for x in _deep if "·" in (x.get("name") or "")]
    check(_ddot and all(x["name"] in GA2.build_deep_prompt(x) for x in _ddot),
          "留痕：深层场 %d 条带 `·` 的**用全名**（含前缀）—— 与常规场的剥离口径不一致，见 ⛔ 待办"
          % len(_ddot))

    print("\n[18] 名字族表（Q15 核实收口）：无死键 / 表序即优先级 / 函数可用 / 现状留痕")
    _nm = [(x.get("name") or "") for x in _fish]
    _hint_d = dict(GA2.NAME_HINTS)
    _deadk = [k for k, _d in GA2.NAME_HINTS if not any(k in n for n in _nm)]
    check(GA2.NAME_HINTS and not _deadk,
          "NAME_HINTS 的 %d 个键每个都在真名字里命中过（零命中的死键：%s）"
          % (len(GA2.NAME_HINTS), "、".join(_deadk) if _deadk else "无"))
    # 表序即优先级（表里的注释明写「长串必须排在短串前」）：首个命中的键必须就是**最长**的那个
    _shadow = []
    for x in _fish:
        _n = x.get("name") or ""
        _first = next((k for k, _d in GA2.NAME_HINTS if k in _n), None)
        _longest = None
        for k, _d in GA2.NAME_HINTS:
            if k in _n and (_longest is None or len(k) > len(_longest)):
                _longest = k
        if _first and _longest and _first != _longest:
            _shadow.append((x["id"], _first, _longest))
    check(not _shadow, "长串都排在短串前面（被截胡的 %d 处%s）"
          % (len(_shadow), ("：" + repr(_shadow[:4])) if _shadow else ""))
    # 函数可用：喂一个含该键的名字，必须原样拿到表里那句（不抛、不串行）
    # ⚠️ 必须带 `shape`：`name_hint()` 的门是 `f.get("shape") not in FISH_SHAPES`
    #    —— 缺这个键时是 `None not in …` ⇒ 直接返回空串，探针会以为「表坏了」。
    _probe_bad = [k for k, _d in GA2.NAME_HINTS
                  if GA2.name_hint({"name": "测试" + k, "shape": "fish"}) != _d]
    check(not _probe_bad, "每个键单独喂进去都拿得到它自己那句描述（对不上的：%r）" % (_probe_bad[:4],))
    # ⚠️ **现状留痕（Q15 的旧口径已作废）**：`build_prompt` 的 ② 是
    #    `"" if verified else name_hint(f)` —— 而 **362 条全都有查证过的 `form`**
    #    ⇒ 名字族在**母版提示词**上当前一条都不会生效。所以「按 88 条泛称补齐名字族」
    #    这件事的收益是 **0**（改了也看不出来）；将来加新鱼若没有 `form` 才会用上。
    _hits = [x for x in _fish if GA2.name_hint(x)]
    _ver = [x for x in _fish if (GA2.trait_of(x["id"], "form") or "").strip()]
    check(len(_hits) > 0,
          "名字族仍命中 %d 条名字（现算）；⚠️ 有查证 form 的 %d 条使这条路在母版提示词上"
          "**生效 0 条** —— traits 补齐后的正常现状、不是 bug（「扩表」收益 = 0）"
          % (len(_hits), len(_ver)))

    print("\n[19] 边缘去污染（Q11）：只改 RGB 不动 alpha / 沿边缘取主体色 / 轮数由规格现算")
    # 先造一张「深底亮主体 + 被背景色污染的羽化边」的合成图 —— 与真实母版同一个成因：
    # 边缘像素 = 主体色 × 覆盖度 + 背景色 × (1 − 覆盖度)，alpha 就是覆盖度。
    _BG, _FG = (30, 30, 30), (200, 180, 60)
    _FW, _FH = 200, 120
    _syn = Image.new("RGBA", (_FW, _FH), (_BG[0], _BG[1], _BG[2], 0))
    _px = _syn.load()
    _L, _T, _R, _B = 60, 40, 140, 80
    _FEATHER = 6.0

    def _cover(v, a, b):
        if v < a - _FEATHER or v > b + _FEATHER:
            return 0.0
        if v < a:
            return (v - (a - _FEATHER)) / _FEATHER
        if v > b:
            return ((b + _FEATHER) - v) / _FEATHER
        return 1.0

    for _y in range(_FH):
        for _x in range(_FW):
            _c = _cover(_x, _L, _R) * _cover(_y, _T, _B)
            _px[_x, _y] = tuple(int(round(_BG[i] + (_FG[i] - _BG[i]) * _c)) for i in range(3)) \
                + (int(round(255 * _c)),)
    _fixed = P.bleed(_syn)

    def _edge_delta(img):
        _al = img.getchannel("A")
        _e = _al.point(lambda v: 255 if P.SPEC["alphaMin"] < v < P.SPEC["defringe"]["alphaHi"] else 0)
        _o = _al.point(lambda v: 255 if v >= P.SPEC["defringe"]["alphaHi"] else 0)
        _i = ImageChops.subtract(_o, _o.filter(ImageFilter.MinFilter(5)))
        _rgb = img.convert("RGB")
        _el = ImageStat.Stat(_rgb, _e).mean
        _il = ImageStat.Stat(_rgb, _i).mean
        _lum = lambda c: 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        return _lum(_el) - _lum(_il)

    _d0, _d1 = _edge_delta(_syn), _edge_delta(_fixed)
    check(_d0 < -40, "合成图**修前**确实被污染（Δ = %+.1f，负数 = 边缘比主体暗）" % _d0)
    check(abs(_d1) <= 3, "修后边缘带的颜色回到主体色（Δ = %+.1f，应在 ±3 内）" % _d1)
    check(_fixed.getchannel("A").tobytes() == _syn.getchannel("A").tobytes(),
          "**alpha 通道逐字节不变** —— 去污染只许改颜色（动 alpha = 抠图轮廓被改，没人看得见）")
    check(_fixed.getpixel((0, 0))[3] == 0 and _fixed.getpixel((0, 0))[:3] == _BG,
          "抠图外的全透明像素不动（RGB 留在背景色上、alpha 仍是 0）")
    # 轮数**真被消费**：给 0 轮 = 什么都不做（差值原样）；给不足的轮数 = 只抹掉最外一层
    check(abs(_edge_delta(P.bleed(_syn, rounds=0)) - _d0) < 0.5, "rounds=0 时一个像素都不改")
    _d2 = _edge_delta(P.bleed(_syn, rounds=1))
    check(_d2 < _d1 - 10, "rounds=1 只抹掉最外一层（Δ = %+.1f，远达不到 %+.1f）—— 轮数是真参数"
          % (_d2, _d1))
    check(P.bleed(_syn).tobytes() == _fixed.tobytes(), "同一张图两次去污染逐字节相同（确定性）")
    # 真数据上也成立（有卡面就跑，没有不算失败 —— 与 [16] 的「真数据」那几条同款）
    _real = os.path.join(ROOT, "assets", "cards", "A01-normal.png")
    if os.path.isfile(_real):
        _rim = Image.open(_real).convert("RGBA")
        _rf = P.bleed(_rim)
        check(_edge_delta(_rf) > _edge_delta(_rim) + 20,
              "真卡面 A01-normal：Δ %+.1f → %+.1f（外扩确实把背景色挤出边缘）"
              % (_edge_delta(_rim), _edge_delta(_rf)))
        check(_rf.getchannel("A").tobytes() == _rim.getchannel("A").tobytes(),
              "真卡面：alpha 也逐字节不变")
    # 实现唯一 + 规格消费（静态，剥注释走共用实现；与 verify §53 ⑦ 同源但这里是 python 侧的自检）
    _pcode = wash.read_washed(os.path.join(TOOLS, "prep-cards.py"))
    check(len(re.findall(r"def bleed\(", _pcode)) == 1
          and len(re.findall(r"bleed\(", _pcode)) == 2,
          "bleed() 只有一处实现 + 一处调用（实得 %d / %d）"
          % (len(re.findall(r"def bleed\(", _pcode)), len(re.findall(r"bleed\(", _pcode))))
    _bl = _pcode.split("def bleed(")[1].split("\ndef ")[0]
    check('SPEC["defringe"]["rounds"]' in _bl and "SPEC[\"alphaMin\"]" in _bl,
          "轮数 / 羽化下界都从 SPEC 现算（`alphaMin` 以前是个零消费的规格键，这里才第一次读它）")

    print("\n[20] 一键启动器的参数面：`.cmd` 广告的用法必须真能跑")
    # 病根（2026-10-11 实测出来的真 bug）：`tools/gen-art-loop.cmd` 的文件头 +
    #   `docs/开发者文档.md` + `docs/改进待办.md` 都写着 `gen-art-loop.cmd check`
    #   （先看一眼要出多少张）与 `gen-art-loop.cmd 30`（每 30 分钟收工），
    #   而 `rerender.py` 的 argparse 只认 `--check` / `-m N` ⇒ 那两个**位置形态
    #   直接退出码 2**（`unrecognized arguments: check`）。最常用的「先看量」
    #   照着文档敲就是报错 —— 而且报的是 usage，看起来像脚本坏了。
    # 为什么放在这里、而不是 verify 里：这是**行为**判据（真 import、真调 main()）。
    #   `verify`（第 51 节 ⑦）只能看源码结构，而结构对了行为照样能错 ——
    #   第一版就是：`normalize_argv()` 在、`main()` 也调了它，但**没跳过「选项的值」**，
    #   于是 `-m 30` 变成 `['-m','--budget-min','30']` ⇒ argparse 报
    #   `expected one argument`。那种 bug 只有真调一次才看得见。
    rr_test = os.path.join(TOOLS, "rerender.py")
    if os.path.exists(rr_test):
        _spec = importlib.util.spec_from_file_location("rerender_args", rr_test)
        _RR = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_RR)          # __name__ != "__main__" ⇒ main() 不会自己跑
        _trace = {}

        def _fake_render(budget):
            _trace["budget"] = budget
            return 0

        _RR.preflight = lambda: True           # 不连 ComfyUI
        _RR.summary = lambda: 0                # 不调 gen-art.py
        _RR.render = _fake_render              # **绝不出图**

        def _run(*argv):
            _trace.clear()
            _old = sys.argv
            sys.argv = ["rerender.py"] + list(argv)
            try:
                # ⚠️ `SystemExit` 必须接住（argparse 参数写错时它抛 `SystemExit(2)`）：
                #    不接的话，一条“参数面坏了”的注入会把整个测试宿主带崩、退 2 且
                #    **一句报告都没有**（硬规矩 15 同族：源文件写崩 ⇒ 退出码 1 却看不到
                #    「自检未通过」那一行，与「注入没生效」长得一模一样）。
                #    接住之后，失败态就只是一条红灯，报告照常打。
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    _rc = _RR.main()
            except SystemExit as _e:
                _rc = _e.code if isinstance(_e.code, int) else 2
            finally:
                sys.argv = _old
            return _rc, dict(_trace)

        _rc, _t = _run("--check")
        check(_rc == 0 and "budget" not in _t,
              "--check：退出 0 且**没进 render**（只自检 + 报数）")
        _rc, _t = _run("check")
        check(_rc == 0 and "budget" not in _t,
              "`check`（位置形态，`.cmd` 文件头广告的就是它）：退出 0 且没进 render"
              "（实得 rc=%d）—— 修前是 argparse 报 unrecognized arguments / 退出码 2" % _rc)
        _rc, _t = _run("-m", "30")
        check(_rc == 0 and _t.get("budget") == 30,
              "-m 30：退出 0 且 render 收到 30（实得 rc=%d / budget=%r）" % (_rc, _t.get("budget")))
        _rc, _t = _run("30")
        check(_rc == 0 and _t.get("budget") == 30,
              "`30`（位置形态）：退出 0 且 render 收到 30（实得 rc=%d / budget=%r）"
              "—— 修前退出码 2" % (_rc, _t.get("budget")))
        _rc, _t = _run()
        check(_rc == 0 and _t.get("budget") == 0, "无参数：退出 0 且 render 收到 0（不限时长）")
        # 🔴 回归：归一**必须跳过「选项的值」**（上面那个真 bug 的正面判据）
        check(_RR.normalize_argv(["-m", "30"]) == ["-m", "30"],
              "归一跳过选项的值：`-m 30` 原样不动（第一版把 30 二次归一 ⇒ "
              "`['-m','--budget-min','30']` ⇒ `expected one argument`）")
        check(_RR.normalize_argv(["check"]) == ["--check"]
              and _RR.normalize_argv(["30"]) == ["--budget-min", "30"]
              and _RR.normalize_argv(["--budget-min", "30"]) == ["--budget-min", "30"],
              "两种位置形态各归到正确的选项上，选项形态原样通过")
        # 洗注释走共用实现（Q95）：这一份原先是**不看引号**的裸正则 `#[^\n]*` ——
        # 会把 `'#a87a1f'` 这类字符串从中间撕开（JS 侧第 57 轮 Q88 修过同一个坑）。
        _rr_code = wash.read_washed(rr_test)
        check(len(re.findall(r"def normalize_argv\(", _rr_code)) == 1,
              "`normalize_argv()` 只有一处实现（实得 %d 处）—— 两份必然分家"
              % len(re.findall(r"def normalize_argv\(", _rr_code)))

    print("\n[21] pick-card：干跑形态真能跑、且真不落盘（本轮修的第二个 bug）")
    # 病根（2026-10-11 实测）：`tools/pick-shiny.cmd` 把 `%2` 当**版号**原样转给
    #   `pick-card.py`（`… %ID% shiny %VER%`），而它的文件头与 `docs/开发者文档.md`
    #   都把干跑写成 `pick-shiny.cmd A44 dry` ⇒ 实际到达 `pick-card.py A44 shiny dry`
    #   ⇒ argparse 报 `invalid int value: 'dry'`（退出码 2）；另一种写法
    #   `pick-shiny.cmd A44 --dry` 能过 argparse，但版号缺了 ⇒ 报用法错。
    #   ⇒ **两种广告写法都跑不通**（和 [20] 那个 `check` / `30` 同族）。
    # 🔴 这一段会在**临时沙盒**里做一次**真的对换**（合成台账 + 两个假文件）：
    #     绝不碰 `assets/cards/`。这正是「工具跑成功 ≠ 产物能用」那条教训的正解 ——
    #     判据要真跑一次那条路径（对换是**不可逆**的动作，只有真跑一次才看得见它写没写）。
    pc_path = os.path.join(TOOLS, "pick-card.py")
    if os.path.exists(pc_path):
        _specp = importlib.util.spec_from_file_location("pick_card_args", pc_path)
        PC = importlib.util.module_from_spec(_specp)
        _specp.loader.exec_module(PC)
        _sand = os.path.join(TMP, "pickcard-sandbox")
        if os.path.isdir(_sand):
            shutil.rmtree(_sand)
        os.makedirs(os.path.join(_sand, "cards"))
        PC.OUT = os.path.join(_sand, "cards")
        PC.MANIFEST = os.path.join(PC.OUT, "manifest.json")
        PC.TMP = os.path.join(PC.OUT, "_tmp")
        _man = {"A44": {"name": "沙盒测试鱼",
                        "morphs": {"shiny": {"label": "甲", "candidate": "shiny/1"},
                                   "shiny-2": {"label": "乙", "candidate": "shiny/7"}},
                        "morphVariant": {}}}
        with io.open(PC.MANIFEST, "w", encoding="utf-8") as _f:
            _f.write(json.dumps(_man, ensure_ascii=False, sort_keys=True))
        _pa = os.path.join(PC.OUT, "A44-shiny.png")
        _pb = os.path.join(PC.OUT, "A44-shiny-2.png")
        with open(_pa, "wb") as _f:
            _f.write(b"AAA")
        with open(_pb, "wb") as _f:
            _f.write(b"BB")

        def _snap():
            """两张**图**的 md5（对换的直接证据）。

            ⚠️ 台账**不能**一起取字节 md5：`save_manifest()` 会把 JSON 按自己的
               `indent=1 / sort_keys=True` 重写 ⇒ 换回来之后字节也跟合成样本不同，
               判据会假红（第一版就是这么栽的）。台账按**语义**比（json 相等）。
            """
            _o = {}
            for _p in (_pa, _pb):
                with open(_p, "rb") as _fp:
                    _o[os.path.basename(_p)] = hashlib.md5(_fp.read()).hexdigest()
            return _o

        def _man_now():
            return json.load(io.open(PC.MANIFEST, encoding="utf-8"))["A44"]["morphs"]

        def _runpick(*argv):
            _old = sys.argv
            sys.argv = ["pick-card.py"] + list(argv)
            _buf = io.StringIO()
            try:
                # `die()` 抛的是 `SystemExit("❌ …")`（字符串码）⇒ 接住并把文案当报告，
                # 不让「参数面坏了」把整个测试宿主带崩（同 [20]）
                # ⚠️ stderr 也要收：`argparse` 的 usage / error（用法错，退出码 2）走 stderr，
                # 不收的话「报用法错」这条断言会因为拿不到文案而假红（2026-10-12 第 55 轮）。
                _errb = io.StringIO()
                with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(_errb):
                    PC.main()
                _rc = 0
            except SystemExit as _e:
                _rc = _e.code if isinstance(_e.code, int) else 1
                if isinstance(_e.code, str):
                    _buf.write(_e.code)
            finally:
                sys.argv = _old
            _buf.write(_errb.getvalue())
            return _rc, _buf.getvalue()

        check(PC.normalize_dry(["A44", "shiny", "dry"]) == ["A44", "shiny", "--dry"]
              and PC.normalize_dry(["--dry"]) == ["--dry"],
              "裸词 `dry` 归一到 `--dry`（唯一一处；选项形态原样通过）")
        _s0 = _snap()
        _m0 = _man_now()
        for _arg, _what in ((("A44", "shiny", "dry"), "`dry`（裸词，.cmd 文件头广告的写法）"),
                            (("A44", "shiny", "--dry"), "`--dry`（省版号）"),
                            (("A44", "shiny", "2", "--dry"), "`2 --dry`（带版号）")):
            _rc, _t = _runpick(*_arg)
            check(_rc == 0 and "对换" in _t,
                  "%s：退出 0 且真打出了「会发生什么」（实得 rc=%d）" % (_what, _rc))
            check(_snap() == _s0 and _man_now() == _m0,
                  "%s：**一个字节都没写**（两张图与台账都没动）" % _what)
        _rc, _t = _runpick("A44", "shiny")
        check(_rc == 2 and "用法" in _t and _snap() == _s0 and _man_now() == _m0,
              "不带 `--dry` 又省版号 ⇒ 报用法错（**退出码 2**，与 `--list`+id 撞车同口径）"
              "且不落盘（防手滑把「少打一个数字」直接变成一次真换 —— 那一步不可逆）"
              "（实得 rc=%d）" % _rc)
        _rc, _t = _runpick("A44", "shiny", "2")
        _now = _man_now()
        with open(_pa, "rb") as _f:
            _pa_bytes = _f.read()
        check(_rc == 0 and _snap() != _s0 and _now["shiny"]["label"] == "乙"
              and _now["shiny-2"]["label"] == "甲" and _pa_bytes == b"BB",
              "真换：**文件与台账一起**换（只换文件 = 台账开始描述另一张图，而且不报错）")
        _rc, _t = _runpick("A44", "shiny", "2")
        check(_rc == 0 and _snap() == _s0 and _man_now() == _m0,
              "再跑一次同一条命令就换回来（可反悔）")

    print("\n[22] pick-card：`--only-missing` 的筛选方向（本轮修的第三个 bug）")
    # 病根（2026-10-11 实测）：`cmd_list()` 里那个开关写成
    #     `if only_missing and len(on_disk) < len(ks): continue`
    #   ⇒ 把**版本没出齐的**那几条筛掉、留下**齐的** —— 与 help（「只列『版本没出齐』的」）
    #   正好相反。它**不报错**，而且在现状下**完全看不出来**：盘上 26 条候选两版全在，
    #   加不加这个开关输出一字不差（同族：Q14 的「静默跳过」）。
    # 🔴 想验它就必须**造一个「缺一版」的样本**（真盘上没有这种鱼），
    #    否则这条判据会因为「空集」而恒真 —— 所以这里用沙盒合成台账 + 少写一个文件。
    #    ⚠️ 沙盒与 [21] 共用同一套路径改写手法（`PC.OUT` / `PC.MANIFEST` / `PC.TMP`），
    #       全程不碰 `assets/cards/`。
    if os.path.exists(pc_path):
        # ⚠️ `PC` 在 [21] 里已经加载过同一个模块对象（`importlib` 不缓存但变量还在）
        #    ⇒ 直接复用，重设路径即可；真缺了才重新加载（单独跑 [22] 的场合）。
        if "PC" not in dir():
            _s2 = importlib.util.spec_from_file_location("pick_card_onlymiss", pc_path)
            PC = importlib.util.module_from_spec(_s2)
            _s2.loader.exec_module(PC)
        _sand2 = os.path.join(TMP, "pickcard-onlymiss")
        if os.path.isdir(_sand2):
            shutil.rmtree(_sand2)
        os.makedirs(os.path.join(_sand2, "cards"))
        PC.OUT = os.path.join(_sand2, "cards")
        PC.MANIFEST = os.path.join(PC.OUT, "manifest.json")
        PC.TMP = os.path.join(PC.OUT, "_tmp")
        # 三条鱼：`OKA` 两版齐 / `MIS` 缺第 2 版的文件 / `MIS1` 缺第 1 版的文件
        #   （两种「没出齐」都要认：缺哪一版都挑不了）
        _man2 = {
            "OKA": {"name": "两版齐的鱼",
                    "morphs": {"shiny": {"label": "甲"}, "shiny-2": {"label": "乙"}}},
            "MIS": {"name": "缺第二版的鱼",
                    "morphs": {"shiny": {"label": "甲"}, "shiny-2": {"label": "乙"}}},
            "MIS1": {"name": "缺第一版的鱼",
                     "morphs": {"shiny": {"label": "甲"}, "shiny-2": {"label": "乙"}}},
        }
        with io.open(PC.MANIFEST, "w", encoding="utf-8") as _f:
            _f.write(json.dumps(_man2, ensure_ascii=False, sort_keys=True))
        for _p in ("OKA-shiny.png", "OKA-shiny-2.png",
                   "MIS-shiny.png", "MIS1-shiny-2.png"):
            with open(os.path.join(PC.OUT, _p), "wb") as _f:
                _f.write(b"x")

        def _runlist(*argv):
            _old = sys.argv
            sys.argv = ["pick-card.py"] + list(argv)
            _buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(io.StringIO()):
                    PC.main()
                _rc = 0
            except SystemExit as _e:
                _rc = _e.code if isinstance(_e.code, int) else 1
            finally:
                sys.argv = _old
            return _rc, _buf.getvalue()

        _rc, _all = _runlist("--list")
        check(_rc == 0 and "OKA" in _all and "MIS" in _all and "MIS1" in _all,
              "`--list`（不筛）：三条都列（前提成立 —— 沙盒里真有一条是残缺的）")
        _rc, _miss = _runlist("--list", "--only-missing")
        check(_rc == 0 and "MIS" in _miss and "MIS1" in _miss,
              "`--only-missing`：**缺版本的**两条都要列（缺第 1 版 / 缺第 2 版都算没出齐）")
        check("OKA" not in _miss,
              "`--only-missing`：**版本齐的那条不许出现**"
              "（旧写法把这条留下、把残缺的两条筛掉 ⇒ 正好反了）")
        check("版本没出齐" in _miss and "把某一版扶正" not in _miss,
              "`--only-missing` 的表头写的是「版本没出齐」，且**不给**「把某一版扶正」的建议"
              "（那几条真挑不了 —— 给这句话等于教人撞墙）")
        # 反向验证的机器化版本：**同一个样本**上，新旧两种筛选方向给出的行集必须不相交
        #   —— 否则说明样本没选对、上面的断言其实是恒真的（本项目踩过「判据条件写宽」）。
        def _rows_of(_judge):
            _out = []
            for _fid in ("OKA", "MIS", "MIS1"):
                _ks = ["shiny", "shiny-2"]
                _od = [k for k in _ks
                       if os.path.exists(os.path.join(PC.OUT, "%s-%s.png" % (_fid, k)))]
                if _judge(len(_od), len(_ks)):
                    _out.append(_fid)
            return _out

        check(_rows_of(lambda a, b: a < b) == ["MIS", "MIS1"]
              and _rows_of(lambda a, b: not (a < b)) == ["OKA"],
              "反向验证：新方向留 `MIS/MIS1`、旧方向留 `OKA`，两者**不相交** "
              "⇒ 上面那两条断言在旧代码上必红（判据不是恒真）")

    print("\n[23] `--sleep-check` 的分块睡眠：必须**真的分块续心跳**（本轮新接线的那条）")
    # 病根：`gen-art.py --sleep-check` 自 `48faa42`（2026-10-08「无人值守保险」）起
    #   **只声明、从没被读过** —— 传了等于没传（退出码 0、不报错、行为与不传一样）。
    # 本轮把它接上，但「接上」不只是加一行调用：`--sleep-check N` 要歇 N 秒，
    #   而锁的存活靠**心跳**（`LOCK_STALE_SEC` 没心跳就判「上一轮已死、可以接管」）⇒
    #   一口气 `time.sleep(N)` 睡过阈值，别的生图进程会接管 ⇒ 重复出图 + 并发写 manifest.json。
    #   ⇒ 实现按 `SLEEP_CHUNK_SEC` 分块、每块之间续一次心跳。
    # 这里钉三件静态判据看不出来的事：**分块粒度真的决定心跳次数**、0 秒立刻返回、
    #   `beat` 可省（渲染循环之外也想用它时不许炸）。
    GA = load_genart()
    if hasattr(GA, "sleep_in_chunks"):
        check(GA.SLEEP_CHUNK_SEC < GA.LOCK_STALE_SEC,
              "分块粒度 %gs 必须小于心跳阈值 %gs（否则分块也白搭：睡过阈值的那一段里，"
              "别的进程会把这个锁判成 free 并接管）" % (GA.SLEEP_CHUNK_SEC, GA.LOCK_STALE_SEC))
        # 把粒度临时调小，好在几十毫秒里观察「分块 ⇒ 多次心跳」（不然要真睡 90 秒）
        _oldchunk = GA.SLEEP_CHUNK_SEC
        GA.SLEEP_CHUNK_SEC = 0.02
        _t0 = time.time()
        _beats = []
        GA.sleep_in_chunks(0.05, lambda: _beats.append(time.time()))
        _el = time.time() - _t0
        check(len(_beats) == 3 and _el >= 0.045,
              "粒度 0.02s 睡 0.05s ⇒ **续了 3 次心跳**且真的睡够了（实得 %d 次 / %.3fs）"
              % (len(_beats), _el))
        check(all(b <= _beats[i + 1] for i, b in enumerate(_beats[:-1])),
              "心跳是按时间先后发生的（不是一次性攒在同一刻）")
        _b2 = []
        GA.sleep_in_chunks(0.05, lambda: _b2.append(1))
        check(len(_b2) == 3, "同参数再跑一次，心跳次数稳定（实得 %d 次）" % len(_b2))
        GA.SLEEP_CHUNK_SEC = _oldchunk
        _b3 = []
        GA.sleep_in_chunks(0, lambda: _b3.append(1))
        check(_b3 == [], "睡 0 秒 ⇒ 一次心跳都不续、立刻返回（别把 `--sleep-check 0` 变成忙等）")
        _ok_no_beat = True
        try:
            GA.sleep_in_chunks(0.01)          # 不传 beat 也不许炸
        except Exception:
            _ok_no_beat = False
        check(_ok_no_beat, "`beat` 可省（不传也不许抛）")
        # 判据效力：**粒度决定心跳次数** —— 拿「粒度 > 总时长」反证「分块不是摆设」
        _oldchunk = GA.SLEEP_CHUNK_SEC
        GA.SLEEP_CHUNK_SEC = 5
        _b4 = []
        GA.sleep_in_chunks(0.05, lambda: _b4.append(1))
        GA.SLEEP_CHUNK_SEC = _oldchunk
        check(len(_b4) == 1,
              "把粒度调到 5s（> 总时长 0.05s）⇒ 只续 1 次 —— 说明 30s 这个粒度**真的是**"
              "心跳节奏的来源（粒度 ≥ 阈值时它就是一句 `time.sleep`）")
    else:
        check(False, "`gen-art.py` 里找不到 `sleep_in_chunks()` —— `--sleep-check` 又变成"
                     "「声明了没人读」的空开关（这正是本轮修的那个形状）")

    print("\n[24] 同一端口不许起第二个评审台运行器（本轮修的第四件事：Q58）")
    # 病根：`serve()` 末尾那句 `ThreadingTCPServer.allow_reuse_address = True` 在 **Windows 上
    #   就是 `SO_REUSEADDR`** —— 它允许**第二个 socket 绑同一个地址**。实测连起两次之后
    #   `netstat` 里是**两个 pid 同时 LISTENING 在同一端口**，两个窗口都印「运行器已启动」、
    #   **谁都不报错**。而用户最自然的动作恰恰是「双击两次 `review-desk.cmd`」。
    # 修法：起服务**之前**先探 `/api/ping`，有人答就不再绑，把地址报给人并正常退出（0）。
    # 🔴 这一段**真起服务**（子进程）+ 真起第二次，因为它要证的是**绑定行为**，
    #    静态断言看不见（`allow_reuse_address` 那行的存在与否都「看起来没问题」）。
    #    ⚠️ 端口取自 `PORT_BASE`（偏移一个不常用的段位），跑完全部收掉，不留后台进程。
    import socket as _sock
    PORT_BASE = 8791

    def _can_bind(_port):
        """不带 SO_REUSEADDR 能不能绑上 —— 有人 LISTENING 时 Windows 会拒（这正是判据的对照物）。"""
        _s = _sock.socket()
        try:
            _s.bind(("127.0.0.1", _port))
            return True
        except OSError:
            return False
        finally:
            _s.close()

    def _listen_count(_port):
        """`netstat` 里这个端口的 LISTENING 行数（读不到就返回 None，由调用方决定怎么报）。"""
        try:
            _r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                                errors="replace", timeout=20)
            return len([l for l in (_r.stdout or "").split("\n")
                        if (":%d " % _port) in l and "LISTENING" in l])
        except Exception:
            return None

    if hasattr(R, "runner_alive"):
        check(R.runner_alive(PORT_BASE, timeout=0.6) is False and _can_bind(PORT_BASE),
              "空端口上：`runner_alive()` 说没有、裸 socket 也绑得上（前提成立）")
        _p1 = subprocess.Popen([sys.executable, "-u", os.path.join(TOOLS, "review-cards.py"),
                                "--serve", "--port", str(PORT_BASE)],
                               cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace")
        try:
            _up = False
            for _ in range(60):                     # 最多等 30 秒（启动时有一次 gen-art 自检）
                if R.runner_alive(PORT_BASE, timeout=0.6):
                    _up = True
                    break
                if _p1.poll() is not None:
                    break
                time.sleep(0.5)
            check(_up, "第一个运行器真的起来了（`/api/ping` 答话）")
            # ⚠️ 第二次必须用 Popen + 有界等待，**不能用 `subprocess.run(timeout=…)`**：
            #    修之前那版会**绑上端口并 serve_forever**（永远不返回）⇒ `run()` 抛
            #    `TimeoutExpired`（整份宿主崩掉、退出码 1 却没有「未通过」标记，
            #    反向验证会把它读成「没报红」）。这里把「一直不返回」**当成失败证据**收下。
            _p2 = subprocess.Popen([sys.executable, "-u", os.path.join(TOOLS, "review-cards.py"),
                                    "--serve", "--port", str(PORT_BASE)],
                                   cwd=ROOT, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace")
            try:
                _t2 = _p2.communicate(timeout=90)[0] or ""
                _rc2, _hung = _p2.returncode, False
            except subprocess.TimeoutExpired:
                _p2.kill()
                _t2 = (_p2.communicate()[0] or "")
                _rc2, _hung = None, True
            check(not _hung and _rc2 == 0,
                  "第二次起**立刻正常退出 0**（用户的意图「我要用评审台」已经满足了，不是错误）"
                  "（实得 %s）" % ("一直不返回 = 它把端口又绑上了、正在 serve_forever" if _hung
                                   else "rc=%s" % _rc2))
            check("已经有一个评审台运行器在跑" in _t2,
                  "第二次起会明说「已经有一个运行器在跑」并把地址报给人")
            check("运行器已启动" not in _t2,
                  "第二次起**没有**再印「运行器已启动」（印了就说明它又绑了一次）")
            _n = _listen_count(PORT_BASE)
            check(_n == 1,
                  "同一端口只有一个 LISTENING（实得 %s —— 修之前这里是 2，而两个进程都不报错）"
                  % ("读不到" if _n is None else _n))
        finally:
            _p1.kill()
            try:
                _p1.wait(timeout=10)
            except Exception:
                pass
        _gone = False
        for _ in range(20):
            if not R.runner_alive(PORT_BASE, timeout=0.6) and _can_bind(PORT_BASE):
                _gone = True
                break
            time.sleep(0.5)
        check(_gone, "收尾：运行器被收掉、端口重新空出来（测试不留后台进程）")
    else:
        check(False, "`review-cards.py` 里找不到 `runner_alive()` —— 同端口二次启动又没人拦了")

    print("\n[25] `--stale` 报告打印的「重出命令」必须**照抄就能跑**（档名 vs 归档键）")
    # 病根（2026-10-12 第 53 轮实测出来的真 bug）：`report_stale()` 按**归档键**分组打印，
    #   而一档多版时归档键带 `-2` 后缀（`shiny-2`，27 条传说鱼的闪光第 2 版）；
    #   它把那个键直接拼进 `--only-morph`，而 `--only-morph` 的值域只有**档名**
    #   （`[k for k, _ in MORPHS]`）⇒ 照打印的命令跑会当场
    #   `--only-morph 里有不认识的档：shiny-2（可选：bright/albino/golden/shiny）`。
    #   这一行的用途恰恰是「照抄就能重出」⇒ 它是**假提示**，而不是一条无害的笔误。
    #
    # 判法（确定性，不依赖真实卡面状态）：把 `card_state()` 换成「只有 shiny 第 2 版算过期」
    #   的桩 + 把 MANIFEST 指向临时文件 ⇒ 那一条组必然出现（判据不是空转），
    #   然后逐个检查它打印出来的 `--only-morph` 值。
    GA = load_genart()
    _mfile = os.path.join(TMP, "rs-manifest-stub.json")
    with io.open(_mfile, "w", encoding="utf-8") as fh:
        json.dump({"A44": {}}, fh)
    _old_man, _old_state = GA.MANIFEST, GA.card_state
    GA.MANIFEST = _mfile
    GA.card_state = lambda f, morph, vi, man: (
        "步数已变" if (morph, vi) in ((None, 0), ("bright", 0), ("shiny", 1)) else None)
    try:
        _buf = io.StringIO()
        with contextlib.redirect_stdout(_buf):
            GA.report_stale([f for f in GA.load_fish() if f["id"] in ("A44", "SS01")])
        out = _buf.getvalue()
    finally:
        GA.MANIFEST, GA.card_state = _old_man, _old_state
        try:
            os.remove(_mfile)                      # 收尾不留临时文件（同「不留后台进程」那条规矩）
        except OSError:
            pass
    keys = [k for k, _ in GA.MORPHS]                    # `--only-morph` 的合法值域（档名）
    check("shiny-2" in out,
          "桩生效：输出里出现了带版本后缀的分组 `shiny-2`（否则这条断言是空转）")
    check("母版" in out, "桩生效：母版那一组也在（它打印的命令**不带** --only-morph）")
    flags = re.findall(r"--only-morph\s+(\S+)", out)
    check(len(flags) >= 2, "报告里确实打印了 --only-morph 命令（实得 %d 条）" % len(flags))
    bad = sorted({x for x in flags if x not in keys})
    check(not bad,
          "打印的 --only-morph 值全部落在档名集合 %s（越界 = 照抄会报错）：%s"
          % ("/".join(keys), bad or "一致"))
    if "shiny-2" in out:
        _line = [ln for ln in out.split("\n") if "--only-morph" in ln and "shiny" in ln]
        check(any(ln.split("--only-morph")[-1].strip() in keys for ln in _line),
              "`shiny-2` 那一组打印的是**档名**（`--only-morph shiny`），不是归档键")
    ids = re.findall(r"--list\s+(\S+)", out)
    fish_ids = {f["id"] for f in GA.load_fish()}
    check(all(set(x.split(",")) <= fish_ids for x in ids) and ids,
          "打印的 --list 值都是鱼 id（实得 %d 条命令）" % len(ids))

    print("\n[26] `measure-silhouette.py`：「一条都没量到」不许当成功（本轮修的真缺陷）")
    # 病根（2026-10-12 第 57 轮实测）：待测目录不存在时，六行全印「测量失败」而**退出码 0**
    #   —— 一份看起来正常的表格 + 成功退出码，实际一条数据都没有。同轮还查出它文件头里
    #   两处不实（`_m3d` vs 代码里的 `m3d`；写着「或改参数指定目录」而当时没有参数解析）。
    # 判法：真 spawn 这个工具，逐条看**退出码 + 文案**；另有「盘上文件一个字节都没动」的守卫
    #   （它是只读工具，任何写盘都是事故）。
    SIL = os.path.join(TOOLS, "measure-silhouette.py")
    _watch = [os.path.join(ROOT, "src", "data", "fish.js"),
              os.path.join(ROOT, "src", "data", "fields.js"),
              os.path.join(ROOT, "tools", "fish-traits.json")]
    _before = {}
    for _p in _watch:
        with io.open(_p, "rb") as _fh:
            _before[_p] = hashlib.md5(_fh.read()).hexdigest()

    def run_sil(*args):
        return subprocess.run([sys.executable, SIL] + list(args),
                              capture_output=True, text=True, errors="replace", cwd=ROOT)

    _empty = os.path.join(TMP, "sil-empty")
    if not os.path.isdir(_empty):
        os.makedirs(_empty)
    r_miss = run_sil("--mine-dir", _empty, "--only", "fish,shark")
    check(r_miss.returncode == 1,
          "待测图不在盘上 ⇒ **退出码 1**（实得 %d）—— 旧的「全印测量失败却退 0」是假成功"
          % r_miss.returncode)
    check("图不在" in r_miss.stdout,
          "逐侧说清「是哪一种没量到」（输出里要有『图不在』，不是一句『测量失败』）")
    r_help = run_sil("--help")
    check(r_help.returncode == 0 and "usage" in r_help.stdout,
          "`--help` 退出码 0 且打出 usage（此前它没有参数解析，只能量写死的那两个目录）")
    r_bad = run_sil()
    check(r_bad.returncode == 2,
          "缺 `--mine-dir` ⇒ 用法错（退出码 2，实得 %d）" % r_bad.returncode)

    # 正控：给一张真图 ⇒ 退出码 0 且真量出宽高比（否则「恒退 1」的判据就是空转）
    _mine = os.path.join(TMP, "sil-mine")
    if not os.path.isdir(_mine):
        os.makedirs(_mine)
    _ref = os.path.join(ROOT, "docs", "images", "v9-ref", "fish.jpg")
    if os.path.isfile(_ref):
        shutil.copyfile(_ref, os.path.join(_mine, "fish.png"))
        r_ok = run_sil("--mine-dir", _mine, "--only", "fish")
        check(r_ok.returncode == 0 and "成功 1 / 失败 0" in r_ok.stdout,
              "给一张真图 ⇒ 退出码 0 且打印出宽高比（正控：说明上面那两条不是「恒退 1」）")
    else:
        check(False, "`docs/images/v9-ref/fish.jpg` 不在 ⇒ 正控跑不了（先修测试宿主）")

    _moved = [p for p in _watch if hashlib.md5(io.open(p, "rb").read()).hexdigest() != _before[p]]
    check(not _moved, "量轮廓的工具**一个字节都没写盘**（它是只读工具）：%s" % (_moved or "未变"))
    for _d in (_empty, _mine):                      # 收尾不留临时目录（同「不留后台进程」那条规矩）
        shutil.rmtree(_d, ignore_errors=True)

    print("\n[27] 生图管线的**两层口径**：只有「换了物种」的才要重出（用户 2026-10-12 拍板）")
    # 病根（2026-10-12 用户原话）：「其实没必要全变的…让**只有换了物种的**需要重新生成。
    #   后续我会审查全部图片之后再选出需要修改的」。而当时 `card_state()` 把「提示词已变」
    #   也算成「要重出」⇒ 口径改过一次之后，`--stale` 报 **1706 张**（等于全都要重出）。
    # 口径：要重出 = 无文件 / 母版派生缺失 / 无台账 / **物种已换**；
    #   提示词 / 步数这类**生成口径漂移**降级为提示（`card_drift()`），`--skip-existing` 会跳过它们。
    # 判法：合成沙盒（假 OUT + 假 manifest + 真 `card_plan()` 算出的提示词）逐情形真调，
    #   并**两向**都钉：漂移不许进「要重出」、换物种不许被跳过。
    _GA2 = load_genart()
    _fish = [f for f in _GA2.load_fish() if f["id"] == "A01"][0]
    _box = os.path.join(TMP, "cardstate-sandbox")
    shutil.rmtree(_box, ignore_errors=True)
    os.makedirs(_box)
    _mpath = os.path.join(_box, "manifest-stub.json")
    _old_out, _old_man_path = _GA2.OUT, _GA2.MANIFEST
    _watch2 = os.path.join(ROOT, "src", "data", "fish.js")
    with io.open(_watch2, "rb") as _fh:
        _fish_md5 = hashlib.md5(_fh.read()).hexdigest()
    try:
        _GA2.OUT, _GA2.MANIFEST = _box, _mpath
        _mname, _mprompt, _msteps, _mkey, _mder = _GA2.card_plan(_fish, None, 0)
        for _n in (_mname, _mder):
            io.open(os.path.join(_box, _n), "w").write("x")

        def _man(prompt=None, steps=None, name=None, sub=None):
            d = {"name": _fish["name"] if name is None else name, "steps": _msteps if steps is None else steps,
                 "prompt": _mprompt if prompt is None else prompt}
            if sub is not None:
                d["morphs"] = sub
            json.dump({"A01": d}, io.open(_mpath, "w", encoding="utf-8"))

        def _state():
            return _GA2.card_state(_fish, None, 0, json.load(io.open(_mpath, encoding="utf-8")))

        def _drift():
            return _GA2.card_drift(_fish, None, 0, json.load(io.open(_mpath, encoding="utf-8")))

        _man()
        check(_state() is None and _drift() is None,
              "全部对齐（提示词 / 步数 / 名字都与台账一致）⇒ 既不「要重出」也没有漂移")
        _man(prompt=_mprompt + " old")
        check(_state() is None, "🔴 只改了提示词 ⇒ **不算要重出**（`card_state()` 返回 None）")
        check(_drift() == "提示词已变", "同一条必须出现在**漂移**里（不许两边都不报）：%s" % _drift())
        _man(steps=_msteps + 5)
        check(_state() is None and _drift() == "步数已变",
              "只改了步数 ⇒ 也算漂移、不算要重出（%s / %s）" % (_state(), _drift()))
        _man(name="塘泥螺")
        check(_state() == "物种已换", "台账里的名字与现在不同 ⇒ **要重出**（实得 %s）" % _state())
        _man(prompt="")          # 空串 = 台账里没有这条路（helper 的 `None` 是「用默认」，别混）
        check(_state() == "无台账", "台账里没有这条路 ⇒ 判「无台账」（实得 %s）" % _state())
        _man()
        os.remove(os.path.join(_box, _mder))
        check(_state() == "派生缺失", "母版在、`-normal` 不在 ⇒ 判「派生缺失」（实得 %s）" % _state())
        io.open(os.path.join(_box, _mder), "w").write("x")
        os.remove(os.path.join(_box, _mname))
        check(_state() == "无文件", "还没出过图 ⇒ 判「无文件」（待出，不是过期）：%s" % _state())
        io.open(os.path.join(_box, _mname), "w").write("x")

        # 跳过口径必须与判定同源（`--skip-existing` 跑一轮 = 只重出要重出的那批）
        _man(prompt=_mprompt + " old")
        _mf = json.load(io.open(_mpath, encoding="utf-8"))
        check(_GA2.skip_note(_fish, None, 0, _mf, True) is None,
              "`--skip-existing`：只漂移的卡**跳过**（否则一轮又把 1700 张全重出一遍）")
        _man(name="黄斑蟹")
        _mf = json.load(io.open(_mpath, encoding="utf-8"))
        check(_GA2.skip_note(_fish, None, 0, _mf, True) == "物种已换",
              "`--skip-existing`：换了物种的**不跳过**（这一条是整件事的目的）")

        # 报告必须**两段都打**：漂移那批不能从 `--stale` 里消失
        _man(prompt=_mprompt + " old")
        _buf = io.StringIO()
        with contextlib.redirect_stdout(_buf):
            _GA2.report_stale([_fish])
        _out = _buf.getvalue()
        check("没有**要重出**的卡片" in _out and "生成口径漂移" in _out,
              "只漂移时：报告说「没有要重出的」**并且**单独报出漂移（不许吞掉）")
        _man(name="黄斑蟹")
        _buf = io.StringIO()
        with contextlib.redirect_stdout(_buf):
            _GA2.report_stale([_fish], drift_detail=True)
        _out2 = _buf.getvalue()
        check("要重出的卡片共 1 张" in _out2 and "物种已换" in _out2,
              "换物种时：报告第一段把它列成「要重出」（1 张 / 原因物种已换）")
    finally:
        _GA2.OUT, _GA2.MANIFEST = _old_out, _old_man_path
        shutil.rmtree(_box, ignore_errors=True)
    with io.open(_watch2, "rb") as _fh:
        check(hashlib.md5(_fh.read()).hexdigest() == _fish_md5,
              "这一节只动沙盒：`src/data/fish.js` 一个字节都没变")

    print("\n[28] `tools/*.py` 的用法面：`-h` 退出 0、未知开关退出 2、且**一个字节都不写盘**")
    # 病根（Q90，2026-10-12 第 57 轮实测）：`python tools/gen-fish.py --help` **真的重写了
    #   `src/data/fish.js` 362 行**、退出码 0 —— 手写 argv 的工具把 `--help` 当成位置参数忽略，
    #   然后照常跑完整条数值链里最不可逆的那一步（`--dry` 那一句只看 `'--dry' in sys.argv`）。
    #   同族：`check-fishdata-drift.py --help` 抛 traceback、`check-cards.py --help` 当文件名、
    #   `measure-shine.py --help` 当鱼 id、`facet-count` / `measure-palette-facets` 忽略一切参数。
    # 判法：**逐个真 spawn**。这是行为面唯一的办法 —— 静态判据（`verify [32-x]`）只能证明
    #   「文件里有 ArgumentParser」，证不了「`-h` 真的在**任何写盘动作之前**退出」。
    #   ⚠️ 被盯的数据文件 md5 必须**同一节内比对**：只读工具任何写盘都是事故。
    _watch28 = [os.path.join(ROOT, "src", "data", "fish.js"),
                os.path.join(ROOT, "src", "data", "fields.js"),
                os.path.join(ROOT, "tools", "fish-traits.json")]
    _b28 = {}
    for _p in _watch28:
        with io.open(_p, "rb") as _fh:
            _b28[_p] = hashlib.md5(_fh.read()).hexdigest()

    # 宿主自己不参与（它跑完就会 `sys.exit`，而且正在运行的就是它）
    _me28 = os.path.basename(os.path.abspath(__file__))
    _pys28_all = sorted(f for f in os.listdir(TOOLS)
                        if f.endswith(".py") and f != _me28)
    # 🆕 Q95（第 59 轮）：`tools/wash.py` 是**纯库模块**（没有 `__main__` 入口、没有命令行面）
    #   ⇒ 它不该被要求「`--help` 打得出 usage」。豁免口径 = **有没有 `__main__` 入口**（现算，
    #   不看文件名白名单），并且这条豁免**必须仍然需要**（真的存在库模块，否则报红 —— 同 §40 口径）。
    _lib28 = [f for f in _pys28_all
              if "__main__" not in wash.strip_py(io.open(os.path.join(TOOLS, f), encoding="utf-8").read())]
    _pys28 = [f for f in _pys28_all if f not in _lib28]
    check(len(_lib28) >= 1,
          "纯库模块（无 `__main__` 入口）%d 个：%s —— 一个都没有说明豁免已过期（要么库模块被删了，"
          "要么它偷偷加了入口却还在这儿免检）" % (len(_lib28), "、".join(_lib28) or "无"))
    check(len(_pys28) >= 20,
          "`tools/*.py` 的命令行工具扫到 %d 个（少于 20 ⇒ 扫描面坏了，这一节会变成空断言）"
          % len(_pys28))

    def run_py28(name, *a):
        return subprocess.run([sys.executable, os.path.join(TOOLS, name)] + list(a),
                              capture_output=True, text=True, errors="replace", cwd=ROOT)

    _no_help, _no2 = [], []
    for _name in _pys28:
        _r = run_py28(_name, "--help")
        # ⚠️ 退出码 0 **且**打得出 usage：只判退出码放得过「静默忽略参数照样跑完」的那种
        if _r.returncode != 0 or "usage" not in (_r.stdout + _r.stderr).lower():
            _no_help.append("%s（退出码 %d）" % (_name, _r.returncode))
        _r2 = run_py28(_name, "--zzz-unknown")
        if _r2.returncode != 2:
            _no2.append("%s（退出码 %d）" % (_name, _r2.returncode))
    check(not _no_help,
          "每个 `tools/*.py` 的 `--help` 都退出 0 且打得出 usage（另有 %d 个不合格：%s）"
          % (len(_no_help), "、".join(_no_help) or "无"))
    check(not _no2,
          "每个 `tools/*.py` 的未知开关都退出 **2**（用法错）—— 另有 %d 个不合格：%s"
          % (len(_no2), "、".join(_no2) or "无"))

    # 🔴 本节的**正题**：`--help` 一个字节都不许写盘（上面那条事故就是这么发生的）
    _moved28 = [p for p in _watch28
                if hashlib.md5(io.open(p, "rb").read()).hexdigest() != _b28[p]]
    check(not _moved28,
          "跑完全部 `--help` / 未知开关之后，被盯的数据文件**一个字节都没变**：%s"
          % (("、".join(os.path.basename(p) for p in _moved28)) or "未变"))

    # 正控：这些工具**正常跑**时要真能干活（否则「`-h` 退出 0」可能只是「什么都干不了」）
    _fc = run_py28("facet-count.py", "--ref")
    check(_fc.returncode == 0 and "每千px" in _fc.stdout,
          "正控 `facet-count.py --ref` 真量出靶子（退出码 0 + 有「每千px」那一列）")
    _gf = run_py28("gen-fish.py", "--dry")
    check(_gf.returncode == 0 and "没有写盘" in _gf.stdout,
          "正控 `gen-fish.py --dry` 真跑且明说「没有写盘」")

    print("\n[29] `check-fishdata-drift.py` 的临时产物：**异常路径**也不许留在仓库里（Q92）")
    # 病根（Q92，2026-10-12 第 57 轮 C 类审计顺出来的小修）：它把旧版 `gen-art.py` 落到
    #   `tools/_drift_old.py`（靠 `__file__` 定位 ROOT ⇒ 必须落在 tools/），而清理只写在
    #   **最后一行** `os.remove()` ⇒ 中途抛异常（git 起不来 / import 旧版失败 / Ctrl-C）
    #   就把它留在盘上：一个**未跟踪**文件，长得像「有人手滑加进来的工具」，`git status` 从此一直脏。
    # 判法：① 真 spawn 正常跑一次，断言盘上不留；
    #   ② **真调 `main()`** 并让第 3 次 `git_show()` 抛异常（那一刻文件已经写下、还没到收尾），
    #      断言 `finally` 仍然把它清掉 —— 这一半才是 Q92 的正题（异常路径）。
    _DRIFT = os.path.join(TOOLS, "_drift_old.py")
    if os.path.exists(_DRIFT):
        os.remove(_DRIFT)
    _r29 = subprocess.run([sys.executable, os.path.join(TOOLS, "check-fishdata-drift.py"), "HEAD"],
                          capture_output=True, text=True, errors="replace", cwd=ROOT)
    check(_r29.returncode == 0 and not os.path.exists(_DRIFT),
          "正常跑完 `check-fishdata-drift.py HEAD` ⇒ 退出 0 且盘上不留 `tools/_drift_old.py`")

    _spec29 = importlib.util.spec_from_file_location(
        "fishdata_drift", os.path.join(TOOLS, "check-fishdata-drift.py"))
    _mod29 = importlib.util.module_from_spec(_spec29)
    _argv29 = sys.argv
    # ⚠️ 它在**模块顶层**就 `parse_args()` ⇒ 不换掉宿主的 argv 就会被宿主的参数（如 `--window`）打断
    sys.argv = ["check-fishdata-drift.py", "HEAD"]
    try:
        _spec29.loader.exec_module(_mod29)
    finally:
        sys.argv = _argv29

    _real29 = _mod29.git_show
    _call29 = {"n": 0, "existed": None}

    def _boom29(rel):
        _call29["n"] += 1
        if _call29["n"] >= 3:                    # 第 3 次 = tools/fish-traits.json（此时文件已写下）
            _call29["existed"] = os.path.exists(_DRIFT)
            raise RuntimeError("注入：第 3 次 git_show 失败")
        return _real29(rel)

    _mod29.git_show = _boom29
    _raised29 = False
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            _mod29.main()
    except RuntimeError:
        _raised29 = True
    finally:
        _mod29.git_show = _real29
    check(_raised29, "注入的异常真的抛出来了（否则这一节验的不是异常路径）")
    check(_call29["existed"] is True,
          "抛异常那一刻 `tools/_drift_old.py` **确实在盘上**（否则「清理掉」这条是空转）")
    check(not os.path.exists(_DRIFT),
          "异常路径下 `finally` 仍把它清掉（这就是 Q92 的正题：裸放最后一行的 `os.remove` 做不到）")

    print("\n[30] py 侧洗注释：抽值前必须洗（注释里的假数据不算数据）+ 与 js 侧逐字节同源（Q95）")
    # 为什么有这一节（2026-10-12 第 59 轮实测的洞）：`review-cards.load_fish()` 从
    #   `src/data/fish.js` 里正则抽鱼表，读的是**源码原文** ⇒ 往注释里写一行
    #   `// F('A99', '假鱼', 3, 'fish', '#123456')`，评审台就从 362 条变成 **363 条**
    #   （`A99` 真的进了表格），一句都不报错 —— 正是本项目最高频的「注释喂饱判据」。
    #   同族还有 `load_fields()`（钓场下拉凭空多一项）、`load_shape_cn()`、
    #   `measure-palette-facets.read_fish()`（色相直方图被注释里的色值污染）。
    _RE_FISH = r"F\('([A-Z]+\d+)',\s*'([^']*)',\s*(\d),\s*'([a-z]+)',\s*'(#[0-9A-Fa-f]{6})'"
    _sb30 = os.path.join(TMP, "wash-gate30")
    try:
        if os.path.isdir(_sb30):
            shutil.rmtree(_sb30)
        os.makedirs(_sb30)
        # ① 机制（沙盒，不动真数据）：三种形态的注释里各放一条假记录，洗过之后只认真的那条
        _fake = os.path.join(_sb30, "sample.js")
        _txt = ("// F('A99', '假鱼·行注释', 3, 'fish', '#123456')\n"
                "F('A01', '真记录', 3, 'fish', '#abcdef')\n"
                "/* F('A98', '假鱼·块注释', 3, 'fish', '#654321') */\n"
                "/* 跨行块注释\n   F('A97', '假鱼·跨行', 3, 'fish', '#0f0f0f') */\n")
        io.open(_fake, "w", encoding="utf-8").write(_txt)
        _ids_raw = [m[0] for m in re.findall(_RE_FISH, _txt)]
        _ids_wash = [m[0] for m in re.findall(_RE_FISH, wash.read_washed(_fake))]
        check(len(_ids_raw) == 4,
              "负对照：**不洗**的话 4 条（含 3 条注释里的假记录）全都会被抓到 —— 这一节确实有牙")
        check(_ids_wash == ["A01"],
              "洗过之后只认真记录（实得 %r；注释里的 3 条假记录一条都不许进来）" % (_ids_wash,))
        # ①-b py 口径：注释与 docstring 里的假记录也不许被抽到
        _fakepy = os.path.join(_sb30, "sample.py")
        _ptxt = ('x = 1  # NEEDLE=True 这一句是行尾注释\n'
                 '"""NEEDLE=True 这一段是 docstring"""\n'
                 "NEEDLE = True\n"
                 "s = '#a87a1f'  # 引号里的井号不是注释\n")
        _pcode = wash.read_washed(_fakepy.replace(".py", ".py")) if False else wash.strip_py(_ptxt)
        check(len(re.findall(r"NEEDLE = True", _pcode)) == 1,
              "py 口径：整行 / 行尾 / docstring 里的 `NEEDLE = True` 都不算（只留真那一处）")
        check("'#a87a1f'" in _pcode,
              "py 口径：**引号里的 `#` 一个字节都不许动**（撕开它 = 色值字符串被切半，判据再也找不到）")
        # ② 三个 loader（+ 量图工具）必须真的走共用实现：从**函数体**里判，不看全文出现过
        R = load_review()
        for _mod, _rel, _fn in ((R, "review-cards.py", "load_fish"),
                                (R, "review-cards.py", "load_fields"),
                                (R, "review-cards.py", "load_shape_cn")):
            _src = wash.strip_py(io.open(os.path.join(TOOLS, _rel), encoding="utf-8").read())
            _body = _src.split("def %s(" % _fn)[1].split("\ndef ")[0]
            check("wash.read_washed(" in _body,
                  "`%s()` 读源码走 `wash.read_washed()`（抽值前先洗——抓不到就是又直接 `io.open().read()` 了）" % _fn)
        _mp = wash.strip_py(io.open(os.path.join(TOOLS, "measure-palette-facets.py"), encoding="utf-8").read())
        _mpbody = _mp.split("def read_fish(")[1].split("\ndef ")[0]
        check("wash.read_washed(" in _mpbody,
              "`measure-palette-facets.read_fish()` 同样先洗（它是色相直方图那条标尺）")
        # ③ 跨语言对拍：py 的 `tools/wash.py` 与 js 的 `tools/wash.js` 在同一批真文件上必须逐字节相同
        #    （两边是**有意保留的两份实现** —— 宿主语言不同，唯一的防线就是对拍；行尾按 LF 归一，
        #     因为 python 文本模式本来就把 CRLF 翻译成 LF，那不是口径差异）
        _node = shutil.which("node")
        if not _node:
            print("      · 跳过跨语言对拍：本机 PATH 里没有 node（环境问题，不是代码问题）")
        else:
            _files30 = ["src/data/fish.js", "src/data/fields.js", "src/data/config.js",
                        "src/render/fishart.js", "src/ui/panels.js", "tools/gen-art.py",
                        "tools/prep-cards.py", "tools/review-cards.py",
                        "assets/css/style.css", "tools/wash.py"]
            _prog = (
                "const fs=require('fs'),crypto=require('crypto');"
                "const {wash}=require('./tools/wash.js');"
                "const F=" + json.dumps(_files30) + ";"
                "const l=[];"
                "for(const r of F){const s=wash(r,fs.readFileSync(r,'utf8')).split('\\r\\n').join('\\n');"
                "l.push(crypto.createHash('md5').update(s,'utf8').digest('hex')+' '+r);}"
                "console.log(l.join('\\n'));")
            _r30 = subprocess.run([_node, "-e", _prog], capture_output=True, text=True,
                                  errors="replace", cwd=ROOT)
            if _r30.returncode != 0:
                check(False, "跨语言对拍跑不起来（node 退出码 %d）：%s"
                      % (_r30.returncode, (_r30.stderr or "").strip()[:160]))
            else:
                _js = dict((ln.split(" ", 1)[1], ln.split(" ", 1)[0]) for ln in _r30.stdout.strip().split("\n"))
                _diff30 = []
                for _rel in _files30:
                    _mine = hashlib.md5(wash.read_washed(os.path.join(ROOT, _rel)).encode("utf-8")).hexdigest()
                    if _js.get(_rel) != _mine:
                        _diff30.append(_rel)
                check(len(_js) == len(_files30),
                      "js 侧回报了 %d/%d 个文件（少于就说明那边的清单/实现坏了）" % (len(_js), len(_files30)))
                check(not _diff30,
                      "py 的 `tools/wash.py` 与 js 的 `tools/wash.js` 在 %d 个真文件上**逐字节相同**"
                      "（另有 %d 个不一致：%s）"
                      % (len(_files30), len(_diff30), "、".join(_diff30) or "无"))
        # ④ py 侧也不许再有**局部**洗注释实现（与 `verify [32-w]` 同款纪律，只是这一侧归 python 管）。
        #    判法：扫每个 `.py` 的代码面，找 `re.sub(` 的那些调用，看**它紧跟着的正则实参**是不是
        #    在剥注释（含 `#[^` 这种「井号到行尾」或三引号）—— 名称无关，所以「换个名字照样抄」
        #    也抓得到。针串全部**拼接造**，否则本节的示例文本会把自己喂饱（硬规矩 ①/㊳）。
        #    ⚠️ **有意保留的一个假报类**：把「洗注释的写法」原样**抄进字符串字面量**（例如当测试样本）
        #       也会被判红 —— 判据分不清「真的在洗」与「引用一个洗的写法」。要留这种样本请按
        #       项目惯例**拼接**造针串（`"re." + "sub("` 这样），那样就不会被自己喂饱。
        _SUB = "re." + "sub("
        _HASH = "#[" + "^"
        _Q3 = '"' * 3
        _lit30 = _SUB + "r'" + _HASH          # 形态一：re.sub(r'#[^…', …)
        _lit31 = _SUB + "r\"" + _HASH          # 形态二：re.sub(r"#[^…", …)
        _lit32 = _SUB + "r'" + _Q3             # 形态三：re.sub(r'"""…', …)
        _lit33 = _SUB + "r\"" + _Q3            # 形态四：re.sub(r"""…", …)

        def _local_washers30(code):
            hits = 0
            for _n in (_lit30, _lit31, _lit32, _lit33):
                hits += code.count(_n)
            return hits

        # 自检：合成样本必须被认出来（拼接造，别让本节自己的示例喂饱判据）
        _s30 = "x = " + _SUB + "r'" + _HASH + "\\n]*', '', s)"
        check(_local_washers30(_s30) >= 1,
              "自检：局部洗注释的针串在合成样本上必须命中（否则本条判据恒真、白过）")
        _local30 = []
        for _f in sorted(os.listdir(TOOLS)):
            if not _f.endswith(".py") or _f == "wash.py":
                continue
            _code = wash.strip_py(io.open(os.path.join(TOOLS, _f), encoding="utf-8").read())
            _n30 = _local_washers30(_code)
            if _n30:
                _local30.append("%s（%d 处）" % (_f, _n30))
        check(not _local30,
              "`tools/*.py` 里没有局部的洗注释实现（有就收口到 `tools/wash.py`）—— 另有 %d 个：%s"
              % (len(_local30), "、".join(_local30) or "无"))
    finally:
        if os.path.isdir(_sb30):
            shutil.rmtree(_sb30, ignore_errors=True)

    print("\n[31] `review-cards.py --check`：生成物新鲜度（不写盘 + 过期必须报红）（Q97）")
    # 为什么要有这一节（2026-10-13 第 60 轮，Q97）：
    #   `docs/卡片评审.html` 是**生成物**，改过数据 / 形态 / 配色而忘了重跑，
    #   页面上的数与盘上的卡就分家 —— 而此前它**连干跑模式都没有**（同族 `balance.js --check`
    #   早有、`gen-collect-time.js` 本轮补上），「谁该有干跑」这件事本身没有网。
    #   这一节是**行为**判据：真 import、真调 `main()`、真比对——
    #     (a) 新鲜：退出 0 且 stdout 里明说「一致」；
    #     (b) 过期：把 `--out` 指到一份被手改过的副本 ⇒ 退出 1（**不写盘**）；
    #     (c) `--check --serve` 一起给 ⇒ 用法错（退出码 2），不许静默丢掉一个（口径同 §32-p）。
    #   ⚠️ `--check` 的比对**必须先归一化换行**：本仓 `core.autocrlf=true`（Windows 签出写 CRLF、
    #      本工具写 LF）⇒ 直接逐字节比会**每次都假红**（实测差 4032 字符 = 行数）。
    #      所以 (b) 的注入只加一个**尾巴标记**，不动换行 —— 那样判红才不是被换行差异喂出来的。
    _RR2 = os.path.join(TOOLS, "review-cards.py")
    if os.path.exists(_RR2):
        _spec31 = importlib.util.spec_from_file_location("review_cards_check", _RR2)
        _RC = importlib.util.module_from_spec(_spec31)
        _spec31.loader.exec_module(_RC)

        def _rc_run(*argv):
            """真调 `main()`，argv **逐字给全**（含工具名）。

            ⚠️ 为什么每次调用都把 `"review-cards.py", "--check"` 写在**同一行**：
               `verify [14-c](c)` 要能证明「这个开关真的有人在跑」——它按**代码面**的
               「工具名 + 开关名相邻」判，所以这里的写法是**契约的一部分**，不是排版偏好。
               （第一版判据写宽了：只要全文件里各出现一次就算过 ⇒ 把调用注释掉也照样绿，
                反向验证当场逮到。）"""
            _old31 = sys.argv
            _buf31 = io.StringIO()
            sys.argv = list(argv)
            try:
                with contextlib.redirect_stdout(_buf31), contextlib.redirect_stderr(_buf31):
                    _rc31 = _RC.main()
            except SystemExit as _e31:
                _rc31 = _e31.code if isinstance(_e31.code, int) else 2
            finally:
                sys.argv = _old31
            return _rc31, _buf31.getvalue()

        _sb31 = os.path.join(ROOT, "_tmp", "rv-check-sandbox")
        try:
            if not os.path.isdir(_sb31):
                os.makedirs(_sb31)
            _rc, _out = _rc_run("review-cards.py", "--check")
            check(_rc == 0 and "一致" in _out,
                  "新鲜：`--check` 退出 0 且报告与实跑结论一致（实得 rc=%d）" % _rc)
            # (b) 过期：把生成物**手改一下**（只加尾巴、不动换行）再指过去 ⇒ 必须报红
            _stale31 = os.path.join(_sb31, "stale.html")
            _fresh31 = os.path.join(_sb31, "fresh.html")
            with io.open(_fresh31, "w", encoding="utf-8", newline="\n") as _f31:
                _f31.write(_RC.build_page(None)[0])
            with io.open(_stale31, "w", encoding="utf-8", newline="\n") as _f31:
                _f31.write(_RC.build_page(None)[0] + "\n<!-- 手改过 -->\n")
            _rc, _out = _rc_run("review-cards.py", "--check", "--out", _fresh31)
            check(_rc == 0, "对照：`--check` 指向一份**同内容**的副本时退出 0（实得 rc=%d）" % _rc)
            _rc, _out = _rc_run("review-cards.py", "--check", "--out", _stale31)
            check(_rc == 1 and "过期" in _out,
                  "过期：`--check` 指向一份被手改过的副本时**退出 1** 且明说「已过期」"
                  "（实得 rc=%d）—— 只加了一个尾巴标记、没动换行，所以这一条不是被换行差异喂出来的" % _rc)
            check(not os.path.exists(os.path.join(_sb31, "stale.html.bak")),
                  "`--check` 一个字节都不写（连备份都不留）")
            _rc, _out = _rc_run("review-cards.py", "--check", "--serve")
            check(_rc == 2 and "不能同时用" in _out,
                  "`--check --serve` 一起给 = 用法错、退出码 2（不许静默丢掉一个；口径同 §32-p）"
                  "（实得 rc=%d）" % _rc)
        finally:
            shutil.rmtree(_sb31, ignore_errors=True)

    print("\n[32] `docs/` 生成物的干跑闸门：`gen-captions.py --dry` / `refresh-captions.py --check` / `gen-art.py --check` 真跑（Q101 / 第 62 轮）")
    # 🔴 由头（第 61 轮 Q101）：`verify [14-c](b)` 的扫描面此前只认「`--out` 默认落在 docs/」
    #    ⇒ 用**常量**写 docs/ 的两个工具（`gen-captions.py` / `refresh-captions.py`）在网外，
    #    它们的干跑开关**没有任何常跑门禁真跑过** —— 而 `gen-captions.py --dry` 当时
    #    **恒退 0**（无参 `return`），就算跑也判不出过期（天生的假绿，已修）。
    #    这一节把两者接进常跑门禁：**退出码 0 + 明说「一致」+ 一个字节都不写**。
    #    ⚠️ 过期那一路（把盘上那份改坏 ⇒ 必须退 1）本轮已手工实跑验证过（rc 0→改坏→rc 1→还原）；
    #       这里**不**在常跑门禁里改被追踪的文件 —— 一旦中途崩掉就会把仓库留成脏的。
    def _run_py32(_name, *a):
        return subprocess.run([sys.executable, os.path.join(TOOLS, _name)] + list(a),
                              capture_output=True, text=True, errors="replace", cwd=ROOT)

    def _md5_32(_p):
        with io.open(_p, "rb") as _fh:
            return hashlib.md5(_fh.read()).hexdigest()

    _docs32 = [
        ("gen-captions.py", "--dry", os.path.join(ROOT, "docs", "图鉴文案.md")),
        ("refresh-captions.py", "--check", os.path.join(ROOT, "docs", "图鉴文案-手写.md")),
        # 🔴 第 62 轮：`gen-art.py` 的 `--check`（还清了 `[14-c]` 的那条文件级豁免）。
        #    ⚠️ 默认集合只含两份**确定性**产物（形态档案 / 提示词表）—— `docs/生图清单.md`
        #    是状态快照（勾选按磁盘现算、耗时按 manifest 实测中位现算），出图跑一批它就变，
        #    绑进常跑门禁 = 每批图红一次（假红）⇒ 要单独比它得 `--check --plan`。
        ("gen-art.py", "--check", os.path.join(ROOT, "docs", "鱼形态档案.md")),
    ]
    for _name, _flag, _doc in _docs32:
        if not os.path.exists(_doc):
            check(False, "`%s` 的产物 `%s` 不在盘上 —— 这一节抓不到要判的东西"
                  % (_name, os.path.relpath(_doc, ROOT)))
            continue
        _m0 = _md5_32(_doc)
        _r = _run_py32(_name, _flag)
        _txt = (_r.stdout or "") + (_r.stderr or "")
        check(_r.returncode == 0 and "一致" in _txt,
              "`%s %s` 退出 0 且报告「一致」（实得 rc=%d）—— 它就是 `docs/` 生成物的新鲜度闸门"
              % (_name, _flag, _r.returncode))
        check(_md5_32(_doc) == _m0,
              "`%s %s` 一个字节都不写（`%s` 逐字节未变）"
              % (_name, _flag, os.path.basename(_doc)))

    print("\n" + "=" * 52)
    if fails:
        print("\u2716 未通过：%d 项\n" % len(fails))
        for f in fails:
            print("   - " + f)
        sys.exit(1)
    print("\u2714 全部通过\n")


if __name__ == "__main__":
    main()
