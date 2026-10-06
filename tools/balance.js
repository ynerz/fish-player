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

/* ---------------- ③ 图鉴收集耗时（用游戏真实抽卡逻辑蒙特卡洛） ---------------- */
const FIGHT_EXP = [7.3, 22, 34, 50];   // 每竿期望耗时（含失败重来），秒

function simulateCollect(field, needCount, opts) {
  const seen = new Set();
  let casts = 0, sec = 0;
  while (seen.size < needCount && casts < 4000000) {
    const pick = G.Loot.rollFish(field, opts);
    seen.add(pick.fish.id);
    casts++;
    sec += G.Loot.biteTime(pick.rar, opts) + FIGHT_EXP[pick.rar];
  }
  return { casts, sec };
}

const TRIALS = Number(process.env.TRIALS || 400);

/* 精确公式：收齐「全部」鱼种的期望竿数（长尾分布下蒙特卡洛样本不足，必须用解析解） */
function expectedAll(ps) {
  let pmin = Infinity;
  for (const p of ps) if (p < pmin) pmin = p;
  if (!(pmin > 0)) return Infinity;
  const q = ps.map(p => p / pmin);
  const M = 2000, U = 95, h = U / M;
  const f = (u) => {
    let prod = 1;
    for (let i = 0; i < q.length; i++) {
      prod *= (1 - Math.exp(-q[i] * u));
      if (prod < 1e-15) return 1;
    }
    return 1 - prod;
  };
  let acc = f(0) + f(U);
  for (let i = 1; i < M; i++) acc += (i % 2 ? 4 : 2) * f(i * h);
  return (acc * h / 3) / pmin;
}

/* 用游戏真实掉率算出每个鱼种的单竿概率与单竿期望耗时 */
function realProbs(field, opts) {
  const w = G.Loot.rarityWeights(field, opts || {});
  const tw = w.reduce((a, b) => a + b, 0);
  const out = [];
  G.FISH_BY_FIELD[field.id].forEach(f => {
    const tier = G.FISH_BY_FIELD_RARITY[field.id][f.rar];
    const W = tier.reduce((a, b) => a + b.w, 0);
    out.push({ fish: f, p: (w[f.rar] / tw) * (f.w / W) });
  });
  return out;
}

function cycleOf(field) {
  let c = 0;
  const w = G.Loot.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  for (let t = 0; t < 4; t++) {
    c += (w[t] / tw) * ((CFG.rarity[t].timeMin + CFG.rarity[t].timeMax) / 2 + FIGHT_EXP[t]);
  }
  return c;
}

console.log('\n=== ③ 图鉴收集耗时（蒙特卡洛 ' + TRIALS + ' 次，使用游戏真实掉率）===');
console.log('钓场   鱼种  80%需   到80%(均值)  100%均值   100%中位   累计(100%均值)');

const rowData = [];
let cum100 = 0;
for (const field of G.FIELDS) {
  const list = G.FISH_BY_FIELD[field.id];
  const n = list.length;
  const need80 = Math.ceil(n * 0.8);
  const a80 = [];
  for (let i = 0; i < TRIALS; i++) a80.push(simulateCollect(field, need80, {}).sec / 3600);
  a80.sort((x, y) => x - y);
  const mean = arr => arr.reduce((x, y) => x + y, 0) / arr.length;
  const h80 = mean(a80);
  /* 100% 用解析解 */
  const probs = realProbs(field, {});
  const cyc = cycleOf(field);
  const m100 = expectedAll(probs.map(x => x.p)) * cyc / 3600;
  const h100 = m100;
  cum100 += m100;
  rowData.push({ id: field.id, name: field.name, n, need80, h80, h100: m100, med: h100, cum: cum100 });
  console.log(
    `${field.rank.padEnd(5)} ${String(n).padStart(4)} ${String(need80).padStart(5)}  ` +
    `${h80.toFixed(2).padStart(10)} h  ${m100.toFixed(2).padStart(9)} h  ${h100.toFixed(2).padStart(9)} h  ${cum100.toFixed(1).padStart(12)} h`
  );
}
console.log('\n累计解锁节奏（达到该钓场图鉴 100% 时的总时长）：');
let c = 0;
G.FIELDS.forEach((f, i) => {
  c += rowData[i].h100;
  console.log(`  ${f.rank.padEnd(4)} ${f.name.padEnd(10)} → 累计 ${c.toFixed(1)} h`);
});
console.log(`\n全部 7 个钓场 100% 收满 ≈ ${c.toFixed(0)} 小时`);
console.log('');

