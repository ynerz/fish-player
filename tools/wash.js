/* =========================================================
   tools/wash.js  —  洗注释：**唯一一处实现**（Q83 / Q91 / Q94）
   =========================================================
   为什么要有这个文件（2026-10-12 第 59 轮 Q94 实测）：
   `tools/` 的判据要扫源码，而扫之前必须先**把注释剥掉**（硬规矩 ①：只扫代码不扫注释），
   否则「注释里提一句」就会喂饱判据（假绿）/ 误伤（假红）。这件事在 `tools/verify.js`
   里被抄了 **三十几份**，而且**四种口径**并存：

     · 只剥**整行**注释（行首空白 + 双斜杠）⇒ **行尾注释**留在文本里当代码用；
     · `//` 起到行尾的**裸正则**（**不看引号**）⇒ 会把 `'http://x'` 从中间撕成两半；
     · 不看引号但只在「空白后跟 `//`」时剥 ⇒ 仍在 `'a // b'` 这类字符串上出错；
     · 按 `.py` 的 `#` 剥 —— 拿它洗 `.js` 等于没洗（第 57 轮 §53 就是这么栽的，
       当时只是**靠巧合**没错报）。

   口径要改就得改三十几处、漏一处就分家 —— 这正是本项目反复栽的「同一事实写 N 遍」。
   ⇒ 三个**按语言分派**的顶层入口（Q91 定下的口径）+ 一个按扩展名的分派器：

     · `stripComments(t)` —— **JS**：`//`（整行 + 行尾）与块注释；引号里的不动（`'http://…'`）。
     · `stripPy(t)`       —— **Python**：`#`（整行 + 行尾）+ 三引号 docstring；引号里的 `#` 不动。
     · `stripMarkup(t)`   —— **HTML / CSS**（含页内 JS）：HTML 注释 + 块注释 + 行内 `//`，
                             且 `//` 必须**放过 `://`**（`url(https://…)` 不能被切成半句）。
     · `blankStrings(t)`  —— 再把字符串字面量的内容清空（位置不打乱），与洗注释两步分开：
                             绝大多数判据只需要前者，剥字符串会误伤「本来就盯字符串」的判据。
     · `wash(rel, raw)`   —— **按文件扩展名选**上面三个之一（调用方连扩展名都不用自己判）。

   ⚠️ 为什么 `wash()` 值得单独存在：扫描面跨语言是常态（`src/*.js` + `tools/*.py` + `*.html`），
      「一律喂 `stripPy()`」与「一律喂 `stripComments()`」都是错的，而错了**不报错** ——
      只表现为判据多留一片文本（假绿）或把 URL 撕开（假红）。分派器只有这一处，改口径改这里。

   ⚠️ 已知窄口（照实写，不假装没有）：`stripComments()` 逐字符扫引号态，但**正则字面量里的引号**
      （本仓 `panels.js` 有一处 `/"/g`）会让扫描器提前进入「字符串态」⇒ 该行余下的 `//` 不被剥。
      方向是**多留文本**（可能假红），不会假绿；要收口得引 JS 词法器，暂时不做。

   门禁：`tools/verify.js [32-w]` —— ① 定义只许在本文件（其他地方只许写
   `const X = stripComments;` 这种**别名**）；② 三个入口必须真的是函数且行为都对；
   ③ 抓不到就报错。
   ========================================================= */
'use strict';

/* ---------- ① JS ---------- */
function stripComments(t) {
  const NL = String.fromCharCode(10);
  return String(t).replace(/\/\*[\s\S]*?\*\//g, '').split(NL).map(line => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q && line[i - 1] !== '\\') q = null; }
      else if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join(NL);
}

/* ---------- ② 字符串内容清空（与洗注释两步分开，见文件头） ---------- */
function blankStrings(t) {
  const NL = String.fromCharCode(10);
  return String(t).split(NL).map(line => {
    let q = null, out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q && line[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; out += ' '; continue; }
      out += c;
    }
    return out;
  }).join(NL);
}

/* ---------- ③ HTML / CSS（含页内 JS） ---------- */
function stripMarkup(t) {
  return String(t)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---------- ④ Python ---------- */
function stripPy(t) {
  const NL = String.fromCharCode(10);
  return String(t).replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''")
    .replace(/(^|[\r\n])[ \t]*#[^\n]*/g, '$1')
    .split(NL).map(line => {
      /* 行尾注释也要剥：`x = 1  # args.foo` 能喂饱子串判据 */
      let q = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === q && line[i - 1] !== '\\') q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '#') return line.slice(0, i);
      }
      return line;
    }).join(NL);
}

/* ---------- 按扩展名分派（唯一一处） ----------
   `.py` → py 的 `#`；`.html` / `.htm` / `.css` → markup 口径；
   其余（`.js` / `.cmd` / 无扩展名）→ js 口径。
   ⚠️ `.cmd` 走 js 口径：它是批处理，`::` 与 `rem` 是注释 —— 本轮**有意不动**它
      （本轮没有 .cmd 的洗注释需求；真要收口得先量清 ANSI 形态，别顺手加）。 */
function wash(rel, raw) {
  if (/\.py$/.test(rel)) return stripPy(raw);
  if (/\.(html?|css)$/.test(rel)) return stripMarkup(raw);
  return stripComments(raw);
}

module.exports = { stripComments: stripComments, blankStrings: blankStrings,
  stripPy: stripPy, stripMarkup: stripMarkup, wash: wash };
