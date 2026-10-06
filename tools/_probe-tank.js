async page => {
  const out = {};
  await page.goto('http://127.0.0.1:8765/index.html?dev', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => { G.Panels.open('net'); });
  await page.waitForTimeout(500);

  /* 采样整幅画布（缩略网格），能反映水波与鱼的运动 */
  const sample = () => page.evaluate(() => {
    const cv = document.querySelector('.tank-canvas');
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 373) h = (h * 31 + d[i]) >>> 0;
    return { w: cv.width, h: cv.height, hash: h };
  });

  const a = await sample();
  await page.waitForTimeout(900);
  const b = await sample();
  out.tankCount = await page.evaluate(() => G.State.tankCount());
  out.emptyTankFrozen = a.hash === b.hash;
  out.emptyTank = { a, b };

  /* 视口压到 modal-box 的 760px 上限以下，画布才会真的改变尺寸 */
  await page.setViewportSize({ width: 560, height: 760 });
  await page.waitForTimeout(700);
  const c = await sample();
  out.resizedCanvas = c;
  out.repaintedAfterResize = c.w !== a.w;

  /* 塞一条鱼进水族箱 → 有活物就必须重新动起来 */
  await page.evaluate(() => {
    const f = G.FISH_BY_FIELD.D[1];
    G.State.toNet(f, 3.2, 'gold');
    G.State.moveToTank(0);
    G.Panels.refresh();
  });
  await page.waitForTimeout(400);
  const d1 = await sample();
  await page.waitForTimeout(700);
  const d2 = await sample();
  out.tankCountAfter = await page.evaluate(() => G.State.tankCount());
  out.filledAnimates = d1.hash !== d2.hash;
  out.filled = { d1, d2 };

  /* 关面板再开：空缸也不能崩、不能残留 RAF */
  await page.evaluate(() => { G.Panels.close(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { G.Panels.open('net'); });
  await page.waitForTimeout(400);
  out.reopenOk = await page.evaluate(() => !!document.querySelector('.tank-canvas'));
  return out;
}
