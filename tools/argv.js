/* =========================================================
   tools/argv.js  —  tools/*.js 的命令行契约（**唯一一处实现**）
   =========================================================
   为什么要有这个文件（2026-10-12 第 54 轮实测）：
   `tools/` 里的 js 工具是**手写** argv 解析（`tools/*.py` 那边走 argparse，天然有校验），
   而手写的那一套有一整类**不报错、退出码 0** 的坏法 —— 与 py 侧的「开关组合语义」（§32-p）
   完全同族，只是这一侧此前一张网都没有：

     ① `node tools/build.js --out --release`
        ⇒ 把 `--release` 当成了 `--out` 的**值** ⇒ **真写出一个名为 `--release` 的文件**
          （实测 944 KB）、退出码 0、报告还写着「构建通过」。
     ② `node tools/build.js --out`（漏了值）
        ⇒ 静默落回默认路径 `dist/fish-player.html`：用户以为另存了，其实没有。
     ③ `node tools/build.js --check --out x.html`
        ⇒ `--out` 被静默丢掉（`--check` 从不写盘）：退出码 0、一行提示都没有。
     ④ `node tools/balance.js --emit --check`
        ⇒ `--check` 优先，`--emit` 被静默吃掉（不会写 `docs/balance-figures.js`），退出码 0。
     ⑤ `node tools/browser-probe.js --zzz --wait 500`
        ⇒ 未知开关被 `pos.push()` 收成**位置参数**，于是 `--zzz` 变成了要打开的 URL：
          报「Cannot navigate to invalid URL」（报的是**后面**的错，指不到真原因）。

   三条判据因此收在这里，一处实现、五个工具共用：
     · `checkKnown()`      —— 不认识的开关**报错**，不许静默当位置参数；
     · `needValue()`       —— 有值开关的值缺失 / 值写成另一个开关时**报错**；
     · `checkExclusive()`  —— 明确互斥的两个开关同给时报错（口径同 py 侧：
                              **要么报错、要么明说**，不许静默丢掉一个）；
     · `fail()`            —— 坏用法的唯一出口（**退出码 2**，与 argparse 对齐）。

   ⚠️ 「合法开关表」`KNOWN` / 互斥表 `EXCLUSIVE` 由**各工具自己声明**（它们才是各自的事实），
      本文件只负责判定与报错 —— 这样 `verify §32-s` 才能把「声明的表」与
      「文件里真正比对的开关」**双向**对拍（多一个 = 零消费登记，少一个 = 真比对却没登记）。
   ========================================================= */

/** 坏用法的统一退出码（与 `argparse` 的 `error()` 一致：2 = 命令行用法错，不是运行失败） */
const EXIT_BAD_USAGE = 2;

/** 坏用法的**唯一出口**：打印 → 退出码 2。（`§32-s(a)` 盯着 tools/ 里 `process.exit(2)` 只许这里一处） */
function fail(tool, msg) {
  console.error('\n\u2716 ' + tool + '：' + msg + '\n');
  process.exit(EXIT_BAD_USAGE);
}

/**
 * 不认识的开关一律报错 —— **不许静默当成位置参数**（工具的位置参数是 url / 路径，
 * 一个多出来的 `--zzz` 会让整串位置参数整体串位，报出来的错还指不到原因）。
 * @returns {string[]} 本次命令行里**出现过**的合法开关（供 checkExclusive 用）
 */
function checkKnown(argv, known, tool) {
  if (!Array.isArray(known) || known.length === 0) fail(tool, '内部错误：合法开关表是空的');
  const bad = argv.filter(t => typeof t === 'string' && t.length > 1 && t.charAt(0) === '-' && known.indexOf(t) < 0);
  if (bad.length) {
    fail(tool, '不认识的开关：' + bad.join(' ') + '（合法开关：' + known.join(' ') + '）');
  }
  return known.filter(k => argv.indexOf(k) >= 0);
}

/**
 * 有值开关取值：`needValue(argv, i, '--out', 'build.js')`。
 * 两种情况都报错：① 后面没有 token；② 后面那个 token 又以 `-` 开头（多半是漏了值、
 * 把另一个开关写在了值的位置 —— 实测就是它写出了一个叫 `--release` 的文件）。
 */
function needValue(argv, i, flag, tool) {
  const v = argv[i + 1];
  if (v === undefined || v === '') fail(tool, flag + ' 后面缺一个值');
  if (v.charAt(0) === '-') fail(tool, flag + ' 的值是 ' + v + ' —— 看起来是另一个开关，多半是漏了值');
  return v;
}

/**
 * 明确互斥的开关同给就报错。`pairs` 形如 `[['--check', '--out', '为什么互斥']]`。
 * ⚠️ 口径（同 py 侧 §32-p）：**要么报错、要么在 help 里明说**；静默丢掉一个是最坏的一种，
 *    因为它退出码 0、玩家以为两个都生效了。
 */
function checkExclusive(seen, pairs, tool) {
  if (!Array.isArray(pairs)) fail(tool, '内部错误：互斥表不是数组');
  pairs.forEach(p => {
    if (!p || p.length < 2) fail(tool, '内部错误：互斥表里有一项不是开关对');
    if (seen.indexOf(p[0]) >= 0 && seen.indexOf(p[1]) >= 0) {
      fail(tool, p[0] + ' 与 ' + p[1] + ' 不能同时用：' + (p[2] || '二选一'));
    }
  });
  return seen;
}

module.exports = { fail, checkKnown, needValue, checkExclusive, EXIT_BAD_USAGE };
