/* 图鉴「体型筛选」的真浏览器探针（2026-10-10）。
   交给 tools/browser-probe.js 在页面里求值：
     node tools/browser-probe.js "file:///D:/fish%20player/index.html?dev" _tmp/图鉴-体型筛选.png _tmp/probe-codex.js
   判据只认**不变量 + 现算期望**，不写死条数（数据一变就假红的断言等于没写）。 */
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var q = function (s) { return document.querySelector(s); };
  var out = {};
  try {
    /* 打开图鉴面板 */
    G.Panels.open('book');
    await sleep(400);
    var root = q('#modal') || document.body;
    out.panelOpen = !!q('.book-filters');

    /* ① 体型那一行必须真的在，且每个 chip 的中文名来自 G.CONFIG.shapeCn（不是裸英文键） */
    var rows = root.querySelectorAll('.book-filters');
    out.filterRowCount = rows.length;
    var texts = [];
    Array.prototype.forEach.call(rows, function (r) {
      texts.push(r.textContent.replace(/\s+/g, ' ').trim());
    });
    out.rows = texts;
    var shapeRow = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].textContent.indexOf('全部体型') >= 0) shapeRow = rows[i];
    }
    out.hasShapeRow = !!shapeRow;
    if (!shapeRow) { out.error = '找不到「全部体型」那一行'; return out; }

    var chips = shapeRow.querySelectorAll('button.chip');
    out.chipCount = chips.length;
    var labels = [];
    Array.prototype.forEach.call(chips, function (c) { labels.push(c.textContent.trim()); });
    out.chipLabels = labels;
    /* 每个 chip 的标签必须以 `G.CONFIG.shapeCn` 里的某个中文名开头（不是内部英文键） */
    var cnVals = Object.keys(G.CONFIG.shapeCn).map(function (k) { return G.CONFIG.shapeCn[k]; });
    out.allChipsHaveCn = labels.slice(1).every(function (t) {
      return cnVals.some(function (v) { return t.indexOf(v) === 0; });
    });
    /* 只列鱼表里真出现过的体型 —— 死选项 = 点下去 0 条 */
    var seen = {};
    G.FISH.forEach(function (f) { seen[f.shape] = (seen[f.shape] || 0) + 1; });
    out.chipCountMatchesSeen = (chips.length - 1) === Object.keys(seen).length;
    out.noDeadShape = Object.keys(seen).every(function (k) { return !!G.CONFIG.shapeCn[k]; });

    /* ② 点「不选体型」= 全量 */
    var list = function () {
      return parseInt((q('.bk-count') || {}).textContent.replace(/[^\d]/g, ''), 10) || 0;
    };
    /* ⚠️ 图鉴默认只显示**当前钓场**（`bookFilter.field` 初值取存档里的 field）
       ⇒ 先把钓场与稀有度都点回「全部」，否则下面每条期望值都会少算。
       这是探针第一版踩的坑：`allCount` 量成 16，然后每一条都「不匹配」。 */
    var rowOf = function (t) {
      var r = null;
      Array.prototype.forEach.call(rows, function (x) { if (x.textContent.indexOf(t) >= 0) r = x; });
      return r;
    };
    var chipOf = function (row, t) {
      var c2 = null;
      if (!row) return null;
      Array.prototype.forEach.call(row.querySelectorAll('button.chip'), function (x) {
        if (x.textContent.indexOf(t) >= 0) c2 = x;
      });
      return c2;
    };
    if (chipOf(rowOf('全部钓场'), '全部钓场')) chipOf(rowOf('全部钓场'), '全部钓场').click();
    await sleep(120);
    if (chipOf(rowOf('全部稀有度'), '全部稀有度')) chipOf(rowOf('全部稀有度'), '全部稀有度').click();
    await sleep(120);
    var allCount = list();
    out.allCount = allCount;
    out.allMatchesFish = allCount === G.FISH.length;

    /* ③ 逐个点体型 chip：列表条数必须等于**鱼表现算**的该体型条数 */
    var bad = [];
    for (var c = 1; c < chips.length; c++) {
      chips[c].click();
      await sleep(60);
      /* chip 里带了条数（「通用鱼形 239」）→ 直接读它，与列表条数比 */
      var n = parseInt(chips[c].textContent.replace(/[^\d]/g, ''), 10);
      var got = list();
      if (got !== n) bad.push(chips[c].textContent.trim() + ': 列表 ' + got + ' vs chip ' + n);
      /* 复位 */
      chips[0].click();
      await sleep(40);
    }
    out.chipVsList = bad;                       // 必须为空

    /* ④ 组合：体型 + 钓场（深渊异界）必须**同时**生效 */
    Array.prototype.forEach.call(q('.book-filters').querySelectorAll('button.chip'), function () {});
    var fieldRow = null, rarRow2 = null, sRow = null;
    Array.prototype.forEach.call(rows, function (r) {
      if (r.textContent.indexOf('全部钓场') >= 0) fieldRow = r;
      if (r.textContent.indexOf('全部稀有度') >= 0) rarRow2 = r;
      if (r.textContent.indexOf('全部体型') >= 0) sRow = r;
    });
    var byText = chipOf;
    var ssChip = byText(fieldRow, '星陨之渊');
    out.hasSSField = !!ssChip;
    if (ssChip) ssChip.click();
    await sleep(120);
    var fishChip = byText(sRow, '通用鱼形');
    if (fishChip) fishChip.click();
    await sleep(120);
    var got2 = list();
    var want2 = G.FISH.filter(function (f) { return f.field === 'SS' && f.shape === 'fish'; }).length;
    out.comboGot = got2;
    out.comboWant = want2;
    out.comboAgree = got2 === want2;
    /* 复位体型与钓场 */
    if (byText(sRow, '全部体型')) byText(sRow, '全部体型').click();
    await sleep(80);
    if (byText(fieldRow, '全部钓场')) byText(fieldRow, '全部钓场').click();
    await sleep(80);
    out.backToAll = list();
    out.backToAllOk = out.backToAll === G.FISH.length;
    G.Panels.close();
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
})()
