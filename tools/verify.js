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

/* ---------- 固定随机种子 ----------
   第 ⑦ / ⑧ 节与 estOwnHours 复算都靠采样。用 Math.random 的话，
   同一份数据每次跑出来的数字都略有不同 —— 实测第 ⑧ 节的 C/D 比值
   会偶尔掉到 1.15 的警戒线以下（30 次里 1 次），于是「自检通过 0 警告」
   变成抽奖。门禁必须可复现，所以这里换成定种子的 LCG。
   踩过的坑：fish.js 的价格做过一次归一化（见 fix-rarity-price.js），
   C/D 的比值变近警戒线，这个老毛病才被暴露出来。 */
let _vseed = 20260101;
Math.random = function () { _vseed = (_vseed * 48271) % 2147483647; return _vseed / 2147483647; };

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/data/goals.js',
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
   只断言「曲线不许倒退」这个设计不变量。 */console.log('\n[8] 各场每小时金币应单调递增');
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

/* ---------------- 10. 新手引导：config ↔ 实现的一致性 ----------------
   和第 ⑨ 节同一类坑：步骤写在 config，规则写在 tutorial.js。
   加了一步却忘了写规则 → 那一步永远学不会；place 拼错 → 气泡飘到左上角。
   两种都是「不报错的静默失败」，所以这里做交叉检查。 */
console.log('\n[10] 新手引导：每一步都有实现与定位');
let tutBad = 0;
const tutSrc  = fs.readFileSync(path.join(ROOT, 'src/ui/tutorial.js'), 'utf8');
const tutHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tutCss  = fs.readFileSync(path.join(ROOT, 'assets/css/style.css'), 'utf8');
const tSteps  = (CFG.tutorial && CFG.tutorial.steps) || [];

if (!tSteps.length) { err('config.tutorial.steps 是空的'); tutBad++; }
if (typeof CFG.tutorial.enabled !== 'boolean') { err('config.tutorial.enabled 不是布尔值'); tutBad++; }
if (!(CFG.tutorial.holdNeed > 0) || !(CFG.tutorial.doneHold > 0)) {
  err('tutorial.holdNeed / doneHold 必须是正数'); tutBad++;
}
const tSeen = {};
tSteps.forEach(s => {
  if (tSeen[s.id]) { err(`引导步骤 id 重复：${s.id}`); tutBad++; }
  tSeen[s.id] = 1;
  if (!new RegExp('(^|\\n)\\s*' + s.id + '\\s*:\\s*function').test(tutSrc)) {
    err(`步骤「${s.id}」在 tutorial.js 的 RULES 里没有完成条件（这一步永远学不会）`); tutBad++;
  }
  if (!s.text || !s.tip) { err(`步骤「${s.id}」缺文案或提示`); tutBad++; }
  if (['idle', 'bite', 'fight'].indexOf(s.showWhen) < 0) {
    err(`步骤「${s.id}」的 showWhen 非法：${s.showWhen}`); tutBad++;
  }
});
/* 每个用到的 place 都必须有 .tut-bubble.at-<place> 定位规则 */
const tPlaces = [];
tSteps.forEach(s => { if (tPlaces.indexOf(s.place) < 0) tPlaces.push(s.place); });
tPlaces.forEach(p => {
  if (!new RegExp('\\.tut-bubble\\.at-' + p + '\\b').test(tutCss)) {
    err(`步骤位置「${p}」在 style.css 里没有 .tut-bubble.at-${p} 定位规则（气泡会飘到左上角）`); tutBad++;
  }
});
const bubbleRule = (tutCss.match(/\.tut-bubble\{[^}]*\}/) || [''])[0];
if (!/position:absolute/.test(bubbleRule)) { err('.tut-bubble 必须是绝对定位'); tutBad++; }
if (!/pointer-events:\s*none/.test(bubbleRule)) {
  err('.tut-bubble 必须 pointer-events:none（否则会挡住抛竿按钮，变成阻塞式引导）'); tutBad++;
}
if (!/id="tutBubble"/.test(tutHtml)) { err('index.html 里没有 #tutBubble 容器'); tutBad++; }
const tIdx = tutHtml.indexOf('src/ui/tutorial.js'), mIdx = tutHtml.indexOf('src/main.js');
if (!(tIdx > 0 && mIdx > tIdx)) {
  err('tutorial.js 必须在 index.html 里、且在 main.js 之前加载'); tutBad++;
}
if (!tutBad) {
  ok(`${tSteps.length} 步：规则 / 文案 / 定位 / 顺序全部对得上`);
  ok('.tut-bubble 是绝对定位 + 非阻塞（pointer-events:none）');
}

/* ---------------- 11. 入口完整性 + 模块按序可加载 ----------------
   index.html 是唯一的「装配清单」，它和 src/ 一旦对不上就是白屏。
   三类静默失败在这里一次抓住：
     · 新增模块却忘了在 index.html 里引 → 运行时 undefined，页面半死
     · 脚本顺序错（用到的模块还没定义）  → 一加载就抛，整个游戏起不来
     · 模块里有语法错误                  → 同上
   devtools.js / main.js 在加载时就会碰 location / document，
   在 Node 里只做「语法解析」不做「执行」——
   判据：报错是 ReferenceError 且说的是浏览器全局 → 可预期，放过；
   其他任何异常（含「顺序错」引发的 TypeError）一律报错。 */
console.log('\n[11] 入口完整性：index.html 的 <script src> ↔ src/ 下的 .js');
const BLD = require('./build.js');
const htmlRaw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const listed = BLD.collectScripts(htmlRaw);
let entryBad = 0;

/* 11-a 引用的文件都存在、且不重复 */
const miss = listed.filter(r => !fs.existsSync(path.join(ROOT, r)));
if (miss.length) { err('index.html 引用了不存在的脚本：' + miss.join('、')); entryBad++; }
const seenS = {}, dupS = [];
listed.forEach(r => { if (seenS[r]) dupS.push(r); seenS[r] = 1; });
if (dupS.length) { err('index.html 重复引用脚本：' + dupS.join('、')); entryBad++; }

/* 11-b src/ 下每一个 .js 都必须被引用（加了新模块忘记挂 = 白屏） */
const onDisk = [];
(function walk(dir) {
  fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
    const rel = dir + '/' + name;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.js$/.test(name)) onDisk.push(rel);
  });
})('src');
const notWired = onDisk.filter(r => listed.indexOf(r) < 0);
const ghost = listed.filter(r => onDisk.indexOf(r) < 0 && fs.existsSync(path.join(ROOT, r)));
if (notWired.length) { err('src/ 下这些模块没被 index.html 引用（永远不会被加载）：' + notWired.join('、')); entryBad++; }
if (ghost.length) { err('index.html 引了 src/ 目录之外的脚本：' + ghost.join('、')); entryBad++; }
if (listed[0] !== BLD.MUST_BE_FIRST) {
  err(`第一个脚本应是 ${BLD.MUST_BE_FIRST}（它建 window.G），实际是 ${listed[0]}`); entryBad++;
}
if (listed[listed.length - 1] !== BLD.MUST_BE_LAST) {
  err(`最后一个脚本应是 ${BLD.MUST_BE_LAST}（它 boot 整个游戏），实际是 ${listed[listed.length - 1]}`); entryBad++;
}

/* 11-c 样式表（缺了游戏能跑但没皮肤，属于静默降级） */
const cssListed = BLD.collectStyles(htmlRaw);
if (!cssListed.length) { err('index.html 里没有外链样式表'); entryBad++; }
cssListed.forEach(r => {
  if (!fs.existsSync(path.join(ROOT, r))) { err('样式表不存在：' + r); entryBad++; }
});

/* 11-d 按 index.html 的顺序真的加载一遍 */
const vm = require('vm');
const silent = { log() {}, warn() {}, error() {} };
const sandbox = { console: silent, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, JSON };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
vm.createContext(sandbox);
const DOM_GLOBALS = ['document', 'location', 'navigator', 'innerWidth', 'innerHeight',
  'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Image', 'Audio', 'screen'];
const isDomRef = e => e && e.name === 'ReferenceError' &&
  new RegExp('^(' + DOM_GLOBALS.join('|') + ') is not defined').test(String(e.message));
const deferred = [];
let ranCount = 0;
listed.forEach(rel => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let sc;
  try { sc = new vm.Script(src, { filename: rel }); }
  catch (e) { err(`${rel} 有语法错误：${e.message}`); entryBad++; return; }
  try { sc.runInContext(sandbox); ranCount++; }
  catch (e) {
    if (isDomRef(e)) { deferred.push(rel); return; }   // 需要 DOM，可预期
    err(`${rel} 按 index.html 的顺序加载就抛错：${e.name}: ${e.message}（多半是顺序错了）`); entryBad++;
  }
});

/* 11-e 加载完，模块表必须是齐的 */
const WANT = ['CONFIG', 'FIELDS', 'FIELD_MAP', 'FISH', 'FISH_ID', 'FISH_BY_FIELD', 'FISH_BY_FIELD_RARITY',
  'TOTAL_FISH', 'BAITS', 'RODS', 'LINES', 'DECORS', 'ACHIEVEMENTS',
  'U', 'Platform', 'Audio', 'Loot', 'State', 'Goals', 'FishArt', 'Scene', 'Fight', 'Weather', 'Track',
  'Fishing', 'Panels', 'Hud', 'Tutorial'];
const gone = WANT.filter(k => !sandbox.G || sandbox.G[k] == null);
if (gone.length) { err('按序加载后缺这些全局模块：' + gone.join('、')); entryBad++; }

/* 11-f 版本号单一来源：文档基线必须跟着 config.js 走
   （踩过：CFG.version 一度停在 0.4.0，设置面板和文档各说各话） */
const todoTxt = fs.readFileSync(path.join(ROOT, 'docs/改进待办.md'), 'utf8');
const baseM = todoTxt.match(/当前基线：v([\d.]+)/);
if (!baseM) { err('docs/改进待办.md 头部找不到「当前基线：vX.Y.Z」'); entryBad++; }
else if (baseM[1] !== CFG.version) {
  err(`版本号不一致：config.js 是 v${CFG.version}，docs/改进待办.md 头部基线是 v${baseM[1]}`); entryBad++;
}

if (!entryBad) {
  ok(`入口 ${listed.length} 个脚本 == src/ 下 ${onDisk.length} 个模块，顺序正确`);
  ok(`按 index.html 顺序加载：${ranCount} 个模块在 Node 里跑通` +
     (deferred.length ? `（${deferred.length} 个需要 DOM，跳过执行：${deferred.join('、')}）` : ''));
  ok(`${WANT.length} 个全局模块齐全（G.CONFIG … G.Tutorial）`);
  ok(`版本号单一来源：config.js 与 docs/改进待办.md 头部基线都是 v${CFG.version}`);
}


/* ---------------- 12. 画布按下 == 主按钮按下 ----------------
   踩过的坑：`src/main.js` 的画布 pointerdown 曾按 state 写白名单
   （只列了 idle/bite/waiting），漏掉 fight → **拉扯中按住画布收不了线**；
   而松手是 window 级全局监听，于是「按下无效、抬起生效」，
   鱼必脱钩且不报任何错。这条断言锁住「画布按下直接透传 handlePress()」。 */
console.log('\n[12] 画布按下必须等同于主按钮（不得再写状态白名单）');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
let inputBad = 0;

if (!/function handlePress\s*\(/.test(mainSrc)) { err('main.js 里没有 handlePress()'); inputBad++; }
const hudSrc = fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8');
if (!/U\.on\(window,\s*'blur'/.test(hudSrc)) {
  err('hud.js 没有在 window blur 时兜底放线 —— 指针在窗口外抬起（拖出浏览器 / 切应用）会一直收线到断线');
  inputBad++;
}
const platSrc = fs.readFileSync(path.join(ROOT, 'src/core/platform.js'), 'utf8');
if (!/up:\s*function\s*\(\s*fn\s*\)/.test(platSrc)) {
  err('platform.js 的 input.up 签名必须是 up(fn) —— 写成 up(el, fn) 会让松手通道整体失效');
  inputBad++;
}
const sceneAt = mainSrc.indexOf("input.down(U.$('#scene')");
if (sceneAt < 0) { err('main.js 里找不到画布 pointerdown 绑定（#scene）'); inputBad++; }
else {
  const body = mainSrc.slice(sceneAt, mainSrc.indexOf('});', sceneAt));
  if (!/handlePress\(\)/.test(body)) { err('画布按下回调没有调用 handlePress()'); inputBad++; }
  if (/getState\(\)|\bst\s*===\s*'/.test(body)) {
    err('画布按下回调里仍按 state 白名单过滤 —— 漏一个状态就是「按住不收线」，应直接透传 handlePress()');
    inputBad++;
  }
}
if (!inputBad) ok('画布按下 = 主按钮按下（无状态白名单，fight 状态也能收线）');


/* ---------------- 13. 张力安全线只有一处来源 ----------------
   A4 的遗留：安全线数值写在 config，但 CSS 里又硬编码了一份 78%。
   改 config 时 CSS 不跟着变 → 「改一处不生效」，而且没有任何报错。
   现在统一由 hud.js 在 init 时从 G.Fight.SAFE 写进行内样式。 */
console.log('\n[13] 张力安全线只有一处来源（CFG.fight.safeRatio）');
let safeBad = 0;
const safeR = CFG.fight.safeRatio;
if (!(safeR > 0 && safeR < 1)) { err(`CFG.fight.safeRatio 不是 0~1 的占比：${safeR}`); safeBad++; }
if (G.Fight.SAFE !== safeR) {
  err(`G.Fight.SAFE(${G.Fight.SAFE}) 与 CFG.fight.safeRatio(${safeR}) 不一致`); safeBad++;
}
const safeCss = fs.readFileSync(path.join(ROOT, 'assets/css/style.css'), 'utf8');
['zone-safe', 'danger-mark'].forEach(cls => {
  const rule = (safeCss.match(new RegExp('\\.tension-track\\s+\\.' + cls + '\\s*\\{[^}]*\\}')) || [''])[0];
  if (!rule) { err(`style.css 里找不到 .tension-track .${cls} 规则`); safeBad++; return; }
  if (/(width|left)\s*:\s*[^;]*\d\s*%/.test(rule)) {
    err(`.tension-track .${cls} 的 width/left 又写死了百分比（应由 JS 从 CFG.fight.safeRatio 写入）`); safeBad++;
  }
});
const hudSrcSafe = fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8');
if (!/zoneSafe[\s\S]{0,200}G\.Fight\.SAFE/.test(hudSrcSafe) ||
    !/dangerMark[\s\S]{0,200}G\.Fight\.SAFE/.test(hudSrcSafe)) {
  err('hud.js 没有把 G.Fight.SAFE 写进安全区带 / 危险标（改了 config 界面不跟着变）'); safeBad++;
}
if (!safeBad) ok(`安全线 ${(safeR * 100).toFixed(0)}% 只存在于 config.js，CSS 里没有第二份`);


/* ---------------- 14. 数值链幂等：fish.js 必须已归一化 ----------------
   踩过的坑：fix-rarity-price.js 的「重量系数」用 Math.random 采样估计，
   两次运行结果不同 → 写回的鱼价在最后一位抖动 → 后来「按标准顺序重跑数值链」
   会莫名改掉 fish.js 上百行，工作区变脏、容易被误当成自己的改动提交。
   现在该脚本固定了随机种子并迭代到不动点，跑第二遍必须是 0 条改动。
   这里直接干跑一次，把「第二次运行会不会改文件」变成一条可执行的断言。 */
console.log('\n[14] 数值链幂等：fix-rarity-price.js 干跑应为 0 条改动');
let chainBad = 0;
try {
  /* 用模块入口干跑（不写盘、跑完还原内存），比开子进程更稳也更快 */
  const FP = require(path.join(ROOT, 'tools/fix-rarity-price.js'));
  const dr = FP.dryRun();
  if (!dr.converged) {
    err(`归一化在 ${FP.MAX_ROUNDS} 轮内没有收敛（仍要改动 ${dr.residual} 条）`); chainBad++;
  } else if (dr.changed !== 0) {
    err(`fish.js 未处于归一化状态：干跑还会改动 ${dr.changed} 条鱼价（标准数值链重跑会把工作区改脏）`); chainBad++;
  } else if (dr.residual !== 0) {
    err(`不动点上再套一遍仍会改动 ${dr.residual} 条 —— 本工具不幂等`); chainBad++;
  }
  const dr2 = FP.dryRun();
  if (dr2.changed !== dr.changed || dr2.rounds !== dr.rounds) {
    err('连跑两次干跑结果不一致 —— 随机源没固定住'); chainBad++;
  }
  if (!chainBad) {
    ok(`fish.js 在不动点上：干跑 0 条改动（收敛 ${dr.rounds} 轮，残差 ${dr.drift.toExponential(1)}）`);
    ok('干跑可复现：连跑两次结论完全一致（随机源已固定）');
  }
} catch (e) {
  err('fix-rarity-price.js 干跑跑不通：' + String(e.message || e).split('\n')[0]);
  chainBad++;
}

/* 工具输出必须可复现：会用到随机性的工具都必须覆写 Math.random。
   踩过的坑：balance.js / verify.js 的输出会抄进文档，它们的警戒线
   （比如「C 场比 D 场高 15% 以上」）曾经会因为随机性 30 次里误报 1 次。 */
['tools/balance.js', 'tools/verify.js', 'tools/tune.js', 'tools/fix-rarity-price.js'].forEach(rel => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (!/Math\.random\s*=/.test(src)) {
    err(`${rel} 没有固定随机种子（Math.random 未被覆写）—— 同一份数据两次跑出的结论会不同`);
    chainBad++;
  }
});
if (!chainBad) ok('4 个带随机性的工具全部固定了种子（balance / verify / tune / fix-rarity-price）');


/* ---------------- 15. 错误采集（E4 空壳）的边界 ----------------
   这一层的价值全在「出问题时还能用」：它自己绝对不能碰需要联网/存储的能力，
   也绝对不能因为记日志而抛异常。参数（缓冲条数等）同样只许来自 config。 */
console.log('\n[15] 错误采集 G.Track：参数只在 config，且不接任何外部能力');
let trackBad = 0;
const tkCfg = CFG.track;
if (!tkCfg) { err('config.js 里没有 track 段'); trackBad++; }
else {
  if (!(tkCfg.buffer > 0)) { err('track.buffer 必须是正数'); trackBad++; }
  if (!(tkCfg.maxMessage > 0)) { err('track.maxMessage 必须是正数'); trackBad++; }
  if (typeof tkCfg.enabled !== 'boolean') { err('track.enabled 必须是布尔值'); trackBad++; }
}
const tkSrc = fs.readFileSync(path.join(ROOT, 'src/core/track.js'), 'utf8');
/* 只看代码，不看注释（注释里会提到「不碰 localStorage」这类词） */
const tkCode = tkSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (!/CFG\.track/.test(tkCode)) { err('track.js 没有读 CFG.track（参数可能会散落成硬编码）'); trackBad++; }
['localStorage', 'sessionStorage'].forEach(k => {
  if (tkCode.indexOf(k) >= 0) { err(`track.js 里出现了 ${k} —— 平台能力必须走 G.Platform`); trackBad++; }
});
['XMLHttpRequest', 'sendBeacon', 'fetch('].forEach(k => {
  if (tkCode.indexOf(k) >= 0) { err(`track.js 里出现了 ${k} —— E4 明确要求不接外部服务（空壳）`); trackBad++; }
});
const tkIdx = htmlRaw.indexOf('src/core/track.js'), mnIdx = htmlRaw.indexOf('src/main.js');
if (!(tkIdx > 0 && mnIdx > tkIdx)) {
  err('track.js 必须在 index.html 里、且在 main.js 之前加载（否则启动期的崩溃采不到）'); trackBad++;
}
if (mainSrc.indexOf('G.Track.init()') < 0) {
  err('main.js 没有调 G.Track.init()（全局异常不会被采集）'); trackBad++;
}
if (!/function safeBoot\s*\(/.test(mainSrc)) {
  err('main.js 没有把 boot 包起来 —— 启动期抛异常就只剩白屏，拿不到任何线索'); trackBad++;
}
if (!trackBad) ok(`config.track 参数齐全（缓冲 ${tkCfg.buffer} 条）；track.js 不碰存储 / 不联网；main.js 已挂采集`);


/* ---------------- 16. 周常挑战（中周期目标）的跨文件一致性 ----------------
   和第 ⑨ / ⑩ 节同一类：规则散在几处（模板表 / 核心层取数口径 / 面板渲染 / 存档字段），
   任何一处漏掉都是「不报错的静默失败」：
     · 模板的 metric 在核心层没有实现   → 进度算成 NaN，任务永远完不成
     · 同表两条模板共用 metric          → 进度基准被互相覆盖，同样永远完不成
     · 面板没有渲染 weekly              → 玩家看得到完成提示却领不了奖
     · 存档没有 weekly 字段             → 每次刷新都重掷，进度原地踏步 */
console.log('\n[16] 周常挑战：模板 ↔ 取数口径 ↔ 面板 ↔ 存档 一致');
let goalBad = 0;

const goalCfg = CFG.goals;
if (!goalCfg) { err('config.js 里没有 goals 段（奖励数值必须集中在 config）'); goalBad++; }
else {
  if (!(goalCfg.dailyMedals >= 1)) { err('goals.dailyMedals 必须是 ≥1 的数（每日任务只发纪念币）'); goalBad++; }
  if (!(goalCfg.weeklyMedals >= 1)) { err('goals.weeklyMedals 必须是 ≥1 的数'); goalBad++; }
}

const coreGoalsSrc = fs.readFileSync(path.join(ROOT, 'src/core/goals.js'), 'utf8');
const stateSrc     = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
const panelsSrc    = fs.readFileSync(path.join(ROOT, 'src/ui/panels.js'), 'utf8');

/* 取数口径：从核心层的 METRICS 表里把 key 抠出来（只看代码，不看注释） */
const metricBody = (coreGoalsSrc.match(/var METRICS\s*=\s*\{([\s\S]*?)\n  \};/) || [, ''])[1];
const metricKeys = (metricBody.match(/(^|\n)\s*(\w+)\s*:\s*function/g) || [])
  .map(s => s.trim().split(/\s*:\s*/)[0]);

const weekTpls = G.WEEKLY_TPL || [];
if (!weekTpls.length) { err('data/goals.js 里没有 G.WEEKLY_TPL（周常挑战没有模板）'); goalBad++; }
if (!(G.WEEKLY_PER_WEEK >= 1)) { err('G.WEEKLY_PER_WEEK 必须是 ≥1 的数'); goalBad++; }
else if (G.WEEKLY_PER_WEEK > weekTpls.length) {
  err(`G.WEEKLY_PER_WEEK(${G.WEEKLY_PER_WEEK}) 超过模板总数(${weekTpls.length})，会有周期只生成半张表`); goalBad++;
}

[['每日', G.QUEST_TPL], ['周常', weekTpls]].forEach(([label, list]) => {
  const ids = new Set(); let dup = 0, noMetric = 0;
  list.forEach(t => {
    if (ids.has(t.id)) dup++;
    ids.add(t.id);
    if (!metricKeys.includes(t.metric)) { noMetric++; err(`${label}模板「${t.id}」的 metric「${t.metric}」在 core/goals.js 的 METRICS 里没有实现`); }
    if (typeof t.text !== 'function') { err(`${label}模板「${t.id}」缺 text 文案函数`); goalBad++; }
    if (!t.pool && !t.poolFn) { err(`${label}模板「${t.id}」既没有 pool 也没有 poolFn`); goalBad++; }
  });
  if (dup) { err(`${label}模板 id 重复 ${dup} 个（tplById 只会命中第一个）`); goalBad++; }
  if (noMetric) goalBad++;
  /* 进度基准 base 是按 metric 记的 → 同表两条共用一个 metric 会互相覆盖 */
  const ms = list.map(t => t.metric);
  const dupM = ms.filter((m, i) => ms.indexOf(m) !== i);
  if (dupM.length) {
    err(`${label}模板里有 ${dupM.length} 个重复 metric（${[...new Set(dupM)].join('、')}）—— 进度基准按 metric 记，会互相覆盖`);
    goalBad++;
  }
});
/* 两张表的 id 不能撞车：tplById 是同时在两张表里找的 */
const allIds = (G.QUEST_TPL || []).map(t => t.id).concat(weekTpls.map(t => t.id));
if (new Set(allIds).size !== allIds.length) { err('每日与周常模板的 id 有冲突（tplById 会取错模板）'); goalBad++; }

/* 奖励数值不许在核心层写死：必须读 CFG.goals */
if (!/CFG\.goals/.test(coreGoalsSrc)) { err('core/goals.js 没有读 CFG.goals —— 纪念币数量可能被写死在逻辑里'); goalBad++; }
if (!/function ensureWeek\s*\(/.test(coreGoalsSrc)) { err('core/goals.js 里没有 ensureWeek()（周常不会跨周刷新）'); goalBad++; }
if (!/function weekOf\s*\(/.test(coreGoalsSrc)) { err('core/goals.js 里没有纯函数 weekOf(date)（周数算法没法定点测）'); goalBad++; }
if (coreGoalsSrc.indexOf('S.weekly') < 0) { err('core/goals.js 里没有用 S.weekly 这个存档字段'); goalBad++; }
if (!/weeklyMedals\s*\(/.test(coreGoalsSrc) || !/dailyMedals\s*\(/.test(coreGoalsSrc)) {
  err('core/goals.js 没有从 config 读每日 / 周常的纪念币数'); goalBad++;
}

/* 存档：blank() 必须有 weekly 字段，migrate() 必须有类型纠正，SAVE_V 要 >= 5 */
if (!/weekly:\s*null/.test(stateSrc)) { err('state.js 的 blank() 里没有 weekly: null（存档缺字段）'); goalBad++; }
if (!/d\.weekly\s*=/.test(stateSrc)) { err('state.js 的 migrate() 没有纠正 weekly 的类型（脏数据会漏进运行期）'); goalBad++; }
const saveVM = stateSrc.match(/var SAVE_V\s*=\s*(\d+)/);
if (!saveVM) { err('state.js 里找不到 SAVE_V'); goalBad++; }
else if (Number(saveVM[1]) < 5) { err(`SAVE_V = ${saveVM[1]}，但 v5 才开始有周常挑战字段`); goalBad++; }
if (!/function weekKey\s*\(/.test(coreGoalsSrc)) { err('core/goals.js 里没有 weekKey()（周常没有周期种子）'); goalBad++; }

/* 面板：必须真的渲染并给出领取入口 */
if (panelsSrc.indexOf('Gl.weekly(') < 0) { err('panels.js 的「目标」面板没有渲染周常挑战（完成了却看不到）'); goalBad++; }
if (panelsSrc.indexOf('claimWeekly') < 0) { err('panels.js 里没有领取周常的入口（claimWeekly）'); goalBad++; }
/* 徽标要同时算上周常，否则周常完成的提醒永远不会出现。
   ⚠️ 断言看的是「两个 board 都遍历了」，不是某个具体函数名 ——
      徽标计数后来改成不走 questState()（不生成展示文案），
      写死 `weekly()` 会误报。 */
const badgeBody = (coreGoalsSrc.match(/function medalClaimable\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
if (!badgeBody || badgeBody.indexOf('S.daily') < 0 || badgeBody.indexOf('S.weekly') < 0) {
  err('medalClaimable() 没有同时统计每日与周常（周常完成不会提醒）'); goalBad++;
}
/* 徽标每 0.4 秒被问一次数，走 questState() 会白造十几段展示文案 */
if (badgeBody.indexOf('questState(') >= 0) {
  err('medalClaimable() 走回 questState() 了 —— 它每条都要生成展示文案，而徽标只需要一个数'); goalBad++;
}

if (!goalBad) {
  ok(`config.goals 奖励齐全（每日 ${goalCfg.dailyMedals} / 周常 ${goalCfg.weeklyMedals} 枚纪念币）`);
  ok(`周常 ${weekTpls.length} 个模板，metric 全部有实现且不重复；每周取 ${G.WEEKLY_PER_WEEK} 条`);
  ok('存档有 weekly 字段 + 类型纠正，SAVE_V 已升档；面板有渲染与领取入口，徽标把周常算进去');
}


/* ---------------- 17. 渲染路径里不许每帧新建渐变 ----------------
   D1 修过一次，但只修了「跟尺寸/主题有关」的那些：灯笼光晕（9 个/帧）
   与极光带（4 个/帧）因为颜色随时间呼吸，被漏在外面 —— 技术债 #16 就是这么来的。
   现在两者都收口了（光晕改成预渲染离线图 + globalAlpha）。
   这里做一条源码级断言防复发：场景里每个 `ctx.createXxxGradient` 都必须
   紧跟在 `grad('key', function () {` 工厂里（工厂只在缓存未命中时求值）。 */
console.log('\n[17] scene.js 的渐变全部走缓存工厂（不得每帧新建）');
let gradBad = 0;
const sceneLines = sceneSrc.split('\n');
sceneLines.forEach((ln, i) => {
  if (!/ctx\.create(?:Linear|Radial)Gradient\s*\(/.test(ln)) return;
  const before = sceneLines.slice(Math.max(0, i - 3), i).join('\n');
  if (!/grad\('/.test(before)) {
    err(`scene.js:${i + 1} 直接建了渐变，但前 3 行里没有 grad('key', ...) 工厂 —— 每帧新建会造成 GC 压力`);
    gradBad++;
  }
});
if (!gradBad) {
  const n = (sceneSrc.match(/ctx\.create(?:Linear|Radial)Gradient\s*\(/g) || []).length;
  ok(`${n} 处 ctx 渐变全部在 grad() 缓存工厂里`);
}
/* 灯笼光晕走预渲染离线图：缓存必须跟着 resize 失效（dpr 可能变） */
if (!/function clearGradCache\s*\(\)\s*\{[\s\S]{0,120}?glowSprite\s*=\s*null/.test(sceneSrc)) {
  err('clearGradCache() 没有一起清掉灯笼光晕的离线图 —— dpr 变化后会用到旧精度的图'); gradBad++;
}
if (!/function lanternGlow\s*\(/.test(sceneSrc)) {
  err('scene.js 里没有 lanternGlow()（灯笼光晕没有做成预渲染离线图）'); gradBad++;
} else {
  ok('灯笼光晕是预渲染离线图 + globalAlpha（不再每帧建 9 个径向渐变）');
}
if (!gradBad) ok('渐变缓存是「按 resize / setField 失效」的唯一入口');


/* ---------------- 18. 面板关闭回调必须常驻 ----------------
   一个「不报错但玩家能看出来」的坑：onCloseCb 被 close() 自己置空。
   它其实是 hud.js 在 init 时只注册一次的常驻回调（用来清掉顶栏标签页高亮），
   写成一次性之后，从第二次关面板开始，那个标签页会一直亮着。
   （浏览器实测：点图鉴→✕、再点图鉴→✕，第二次高亮就留在顶栏不掉了。） */
console.log('\n[18] 面板关闭回调必须常驻（close() 不得把自己注销掉）');
let panelBad = 0;
const closeBody = (panelsSrc.match(/function close\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
if (!closeBody) { err('panels.js 里找不到 close()'); panelBad++; }
else if (/onCloseCb\s*=\s*null/.test(closeBody)) {
  err('panels.js 的 close() 把 onCloseCb 置空了 —— 它是 hud.js 只注册一次的常驻回调，第二次关闭起标签页高亮就清不掉了');
  panelBad++;
}
const hudSrcTab = fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8');
if (!/G\.Panels\.setOnClose\(function \(\) \{ setActiveTab\(null\); \}\)/.test(hudSrcTab)) {
  err('hud.js 没有在关闭时清掉标签页高亮（setOnClose → setActiveTab(null)）'); panelBad++;
}
const tabN = (hudSrcTab.match(/U\.on\(b, 'click'/g) || []).length;
if (tabN !== 1) { err(`hud.js 里给标签页绑 click 的地方有 ${tabN} 处（重复注册会一次点击触发多次）`); panelBad++; }
if (!panelBad) ok('close() 不再注销常驻回调；hud 的「关闭即清高亮」只注册一次');


/* ---- [19] 弹层不得盖住顶栏（顶栏是面板的导航，被盖住就只能「先关一次、再点一次」） ----
   原来 `.modal` 是 `inset:0`，整条顶栏都在遮罩底下 → 面板开着时点标签页，
   点击落在遮罩上（只会关面板）。改成从 `top:var(--hud-h)` 开始，
   hud.js 的 tab 分支才能就地切面板。 */
console.log('\n[19] 弹层不从顶栏上方开始（顶栏在面板打开时仍可点）');
let layerBad = 0;
const modalRule = (fs.readFileSync(path.join(ROOT, 'assets/css/style.css'), 'utf8')
  .match(/\.modal\s*\{[\s\S]*?\}/) || [''])[0];
if (!modalRule) { err('style.css 里找不到 .modal 规则'); layerBad++; }
else {
  if (/inset\s*:\s*0/.test(modalRule)) {
    err('.modal 又写回 inset:0 —— 遮罩会盖住顶栏，面板开着时点标签页只会关面板（切面板要点两次）');
    layerBad++;
  }
  if (!/top\s*:\s*var\(--hud-h\)/.test(modalRule)) {
    err('.modal 没有从 var(--hud-h) 开始 —— 弹层会压住顶栏，标签页点不到'); layerBad++;
  }
}
if (!/G\.Panels\.isOpen\(\)\s*&&\s*G\.Panels\.current\(\)\s*===\s*p/.test(hudSrcTab)) {
  err('hud.js 的标签页分支没有做「就地切换」（缺 isOpen() && current() === p 的判断）'); layerBad++;
}
if (!layerBad) ok('弹层从顶栏下方开始；点标签页可直接切换/收起面板');


/* ---------------- 20. 渔获归因必须用「抛竿时」的值 ----------------
   resolve() 记 `stats.byBait / byWx / byTm` 时一度读的是**现值**
   (`St.curBait().id` / `G.Weather.env()`)。两个静默后果：
     · 用掉最后一枚付费饵时 baitSel 已被切回蚯蚓 → 那一竿错记到蚯蚓名下
       （与 v0.5.6 修过的「最后一枚白花」是同一个坑的两个面）
     · 一场传说鱼要拉扯几分钟，中途变天 / 天黑 → 记到错误的天气时段上
   这类 bug 不报错、只在任务进度上慢慢显出偏差，所以做一条源码级断言兜住。 */
console.log('\n[20] 渔获归因用抛竿时的鱼饵与环境（不许读结算时的现值）');
let attrBad = 0;
const fishingSrc = fs.readFileSync(path.join(ROOT, 'src/core/fishing.js'), 'utf8');
/* 只看 resolve() 的函数体：offlineCatchUp 里的 `St.curBait()` 是合法的
   （离线补算没有「抛竿那一刻」，当前选中的饵就是唯一合理的说法） */
const resolveBody = (fishingSrc.match(/function resolve\s*\([\s\S]*?\n  \}/) || [''])[0];
if (!resolveBody) { err('fishing.js 里找不到 resolve()'); attrBad++; }
else {
  if (!/bait:\s*castBait/.test(resolveBody)) {
    err('resolve() 没有用 castBait 记鱼饵 —— 用掉最后一枚时那一竿会错记到蚯蚓名下'); attrBad++;
  }
  if (/St\.curBait\(\)/.test(resolveBody)) {
    err('resolve() 又读 St.curBait() 了（结算时的现值，选饵可能已被自动切走）'); attrBad++;
  }
  if (!/env:\s*castEnv/.test(resolveBody)) {
    err('resolve() 没有用抛竿时缓存的 castEnv —— 拉扯中变天会记错天气时段'); attrBad++;
  }
}
if (!/castEnv\s*=\s*G\.Weather\.isReady/.test(fishingSrc)) {
  err('fishing.js 没有在 cast() 里缓存抛竿时的环境（castEnv）'); attrBad++;
}
if (!attrBad) ok('鱼饵用 castBait、环境用 castEnv；两处都取自抛竿那一刻');


console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
