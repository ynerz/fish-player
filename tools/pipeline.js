/* =========================================================
   tools/pipeline.js  —  数值链的「下一步」唯一出口
   =========================================================
   顺序表本身在 `tools/pipeline.json`（**数据，不是逻辑** —— 所以 py 侧的
   `gen-fish.py` 也能直接 `json.load` 它，不会出现「一份真相两种写法」）。
   本文件只负责把它变成**给人看的那一行**：`下一步： <cmd>  &&  <cmd>`。

   为什么要收口（2026-10-12 第 54 轮实测）：
   这条链四个写盘工具各自在收尾时说「下一步」，写法与覆盖面各不相同 ——
   `fix-rarity-price.js` 只写 `balance.js && verify.js`（**漏了链条最后一环
   `gen-collect-time.js`**，而它才是刷新《收集耗时表》的那个），
   `solve-drop.js` 只写「复核：balance.js」（**漏了 `fix-rarity-price.js`**），
   `gen-fish.py` 真跑时一个字都不提。照这些提示做完，`docs/收集耗时表.html`
   就与数据分家 —— 而**没有任何门禁会报红**（本项目最高频的坑型：不报错但静默失效）。
   ⇒ 现在：顺序只在 JSON 里写一次，打印走 `nextLine()`，`verify §32-t` 逐条核对
   「打印出来的命令集合 == JSON 里的 next 集合」（双向）。
   ========================================================= */
const RAW = require('./pipeline.json');

/** 收尾提示的统一前缀（也只在 JSON 里写一次 —— 判据从它现算，不许在工具里手抄） */
const NEXT_PREFIX = RAW.nextPrefix;
/** 各步之间的连接符（照抄到命令行里能直接跑） */
const JOIN = '  &&  ';

/** @returns {{tool:string,next:string[]}|null} 找不到就返回 null（调用方自己决定怎么报） */
function stepOf(tool) {
  return RAW.steps.filter(s => s.tool === tool)[0] || null;
}

/**
 * 收尾那一行的正文（不含换行）。**没有下游**（链条的叶子）时返回 null ——
 * 调用方据此不打这一行（打一句「下一步：」后面空着，比不打更让人困惑）。
 */
function nextLine(tool) {
  const s = stepOf(tool);
  if (!s || !s.next.length) return null;
  return NEXT_PREFIX + ' ' + s.next.join(JOIN);
}

module.exports = { NEXT_PREFIX, JOIN, nextLine, stepOf, RAW };
