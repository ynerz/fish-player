/* =========================================================
   tools/balance.js  —  数值仿真（Node 运行，不参与游戏本体）
   用法： node tools/balance.js
   作用： 用「模拟玩家」跑大量对局，验证
          ① 各稀有度的拉扯胜率是否合理
          ② 拉扯时长是否在预期范围
          ③ 各钓场每小时收益曲线
          ④ 集齐图鉴（100%）的预估耗时
   ========================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 模拟浏览器环境：window 即全局，window.G 同时也裸写成 G */
global.window = global;
const G_HOLDER = { G: {} };
Object.defineProperty(global, 'G', {
  get() { return G_HOLDER.G; },
  set(v) { G_HOLDER.G = v; },
  configurable: true,
});

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 用 Function 在全局作用域执行，模拟 <script> 标签
  (new Function(code)).call(global);
}
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(load);

const G = global.window.G;
const U = G.U, CFG = G.CONFIG;

/* ---------------- 模拟玩家 ---------------- */
/* 两档玩家：
   熟练：反应 0.15s，预警 0.5 就开始松手
   普通：反应 0.32s，预警 0.15 才松手，张力判断更迟钝 */
const PROFILE = {
  熟练: { react: 0.15, warnTh: 0.50, hi: 0.80, lo: 0.58 },
  普通: { react: 0.32, warnTh: 0.15, hi: 0.86, lo: 0.50 },
};

function simulate(fish, kg, tensionMax, reelMul, prof) {
  const f = G.Fight.begin({ fish, kg, tensionMax, reelMul });
  let t = 0, hold = true, holdTimer = 0;
  const dt = 1 / 60;
  const maxT = f.tensionMax;

  while (!f.over && t < 300) {
    holdTimer += dt;
    if (holdTimer >= prof.react) {
      holdTimer = 0;
      if (f.dashing || f.warn > prof.warnTh) hold = false;
      else if (f.tension >= maxT * prof.hi) hold = false;
      else if (f.tension <= maxT * prof.lo) hold = true;
    }
    G.Fight.update(dt, hold);
    t += dt;
  }
  const res = f.result || 'timeout';
  G.Fight.end();
  return { result: res, time: t };
}

/* ---------------- 单竿耗时 ---------------- */
function waitTime(rar) {
  const r = CFG.rarity[rar];
  return U.range(r.timeMin, r.timeMax);
}

/* ---------------- 抽鱼 ---------------- */
function rollFish(field, bait, rodRareMul, idleOn) {
  const weights = field.rarity.slice();
  if (idleOn) {
    for (let i = 1; i < weights.length; i++) weights[i] *= CFG.idle.rareWeightMul;
  }
  // 鱼饵 / 鱼竿对稀有档的加成
  const boost = (bait ? bait.rareMul : 1) * (rodRareMul || 1);
  weights[1] *= boost;
  weights[2] *= boost * (bait && bait.legendMul ? 1 : 1);
  weights[3] *= boost * (bait && bait.legendMul ? bait.legendMul : 1);

  const rar = pickWeighted(weights);
  const buckets = G.FISH_BY_FIELD_RARITY[field.id][rar];
  return { fish: U.weighted(buckets, 'w'), rar };
}

function pickWeighted(w) {
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}

const rollKg = (fish) => G.Loot.rollKg(fish);

/* ---------------- 主流程 ---------------- */
const ROUNDS = 4000;

console.log('\n=== ① 张力拉扯胜率 / 耗时（6 万次对局）===');
console.log('稀有度   熟练胜率  熟练耗时   普通胜率  普通耗时   断线率  脱钩率  超时率');
for (let rar = 0; rar < 4; rar++) {
  const stat = {};
  const sample = G.FISH.find(f => f.rar === rar);
  Object.keys(PROFILE).forEach(name => {
    let win = 0, sum = 0, snap = 0, esc = 0, tout = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const kg = rollKg(sample);
      const r = simulate(sample, kg, 100, 1.0, PROFILE[name]);
      if (r.result === 'success') { win++; sum += r.time; }
      else if (r.result === 'snap') snap++;
      else if (r.result === 'escape') esc++;
      else tout++;
    }
    stat[name] = { win: win / ROUNDS, time: win ? sum / win : 0,
                   snap: snap / ROUNDS, esc: esc / ROUNDS, tout: tout / ROUNDS };
  });
  const a = stat['熟练'], b = stat['普通'];
  console.log(
    `${CFG.rarity[rar].name.padEnd(6)}  ` +
    `${(a.win * 100).toFixed(1).padStart(7)}%  ${a.time.toFixed(1).padStart(7)}s  ` +
    `${(b.win * 100).toFixed(1).padStart(7)}%  ${b.time.toFixed(1).padStart(7)}s  ` +
    `${(b.snap * 100).toFixed(1).padStart(6)}%  ${(b.esc * 100).toFixed(1).padStart(5)}%  ${(b.tout * 100).toFixed(1).padStart(5)}%`
  );
}

console.log('\n=== ② 各钓场节奏（每竿：等待 + 拉扯）===');
console.log('钓场    平均等待   平均拉扯   单竿合计   每小时竿数  平均鱼价   每小时金币');
const rodFor = (fid) => G.RODS[0];
for (const field of G.FIELDS) {
  let sumWait = 0, sumFight = 0, sumValue = 0, n = ROUNDS;
  for (let i = 0; i < n; i++) {
    const { fish } = rollFish(field, G.BAITS[0], 1.0, false);
    const kg = rollKg(fish);
    sumWait += waitTime(fish.rar);
    const r = simulate(fish, kg, 100, 1.0, PROFILE["熟练"]);
    sumFight += r.result === 'success' ? r.time : r.time * 0.6;
    sumValue += fish.price * (kg / ((fish.minKg + fish.maxKg) / 2));
  }
  const avgWait = sumWait / n, avgFight = sumFight / n;
  const perFish = avgWait + avgFight;
  const perHour = 3600 / perFish;
  const avgVal = sumValue / n;
  console.log(
    `${field.rank.padEnd(5)}  ${avgWait.toFixed(1).padStart(7)}s  ` +
    `${avgFight.toFixed(1).padStart(7)}s  ${perFish.toFixed(1).padStart(8)}s  ` +
    `${perHour.toFixed(0).padStart(9)}  ${avgVal.toFixed(1).padStart(8)}  ${(perHour * avgVal).toFixed(0).padStart(10)}`
  );
}

console.log('\n=== ③ 单钓场「集齐 100% 图鉴」预估（含传说鱼收集）===');
console.log('钓场    鱼种   平均单竿   集齐期望竿数   预估耗时');
for (const field of G.FIELDS) {
  const list = G.FISH_BY_FIELD[field.id];
  let expCasts = 0;
  for (const fish of list) {
    // 该鱼的单次出现概率
    const pRar = field.rarity[fish.rar] / 100;
    const tierW = G.FISH_BY_FIELD_RARITY[field.id][fish.rar];
    const wSum = tierW.reduce((a, b) => a + b.w, 0);
    const p = pRar * (fish.w / wSum);
    expCasts += 1 / Math.max(p, 1e-9);   // 该鱼的期望竿数
  }
  // 平均单竿耗时（上半段计算过，这里复用近似：按稀有度加权）
  let avg = 0;
  const wsum = field.rarity.reduce((a, b) => a + b, 0);
  field.rarity.forEach((v, i) => {
    avg += (v / wsum) * ((CFG.rarity[i].timeMin + CFG.rarity[i].timeMax) / 2 + 12);
  });
  const hours = expCasts * avg / 3600;
  console.log(
    `${field.rank.padEnd(5)}  ${String(list.length).padStart(4)}  ` +
    `${avg.toFixed(1).padStart(8)}s  ${expCasts.toFixed(0).padStart(13)}  ${hours.toFixed(1).padStart(8)} h`
  );
}
console.log('');
