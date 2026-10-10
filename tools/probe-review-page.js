/* =========================================================
   tools/probe-review-page.js  —  docs/卡片评审.html 的交互复核探针
   =========================================================
   用法（交给 tools/browser-probe.js 在页面里求值）：
     # 静态打开
     node tools/browser-probe.js "file:///D:/fish%20player/docs/%E5%8D%A1%E7%89%87%E8%AF%84%E5%AE%A1.html" \
          _tmp/评审台-静态.png tools/probe-review-page.js
     # 带运行器（页面上能直接「开始重出」）
     python tools/review-cards.py --serve --port 8770
     node tools/browser-probe.js http://127.0.0.1:8770/ _tmp/评审台-运行器.png tools/probe-review-page.js

   为什么要有它：这一页是**给人手动打开**的交付物，而它静默坏过一次
   （页内 JS 的 `\n` 被 Python 提前解释掉 → 整页空白，而生成工具退出码 0）。
   `verify.js` 第 ㊴ 节现在能拦「语法坏了」，但拦不住「语法对了、点下去没反应」。
   ⇒ 真打开一次、把该点的都点一遍，才是这一页的终局判据。
   返回：各步骤的布尔结果（见下）；`node tools/browser-probe.js` 会连同
         正文长度 / 破图数 / 页面报错一起打出来。
   ========================================================= */
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var q = function (s) { return document.querySelector(s); };
  var out = {};

  /* ① 卡面渲染：每条鱼一张卡，卡里是**若干**个可评审单元（母版 + 各档**各版**；
        一档出了几版就占几槽 —— 2026-10-08 起传说闪光有第 2 版，所以这里不能写死 5） */
  var grid = q('#grid');
  out.hasGrid = !!grid;
  out.cells = grid ? grid.children.length : 0;
  var cellImgs = grid ? grid.querySelectorAll('img') : [];
  var broken = 0;
  for (var i = 0; i < cellImgs.length; i++) {
    var src = cellImgs[i].getAttribute('src') || '';
    if (src && cellImgs[i].complete && cellImgs[i].naturalWidth === 0) broken++;
  }
  out.cellImgs = cellImgs.length;
  out.brokenImgs = broken;
  out.firstCell = grid && grid.children[0]
    ? grid.children[0].innerText.replace(/\s+/g, ' ').slice(0, 80) : null;

  /* ② 点图放大到原图（#lb 层），Esc 能关 */
  if (cellImgs.length) {
    cellImgs[0].click();
    await sleep(350);
    out.lightboxOn = q('#lb').classList.contains('on');
    out.lightboxSrc = (q('#lb img') || {}).getAttribute ? q('#lb img').getAttribute('src') : null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(250);
    out.lightboxClosedByEsc = !q('#lb').classList.contains('on');
  }

  /* ③ 判「重出」：按钮亮起 + 计数增加 + 落 localStorage */
  var bad = q('#grid .b-bad');
  out.hasBadBtn = !!bad;
  if (bad) bad.click();
  await sleep(300);
  out.badBtnOn = bad ? bad.classList.contains('on') : null;
  out.markedLabel = (document.body.innerText.match(/重出\s*\d+/) || [])[0] || null;
  try {
    var raw = localStorage.getItem('fishcard-review-v2');
    out.saved = !!raw;
    out.savedIds = raw ? Object.keys(JSON.parse(raw)).length : 0;
  } catch (e) { out.saved = 'localStorage 不可用：' + e.name; }

  /* ④ 导出重出清单：对话框内容要能直接执行（含 gen-art.py --list） */
  var exp = Array.prototype.slice.call(document.querySelectorAll('button'))
    .filter(function (b) { return /导出/.test(b.textContent); })[0];
  out.hasExportBtn = !!exp;
  if (exp) exp.click();
  await sleep(400);
  var txt = (q('#out') || {}).value || '';
  out.dialogOpen = q('#dlg') ? q('#dlg').open : null;
  out.cmdHasList = /gen-art\.py --list/.test(txt);
  out.cmdHead = txt.split('\n').slice(0, 2).join(' | ');

  /* ⑤ 运行器：连上才该让点，静态打开必须置灰（防「点了没反应」）
     ⚠️ 这里**只读状态、不点这三个按钮** —— 「在窗口里开跑」会真的弹一个控制台出来。 */
  out.runText = (q('#run') || {}).textContent;
  out.runDisabled = (q('#run') || {}).disabled;
  out.runState = (q('#runState') || {}).textContent;
  out.btns = ['runWin', 'run', 'runLoop'].map(function (id) {
    var b = q('#' + id);
    return { id: id, exists: !!b, disabled: b ? b.disabled : null,
             text: b ? b.textContent : null };
  });
  out.hasDryBox = !!q('#dryWin');
  out.hasWinNote = !!q('#winNote');
  out.hasWinDone = !!q('#winDone');

  /* ⑥ 形态模板那一格（2026-10-08 加）：必须给「中文标签 + 原始键」，
        不许把内部键当裸英文印出来（原来就是 `A03 · 稀有 · fish`，看着像脏数据）。 */
  var nm = q('#grid .c .nm span');
  out.shapeTagText = nm ? nm.textContent.replace(/\s+/g, ' ').trim() : null;
  out.shapeHasLabel = !!(nm && /形态模板：/.test(nm.textContent));
  out.shapeHasRawKey = !!(nm && nm.querySelector('code'));
  /* 「裸印」的判据：最后一个分隔段**直接**是英文键（没有「形态模板：」前缀） */
  out.shapeBareEnglish = !!(nm && /·\s*(fish|shark|eel|ray|squid|jelly|whale|dragon|oarfish)\s*$/
    .test(nm.textContent.replace(/\s+/g, ' ')));
  /* 交叉提示：只提示不报错 ⇒ 全页**最多**几行有它（当前数据 1 行：S34 深海龙鱼） */
  out.hintRows = document.querySelectorAll('#grid .nm .hint').length;
  out.hintSample = (q('#grid .nm .hint') || {}).textContent || null;

  /* ⑦ 槽位本身（2026-10-08 加）：一张卡里每个槽位必须**各有各的键**、都印了标签，
        而且「一档多版」的槽位真的在页面上（第 2 版出过而页面上没有 = 没人能审它）。
        ⚠️ 这两条是**不变量**（任何数据都该成立）；「有几条鱼有第 2 版」只**报告**不判定
        —— 那取决于用户此刻出了多少图，写死就是给未来的自己挖坑。 */
  var cards = grid ? grid.querySelectorAll('.c') : [];
  var dupKeys = [], noLabel = [], v2Slots = [], slotN = [];
  for (var j = 0; j < cards.length; j++) {
    var ks = [];
    var boxes = cards[j].querySelectorAll('.slot');
    slotN.push(boxes.length);
    for (var t = 0; t < boxes.length; t++) {
      var b2 = boxes[t].querySelector('.b-bad');
      ks.push(b2 ? b2.getAttribute('data-k') : null);
      var lb = boxes[t].querySelector('.sl-label');
      if (!lb || !lb.textContent.trim()) noLabel.push(cards[j].getAttribute('data-id'));
      if (lb && /·第\d+版/.test(lb.textContent)) v2Slots.push(cards[j].getAttribute('data-id'));
    }
    if (ks.filter(function (x, i) { return ks.indexOf(x) !== i; }).length) {
      dupKeys.push(cards[j].getAttribute('data-id'));
    }
  }
  out.slotCounts = slotN.slice(0, 6);
  out.dupSlotKeys = dupKeys;                  // 必须为空：同键两槽会共用一份结论
  out.slotsWithoutLabel = noLabel;            // 必须为空：没标签就不知道在审哪一档
  out.v2Slots = v2Slots;                      // 只报告：当前数据里哪些鱼有第 2 版

  /* ⑧ 条件筛选（2026-10-10 加，用户口径：「筛选同一个条件下的所有鱼，我来标记要重出」）。
        这里**真的改 select 的 value 并派发 change**，然后数网格里剩几张卡 ——
        「控件在」不等于「筛得动」，只读 DOM 属性是看不出这件事的。
        ⚠️ 判据只认**不变量**：筛完必须是「全量里该条件的子集」且**计数与网格一致**，
           不写死任何具体条数（数据一变就会假红）。 */
  var STEP = 'start';
  try {
  STEP = 'grid';
  var all = q('#grid').querySelectorAll('.c').length;
  STEP = 'ui';
  out.filterUi = ['q-field', 'q-shape', 'q-rar', 'q-hue', 'f-clr'].every(function (id) { return !!q('#' + id); });
  out.facetOptionCounts = ['q-field', 'q-shape', 'q-rar', 'q-hue'].map(function (id) {
    return q('#' + id).options.length - 1;      // 减掉「全部…」那一条
  });
  var probeFlt = function (id, val) {
    var sel = q('#' + id);
    sel.value = val;
    sel.dispatchEvent(new Event('change'));
    var cards2 = q('#grid').querySelectorAll('.c');
    var ids = [];
    for (var z = 0; z < cards2.length; z++) ids.push(cards2[z].getAttribute('data-id'));
    return { ids: ids, hit: parseInt(q('#flt-hit').textContent, 10),
             label: sel.options[sel.selectedIndex].text,
             note: q('#flt-note').textContent };
  };
  /* 复位四个下拉（每条单独测时互不干扰）。
     ⚠️ 期望值一律**从 DATA 现算**，不写死条数 —— 数据一变就假红的断言等于没写。 */
  var resetFlt = function () {
    ['q-field', 'q-shape', 'q-rar', 'q-hue'].forEach(function (id) {
      q('#' + id).value = '';
      q('#' + id).dispatchEvent(new Event('change'));
    });
  };
  var expect = function (fn) {
    return DATA.filter(function (d) { return fn(d); }).length;
  };
  resetFlt();
  STEP = 'field';
  var byField = probeFlt('q-field', 'SS');
  out.fieldHit = byField.hit;
  out.fieldCells = byField.ids.length;
  out.fieldExpect = expect(function (d) { return d.field === 'SS'; });
  out.fieldCountsAgree = byField.hit === byField.ids.length;   // 计数与网格必须一致
  out.fieldMatchesData = byField.hit === out.fieldExpect;      // 与 DATA 现算的一致
  out.fieldAllSS = byField.ids.every(function (x) { return /^SS\d/.test(x); });
  out.fieldNote = byField.note;
  resetFlt();
  var byShape = probeFlt('q-shape', 'eel');
  out.shapeHit = byShape.hit;
  out.shapeCells = byShape.ids.length;
  out.shapeExpect = expect(function (d) { return d.shape === 'eel'; });
  out.shapeCountsAgree = byShape.hit === byShape.ids.length;
  out.shapeMatchesData = byShape.hit === out.shapeExpect;
  resetFlt();
  var byHue = probeFlt('q-hue', '8');
  out.hueHit = byHue.hit;
  out.hueCells = byHue.ids.length;
  out.hueExpect = expect(function (d) { return d.hueBand === 8; });
  out.hueCountsAgree = byHue.hit === byHue.ids.length;
  out.hueMatchesData = byHue.hit === out.hueExpect;
  /* 单条鱼都不该被算漏：四个条件**都不选**时必须等于全量 */
  resetFlt();
  out.resetBackToAll = parseInt(q('#flt-hit').textContent, 10) === all;
  /* 组合条件（钓场 + 体型 + 色相）必须**同时生效**（不是最后一个覆盖前面） */
  var combo = probeFlt('q-field', 'SSS');
  var sel2 = q('#q-shape'); sel2.value = 'fish'; sel2.dispatchEvent(new Event('change'));
  var sel3 = q('#q-hue'); sel3.value = '2'; sel3.dispatchEvent(new Event('change'));
  out.comboHit = parseInt(q('#flt-hit').textContent, 10);
  out.comboCells = q('#grid').querySelectorAll('.c').length;
  out.comboAllSSS = Array.prototype.every.call(q('#grid').querySelectorAll('.c'), function (c) {
    return /^SSS\d/.test(c.getAttribute('data-id'));
  });
  out.comboCustom = q('#flt-note').textContent;
  /* hash 同步（可收藏 / 可贴给别人）*/
  out.hashAfter = location.hash;
  /* 清空条件 → 必须回到全量 */
  q('#f-clr').click();
  out.afterClearCells = q('#grid').querySelectorAll('.c').length;
  out.afterClearHit = parseInt(q('#flt-hit').textContent, 10);
  out.afterClearHash = location.hash;
  out.allTotal = all;
  /* 收尾：把上游步骤打开的「导出清单」弹窗关掉、滚回顶部 ——
     否则视口截图拍到的全是那个弹窗，等于没留下「筛选行长什么样」的证据。 */
  var dlg = q('#dlg');
  if (dlg && dlg.open) { var cb = q('#close'); if (cb) cb.click(); }
  window.scrollTo(0, 0);
  } catch (e) {
    /* 条件筛选这一段**自己兜底**：出错时返回「走到哪一步 + 什么错」，
       而不是让整个探针抛掉 —— 抛掉的话前面 ①~⑦ 的结果也一起丢了（什么都诊断不了）。 */
    out.facetError = STEP + ' → ' + String((e && e.message) || e).slice(0, 160);
  }
  return out;
})()
