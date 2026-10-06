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
  'U', 'Platform', 'Audio', 'Loot', 'State', 'Goals', 'FishArt', 'Scene', 'Fight', 'Weather',
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


console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
