# -*- coding: utf-8 -*-
"""tools/refresh-captions.py — 按当前数据**重算** `docs/图鉴文案-手写.md` 的每一条标题行。

为什么需要它（Q47，2026-10-11）：
  这份文档 362 条的标题行长这样 ——
      `## 12 · C24 溪灵·金线鲃（湖心半岛 · 1.2 kg · 480 金）`
  其中**钓场 / 最小体重 / 价格 / 名字**四样全部是 `fields.js` + `fish.js` 的**现算值**，
  而不是手写的。手感判定由 `verify §33-g` 盯着（表头三个数与现算不符就报红）——
  但门禁只会**告诉你它红了**，不会替你改。以前改它靠 `_tmp/merge_captions.py`
  （合并 4 份分卷那次的一次性脚本，**分卷与那个脚本都没入库**）⇒ 谁碰上门禁红谁就得现写一遍。
  本文件就是那个「现写一遍」的成品，**只做表头**：
    · 标题行按当前 `fish.js` / `fields.js` 重算（名字也换 —— 物种换过名字的条目靠它跟上）；
    · **正文一个字都不动**（`## ` 行以下到下一个 `## ` 之前的全部内容原样保留）；
    · 文末「待重写清单」原样保留（那是进度记录，不是算出来的）。
  ⇒ `_tmp/merge_captions.py` 与 `_tmp/patch_captions.py` **已退役**（前者要的 4 份分卷
     已合并且不在仓库里，后者要的 `_tmp/cap_batchN.py` 是逐批一次性数据）。

用法：
    python tools/refresh-captions.py --check    # 只报告有多少条标题行过期（不改文件）
    python tools/refresh-captions.py           # 真写回（同样会打印改了几条）
退出码：`--check` 发现过期时退 1（可以挂进脚本里当判据），无过期 / 已写回退 0。
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DOC = os.path.join(ROOT, 'docs', '图鉴文案-手写.md')

# 与 `merge_captions.py` / `verify §33-g` 同一份形态：`## <序号> · <id> <名字>（钓场 · 体重 · 价格 金）`
HEAD = re.compile(r"^##\s+(\d+)\s*·\s*([A-Z]{1,3}\d{2,3})\s+(\S+?)\s*（([^）]*)）\s*$")


def load_data():
    js = ("global.window=global;require('./src/data/config.js');require('./src/data/fields.js');"
          "require('./src/data/fish.js');console.log(JSON.stringify({fish:global.G.FISH,fields:global.G.FIELDS}));")
    r = subprocess.run(["node", "-e", js], capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        sys.exit('[!] 读不到数据（node 失败）：\n' + (r.stderr or '')[-400:])
    d = json.loads(r.stdout)
    return {f['id']: f for f in d['fish']}, {f['id']: f['name'] for f in d['fields']}


def kg(w):
    """最小体重的**可读**写法（与游戏内 `U.kg()` 不是同一个口径，见文件头）。

    口径：<1kg 用 g、<1 吨用 kg、再往上用 吨 / 万吨 / 亿吨 / 万亿吨 ——
    巨型鱼的最小体重到 1e18 kg，用 kg 写出来是一串 19 位数字。"""
    if w < 1:
        return "%.0f g" % (w * 1000)
    if w < 1000:
        return ("%.2f" % w).rstrip("0").rstrip(".") + " kg"
    t = w / 1000.0
    for div, unit in ((1e12, "万亿吨"), (1e8, "亿吨"), (1e4, "万吨"), (1, "吨")):
        if t >= div:
            v = t / div
            return (("%.2f" % v).rstrip("0").rstrip(".")) + " " + unit
    return "%.0f 吨" % t


def want_head(no, fid, fish, fname):
    return "## %d · %s %s（%s · %s · %s 金）" % (
        no, fid, fish["name"], fname.get(fish["field"], fish["field"]),
        kg(fish["minKg"]), fish["price"])


def main():
    ap = argparse.ArgumentParser(description='重算 docs/图鉴文案-手写.md 的标题行')
    ap.add_argument('--check', action='store_true', help='只报告过期条数，不写文件')
    args = ap.parse_args()

    cur, fname = load_data()
    lines = io.open(DOC, encoding='utf-8').read().split('\n')
    changed, unknown = 0, []
    for i, ln in enumerate(lines):
        m = HEAD.match(ln.strip())
        if not m:
            continue
        no, fid = int(m.group(1)), m.group(2)
        fish = cur.get(fid)
        if not fish:                       # fish.js 里没有这个 id ⇒ 那是真问题，别静默跳过
            unknown.append('%d 行：%s' % (i + 1, fid))
            continue
        w = want_head(no, fid, fish, fname)
        if w != ln.strip():
            changed += 1
            if args.check and changed <= 5:
                print('  · 第 %d 行：\n      现在是 %s\n      应为   %s' % (i + 1, ln.strip(), w))
            elif not args.check:
                lines[i] = w

    if unknown:
        sys.exit('[!] 文档里有 fish.js 不存在的 id，先修数据或文档：\n    ' + '\n    '.join(unknown))
    if args.check:
        if changed:
            print('\n[!] %d 条标题行已过期（门禁 §33-g 也会报红）—— 跑 `python tools/refresh-captions.py` 写回'
                  % changed)
            return 1
        print('✔ 362 条标题行都与当前 fish.js / fields.js 一致（正文未动）')
        return 0
    if changed:
        io.open(DOC, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
    print('已写回 %s：标题行改了 %d 条（正文与文末清单一个字未动）' % (os.path.relpath(DOC, ROOT), changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
