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
import importlib.util
import io
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = os.path.join(ROOT, "_tmp")

fails = []


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
        bad_cmd = os.path.join(TMP, "dry-run-bad.cmd")
        io.open(bad_cmd, "w", encoding="ascii", newline="").write(bad_body)
        before2 = set(os.listdir(ROOT))
        try:
            subprocess.run(["cmd", "/c", bad_cmd], capture_output=True, text=True,
                           errors="replace", cwd=ROOT, timeout=60)
        except subprocess.TimeoutExpired:
            pass
        added2 = sorted(set(os.listdir(ROOT)) - before2)
        check(bool(added2), "判据自检：改回 `->` 的写法**确实**会在仓库根写出文件（%r）"
                            "—— 这正是要拦的那个 bug" % (added2[:3] or "居然没写出来"))
        for junk in added2:                      # 自检产物当场清掉
            try:
                os.remove(os.path.join(ROOT, junk))
            except OSError:
                pass

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

    print("\n" + "=" * 52)
    if fails:
        print("\u2716 未通过：%d 项\n" % len(fails))
        for f in fails:
            print("   - " + f)
        sys.exit(1)
    print("\u2714 全部通过\n")


if __name__ == "__main__":
    main()
