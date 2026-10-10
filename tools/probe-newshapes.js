/* 新体型剪影的真浏览器复核（2026-10-10）。
   交给 tools/browser-probe.js 在页面里求值：
     node tools/browser-probe.js "file:///D:/fish%20player/index.html?dev" docs/images/新体型-蟹螺龟.png tools/probe-newshapes.js
   为什么要有它：本轮新增了 19 个体型（通用鱼形细分），它们的**程序化剪影是人手画的
   Bézier**——只看「语法通过」等于没验。这里把 15 个体型各画一张放在页面上，
   连同「有没有画出东西 / 有没有抛错」一起返回，顺便留一张截图给人看。 */
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  try {
    /* ⚠️ 体型清单**现算**（`CONFIG.shapeCn` 的键 ∩ 数据里真出现的）——
       写死的话每加一个体型就要回来改探针，而探针正是「加体型时最该跑」的那个。 */
    var seenSh = {};
    G.FISH.forEach(function (f) { seenSh[f.shape] = 1; });
    var SHAPES = Object.keys(G.CONFIG.shapeCn).filter(function (k) { return seenSh[k]; });
    /* 🔴 分页（2026-10-10 加）：体型涨到 37 之后，5 列 × 8 行 = 900+px 的板子
       **一张视口截图拍不全**（`browser-probe` 的全页截图在这个尺寸上会退回视口截图），
       而下半截恰好是「新加的 19 个」—— 最容易画坏的那批反而看不见。
       ⇒ URL 上加 `&probe=N` 取第 N 页（每页 20 个），两页都留图。 */
    var PAGE = (function () {
      var m = /(?:^|[?&#])probe=(\d+)/.exec(location.search + '&' + (location.hash || ''));
      return m ? parseInt(m[1], 10) : 0;
    })();
    var PER = 20;
    out.shapeTotal = SHAPES.length;
    out.page = PAGE;
    SHAPES = SHAPES.slice(PAGE * PER, PAGE * PER + PER);
    /* 每个体型挑一条代表鱼（现算，不写死：拿数据里第一条该体型的鱼） */
    var pick = {};
    G.FISH.forEach(function (f) { if (!pick[f.shape]) pick[f.shape] = f; });
    out.missingShape = SHAPES.filter(function (s) { return !pick[s]; });
    out.shapeCount = SHAPES.length;

    /* 搭一块临时画板：5 列 × 3 行，每格 150×110 */
    var old = document.getElementById('shapeProbe');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'shapeProbe';
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#16171a;'
      + 'padding:10px;display:grid;grid-template-columns:repeat(5,150px);gap:6px;';
    document.body.appendChild(box);

    var errs = [], empty = [];
    SHAPES.forEach(function (s) {
      var f = pick[s];
      var cell = document.createElement('div');
      cell.style.cssText = 'background:#0e0f12;border:1px solid #2a2d34;position:relative';
      var cv = document.createElement('canvas');
      cv.width = 150; cv.height = 110;
      cv.style.cssText = 'width:150px;height:110px;display:block';
      var lb = document.createElement('div');
      lb.textContent = s;
      lb.style.cssText = 'position:absolute;left:4px;bottom:2px;color:#8a9099;font:11px monospace';
      var nm = document.createElement('div');
      nm.textContent = f ? (f.id + ' ' + f.name) : '—';
      nm.style.cssText = 'position:absolute;right:4px;bottom:2px;color:#c9a227;font:11px monospace';
      cell.appendChild(cv); cell.appendChild(lb); cell.appendChild(nm);
      box.appendChild(cell);
      try {
        var ctx = cv.getContext('2d');
        G.FishArt.draw(ctx, f, 75, 55, 108, { t: 0.4 });
        /* 「画出东西了没有」：数一下非透明像素 */
        var d = ctx.getImageData(0, 0, 150, 110).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) { if (d[i] > 8) n++; }
        if (n < 120) empty.push(s + '(' + n + 'px)');
      } catch (e) {
        errs.push(s + ': ' + String((e && e.message) || e).slice(0, 80));
      }
    });
    out.drawErrors = errs;         // 必须为空
    out.tooEmpty = empty;          // 必须为空：剪影画出来至少要有一定面积的像素
    out.canvases = box.querySelectorAll('canvas').length;
    /* 让截图拍到画板：滚到顶、隐藏原来的 UI，画板已 fixed 在左上 */
    window.scrollTo(0, 0);
    await sleep(120);
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
})()
