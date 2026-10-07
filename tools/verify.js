/* =========================================================
   tools/verify.js  —  数据自检 / 一致性断言
   =========================================================
   目的：把「靠人记得跑」变成「跑一次就知道有没有错」。

   检查项：
     1. 各钓场稀有度权重合计 = 100%
     2. 每个稀有度档位的颜色概率合计 = 100%
     3. 档内颜色序：原色 > 彩虹色 ≥ 白化 > 黄金 > 闪光
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

/* ---------------- 2-b 颜色概率只许走 Loot.colorProb ----------------
   配置里早年的「单值写法」`cm.prob` 已经删掉了，但代码/tools 里还留着读取它，
   而读一个不存在的字段**不会报错**：
     · `tools/gen-collect-time.js` 用它排序 → 比较器拿到 undefined → NaN →
       排序完全没生效 → 《收集耗时表》把「最稀有 · 最贵」标在了**原色**那一行，
       两个额外列也印成「该鱼原色 / 该鱼彩虹色」。
   判据：src 与 tools 的 .js 里不许出现 `.prob`（`.probs` 合法），且必须是
   `G.Loot.colorProb(...)` 取概率。只看代码不看注释。 */
console.log('\n[2-b] 颜色概率只许走 Loot.colorProb（不得再读已删的旧单值字段）');
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.js$/.test(n)) files.push(dir + '/' + n);
    });
  })('src');
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      if (/\.js$/.test(n)) files.push(dir + '/' + n);
    });
  })('tools');
  let pb = 0;
  files.forEach(r => {
    const code = strip(fs.readFileSync(path.join(ROOT, r), 'utf8'));
    /* `.prob` 后面不能再跟字母（`.probs` / `.colorProbTotal` 都合法）。
       ⚠️ 写成 `\.[p]rob` 而不是 `\.prob`：否则**这条断言自己的正则**就会被自己扫到
       （本行的源码里含有 `.prob` 这几个字），自指的坑踩过一次就够了。 */
    if (/\.[p]rob(?![A-Za-z0-9_$])/.test(code)) {
      err(`${r} 里读了颜色表里已删除的旧「单值概率」字段（现在恒为 undefined）—— ` +
          '读一个不存在的字段不会报错，只会静默算错；请统一用 G.Loot.colorProb(cm, rarIdx)');
      pb++;
    }
  });
  if (!pb) ok(`${files.length} 个源码 / 工具文件里都没有对已删的颜色概率旧字段的读取`);
})();

/* ---------------- 3. 档内颜色序 ---------------- */
console.log('\n[3] 档内颜色序：原色 > 彩虹色 ≥ 白化 > 黄金 > 闪光');
const byKey = {};
CFG.colorMorphs.forEach(c => { byKey[c.key] = c; });
[0, 1, 2, 3].forEach(t => {
  const n = byKey.normal, b = byKey.bright, a = byKey.albino, g = byKey.golden, s = byKey.shiny;
  const P = k => L.colorProb(byKey[k], t);
  const bad = [];
  if (!(P('normal') > P('bright'))) bad.push('原色 ≤ 彩虹色');
  if (!(P('bright') >= P('albino'))) bad.push('彩虹色 < 白化');
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

/* 11-g GDD 的版本历史表必须按版本号递增排列，且标题写到当前版本
   （踩过：v0.5.7 那一行被插在 v0.5.4 与 v0.5.6 之间，读起来像版本号倒退了） */
const gddTxt = fs.readFileSync(path.join(ROOT, 'docs/GDD.md'), 'utf8');
const histSec = (gddTxt.match(/### v([\d.]+) → v([\d.]+) 的变更[^\n]*\n[\s\S]*?(?=\n---|\n## )/) || [''])[0];
if (!histSec) { err('GDD 里找不到「### vX → vY 的变更」版本历史表'); entryBad++; }
else {
  const rows = [...histSec.matchAll(/\|\s*\*\*v(\d+)\.(\d+)\.(\d+)\*\*\s*\|/g)]
    .map(m => [+m[1], +m[2], +m[3]]);
  let bad = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) || (b[0] === a[0] && b[1] === a[1] && b[2] < a[2])) bad++;
  }
  if (rows.length < 5) { err(`GDD 版本历史表只认出 ${rows.length} 行（表格被改坏了？）`); entryBad++; }
  if (bad) { err(`GDD 版本历史表里有 ${bad} 处版本号倒退（应按 v0.4.0 → 当前版本 递增排列）`); entryBad++; }
  const headM = gddTxt.match(/### v([\d.]+) → v([\d.]+) 的变更/);
  if (headM && headM[2] !== CFG.version) {
    err(`GDD 版本历史表的标题写到 v${headM[2]}，但当前版本是 v${CFG.version}`); entryBad++;
  }
  if (!bad && rows.length >= 5) ok(`GDD 版本历史表 ${rows.length} 行按版本号递增，标题对齐 v${CFG.version}`);
}

/* 11-h 文档里写的「单文件产物 ≈ N KB」必须与真实构建相符
   这个数字在 GDD / 开发者文档里各写了一遍，谁都不会记得跟着改 ——
   本轮实测：文档写 419 KB，真产物已经 464 KB（漂了 11%），而它正是
   「双击 file:// 就能跑的单个文件有多大」这个对外说法。
   容差 5%：dev 与 release 产物本来就有约 2% 的差（release 剔除 devtools.js）。
   ⚠️ 判据只认「产物 ≈ N KB」与「≈ N KB」两种写法 ——
   GDD 版本历史表里那句「（21 个脚本内联成一个 HTML，≈419 KB）」是**历史记录**，
   刻意不纳入（它描述的是 v0.5.4 当时的产物）。改措辞时记得同步这里的正则。 */
const realKB = Math.round(BLD.build({}).meta.bytes / 1024);
let sizeClaimCount = 0;
[['docs/GDD.md', /产物\s*[≈约]\s*\*{0,2}\s*(\d+)\s*KB/g],
 ['docs/开发者文档.md', /[≈约]\s*\*{0,2}\s*(\d+)\s*KB/g]].forEach(function (pair) {
  const file = pair[0];
  const txt = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let m;
  while ((m = pair[1].exec(txt))) {
    sizeClaimCount++;
    const claimed = +m[1];
    if (Math.abs(claimed - realKB) / realKB > 0.05) {
      err(`${file} 里写着产物 ≈${claimed} KB，实际构建是 ${realKB} KB（偏差 >5%，改文档或别内联那么多东西）`);
      entryBad++;
    }
  }
});
if (!sizeClaimCount) { err('文档里再找不到「单文件产物 ≈ N KB」这句对外说法（被删了？）'); entryBad++; }

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
/* 两个「张力判定窗口」必须同族：触顶多久断线（snapGrace）与贴地多久脱钩（slackGrace）
   是同一类手感参数，理应都在 `config.fight` 里。
   踩过的坑：snapGrace 原来放在 `config.misc`（注释写「断线缓冲」），
   调张力手感时要在两个段落里各翻一个值 —— 而且谁也不会想到去 misc 找它。 */
['snapGrace', 'slackGrace'].forEach(k => {
  if (CFG.fight[k] == null) {
    err(`CFG.fight.${k} 不存在 —— 张力判定窗口应集中在 config.fight 里`); safeBad++;
  }
  if (CFG.misc[k] != null) {
    err(`CFG.misc.${k} 又出现了（张力判定窗口不该散在 misc 里）`); safeBad++;
  }
});
if (!safeBad) ok(`安全线 ${(safeR * 100).toFixed(0)}% 只存在于 config.js，CSS 里没有第二份；两个张力判定窗口同族在 config.fight`);


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
/* 落盘：白屏那条日志最值钱，刷新后必须还在（内存缓冲会跟着页面一起没） */
if (tkCfg && tkCfg.persist !== false) {
  if (!/G\.Platform\.storage\.(get|set)\s*\(/.test(tkCode)) {
    err('track.persist 开着，但 track.js 没有通过 G.Platform.storage 落盘'); trackBad++;
  }
  if (typeof tkCfg.storageKey !== 'string' || !tkCfg.storageKey) {
    err('track.storageKey 必须是非空字符串（日志不能挤进存档键）'); trackBad++;
  }
  if (!(tkCfg.persistMinMs > 0)) {
    err('track.persistMinMs 必须是正数（渲染循环里出错是每帧一次，不节流会每帧写盘）'); trackBad++;
  }
  if (!(tkCfg.persistMaxBytes > 0)) {
    err('track.persistMaxBytes 必须是正数（单次落盘要有上限）'); trackBad++;
  }
  if (!/function load\s*\(/.test(tkCode) || !/function save\s*\(/.test(tkCode)) {
    err('track.js 缺少 load() / save() —— 落盘就是半成品'); trackBad++;
  }
}
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
if (!trackBad) ok(`config.track 参数齐全（缓冲 ${tkCfg.buffer} 条、落盘节流 ${tkCfg.persistMinMs}ms）；track.js 只走 G.Platform 存储、不联网；main.js 已挂采集`);


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

/* 同一条红线也适用于 panels.js 的**每帧**绘制：水族箱动画（drawTank）原来每帧
   建一个水体线性渐变。一次性绘制（图鉴详情页的鱼卡背景）不在约束内。 */
console.log('  · panels.js 的每帧绘制同样不许新建渐变');
let tankGradBad = 0;
const panelsSrcG = fs.readFileSync(path.join(ROOT, 'src/ui/panels.js'), 'utf8');
const drawTankBody = (panelsSrcG.match(/function drawTank\s*\([\s\S]*?\n    \}/) || [''])[0];
if (!drawTankBody) { err('panels.js 里找不到 drawTank()（水族箱动画）'); tankGradBad++; }
else {
  const dtLines = drawTankBody.split('\n');
  let nTankGrad = 0;
  dtLines.forEach((ln, i) => {
    if (!/create(?:Linear|Radial)Gradient\s*\(/.test(ln)) return;
    nTankGrad++;
    const before = dtLines.slice(Math.max(0, i - 4), i).join('\n');
    if (!/waterGradH/.test(before)) {
      err(`panels.js drawTank 里直接建了渐变，前面 4 行没有缓存判断 —— 面板开着时每帧都会造一个新对象`);
      tankGradBad++;
    }
  });
  if (!tankGradBad && nTankGrad) ok(`水族箱动画的 ${nTankGrad} 个渐变走尺寸缓存（每帧 0 新建）`);
  else if (!nTankGrad) { err('drawTank 里找不到渐变（水体绘制被改掉了？）'); tankGradBad++; }

  /* 空鱼缸必须按需重绘：面板开着时原来每秒把水 + 亮带 + 沙整幅重画 60 次，
     缸里却一条鱼都没有。早退必须发生在**任何绘制之前**（拿到尺寸之后就判断）。 */
  const guardAt = dtLines.findIndex(ln => /if \(!tankN && tankPainted/.test(ln));
  const drawAt = dtLines.findIndex(ln => /getContext\('2d'\)/.test(ln));
  if (guardAt < 0) {
    err('panels.js drawTank 里没有「空鱼缸尺寸没变就早退」的判断 —— 面板开着时会一直空转重绘');
    tankGradBad++;
  } else if (drawAt >= 0 && guardAt > drawAt) {
    err('空鱼缸的早退写在了取 ctx 之后 —— 一定要在绘制之前，否则白跑'); tankGradBad++;
  } else {
    ok(`空鱼缸按需重绘（第 ${guardAt + 1} 行早退，早于第 ${drawAt + 1} 行取 ctx）`);
  }
}


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

/* ---- [21] 一个 tick 里最多重绘一次面板 ----
   一次点击里 refresh() 会被喊 2~3 遍（点击回调一次 + St 的 'net'/'eco' 事件各一次），
   整面板 DOM 就被重建 2~3 遍。refresh() 必须改成「排队到本 tick 末尾」再画。 */
console.log('\n[21] refresh() 一个 tick 最多重绘一次（不许被事件连击打出重复渲染）');
let coalesceBad = 0;
const refreshBody = (panelsSrc.match(/function refresh\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
if (!refreshBody) { err('panels.js 里找不到 refresh()'); coalesceBad++; }
else {
  const queueAt = refreshBody.indexOf('setTimeout');
  const drawAt = refreshBody.indexOf('renderCurrent');
  if (queueAt < 0) {
    err('panels.js 的 refresh() 是同步重绘 —— 一次点击里被喊几遍就重建几遍 DOM'); coalesceBad++;
  } else if (drawAt >= 0 && drawAt < queueAt) {
    err('panels.js 的 refresh() 既同步画又排队 —— 同步那次就是白画的，等于没合并'); coalesceBad++;
  }
  if (!/if \(!isOpen\(\) \|\| refreshTimer\) return;/.test(refreshBody)) {
    err('refresh() 没有「已排队就跳过」的闸门 —— 连击仍然会排出多次重绘'); coalesceBad++;
  }
}
/* open() 必须是同步重绘的：面板刚打开不能先白一帧 */
const openBody = (panelsSrc.match(/function open\s*\(name, arg\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
if (!openBody || openBody.indexOf('renderCurrent(arg)') < 0) {
  err('panels.js 的 open() 不再同步渲染了 —— 打开面板会先空一帧'); coalesceBad++;
} else if (openBody.indexOf('clearTimeout(refreshTimer)') < 0) {
  err('open() 没有取消排队中的 refresh —— 打开后会紧接着被重绘一遍'); coalesceBad++;
}
if (!coalesceBad) ok('refresh() 排队合并到本 tick 末尾；open() 仍同步渲染并取消排队');


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


/* ---------------- 22. 卖鱼入账只有一个出口 ----------------
   金币与「累计卖鱼收入」(stats.totalValue) 必须一起涨：
   挂机自动卖出（fishing.js）与结算卡「卖出」（main.js）原来各自
   `addCoin(p)` + 手写一行 `stats.totalValue += p` —— 漏写一处，成就口径
   就悄悄偏了，而且那一行没有 NaN 兜底。现在统一走 St.sellFish()。 */
console.log('\n[22] 卖鱼入账单一出口（stats.totalValue 只许在 state.js 里写）');
let incomeBad = 0;
const allSrc = [];
(function walk(dir) {
  fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
    const rel = dir + '/' + name;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.js$/.test(name)) allSrc.push(rel);
  });
})('src');
allSrc.filter(r => r !== 'src/core/state.js').forEach(r => {
  fs.readFileSync(path.join(ROOT, r), 'utf8').split('\n').forEach((ln, i) => {
    if (/stats\.totalValue\s*(?:\+=|-=|=)/.test(ln)) {
      err(`${r}:${i + 1} 直接改 stats.totalValue —— 卖鱼入账要走 St.sellFish()（金币与累计收入必须一起涨）`);
      incomeBad++;
    }
  });
});
const stateSrcSell = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
if (!/function sellFish\s*\(/.test(stateSrcSell) || !/sellFish:\s*sellFish/.test(stateSrcSell)) {
  err('state.js 里没有对外暴露 sellFish() —— 卖鱼入账没有单一出口'); incomeBad++;
}
if (!incomeBad) ok('stats.totalValue 只在 state.js 的卖鱼出口里写，其余源码只调 St.sellFish()');


/* ---------------- 23. 结算卡那一行是「体重占比」，不是「体长」 ----------------
   游戏里没有「体长」这个数据（fishart 里的 L 是绘制像素）。
   而 CFG.weight.giantProb 有 3% 的「巨物」会在常规上限之上再 ×1.55，
   那时显示「155% 上限」自相矛盾 —— 必须点名是巨物。 */
console.log('\n[23] 结算卡的体重占比（不得写成「体长」；巨物要单独标注）');
let catchBad = 0;
const showCatchBody = (panelsSrc.match(/function showCatch\s*\([\s\S]*?\n  \}/) || [''])[0];
if (!showCatchBody) { err('panels.js 里找不到 showCatch()'); catchBad++; }
else {
  /* 只看代码，不看注释 —— 那段注释本身就要说明「以前写成体长」，
     否则断言会被自己的说明文字绊倒 */
  const showCatchCode = showCatchBody
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (showCatchCode.indexOf('体长') >= 0) {
    err('结算卡又写「体长」了 —— 这一行算的是体重占常规上限的比例，游戏里根本没有体长数据');
    catchBad++;
  }
  if (showCatchCode.indexOf('maxKg') < 0) { err('结算卡不再对比同种的体重上限了'); catchBad++; }
  if (showCatchCode.indexOf('巨物') < 0) {
    err('结算卡没有标注「巨物」—— 3% 概率的巨物会显示成「155% 上限」，自相矛盾'); catchBad++;
  }
}
if (!catchBad) ok('结算卡第 2 行是体重占比；超过常规上限（巨物）会单独标注');


/* ---------------- 24. 付费内容面板的数值不许写死 ----------------
   原来文案里硬编码了 20% / 5% / 10%，还写着「已实现为鱼竿稀有权重 ×1.08~×1.45」，
   而 items.js 里鱼竿的实际区间是 ×1.06~×1.5 —— 调数值时这两处一定会漂。
   现在全部从 config.monetization / 道具表现算出来。 */
console.log('\n[24] 付费内容面板的数值来自 config（不得硬编码）');
let paidBad = 0;
const paidBlock = (panelsSrc.match(/if \(shopTab === 'paid'\)\s*\{[\s\S]*?\n      \}/) || [''])[0];
if (!paidBlock) { err("panels.js 里找不到 shopTab === 'paid' 分支"); paidBad++; }
else {
  const paidCode = paidBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/\d+\s*%/.test(paidCode)) {
    err('付费内容面板的文案里又出现写死的百分比了 —— 数值要读 CFG.monetization');
    paidBad++;
  }
  /* 时长同理：「观看广告获得 1 小时挂机券」里的「1 小时」原来写死在文案里 */
  if (/\d+\s*小时/.test(paidCode)) {
    err('付费内容面板的文案里又出现写死的时长了（N 小时）—— 应读 CFG.monetization.adTicketHours');
    paidBad++;
  }
  if (paidCode.indexOf('m.adTicketHours') < 0) {
    err('付费内容面板没有读 monetization.adTicketHours（广告券时长会与 config 分家）');
    paidBad++;
  }
  ['rodRareBoost', 'idleRareCut', 'shareRodBoost'].forEach(k => {
    if (paidCode.indexOf('m.' + k) < 0) { err(`付费内容面板没有读 monetization.${k}`); paidBad++; }
  });
  if (paidCode.indexOf('rareMul') < 0 || paidCode.indexOf('Math.min') < 0 || paidCode.indexOf('Math.max') < 0) {
    err('付费内容面板的「鱼竿稀有权重区间」没有按 items.js 的真实 rareMul 现算（应走 Math.min / Math.max）');
    paidBad++;
  }
}
/* monetization 的每个数值键都必须真的有消费方，否则就是「配了没人用」 */
const monCfg = (CFG.monetization || {});
const monKeys = Object.keys(monCfg).filter(k => k !== 'enabled');
const panelsAndSrc = panelsSrc + fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
const monOrphan = monKeys.filter(k => panelsAndSrc.indexOf('monetization.' + k) < 0 && panelsAndSrc.indexOf('m.' + k) < 0);
if (monOrphan.length) {
  err(`config.monetization 里这些键没有任何消费方：${monOrphan.join('、')}`); paidBad++;
}
if (!paidBad) ok(`付费内容面板的数值全部来自 config（monetization 的 ${monKeys.length} 个键都有消费方）`);


/* ---------------- 25. util.js 的导出面里不许有「零消费」死函数 ----------------
   `G.U` 里曾经躺着 rnd / irange / pick / chance / normalize 五个函数：
   全项目零调用，却长得很像「基础设施」，读代码的人会以为它们是常用工具。
   判据：**每个被导出的函数，要么在 util.js 之外被 `U.<name>` 用过，
   要么在 util.js 内部被别处调用过**（如 hex2rgb 只服务 mix/lighten）。
   两边都没有 = 真死代码 → 报错。新增工具只要有人用就不会误报。 */
console.log('\n[25] util.js 导出的工具函数都必须真的有消费方');
let utilBad = 0;
const utilSrcRaw = fs.readFileSync(path.join(ROOT, 'src/core/util.js'), 'utf8');
/* ⚠️ 只扫代码不扫注释：上面那段「删掉过 rnd…」的说明注释会把名字带回来 */
const utilCode = utilSrcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* 收集 util.js 之外的全部源码：src/ + tools/ + index.html */
const extFiles = [path.join(ROOT, 'index.html')];
const walk = dir => fs.readdirSync(dir).forEach(n => {
  const p = path.join(dir, n);
  if (fs.statSync(p).isDirectory()) walk(p);
  else if (/\.(js|html)$/.test(n)) extFiles.push(p);
});
walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'tools'));
const extCode = extFiles
  .map(p => fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
  .join('\n');
const utilFns = (utilCode.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/g) || [])
  .map(s => s.replace(/function\s+/, '').replace(/\s*\($/, ''));
const utilExports = (utilCode.match(/return\s*\{([\s\S]*?)\n\s*\};/) || [, ''])[1];
const utilDead = utilFns.filter(fn => {
  if (!(new RegExp('(^|[\\s{,])' + escRe(fn) + '\\s*:').test(utilExports))) return false; // 没导出
  const outside = new RegExp('U\\.' + escRe(fn) + '(?![A-Za-z0-9_$])').test(extCode);
  const inside = new RegExp(escRe(fn) + '\\s*\\(')
    .test(utilCode.replace(new RegExp('function\\s+' + escRe(fn) + '\\s*\\(', 'g'), '')); // 剥掉自己的声明
  return !outside && !inside;
});
if (utilDead.length) {
  err(`src/core/util.js 里这些导出函数全项目零调用，是死代码：${utilDead.join('、')}（删掉，或补一处真实用例）`);
  utilBad++;
}
if (!utilBad) ok(`util.js 导出的 ${utilFns.filter(f => new RegExp('(^|[\\s{,])' + escRe(f) + '\\s*:').test(utilExports)).length} 个函数都有真实消费方`);


/* ---------------- 26. 文档页 / 工具页的脚本依赖自检（E5：缺依赖就报红） ----------------
   `docs/说明书.html` 曾经漏挂 `loot.js` —— 页面能打开、样式也对，只有一小块内容
   永远算不出来（静默降级），没人会注意到。这类问题每加一个页面就会复发一次，
   所以在这里把它变成机器能查的事：
     26-a 引用的脚本文件必须存在
     26-b 脚本的相对顺序必须是 index.html 顺序的**子序列**（index.html 是规范加载序）
     26-c 内联脚本里用到的每个「真的有人导出」的 `G.*`，都必须由页面已加载的模块提供 */
console.log('\n[26] 文档页 / 工具页的脚本依赖自检');
let docBad = 0;
const gExportMap = {};        // 导出的 G.* 名字 -> 定义它的模块
const gMods = [];
(function walkJs(dir) {
  fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
    const rel = dir + '/' + name;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walkJs(rel);
    else if (/\.js$/.test(name)) gMods.push(rel);
  });
})('src');
gMods.forEach(m => {
  const code = fs.readFileSync(path.join(ROOT, m), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 只认「行首的 G.X = 」（排除 G.CONFIG.rarity = 这类深层赋值） */
  (code.match(/^G\.([A-Za-z_$][\w$]*)\s*=(?!=)/gm) || []).forEach(line => {
    const nm = line.replace(/^G\./, '').replace(/\s*=.*$/, '');
    if (!(nm in gExportMap)) gExportMap[nm] = m;
  });
});
const indexOrder = BLD.collectScripts(htmlRaw);
const docPages = [];
['docs', 'tools'].forEach(dir => fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
  if (/\.html$/.test(n)) docPages.push(dir + '/' + n);
}));
docPages.forEach(rel => {
  let pageBad = 0;
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const srcs = (raw.match(/<script[^>]*\bsrc\s*=\s*["'][^"']+["']/gi) || [])
    .map(s => (s.match(/["']([^"']+)["']/) || [, ''])[1]);
  const pageDir = path.dirname(path.join(ROOT, rel));
  const loaded = [], order = [];
  srcs.forEach(s => {
    const abs = path.resolve(pageDir, s);
    if (!fs.existsSync(abs)) { err(`${rel} 引用了不存在的脚本：${s}`); docBad++; pageBad++; return; }
    const r = path.relative(ROOT, abs).split(path.sep).join('/');
    loaded.push(r);
    const i = indexOrder.indexOf(r);
    if (i >= 0) order.push([i, r]);
  });
  /* 26-b */
  for (let i = 1; i < order.length; i++) {
    if (order[i][0] < order[i - 1][0]) {
      err(`${rel} 的脚本顺序与 index.html 相反：${order[i][1]} 应在 ${order[i - 1][1]} 之前`);
      docBad++; pageBad++;
      break;
    }
  }
  if (!loaded.length) { ok(`${rel}：不加载游戏代码，无需依赖检查`); return; }
  /* 26-c */
  const inline = (raw.match(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi) || []).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const used = {};
  (inline.match(/G\.([A-Za-z_$][\w$]*)/g) || []).forEach(m => {
    const nm = m.slice(2);
    if (gExportMap[nm]) used[nm] = gExportMap[nm];      // 不存在于任何模块的名字当作文档里的示例，不管
  });
  const lack = Object.keys(used).filter(nm => loaded.indexOf(used[nm]) < 0);
  if (lack.length) {
    err(`${rel} 用到了 G.${lack.join(' / G.')}，但页面没加载定义它们的模块：` +
      lack.map(nm => used[nm]).filter((v, i, a) => a.indexOf(v) === i).join('、'));
    docBad++; pageBad++;
  }
  if (!pageBad) ok(`${rel}：${loaded.length} 个脚本齐全、顺序与入口一致、用到的 ${Object.keys(used).length} 个 G.* 都有来源`);
});
if (docPages.length === 0) { err('没有扫到任何文档页/工具页（路径写错了？）'); docBad++; }


/* ---------------- 27. 统计面板：理论时长不能和「已收满」打架 ----------------
   `estOwnHours` / `estUnlockHours` 是「从零收满要多久」的**理论值**，不随进度变化。
   原来两格直接把它当「预计收满」显示 —— 满图鉴的玩家会看到「当前钓场预计收满 2 小时」
   这种自相矛盾的数（与 ㉓ 节「体重占比 155% 上限」同一类：文案与数据对不上）。
   顺带盯住这段里的「只算不用」局部变量（这处曾有一个查完不用的 `maxFish`）。
   ⚠️ 死变量的扫描范围从「总览」块扩到**整个统计视图** ——
      「各钓场进度」里原来还有一个 `var need` 算完不用，正好落在旧范围之外。 */
console.log('\n[27] 统计面板：理论时长必须标注「已收满」，且不留只算不用的局部变量');
let statsBad = 0;
const statsView = (panelsSrc.match(/VIEWS\.stats = \{[\s\S]*?\n  \};/) || [''])[0];
if (!statsView) { err('panels.js 里找不到 VIEWS.stats 整个视图'); statsBad++; }
else {
  const overview = (statsView.match(/root\.appendChild\(U\.el\('div', 'section-title', '总览'\)\);[\s\S]*?root\.appendChild\(g1\);/) || [''])[0];
  if (!overview) { err('panels.js 里找不到统计面板的「总览」块'); statsBad++; }
  else if (overview.indexOf('estOwnHours') >= 0 || overview.indexOf('estUnlockHours') >= 0) {
    if (!/pct\s*>=\s*1/.test(overview) || overview.indexOf('已收满') < 0) {
      err('统计面板把理论时长当「预计收满」显示，却没有在 100% 时改口成「已收满」');
      statsBad++;
    }
  }
  /* 只扫代码不扫注释：否则上面那段「原来叫 maxFish / need」的说明会把名字带回来 */
  const viewCode = statsView.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const decls = (viewCode.match(/var\s+([A-Za-z_$][\w$]*)\s*=/g) || [])
    .map(s => s.replace(/var\s+/, '').replace(/\s*=$/, ''));
  const deadLocals = decls.filter(nm => (viewCode.match(new RegExp('\\b' + escRe(nm) + '\\b', 'g')) || []).length < 2);
  if (deadLocals.length) {
    err(`统计面板里这些局部变量只赋值、没有任何使用：${deadLocals.join('、')}`);
    statsBad++;
  }
  /* 「各钓场进度」的门槛百分比同理：写死「需前置 100%」就多了一份真相，
     隐藏钓场的 collectionPct 本来就是 1.0，现算即可。 */
  if (/需前置\s*[\d.]+\s*%/.test(viewCode)) {
    err('统计面板把钓场解锁门槛写死成「需前置 N%」了 —— 应读 f.collectionPct');
    statsBad++;
  }
}
if (!statsBad) ok('统计面板的理论时长会随「已收满」改口，且没有只算不用的局部变量 / 写死的门槛百分比');


/* ---------------- 28. 鱼饵 speed 的文案方向 ----------------
   `items.js` 里鱼饵的 `speed` 是**等待时间的倍率**（`Loot.biteTime` 里 `t *= bait.speed`），
   越小咬口越快。商店却把它写成「上鱼速度 ×0.56」—— 方向正好说反：
   看着像砍掉 44% 速度，实际是快了 79%。玩家按字面理解就会觉得好饵是坑。
   现在统一叫「咬口时间」。 */
console.log('\n[28] 鱼饵 speed 只能叫「咬口时间」（不许叫「上鱼速度」）');
let baitWordBad = 0;
const wordMods = [];
(function walkSrc(dir) {
  fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
    const rel = dir + '/' + name;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walkSrc(rel);
    else if (/\.js$/.test(name)) wordMods.push(rel);
  });
})('src');
wordMods.forEach(m => {
  const code = fs.readFileSync(path.join(ROOT, m), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (code.indexOf('上鱼速度') >= 0) {
    err(`${m} 里又把鱼饵 speed 写成「上鱼速度」了 —— 它乘的是咬口时间，越小越快，方向会说反`);
    baitWordBad++;
  }
  /* 只叫「速度 ×0.56」同样说反（少了「上鱼」两个字，上一版就这么漏过去的：
     商店改了、底栏的「选择鱼饵」面板没改）。鱼饵相关的文案只许叫「咬口时间」。 */
  if (/速度\s*×/.test(code)) {
    err(`${m} 里鱼饵 speed 又写成「速度 ×…」了 —— 只许叫「咬口时间」（越小越快）`);
    baitWordBad++;
  }
});
/* 两处鱼饵界面（商店 / 底栏选饵面板）都得标「咬口时间 ×」。
   ⚠️ 必须扫**去掉注释**后的代码 —— 第一次写这条时用的是原始源码，
   结果被自己那段「写成『速度 ×0.56』方向正好说反」的说明注释喂饱了（假通过）。 */
const panelsCode = panelsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const baitTimeHits = (panelsCode.match(/咬口时间 ×/g) || []).length;
if (baitTimeHits < 2) {
  err(`鱼饵的「咬口时间 ×」标注只有 ${baitTimeHits} 处（商店 / 选饵面板各需一处）`); baitWordBad++;
}
/* 消耗口径同理：只写「每抛一竿消耗一个」而不提「提前收杆退回」，
   与 v0.5.7 的实现（以及 GDD §6.1 / 说明书）不一致 —— 玩家会以为收杆也亏饵。 */
if (panelsCode.indexOf('提前收杆') < 0) {
  err('panels.js 的鱼饵消耗说明没提「提前收杆退饵」，与 v0.5.7 的口径不一致'); baitWordBad++;
}
['docs/GDD.md', 'docs/说明书.html'].forEach(f => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (t.indexOf('上鱼速度') >= 0) { err(`${f} 的鱼饵表还写着「上鱼速度」`); baitWordBad++; }
});
if (!baitWordBad) ok('商店 / GDD / 说明书都按「咬口时间」表述（越小越快），方向不再说反');


/* ---------------- 29. 界面里的文案数值与配色常量都要单一来源 ----------------
   项目硬约束：「平衡数值全部集中在 `src/data/config.js`，逻辑里不许写死数值」。
   但文案字符串最容易漏 —— 挂机的「稀有 ×0.95」曾在 main.js / 设置页 / 离线报告
   三处各写一遍、「离线补算上限 8 小时」也写死过。改 config 的时候没人会想起
   这三句中文，于是界面说的和实际跑的就会悄悄分家。
   同理，钓场等级配色表曾在「钓场选择 / 图鉴 / 统计」三处各写了一份，
   连兜底色都不一样 —— 加一个新等级漏改一处，同一张卡片会在不同面板里变色。 */
console.log('\n[29] 界面文案的数值 / 配色常量必须单一来源');
let copyNumBad = 0;
const copyTargets = ['src/main.js', 'src/ui/panels.js'];
copyTargets.forEach(m => {
  const code = fs.readFileSync(path.join(ROOT, m), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (code.indexOf('×0.95') >= 0) {
    err(`${m} 里把挂机稀有权重写死成「×0.95」了 —— 应读 CFG.idle.rareWeightMul`); copyNumBad++;
  }
  if (/上限\s*8\s*小时/.test(code)) {
    err(`${m} 里把离线补算上限写死成「8 小时」了 —— 应读 CFG.idle.maxCatchUp`); copyNumBad++;
  }
});
['src/main.js', 'src/ui/panels.js'].forEach(m => {
  if (fs.readFileSync(path.join(ROOT, m), 'utf8').indexOf('rareWeightMul') < 0) {
    err(`${m} 没有消费 CFG.idle.rareWeightMul（挂机稀有倍率的文案会漂）`); copyNumBad++;
  }
});
if (panelsSrc.indexOf('maxCatchUp') < 0) {
  err('panels.js 没有消费 CFG.idle.maxCatchUp（离线补算上限的文案会漂）'); copyNumBad++;
}
/* 钓场等级配色表只许有一份：SSS 的色值是它最独特的标记，全项目只该出现 1 次 */
(function () {
  let hits = 0;
  const walk = dir => fs.readdirSync(path.join(ROOT, dir)).forEach(nm => {
    const rel = dir + '/' + nm;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.(js|css)$/.test(nm)) {
      hits += (fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/#a87a1f/g) || []).length;
    }
  });
  walk('src'); walk('assets');
  if (hits !== 1) {
    err(`钓场等级配色表（#a87a1f）在代码里出现了 ${hits} 次，应恰好 1 次（多份会各自漂）`); copyNumBad++;
  }
})();
/* 钓场解锁门槛的文案必须现算自 fields.js。
   「钓场选择」页的说明原来把「80%」「隐藏钓场 SS / SSS」「七个钓场」三样全写死，
   而同一页的钓场卡片读的是 `f.collectionPct` / `G.FIELDS.length` ——
   改一次数据，说明和卡片就分家（同 §29 上面这类「文案里的第二份真相」）。
   `docs/说明书.html` 的钓场表同理。 */
(function () {
  const code = panelsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/\b80\s*%/.test(code)) {
    err('panels.js 里又把钓场解锁门槛写死成「80%」了 —— 应走 fieldGateText() 现算'); copyNumBad++;
  }
  if (code.indexOf('七个钓场') >= 0) {
    err('panels.js 里把钓场数量写死成「七个钓场」了 —— 应读 G.FIELDS.length'); copyNumBad++;
  }
  const gateHits = (code.match(/fieldGateText/g) || []).length;
  if (gateHits < 2) {
    err(`fieldGateText() 出现 ${gateHits} 次（定义 1 次 + 至少 1 处调用）—— 解锁门槛文案会与钓场数据分家`);
    copyNumBad++;
  }
  const manual = fs.readFileSync(path.join(ROOT, 'docs/说明书.html'), 'utf8');
  if (/图鉴\s*80%/.test(manual)) {
    err('docs/说明书.html 的钓场表又把「图鉴 80%」写死了 —— 应读 f.collectionPct'); copyNumBad++;
  }
})();
/* 图鉴详情页说明里的「普通鱼基准：闪光 1%、黄金 3%」同理 ——
   那两个数就是 colorMorphs 的普通档概率，而同一页每一行已经在用
   `fmtPct(Loot.colorProb(cm, ...))` 现算了，只有这句说明留了第二份真相。 */
(function () {
  const code = panelsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/闪光\s*[\d.]+\s*%|黄金\s*[\d.]+\s*%/.test(code)) {
    err('panels.js 里把颜色基准概率写死了（「闪光 1% / 黄金 3%」）—— 应走 Loot.colorProb() 现算');
    copyNumBad++;
  }
  const plainHits = (code.match(/pctPlain/g) || []).length;
  if (plainHits < 2) {
    err(`pctPlain() 出现 ${plainHits} 次（定义 1 次 + 至少 1 处调用）—— 颜色基准说明会与 config 分家`);
    copyNumBad++;
  }
})();
/* 顶栏天气芯片的「好时机」高亮阈值同理：原来写死 `sn.rareMul >= 1.2`，
   config.weather 里没有对应项 —— 调完天气倍率这个 1.2 就失去意义了。 */
(function () {
  const hudCode = fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (/rareMul\s*[<>]=?\s*[\d.]/.test(hudCode)) {
    err('hud.js 里把天气高亮阈值写死了 —— 应读 CFG.weather.goodMul'); copyNumBad++;
  }
  if (hudCode.indexOf('weather.goodMul') < 0) {
    err('hud.js 没有消费 CFG.weather.goodMul（天气高亮阈值会与 config 分家）'); copyNumBad++;
  }
})();
if (!copyNumBad) ok('挂机倍率 / 离线补算上限 / 解锁门槛 / 颜色基准概率 / 天气高亮阈值的文案都现算自数据，钓场配色表只有一份');


/* ---------------- 29-b. 生态值颜色系数**不许**从售价倍率派生（倍率改动会连锁放大） ----------------
   🔴 2026-10-07 修的真 bug：`state.js` 里算生态值用的是
      `colorBase + colorSpan × cm.valueMul` —— 售价倍率从 4.00 改成 100 之后，
      闪光档的颜色系数从 **2.0 变成 30.8（设计值的 15.4 倍）**，而没人改过那一行。
   **根因是「派生」**：售价倍率是经济杠杆、生态值系数是收集杠杆，两者不该挂钩。
   已改成独立的 `CFG.eco.colorMul`（逐个还原改动前的实际取值）。
   本节盯两件事：① state.js 的生态值路径里不许再出现 `valueMul`；② colorMul 的跨度要平缓。 */
console.log('\n[29-b] 生态值颜色系数：独立配置，不许从售价倍率派生');
(function () {
  const st = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fn = st.slice(st.indexOf('function ecoValue'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  if (body.indexOf('valueMul') >= 0) {
    err('state.js 的 ecoValue() 又去读 valueMul 了 —— 售价倍率一改，生态值会被连锁放大（曾放大到 15.4 倍）');
    return;
  }
  const cm = CFG.eco.colorMul;
  if (!cm) { err('CFG.eco.colorMul 不存在 —— 生态值颜色系数必须有独立配置'); return; }
  const miss = CFG.colorMorphs.filter(m => cm[m.key] == null).map(m => m.key);
  if (miss.length) { err(`CFG.eco.colorMul 缺档位：${miss.join('、')}`); return; }
  const vals = CFG.colorMorphs.map(m => cm[m.key]);
  const spread = Math.max(...vals) / Math.min(...vals);
  if (spread > 2.5) {
    err(`生态值颜色系数的跨度过大（${spread.toFixed(2)} 倍，应 ≤2.5）—— 放生稀有颜色会变成刷生态值`
      + `（售价的跨度可以有 100 倍，但生态值是收集货币，必须平缓）`);
    return;
  }
  ok(`生态值颜色系数独立且平缓（${CFG.colorMorphs.map((m, i) => m.key + '×' + vals[i]).join(' / ')}，跨度 ${spread.toFixed(2)}×）`);
})();

/* ---------------- 30. 读档兜底的接线 ----------------
   `load()` 现在会在读档出问题时给 `St.loadNote()` 留一句话（退备份 / 已重置），
   但如果 main.js 没人读它，这句话就永远不出现 —— 玩家看到的还是「进度莫名没了」。
   同理 `config.saveKeyRescue`（坏档留存）必须有写入方。
   这里只接线；真正的行为断言在 tools/test.js 的「读档失败不再白屏」一节。 */
console.log('\n[30] 读档兜底的接线（提示语要有人播、rescue 键要有人写）');
let loadWireBad = 0;
(function () {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const stateCode = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const stateExports = /loadNote:\s*loadNoteText/.test(stateCode);
  if (!stateExports) { err('state.js 没有把 loadNote() 暴露出去（提示语传不到 UI）'); loadWireBad++; }
  if (!/St\.loadNote[\s\S]{0,240}Hud\.toast/.test(mainSrc)) {
    err('main.js 没有把 St.loadNote() 通过 toast 播出去 —— 读档出问题时玩家收不到任何提示');
    loadWireBad++;
  }
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/data/config.js'), 'utf8');
  if (cfgSrc.indexOf('saveKeyRescue') < 0) {
    err('config 里没有 saveKeyRescue —— 坏档没地方留存，下一次自动存档就把证据盖掉了');
    loadWireBad++;
  }
  if (stateCode.indexOf('CFG.saveKeyRescue') < 0) {
    err('state.js 没有写 saveKeyRescue（坏档留存等于没做）'); loadWireBad++;
  }
  /* migrate 抛异常必须被接住。
     原来那条会冒到 boot() 的写法是「三元里直接调」：
       `S = data && typeof data === 'object' ? migrate(data) : blank();`
     （不能简单地找 `S = ... migrate(` —— 修好之后 `S = migrate(data);` 仍在，
      只是被 try 包住了。） */
  if (/\?\s*migrate\(/.test(stateCode)) {
    err('load() 又在三元表达式里裸调 migrate() 了 —— 迁移抛异常会一路冒到 boot() 变白屏');
    loadWireBad++;
  }
  const loadBody = (stateCode.match(/function load\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  if (loadBody.indexOf('migrate(') < 0 || loadBody.indexOf('try {') < 0 || loadBody.indexOf('catch') < 0) {
    err('load() 没有把 migrate() 包在 try / catch 里（读档失败就会白屏）'); loadWireBad++;
  }
})();
if (!loadWireBad) ok('读档提示语会播出去，坏档也有留存，迁移异常被接住');


/* ---------------- 31. 表现层接口不许「只在文档里存在」 ----------------
   实测过的一种静默失效：`scene.js` 的 `showShadow()` + `updateShadow()` +
   `drawUnderwater()` 里的鱼影分支一共几十行，而 `showShadow()` **全项目零调用**
   → `S.fishShadow` 永远是 null → 那两段代码从来没跑过；
   而开发者文档 §5.1 却把它写成「供 fishing.js 调用」的现成接口。
   这类「文档里有、代码里没人调」的死接口不会有任何报错，只能靠断言盯。
   这里查的是**读写闭环**：写了状态却没人读、或读的状态没人写，都算断链。 */
console.log('\n[31] 表现层接口的接线（鱼影：写、读、收尾三处都要有人）');
let wireBad = 0;
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const sceneCode = strip(fs.readFileSync(path.join(ROOT, 'src/render/scene.js'), 'utf8'));
  const fishingSrc = fs.readFileSync(path.join(ROOT, 'src/core/fishing.js'), 'utf8');
  const srcAll = (function () {
    const out = [];
    const walk = d => fs.readdirSync(d).forEach(n => {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
    });
    walk(path.join(ROOT, 'src'));
    return out.join('\n');
  })();

  /* ① 有人写：showShadow() 必须在 fishing.js 里被真的调到 */
  if (fishingSrc.indexOf('Scene.showShadow(') < 0) {
    err('fishing.js 没有调用 G.Scene.showShadow() —— S.fishShadow 永远是 null，鱼影那几十行是死的');
    wireBad++;
  }
  /* ② 有人读：写进去的状态必须在画面上被消费 */
  if (!/if\s*\(\s*S\.fishShadow\s*\)/.test(sceneCode)) {
    err('scene.js 里没有任何地方读 S.fishShadow —— 鱼影写了也不会出现'); wireBad++;
  }
  /* ③ 有人收尾：回合结束后不许留在水里 */
  const endFightBody = (sceneCode.match(/function endFight\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  if (endFightBody.indexOf('S.fishShadow') < 0) {
    err('Scene.endFight() 没有清 S.fishShadow —— 上岸 / 收杆之后鱼影会一直留在水里'); wireBad++;
  }
  /* ④ 同一个坑的反面：接口既要在导出面上，也要在 src 里真的有调用方 */
  if (!/showShadow:\s*showShadow/.test(sceneCode)) {
    err('scene.js 没有导出 showShadow（fishing.js 调用它会直接 TypeError）'); wireBad++;
  }
  void srcAll;
})();
if (!wireBad) ok('鱼影的「写 → 读 → 收尾」三处接线都在，且 showShadow 在导出面上');


/* ---------------- 32. 导出面上的「零消费」死函数（全部模块） ----------------
   第 ㉕ 节只扫了 `util.js`。实测**每个模块都积了一批**：G.U 那次删掉 5 个之后，
   别处又长出 `Platform.input.upOn`（未文档化、无人调用）、`Platform.isWeb`（同一个
   事实在顶层与 sys 里各写了一份、都没人读）、`Loot.envWeight / pickInBucket`
   （只在 loot.js 内部用，不该出现在导出面上）、`Scene.getRodTip / getFloat`、
   `Track.kinds`（与 count() 完全同义的重复接口）、`Hud.clearCatchLog`、
   `FishArt.paintTo`（开发者文档 §5.2 说它给图鉴 / 结算卡用，实际那两处都直接调
   `G.FishArt.draw`，所以它零调用）…… 全是同一类：**看着像基础设施，实际没人用**。
   判据（比 ㉕ 更宽松，避免误报）：某个导出名在**它自己文件之外**的
   `src/` `tools/` `docs/` `index.html` 里一次都没出现过 → 报错。
   白名单只留「按设计就不该被代码调用」的：控制台 API 与将来接外部服务的接入点。 */
console.log('\n[32] 所有模块的导出面：除白名单外，每个导出都要有消费方');
let deadExportBad = 0;
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const collect = (dir, re, out) => fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
    const p = path.join(ROOT, dir, n);
    if (fs.statSync(p).isDirectory()) collect(dir + '/' + n, re, out);
    else if (re.test(n)) out.push(dir + '/' + n);
  });
  const rel = [];
  collect('src', /\.js$/, rel);
  collect('tools', /\.(js|html)$/, rel);
  collect('docs', /\.html$/, rel);
  rel.push('index.html');
  const code = {};
  rel.forEach(r => { code[r] = strip(fs.readFileSync(path.join(ROOT, r), 'utf8')); });

  /* 「按设计就没有代码消费方」的名单：模块 → 允许零调用的导出名 */
  const WHITELIST = {
    /* G.Cheat.* 是**控制台 API**（开发者文档 §11 逐条列着），只在手动调试时敲，
       代码里当然不会有人调。同理 mount() 由自身 boot() 触发。 */
    'src/ui/devtools.js': ['unlockAll', 'fillBook', 'fillColors', 'addCoin', 'setPlayTime',
      'clearSave', 'finishQuests', 'addMedals', 'addEco', 'allDecors',
      'dumpTrack', 'trackCount', 'mount'],
    /* G.Track 的「将来接外部服务」接入点：文档 §16.4 明确说上线时才实现 flush。 */
    'src/core/track.js': ['flush', 'onFlush', 'dumpJson'],
    /* 定点调试用（按 key 强制天气 / 时段，复现某个环境下的数值），文档 §11 已列。 */
    'src/core/weather.js': ['set'],
  };

  /* 从模块里取出「顶层 return 的导出块」。两种写法都认：
       `return { ... };`（多数模块）与 `var API = { ... }; return API;`（audio.js） */
  function exportKeys(txt) {
    let m = [...txt.matchAll(/^  return \{/gm)];
    let start = -1;
    if (m.length) start = m[m.length - 1].index + '  return {'.length;
    else {
      m = [...txt.matchAll(/^  var API = \{/gm)];
      if (m.length) start = m[m.length - 1].index + '  var API = {'.length;
    }
    if (start < 0) return [];
    const end = txt.indexOf('};', start);
    if (end < 0) return [];
    const block = txt.slice(start, end);
    const keys = [];
    (block.match(/(^|[\s{,])([A-Za-z_$][\w$]*)\s*:/g) || []).forEach(s => {
      const k = s.replace(/^[\s{,]+/, '').replace(/\s*:$/, '');
      if (keys.indexOf(k) < 0) keys.push(k);
    });
    return keys;
  }

  let checked = 0, modCount = 0;
  rel.filter(r => r.startsWith('src/') && r.endsWith('.js')).forEach(r => {
    const keys = exportKeys(code[r]);
    if (!keys.length) return;
    checked += keys.length;
    modCount++;
    const allow = WHITELIST[r] || [];
    const dead = keys.filter(k => {
      if (allow.indexOf(k) >= 0) return false;
      const re = new RegExp('(^|[^A-Za-z0-9_$])' + k.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_$])');
      return !rel.some(g => g !== r && re.test(code[g]));
    });
    if (dead.length) {
      err(`${r} 的导出里这些名字全项目零调用：${dead.join('、')}（删掉，或补一处真实用例；确实不该有调用方的请加白名单并写明理由）`);
      deadExportBad++;
    }
  });
  if (!deadExportBad) ok(`${modCount} 个模块共 ${checked} 个导出都有真实消费方，白名单只留控制台 API 与外部上报接入点`);
})();

/* 32-b 运行时兜底：短名字的按名扫描有假阴性（`state` / `resize` / `set` / `flush`
   这些名字很容易在别处撞上同名字段，于是 `exportKeys` + 全文正则这套网会漏掉它们），
   所以对「已经删过一次的死接口」做一次**运行时**回归 —— 只许消失，不许悄悄回来。
   （这条正是上面 ㉜ 扫不到的那类：`Scene.state` / `Scene.resize` 挂了很久没人发现。） */
console.log('\n[32-b] 已清理过的死接口不许复活（运行时按路径取值）');
(function () {
  const REMOVED = ['Scene.state', 'Scene.resize', 'Scene.getRodTip', 'Scene.getFloat',
    'Platform.sys.isWeb', 'Platform.input.upOn', 'Loot.envWeight', 'Loot.pickInBucket',
    'Fight.isRunning', 'Audio.isEnabled', 'Audio.getVolume', 'Tutorial.isFinished',
    'Panels.getPendingCatch', 'Panels.hideCatch', 'FishArt.paintTo', 'Hud.el'];
  const at = p => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), sandbox.G);
  const back = REMOVED.filter(p => at(p) !== undefined);
  if (back.length) {
    err(`这些死接口又被加回导出面了：${back.join('、')}（零消费的导出要删掉，别留「看着像基础设施」的 API）`);
  } else {
    ok(`${REMOVED.length} 条已知死接口在运行时确认仍然不存在`);
  }
})();


/* ---------------- 33. 体型数量：文档 / 出图工具必须与代码一致 ----------------
   代码里是 **9 种**（`TPL.fish / eel / ray / squid / jelly / oarfish / shark / whale / dragon`），
   而 GDD 两处 + 开发者文档一处都写着「10 种体型」，开发者文档 §5.2 自己又写着 9 ——
   同一份文档里两个数字打架，而且**没有任何报错**。
   出图工具更狠：`tools/style-preview.html` 的标题是「全形态总览（6 风格 × 10 种体型）」，
   但 `SHAPES` 里列的 11 条鱼只有 fish / eel / jelly 三种体型 —— 漏了 6 种还叫「全形态」。
   判据（都是现算，不写死 9）：① 「N 体型 / N 种体型」的 N 必须等于 fish.js 里的体型数
                              ② 出图工具的代表鱼必须覆盖全部体型 */
console.log('\n[33] 体型数量：文档文案与出图工具的覆盖都要与 fishart.js 一致');
let shapeBad = 0;
(function () {
  const shapeSet = {};
  G.FISH.forEach(f => { shapeSet[f.shape] = true; });
  const shapes = Object.keys(shapeSet).sort();
  const n = shapes.length;

  /* ① 文案里的数字
     ⚠️ `.html` 里的 `<script>` 也是代码：必须**先剥掉块注释**再匹配 ——
        第一版没剥，结果把 style-preview.html 里那句「标题说全形态、实际漏了 6 种体型」
        的说明注释当成了正文（自己把自己喂饱 → 假报红）。 */
  const docs = ['docs/GDD.md', 'docs/开发者文档.md', 'docs/说明书.html', 'README.md',
                'tools/style-preview.html'];
  docs.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    let txt = fs.readFileSync(p, 'utf8');
    if (/\.html$/.test(rel)) txt = txt.replace(/\/\*[\s\S]*?\*\//g, '');
    (txt.match(/\d+\s*种?体型/g) || []).forEach(hit => {
      const num = parseInt(hit, 10);
      if (num !== n) {
        err(`${rel} 写着「${hit}」，而 src/render/fishart.js 只有 ${n} 种体型（${shapes.join(' / ')}）`);
        shapeBad++;
      }
    });
  });

  /* ② 出图工具的代表鱼覆盖 */
  const previewSrc = fs.readFileSync(path.join(ROOT, 'tools/style-preview.html'), 'utf8');
  const arr = (previewSrc.match(/var SHAPES\s*=\s*\[([\s\S]*?)\];/) || [, ''])[1];
  const ids = (arr.match(/'([A-Z]+\d+)'/g) || []).map(s => s.replace(/'/g, ''));
  if (!ids.length) { err('style-preview.html 里找不到 SHAPES 代表鱼列表'); shapeBad++; }
  const miss = shapes.filter(sh => !ids.some(id => G.FISH_ID[id] && G.FISH_ID[id].shape === sh));
  if (miss.length) {
    err(`tools/style-preview.html 的「全形态总览」漏了 ${miss.length} 种体型：${miss.join(' / ')}` +
        `（标题写着「全形态」，实际只有 ${shapes.length - miss.length} 种）`);
    shapeBad++;
  }
  const badId = ids.filter(id => !G.FISH_ID[id]);
  if (badId.length) { err(`style-preview.html 的代表鱼里有不存在的 id：${badId.join(' / ')}`); shapeBad++; }
  const uniq = {};
  ids.forEach(id => { if (G.FISH_ID[id]) uniq[G.FISH_ID[id].shape] = 1; });
  if (Object.keys(uniq).length !== ids.length) {
    warn(`style-preview 的代表鱼里有重复体型（${ids.length} 条鱼只覆盖 ${Object.keys(uniq).length} 种）`);
  }
})();
if (!shapeBad) ok(`文档里的体型数量与出图工具的覆盖都等于代码里的 ${Object.keys(G.FISH.reduce((a, f) => (a[f.shape] = 1, a), {})).length} 种`);

/* 33-b 钓场结构数字（品种数 / 解锁门槛 / 传说条数）也必须与数据一致
   和 ㉝ 同一类：文档里写死的数字会随着数值调整悄悄过期，且没有任何报错。
   这次抓到的：GDD 的解锁规则还写着「D 有 6 种鱼 → 需 5 种」「SS 共 60 种、SSS 共 84 种」，
   说明书还写着「D 和 C 钓场没有传说鱼」—— 而实际上 D 16 种 / C 24 种，
   D~S 共 182 种、D~SS 共 262 种，且**每个钓场都有传说鱼**（D / C 各 1 条）。
   判据全部现算，不写死任何数字。 */
console.log('\n[33-b] 文档里的钓场结构数字（品种数 / 门槛 / 传说条数）必须与数据一致');
let structBad = 0;
(function () {
  const cnt = {};
  G.FIELDS.forEach(f => { cnt[f.id] = G.FISH_BY_FIELD[f.id].length; });
  const legendary = {};
  G.FIELDS.forEach(f => { legendary[f.id] = (G.FISH_BY_FIELD_RARITY[f.id][3] || []).length; });
  const cum = (from, to) => G.FIELDS.slice(from, to).reduce((a, f) => a + cnt[f.id], 0);
  const cumSet = [cum(0, 5), cum(0, 6)];   // D~S 与 D~SS

  const docList = ['docs/GDD.md', 'docs/说明书.html', 'README.md', 'docs/开发者文档.md'];
  docList.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, 'utf8');

    /* ① 「X 有/只有 N 种鱼」的 N 必须等于该钓场的品种数 */
    (txt.match(/[A-Z]+\s*[有只]\s*有?\s*\d+\s*种鱼/g) || []).forEach(hit => {
      const m = hit.match(/([A-Z]+)[\s\S]*?(\d+)\s*种鱼/);
      if (!m || cnt[m[1]] == null) return;
      if (parseInt(m[2], 10) !== cnt[m[1]]) {
        err(`${rel} 写着「${hit.trim()}」，而钓场 ${m[1]} 实际有 ${cnt[m[1]]} 种鱼`);
        structBad++;
      }
    });

    /* ② 解锁规则里「全 100%（共 N 种）」的 N 必须等于 D~S 或 D~SS 的实际累计。
       只认这个上下文 —— 文档里还有「共 362 种鱼」这种总量说法，不该被这条管。 */
    (txt.match(/100%\s*[（(]\s*共\s*\d+\s*种/g) || []).forEach(hit => {
      /* ⚠️ 取「共」后面的那个数，不能把前面的 100 也算进去 */
      const num = parseInt((hit.match(/共\s*(\d+)/) || [, '0'])[1], 10);
      if (cumSet.indexOf(num) < 0) {
        err(`${rel} 写着「${hit}」，而实际累计只有 D~S = ${cumSet[0]} 种、D~SS = ${cumSet[1]} 种`);
        structBad++;
      }
    });

    /* ③ 每个钓场都有传说鱼时，不许再写「某钓场没有传说鱼」 */
    const hasLegendary = G.FIELDS.some(f => legendary[f.id] > 0);
    if (hasLegendary && /没有传说鱼/.test(txt)) {
      err(`${rel} 还写着「没有传说鱼」—— 实际每个钓场都有（D / C 各 ${legendary.D} 条）`);
      structBad++;
    }
  });

  if (!structBad) {
    ok(`钓场结构文案与数据一致（D ${cnt.D} 种 / C ${cnt.C} 种；D~S ${cumSet[0]} 种、D~SS ${cumSet[1]} 种；` +
       `传说条数 ${G.FIELDS.map(f => legendary[f.id]).join('/')}）`);
  }
})();


/* ---------------- 33-c. 五档提示词必须复用母版骨架，只换「颜色句」 ----------------
   2026-10-07 口径：**五档全部走文生图**（图生图已弃用）。
   每档提示词 = 母版提示词**只换颜色句**，其余逐字相同 —— 由 `build_morph_prompt()` 保证：
   它调用**同一个** `build_prompt()`，再挖掉 `palette_desc(f)` 换上该档的颜色句。
   踩过的坑：曾经「母版一个骨架、五档另一个骨架」，两套风格常量各写一份，
   于是母版与五档「不像一家人」。**现在只允许有一份骨架定义**（见 §33-e）。
   量化的代价（已与用户确认接受）：档位之间剪影 IoU 从图生图的 0.997 降到 0.93 ——
   ⚠️ 也就是说**档位之间不再是「同一条鱼换漆」，而是同一条鱼的不同个体**。
   对拍留痕：`docs/images/card-ab/_t2i-vs-i2i.png`。 */
console.log('\n[33-c] 五档提示词必须复用母版骨架，只换颜色句');
(function () {
  const p = path.join(ROOT, 'tools/gen-art.py');
  if (!fs.existsSync(p)) { err('tools/gen-art.py 不存在'); return; }
  const src = fs.readFileSync(p, 'utf8').replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  if (!/def build_morph_prompt/.test(src)) {
    err('gen-art.py 里没有 build_morph_prompt() —— 五档提示词没走「复用母版骨架」那条路'); return;
  }
  const body = src.slice(src.indexOf('def build_morph_prompt'));
  const fn = body.slice(0, body.indexOf('\ndef ', 10));
  const miss = ['build_prompt(', 'palette_desc(', '.replace('].filter(k => fn.indexOf(k) < 0);
  if (miss.length) {
    err(`build_morph_prompt() 没有「调 build_prompt → 换掉 palette_desc」的写法（缺 ${miss.join('、')}）`
      + ` —— 五档会另起一套骨架，与母版口径分家`); return;
  }
  ok('build_morph_prompt() 复用 build_prompt 骨架 + 只替换颜色句');
})();


/* ---------------- 33-d. 抠图接线：必须产出 RGBA，且极性必须反转 ---------------- 
   2026-10-07 新增：卡面改为**透明 PNG**（真 alpha，靠 BiRefNet），背景噪音问题从根上消失。
   🔴 盯住四件事（都是「不报错只出错结果」型）：
     ① `RemoveBackground` 的 MASK 是**亮 = 背景**，alpha 要的是**亮 = 主体** ——
        **必须经 `InvertMask`**。去掉这一步不会报错，只会得到「鱼透明、底不透明」，
        而且看着还挺「干净」，肉眼极难发现。
     ② 必须走 `LoadBackgroundRemovalModel` + `JoinImageWithAlpha` 才真的产出 alpha；
        只在提示词里写「transparent PNG」是**没用**的 ——
        扩散模型输出的是像素，它会把「透明」画成一个**棋盘格**。
     ③ `gen-art.py` 必须把抠图**接进出图流程**（`import cutout` + `cutout.cut_one`），
        否则五档又会退回「暗底 + 噪点」。
     ④ `tools/gen-morph.py` **必须已删除** —— 它是旧图生图管线的入口，留着就是地雷
        （历史事故：废弃脚本被定时任务误跑，静默产出 45 张废图）。
   完整背景见 `tools/cutout.py` 文件头。 */
console.log('\n[33-d] 抠图接线：产 RGBA + mask 极性反转 + 旧管线入口已清除');
(function () {
  const p = path.join(ROOT, 'tools/cutout.py');
  if (!fs.existsSync(p)) { err('tools/cutout.py 不存在 —— 卡面透明化那一步没了'); return; }
  /* 剥掉 `#` 注释**和**三引号字符串，否则文件头的说明书会自己把自己喂饱 */
  const src = fs.readFileSync(p, 'utf8')
    .replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  const need = [
    ['LoadBackgroundRemovalModel', '加载抠图模型'],
    ['birefnet', 'BiRefNet 权重名'],
    ['RemoveBackground', '抠图节点'],
    ['InvertMask', '🔴 极性反转（去掉 = 鱼变透明）'],
    ['JoinImageWithAlpha', '合成 alpha 产出 RGBA'],
  ];
  const miss = need.filter(([k]) => src.indexOf(k) < 0).map(([k, why]) => `${k}（${why}）`);
  if (miss.length) { err(`tools/cutout.py 缺少：${miss.join('、')}`); return; }

  const ga = fs.readFileSync(path.join(ROOT, 'tools/gen-art.py'), 'utf8')
    .replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  if (!/import cutout/.test(ga) || !/cutout\.cut_one/.test(ga)) {
    err('gen-art.py 没把抠图接进出图流程（缺 `import cutout` / `cutout.cut_one`）—— 五档会退回暗底噪点');
    return;
  }
  if (fs.existsSync(path.join(ROOT, 'tools/gen-morph.py'))) {
    err('tools/gen-morph.py 又出现了 —— 旧图生图管线的入口会被误跑（曾静默产出 45 张废图），必须删掉');
    return;
  }

  // ── 无人值守跑图的两条保险（2026-10-08 补）──────────────────────────────
  //  ① `--budget-min`：定时任务每轮必须能在 40 分钟窗口内自己停下来。
  //     没有它就只能「按条数估」，而每条鱼 5.2 分钟，估错就和下一轮叠在一起。
  //  ② 互斥锁：两个生图进程同时跑会**重复出图 + 并发写 manifest.json**。
  const guard = [
    ['--budget-min', '时间预算（定时任务靠它把单轮压进窗口）'],
    ['.gen-art.lock', '互斥锁（防两个生图进程同时跑）'],
    ['lock_write', '锁的心跳刷新'],
    ['--img-timeout', '单张等待上限（卡死时不再白等 3600s）'],
  ];
  const gmiss = guard.filter(([k]) => ga.indexOf(k) < 0).map(([k, why]) => `${k}（${why}）`);
  if (gmiss.length) {
    err(`gen-art.py 缺少无人值守保险：${gmiss.join('、')}`);
    return;
  }
  ok('抠图接线完整（BiRefNet → RemoveBackground → InvertMask → JoinImageWithAlpha），已接入 gen-art，旧管线入口已清除；'
     + '无人值守保险齐（时间预算 / 互斥锁 / 心跳 / 单张超时）');
})();


/* ---------------- 33-e. 低模精细度 + 「骨架只能有一份定义」 ----------------
   2026-10-07 修正：`GEOM` 原稿写的是
     `Built from large flat angular facets, ... minimal surface detail`
   —— 字面上命令模型「用**大**面片、**尽量少**的表面细节」，结果鱼身只有 30~50 个大块，
   比 v9 标准图（密集三角网，密度 ≈3.6 色块/千px）糙得多。**改提示词不会报错，只会变难看。**
   教训：这块防的是「写实」，不是「密度」，**两者可以同时要**（见开发者文档 §17.10）。
   🔴 另盯一件：骨架（BASE / GEOM / LIGHT / BG）**全项目只允许有一份定义**。
      以前 gen-art.py 与 gen-morph.py 各写一份，靠「必须逐字一致」的**约定**维持 ——
      约定会忘记，机制不会。现在 gen-morph.py 已并入 gen-art.py，这条改成**机制检查**。
   量化工具：`python tools/facet-count.py`（靶子 ≈ 3.6）。 */
console.log('\n[33-e] 低模精细度：GEOM 要密度不要「大面片」；骨架全项目只许有一份');
(function () {
  const src = fs.readFileSync(path.join(ROOT, 'tools/gen-art.py'), 'utf8')
    .replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  const toStr = (m) => (m ? (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join(' ') : null);
  const geom = toStr(src.match(/^GEOM\s*=\s*\(([\s\S]*?)\)\s*$/m));
  const base = toStr(src.match(/^BASE\s*=\s*\(([\s\S]*?)\)\s*$/m));
  if (!geom || !base) { err('读不到 gen-art.py 的 BASE / GEOM 常量'); return; }

  /* ① 不许再出现「大面片 / 最少细节」这种把低模写粗的措辞 */
  const BAD = ['large flat angular facets', 'minimal surface detail'];
  const hit = BAD.filter(s => geom.includes(s));
  if (hit.length) {
    err(`GEOM 里又出现了「把低模写粗」的措辞：${hit.join('、')} —— `
      + `实测那样鱼身只有 30~50 个大块（v9 靶子密度 ≈3.6 色块/千px，老稿只有 ≈1.5）`);
    return;
  }
  /* ② 必须显式要求「密集细分」 */
  const DENSITY = ['dense triangular polygon mesh', 'dense', 'tessellation', 'many small'];
  if (!DENSITY.some(s => geom.includes(s))) {
    err(`GEOM 没有要求面片密度（要出现 dense / tessellation / many small 之类的词）：${geom}`); return;
  }
  /* ③ 骨架只能有一份定义：tools/ 下不许再有第二个 GEOM = ... */
  const others = fs.readdirSync(path.join(ROOT, 'tools'))
    .filter(n => n.endsWith('.py') && n !== 'gen-art.py')
    .filter(n => /^GEOM\s*=\s*\(/m.test(fs.readFileSync(path.join(ROOT, 'tools', n), 'utf8')));
  if (others.length) {
    err(`骨架常量出现了第二份定义：${others.join('、')} —— 母版与五档会口径分家，骨架只许写在 gen-art.py`);
    return;
  }
  ok('GEOM 明确要求密集三角网；骨架常量全项目只有 gen-art.py 一份定义（密度判据见 tools/facet-count.py）');
})();

/* ---------------- 33-f. 五档颜色句：候选总表 + 权重池，且抽样必须可复现 ----------------
   2026-10-08 定稿（用户口径：「四档提示词有点单一，多跑几套我来挑，之后生成时随机挑一套」）：
   🔴 1. `MORPH_CANDIDATES` —— **候选总表**，键 = 出处档/编号，值 = (标签, 颜色句)。
         落选的句子也留着（下次换型要原句），所以池子里只有一部分键，**不许按前缀过滤**。
     2. `MORPH_POOL` —— **正式池子**，每档一串 `(候选键, 权重)`。
     3. `MORPHS` 仍 = 5 档每档一句（清单 / manifest / 耗时常量按它算），**由 1+2 派生**。
   🔴 盯四件事（全是本项目的高频坑型）：
     ① **颜色句只能有一份**：`MORPHS` 必须由 `MORPH_CANDIDATES[MORPH_POOL[k][0][0]][1]` 派生；
        池子里**只许出现「候选键 + 权重」**，不许把句子原文抄进池子（两份拷贝必然漂开）。
     ② **权重 ≥1 且模块加载时就校验**（`check_pools()` 必须被调用）——
        权重 ≤0 或候选键写错 = 那套句子**永远抽不到、而且不报错**，
        362 张图没人会去数。放在加载时是因为「记得手动跑一下」在本项目反复栽跟头。
     ③ **抽样必须可复现**：`morph_pick()` 必须用 `hashlib.md5`，**不许用内置 `hash()`** ——
        后者带 PYTHONHASHSEED 随机盐，**每次进程启动结果都不一样** →
        同一条鱼今天出金色、明天出古铜金，manifest 里的提示词与磁盘上的图对不上。
     ④ 基准句仍在候选总表里（`MORPHS` 取的就是它们，四档各留一句特征词做留证）。
   ⚠️ 这里只能做**文本结构**检查（verify 不跑 python）。真实抽签分布由
   `python tools/prompt-ab.py --picks` 打印（每套句子的实际占比 vs 期望占比）。 */
console.log('\n[33-f] 五档颜色句：候选总表 + 权重池；MORPHS 派生；抽样用 md5 可复现');
(function () {
  const p = path.join(ROOT, 'tools/gen-art.py');
  if (!fs.existsSync(p)) { err('tools/gen-art.py 不存在'); return; }
  const src = fs.readFileSync(p, 'utf8').replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  if (!/MORPH_CANDIDATES\s*=\s*\{/.test(src) || !/MORPH_POOL\s*=\s*\{/.test(src)) {
    err('gen-art.py 缺少 MORPH_CANDIDATES / MORPH_POOL —— 五档又回到「每档只有一句」'); return;
  }
  /* ① 单一来源：MORPHS 由候选总表 + 池子派生 */
  if (!/MORPHS\s*=\s*\[\(k,\s*MORPH_CANDIDATES\[MORPH_POOL\[k\]\[0\]\[0\]\]\[1\]\)/.test(src)) {
    err('MORPHS 不再由 MORPH_CANDIDATES[MORPH_POOL[k][0][0]][1] 派生 —— '
      + '颜色句出现了第二份拷贝，两份必然漂开'); return;
  }
  /* ①b 池子里只许有「候选键 + 权重」，不许出现句子原文（连续三个英文单词 = 抄了原文） */
  const poolStart = src.indexOf('MORPH_POOL = {');
  const poolBody = src.slice(poolStart, src.indexOf('\n}', poolStart));
  if ((poolBody.match(/\(\s*"[a-z]+\/\d+"\s*,\s*\d+\s*\)/g) || []).length < 4) {
    err('MORPH_POOL 里没有找到 ≥4 个 `("候选键", 权重)` 元组 —— 池子结构不对'); return;
  }
  if (/[a-z]{4,} [a-z]{4,} [a-z]{4,}/.test(poolBody)) {
    err('MORPH_POOL 里出现了成段的英文原文 —— 颜色句被抄进池子了，'
      + '它只该引用 MORPH_CANDIDATES 的键'); return;
  }
  /* ② 自检必须真的被调用，不只是定义 */
  if (!/def check_pools\(/.test(src) || !/^check_pools\(\)\s*$/m.test(src)) {
    err('check_pools() 没定义或**没在模块加载时被调用** —— 权重 ≤0 / 候选键写错会静默通过'); return;
  }
  /* ③ 可复现：必须 md5，不许内置 hash() */
  const pk = src.slice(src.indexOf('def morph_pick'));
  const pickFn = pk.slice(0, pk.indexOf('\ndef ', 10));
  if (!/hashlib\.md5/.test(pickFn)) {
    err('morph_pick() 没有用 hashlib.md5 —— 抽样不可复现，跨进程会变'); return;
  }
  if (/\bhash\(/.test(pickFn)) {
    err('morph_pick() 用了内置 hash() —— 它带 PYTHONHASHSEED 随机盐，'
      + '每次进程启动结果都不一样，manifest 与磁盘上的图会对不上'); return;
  }
  /* ④ 基准句逐档在册 ——
     ⚠️ 比对前要先把**跨行的字符串隐式拼接**接回去（`.replace(/"\s*"/g, '')` 去掉
        「引号 换行 引号」），否则只要某句被折成两行，这条检查就会误报「被删了」，
        而它想抓的其实是「句子本身被改了」。折行与内容无关，不该影响判定。 */
  const flat = src.replace(/"\s*"/g, '').replace(/\s+/g, ' ');
  const BASE = {
    bright: 'from magenta and orange through yellow and cyan to blue and violet',
    albino: 'pale creamy white body, soft pink translucent fins, pale pink eye',
    golden: 'rich brass and gold tones, brilliant golden sheen, high luminance',
    shiny: 'star-shaped sparkle highlights, prismatic sheen',
  };
  const miss = Object.keys(BASE).filter(k => flat.indexOf(BASE[k]) < 0);
  if (miss.length) {
    err(`基准颜色句被删了或改动了：${miss.join('、')} —— 池子第 0 项引用的就是它们，不许动`);
    return;
  }
  ok('候选总表 + 权重池齐备；MORPHS 派生、池内只存键与权重；check_pools() 加载即校验；'
    + 'morph_pick 走 md5（可复现）；四档基准句在册');
})();

/* ---------------- 34. 文档里写的「自检 N 节」必须就是本文件的节数 ----------------
   开发者文档 §8 出现过「数据自检 29 节」、GDD §目录树 写着「自检 15 节」，
   而本文件早就不是这个数了 —— 每加一节就过期一次，而且没人会去核对。
   这里改成现算：数一遍本文件里的 `console.log('\n[N] …')`，与文档里的措辞比对。
   测试的「项数」同理不再写进文档（加一条断言就漂），只说「以输出为准」。 */
console.log('\n[34] 文档里写的自检节数 == 本文件真实的节数');
let secBad = 0;
(function () {
  const self = fs.readFileSync(path.join(ROOT, 'tools/verify.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const real = (self.match(/console\.log\('\\n\[\d+\]/g) || []).length;
  const docs = ['docs/开发者文档.md', 'docs/GDD.md', 'docs/说明书.html', 'README.md'];
  let found = 0;
  docs.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, 'utf8');
    const hits = [];
    (txt.match(/自检\s*\d+\s*节/g) || []).forEach(h => hits.push(h));
    (txt.match(/\d+\s*节一致性断言/g) || []).forEach(h => hits.push(h));
    hits.forEach(h => {
      found++;
      const n = parseInt(h.replace(/[^\d]/g, ''), 10);
      if (n !== real) {
        err(`${rel} 写着「${h}」，而 tools/verify.js 实际有 ${real} 节`);
        secBad++;
      }
    });
  });
  if (!found) { err('四份文档里都找不到「自检 N 节」的描述（改了措辞就来更新这条断言）'); secBad++; }
})();
if (!secBad) ok(`文档里的节数与 verify.js 实际节数一致（如实写 ${(fs.readFileSync(path.join(ROOT, 'tools/verify.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').match(/console\.log\('\\n\[\d+\]/g) || []).length} 节）`);


/* ---------------- 35. 主循环的三条守则（三条都是踩过的坑） ----------------
   ① **失焦时不许渲染**：失焦 = 暂停（St.tick / Weather / F.update 全按 focused 拦住了），
      画面本来就静止；原来无条件 `S.render(dt)`，切到别的应用还在 60fps 重画水面与粒子。
      浏览器只在**标签页不可见**时节流 rAF，「窗口失焦但页面可见」不节流 → 纯烧电。
   ② **帧率上限**：`FRAME_MIN` 锁 60fps（高刷屏原本跑满 144 帧）。
   ③ **浏览面板不暂停钓鱼**：`paused` 只能由结算卡决定 —— 原来写成
      `P.isCatchOpen() || P.isOpen()`，挂机时打开图鉴鱼就不咬了（挂机游戏的核心预期）。 */
console.log('\n[35] 主循环守则：失焦不渲染 / 锁 60fps / 浏览面板不暂停钓鱼');
let loopBad = 0;
(function () {
  const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  if (/\n\s*S\.render\(dt\);/.test(code)) {
    err('main.js 的主循环里 `S.render(dt)` 又变成不带条件的裸语句了 —— 失焦时还在全速重画');
    loopBad++;
  }
  if (!/if\s*\(focused\)\s*S\.render\(dt\)/.test(code)) {
    err('main.js 里找不到 `if (focused) S.render(dt)` —— 主循环的渲染守卫不见了'); loopBad++;
  }
  if (code.indexOf('FRAME_MIN') < 0 || !/frameAcc\s*<\s*FRAME_MIN/.test(code)) {
    err('main.js 里没有 60fps 帧率闸门（FRAME_MIN）—— 高刷屏会空转'); loopBad++;
  }
  const pausedLine = (code.match(/var paused\s*=\s*[^;]+;/) || [''])[0];
  if (!pausedLine || pausedLine.indexOf('isCatchOpen') < 0 || pausedLine.indexOf('P.isOpen()') >= 0) {
    err(`main.js 的 paused 判定不对：「${pausedLine.trim()}」—— 只有结算卡才能暂停钓鱼` +
        '（写成 P.isOpen() 会让挂机时一开图鉴就停摆）');
    loopBad++;
  }
})();
if (!loopBad) ok('失焦不渲染、锁 60fps、只有结算卡会暂停钓鱼（三条守则都还在）');

/* 35-b 每帧路径上的 UI 文案不许无条件重写 innerHTML
   （和 ⑰ 节的「每帧不许新建渐变」同一类：不报错、只是每帧白跑一遍）。
   踩过的：`Hud.updateFight()` 被 main.js 每帧调一次，里面四个分支各自写
   `el.fightTip.innerHTML = …` —— 文案其实只在状态切换时才变，
   60fps 下每帧都让浏览器把同一段 HTML 重新解析一遍。 */
console.log('\n[35-b] 每帧走的 UI 文案要缓存（不许无条件重写 innerHTML）');
(function () {
  const hud = fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = (hud.match(/function updateFight\s*\(s\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  if (!fn) { err('找不到 hud.js 的 updateFight()（改了名字就来更新这条断言）'); return; }
  const writes = (fn.match(/el\.fightTip\.innerHTML\s*=/g) || []).length;
  if (writes > 1 || fn.indexOf('fightTipCache') < 0) {
    err(`updateFight() 里对 fightTip.innerHTML 的赋值有 ${writes} 处，且没有缓存判断 —— ` +
        '每帧都会重写（改成：算出文案 → 变了才写）');
    return;
  }
  ok('updateFight() 只在文案变化时才写 #fightTip');
})();


/* ---------------- 36. 平台能力只能通过 G.Platform ----------------
   硬约束第 5 条：存储 / 音频 / 画布 / 输入 / 系统信息 / 剪贴板 / 对话框
   一律走 G.Platform，否则上小程序时要全项目搜替换一遍（G1 / G2 / G5 那几项就是欠账）。

   踩过的：设置面板的「重置 / 导出 / 导入」直接用了 confirm / navigator.clipboard /
   window.prompt / location.reload（连**重置都会重载两次** —— `St.reset()` 自己也
   `emit('reset')`，main.js 已经在重载了），开发者面板同样；scene.js 直接监听
   window resize，main.js 直接读 document.visibilityState。

   判据：src 下除 platform.js 外，不许出现这些浏览器专有用法；**只看代码不看注释**
   （注释里会写「不碰 localStorage」这类词），也不把界面文案里的字面词算进来。 */
console.log('\n[36] 平台能力只能通过 G.Platform（不得直连浏览器专有 API）');
let platBad = 0;
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 名字 → 判据。都刻意避开「前面是 `.`」的情形（`G.Platform.dialog.confirm(` 合法）。 */
  const FORBID = [
    ['location.reload', /location\s*\.\s*reload\s*\(/],
    ['navigator.clipboard', /navigator\s*\.\s*clipboard/],
    ['window.prompt', /window\s*\.\s*prompt\s*\(/],
    ['原生 prompt(', /(^|[^\w$.])prompt\s*\(/],
    ['原生 confirm(', /(^|[^\w$.])confirm\s*\(/],
    ['document.visibilityState', /document\s*\.\s*visibilityState/],
    ['window.addEventListener(...)', /window\s*\.\s*addEventListener\s*\(/],
    ['localStorage 读写', /\blocalStorage\s*\.\s*(get|set|remove)Item/],
  ];
  const rel = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.js$/.test(n)) rel.push(dir + '/' + n);
    });
  })('src');
  const checked = rel.filter(r => r !== 'src/core/platform.js');
  checked.forEach(r => {
    const code = strip(fs.readFileSync(path.join(ROOT, r), 'utf8'));
    FORBID.forEach(pair => {
      if (pair[1].test(code)) { err(`${r} 里直接用了「${pair[0]}」—— 平台能力必须走 G.Platform`); platBad++; }
    });
  });
  if (!platBad) ok(`src 下除 platform.js 外的 ${checked.length} 个模块都没有直连浏览器专有 API`);
})();


/* ---------------- 37. 读 config 的键必须真的存在 ----------------
   踩过的（同一个根因的另一半）：`tools/gen-collect-time.js` 读 `cm.prob`
   —— 那个字段早改了名，于是比较器拿到 `undefined`、排序静默失效，
   把「最稀有的颜色」标成了原色（见第 2-b 节）。
   **读一个不存在的键永远不会报错**，只会算错、或让兜底值静默生效，
   所以这里把所有 `CFG.x.y.z` 的静态路径拿到运行时真解析一遍。

   已知局限（刻意的）：只认**静态的点号链**。`CFG.rarity[t].timeMin`、
   `CFG[name]`、`CFG.fight[key]` 这类动态取值扫不到 —— 断言只能当网用。 */
console.log('\n[37] 读 config 的键必须真的存在（读不存在的键不会报错）');
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.js$/.test(n)) files.push(dir + '/' + n);
    });
  })('src');
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      if (/\.js$/.test(n)) files.push(dir + '/' + n);
    });
  })('tools');

  const cfg = sandbox.G && sandbox.G.CONFIG;
  if (!cfg) { err('沙箱里没有 G.CONFIG —— 第 ⑪ 节没把 config.js 加载进来？'); return; }
  /* 前面必须有「非标识符」边界：否则 `GOAL_CFG.dailyMedals` 里的 `CFG.` 会被误认 */
  const re = /(?:^|[^\w$.])(?:CFG|G\.CONFIG)((?:\.[A-Za-z_][\w]*)+)/g;
  const bad = {};
  let checked = 0;
  files.forEach(r => {
    const code = strip(fs.readFileSync(path.join(ROOT, r), 'utf8'));
    let m;
    while ((m = re.exec(code))) {
      const parts = m[1].slice(1).split('.');
      let o = cfg, i;
      for (i = 0; i < parts.length; i++) {
        if (o == null || o[parts[i]] === undefined) break;
        o = o[parts[i]];
      }
      checked++;
      if (i < parts.length) {
        const key = parts.slice(0, i + 1).join('.');
        (bad[key] = bad[key] || []).push(r);
      }
    }
    re.lastIndex = 0;
  });
  const keys = Object.keys(bad);
  if (keys.length) {
    keys.forEach(k => err(`config 里没有 \`${k}\`，但 ${bad[k].join('、')} 在读它 —— 拿到的是 undefined（不报错，只会算错或走兜底）`));
  } else {
    ok(`${files.length} 个文件里的 ${checked} 处 config 取值路径全部存在`);
  }
})();


console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
