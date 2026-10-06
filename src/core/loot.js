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

  /* ---------------- 颜色变异 ----------------
     概率按鱼的稀有度分档：cm.probs[rarIdx]（0=普通 … 3=传说）
     rarIdx 缺失 / 越界时退回普通档 probs[0]。 */
  function colorProb(cm, rarIdx) {
    var a = cm.probs || cm.prob || 0;
    if (typeof a === 'number') return a;               // 兼容单值写法
    var v = a[rarIdx];
    return v == null ? a[0] : v;
  }
  function colorProbTotal(rarIdx) {
    var t = 0;
    for (var i = 0; i < CFG.colorMorphs.length; i++) t += colorProb(CFG.colorMorphs[i], rarIdx);
    return t;
  }
  function rollColor(rarIdx, env) {
    rarIdx = rarIdx || 0;
    var boost = (env && env.colorBoost) ? env.colorBoost : 1;
    /* 原色不参与加成，其余 4 档整体放大后再归一化 ——
       这样「越稀有的颜色」在好天气里提升得更明显（因为它起点低）。 */
    var ws = CFG.colorMorphs.map(function (c, i) {
      return colorProb(c, rarIdx) * (i === 0 ? 1 : boost);
    });
    var total = 0, i;
    for (i = 0; i < ws.length; i++) total += ws[i];
    var r = Math.random() * total;
    for (i = 0; i < ws.length; i++) {
      r -= ws[i];
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
    /* 天气 / 时段：抬高稀有档整体权重（env 为 null 时等于中性） */
    if (opts.env && opts.env.rareMul) boost *= opts.env.rareMul;
    var idleMul = opts.idle ? CFG.idle.rareWeightMul : 1;
    for (var i = 1; i < w.length; i++) w[i] *= boost * idleMul;
    if (opts.bait && opts.bait.legendMul) w[3] *= opts.bait.legendMul;
    return w;
  }

  /* ---------------- 天气 / 时段对鱼种的影响 ----------------
     鱼种可以带 wx / tm 偏好（见 tools/gen-fish.py）。
     命中时它在**本档鱼池内**的抽取权重 ×fishWxMul / ×fishTmMul。
     这是「更容易出」而不是「只有这时才出」，避免图鉴被天气卡住。 */
  function envWeight(fish, env) {
    if (!env) return 1;
    var m = 1;
    if (env.wx && fish.wx === env.wx) m *= CFG.weather.fishWxMul;
    if (env.tm && fish.tm === env.tm) m *= CFG.weather.fishTmMul;
    return m;
  }

  /* 按（档内权重 × 天气倍率）挑一条鱼 */
  function pickInBucket(bucket, env) {
    var total = 0, i;
    for (i = 0; i < bucket.length; i++) total += (bucket[i].w || 0) * envWeight(bucket[i], env);
    if (total <= 0) return bucket[0] || null;
    var r = Math.random() * total;
    for (i = 0; i < bucket.length; i++) {
      r -= (bucket[i].w || 0) * envWeight(bucket[i], env);
      if (r <= 0) return bucket[i];
    }
    return bucket[bucket.length - 1];
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
    return { fish: pickInBucket(buckets, opts.env), rar: rar };
  }

  /* ---------------- 上鱼耗时（秒） ----------------
     咬口时长 = 稀有度基础区间 × 钓场深度倍率 × 鱼饵咬口倍率
     深度倍率只作用于普通 / 稀有档：史诗 / 传说本来就接近 10 分钟上限。 */
  function biteTime(rarityIdx, opts) {
    opts = opts || {};
    var r = CFG.rarity[rarityIdx];
    var t = U.range(r.timeMin, r.timeMax);
    if (rarityIdx <= 1) {
      var mul = 1;
      if (opts.field && opts.field.biteMul) mul = opts.field.biteMul;
      else if (opts.fieldId && G.FIELD_MAP[opts.fieldId]) mul = G.FIELD_MAP[opts.fieldId].biteMul || 1;
      t *= mul;
    }
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

  /* ---------------- 水族箱被动收益（单条，金/小时） ----------------
     产出 = tankYieldBase × √(售价 / tankYieldRef)
     开平方是刻意的：线性比例下几条百万级的顶级鱼就能让「躺着赚」
     超过主动钓鱼（实测 SS 场上界 118%），玩法会废掉。
     ⚠️ 游戏本体（state.js）和 tools/balance.js 都必须调这一个函数，
        不要各自写一遍公式 —— A1 那次「balance 漏乘 biteMul」就是这么来的。 */
  function tankYield(price) {
    if (!(price > 0)) return 0;
    return CFG.storage.tankYieldBase * Math.sqrt(price / CFG.storage.tankYieldRef);
  }

  /* ---------------- 完整一次「钓上来」的生成 ---------------- */
  function generate(field, opts) {
    var pick = rollFish(field, opts);
    var kg = rollKg(pick.fish);
    var color = rollColor(pick.rar, opts.env);
    return { fish: pick.fish, rar: pick.rar, kg: kg, color: color, wait: biteTime(pick.rar, opts) };
  }

  return {
    rollKg: rollKg, rollColor: rollColor, colorByKey: colorByKey,
    envWeight: envWeight, pickInBucket: pickInBucket,
    colorProb: colorProb, colorProbTotal: colorProbTotal,
    rarityWeights: rarityWeights, rollFish: rollFish,
    biteTime: biteTime, price: price, generate: generate, tankYield: tankYield,
  };
})();
