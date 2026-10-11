/* ============================================================================
   图鉴懒绘制的**真路径**探针（队列 Q52，2026-10-11 第 44 轮）
   ============================================================================
   要证的两件事（此前两侧都没有机器证据 —— Node 桩里没有 IntersectionObserver，
   跑的是「观察不到就直接画」的兜底分支；而 `data-drawn` 标记当时没人读）：
     ① **不会一次全画**：打开图鉴后，带 `data-drawn="1"` 的格子数应 **< 总格数**；
     ② **画过的不再画**（`unobserve` 真的生效）：滚到底、再滚回顶，**不应有新的 `_paint()` 调用**。

   为什么用「包裹每个格子的 `_paint`」而不是只数绘制函数调用：
     卡面是**异步**到的（`CardArt.want(...)` → 图回来会再画一次），所以「绘制调用数」
     会因图片到达而涨，分不清「滚回去重画了」与「图刚回来」。`_paint()` 的调用数
     才是那条懒绘制路径的直接证据。

   ⚠️ **必须给真实窗口尺寸**（`--size 1440,900`）：默认 headless 只有 800x600，
      图鉴里 52 个筛选 chip 会把网格推到可视区之外 ⇒ 首屏一条鱼都不画，
      量出来的「首屏懒绘制」是**布局**的结论，不是懒绘制的结论。
      🔴 已实测（2026-10-11 第 44 轮）：`--size 1440,900` ⇒ `paintedFirst=5`（真懒）；
         `--size 800,600` ⇒ `paintedFirst=0` —— 于是本探针**自己报出网格顶距**
         （`gridTop` / `gridAboveFold`），好让读的人一眼分清「没画」是懒还是没进视野。
   ⚠️ 图鉴默认筛的是**当前钓场**（不是全 362 条）⇒ 这里会先点「全部钓场」再量，
      否则格数只有十几条，不足以说明问题。
   ℹ️ 一次滚到底**不会**画出全部：`IntersectionObserver` 只报「这一刻在视野里的」，
      直接跳到底就跳过了中间那些格子（实测 362 格里画出 22 格、新增 17 次 `_paint`）。
      这正是真懒绘制的应有表现；滚回顶部则**一次新的 `_paint` 都不该有**（unobserve 生效）。

   用法：
     python -m http.server 8765 --bind 127.0.0.1
     node tools/browser-probe.js http://127.0.0.1:8765/index.html _tmp/out.png tools/probe-book-lazydraw.js --size 1440,900
     # 用完记得关掉 http.server
   ========================================================================= */
(async function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raf = window.__raf1 || (() => Promise.resolve(true));
  const out = {};
  const body = () => document.getElementById('modalBody');
  const itemsOf = () => Array.prototype.slice.call(document.querySelectorAll('#modalBody .book-grid > *'));
  const paintedOf = () => document.querySelectorAll('#modalBody canvas[data-drawn="1"]').length;
  const chipByText = t => Array.prototype.slice.call(document.querySelectorAll('#modalBody .chip'))
    .filter(c => String(c.innerHTML).indexOf(t) >= 0)[0];

  out.viewport = [window.innerWidth, window.innerHeight];
  out.beforeOpen = { items: itemsOf().length, painted: paintedOf() };

  G.Panels.open('book');
  await raf(); await raf(); await sleep(300);

  /* 先切到「全部钓场」（默认是当前钓场，只有十几条，量不出「懒」） */
  const allChip = chipByText('全部钓场');
  if (allChip) { allChip.click(); await raf(); await sleep(500); }
  out.fieldChipAll = !!allChip;

  const items = itemsOf();
  out.items = items.length;
  out.paintedFirst = paintedOf();
  out.scroll = { h: body().scrollHeight, c: body().clientHeight };
  /* 网格顶距滚动容器顶多少 —— 「首屏一条都没画」到底是**懒**还是**没进视野**，
     只有这个数能回答。（`--size 800,600` 时 chip 行把网格顶到可视区外 ⇒
     `paintedFirst=0` 是布局的结论。）
     ⚠️ 判据要算上 `rootMargin: 260px` —— 观察器**提前 260px** 就算「进了视野」，
        所以真正该比的是 `clientHeight + 260`。实测（1440x900）：`gridTop=757` 而
        `clientHeight=637` ⇒ 按可视区算是「没进视野」，可它确实画了 5 格 ——
        正是这 260px 的余量起作用。漏掉这 260 会让这两个数看起来互相矛盾。 */
  const ROOT_MARGIN = 260;
  const grid = document.querySelector('#modalBody .book-grid');
  out.rootMargin = ROOT_MARGIN;
  out.gridTop = grid ? Math.round(grid.getBoundingClientRect().top - body().getBoundingClientRect().top) : null;
  out.gridInPaintRange = out.gridTop != null && out.gridTop < body().clientHeight + ROOT_MARGIN;
  out.firstScreenLazy = out.paintedFirst < out.items;

  /* 包裹每个格子的 _paint —— 这之后的调用数才是「有没有重画」的判据 */
  const calls = { total: 0 };
  items.forEach(it => {
    if (typeof it._paint !== 'function') return;
    const orig = it._paint;
    it._paint = function () { calls.total++; return orig.apply(this, arguments); };
  });
  out.wrapped = items.filter(it => typeof it._paint === 'function').length;

  /* 滚到底 → 应画出更多（并消耗一批 _paint 调用） */
  body().scrollTop = body().scrollHeight;
  await sleep(700); await raf();
  const down = { painted: paintedOf(), calls: calls.total };
  out.afterScrollDown = down;

  /* 滚回顶 → **不该有新的 _paint 调用**（画过的已经 unobserve 了） */
  body().scrollTop = 0;
  await sleep(700); await raf();
  const up = { painted: paintedOf(), calls: calls.total };
  out.afterScrollBackUp = up;

  out.grewAfterScroll = down.painted > out.paintedFirst;
  out.noRepaintOnReturn = (up.calls - down.calls) === 0;

  /* 换一个筛选（体型）：结果集只有几条时，**必须全部画出来** ——
     ⚠️ 第一版这里写的是「筛选后也应该懒」（painted < items），实测假报：
     「通用鱼形」只有 5 条，全都落在视口内 ⇒ 懒绘制的意义本来就不存在。
     正确的期望是反过来的：**懒绘制不许漏画**（全在视野内就得全画上）。 */
  const shapeChip = chipByText('通用鱼形');
  if (shapeChip) {
    shapeChip.click();
    await raf(); await sleep(500);
    out.afterShapeFilter = { items: itemsOf().length, painted: paintedOf() };
    out.smallResultFullyPainted = out.afterShapeFilter.painted === out.afterShapeFilter.items;
  }

  G.Panels.close();
  await raf();
  out.afterClose = document.getElementById('modal').classList.contains('hidden');
  return JSON.stringify(out);
})()
