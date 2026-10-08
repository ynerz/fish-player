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

    print("\n" + "=" * 52)
    if fails:
        print("\u2716 未通过：%d 项\n" % len(fails))
        for f in fails:
            print("   - " + f)
        sys.exit(1)
    print("\u2714 全部通过\n")


if __name__ == "__main__":
    main()
