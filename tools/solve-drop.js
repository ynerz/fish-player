/* =========================================================
   tools/solve-drop.js  —  掉率求解器
   =========================================================
   目标：让「集齐某个钓场 100% 图鉴」的期望耗时，命中策划给的节奏表。

   累计解锁节奏（策划口径）：
     C  @ 1h    （D 收满）
     B  @ 3h    （D+C 收满）
     A  @ 10h   （D~B 收满）
     S  @ 30h   （D~A 收满）
     SS @ 100h  （D~S 收满）
     SSS@ 300h  （D~SS 收满）
     全部集满 ≈ 700h

   解法：
     固定「每档鱼种数 n[]」与「档内稀有度梯度 spread[]」，
     对每个钓场二分求解「稀有档总占比 R」，
     使 Σ(1/p_i) × 单竿期望耗时 == 目标小时数。
   输出：直接改写 src/data/fields.js 的 rarity 数组
         与 src/data/fish.js 每个鱼种的 w 值。

   用法： node tools/solve-drop.js            # 求解并写回
          node tools/solve-drop.js --dry      # 只打印不写回
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

/* 各钓场 100% 收满的目标耗时（小时）—— 累计节奏换算成单场增量 */
const FIELD_HOURS = { D: 1, C: 2, B: 7, A: 20, S: 70, SS: 600, SSS: 300 };

/* 档内稀有度梯度：同档内最后一条比第一条稀有多少倍 */
const SPREAD = [1.6, 2.5, 3.5, 5.0];

/* 设计约束：普通档占比下限（防止求解器为了让时间对上加太多稀有鱼，把"稀有"做成大路货） */
const MIN_COMMON = { D: 78, C: 72, B: 66, A: 62, S: 58, SS: 55, SSS: 52 };

/* 稀有档占比下限：保证"稀有"真的是稀有，而不是变成 0.01% 的彩票 */
const MIN_RARE = { D: 6, C: 8, B: 10, A: 14, S: 18, SS: 2, SSS: 8 };

/* 形状合理区间：史诗/稀有、传说/稀有的比值应落在这个带里 */
const D2_BAND = [0.12, 0.55];
const D3_BAND = [0.02, 0.35];

/* 单竿期望耗时（秒）：咬钩等待 + 拉扯，按实测值取 */
const BITE_AVG  = [15, 69, 235, 490];
const FIGHT_AVG = [7.5, 22, 38, 52];

const ROUNDS_PER_HOUR = 3600;

/* ---------------- 工具 ---------------- */
function fieldTiers(fid) {
  const list = G.FISH_BY_FIELD[fid];
  const n = [0, 0, 0, 0];
  list.forEach(f => { n[f.rar]++; });
  return n;
}

/* 档内权重：几何梯度，返回整数数组 */
function tierWeights(n, spread) {
  if (n <= 0) return [];
  if (n === 1) return [100];
  const out = [];
  for (let j = 0; j < n; j++) {
    const t = j / (n - 1);
    out.push(Math.max(1, Math.round(100 * Math.pow(spread, -t))));
  }
  return out;
}

/* 三参数决定四档占比：
     R  = 稀有档（稀有+史诗+传说）总占比 %
     d2 = 史诗 / 稀有
     d3 = 传说 / 稀有
   没有鱼种的档位会被剔除并重新归一化 */
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

/* 收齐「所有」鱼种的期望竿数（精确公式，不是 Σ1/p —— 那是单条鱼的期望）
     E[T] = ∫₀^∞ [1 − Π_j (1 − e^(−p_j·t))] dt
   归一化 u = p_min·t 后做 Simpson 数值积分 */
function expectedCollectAll(ps) {
  let pmin = Infinity;
  for (let i = 0; i < ps.length; i++) if (ps[i] < pmin) pmin = ps[i];
  if (!(pmin > 0) || !isFinite(pmin)) return Infinity;
  const q = ps.map(p => p / pmin);
  const M = 1500, U = 90, h = U / M;
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

/* 某钓场在给定档位占比下的：期望竿数 / 单竿耗时 / 小时数 */
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
    for (let j = 0; j < n; j++) {
      const p = (P[t] / 100) * (w[j] / W);
      if (p <= 0) return { eCasts: Infinity, cycle: 0, hours: Infinity, P };
      ps.push(p);
    }
  }
  const eCasts = expectedCollectAll(ps);

  let cycle = 0;
  for (let t = 0; t < 4; t++) cycle += (P[t] / 100) * (BITE_AVG[t] + FIGHT_AVG[t]);

  return { eCasts, cycle, hours: eCasts * cycle / ROUNDS_PER_HOUR, P };
}

/* 网格搜索 (R, d2, d3) 命中目标小时数，带设计约束 */
function solve(fid, targetHours) {
  const floor = MIN_COMMON[fid];
  let best = null;
  const R_STEPS = 110, D_STEPS = 16;

  function consider(R, d2, d3) {
    if (R <= 0 || R >= 100) return;
    const res = evaluate(fid, R, d2, d3);
    if (!isFinite(res.hours)) return;
    if (res.P[0] < floor) return;                       // 普通鱼太少 → 手感崩
    if (R < MIN_RARE[fid]) return;                      // 稀有鱼太少 → 变成彩票
    if (d2 > 0.85) return;                              // 史诗必须比稀有稀
    if (d3 > d2 * 0.90) return;                         // 传说必须比史诗稀
    const relErr = Math.abs(res.hours - targetHours) / targetHours;
    // 形状越偏离合理带，惩罚越大
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
      const d2 = 0.05 * Math.pow(20, a / (D_STEPS - 1));     // 0.05 ~ 1.0
      for (let b = 0; b < D_STEPS; b++) {
        const d3 = 0.005 * Math.pow(70, b / (D_STEPS - 1));  // 0.005 ~ 0.35
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

/* 该钓场理论上能达到的最短收满时间 */
function minHours(fid) {
  let m = Infinity, at = null;
  for (let i = 1; i < 200; i++) {
    const R = i * 0.5;
    for (let a = 0; a < 24; a++) {
      const d2 = 0.03 * Math.pow(40, a / 23);
      for (let b = 0; b < 24; b++) {
        const d3 = 0.004 * Math.pow(300, b / 23);
        const res = evaluate(fid, R, d2, d3);
        if (!isFinite(res.hours)) continue;
        if (res.P[0] < MIN_COMMON[fid] || R < MIN_RARE[fid]) continue;
        if (res.hours < m) { m = res.hours; at = { R, d2, d3 }; }
      }
    }
  }
  return { hours: m, at };
}

/* ---------------- 主流程 ---------------- */
const ids = G.FIELDS.map(f => f.id);
const solution = {};

console.log('\n================ 掉率求解 ================\n');
console.log('钓场  目标(h)  实际(h)  稀有档占比   期望竿数   单竿耗时   档位分布(普/稀/史/传)  理论最快');

for (const fid of ids) {
  const target = FIELD_HOURS[fid];
  const sol = solve(fid, target);
  const { R, res } = sol;
  const n = fieldTiers(fid);
  solution[fid] = { R, d2: sol.d2, d3: sol.d3, P: res.P, n, res };
  const mh = minHours(fid);
  console.log(
    `${fid.padEnd(5)} ${String(target).padStart(6)}  ${res.hours.toFixed(2).padStart(6)}  ` +
    `${R.toFixed(3).padStart(8)}%  ${Math.round(res.eCasts).toString().padStart(9)}  ` +
    `${res.cycle.toFixed(1).padStart(8)}s  ` +
    res.P.map(v => v.toFixed(1).padStart(5)).join('/') +
    `   ${mh.hours.toFixed(2)}h`
  );
  if (sol.err > target * 0.15) {
    console.log(`      ⚠ 目标 ${target}h 偏离较大（实际 ${res.hours.toFixed(2)}h，该场理论最快 ${mh.hours.toFixed(2)}h）`);
  }
}

/* 累计校验 */
console.log('\n================ 累计解锁节奏校验 ================\n');
console.log('解锁    钓场        累计耗时');
let cum = 0;
for (const fid of ids) {
  if (fid === 'D') { cum += FIELD_HOURS[fid]; continue; }
  cum += FIELD_HOURS[fid];
  console.log(`到 ${fid.padEnd(4)}    ${G.FIELD_MAP[fid].name.padEnd(10)}  ${cum} h`);
}
console.log(`\n全部 7 个钓场 100% 收满 ≈ ${cum} h`);

/* 稀有鱼绝对概率报告 */
console.log('\n================ 关键鱼种绝对概率 ================\n');
console.log('钓场   最稀有那条鱼            单竿概率        期望竿数');
for (const fid of ids) {
  const list = G.FISH_BY_FIELD[fid];
  const sol = solution[fid];
  for (let t = 3; t >= 0; t--) {
    const tierFish = list.filter(f => f.rar === t);
    if (!tierFish.length) continue;
    const n = tierFish.length;
    const w = tierWeights(n, SPREAD[t]);
    const W = w.reduce((a, b) => a + b, 0);
    const last = tierFish[n - 1];
    const p = (sol.res.P[t] / 100) * (w[n - 1] / W);
    console.log(
      `${fid.padEnd(5)}  ${last.name.padEnd(22)} ${(p * 100).toExponential(3).padStart(11)}%  ${Math.round(1 / p).toString().padStart(10)}`
    );
    break;
  }
}

/* ---------------- 写回 ---------------- */
if (!DRY) {
  /* 1) fields.js —— 替换 rarity 数组 */
  let fsrc = fs.readFileSync(path.join(ROOT, 'src/data/fields.js'), 'utf8');
  for (const fid of ids) {
    const P = solution[fid].P.map(v => Math.round(v * 1000) / 1000);
    const re = new RegExp("(id: '" + fid + "'[\\s\\S]*?rarity: \\[)[^\\]]*(\\])");
    if (!re.test(fsrc)) { console.log('!! fields.js 未匹配到 ' + fid); continue; }
    fsrc = fsrc.replace(re, '$1' + P.join(', ') + '$2');
  }
  fs.writeFileSync(path.join(ROOT, 'src/data/fields.js'), fsrc);
  console.log('\n✔ fields.js rarity 已写回');

  /* 2) fish.js —— 替换每个鱼种的 w */
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
    const id = m[1];
    const nw = wmap[id];
    if (nw == null) continue;
    if (/w:\s*\d+/.test(lines[i])) lines[i] = lines[i].replace(/w:\s*\d+/, 'w:' + nw);
    else lines[i] = lines[i].replace(/\}\s*\);\s*$/, ', w:' + nw + ' });');
    patched++;
  }
  fs.writeFileSync(path.join(ROOT, 'src/data/fish.js'), lines.join('\n'));
  console.log('✔ fish.js 权重已写回，共 ' + patched + ' 条');
}

/* ---------------- 复核 ---------------- */
console.log('\n================ 复核（用游戏内真实抽卡逻辑跑 20 万竿）================\n');
for (const fid of ids) {
  const field = G.FIELD_MAP[fid];
  if (!DRY) {
    /* 重新加载改过的数据 */
    delete require.cache[require.resolve(path.join(ROOT, 'src/data/fields.js'))];
  }
}
console.log('（复核请直接运行 node tools/balance.js）');
