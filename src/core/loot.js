/* =========================================================
   loot.js  —  掉率 / 重量 / 颜色 / 售价（游戏与数值仿真共用）
   =========================================================
   把抽卡逻辑集中在这里，保证「实际游戏」与「tools/balance.js 仿真」
   用的是同一套算法，数值调整才可信。
   ========================================================= */
window.G = window.G || {};

G.Loot = (function () {
  var U = G.U, CFG = G.CONFIG;

  /* ---------------- 重量 ----------------
     以鱼种自身的 minKg~maxKg 为唯一区间，
     偏小值分布 + 小概率「巨物」溢出。
     稀有度本身的大小差异已经写在各鱼种的区间里，
     这里不再叠加倍率（否则会大面积突破上限）。 */
  function rollKg(fish) {
    var kg = U.skew(fish.minKg, fish.maxKg, CFG.weight.skew);
    if (Math.random() < CFG.weight.giantProb) kg *= CFG.weight.giantMul;
    return kg;
  }

  /* ---------------- 颜色变异 ---------------- */
  function rollColor() {
    var total = 0, i;
    for (i = 0; i < CFG.colorMorphs.length; i++) total += CFG.colorMorphs[i].prob;
    var r = Math.random() * total;
    for (i = 0; i < CFG.colorMorphs.length; i++) {
      r -= CFG.colorMorphs[i].prob;
      if (r <= 0) return CFG.colorMorphs[i];
    }
    return CFG.colorMorphs[0];
  }
  function colorByKey(key) {
    for (var i = 0; i < CFG.colorMorphs.length; i++) if (CFG.colorMorphs[i].key === key) return CFG.colorMorphs[i];
    return CFG.colorMorphs[0];
  }

  /* ---------------- 稀有度权重 ----------------
     · 鱼饵 / 鱼竿：提升稀有档权重
     · 挂机：稀有档权重 ×0.95（策划「稀有鱼概率下降 5%」） */
  function rarityWeights(field, opts) {
    opts = opts || {};
    var w = field.rarity.slice();
    var boost = 1;
    if (opts.bait && opts.bait.rareMul) boost *= opts.bait.rareMul;
    if (opts.rod && opts.rod.rareMul) boost *= opts.rod.rareMul;
    var idleMul = opts.idle ? CFG.idle.rareWeightMul : 1;
    for (var i = 1; i < w.length; i++) w[i] *= boost * idleMul;
    if (opts.bait && opts.bait.legendMul) w[3] *= opts.bait.legendMul;
    return w;
  }

  /* ---------------- 抽一条鱼 ---------------- */
  function rollFish(field, opts) {
    var w = rarityWeights(field, opts);
    var total = 0, i;
    for (i = 0; i < w.length; i++) total += w[i];
    var r = Math.random() * total, rar = w.length - 1;
    for (i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) { rar = i; break; } }
    var buckets = G.FISH_BY_FIELD_RARITY[field.id][rar];
    if (!buckets || !buckets.length) {   // 兜底
      buckets = G.FISH_BY_FIELD_RARITY[field.id][0];
      rar = 0;
    }
    return { fish: U.weighted(buckets, 'w'), rar: rar };
  }

  /* ---------------- 上鱼耗时（秒） ---------------- */
  function biteTime(rarityIdx, opts) {
    opts = opts || {};
    var t = U.range(CFG.rarity[rarityIdx].timeMin, CFG.rarity[rarityIdx].timeMax);
    if (opts.bait && opts.bait.speed) t *= opts.bait.speed;
    return t;
  }

  /* ---------------- 售价 ----------------
     售价 = 鱼种基础价 × 重量系数 × 颜色系数 ×（首次捕获奖励） */
  function price(fish, kg, color, isNew) {
    var mid = Math.max(1e-6, (fish.minKg + fish.maxKg) / 2);
    var kgMul = U.clamp(kg / mid, 0.40, 2.60);
    var p = fish.price * kgMul * (color ? color.valueMul : 1) * CFG.economy.sellMul;
    if (isNew) p *= CFG.economy.firstCatchBonus;
    return Math.max(1, Math.round(p));
  }

  /* ---------------- 完整一次「钓上来」的生成 ---------------- */
  function generate(field, opts) {
    var pick = rollFish(field, opts);
    var kg = rollKg(pick.fish);
    var color = rollColor();
    return { fish: pick.fish, rar: pick.rar, kg: kg, color: color, wait: biteTime(pick.rar, opts) };
  }

  return {
    rollKg: rollKg, rollColor: rollColor, colorByKey: colorByKey,
    rarityWeights: rarityWeights, rollFish: rollFish,
    biteTime: biteTime, price: price, generate: generate,
  };
})();
