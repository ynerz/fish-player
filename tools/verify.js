/* =========================================================
   tools/verify.js  —  数据自检 / 一致性断言
   =========================================================
   目的：把「靠人记得跑」变成「跑一次就知道有没有错」。

   检查项：
     1. 各钓场稀有度权重合计 = 100%
     2. 每个稀有度档位的颜色概率合计 = 100%
     3. 档内颜色序：原色 > 亮色 ≥ 白化 > 黄金 > 闪光
     4. 颜色概率随稀有度单调（原色递减，其余递增）
     5. 各场 100% 收齐耗时 vs fields.js 的 estOwnHours（偏差 >8% 报错）
     6. fish.js 每条鱼字段完整、权重/价格/体重区间合法
     7. rollColor 实测分布 vs 配置概率（相对误差 >20% 报错）
     8. 各场每小时金币是否单调递增（经济曲线不倒退）

   用法： node tools/verify.js       ← 有 ERROR 时退出码为 1
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, CFG = G.CONFIG, L = G.Loot;

let errors = 0, warns = 0;
const ok   = m => console.log('  \u2714 ' + m);
const err  = m => { errors++; console.log('  \u2716 ' + m); };
const warn = m => { warns++; console.log('  \u26a0 ' + m); };

/* ---------------- 1. 稀有度权重合计 ---------------- */
console.log('\n[1] 各钓场稀有度权重合计 = 100%');
G.FIELDS.forEach(f => {
  const s = f.rarity.reduce((a, b) => a + b, 0);
  if (Math.abs(s - 100) > 0.01) err(`${f.rank} 合计 ${s.toFixed(3)}%`);
  else ok(`${f.rank} ${s.toFixed(3)}%`);
});

/* ---------------- 2. 颜色概率合计 ---------------- */
console.log('\n[2] 每个稀有度档位的颜色概率合计 = 100%');
[0, 1, 2, 3].forEach(t => {
  const s = L.colorProbTotal(t) * 100;
  if (Math.abs(s - 100) > 1e-6) err(`${CFG.rarity[t].name}档 合计 ${s}%`);
  else ok(`${CFG.rarity[t].name}档 100%`);
});

/* ---------------- 3. 档内颜色序 ---------------- */
console.log('\n[3] 档内颜色序：原色 > 亮色 ≥ 白化 > 黄金 > 闪光');
const byKey = {};
CFG.colorMorphs.forEach(c => { byKey[c.key] = c; });
[0, 1, 2, 3].forEach(t => {
  const n = byKey.normal, b = byKey.bright, a = byKey.albino, g = byKey.golden, s = byKey.shiny;
  const P = k => L.colorProb(byKey[k], t);
  const bad = [];
  if (!(P('normal') > P('bright'))) bad.push('原色 ≤ 亮色');
  if (!(P('bright') >= P('albino'))) bad.push('亮色 < 白化');
  if (!(P('albino') > P('golden'))) bad.push('白化 ≤ 黄金');
  if (!(P('golden') > P('shiny'))) bad.push('黄金 ≤ 闪光');
  if (bad.length) err(`${CFG.rarity[t].name}档：${bad.join('、')}`);
  else ok(`${CFG.rarity[t].name}档 序正确（闪光 ${(P('shiny') * 100).toFixed(1)}% 最稀有）`);
  void n; void b; void a; void g; void s;
});

/* ---------------- 4. 颜色概率随稀有度的单调性 ---------------- */
console.log('\n[4] 颜色概率随稀有度单调变化');
CFG.colorMorphs.forEach(c => {
  const v = [0, 1, 2, 3].map(t => L.colorProb(c, t));
  const inc = v.every((x, i) => i === 0 || x >= v[i - 1]);
  const dec = v.every((x, i) => i === 0 || x <= v[i - 1]);
  if (c.key === 'normal') {
    if (!dec) err(`${c.name} 应随稀有度递减，实际 ${v.join(' / ')}`);
    else ok(`${c.name} 递减 ${v.join(' / ')}`);
  } else {
    if (!inc) err(`${c.name} 应随稀有度递增，实际 ${v.join(' / ')}`);
    else ok(`${c.name} 递增 ${v.join(' / ')}`);
  }
});

/* ---------------- 5. 收集耗时 vs 写回的 estOwnHours ---------------- */
console.log('\n[5] 各场 100% 收齐耗时 vs fields.js 的 estOwnHours（容差 8%）');

function expectedAll(ps) {
  if (!ps.length) return 0;
  let pmin = Infinity;
  for (const p of ps) if (p < pmin) pmin = p;
  if (!(pmin > 0)) return Infinity;
  const q = ps.map(p => p / pmin);
  const M = 1600, U = 95, h = U / M;
  const f = u => { let pr = 1; for (let i = 0; i < q.length; i++) { pr *= (1 - Math.exp(-q[i] * u)); if (pr < 1e-15) return 1; } return 1 - pr; };
  let acc = f(0) + f(U);
  for (let i = 1; i < M; i++) acc += (i % 2 ? 4 : 2) * f(i * h);
  return (acc * h / 3) / pmin;
}
function trueProbs(field) {
  const w = L.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  return G.FISH_BY_FIELD[field.id].map(f => {
    const tier = G.FISH_BY_FIELD_RARITY[field.id][f.rar];
    const W = tier.reduce((a, b) => a + b.w, 0);
    return { fish: f, p: (w[f.rar] / tw) * (f.w / W) };
  });
}
/* Loot.biteTime 内部是随机取值，直接调一次得到的是随机数而不是期望。
   这里用真实代码路径抽样取平均，既避免和 loot.js 的公式重复，
   又能顺带验证 biteMul 确实生效。 */
function biteExpect(t, field, n) {
  n = n || 800;
  let s = 0;
  for (let i = 0; i < n; i++) s += L.biteTime(t, { field });
  return s / n;
}
function cycleOf(field) {
  const w = L.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  let c = 0;
  for (let t = 0; t < 4; t++) {
    c += (w[t] / tw) * (biteExpect(t, field) + CFG.misc.fightExpect[t]);
  }
  return c;
}
G.FIELDS.forEach(field => {
  const rows = trueProbs(field);
  const hours = expectedAll(rows.map(r => r.p)) * cycleOf(field) / 3600;
  const declared = field.estOwnHours;
  if (!declared) { warn(`${field.rank} 没有 estOwnHours，跳过`); return; }
  const dev = Math.abs(hours - declared) / declared;
  const msg = `${field.rank} 实算 ${hours.toFixed(1)}h vs 声明 ${declared}h（偏差 ${(dev * 100).toFixed(1)}%）`;
  if (dev > 0.08) err(msg);
  else ok(msg);
});

/* ---------------- 6. fish.js 字段完整性 ---------------- */
console.log('\n[6] fish.js 字段完整性');
let badFish = 0;
G.FISH.forEach(f => {
  const issues = [];
  if (!f.id || !f.name) issues.push('缺 id/name');
  if (!G.FIELD_MAP[f.field]) issues.push('field 不存在: ' + f.field);
  if (!(f.rar >= 0 && f.rar <= 3)) issues.push('rar 越界: ' + f.rar);
  if (!(f.w > 0)) issues.push('w 非正: ' + f.w);
  if (!(f.price > 0)) issues.push('price 非正: ' + f.price);
  if (!(f.minKg > 0)) issues.push('minKg 非正');
  if (!(f.maxKg > f.minKg)) issues.push('maxKg ≤ minKg');
  if (!(f.shape)) issues.push('缺 shape');
  if (issues.length) { err(`${f.id} ${f.name}: ${issues.join('；')}`); badFish++; }
});
if (!badFish) ok(`${G.FISH.length} 条鱼全部字段完整`);
if (G.FISH_ID[G.FISH[0].id] !== G.FISH[0]) err('FISH_ID 索引与 FISH 不一致'); else ok('FISH_ID 索引一致');

/* ---------------- 7. rollColor 实测分布 ---------------- */
console.log('\n[7] rollColor 实测分布 vs 配置（每档 40000 次，容差 20% 相对误差）');
const N = 40000;
[0, 1, 2, 3].forEach(t => {
  const cnt = {};
  for (let i = 0; i < N; i++) { const c = L.rollColor(t); cnt[c.key] = (cnt[c.key] || 0) + 1; }
  let worst = 0, worstName = '';
  CFG.colorMorphs.forEach(c => {
    const want = L.colorProb(c, t) / L.colorProbTotal(t);
    const got = (cnt[c.key] || 0) / N;
    const rel = Math.abs(got - want) / want;
    if (rel > worst) { worst = rel; worstName = c.name; }
  });
  const msg = `${CFG.rarity[t].name}档 最大偏差 ${(worst * 100).toFixed(1)}%（${worstName}）`;
  if (worst > 0.20) err(msg); else ok(msg);
});

/* ---------------- 8. 经济曲线单调 ----------------
   用「游戏真实售价函数」估算平均鱼价：基础价 × 重量系数 × 颜色系数。
   这里刻意不断言具体数值（那是 balance.js 的活儿），
   只断言「曲线不许倒退」这个设计不变量。 */
console.log('\n[8] 各场每小时金币应单调递增');
const income = [];
G.FIELDS.forEach(field => {
  const tot = field.rarity.reduce((a, b) => a + b, 0);
  let cycle = 0;
  [0, 1, 2, 3].forEach(t => {
    cycle += (field.rarity[t] / tot) * (biteExpect(t, field) + CFG.misc.fightExpect[t]);
  });
  /* 抽 20000 竿算平均售价。样本必须够大 ——
     A/S/SS/SSS 的传说鱼只占 0.02~0.5%，样本少了会被单条大鱼带跑。 */
  let sum = 0;
  const N = 20000;
  const opt = { bait: null, rod: null, idle: false };
  for (let i = 0; i < N; i++) {
    const pick = L.rollFish(field, opt);
    sum += L.price(pick.fish, L.rollKg(pick.fish), L.rollColor(pick.rar), false);
  }
  income.push({ rank: field.rank, v: 3600 / cycle * (sum / N) });
});
for (let i = 0; i < income.length; i++) {
  const cur = income[i], prev = income[i - 1];
  const label = `${cur.rank} ${Math.round(cur.v)} 金/时`;
  if (!prev) { ok(`${label}（起始场，作基准）`); continue; }
  const ratio = cur.v / prev.v;
  if (ratio < 1) err(`${label} —— 低于 ${prev.rank} 的 ${Math.round(prev.v)}（×${ratio.toFixed(2)}，收益倒退）`);
  else if (ratio < 1.15) warn(`${label} —— 只比 ${prev.rank} 高 ${((ratio - 1) * 100).toFixed(0)}%，曲线偏平`);
  else ok(`${label}（较 ${prev.rank} ×${ratio.toFixed(2)}）`);
}

/* ---------------- 9. 装饰都能画出来 ----------------
   踩过的坑：装饰是「花钱买一个 id」，如果 scene.js 里没有对应的绘制分支，
   玩家花几十万买回来什么都看不见，而且不报任何错。
   所以这里做一次「数据 ↔ 绘制」的对应检查。 */
console.log('\n[9] 每件装饰都在 scene.js 里有绘制分支');
const sceneSrc = fs.readFileSync(path.join(ROOT, 'src/render/scene.js'), 'utf8');
let noDraw = 0;
G.DECORS.forEach(d => {
  const has = new RegExp('S\\.decor\\.' + d.id + '\\b').test(sceneSrc);
  if (!has) { err(`${d.id} 「${d.name}」在 scene.js 里没有绘制实现（买了会看不见）`); noDraw++; }
});
if (!noDraw) ok(`${G.DECORS.length} 件装饰全部有绘制实现`);

const CURS = ['coin', 'eco', 'medal'];
const badCur = G.DECORS.filter(d => d.cur && CURS.indexOf(d.cur) < 0);
if (badCur.length) err(`装饰货币字段非法：${badCur.map(d => d.id + '=' + d.cur).join('、')}`);
else ok('装饰货币字段合法（coin / eco / medal）');

const freeLunch = G.DECORS.filter(d => (d.cur === 'eco' || d.cur === 'medal') && d.price > 5000);
if (freeLunch.length) err(`限定装饰的「价格」应是生态值/纪念币数量，看着像金币：${freeLunch.map(d => d.id).join('、')}`);
else ok('限定装饰的价格都在收集货币的合理量级内');

const noPrice = G.DECORS.filter(d => !(d.price > 0));
if (noPrice.length) err(`装饰缺价格：${noPrice.map(d => d.id).join('、')}`);
else ok('装饰都有正价格');

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
