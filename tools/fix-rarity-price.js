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

   用法： node tools/fix-rarity-price.js       ← 会直接改写 src/data/fish.js
   流程： python tools/gen-fish.py && node tools/solve-drop.js
          && node tools/fix-rarity-price.js && node tools/balance.js
          && node tools/verify.js
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

/* 目标：同场内，各档「每小时收益」相对普通档的倍数 */
const TARGET = [1, 1.8, 4.0, 10.0];
const DRY = process.argv.indexOf('--dry') >= 0;

/* ---------- 期望工具（解析式，不用蒙特卡洛，避免稀有鱼带偏） ---------- */
const kgCache = {};
function fishKgMul(f) {
  if (kgCache[f.id] != null) return kgCache[f.id];
  const mid = (f.minKg + f.maxKg) / 2;
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

/* ---------- 计算每场每档的缩放系数 ---------- */
const scales = {};   // fid -> [s0,s1,s2,s3]
console.log('\n钓场   档位        原收益/时   目标比值   缩放   调整后');
console.log('-'.repeat(70));

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
    console.log(
      (t === 0 ? field.rank.padEnd(6) : '      ') + names[t].padEnd(8) +
      Math.round(inc[t]).toString().padStart(9) +
      ('×' + TARGET[t].toFixed(2)).padStart(11) +
      ('×' + s.toFixed(2)).padStart(8) +
      Math.round(inc[t] * s).toString().padStart(9)
    );
  });
  console.log('      本场合计'.padEnd(14) + Math.round(before).toString().padStart(9) +
    '               ' + ' '.repeat(8) + Math.round(before).toString().padStart(9) +
    '  （保持不变）');
});

/* ---------- 写回 fish.js ---------- */
const FILE = path.join(ROOT, 'src/data/fish.js');
let src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

/* 行格式：  F('D01', '鲫鱼', 0, 'fish', '#a8bcc9', '#7f95a4', 0.1, 0.8, 12, { w:1 });
   第 9 个参数是 price —— 用「最后一个数字 + 逗号 + 空格 + {」定位 */
const RE = /^(\s*F\('([^']+)',(?:[^,]*,){7}\s*)(\d+)(\s*,\s*\{)/;
let changed = 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const out = lines.map(line => {
  const m = line.match(RE);
  if (!m) return line;
  const id = m[2];
  const fish = G.FISH_ID[id];
  if (!fish) return line;
  const s = scales[fish.field];
  if (!s) return line;
  /* 同一场同档用同一个系数；首捕奖励 ×3 与颜色系数都不受影响 */
  const next = clamp(Math.round(fish.price * s[fish.rar]), 1, 99999999);
  if (next === fish.price) return line;
  changed++;
  return m[1] + next + m[4] + line.slice(m[0].length);
});

if (DRY) {
  console.log('\n（--dry 模式，未写回。将改动 ' + changed + ' 条）\n');
} else {
  fs.writeFileSync(FILE, out.join('\n'));
  console.log('\n✔ fish.js 已写回，共调整 ' + changed + ' 条鱼价');
  console.log('  下一步： node tools/balance.js && node tools/verify.js\n');
}
