# -*- coding: utf-8 -*-
"""check-fishdata-drift.py — 改了**鱼表数据**（名字 / 体型 / 形态描述）之后，确认「只有该变的变了」。

用法： python tools/check-fishdata-drift.py [rev]      # 默认 HEAD~1

🔴 为什么不能用 `tools/check-prompt-drift.py`：它把**当前**的鱼表喂给新旧两个模块
   （`prompts_of(mod, fish)`）⇒ 「改鱼名 / 改体型 / 改 form」这类**数据侧**的改动它一条都测不出来
   （那是它的设计：它只管 `gen-art.py` 的**代码**口径漂移）。本轮换的恰恰是数据，得自己对。

⚠️ 这个工具 2026-10-10 当场抓到过 3 条「看着换了、其实提示词一字未动」的鱼
   （`SSS87 / SSS91 / SSS97`）—— 它们**同 seed 同提示词 = 同一张图**，重出等于白跑。
   逐鱼逐档对拍是唯一能发现这件事的方式。

对拍：改动前（rev 的 fish.js + fish-traits.json + gen-art.py）vs 现在，逐鱼逐档比提示词。

为什么不能直接用 tools/check-prompt-drift.py：它把**当前**的鱼表喂给新旧两个模块
（`prompts_of(mod, fish)`），于是「改鱼名 / 改体型」这类**数据侧**的改动它一条都测不出来
—— 那是它的设计（它只管 gen-art.py 的代码口径漂移）。本轮换的恰恰是数据 ⇒ 得自己对。
"""
import io, os, json, subprocess, importlib.util, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)

NODE = r"C:/Users/15001/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
REV = (sys.argv[1] if len(sys.argv) > 1 else "HEAD~1")


def git_show(rel):
    r = subprocess.run(["git", "show", "%s:%s" % (REV, rel)], capture_output=True, text=True,
                       errors="replace", cwd=".")
    assert r.returncode == 0, (rel, r.stderr[:200])
    return r.stdout

# ① 旧 fish.js → node 求值成 JSON（不换磁盘上的文件）
old_fish_js = git_show("src/data/fish.js")
io.open(os.path.join("_tmp", "old-fish.js"), "w", encoding="utf-8", newline="\n").write(old_fish_js)
r = subprocess.run([NODE, "-e",
    "global.window={};global.G={};"
    "new Function(require('fs').readFileSync('_tmp/old-fish.js','utf8')).call(global);"
    "console.log(JSON.stringify(global.G.FISH));"],
    capture_output=True, text=True, errors="replace", cwd=".")
assert r.returncode == 0, r.stderr[:300]
OLD_FISH = json.loads(r.stdout.strip().splitlines()[-1])

# ② 旧 gen-art.py → 放到 tools/ 下（ROOT 靠 __file__ 定位），并覆写它的 TRAITS
io.open("tools/_drift_old.py", "w", encoding="utf-8", newline="\n").write(git_show("tools/gen-art.py"))
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
OLD = load(os.path.join("tools", "_drift_old.py"), "mod_old")
NEW = load(os.path.join("tools", "gen-art.py"), "mod_new")
NEW_FISH = NEW.load_fish()
OLD_TRAITS = json.loads(git_show("tools/fish-traits.json"))
OLD.TRAITS.clear(); OLD.TRAITS.update(OLD_TRAITS)      # 关键：旧模块也要用**旧的** traits

# ③ 逐鱼逐档比
SLOTS = ["master", "bright", "albino", "golden", "shiny"]
def prompts_of(mod, fish):
    out = {k: {} for k in SLOTS}
    for f in fish:
        out["master"][f["id"]] = mod.build_prompt(f)
        for k in ("bright", "albino", "golden", "shiny"):
            desc = mod.morph_pick(f["id"], k, f.get("rar"))[2]
            out[k][f["id"]] = mod.build_morph_prompt(f, k, desc)
    return out

NEW_FISH_BY_ID = {f["id"]: f for f in NEW_FISH}
a = prompts_of(NEW, NEW_FISH)
b = prompts_of(OLD, OLD_FISH)
changed_any, per_slot = set(), {}
for s in SLOTS:
    ids = sorted(k for k in a[s] if a[s][k] != b[s].get(k))
    per_slot[s] = ids
    changed_any |= set(ids)

print("改动前后逐鱼逐档对拍（362 条 × 5 档 = 1810 个提示词）")
for s in SLOTS:
    print("  %-7s 变了 %3d 条" % (s, len(per_slot[s])))
print()
print("  变了提示词的鱼（去重）= %d 条" % len(changed_any))

print()
print("  ✅ 没被波及的鱼 = %d 条" % (362 - len(changed_any)))
print("  变了名字的鱼里，新名字**没**进提示词的：%s" % (
    [i for i in sorted(changed_any)
     if NEW_FISH_BY_ID[i]["name"] not in a["master"][i]] or "（无）"))
print()
print("  ⚠️ 判据：**要重出**的鱼必须出现在上面那张变化清单里 —— "
      "同 seed 同提示词 = 同一张图，没变的鱼重出等于白跑。")
os.remove(os.path.join("tools", "_drift_old.py"))
