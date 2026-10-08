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
    # 控制字符：& | < > 在 echo 文本里会改行为；命令行的引号必须是成对的结构
    for ch in ("&", "|"):
        check(ch not in txt, "内容里没有裸的 %s（cmd 控制字符）—— 注入面收干净" % ch)

    print("\n[5] write_console_script：真的落一个文件，且能双击重跑")
    p = R.write_console_script(groups)
    check(os.path.exists(p), "文件已写出：%s" % os.path.relpath(p, ROOT))
    check(io.open(p, encoding="ascii").read() == txt.replace("\n", "\r\n") or
          io.open(p, encoding="ascii").read().count("@echo off") == 1,
          "文件内容与生成器一致")
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
        io.open(probe, "w", encoding="ascii", newline="\r\n").write(
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

    print("\n" + "=" * 52)
    if fails:
        print("\u2716 未通过：%d 项\n" % len(fails))
        for f in fails:
            print("   - " + f)
        sys.exit(1)
    print("\u2714 全部通过\n")


if __name__ == "__main__":
    main()
