/* =========================================================
   tools/balance.js  —  数值仿真（Node 运行，不参与游戏本体）
   用法： node tools/balance.js           # 只跑仿真、打印结论
          node tools/balance.js --emit    # 另外把「胜率表」写进 docs/balance-figures.js
          node tools/balance.js --check   # 不写盘，只比对盘上那份是不是最新的（退出码 0/1）
   ⚠️ `--emit` 与 `--check` **互斥**（一个要写、一个只比对）：同给退出码 2、报错说明；
      旧行为是 `--check` 静默吃掉 `--emit`（退出码 0、一行提示都没有 —— 实测过）。
   用法错（不认识的开关 / 互斥同给）退出码 2，判定在 `tools/argv.js`（唯一实现）。
   作用： 用「模拟玩家」跑大量对局，验证
          ① 各稀有度的拉扯胜率是否合理
          ② 拉扯时长是否在预期范围
          ③ 各钓场每小时收益曲线
          ④ 集齐图鉴（100%）的预估耗时

   ⚠️ 两种「口径」分工（2026-10-11 第 50 轮统一）：
      · **仿真结论**（① 的胜率 / 耗时）—— 只能跑对局得到 ⇒ `--emit` 写进
        `docs/balance-figures.js`，说明书 / GDD 引用它（**不许手抄**）。
      · **解析期望**（② 的节奏 / 鱼价 / 收益）—— 能从 `config` + `G.Loot` 一步算出
        ⇒ 直接调 `G.Loot.expectPrice()` 与 `CFG.misc.fightExpect`，
        与 `verify §8`、玩家向说明书**同一份口径**。
      （此前 ② 用 4000 场仿真的样本均值，尾重分布下**样本均值本身**就能差 40%
        —— 同一个「D 场每小时金币」在说明书里同时写着 2,532 / 4,277 / 9,702 三个数。）
   ========================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 命令行契约的唯一实现（判定 + 报错口径都在那儿，工具只声明自己的开关表） */
const { checkKnown, checkExclusive } = require('./argv');

/* 写回目标：**唯一一处声明**（同 `solve-drop.js` / `gen-collect-time.js`）——
   写完之后照它打印清单与还原命令，`verify [14-b]` 会拿它与真写盘路径对拍。 */
const WRITES = ['docs/balance-figures.js'];

const SEED = 20260101;
const argv = process.argv.slice(2);
/* 合法开关表 / 互斥表由本工具声明，`verify §32-s` 与文件里真正比对的开关逐项双向对拍。
   ⚠️ 判定放在**重活之前**：互斥同给要在开跑几万场仿真前就报错，别白跑一轮再说参数不对。 */
const KNOWN = ['--emit', '--check'];
const EXCLUSIVE = [['--emit', '--check', '--check 只比对、从不写盘，--emit 会被静默忽略']];
{
  const seen = checkKnown(argv, KNOWN, 'balance.js');
  checkExclusive(seen, EXCLUSIVE, 'balance.js');
}
const EMIT = argv.indexOf('--emit') >= 0;
const CHECK = argv.indexOf('--check') >= 0;

/* ---------- 固定随机种子 ----------
   本工具是「拉扯胜率」这类**仿真结论**的唯一来源，`docs/balance-figures.js` 就是它的产物。
   用 Math.random 的话每次跑出来的数都略有不同，文档里的表就永远对不上。
   换成定种子 LCG（Lehmer），保证同一份数据每次得到完全一样的结论。 */
let _seed = SEED;
Math.random = function () { _seed = (_seed * 48271) % 2147483647; return _seed / 2147483647; };

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

/* ---------------- 抽鱼 / 单竿耗时 ----------------
   这里原先有 `rollFish()` / `pickWeighted()` / `waitTime()` 三份**本地实现** ——
   它们是 `G.Loot` 出现之前的遗留，与 `Loot.rollFish` / `Loot.biteTime` **各写一遍**。
   2026-10-11 第 50 轮清掉：② 段改走 `G.Loot` 之后它们就再没人调用了，
   而「同一套掉率写两份」正是本项目最容易静默分家的形状（biteMul 那次就是）。
   ⇒ 抽鱼一律 `G.Loot.rollFish()`；咬口时长一律 `G.Loot.biteTime()`。 */

const rollKg = (fish) => G.Loot.rollKg(fish);

/* ---------------- 主流程 ---------------- */
const ROUNDS = 4000;

/* 收进生成物的数必须与**打印出来的那一串**逐字一致：
   ⚠️ 不能用 `Math.round(x*10)/10` —— 它与 `x.toFixed(1)` 在「恰好 .x5」上会分家
   （实测 史诗·普通玩家胜率 = 90.55%：`toFixed(1)` → "90.5"、`Math.round` → 90.6
   ⇒「控制台说 90.5、生成物说 90.6」，同一张表两种说法且不报错）。
   统一走 `Number(x.toFixed(n))`：页面再 `.toFixed(n)` 回来与这里逐字相同。 */
const r1 = (x) => Number(x.toFixed(1));
const r0 = (x) => Number(x.toFixed(0));

/* ① 的结论要写进 `docs/balance-figures.js` ⇒ 收集成结构化行，而不是只往 stdout 打 */
const fightRows = [];
console.log(`\n=== ① 张力拉扯胜率 / 耗时（每档每种玩法 ${ROUNDS} 场）===`);
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
  /* ⚠️ 必须与上面打印出来的那一串逐字一致 —— 见文件里 r1() 上面那段说明 */
  fightRows.push({ rar: rar, name: CFG.rarity[rar].name,
                   skillWin: r1(a.win * 100), skillSec: r1(a.time),
                   normWin: r1(b.win * 100), normSec: r1(b.time), snap: r1(b.snap * 100) });
}

/* ② 走**解析期望**（不是 4000 场仿真的样本均值）。
   理由见文件头：售价尾部极重，样本均值本身就能差 40%（同一个「D 场每小时金币」
   在说明书里曾同时写着 2,532 / 4,277 / 9,702 三个数）。
   这里刻意与 `verify §8`、`main.js: avgCycle()`、离线补算、`G.Loot.expectPrice()`
   用**同一份口径** ⇒ 改 ① 的仿真结论不会悄悄改掉经济表。 */
function biteExpect(rar, field) {      // 咬口时长的期望：**只有 Loot 一处实现**，这里只是转调
  return G.Loot.biteExpect(rar, { field: field });
}
console.log('\n=== ② 各钓场节奏（每竿：等待 + 拉扯，解析期望）===');
console.log('钓场    平均等待   平均拉扯   单竿合计   每小时竿数  平均鱼价   每小时金币');
/* ②的结果要留给 ⑤（水族箱产出复核）用，所以顺手存下来 */
const activeIncome = {};   // fid -> 金/小时
const avgPriceOf = {};     // fid -> 平均鱼价
const samplePrices = {};   // fid -> 该场鱼价样本（用于算「顶配水族箱」上界）
const paceRows = [];
for (const field of G.FIELDS) {
  const w = G.Loot.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  let avgWait = 0, avgFight = 0;
  for (let t = 0; t < 4; t++) {
    avgWait += (w[t] / tw) * biteExpect(t, field);
    avgFight += (w[t] / tw) * CFG.misc.fightExpect[t];
  }
  const perFish = avgWait + avgFight;
  const perHour = 3600 / perFish;
  const avgVal = G.Loot.expectPrice(field);          // 解析期望鱼价（确定性）
  activeIncome[field.id] = perHour * avgVal;
  avgPriceOf[field.id] = avgVal;
  /* ⑤ 的「顶配」是「该场最贵的 24 条」——它要的是**分布上界**而不是均值，
     所以这里仍然采一批样本（不跑对局，只要价格）。 */
  const prices = [];
  for (let i = 0; i < ROUNDS; i++) {
    const pick = G.Loot.rollFish(field, {});
    prices.push(G.Loot.price(pick.fish, G.Loot.rollKg(pick.fish), G.Loot.rollColor(pick.rar), false));
  }
  samplePrices[field.id] = prices;
  paceRows.push({ rank: field.rank, name: field.name,
                  wait: r1(avgWait), fight: r1(avgFight), cycle: r1(perFish),
                  perHour: r0(perHour), price: r1(avgVal), income: r0(perHour * avgVal) });
  console.log(
    `${field.rank.padEnd(5)}  ${avgWait.toFixed(1).padStart(7)}s  ` +
    `${avgFight.toFixed(1).padStart(7)}s  ${perFish.toFixed(1).padStart(8)}s  ` +
    `${perHour.toFixed(0).padStart(9)}  ${avgVal.toFixed(1).padStart(8)}  ${(perHour * avgVal).toFixed(0).padStart(10)}`
  );
}

/* ---------------- ⑤ 水族箱被动收益复核 ----------------
   水族箱是「长线收集」的回报：养着的鱼按身价的固定比例每小时产金币。
   复核两件事：
     ① 平均情况 —— 用该场平均鱼塞满，产出应该只是「一点零花」（≤10% 主动收益）
     ② 上界     —— 把该场最贵的 24 条（水族箱扩容到顶的格数）塞进去，
                   产出不能超过该场主动收益（否则躺着比钓鱼赚，玩法就废了）
   ⚠️ 被动收益**故意不进**第 ⑧ 节「各场每小时金币单调递增」的断言：
      它不该改变主动玩法（钓鱼）的收益曲线，只是额外的一小笔。
   ⚠️ 改 config.storage.tankYieldRate 必须重跑本文件。 */
/* 单条产出走 G.Loot.tankYield（与游戏本体共用一份公式） */
const ty = (price) => G.Loot.tankYield(price);
const TANK_SLOTS_MAX = CFG.storage.tankCap + CFG.storage.tankStep * CFG.storage.tankCosts.length;
console.log(`\n=== ⑤ 水族箱被动收益（满格 ${TANK_SLOTS_MAX} 格，单条 = ` +
            `${CFG.storage.tankYieldBase} × √(身价 / ${CFG.storage.tankYieldRef}) 金/时）===`);
console.log('钓场   满格平均产出   占主动收益   顶配产出(最贵24条)   占主动收益   结论');

let tankBad = 0;
for (const field of G.FIELDS) {
  const act = activeIncome[field.id];
  const avg = ty(avgPriceOf[field.id]) * TANK_SLOTS_MAX;
  const top = samplePrices[field.id].slice().sort((a, b) => b - a).slice(0, TANK_SLOTS_MAX)
    .reduce((a, b) => a + ty(b), 0);
  const rAvg = avg / act, rTop = top / act;
  const bad = rAvg > 0.10 || rTop > 1.0;
  if (bad) tankBad++;
  console.log(
    `${field.rank.padEnd(5)} ${avg.toFixed(0).padStart(11)}   ` +
    `${(rAvg * 100).toFixed(1).padStart(8)}%   ${top.toFixed(0).padStart(16)}   ` +
    `${(rTop * 100).toFixed(1).padStart(8)}%   ${bad ? '✖ 失控' : '✔ 合理'}`
  );
}
if (tankBad) {
  console.log(`\n✖ 水族箱被动收益失控：${tankBad} 个钓场越界。` +
              `把 config.storage.tankYieldRate（当前 ${TANK_RATE}）调小。`);
  process.exitCode = 1;
} else {
  console.log('  ✔ 全部钓场：平均满格 ≤ 主动收益 10%，顶配满格 ≤ 主动收益 100%');
}
console.log('  （顶配 = 该场最贵的 24 条鱼；它们本身价值极高，' +
            '而且养起来就卖不掉了 —— 机会成本由玩家自己权衡）');

/* ---------------- ③ 图鉴收集耗时（用游戏真实抽卡逻辑蒙特卡洛） ---------------- */
const FIGHT_EXP = CFG.misc.fightExpect;   // 每竿期望耗时（含失败重来），秒

function simulateCollect(field, needCount, opts) {
  const seen = new Set();
  let casts = 0, sec = 0;
  while (seen.size < needCount && casts < 4000000) {
    const pick = G.Loot.rollFish(field, opts);
    seen.add(pick.fish.id);
    casts++;
    sec += G.Loot.biteTime(pick.rar, { field: field }) + FIGHT_EXP[pick.rar];
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
  const mul = field.biteMul || 1;
  for (let t = 0; t < 4; t++) {
    /* 深水咬口倍率只作用于普通/稀有档，与 loot.js 保持一致 */
    const bite = (CFG.rarity[t].timeMin + CFG.rarity[t].timeMax) / 2 * (t <= 1 ? mul : 1);
    c += (w[t] / tw) * (bite + FIGHT_EXP[t]);
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
/* ---------------- ④ 全颜色 × 全品类收集（完美主义目标） ---------------- */
function fmtLong(h) {
  if (h < 1) return (h * 60).toFixed(0) + ' 分钟';
  if (h < 48) return h.toFixed(1) + ' 小时';
  if (h < 24 * 90) return (h / 24).toFixed(1) + ' 天';
  if (h < 24 * 365 * 3) return (h / 24 / 365).toFixed(2) + ' 年';
  return (h / 24 / 365).toFixed(0) + ' 年';
}

console.log('\n=== ④ 全颜色 × 全品类收集耗时（完美目标，非解锁条件） ===');
console.log('说明：解锁只看「品种」，颜色完全不参与解锁判定。下面是纯粹的理论极限。');
console.log(`钓场   组合数   收集全部组合均值   其中：集齐1条鱼${CFG.colorMorphs.length}色的均值`);

let totalCombos = 0, totalHours = 0;
for (const field of G.FIELDS) {
  const probs = realProbs(field, {});
  const cyc = cycleOf(field);
  /* 每条鱼的每种颜色都是一个独立目标 */
  const expanded = [];
  probs.forEach(x => {
    CFG.colorMorphs.forEach(cm => expanded.push(x.p * G.Loot.colorProb(cm, x.fish.rar)));
  });
  const casts = expectedAll(expanded);
  const hours = casts * cyc / 3600;
  /* 集齐「某一条鱼」的全部颜色：用最稀有的那条鱼的摄食频率做基准 */
  const rarest = probs.reduce((a, b) => (b.p < a.p ? b : a));
  const colorOnly = expectedAll(CFG.colorMorphs.map(c => G.Loot.colorProb(c, rarest.fish.rar))) / rarest.p;
  totalCombos += expanded.length;
  totalHours += hours;
  console.log(
    `${field.rank.padEnd(5)} ${String(expanded.length).padStart(6)}   ` +
    `${fmtLong(hours).padStart(14)}   ${fmtLong(colorOnly * cyc / 3600).padStart(16)}`
  );
}
console.log(`\n全部 7 个钓场共 ${totalCombos} 个「品种×颜色」组合，收齐约需 ${fmtLong(totalHours)}`);
console.log('（这就是为什么解锁只看品种 —— 颜色当彩蛋，不当门槛）');

console.log('\n累计解锁节奏（达到该钓场图鉴 100% 时的总时长）：');
let c = 0;
G.FIELDS.forEach((f, i) => {
  c += rowData[i].h100;
  console.log(`  ${f.rank.padEnd(4)} ${f.name.padEnd(10)} → 累计 ${c.toFixed(1)} h`);
});
console.log(`\n全部 7 个钓场 100% 收满 ≈ ${c.toFixed(0)} 小时`);
console.log('');

/* ---------------- 收尾：把「仿真结论」写进 docs/balance-figures.js ----------------
   ① 的胜率表 / ② 的节奏表都收进同一个生成物：
     · 胜率是**仿真结论**（说明书页内算不出来）⇒ 说明书 / GDD 必须引用它，不许手抄；
     · 节奏表顺手一起写，好让 `verify §33-l` 能拿「页面里显示的」与「工具算出来的」对拍。
   写回目标在文件头的 `WRITES` 一处声明（`verify [14-b]` 会与真写盘路径对拍）。 */
function figuresSource() {
  const dump = (rows, keys) => rows.map(r =>
    '    { ' + keys.map(k => `${k}: ${JSON.stringify(r[k])}`).join(', ') + ' },').join('\n');
  return `/* =========================================================
   docs/balance-figures.js  —  《说明书》与《GDD》共用的「数值结论」
   =========================================================
   🔴 **本文件由 \`node tools/balance.js --emit\` 生成，不要手改。**
      手改会在下次 --emit 时被覆盖；\`node tools/balance.js --check\` 会当场报红。
   · 为什么要有这个文件：\`fight\` 那一节是**仿真结论**（4 档 × 2 档玩家 × ${ROUNDS} 场对局），
     玩家向说明书在页内**算不出来** —— 只能由生成器产出、页面引用。
     此前它是一张页内手抄常量表，改 \`config.js\` 的 \`fight.*\` 不会动它，**一句都不报错**。
   · \`pace\` 那一节是**解析期望**（页面自己也能算，见 \`G.Loot.expectPrice\`），
     写在这里是为了让门禁能把「页面显示的」与「工具算出来的」逐格对拍。
   · 复现： \`${'node tools/balance.js --emit'}\`   （种子固定 ${SEED}，两次跑逐字节相同）
   ========================================================= */
window.G = window.G || {};
G.BALANCE_FIGURES = {
  seed: ${SEED},
  rounds: ${ROUNDS},                 // ① 每档每种玩法的对局数
  gen: 'node tools/balance.js --emit',
  fight: [
${dump(fightRows, ['rar', 'name', 'skillWin', 'skillSec', 'normWin', 'normSec', 'snap'])}
  ],
  pace: [
${dump(paceRows, ['rank', 'name', 'wait', 'fight', 'cycle', 'perHour', 'price', 'income'])}
  ],
};
`;
}
if (EMIT || CHECK) {
  const target = WRITES[0];
  const next = figuresSource();
  const cur = fs.existsSync(path.join(ROOT, target)) ? fs.readFileSync(path.join(ROOT, target), 'utf8') : null;
  const norm = (s) => s === null ? null : s.replace(/\r\n/g, '\n');
  if (CHECK) {
    if (norm(cur) === norm(next)) {
      console.log(`\n✔ ${target} 与实跑结论一致（种子 ${SEED}、每档 ${ROUNDS} 场）。`);
    } else {
      console.log(`\n✖ ${target} 已过期 —— 与实跑结论不一致。`);
      console.log(`   重跑：node tools/balance.js --emit` +
                  `   （不想留这次改动：git checkout -- ${WRITES.join(' ')}）`);
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(path.join(ROOT, WRITES[0]), next);
    console.log(`\n写 ${WRITES[0]}（不想留这次改动：git checkout -- ${WRITES.join(' ')}）`);
    console.log(`  fight ${fightRows.length} 行 / pace ${paceRows.length} 行 · 种子 ${SEED} · 每档 ${ROUNDS} 场`);
  }
}

