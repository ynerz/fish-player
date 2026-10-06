/* =========================================================
   tools/solve-drop.js  —  掉率求解器
   =========================================================
   目标：让每个钓场的图鉴收集节奏命中策划表。

   节奏表（累计解锁）：
     C @ 1h   B @ 3h   A @ 10h   S @ 30h   SS @ 100h   SSS @ 300h
     SSS 钓场内部：约 700 小时可收集到该场 90% 的鱼

   解法：固定「每档鱼种数」与「档内梯度」，搜索 (R, d2, d3)
        （R = 稀有档总占比，d2 = 史诗/稀有，d3 = 传说/稀有），
        使期望耗时命中目标。

   本轮新约束（用户反馈「概率太极端、没有必要」）：
     · 档内梯度大幅调平（1.25 ~ 1.90，原来 1.6 ~ 5.0）
     · MIN_P：任何一条鱼的单竿概率不得低于该场下限（禁止彩票鱼）
     · MIN_COMMON / MIN_RARE：稀有与普通都要有存在感
     · 鱼种总数扩到 300（对齐市场基准），时长靠「鱼多」而不是「鱼超稀有」

   用法： node tools/solve-drop.js          # 求解并写回
          node tools/solve-drop.js --dry    # 只打印不写回
   ========================================================= */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, CFG = G.CONFIG;

const DRY = process.argv.indexOf('--dry') >= 0;

/* ---------------- 设计参数 ---------------- */

/* 每个钓场：目标小时数 + 要收集的比例（1 = 全收满） */
const FIELD_TARGETS = {
  D:   { hours: 2,    k: 1.0 },
  C:   { hours: 4,    k: 1.0 },
  B:   { hours: 16,   k: 1.0 },
  A:   { hours: 45,   k: 1.0 },
  S:   { hours: 100,  k: 1.0 },
  SS:  { hours: 133,  k: 1.0 },
  SSS: { hours: 350,  k: 0.9 },
};

/* 档内梯度：同档最后一条比第一条稀有多少倍（越平越不会有彩票鱼） */
const SPREAD = [1.55, 2.10, 3.00, 4.60];

/* 普通档占比下限 */
const MIN_COMMON = { D: 58, C: 56, B: 54, A: 52, S: 50, SS: 52, SSS: 65 };

/* 稀有档（稀有+史诗+传说）占比下限 */
const MIN_RARE = { D: 12, C: 18, B: 24, A: 28, S: 30, SS: 30, SSS: 28 };

/* 单条鱼的绝对概率下限（百分数）：低于这个值就是「彩票鱼」，不允许 */
const MIN_P = { D: 0.5, C: 0.25, B: 0.10, A: 0.06, S: 0.045, SS: 0.030, SSS: 0.006 };

/* 形状合理区间 */
const D2_BAND = [0.10, 0.70];
const D3_BAND = [0.02, 0.60];

/* 拉扯耗时（秒），实测值 */
const FIGHT_AVG = [7.5, 22, 38, 52];

const ROUNDS_PER_HOUR = 3600;

/* ---------------- 工具 ---------------- */
function fieldTiers(fid) {
  const list = G.FISH_BY_FIELD[fid];
  const n = [0, 0, 0, 0];
  list.forEach(f => { n[f.rar]++; });
  return n;
}

function tierWeights(n, spread) {
  if (n <= 0) return [];
  if (n === 1) return [100];
  const out = [];
  for (let j = 0; j < n; j++) {
    out.push(Math.max(1, Math.round(100 * Math.pow(spread, -j / (n - 1)))));
  }
  return out;
}

/* 咬口时长均值（把钓场 biteMul 算进去，只作用于普通/稀有） */
function biteAvg(fid, t) {
  const mul = (t <= 1) ? (G.FIELD_MAP[fid].biteMul || 1) : 1;
  return (CFG.rarity[t].timeMin + CFG.rarity[t].timeMax) / 2 * mul;
}

/* 三参数决定四档占比 */
function tierPercents(fid, R, d2, d3) {
  const raw = [1, d2, d3];
  const s = raw[0] + raw[1] + raw[2];
  let P = [100 - R, R * raw[0] / s, R * raw[1] / s, R * raw[2] / s];
  const n = fieldTiers(fid);
  let tot = 0;
  for (let t = 0; t < 4; t++) { if (!n[t]) P[t] = 0; tot += P[t]; }
  if (tot > 0) P = P.map(v => v * 100 / tot);
  return P;
}

/* 收齐「指定集合」的期望竿数（精确公式，不是 Σ1/p）
     E[T] = ∫₀^∞ [1 − Π_j (1 − e^(−p_j·t))] dt */
function expectedCollect(ps) {
  let pmin = Infinity;
  for (let i = 0; i < ps.length; i++) if (ps[i] < pmin) pmin = ps[i];
  if (!(pmin > 0) || !isFinite(pmin)) return Infinity;
  const q = ps.map(p => p / pmin);
  const M = 1200, U = 95, h = U / M;
  function f(u) {
    let prod = 1;
    for (let i = 0; i < q.length; i++) {
      prod *= (1 - Math.exp(-q[i] * u));
      if (prod < 1e-15) return 1;
    }
    return 1 - prod;
  }
  let s = f(0) + f(U);
  for (let i = 1; i < M; i++) s += (i % 2 ? 4 : 2) * f(i * h);
  return (s * h / 3) / pmin;
}

function evaluate(fid, R, d2, d3) {
  const list = G.FISH_BY_FIELD[fid];
  const tiers = [[], [], [], []];
  list.forEach(f => tiers[f.rar].push(f));
  const P = tierPercents(fid, R, d2, d3);

  const ps = [];
  for (let t = 0; t < 4; t++) {
    const n = tiers[t].length;
    if (!n) continue;
    const w = tierWeights(n, SPREAD[t]);
    const W = w.reduce((a, b) => a + b, 0);
    for (let j = 0; j < n; j++) ps.push((P[t] / 100) * (w[j] / W));
  }
  ps.sort((a, b) => b - a);                 // 从常见到稀有

  const target = FIELD_TARGETS[fid];
  const k = Math.max(1, Math.ceil(ps.length * target.k));
  const eCasts = expectedCollect(ps.slice(0, k));

  let cycle = 0;
  for (let t = 0; t < 4; t++) cycle += (P[t] / 100) * (biteAvg(fid, t) + FIGHT_AVG[t]);

  return { eCasts, cycle, hours: eCasts * cycle / ROUNDS_PER_HOUR, P, pMin: ps[ps.length - 1], k };
}

/* 网格搜索，带设计约束 */
function solve(fid, targetHours) {
  const floor = MIN_COMMON[fid];
  let best = null;
  const R_STEPS = 90, D_STEPS = 15;

  function consider(R, d2, d3) {
    if (R <= 0 || R >= 100) return;
    if (R < MIN_RARE[fid]) return;
    if (d2 > 0.85) return;
    if (d3 > d2 * 0.90) return;
    const res = evaluate(fid, R, d2, d3);
    if (!isFinite(res.hours)) return;
    if (res.P[0] < floor) return;
    if (res.pMin < MIN_P[fid] / 100) return;
    /* 单条鱼概率必须按档位严格递减 */
    const n = fieldTiers(fid);
    let prevPS = Infinity;
    for (let t = 0; t < 4; t++) {
      if (!n[t]) continue;
      const ps = res.P[t] / n[t];
      if (ps >= prevPS) return;
      prevPS = ps;
    }
    const relErr = Math.abs(res.hours - targetHours) / targetHours;
    let pen = 0;
    if (d2 < D2_BAND[0]) pen += (D2_BAND[0] - d2) * 3;
    if (d2 > D2_BAND[1]) pen += (d2 - D2_BAND[1]) * 3;
    if (d3 < D3_BAND[0]) pen += (D3_BAND[0] - d3) * 3;
    if (d3 > D3_BAND[1]) pen += (d3 - D3_BAND[1]) * 3;
    const score = relErr + pen;
    if (!best || score < best.score) best = { R, d2, d3, res, err: relErr * targetHours, score };
  }

  const rLo = MIN_RARE[fid], rHi = 100 - floor;
  for (let i = 1; i < R_STEPS; i++) {
    const R = rLo + (rHi - rLo) * (i / R_STEPS);
    for (let a = 0; a < D_STEPS; a++) {
      const d2 = 0.05 * Math.pow(20, a / (D_STEPS - 1));
      for (let b = 0; b < D_STEPS; b++) {
        const d3 = 0.005 * Math.pow(80, b / (D_STEPS - 1));
        consider(R, d2, d3);
      }
    }
  }
  if (!best) return { R: 30, d2: 0.25, d3: 0.08, res: evaluate(fid, 30, 0.25, 0.08), err: Infinity };

  let step = 1;
  for (let k = 0; k < 26; k++) {
    step /= 2;
    for (const dR of [-1, 0, 1]) for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) {
      consider(best.R + dR * step * 2.5, best.d2 * (1 + a * step * 0.06), best.d3 * (1 + b * step * 0.06));
    }
  }
  return best;
}

/* ---------------- 主流程 ---------------- */
const ids = G.FIELDS.map(f => f.id);
const solution = {};

console.log('\n================ 掉率求解 ================\n');
console.log('钓场   目标h   实际h   普通%   稀有%   史诗%   传说%   最稀有鱼单竿概率   期望竿数');

for (const fid of ids) {
  const tgt = FIELD_TARGETS[fid];
  const sol = solve(fid, tgt.hours);
  const res = sol.res;
  solution[fid] = { R: sol.R, d2: sol.d2, d3: sol.d3, P: res.P, res, hours: res.hours };
  const flag = sol.err > tgt.hours * 0.12 ? '  ⚠ 偏离较大' : '';
  console.log(
    `${fid.padEnd(5)} ${String(tgt.hours).padStart(6)} ${res.hours.toFixed(1).padStart(8)}  ` +
    res.P.map(v => v.toFixed(2).padStart(7)).join('') +
    `   ${(res.pMin * 100).toFixed(4).padStart(10)}%  ${Math.round(res.eCasts).toString().padStart(9)}${flag}`
  );
}

/* ---------------- 写回 ---------------- */
if (!DRY) {
  let fsrc = fs.readFileSync(path.join(ROOT, 'src/data/fields.js'), 'utf8');
  for (const fid of ids) {
    const P = solution[fid].P.map(v => Math.round(v * 1000) / 1000);
    const re = new RegExp("(id: '" + fid + "'[\\s\\S]*?rarity: \\[)[^\\]]*(\\])");
    if (!re.test(fsrc)) { console.log('!! fields.js 未匹配到 ' + fid); continue; }
    fsrc = fsrc.replace(re, '$1' + P.join(', ') + '$2');
  }
  fs.writeFileSync(path.join(ROOT, 'src/data/fields.js'), fsrc);
  console.log('\n✔ fields.js rarity 已写回');

  let src = fs.readFileSync(path.join(ROOT, 'src/data/fish.js'), 'utf8');
  const lines = src.split('\n');
  const wmap = {};
  for (const fid of ids) {
    const list = G.FISH_BY_FIELD[fid];
    for (let t = 0; t < 4; t++) {
      const tierFish = list.filter(f => f.rar === t);
      if (!tierFish.length) continue;
      const w = tierWeights(tierFish.length, SPREAD[t]);
      tierFish.forEach((f, j) => { wmap[f.id] = w[j]; });
    }
  }
  let patched = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*F\('([A-Z]+\d+)'/.exec(lines[i]);
    if (!m) continue;
    const nw = wmap[m[1]];
    if (nw == null) continue;
    if (/w:\s*\d+/.test(lines[i])) lines[i] = lines[i].replace(/w:\s*\d+/, 'w:' + nw);
    patched++;
  }
  fs.writeFileSync(path.join(ROOT, 'src/data/fish.js'), lines.join('\n'));
  console.log('✔ fish.js 权重已写回，共 ' + patched + ' 条');
}

/* 累计节奏表 */
console.log('\n================ 累计解锁节奏 ================\n');
let cum = 0;
console.log('解锁    钓场        累计耗时');
for (const fid of ids) {
  cum += solution[fid].hours;
  const note = fid === 'SSS' ? '（本场按 90% 计）' : '';
  console.log(`${('到 ' + fid).padEnd(6)}  ${G.FIELD_MAP[fid].name.padEnd(10)}  ${cum.toFixed(0).padStart(5)} h ${note}`);
}
console.log(`\n全部 7 场 100% 收满 ≥ ${cum.toFixed(0)} 小时`);
console.log('\n复核：node tools/balance.js\n');
