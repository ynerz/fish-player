/* 新体型剪影的真浏览器复核（2026-10-10）。
   交给 tools/browser-probe.js 在页面里求值：
     node tools/browser-probe.js "file:///D:/fish%20player/index.html?dev" docs/images/新体型-蟹螺龟.png tools/probe-newshapes.js
   为什么要有它：本轮新增了 crab / shell / turtle 三个体型，它们的**程序化剪影是人手画的
   Bézier**——只看「语法通过」等于没验。这里把 15 个体型各画一张放在页面上，
   连同「有没有画出东西 / 有没有抛错」一起返回，顺便留一张截图给人看。 */
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  try {
    var SHAPES = ['fish', 'eel', 'shark', 'ray', 'squid', 'jelly', 'oarfish',
                  'whale', 'dragon', 'crustacean', 'star', 'worm', 'crab', 'shell', 'turtle'];
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
