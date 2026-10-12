# -*- coding: utf-8 -*-
"""tools/wash.py —— 洗注释：**python 侧的唯一一处实现**（第 59 轮 Q95）

为什么有这个文件（**实测出来的洞，不是洁癖**）
------------------------------------------------
`tools/` 的 python 工具也要「读源码文本再正则抽值」（抽 `fish.js` 的鱼表、
抽 `config.js` 的体型中文表、抽 `fields.js` 的钓场表、抽 `fishart.js` 的模板键…）。
**读之前必须先把注释剥掉** —— 否则注释里的文字会被当成真数据。第 59 轮真跑过：

    · 往 `src/data/fish.js` 的**注释**里写一行 `// F('A99', '假鱼', 3, 'fish', '#123456')`
      ⇒ `review-cards.load_fish()` 从 **362 条** 变成 **363 条**，`A99` 真的进了评审台。
    · `measure-palette-facets.py` 也从 `fish.js` 里正则取色值统计色相 ⇒ 注释里的色值
      会进直方图（「先量后改」的标尺被注释污染）。

这与 JS 侧（`tools/wash.js` Q83/Q88/Q91/Q94）是**同一条纪律的两半**：
JS 侧那份被 `verify [32-w]` 盯着，py 侧此前**一处都没有**，而且已经有三处各写一份、
口径还不一样（`test-review-cards.py` 里：一份只剥整行 `#`、两份用 `#[^\\n]*` 的**裸正则**
—— 不看引号，会把 `'#a87a1f'` 这类字符串从中间撕开）。

口径（与 `tools/wash.js` **逐字符等价**，跨语言对拍见 `test-review-cards.py [30]`）
------------------------------------------------
  · `strip_py(text)`     —— py 的 `#`（整行 + 行尾）+ 三引号 docstring；引号里的 `#` 不动
  · `strip_js(text)`     —— js 的 `//` + 块注释；引号里的 `//` 不动（`'http://x'`）
  · `strip_markup(text)` —— html 注释 + 块注释 + 行内 `//`，且 `//` 必须放过 `://`
  · `wash(rel, text)`    —— **按扩展名分派**上面三个（`.py` / `.html|.htm|.css` / 其余）

⚠️ 为什么 python 侧不能复用 `tools/wash.js`：这两个宿主语言不同（py 工具不可能 require
   一个 JS 模块）。所以这是**有意保留的第二份实现**，防线不是「只许有一份」而是
   **跨语言对拍**：`test-review-cards.py [30]` 拿同一批真文件分别喂两份实现，
   断言输出**逐字节相同**（漂开就报红）。这与 `assets.js:TIER_SUB` ↔ `prep-cards.py`
   那处跨语言真相是同一套办法（`verify ㊼`）。

⚠️ 已知窄口（与 JS 侧**同一个**，因为算法是照它移植的）：正则字面量里的引号
   （本仓 `panels.js` 有一处 `/"/g`）会让扫描器提前进入「字符串态」⇒ 该行余下的 `//`
   不被剥。方向是**多留文本**（可能假红），不会假绿；要收口得引 JS 词法器，两边一起做。
"""

import os
import re

__all__ = ["strip_py", "strip_js", "strip_markup", "wash", "read_washed"]


def strip_py(text):
    """py 的注释：三引号 docstring → 空串；整行 `#` 与行尾 `#` 都剥（引号态感知）。"""
    t = re.sub(r'"""[\s\S]*?"""', '""', text)
    t = re.sub(r"'''[\s\S]*?'''", "''", t)
    t = re.sub(r"(^|[\r\n])[ \t]*#[^\n]*", r"\1", t)
    out = []
    for line in t.split("\n"):
        q = None
        cut = None
        for i, c in enumerate(line):
            if q:
                if c == q and (i == 0 or line[i - 1] != "\\"):
                    q = None
            elif c == '"' or c == "'":
                q = c
            elif c == "#":
                cut = i
                break
        out.append(line if cut is None else line[:cut])
    return "\n".join(out)


def strip_js(text):
    """js 的注释：块注释 + `//`（整行 / 行尾都剥）；引号里的 `//` 不动。"""
    t = re.sub(r"/\*[\s\S]*?\*/", "", text)
    out = []
    for line in t.split("\n"):
        q = None
        cut = None
        for i, c in enumerate(line):
            if q:
                if c == q and (i == 0 or line[i - 1] != "\\"):
                    q = None
            elif c == '"' or c == "'" or c == "`":
                q = c
            elif c == "/" and i + 1 < len(line) and line[i + 1] == "/":
                cut = i
                break
        out.append(line if cut is None else line[:cut])
    return "\n".join(out)


def strip_markup(text):
    """html / css（含页内 js）：HTML 注释 + 块注释 + 行内 `//`，且 `//` 放过 `://`。"""
    t = re.sub(r"<!--[\s\S]*?-->", "", text)
    t = re.sub(r"/\*[\s\S]*?\*/", "", t)
    t = re.sub(r"(^|[^:])//[^\n]*", r"\1", t)
    return t


def wash(rel, text):
    """按文件扩展名分派（唯一一处）：`.py` → py 的 `#`；`.html|.htm|.css` → markup；其余 js。"""
    if rel.endswith(".py"):
        return strip_py(text)
    if re.search(r"\.(html?|css)$", rel):
        return strip_markup(text)
    return strip_js(text)


def read_washed(path, rel=None):
    """读一个源码文件并**先洗注释**（按扩展名分派口径）。

    `rel` 只用来分派（缺省 = 取 basename 的后缀）；`path` 是真实路径。
    ⚠️ 各工具「读源码抽值」一律走这一处 —— 「先洗再抽」这条纪律只有一份。"""
    p = str(path)
    key = rel or os.path.basename(p)
    with open(p, encoding="utf-8") as fh:
        return wash(key, fh.read())
