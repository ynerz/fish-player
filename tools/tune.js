/* =========================================================
   tools/tune.js  —  参数扫描：为每个稀有度挑选合适的「逃窜强度」
   用法： node tools/tune.js
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 固定随机种子 ----------
   扫描要跑真实对局，而 fight.js 内部用 Math.random —— 不固定种子的话，
   同一份数值每次扫出来的胜率都不一样，没法判断「调完到底变好还是变坏」。
   与 balance.js / verify.js 保持同一套口径（Lehmer LCG）。 */
let _seed = 20260101;
Math.random = function () { _seed = (_seed * 48271) % 2147483647; return _seed / 2147483647; };

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, CFG = G.CONFIG;

const PROFILE = {
  熟练: { react: 0.15, warnTh: 0.50, hi: 0.80, lo: 0.58 },
  普通: { react: 0.32, warnTh: 0.15, hi: 0.86, lo: 0.50 },
};

function sim(fish, kg, prof) {
  const f = G.Fight.begin({ fish, kg, tensionMax: 100, reelMul: 1 });
  let t = 0, hold = true, ht = 0;
  const dt = 1 / 60, maxT = f.tensionMax;
  while (!f.over && t < 300) {
    ht += dt;
    if (ht >= prof.react) {
      ht = 0;
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

const N = Number(process.env.N || 1200);
const STEP = Number(process.env.STEP || 4);
const ONLY = process.env.RAR ? process.env.RAR.split(',').map(Number) : [0, 1, 2, 3];
console.log('稀有度    dashPower   熟练胜率  熟练耗时   普通胜率');
for (const rar of ONLY) {
  const fish = G.FISH.find(f => f.rar === rar);
  const base = CFG.rarity[rar].fight;
  const orig = base.dashPower;
  const cands = [];
  for (let p = Math.max(20, orig - 8); p <= orig + 8; p += STEP) cands.push(p);
  cands.forEach(p => {
    base.dashPower = p;
    const out = {};
    Object.keys(PROFILE).forEach(n => {
      let w = 0, s = 0;
      for (let i = 0; i < N; i++) {
        const r = sim(fish, G.Loot.rollKg(fish), PROFILE[n]);
        if (r.result === 'success') { w++; s += r.time; }
      }
      out[n] = { win: w / N, time: w ? s / w : 0 };
    });
    console.log(
      `${CFG.rarity[rar].name.padEnd(6)}  ${String(p).padStart(9)}  ` +
      `${(out['熟练'].win * 100).toFixed(1).padStart(8)}%  ${out['熟练'].time.toFixed(1).padStart(7)}s  ` +
      `${(out['普通'].win * 100).toFixed(1).padStart(8)}%`
    );
  });
  base.dashPower = orig;
  console.log('');
}
