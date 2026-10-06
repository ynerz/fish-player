/* =========================================================
   tools/fix-rarity-price.js  —  让「稀有度越高越值钱」在每个钓场都成立
   =========================================================
   问题：SS / SSS 场的普通鱼是深海大鱼，价格很高，
   而这两个场的稀有 / 史诗鱼价格没跟上，加上稀有档咬口更慢，
   导致「稀有档的每小时收益」反而低于普通档 ——
   于是「提升稀有鱼概率」（鱼竿、高级鱼饵、付费点①）在那两个场是负收益。

   本工具做的事：按钓场，逐档缩放鱼价，使各档的「每小时收益」
   满足目标比值 [普通 1 : 稀有 1.8 : 史诗 4.0 : 传说 10.0]，
   **并做整体归一化，保证该场每小时收益总额不变**
   （所以节奏表与经济曲线都不受影响）。

   ⚠️ 本脚本必须**幂等**：在同一份 fish.js 上跑第二遍，产出必须逐字节相同。
   踩过的坑：① 重量系数用 Math.random 采样估计，两次运行结果不同；
   ② 鱼价是整数，「套一遍系数」会再舍入一次，一次变换到不了不动点。
   于是「按标准顺序重跑数值链」会莫名改掉 fish.js 上百行，工作区变脏、
   容易被误当成自己的改动提交。现在：
     · 随机源换成定种子的 LCG，且**每条鱼用自己的种子**（估值与调用顺序无关）；
     · 反复套用系数直到价格不再变化（不动点），写回的就是这个不动点；
     · 自检「不动点上再套一遍必须 0 条改动」，不是 0 直接退出码 1。

   用法： node tools/fix-rarity-price.js [--dry]
   流程： python tools/gen-fish.py && node tools/solve-drop.js
          && node tools/fix-rarity-price.js && node tools/balance.js
          && node tools/verify.js
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 确定性随机 ----------
   必须在加载游戏模块之前替换，保证之后所有采样都可复现。
   线性同余（Lehmer）：seed < 2^31，乘 48271 后仍 < 2^47，双精度下无精度损失。 */
let _seed = 20260101;
function seedRandom(s) { _seed = (s % 2147483646) + 1; }
Math.random = function () { _seed = (_seed * 48271) % 2147483647; return _seed / 2147483647; };

global.window = global;
/* 记下调用方原本的 window.G，加载完再还回去 ——
   本工具被 require（verify / test 会这么用）时，绝不能把别人的 G 换掉：
   state.js 的延迟存盘回调是通过全局 G 找 G.Platform 的，
   G 一旦被换成「只加载了 7 个模块」的这份，那个回调就会 TypeError 崩掉。 */
const prevG = Object.getOwnPropertyDescriptor(global, 'G');
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, CFG = G.CONFIG, L = G.Loot;
if (prevG) Object.defineProperty(global, 'G', prevG);

/* 目标：同场内，各档「每小时收益」相对普通档的倍数 */
const TARGET = [1, 1.8, 4.0, 10.0];
const MAX_ROUNDS = 40;

/* ---------- 期望工具（解析式，不用蒙特卡洛，避免稀有鱼带偏） ---------- */
const kgCache = {};
/* 每条鱼一个固定种子：同一条鱼永远拿到同一批样本 → 估值与调用顺序无关 */
function fishSeed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h % 2000000000;
}
function fishKgMul(f) {
  if (kgCache[f.id] != null) return kgCache[f.id];
  const mid = (f.minKg + f.maxKg) / 2;
  seedRandom(fishSeed(f.id));
  let s = 0; const N = 600;
  for (let i = 0; i < N; i++) s += Math.min(2.6, Math.max(0.40, L.rollKg(f) / mid));
  return kgCache[f.id] = s / N;
}
const colCache = {};
function colorMul(rar) {
  if (colCache[rar] != null) return colCache[rar];
  let s = 0;
  CFG.colorMorphs.forEach(c => { s += L.colorProb(c, rar) * c.valueMul; });
  return colCache[rar] = s / L.colorProbTotal(rar);
}
function midBite(t, f) {
  const r = CFG.rarity[t];
  return (r.timeMin + r.timeMax) / 2 * (t <= 1 ? (f.biteMul || 1) : 1);
}
/* 某档鱼的「平均单价」（档内按权重） */
function tierAvgPrice(field, t) {
  const bucket = G.FISH_BY_FIELD_RARITY[field.id][t] || [];
  const bw = bucket.reduce((a, b) => a + b.w, 0) || 1;
  let v = 0;
  bucket.forEach(x => { v += (x.w / bw) * x.price * fishKgMul(x) * colorMul(t); });
  return v;
}
/* 某档的「每小时收益」 */
function tierIncome(field, t) {
  return 3600 / (midBite(t, field) + CFG.misc.fightExpect[t]) * tierAvgPrice(field, t);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const priceAfter = (fish, s) => clamp(Math.round(fish.price * s), 1, 99999999);

/* ---------- 计算每场每档的缩放系数（对当前价格是纯函数） ---------- */
function computeScales() {
  const scales = {};   // fid -> [s0,s1,s2,s3]
  const rows = [];
  rows.push('\n钓场   档位        原收益/时   目标比值   缩放   调整后');
  rows.push('-'.repeat(70));

  G.FIELDS.forEach(field => {
    const tot = field.rarity.reduce((a, b) => a + b, 0);
    const p = field.rarity.map(v => v / tot);
    const inc = [0, 1, 2, 3].map(t => tierIncome(field, t));
    const cyc = [0, 1, 2, 3].map(t => midBite(t, field) + CFG.misc.fightExpect[t]);
    const px = [0, 1, 2, 3].map(t => tierAvgPrice(field, t));

    /* ⚠️ 每小时收益 = 总钱 ÷ 总时间 = (Σ p·价格) / (Σ p·单竿耗时) × 3600。
       不能写成 Σ p·(价格/耗时) —— 那是 Jensen 不等式里的 E[X/Y] ≠ E[X]/E[Y]，
       两边的差距在这份数据上有 2~3 倍，会把「总额不变」的保证直接算错。 */
    const fieldIncome = arr => 3600 * p.reduce((a, v, t) => a + v * arr[t], 0) /
                              p.reduce((a, v, t) => a + v * cyc[t], 0);
    const before = fieldIncome(px);

    /* 让「每档的钱/秒」满足目标比值，取 0 档不动 */
    const raw = [0, 1, 2, 3].map(t => t === 0 ? 1 : (TARGET[t] * inc[0]) / inc[t]);

    /* 再整体缩放，保证该场每小时收益不变 */
    const after = fieldIncome(px.map((v, t) => v * raw[t]));
    const k = before / after;
    scales[field.id] = raw.map(s => s * k);

    const names = ['普通', '稀有', '史诗', '传说'];
    [0, 1, 2, 3].forEach(t => {
      const s = scales[field.id][t];
      rows.push(
        (t === 0 ? field.rank.padEnd(6) : '      ') + names[t].padEnd(8) +
        Math.round(inc[t]).toString().padStart(9) +
        ('×' + TARGET[t].toFixed(2)).padStart(11) +
        ('×' + s.toFixed(2)).padStart(8) +
        Math.round(inc[t] * s).toString().padStart(9)
      );
    });
    rows.push('      本场合计'.padEnd(14) + Math.round(before).toString().padStart(9) +
      '               ' + ' '.repeat(8) + Math.round(before).toString().padStart(9) +
      '  （保持不变）');
  });

  return { scales: scales, rows: rows };
}

/* ---------- 就地套一遍系数，返回「价格真的变了的条数」 ---------- */
function applyScalesOnce() {
  const sc = computeScales().scales;
  let n = 0;
  G.FISH.forEach(f => {
    const s = sc[f.field];
    if (!s) return;
    const nx = priceAfter(f, s[f.rar]);
    if (nx !== f.price) { f.price = nx; n++; }
  });
  return n;
}

/* ---------- 迭代到不动点 ----------
   鱼价是整数，所以「套一遍系数」会把结果再舍入一次：一次变换之后
   残差还有千分之几（便宜鱼上更明显），第二次运行仍会改动几十条。
   反复套到价格不再变化，写回的就是这个不动点。 */
function converge() {
  let rounds = 0, moved = -1;
  while (true) {
    moved = applyScalesOnce();
    rounds++;
    if (moved === 0) return { rounds: rounds, converged: true, residual: 0 };
    if (rounds >= MAX_ROUNDS) return { rounds: rounds, converged: false, residual: moved };
  }
}

function snapshotPrices() { return G.FISH.map(f => f.price); }
function restorePrices(snap) { G.FISH.forEach((f, i) => { f.price = snap[i]; }); }
function countChangedVs(snap) {
  let n = 0;
  G.FISH.forEach((f, i) => { if (f.price !== snap[i]) n++; });
  return n;
}
/* 不动点处再套一遍的残差（最大 |s-1|）与仍会变动的条数 */
function checkIdempotent() {
  const sc = computeScales().scales;
  let drift = 0, residual = 0;
  G.FIELDS.forEach(field => {
    sc[field.id].forEach(s => { drift = Math.max(drift, Math.abs(s - 1)); });
  });
  G.FISH.forEach(f => {
    const s = sc[f.field];
    if (s && priceAfter(f, s[f.rar]) !== f.price) residual++;
  });
  return { drift: drift, residual: residual };
}

/* ---------- 干跑：不改文件、跑完还原内存 ----------
   verify.js 用它断言「fish.js 已经在不动点上」（重跑数值链是 0 条改动）。 */
function dryRun() {
  const snap = snapshotPrices();
  const res = converge();
  const changed = countChangedVs(snap);
  const chk = checkIdempotent();
  restorePrices(snap);
  return { changed: changed, rounds: res.rounds, converged: res.converged, drift: chk.drift, residual: chk.residual };
}

/* ---------- 主流程 ---------- */
function main() {
  const DRY = process.argv.indexOf('--dry') >= 0;
  const first = computeScales();
  first.rows.forEach(r => console.log(r));

  const orig = snapshotPrices();
  const res = converge();
  if (!res.converged) {
    restorePrices(orig);
    console.error('\n✖ 归一化在 ' + MAX_ROUNDS + ' 轮内没有收敛（最后仍改动 ' + res.residual + ' 条）。');
    console.error('  说明各档收益目标与整数鱼价互相打架，请先检查 TARGET / 鱼价量级。\n');
    process.exit(1);
  }

  const chk = checkIdempotent();
  console.log('\n幂等自检：收敛用了 ' + res.rounds + ' 轮；不动点上再套一遍系数 → ' +
    (chk.residual === 0 ? '✔ 0 条改动' : '✖ ' + chk.residual + ' 条仍会变') +
    '（残差最大 ' + chk.drift.toExponential(1) + '）');
  if (chk.residual !== 0) {
    restorePrices(orig);
    console.error('\n✖ 本工具不幂等：第二次运行仍会改动 ' + chk.residual + ' 条鱼价。\n');
    process.exit(1);
  }

  /* ---------- 写回 fish.js ---------- */
  const FILE = path.join(ROOT, 'src/data/fish.js');
  const lines = fs.readFileSync(FILE, 'utf8').split('\n');
  /* 行格式：  F('D01', '鲫鱼', 0, 'fish', '#a8bcc9', '#7f95a4', 0.1, 0.8, 12, { w:1 });
     第 9 个参数是 price —— 用「最后一个数字 + 逗号 + 空格 + {」定位 */
  const RE = /^(\s*F\('([^']+)',(?:[^,]*,){7}\s*)(\d+)(\s*,\s*\{)/;
  const origById = {};
  G.FISH.forEach((f, i) => { origById[f.id] = orig[i]; });
  let changed = 0;

  const out = lines.map(line => {
    const m = line.match(RE);
    if (!m) return line;
    const id = m[2];
    const fish = G.FISH_ID[id];
    if (!fish || !first.scales.hasOwnProperty(fish.field)) return line;
    /* 内存里的 price 已收敛到不动点；和文件里的原值比，决定这行改不改 */
    if (fish.price === origById[id]) return line;
    changed++;
    return m[1] + fish.price + m[4] + line.slice(m[0].length);
  });

  if (DRY) {
    console.log('\n（--dry 模式，未写回。将改动 ' + changed + ' 条）\n');
  } else {
    fs.writeFileSync(FILE, out.join('\n'));
    console.log('\n✔ fish.js 已写回，共调整 ' + changed + ' 条鱼价');
    console.log('  下一步： node tools/balance.js && node tools/verify.js');
    console.log('  再跑一次本脚本应为「0 条」——verify.js 第 ⑭ 节会盯住这一点。\n');
  }
}

module.exports = {
  TARGET: TARGET, MAX_ROUNDS: MAX_ROUNDS,
  computeScales: computeScales, applyScalesOnce: applyScalesOnce, converge: converge,
  checkIdempotent: checkIdempotent, dryRun: dryRun,
  snapshotPrices: snapshotPrices, restorePrices: restorePrices,
};

if (require.main === module) main();
