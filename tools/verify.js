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

/* ---------- 源码文本比对：折行不敏感的两个助手 ----------
   🔴 踩过的坑（第 33-f 节）：按**原文子串**比对的断言会被「折行」误伤。
   源码里一句长字符串经常被排版成两行（JS 与 Python 都同理，Python 还有
   「引号 换行 引号」的隐式拼接）。这时子串在原文字面里**根本连不上**，
   于是断言报「这句话被删了」—— 可它想抓的其实是**内容被改**。
   折行属于排版，与内容无关，不该影响判定；这类误报攒多了，门禁就被当噪音无视
   （真出问题时反而没人看）。
   → 凡拿**散文式**文本（含空格 / 连续汉字 / 长句）去比对源码的，
     一律走 `has()` / `idx()`，不要裸写 `indexOf()`。第 ㊳ 节会盯住这条。
   · flat(t)    先把隐式拼接接回去（`"` + 换行 + `"` → 空），再把所有空白压成单个空格
   · idx(t, n)  == flat(t).indexOf(flat(n))
   · has(t, n)  == idx(t, n) >= 0
   ⚠️ 结构锚点（`'\n  }'`、带 `start` 偏移的 slice/indexOf、正则）**不要**过 flat ——
      它们本来就依赖换行与位置。 */
function flat(t) { return String(t).replace(/"\s*"/g, '').replace(/\s+/g, ' '); }
function idx(t, n) { return flat(t).indexOf(flat(n)); }
function has(t, n) { return idx(t, n) >= 0; }
/* 需要**原始偏移**（要拿去 slice）时用 at()：返回位置，词与词之间允许任意空白
   （含换行）。⚠️ 不能拿 idx() 的返回值去 slice —— 那是压平之后的坐标，
   和原文偏移对不上（栽过一次：第 33-c / 33-f 节当场读歪，报「少了 build_prompt(」）。 */
function at(t, phrase) {
  const re = new RegExp(String(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+'));
  const m = re.exec(String(t));
  return m ? m.index : -1;
}
/* 从「某个标记」起切出它的函数 / 方法体：终止于「缩进 ≤ 该标记自身缩进」的第一行。
   ⚠️ 缩进必须**按标记自己所在行的缩进算**，不能写死 4：
      · 顶层函数（`def build_console_script(`，缩进 0）→ 终止于下一个顶行；
      · 套在 serve() 里的（`def worker(`，缩进 4）→ 终止于 `    class Handler`。
      第一版写死「≤4 就算结束」，于是顶层函数的体（本身正好缩进 4）**第一行就被截断**，
      判据直接假红 —— 差点把好好的代码判成 bug。
   为什么提到顶层共享：第 40 / 43 / 44 节都要切函数体（Python 的与页内 JS 的）。
   页内 JS 也吃这一套：它的函数体全部带缩进、闭合的 `}` 落在第 0 列 —— 于是切片正好停在函数尾。
   ⚠️ 别用「下一个 `\nfunction `」当终止符：最后一个函数后面跟的是
      `document.getElementById(...).onclick = function () {`（不在行首）⇒ 会一路切到脚本末尾，
      判据于是被**后面那些函数**喂饱（「放行条件写宽了」那一类假通过）。 */
function bodyOf(src, marker) {
  const i = String(src).indexOf(marker);
  if (i < 0) return '';
  const rest = String(src).slice(i);
  const nl = rest.indexOf('\n');
  if (nl < 0) return rest;
  const ls = String(src).lastIndexOf('\n', i) + 1;   // 该行的行首
  const indent = i - ls;                             // 标记前面的缩进量
  /* ⚠️ 从 `nl` 起搜（不是 `nl + 1`）：终止符是「换行 + ≤indent 个空格 + 非空白」，
     从 `nl` 起搜才对**单行函数体**（`function f(d) { return d.x; }`）生效 ——
     从 `nl+1` 起搜会跳过它自己那一行，于是单行定义**永远找不到终止符**、一路切到文件末尾。
     实测：第 43 节的合成样本（好/坏两份都是单行）因此双双判成「0 处裸印」= 自检假通过。 */
  const m = new RegExp('\\n {0,' + indent + '}\\S').exec(rest.slice(nl));
  return m ? rest.slice(0, nl + m.index + 1) : rest;
}
/* 判据：这个 needle 属于「会被折行影响」的散文式吗？
   含反斜杠转义 = 结构锚点；纯标识符 / 路径（无空格、汉字 <4 个）不受折行影响。 */
function isProseNeedle(n) {
  if (/\\/.test(n)) return false;
  return /\s/.test(n) || (n.match(/[\u4e00-\u9fff]/g) || []).length >= 4;
}

/* ---------- 引用豁免（只给**开发向**文档用，见第 28 节的措辞禁令） ----------
   写规则说明时难免要**提到**被禁的那句话（「不许写成 `上鱼速度`」），
   于是断言把自己要解释的东西也一起报红了 —— 想讲清规则反而得绕开它。
   所以：把**被引号 / 反引号包起来**的片段挖空再匹配。
   ⚠️ 三条边界，缺一条这个豁免就会变成假通过：
     ① **只对措辞类禁令**用，数值类禁令不用（文档里写死数字就是错，与加不加引号无关）；
     ② **只对开发向文档**用（`开发者文档` / `GDD` / `README`）；`说明书.html` 是玩家向手册，
        它写的「引号」就是**真的界面文案**，一律照原文匹配；
     ③ **源码永不豁免** —— 源码里的字符串本身就是违规载体（`err('…七个钓场…')` 那种）。
      第 28 节末尾有一条自检盯着 ②③ 没被写宽。 */
function maskQuoted(t) {
  return String(t)
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/「[^」\n]*」/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/‘[^’\n]*’/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/'[^'\n]*'/g, ' ');
}
const DEV_DOCS = ['docs/GDD.md', 'docs/开发者文档.md', 'README.md'];
const PLAYER_DOCS = ['docs/说明书.html'];

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

/* theme 里的**舞台开关**同理：写了 `rocks: true` 却没有绘制分支 →
   那就是一句「看着有用、其实没人读」的数据（C 场这样躺了整整一个版本，直到 32-g 抓出来）。
   判据（只扫代码不扫注释）：每个开了开关的钓场，`scene.js` 里必须读到它 ——
   `buildStatic()` 里没有 `th` 参数，读的是 `field.theme.<键>`，绘制函数里读 `th.<键>`，两种都认。 */
let noStage = 0;
const stageBody = sceneSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
(G.FIELDS || []).forEach(f => {
  const th = f.theme || {};
  Object.keys(th).forEach(k => {
    if (typeof th[k] !== 'boolean') return;
    const re = new RegExp('(th|field\\.theme)\\.' + k + '(?![A-Za-z0-9_$])');
    if (!re.test(stageBody)) {
      err(`${f.id} 场（${f.name}）的 theme.${k} = ${th[k]}，但 scene.js 里没人读它`
        + '（要么补绘制分支，要么删掉这个开关）');
      noStage++;
    }
  });
});
if (!noStage) ok('所有钓场的 theme 布尔开关都有对应的绘制分支');

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
if (!/G\.Platform\.sys\.onBlur\s*\(/.test(hudSrc)) {
  err('hud.js 没有在窗口失焦时兜底放线 —— 指针在窗口外抬起（拖出浏览器 / 切应用）会一直收线到断线');
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
  if (has(showCatchCode, '体长')) {
    err('结算卡又写「体长」了 —— 这一行算的是体重占常规上限的比例，游戏里根本没有体长数据');
    catchBad++;
  }
  if (showCatchCode.indexOf('maxKg') < 0) { err('结算卡不再对比同种的体重上限了'); catchBad++; }
  if (!has(showCatchCode, '巨物')) {
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
    if (!/pct\s*>=\s*1/.test(overview) || !has(overview, '已收满')) {
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
  if (has(code, '上鱼速度')) {
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
if (!has(panelsCode, '提前收杆')) {
  err('panels.js 的鱼饵消耗说明没提「提前收杆退饵」，与 v0.5.7 的口径不一致'); baitWordBad++;
}
/* 文档侧的两条措辞禁令走「引用豁免」：玩家向手册照原文，开发向文档允许用引号引用反例。 */
PLAYER_DOCS.forEach(f => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (has(t, '上鱼速度')) { err(`${f} 的鱼饵表还写着「上鱼速度」`); baitWordBad++; }
});
DEV_DOCS.forEach(f => {
  if (!fs.existsSync(path.join(ROOT, f))) return;
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (has(maskQuoted(t), '上鱼速度')) {
    err(`${f} 的鱼饵表还写着「上鱼速度」（且**不是**引号包起来的反例）`); baitWordBad++;
  }
});
if (!baitWordBad) ok('商店 / GDD / 说明书都按「咬口时间」表述（越小越快），方向不再说反');

/* 存档导入：实现是「弹一个输入框让玩家自己粘贴」（panels.js → G.Platform.dialog.prompt），
   **全程没读剪贴板**。文档里写「从剪贴板导入」会让玩家以为要先把内容放进剪贴板；
   而 GDD / 开发者文档 / README **三份各写了一遍** —— 正是「同一件事被写 N 遍」的高危型。 */
let impWordBad = 0;
const impDocs = DEV_DOCS.filter(f =>
  fs.existsSync(path.join(ROOT, f))
  && has(maskQuoted(fs.readFileSync(path.join(ROOT, f), 'utf8')), '从剪贴板导入'));
if (impDocs.length) {
  err(`文档里的存档导入措辞与实现不符（实际是粘进对话框，不读剪贴板）：${impDocs.join('、')}`);
  impWordBad++;
}
if (panelsCode.indexOf('dialog.prompt') < 0) {
  err('panels.js 的存档导入没走 G.Platform.dialog.prompt —— 上面那条文档口径依赖它');
  impWordBad++;
}
if (!impWordBad) ok('存档导入的措辞与实现一致（导出到剪贴板 / 粘进对话框导入，不读剪贴板）');

/* 引用豁免的**行为自检**（照第 38 节那套做法：光有规则不够，得证明它真的这么工作）。
   ⚠️ 这个豁免的本质是「把某一类对象整体放行」—— 最危险的写法就是放行范围写宽了还不自知
   （放行条件写宽 = 假通过，比不写还危险）。所以三件事当场证明：
     ① 引号 / 反引号里 → 豁免；② 裸写 → 照报；③ 玩家向手册**不**豁免。 */
(function () {
  const cases = [['`上鱼速度`', false], ['「上鱼速度」', false], ['这就叫上鱼速度', true]];
  let selfBad = 0;
  cases.forEach(c => {
    if (has(maskQuoted(c[0]), '上鱼速度') !== c[1]) {
      err(`引用豁免自检失败：${c[0]} 应${c[1] ? '报红' : '豁免'}`); selfBad++;
    }
  });
  if (!has('`上鱼速度`', '上鱼速度')) { err('玩家向手册的匹配必须照原文（不许走豁免）'); selfBad++; }
  if (selfBad) baitWordBad += selfBad;
  else ok('引用豁免自检：引号内豁免 / 裸写照报 / 玩家向手册不豁免');
})();


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
  if (has(code, '七个钓场')) {
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
  const fn = st.slice(at(st, 'function ecoValue'));
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
  if (loadBody.indexOf('migrate(') < 0 || !has(loadBody, 'try {') || loadBody.indexOf('catch') < 0) {
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
   判据（2026-10-08 二度收口）：某个导出名必须在**它自己文件之外**被一次
   **指向该模块的成员访问**用到 —— `G.<挂载名>.<名>` 或 `<别名>.<名>`
   （别名 = 该消费方文件里 `X = G.<挂载名>` 的绑定）→ 才算有消费方；
   但只在**本模块内**被调用（`API.<名>(` / 裸名 `<名>(`）过 → 也算有消费方。
   ⚠️ 第一次收口（同一天）只要求「成员访问 `X.名字`」，**X 是什么对象不看** ⇒ 于是
      `Audio.legendary`（只被同文件 `success()` 委派，本该被本节抓住）因为 `verify.js`
      里恰好有个叫 `legendary` 的局部变量而蒙混过关；`Audio.sparkle` 靠与
      `Scene.sparkle` **撞名**混过去。没有这条，本节的通过与否取决于「名字有没有在别处
      撞上」而不是「有没有人用」——那样的门禁比没有更糟：它给出的是虚假的安心。
   ⚠️ 第二次收口（本轮，队列 Q3）补上了「X 是哪个对象」：`fight.js` 的 `F.warn` 会
      让 `Track.warn` 看起来被用过。**实证收益**（都是靠撞名活了很久的死接口）：
       · `Track.kinds` —— 与 `count()` 完全同义的重复接口，零调用，靠 `panels.js` 的
         `r.kinds`（那是渔获结果对象）+ `test.js` 的 `oc.kinds` 两个**同名局部量**混过；
       · `Assets.card` —— 零调用，靠 `docs/*.html` 里 CSS 的 `.card{...}` 类选择器混过。
      ⚠️ 别名按**文件**收集（只在绑定了它的那个文件里算数）—— 否则 `main.js` 的
         `S = G.Scene` 会让别的文件里任何一个叫 `S` 的局部量都变成 Scene 的消费方；
         文件内仍有残留（同一文件里 `A = G.Audio` 与 `A = G.Assets` 并存时会互相串），
         所以本节是**网**不是证明：短名字（`list` / `count` / `set`）的结论仍要人看一眼。
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
    /* 图片链的**业务入口**：图鉴 / 鱼护 / 水族箱现在还是程序化绘制（`fishart.js`），
       改用 AI 贴图是队列 **Q8 → Q9**（卡面后处理 spec → 接进三处 UI + 回退链）的事，
       在那之前它确实零调用 —— 它的兄弟 `load` 也只是被它自己调（本节按「同模块内调用」放行）。
       ⚠️ **Q9 落地时必须删掉本条白名单**（`docs/改进待办.md` 里已记下这个约定）：
          「将来会用」当豁免理由，只有在**有明确接盘条目**时才成立。
       ⚠️ 它此前是靠 `docs/*.html` 里 CSS 的 `.card{...}` 类选择器混过本节的（Q3 实证）。 */
    'src/core/assets.js': ['card'],
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

  let checked = 0, modCount = 0, selfOnly = [];
  /* 「本模块内真的调用过」判据。两种形态都要认：
       · 成员调用 `API.<名>(` —— 导出挂在模块对象上时，本模块内只能这么调
         （audio.js 的 `legendary` 被 `success()` 委派）
       · 裸名调用 `<名>(`   —— 局部函数直接调自己
         （util.js 的 `hex2rgb` / `rgb2hex` 只服务同文件的 mix / lighten / darken）
     ⚠️ 先把**声明本身**剥掉再找调用，否则 `function hex2rgb(` 与导出块里的
        `hex2rgb: hex2rgb` 会自己把自己算成一次调用，这条判据就永远为真（形同虚设）。
     抽成函数是因为下面还有一段「判据自检」要用同一份实现（写两份必然分家）。 */
  function selfUsed(txt, k) {
    const n = escRe(k);
    const body = txt
      .replace(new RegExp('function\\s+' + n + '\\s*\\(', 'g'), 'function ')
      .replace(new RegExp('(^|[\\s{,])' + n + '\\s*:', 'g'), '$1');
    return new RegExp('(^|[^A-Za-z0-9_$])' + n + '\\s*\\(').test(body);
  }
  /* 「别的文件里用到过」判据：必须是**指向该模块的表达式**的成员访问。
     两处收口：① 必须是成员访问（`X.名字` / `X['名字']`），裸名不算；
     ② **X 必须真的指向那个模块** —— `G.<挂载名>`，或该文件里 `X = G.<挂载名>` 绑出来的别名。
     ⚠️ 少了 ② 时，「名字撞上就通过」：`r.kinds`（面板里的渔获结果局部量）会把
        `Track.kinds` 判成有人用；`docs/*.html` 的 `.card{...}` 会把 `Assets.card` 判成有人用。
        那样的门禁比没有更糟 —— 它给出的是虚假的安心。
     实现拆两层，是为了「判据自检」能拿合成别名直接调 usedVia()（自己算一份必然分家）。 */
  function usedVia(txt, mod, aliases, k) {
    const ref = '(?:G\\.' + escRe(mod) + '|\\b(?:'
      + (aliases.length ? aliases.map(escRe).join('|') : '(?!)') + '))';
    return new RegExp(ref + '\\s*(?:\\.\\s*' + escRe(k) + '(?![A-Za-z0-9_$])'
      + '|\\[\\s*[\'"]' + escRe(k) + '[\'"])').test(txt);
  }
  /* 模块的「挂载名」：`G.<名> =`（行首、顶层）。认不出来 ⇒ ② 无从生效 ⇒ 后面报错，
     **不许静默退回 ①**（静默放宽正是本节历史上两次假通过的来源）。 */
  function mountName(txt) {
    const m = [...txt.matchAll(/^G\.([A-Za-z_$][\w$]*)\s*=/gm)];
    return m.length ? m[m.length - 1][1] : null;
  }
  /* 每个文件里「指向某模块」的别名。一行声明多个也要认（`var U = G.U, CFG = G.CONFIG;`），
     所以扫全文而不是按行切；`X = G.X`（挂载名与别名同字，如 `U = G.U`）**是合法别名，不许跳过** ——
     第一版把它当自指跳过了，当场让 util.js / hud.js / panels.js 整片误报成死导出（实测）。
     ⚠️ **不给 `=` 加「左边不许是运算符」的守卫** —— 已实测（`_tmp/probe-alias-guard.js`，13 组样本）：
        `a === G.M` / `a <= G.M` / `a += G.M` / `i < G.M` 在本形态下**本来就匹配不上**
        （模式要求赋值号紧贴 `G.`，而比较 / 复合赋值那个 `=` 的左边不是标识符）。
        第一版加了这条守卫、并在自检里声称「比较运算的左值不会被算成别名」—— **那是一句假话**：
        守卫在合法 JS 里不可达，摘掉它自检照样通过。永不生效的守卫 + 声称验过它 = 双重假通过。 */
  function aliasesOf(txt) {
    const map = {};
    const re = /([A-Za-z_$][\w$]*)\s*=\s*G\.([A-Za-z_$][\w$]*)(?![\w$])/g;
    for (const m of txt.matchAll(re)) (map[m[2]] || (map[m[2]] = [])).push(m[1]);
    return map;
  }
  const aliasOf = {};
  rel.forEach(f => { aliasOf[f] = aliasesOf(code[f]); });
  const crossUsed = (f, mod, k) =>
    usedVia(code[f], mod, (aliasOf[f] && aliasOf[f][mod]) || [], k);

  rel.filter(r => r.startsWith('src/') && r.endsWith('.js')).forEach(r => {
    const keys = exportKeys(code[r]);
    if (!keys.length) return;
    const mod = mountName(code[r]);
    if (!mod) {
      err(`${r} 有顶层导出块，却找不到 \`G.<名> =\` 挂载点 —— 第 ㉜ 节的「消费方必须指向该模块」`
        + `这条判据会无从生效（要么按模块的写法补挂载，要么本节改成看得懂的新写法）`);
      deadExportBad++;
      return;
    }
    checked += keys.length;
    modCount++;
    const allow = WHITELIST[r] || [];
    const dead = keys.filter(k => {
      if (allow.indexOf(k) >= 0) return false;
      if (rel.some(g => g !== r && crossUsed(g, mod, k))) return false;
      if (selfUsed(code[r], k)) { selfOnly.push(r.replace(/^src\//, '') + '.' + k); return false; }
      return true;
    });
    if (dead.length) {
      err(`${r} 的导出里这些名字全项目零调用：${dead.join('、')}（删掉，或补一处真实用例；确实不该有调用方的请加白名单并写明理由）`);
      deadExportBad++;
    }
  });

  /* 判据自检：必须**认得出**真消费方、又**没有宽到**把撞名 / 裸名算进来。
     宽了本节形同虚设，窄了会把真消费方误报成死代码 —— 两头都得钉住。
     ⚠️ 样例名用 `zzz*` 前缀：verify.js 自己也在被扫描的消费方名单里，
        样例里出现一个**真实存在的导出名**就会把它「喂」成已消费（自指的坑，㉓ / 38 都栽过）。 */
  (function () {
    const K = 'zzzCrossProbe', K2 = 'zzzSelfProbe';
    const hitDirect = 'var a = G.Zzz.' + K + '();';          // ✓ 直接成员访问
    const hitAlias = 'var a = ZzzAlias.' + K + '(2);';       // ✓ 经该文件里绑定的别名
    const missOther = 'var a = Other.' + K + '(3);';         // ✗ 别的对象上的**同名成员**（撞名）
    const missBare = 'var ' + K + ' = 1; ' + K + '(4);';     // ✗ 裸名
    const missNoAlias = 'var a = ZzzAlias.' + K + '(5);';    // ✗ 别名表为空时不许放行
    if (!usedVia(hitDirect, 'Zzz', [], K) || !usedVia(hitAlias, 'Zzz', ['ZzzAlias'], K)
        || usedVia(missOther, 'Zzz', ['ZzzAlias'], K) || usedVia(missBare, 'Zzz', [], K)
        || usedVia(missNoAlias, 'Zzz', [], K)) {
      err('第 ㉜ 节「跨文件消费方必须指向该模块」判据不成立：' +
          '要么认不出 `G.<挂载名>.名字` / `<别名>.名字`，要么把**别的对象上的同名成员**或裸名'
          + '算成了消费方（后者会让本节重新退化成「撞名即通过」—— 正是 Q3 要收掉的那个口子）');
      deadExportBad++;
    }
    /* 别名收集的行为契约只有两条，自检也只验这两条：
       ① 一行声明多个都要认（`var U = G.U, CFG = G.CONFIG;` 是全项目最常见的写法）；
       ② 别名按**挂载名**归属 —— `W = G.Other` 不许给 `Zzz` 添上 W。
       ⚠️ 样本里的模块名必须是**假名**：verify.js 自己也在被扫描的消费方名单里，
          而 `aliasesOf` 扫的是剥注释后的**全文** —— 样本字符串本身就会造出一个别名，
          写真实模块名等于亲手喂饱自己的判据（自指的第 N 种形态，㉓ / 38 / 32-g 都栽过）。 */
    const al = aliasesOf('var ZzzA = G.Zzz, ZzzB = G.Zzz;\nvar ZzzC = G.Other;');
    if (!al.Zzz || al.Zzz.indexOf('ZzzA') < 0 || al.Zzz.indexOf('ZzzB') < 0
        || al.Zzz.indexOf('ZzzC') >= 0) {
      err('第 ㉜ 节别名收集判据不成立：要么认不出「一行声明多个」'
        + '（`var A = G.M, B = G.M;`），要么把别的模块的别名算到了本模块头上');
      deadExportBad++;
    }
    const self = ['function ' + K2 + '(a){ return a; }\nvar b = ' + K2 + '(1);',   // ✓ 声明之外还有调用
                  'function ' + K2 + '(a){ return a; }',                           // ✗ 只有声明
                  'return { ' + K2 + ': ' + K2 + ' };',                            // ✗ 只有导出
                  'var o = { m(){ return 1; } }; o.' + K2 + '(2);'];               // ✓ 成员调用
    if (!selfUsed(self[0], K2) || selfUsed(self[1], K2) || selfUsed(self[2], K2)
        || !selfUsed(self[3], K2)) {
      err('第 ㉜ 节「同模块内调用也算消费方」判据不成立：' +
          '要么认不出裸名 / 成员调用，要么把函数声明 / 导出块本身算成了调用（后者等于永远为真）');
      deadExportBad++;
    }
  })();
  if (!deadExportBad) {
    ok(`${modCount} 个模块共 ${checked} 个导出都有真实消费方，白名单只留控制台 API 与外部上报接入点`
      + (selfOnly.length
          ? `；另有 ${selfOnly.length} 个只在本模块内被调用（${selfOnly.join('、')}）`
          : ''));
  }
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
    'Panels.getPendingCatch', 'Panels.hideCatch', 'FishArt.paintTo', 'Hud.el',
    /* 平台适配层自己的两个零消费子能力（32-c 扫出来的）：删存储的入口没人用过 ——
       `G.Track.clear()` 是「写一份空表」而不是删键，全项目没有第二处要删存储的地方。 */
    'Platform.storage.remove', 'Platform.sys.size',
    /* 与 `count()` 完全同义的重复接口（连注释都在说假话：它写「去重后的条数」，
       实际 `return buf.length` 与 count() 一模一样）。它靠 `panels.js` 的 `r.kinds`
       （渔获结果局部量）与 `test.js` 的 `oc.kinds` 两个**同名局部量**混过了 ㉜ 很久，
       2026-10-08 把 ㉜ 的判据硬化（消费方必须指向该模块）后才现形。 */
    'Track.kinds'];
  const at = p => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), sandbox.G);
  const back = REMOVED.filter(p => at(p) !== undefined);
  if (back.length) {
    err(`这些死接口又被加回导出面了：${back.join('、')}（零消费的导出要删掉，别留「看着像基础设施」的 API）`);
  } else {
    ok(`${REMOVED.length} 条已知死接口在运行时确认仍然不存在`);
  }
})();


/* 32-c 平台适配层的**子能力**也必须有消费方。
   ㉜ 只扫每个模块「顶层 return 的导出块」，`G.Platform` 底下的
   storage / audio / canvas / sys / input / clipboard / dialog 整片扫不到。
   2026-10-08 一次全项目 API 扫描才翻出来：`storage.remove` 与 `sys.size`
   零调用躺了很久（同期还发现 `sys.now` 零调用，但那是**真该被用的** ——
   业务代码绕过去直接写 `performance.now()`，已收口，见 ㊱）。
   这里在运行时把子键逐个取出来，要求在 platform.js 之外至少被提到一次。
   ⚠️ 短于 4 个字符的键跳过（get / set / up / key / dpr）—— 它们在别处必然
      撞名，这条网对它们只有假阴性，留着当网反而误导。 */
console.log('\n[32-c] 平台适配层的子能力也必须有消费方');
(function () {
  const SUB_WHITELIST = {
    /* 小程序端接入点：Web 端**故意**实现成 no-op，等 platform.weapp.js 去实现。
       platform.js 的注释与开发者文档都写明了这一点。 */
    'Platform.audio.playFile': true,
  };
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const others = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.js$/.test(n) && dir + '/' + n !== 'src/core/platform.js') {
        others.push(strip(fs.readFileSync(p, 'utf8')));
      }
    });
  })('src');
  const P = sandbox.G && sandbox.G.Platform;
  const dead = [];
  let n = 0;
  if (P) Object.keys(P).forEach(grp => {
    const sub = P[grp];
    if (!sub || typeof sub !== 'object') return;
    Object.keys(sub).forEach(k => {
      if (k.length < 4) return;                       // 短名字只当网用，这里刻意跳过
      n++;
      const path = 'Platform.' + grp + '.' + k;
      if (SUB_WHITELIST[path]) return;
      const re = new RegExp('(^|[^A-Za-z0-9_$])' + k.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_$])');
      if (!others.some(s => re.test(s))) dead.push(path);
    });
  });
  if (!P) err('拿不到 G.Platform，32-c 没跑起来');
  else if (dead.length) {
    err(`平台适配层里这些子能力全项目零调用：${dead.join('、')}`
      + '（删掉，或补一处真实用例；确实按设计不该有调用方的请加 SUB_WHITELIST 并写明理由）');
  } else {
    ok(`G.Platform 的 ${n} 个子能力都有真实消费方（白名单只留小程序接入点 audio.playFile）`);
  }
})();

/* ---------------- 32-d. 模块内部状态字段的「只写不读」 ----------------
   上一节的 32-b/32-c 都是**运行时按 `G.*` 路径取值**，够不到模块内部对象。
   踩过的：`src/render/scene.js` 的 `S.fightFish` / `S.fightRarity` 只写不读躺了很久
   （`beginFight(fish)` 把整条鱼对象存进去、`endFight()` 清掉，全项目零读取），
   当时靠一次性探针（正则统计 `S.<字段>` 的写/读次数）才发现，探针用完就丢了。
   这里把它固化下来（静态扫 `src/` 全部 `.js`，只扫代码不扫注释）。

   计数口径：`X.p` 后面紧跟 `= / += / ++ / --` 算**写**，其余算**读**。
   刻意排除两类必然误报的状态对象 —— 它们是「分析不了」，不是「死字段」：
     A) **逃出模块**（裸 `return X` / `return {X: X}`）：别的文件会读它的字段。
        例：`fight.js` 的 `F.tire` 本文件只写不读，但 `main.js` 通过 `Fight.get()` 读它；
            `goals.js` 的 `b.day` 也是 `return b` 后由 state 持久化的。
        ⚠️ 判据是「**裸**返回」（`X` 后面不跟 `.` / `[`）—— 写成 `return X.field` 只是返回一个值、
        对象没逃出，那种行**不能**算逃逸（第一版按「return 行里出现 X」判，
        结果 `scene.js` 里一句 `return U.lerp(…, S.floatT / …)` 就把 `S` 整个放行了，
        注入的探针字段照样不报红）。
     B) **有动态键访问** `X[表达式]`：字段名是算出来的，静态扫不到。
        例：`fishart.js` 的 `TPL[fish.shape]`、`panels.js` 的 `VIEWS[name]`。
   ⚠️ 所以这是**一张网、不是一份证明**：逃出模块的状态里若有真死字段，它照样漏。
   反之命中即为真（模块内部 + 无动态键 + 写了从没读）。 */
console.log('\n[32-d] 模块内部状态字段「只写不读」（逃出模块 / 动态键的对象不参与）');
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
  let skipped = 0;
  const hits = [];
  files.forEach(r => {
    const code = strip(fs.readFileSync(path.join(ROOT, r), 'utf8'));
    /* 候选状态容器：被赋成对象字面量、且至少有一处 `X.字段` 用法 */
    const globs = [...code.matchAll(/(?:^|[^\w$.])(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*\{/g)]
      .map(m => m[1]);
    [...new Set(globs)].forEach(v => {
      if (!new RegExp('(?:^|[^\\w$.])' + v + '\\s*\\.\\s*[A-Za-z_$]').test(code)) return;
      /* A) 逃出模块（`return X` / `return {X: X}` 这种**裸**返回；`return X.field`
            只是返回一个值，对象没逃出）、B) 动态键 */
      if (new RegExp('\\breturn\\b[^;\\n]*\\b' + v + '\\b(?!\\s*[.\\[])').test(code)
        || new RegExp('(?:^|[^\\w$.])' + v + '\\s*\\[').test(code)) { skipped++; return; }
      const props = {};
      const re = new RegExp('(?:^|[^\\w$.])' + v + '\\s*\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
      let m;
      while ((m = re.exec(code))) {
        const k = m[1];
        const after = code.slice(m.index + m[0].length);
        const isWrite = /^\s*(?:=(?!=)|[-+*/%]=|\+\+|--)/.test(after);
        const isDel = /^\s*(?:;|,|\}|$)/.test(after)
          && /delete\s+$/.test(code.slice(0, m.index + m[0].length - k.length));
        props[k] = props[k] || { w: 0, r: 0, d: 0 };
        if (isDel) props[k].d++; else if (isWrite) props[k].w++; else props[k].r++;
      }
      Object.keys(props).forEach(k => {
        const s = props[k];
        if (s.r > 0 || (s.w + s.d) === 0) return;         // 有读，或压根没写
        if (s.d > 0 && s.d >= s.w) return;                // 写完再删：纯生命周期字段
        hits.push(`${r} 的 ${v}.${k}`);
      });
    });
  });
  if (hits.length) {
    err(`模块内部状态字段只写不读：${hits.join('、')}`
      + '（删掉，或说明它为什么必须存在；若该状态对象会逃出模块请在本节注释里写明）');
  } else {
    ok(`src 下没有「只写不读」的模块内部状态字段（${skipped} 个状态对象因逃出模块 / 动态键未参与判定）`);
  }
})();


/* ---------------- 32-e. 战局状态（G.Fight）的对外出口 ----------------
   本节的由来（2026-10-08）：`main.js` 的力竭提示**绕过 `snapshot()`** 直读 `Fight.get()` 的
   原始字段 —— 读 `f.tire`、往别人的状态对象上挂 `f._tiredNote`、兜底条件写成
   `f.tire !== undefined`。三个后果：
     ① `fight.js` 改字段名 → 提示**无声消失**（不报错、不告警）；
     ② 「报过没有」这种对局状态被写进了**调用方**，谁都能改；
     ③ 顺手验出来的**真 bug**：阈值写死 `tire < 0.62`，而 tire 的真实取值区间是
        **[1 - tireMaxDrop, 1] = [0.78, 1]** → **提示上线以来一次都没弹过**。
   所以立两条判据：
     ① `G.Fight.get()` 的字面量位置白名单 —— **只许 core/fishing.js**
        （它是战局的生命周期主人：begin / update / 读 `over`/`result`/`elapsed` 决定状态迁移）。
        main.js 与 ui/ 一律走 `snapshot()` / `tireHint()`。用第 36-a 节那套
        「管字面量出现位置」的办法，新增任何包装器都会立刻暴露。
     ② 力竭提示线必须落在 tire 的取值区间内（读 config 现算）——
        这是「阈值不可达 = 功能静默失效」的通用网；**32-f 把它推广成一张逐项现算的表**。 */
console.log('\n[32-e] 战局原始状态只许 core/fishing.js 直读；力竭提示线必须可达');
let fightRawBad = 0;
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
  const ALLOW = { 'src/core/fishing.js': 2 };   // 允许的文件 → 允许的出现次数（多/少都报红）
  const seen = {};
  files.forEach(r => {
    const code = strip(fs.readFileSync(path.join(ROOT, r), 'utf8'));
    const n = (code.match(/G\.Fight\.get\(\)/g) || []).length;
    if (n) seen[r] = n;
  });
  Object.keys(seen).forEach(r => {
    if (!(r in ALLOW)) {
      err(`${r} 直读战局原始状态（G.Fight.get() ×${seen[r]}）—— `
        + '改走 G.Fight.snapshot() / tireHint()，别碰别人的状态对象');
      fightRawBad++;
    } else if (seen[r] !== ALLOW[r]) {
      err(`${r} 里 G.Fight.get() 的出现次数是 ${seen[r]}，白名单写的是 ${ALLOW[r]}`
        + '（次数变了要连白名单一起改，并在这里说明为什么）');
      fightRawBad++;
    }
  });
  Object.keys(ALLOW).forEach(r => {
    if (!seen[r]) { err(`${r} 里已找不到 G.Fight.get()，白名单条目过期了`); fightRawBad++; }
  });

  /* 力竭提示线必须可达：tire ∈ [1 - tireMaxDrop, 1]，阈值要严格大于下限 */
  const drop = CFG.fight.tireMaxDrop, rng = CFG.fight.tireRampFrom, below = CFG.fight.tireHintBelow;
  const tireMin = 1 - drop;
  const pAt = rng + (100 - rng) * (1 - below) / drop;   // 现算：tire 跌破阈值时的进度
  if (!(below > tireMin && below <= 1)) {
    err(`config.fight.tireHintBelow = ${below} 落在 tire 取值区间 (${tireMin.toFixed(3)}, 1] 之外`
      + ' —— 力竭提示永远不弹（少一句话，玩再久也发现不了）');
    fightRawBad++;
  } else if (pAt >= 100) {
    err(`力竭提示线 ${below} 只在进度 ${pAt.toFixed(1)}%（≥100%）才到得了 —— 等于永不弹`);
    fightRawBad++;
  }
  if (!fightRawBad) {
    ok('战局状态只从 snapshot() / tireHint() 出（G.Fight.get() 只许 core/fishing.js 的 2 处控制流）；'
      + `力竭提示线 ${below} 可达（对应进度 ${pAt.toFixed(1)}%）`);
  }
})();


/* ---------------- 32-f. 配置阈值必须可达（32-e 的通用化） ----------------
   由来（2026-10-08）：32-e 顺手量出的 `tire < 0.62` **永假**（tire ∈ [0.78, 1]）
   不是孤例，而是「拿写死的阈值去比一个**有界量**」这一类写法的共同风险 ——
   阈值一旦落到区间外，**不报错、不告警、门禁全绿**，只是那个分支 / 提示永远不执行。
   32-e 只盯住了力竭提示线这一处，本节把规则做成一张**逐项现算**的表：
   每一条都从 config / items 里算出被比较量的**真实区间**，再检查阈值落在区间内。
   ⚠️ 以后新增「阈值 vs 有界量」的比较，把它加进下面这张表 —— 光靠人算是会漏的。 */
console.log('\n[32-f] 配置阈值必须可达（拿写死阈值比有界量的地方，逐项现算区间）');
let thrBad = 0;
(function () {
  /* 要求 lo < thr（严格：等于下限通常意味着该分支永不触发）且 thr ≤ hi（hiOpen 时严格）。 */
  function need(name, thr, lo, hi, hiOpen) {
    const bad = !(thr > lo) || (hiOpen ? !(thr < hi) : !(thr <= hi));
    if (bad) {
      err(`${name} = ${thr}，而被比较量的取值区间是 (${lo}, ${hi}${hiOpen ? ')' : ']'}`
        + ' —— 对应的分支 / 提示永远不会触发（不报错、无告警，只有翻代码才看得出来）');
      thrBad++;
    }
  }

  /* ① 顶栏天气芯片的「好时机」高亮：rareMul = 天气档 × 时段档，是两个配置表的乘积
        → 真实区间 = [min(天气)×min(时段), max(天气)×max(时段)]。
        高于上界 = 芯片永不亮；不高于最低倍率 = 芯片常亮，高亮就失去了「好时机」的意义。 */
  const wxs = CFG.weather.types.map(t => t.rareMul || 1);
  const tms = CFG.weather.times.map(t => t.rareMul || 1);
  const rLo = Math.min(...wxs) * Math.min(...tms);
  const rHi = Math.max(...wxs) * Math.max(...tms);
  need('config.weather.goodMul', CFG.weather.goodMul, rLo, rHi, false);

  /* ② 松线判定（张力是绝对值）：下限 0（不按就一路掉到 0），
        上界 = 最细的鱼线张力上限（`curLine()` 必来自 G.LINES，缺省回落 baseTensionMax）。 */
  const tMax = G.LINES.map(l => l.tensionMax).concat([CFG.fight.baseTensionMax]);
  need('config.fight.slackSoft', CFG.fight.slackSoft, 0, Math.min(...tMax), true);

  /* ③ 张力安全线是**占比**（0~1 开区间）：≥1 一收线就「危险」，≤0 一收线就判 overSafe。 */
  need('config.fight.safeRatio', CFG.fight.safeRatio, 0, 1, true);

  /* ④ 巨物概率比 `Math.random()`（值域 [0,1)）：0 → 永不巨物，≥1 → 条条巨物。 */
  need('config.weight.giantProb', CFG.weight.giantProb, 0, 1, true);

  /* ⑤ 逃窜预警的切提示线：hud.js 比的是 `F.warn = 1 - max(0, nextDash) / dashWarnLead`
        （fight.js 只在 `nextDash <= dashWarnLead` 时置 warn），所以 warn ∈ [0, 1]。
        ⚠️ 这条的**第二份真相**曾写在 UI 里（`s.warn > 0.4`）：调 dashWarnLead 会连带
        改变提示出现的时刻，阈值却在另一个文件里 —— 现在收进 config 由本表盯住。 */
  const warnLo = 1 - Math.max(0, CFG.fight.dashWarnLead) / CFG.fight.dashWarnLead;
  need('config.fight.warnTipAt', CFG.fight.warnTipAt, warnLo, 1, true);

  if (!thrBad) {
    ok(`配置阈值全部可达：天气高亮线 ${CFG.weather.goodMul} ∈ (${rLo.toFixed(3)}, ${rHi.toFixed(3)}]`
      + `；松线 ${CFG.fight.slackSoft} < 最细鱼线 ${Math.min(...tMax)}`
      + `；安全线 ${CFG.fight.safeRatio}、巨物率 ${CFG.weight.giantProb} 与逃窜预警线 ${CFG.fight.warnTipAt} ∈ (0,1)`);
  }
})();


/* ---------------- 32-g. 数据文件的字段必须有消费方（零出现 = 死字段） ----------------
   由来（2026-10-08）：`src/data/fields.js` 的 `refHoursText` 从 v0.1.0 起就没人读过 ——
   7 条手写字符串（「约 1 小时」…），值还恰好与 `unlockHours` 一一对应，
   属于**同一件事的第二份真相**：改了 `unlockHours` 文案也不会跟着动，而且永远不会有人发现。
   「零消费」这条线之前只覆盖了模块**导出面**（㉜）与模块**内部状态对象**（32-d），
   **数据文件里的字段两边都不在网内**。
   判据（静态扫，只扫代码不扫注释）：`src/data/*.js` 里形如 `key:` 的键，
   在**它自己文件之外**的 `src/` `tools/` `index.html` 里一次都没出现 → 报错。
   ⚠️ 这张网对付的是「真死字段」；短名字（n / x / …）撞名多，只会假阴性 —— 当网用，不当证明。 */
console.log('\n[32-g] 数据文件的字段必须有消费方（零出现 = 死字段）');
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 有意保留、而非「过时重复」的字段：白名单里必须写清为什么留。 */
  const DATA_WHITELIST = {
    /* `misc.biteWindow` 是**按稀有度 key 动态取值**的
       （`fishing.js`：`CFG.misc.biteWindow[CFG.rarity[pending.rar].key]`），
       键名 `common` / `rare` / … 只是表里的行名，静态扫描看不到这层间接 —— 属于「分析不了」。 */
    'src/data/config.js': ['common', 'rare', 'epic', 'legend'],
    /* ⚠️ fields.js 的 `rocks` 曾在这里（「未实现的表现」）—— 2026-10-08 用户拍板补绘制，
       `scene.js` 现在真的读 `th.rocks` 了，所以它**不在白名单里**：
       哪天绘制代码被删掉，本节会立刻报红（另见第 ⑨ 节的「theme 开关必须有绘制分支」）。 */
  };
  const rel = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.(js|html)$/.test(n)) rel.push(dir + '/' + n);
    });
  })('src');
  fs.readdirSync(path.join(ROOT, 'tools')).forEach(n => { if (/\.js$/.test(n)) rel.push('tools/' + n); });
  rel.push('index.html');
  const code = {};
  rel.forEach(r => { code[r] = strip(fs.readFileSync(path.join(ROOT, r), 'utf8')); });

  const dataFiles = rel.filter(r => /^src\/data\/.*\.js$/.test(r));
  let checked = 0;
  const dead = [];
  dataFiles.forEach(r => {
    const allow = DATA_WHITELIST[r] || [];
    const keys = [];
    /* ⚠️ 键**不必在行首**：`items.js` 大量写成单行对象 `{ id:'worm', price:0, speed:1.00 }`，
       第一版按 `^\\s*key:` 取键 → 整个 items.js 只认出 2 个键，注入的死字段**不报红**（假通过）。
       改成「行首 / `{` / `,` 之后的 key:」才认全（反向验证见提交说明）。 */
    (code[r].match(/(^|[\s{,])[ \t]*([A-Za-z_$][\w$]*)\s*:/g) || []).forEach(s => {
      const k = s.replace(/^[\s{,]+/, '').replace(/\s*:$/, '').trim();
      if (k && keys.indexOf(k) < 0) keys.push(k);
    });
    keys.forEach(k => {
      if (allow.indexOf(k) >= 0) return;
      checked++;
      const re = new RegExp('(^|[^A-Za-z0-9_$])' + k.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_$])');
      if (!rel.some(g => g !== r && re.test(code[g]))) dead.push(r + ' 的 ' + k);
    });
  });
  if (dead.length) {
    err(`数据文件里这些字段全项目零消费：${dead.join('、')}`
      + '（删掉，或加进 DATA_WHITELIST 并写明理由）');
  } else {
    /* ⚠️ 这句话里**不许出现任何被扫描的键名** —— 第一版写了「只留 rocks」，
       `rocks` 就成了 verify.js 里的一个「消费方」，把白名单摘掉也不报红（自指喂饱，㉓/33-f 同款坑）。 */
    ok(`${dataFiles.length} 个数据文件共 ${checked} 个字段都有真实消费方`
      + '（白名单只留 1 类：按 key 动态取值表的行名，理由见代码注释）');
  }
})();


/* ---------------- 32-h. 存档键必须有消费方（设置子键还必须有界面控件） ----------------
   由来（2026-10-08，Q26）：`state.js` 的 `blank()` 是**整份存档结构**的唯一真相，
   它有两类静默失效，之前都没有网：
     ① 顶层键**零消费** —— 上线时逮到第一条真鱼：`createdAt` 从 v0.1.0 起
        每份存档都写它、全项目没有一处读它（已删）。这种键会一直攒下去，没人会发现。
     ② `settings` 的子键**界面看不见** —— 新增一个键却忘了在设置面板补一行，
        表现是「存档里有这个字段、界面上永远看不见」。
   「零消费」这条线此前有三张网：模块**导出面**（㉜）、模块**内部状态对象**（32-d）、
   **数据文件字段**（32-g）—— 存档结构是唯一漏掉的那类：它既不是模块导出，
   又在 `blank()` 的返回值里（`S` 逃出模块 ⇒ 32-d 按判据明确不收）。
   判据（静态扫，只扫代码不扫注释）：
     ① `blank()` 的**顶层**键清单现算（抓不到就报错，不许当成「没有键要检查」而空过）；
     ② 把 `blank()` 那一段**挖空**（否则键的定义行自己就算一次「消费」）后，
        每个顶层键都要在 src/ + tools/*.js + index.html 里至少出现一次 —— 零出现 = 死存档字段；
     ③ `settings` 的每个子键还要出现在 `src/ui/panels.js` 的 `VIEWS.settings` 段内
        （形如 `settings.<键>`）= 设置面板里真有那个控件；段边界现算，抓不到就报错。
   为什么 ③ 收窄到「设置面板那一段」而不是整个 panels.js：
     设置面板是**唯一**能让玩家改这些键的地方。main.js 启动时那三处只是**套用**存档值、
     不是控件；hud.js 的两处是**显示**、tutorial.js 的两处是**闸门**。把这些也算
     「有消费方」的话，新增键只要在别处被读一次就能通过，而设置面板里仍然没有开关 —— 网眼就瞎了。
   为什么处处「抓不到就报错」：空集会让人断言**恒真**（假通过），比不写还危险 ——
     存档结构被搬走 / 设置面板被改名时，本节必须红着脸说「我失效了」，而不是安静地放行。
   已知网眼（有意不写断言，附「为什么不需要」）：
     · 短键名（`v` / `net` / `tank` …）撞名多，只会**假阴性**（漏报）不会误报 ——
       当网用，不当证明（32-g 同款边界；实测 34 个顶层键里 0 处误报）。
     · `settings` 段内若出现 `var se = St.get().settings` 这类**别名**，③ 会**报红**
       （fail-safe 而非漏网），不需要再加守卫（main.js 真有一个别名，但它不在扫描范围内）。
     · 动态键（方括号取值）全项目没有这种写法，真出现时 ③ 也会报红。
   ⚠️ 本节**行尾注释也要剥**：否则一句「记得补 xxx」的说明就能把自己喂饱（32-g 栽过同款）。 */
console.log('\n[32-h] 存档键必须有消费方（设置子键还必须有界面控件）');
(function () {
  const stripCode = t => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
  const REL_STATE = 'src/core/state.js', REL_PANEL = 'src/ui/panels.js';
  const readCode = r => stripCode(fs.readFileSync(path.join(ROOT, r), 'utf8'));

  /* 扫描集：src/ 全部 + tools/ 的 js + index.html（与 32-g 同一张网面） */
  const rel = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.(js|html)$/.test(n)) rel.push(dir + '/' + n);
    });
  })('src');
  fs.readdirSync(path.join(ROOT, 'tools')).forEach(n => { if (/\.js$/.test(n)) rel.push('tools/' + n); });
  rel.push('index.html');
  const code = {};
  rel.forEach(r => { code[r] = readCode(r); });

  /* ① blank() 的顶层键：现算，不写死任何一个键名
     ⚠️ 锚点走共用的 `at()`（词间允许空白、返回**原文偏移**，要拿去 slice）；
        局部名不能取 `at` —— 会把顶部那个助手遮住（第 ㊳ 节因此当场报红过一次）。 */
  const stSrc = code[REL_STATE];
  const fnAt = at(stSrc, 'function blank()');
  let blankSrc = '';
  if (fnAt >= 0) {
    const rest0 = stSrc.slice(fnAt);
    const end = rest0.search(/\n {4}\};/);
    blankSrc = end >= 0 ? rest0.slice(0, end) : rest0;
  }
  /* 顶层缩进**从 `v:` 那一行现取**，不在断言里写死 4 / 6 / 8 个空格
     （否则文件一重排，本节要么误报要么空过）。 */
  const vLine = blankSrc.match(/^([ \t]*)v\s*:\s*SAVE_V,/m);
  const keys = (blankSrc && vLine)
    ? (blankSrc.match(new RegExp('^' + vLine[1] + '([A-Za-z_$][\\w$]*)\\s*:', 'gm')) || [])
      .map(s => s.trim().replace(/\s*:$/, ''))
    : [];
  if (!keys.length) {
    err(REL_STATE + ' 里抓不到 blank() 的顶层键清单（实得 0 个）—— '
      + '存档结构被改名 / 搬家 / 换写法了，本节必须跟着改，不许当成「没有键要检查」而空过');
  }

  /* ② 顶层键的消费方：**先把 blank() 那一段挖空**，否则键的定义行自己就算一次出现 */
  if (keys.length && fnAt >= 0) {
    code[REL_STATE] = stSrc.slice(0, fnAt) + stSrc.slice(fnAt + blankSrc.length);
    const bare = k => new RegExp('(^|[^A-Za-z0-9_$])' + k.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_$])');
    const deadKey = keys.filter(k => !rel.some(r => bare(k).test(code[r])));
    if (deadKey.length) {
      err('这些存档顶层键全项目零消费（挖掉 blank() 定义后再无出现）：' + deadKey.join('、')
        + ' —— 删掉它（老档残留可在 migrate() 里 delete 掉），或写明它服务于哪一处读取');
    } else {
      ok('blank() 的 ' + keys.length + ' 个顶层键在 src/ 与 tools/ 里都有真实消费方'
        + '（清单现算；blank() 定义行已挖空，不会自己算一次消费）');
    }
  }

  /* ③ settings 子键：设置面板里必须有控件
     ⚠️ 锚点同样走 `at()`；段边界 = 到下一个顶层 `VIEWS.<名> =` 之前。 */
  const pSrc = code[REL_PANEL];
  const setAt = at(pSrc, 'VIEWS.settings = {');
  let block = '';
  if (setAt >= 0) {
    const rest = pSrc.slice(setAt + 1);
    const nx = rest.search(/\n[ \t]*VIEWS\.[A-Za-z_$][\w$]*[ \t]*=/);
    block = nx >= 0 ? rest.slice(0, nx) : rest;
  }
  if (block.length < 200) {
    err(REL_PANEL + ' 里抓不到 VIEWS.settings 那一段（实得 ' + block.length + ' 字符）—— '
      + '设置面板被改名 / 拆分 / 挪到别的文件了，本节必须跟着改，不许当成「都通过」');
  }
  /* settings 的子键：从①那份 blankSrc 里单独再取一层（现算） */
  const setLine = blankSrc.match(/^([ \t]*)settings\s*:\s*\{([\s\S]*?)\},/m);
  const subKeys = setLine
    ? (setLine[2].match(/(^|[\s{,])[ \t]*([A-Za-z_$][\w$]*)\s*:/g) || [])
      .map(s => s.replace(/^[\s{,]+/, '').replace(/\s*:$/, '').trim())
    : [];
  if (!subKeys.length) {
    err(REL_STATE + ' 的 blank() 里抓不到 settings 的子键（实得 0 个）—— '
      + '它被改名 / 改形状了，本节必须跟着改，不许当成「没有键要检查」而空过');
  } else if (block.length >= 200) {
    /* 判据自检：认得出正形态，且**拒收**「名字只多带一截」的伪形态 ——
       少了这半段，「拿前缀撞上就算过」这种网眼没人会发现（32-d 的放行条件栽过同款）。 */
    const hit = k => new RegExp('settings\\.' + k.replace(/\$/g, '\\$') + '(?![A-Za-z0-9_$])');
    if (!hit('zzz').test('a.settings.zzz = 1')
        || hit('zzz').test('a.settings.zzzMore = 1')
        || hit('zzz').test('a.settings.zzz2 = 1')) {
      err('32-h 的取值正则自检失败：它认不出 settings.<键>，或把 settings.<键>X 也算成了同一个键');
    } else {
      const missing = subKeys.filter(k => !hit(k).test(block));
      if (missing.length) {
        err('这些设置键在设置面板里没有任何控件（' + REL_PANEL + ' 的 VIEWS.settings 段内看不到对应的 '
          + 'settings.<键>）：' + missing.join('、') + ' —— 补一行 row(...)，或把该键从 blank().settings 里删掉');
      } else {
        /* ⚠️ 这句话里不许写死任何键名（自指喂饱的老坑）；键名一律现算后拼进来。 */
        ok('blank().settings 的 ' + subKeys.length + ' 个键在设置面板里都有控件消费方'
          + '（键清单与面板段落都是现算的，不写死）');
      }
    }
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
  const body = src.slice(at(src, 'def build_morph_prompt'));
  const fn = body.slice(0, body.indexOf('\ndef ', 10));
  const miss = ['build_prompt(', 'palette_color(', '.replace('].filter(k => fn.indexOf(k) < 0);
  if (miss.length) {
    err(`build_morph_prompt() 没有「调 build_prompt → 只换颜色半句」的写法（缺 ${miss.join('、')}）`
      + ` —— 五档会另起一套骨架，与母版口径分家`); return;
  }
  /* 🔴 反向判据：**不许整句替换 `palette_desc`**。
     2026-10-08 用户报障「部分鱼的闪光，鱼头部分和身体部分不一样」，根因就在这一句：
     整句替换会把颜色句的后半句 `PALETTE_SHADE`（`a clearly lighter belly and a darker back`）
     一起换掉 —— 实测五档提示词 **0/508** 条含它，而母版 122/127 条有。
     它为什么致命：`paint-card.py` 的着色是**灰度渐变映射**（`gray = im.convert("L")`，
     **颜色 = 灰度的函数**），背腹明暗正是它的前提。前提被换掉 ⇒ 模型对**头部**与**躯干**的
     明暗处理不再受约束 ⇒ **明暗差直接变成颜色差**（实测 D07 头/身中位亮度差被放大到 68，
     母版只有 25）。所以：只换 `palette_color()` 那半句，`PALETTE_SHADE` 必须留下。 */
  if (fn.indexOf('palette_desc(') >= 0) {
    err('build_morph_prompt() 又在**整句**替换 `palette_desc` —— 会把「背腹明暗」这句着色前提'
      + '一起换掉，头身明暗的不一致会被灰度渐变映射放大成「头身颜色不一样」（2026-10-08 报障原因）');
    return;
  }
  ok('build_morph_prompt() 复用母版骨架 + 只换颜色半句 + 保住背腹明暗（不许整句替换）');
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
    ['save_manifest', '定期落盘（长跑被杀不能连出图台账一起丢）'],
    ['lock_alive', 'pid 死活判据（否则死进程留的陈旧锁会白挡下一轮一小时）'],
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

  /* ④ **闪光档的显式例外**（用户口径 2026-10-08）：
     「闪光档不用是以前很多面的格式，防止有些部分看起来像小像素块」。
     上面的 ② 要求 GEOM 必须写「密集」；而闪光档**故意反着来**（`GEOM_COARSE`）。
     这不是自相矛盾，是**有理由的定向例外**：闪光档的颜色句本来就要求「布满细碎亮斑」，
     再叠一层密集三角网 ⇒ 尾部与鳍在 1:1 下就是一片小碎面（用户原话「小像素块」）。
     实测（D16 闪光档 @35 步，同提示词只差这一句，`tools/facet-count.py`）：
       密集网格 2.39 ／ 只删「密集网格」两句 2.13 ／ 大而分开的块面 **2.04**。
     ⚠️ 所以这一档是**明知掉密度也要换**的取舍，别再"顺手改回去"。
     这一条是**机制检查**，不是散文约定：例外只许挂 `shiny` 一档，多挂一档就报红。 */
  /* ⚠️ 只查字面量是不够的：把「密集」在**运行期**加回去（`GEOM_COARSE += "…"`）静态文本看不出来
     —— 第一版判据就被这种注入骗过了（反向验证当场发现）。
     所以再加一条**只许出现在两处**：定义 + `GEOM_BY_MORPH` 里那一次引用（同项目「死代码判据」的老办法）。 */
  const coarseHits = (src.match(/GEOM_COARSE/g) || []).length;
  if (coarseHits !== 2) {
    err(`GEOM_COARSE 在代码里出现了 ${coarseHits} 次（只许 2 次：定义 + GEOM_BY_MORPH 引用）`
      + ` —— 多出来的那处可能在运行期把「密集」措辞加回闪光档`);
    return;
  }
  const coarse = toStr(src.match(/^GEOM_COARSE\s*=\s*\(([\s\S]*?)\)\s*$/m));
  const byMorph = (src.match(/^GEOM_BY_MORPH\s*=\s*(\{[^}]*\})/m) || [])[1] || '';
  if (!coarse) {
    err('闪光档的 `GEOM_COARSE` 不见了 —— 用户口径「闪光档不用很多面的格式」被改掉了');
    return;
  }
  if (/dense triangular polygon mesh|many small|tessellation/.test(coarse)) {
    err('`GEOM_COARSE` 里又出现了「密集 / 碎小」的措辞 —— 那正是闪光档要避免的东西（尾鳍会碎成小像素块）');
    return;
  }
  const keys = (byMorph.match(/"([a-z]+)"\s*:/g) || []).map(x => x.replace(/["\s:]/g, ''));
  if (keys.length !== 1 || keys[0] !== 'shiny') {
    err('GEOM_BY_MORPH 的例外只许挂 shiny 一档，现在挂的是 ' + JSON.stringify(keys)
      + ' —— 其它档（尤其母版与其他三档）必须继续用 GEOM（那是 v9 标定过、最贴靶子 3.6 的措辞）');
    return;
  }
  ok('闪光档的面片例外（GEOM_COARSE）在位、不含「密集」措辞、且只挂在 shiny 一档');

  /* ⑤ **步数按稀有度 + 档位**（用户口径 2026-10-08：「传说级别的鱼使用 35 步，史诗使用 30」）。
     口径只有 `steps_for(f, morph)` 一处：**取 max**（史诗的黄金档 = max(30,35) = 35）。
     ⚠️ 盯两件事：① 两个表都在、`steps_for` 真的取 max（写成覆盖就会让"史诗的黄金档只有 30 步"）
     ② 「按档句」这类例外只许挂 shiny 一档，且名字只出现两次（定义 + 使用）——
       多一处就可能有人**在运行期**把它加到别的档上（`GEOM_COARSE` 那次就被这种注入骗过）。 */
  const rarTbl = src.match(/^STEPS_BY_RAR\s*=\s*\{[^}]*\}/m);
  const morTbl = src.match(/^STEPS_BY_MORPH\s*=\s*\{[^}]*\}/m);
  if (!rarTbl || !morTbl) {
    err('`STEPS_BY_RAR` / `STEPS_BY_MORPH` 不见了 —— 步数按稀有度/档位的口径被改掉了');
    return;
  }
  const sf = src.slice(at(src, 'def steps_for('));
  const sfBody = sf.slice(0, sf.indexOf('\ndef ', 10) > 0 ? sf.indexOf('\ndef ', 10) : 400);
  if (!/max\(/.test(sfBody) || !/STEPS_BY_RAR/.test(sfBody) || !/STEPS_BY_MORPH/.test(sfBody)) {
    err('`steps_for()` 没有「按稀有度与档位取 max」—— 写成覆盖会让「史诗的黄金档」只有 30 步'
      + '（而黄金档要求 35），两边口径打架');
    return;
  }
  for (const [name, want] of [['PALETTE_SHADE_BY_MORPH', 'shiny'], ['EXTRA_BY_MORPH', 'shiny']]) {
    const hits = (src.match(new RegExp(name, 'g')) || []).length;
    if (hits !== 2) {
      err(name + ' 在代码里出现 ' + hits + ' 次（只许 2 次：定义 + 在 xxx_for() 里引用）——'
        + ' 多出来的那处可能在运行期把闪光档的句子加到别的档上');
      return;
    }
    const tbl = (src.match(new RegExp('^' + name + '\\s*=\\s*\\{[^}]*\\}', 'm')) || [''])[0];
    const keys = (tbl.match(/"([a-z]+)"\s*:/g) || []).map(x => x.replace(/["\s:]/g, ''));
    if (keys.length !== 1 || keys[0] !== want) {
      err(name + ' 只许挂 ' + want + ' 一档，现在挂的是 ' + JSON.stringify(keys));
      return;
    }
  }
  if (!/^PALETTE_SHADE\s*=\s*"/m.test(src)) {
    err('`PALETTE_SHADE`（默认的背腹明暗句）不见了 —— 母版与其它三档要靠它');
    return;
  }
  ok('步数 = max(稀有度 35/30, 档位 35) 只写在 `steps_for()`；按档例外只挂 shiny 且各只出现两处');
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
     ⑤ **按稀有度覆盖池子**（`MORPH_POOL_BY_RAR`，传说档定死）**必须走 `pool_for()`** ——
        绕过它 = 传说鱼照旧轮换出参差，图上看不出来、也不报错；
        **一档多版**（`MORPH_VERSIONS_BY_RAR`）的第 1 版必须落在主文件名上。
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
  const poolStart = at(src, 'MORPH_POOL = {');
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
  const pk = src.slice(at(src, 'def morph_pick'));
  const pickFn = pk.slice(0, pk.indexOf('\ndef ', 10));
  if (!/hashlib\.md5/.test(pickFn)) {
    err('morph_pick() 没有用 hashlib.md5 —— 抽样不可复现，跨进程会变'); return;
  }
  if (/\bhash\(/.test(pickFn)) {
    err('morph_pick() 用了内置 hash() —— 它带 PYTHONHASHSEED 随机盐，'
      + '每次进程启动结果都不一样，manifest 与磁盘上的图会对不上'); return;
  }
  /* ④ 基准句逐档在册 ——
     比对照走顶部共用的 flat()/has()（第 ㊳ 节盯着这条）：
     否则只要某句被折成两行，这条检查就会误报「被删了」，
     而它想抓的其实是「句子本身被改了」。折行与内容无关，不该影响判定。 */
  const BASE = {
    bright: 'from magenta and orange through yellow and cyan to blue and violet',
    albino: 'pale creamy white body, soft pink translucent fins, pale pink eye',
    golden: 'rich brass and gold tones, brilliant golden sheen, high luminance',
    shiny: 'star-shaped sparkle highlights, prismatic sheen',
  };
  const miss = Object.keys(BASE).filter(k => !has(src, BASE[k]));
  if (miss.length) {
    err(`基准颜色句被删了或改动了：${miss.join('、')} —— 池子第 0 项引用的就是它们，不许动`);
    return;
  }
  /* ⑤ 按稀有度覆盖池子 / 一档多版（2026-10-08 用户口径：传说档定死 + 传说闪光出 2 版）
     🔴 盯「覆盖会被绕过」这一型：只要有人绕过 `pool_for()` 直接读 `MORPH_POOL`，
        传说鱼就照旧轮换出参差 —— 图上看不出来是哪一步漏了，也不报任何错。 */
  if (!/MORPH_POOL_BY_RAR\s*=\s*\{/.test(src) || !/MORPH_VERSIONS_BY_RAR\s*=\s*\{/.test(src)) {
    err('缺少 MORPH_POOL_BY_RAR / MORPH_VERSIONS_BY_RAR —— 传说档定死与「一档出 2 版」没了'); return;
  }
  const peFn = src.slice(at(src, 'def pool_entries('), at(src, 'def _check_one_pool('));
  if (!/pool_for\(/.test(peFn)) {
    err('pool_entries() 没有走 pool_for() —— 按稀有度的覆盖会被**静默绕过**（传说鱼照旧轮换）');
    return;
  }
  /* 多版的后缀：第 1 版必须落在**主文件名**上（否则清单勾选 / check-cards / --skip-existing 全失配） */
  const mvFn = src.slice(at(src, 'def morph_versions('), at(src, 'MORPHS = ['));
  if (!/""\s*if\s+i\s*==\s*0/.test(mvFn)) {
    err('morph_versions() 没把第 1 版的后缀留成空串 —— 主文件名会漂，清单/验收/断点续跑的既有口径全部失配');
    return;
  }
  ok('候选总表 + 权重池 + 按稀有度覆盖 + 一档多版齐备；MORPHS 派生、池内只存键与权重；'
    + '覆盖必须走 pool_for()；第 1 版落在主文件名；check_pools() 加载即校验；morph_pick 走 md5；'
    + '四档基准句在册');
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

/* ---------------- 34-b. 文档里不许再把 test.js 的「总项数」写死 ----------------
   本节上面那句「测试的项数不再写进文档，只说『以输出为准』」写于 2026-10-07，
   但**没有任何东西盯着它** ⇒ 它又漂回来了：2026-10-08 实测仍有 3 处写着旧项数
   （开发者文档 §18 验证口径 / 规范 §6 验证口径 / AI素材方案 §8.4 的门禁结论），
   而实际数早就不是那个。**「规则写在注释里、没有机制」= 这条规则不成立**，补一张网。

   判据（窄到不误伤）：**同一行**里既有 `test.js`、又有「<2~4 位数字> 项 + 全…」。
   ⚠️ 边界连同反例一起写死：
     · 「`test.js` 有 30 项断言覆盖某功能」**不算** —— 那是范围说明，不是门禁总数；
     · GDD 变更记录里「当时的 `test.js` 398 项」**不算** —— 没有「全」字，是历史留档。
   ⚠️ **故意不做的**：不去校验文档里的数字「对不对」—— verify 算不出 test.js 的项数
     （它不能跑外部命令：本机 `spawnSync(node, …)` 返回 EBUSY）。所以改判「不许写死」，
     让**唯一的现行基线**留在 `docs/优化队列.md` §1「门禁基线」（每轮收工都要更新）。
   ⚠️ 扫描面**不含** `docs/优化队列.md` 与 `docs/改进待办.md`：它们按规矩是「只追加」的
     台账 / 日志，历史行里的旧数字必须留得住。 */
console.log('\n[34-b] 文档里不许写死 test.js 的总项数（改说「以实跑输出为准」）');
let gateNumBad = 0;
(function () {
  const docs = ['README.md', 'docs/开发者文档.md', 'docs/GDD.md', 'docs/说明书.html',
                'docs/AI素材方案.md', 'docs/画风与颜色标准.md', 'docs/每小时优化轮次规范.md'];
  let scanned = 0;
  docs.forEach(rel => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    scanned++;
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (line.indexOf('test.js') < 0) return;
      const m = line.match(/(\d{2,4})\s*项\s*全/);
      if (!m) return;
      err(`${rel}:${i + 1} 写死了 test.js 的总项数（「${m[1]} 项全…」）—— ` +
          `改成「以实跑输出为准」，现行基线只留 docs/优化队列.md §1`);
      gateNumBad++;
    });
  });
  if (!scanned) { err('34-b 要扫的文档一个都不存在（改了文件名就来更新这条断言）'); gateNumBad++; }
})();
if (!gateNumBad) ok('7 份现行口径文档都没写死 test.js 的总项数（现行基线只留在 docs/优化队列.md §1）');


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
    /* ⚠️ 下面三条是「绕过 window.addEventListener 规则」的缺口：
       生命周期事件经 U.on(window/document, ...) 注册时，上面那条按名扫描拦不住
       （U.on 内部才调 addEventListener）→ main.js / hud.js 的 visibilitychange、
       blur、focus 一直裸挂在 DOM 上。现在必须走 G.Platform.sys.on*。 */
    ['U.on(window, 生命周期事件)', /U\s*\.\s*on\s*\(\s*window\s*,\s*(['"])(?:resize|visibilitychange|blur|focus|orientationchange)\1/],
    ['U.on(document, 生命周期事件)', /U\s*\.\s*on\s*\(\s*document\s*,\s*(['"])(?:resize|visibilitychange|blur|focus|orientationchange)\1/],
    ['document.hidden', /(^|[^\w$.])document\s*\.\s*hidden/],
    /* 启动时机也收进平台层（sys.onReady）：业务代码不再自己判 readyState */
    ['document.readyState', /document\s*\.\s*readyState/],
    ['DOMContentLoaded 字面量', /(['"])DOMContentLoaded\1/],
    /* ⚠️ 时间源也属「系统信息」（sys.now / sys.dpr 是同一族）。
       踩过的：main.js 三处 + panels.js 一处直接写 `performance.now()`，
       而平台层的 `sys.now()` 因此**全项目零调用**——「按名枚举」的规则
       从没覆盖过它，直到 2026-10-08 才被一次全项目 API 扫描翻出来。
       主循环的 dt、鱼缸动画的相位都靠这个时钟，换平台时两边必须一起换。 */
    ['performance.now（直接取时）', /(^|[^\w$.])performance\s*\.\s*now\s*\(/],
    /* 图片加载也是平台能力：Web 端是 `new Image()`，小程序端是 `wx.createImage()`。
       业务代码不许自己建 —— 统一走 `G.Platform.image`（消费方：`G.Assets`）。 */
    ['new Image（直接建图片）', /(^|[^\w$.])new\s+Image\s*\(/],
    /* 帧调度也是平台能力：Web 与微信小游戏有全局 `requestAnimationFrame`，
       **小程序（非小游戏）页面里没有**，要换成 `canvas.requestAnimationFrame`。
       ⚠️ 边界（2026-10-08 明确，见 `docs/每小时优化轮次规范.md` §9）：
          `requestAnimationFrame` / `cancelAnimationFrame` **算**平台能力；
          `setTimeout` / `setInterval` **不算**（任何宿主都有，连 Node 都有），
          所以在业务代码里直接写定时器是**合法**的 —— 这条边界由用户提问触发、
          由「质量优先」拍定为「收口帧调度、不收口通用计时器」，别再反复摇摆。 */
    ['requestAnimationFrame（直接调度帧）', /(^|[^\w$.])requestAnimationFrame\s*\(/],
    ['cancelAnimationFrame（直接调度帧）', /(^|[^\w$.])cancelAnimationFrame\s*\(/],
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

  /* ── 机械规则：管住「挂监听」这个动作的**字面量出现位置** ──────────────
     上面那套按名枚举天生有**封装绕过口**（2026-10-08 才发现）：真正调
     addEventListener 的是 `U.on`，于是按名扫 `window.addEventListener` 一条也
     拦不住，main.js / hud.js 四处生命周期事件裸挂 DOM 很久没人发现。
     与其继续枚举「绕过它的写法」（U.once / U.bind / U.delegate…枚举不完），
     不如反过来：**字面量只许出现在平台层本体**。约定成一张白名单，
     任何新增文件、任何新增包装器都会让这张表对不上 → 立刻报红。
        · src/core/platform.js —— 平台层本体，字面量都该在这儿（不设上限）
        · src/core/util.js     —— `U.on` 是唯一的通用 DOM 事件包装器，**恰好 1 处**
          （元素级点击这类事件换平台时随 UI 层一起重写，见文档 §13，故予豁免）
     ⚠️ 已知残余缺口：写成 `node['addEventListener'](...)` 能绕过（那是刻意规避，
        不是顺手写错）。白名单条目写少于实际也会报红 —— 免得豁免悄悄过期、
        下次有人照着它继续加。 */
  const ADD_EV_ALLOW = { 'src/core/util.js': 1 };
  rel.forEach(r => {
    if (r === 'src/core/platform.js') return;
    const n = (strip(fs.readFileSync(path.join(ROOT, r), 'utf8')).match(/addEventListener\s*\(/g) || []).length;
    const allow = ADD_EV_ALLOW[r] || 0;
    if (n > allow) {
      err(`${r} 里出现了 ${n} 处 addEventListener 字面量（白名单只允许 ${allow} 处）—— `
        + `新加的监听要么走 G.Platform，要么先想清楚为什么必须在这儿`); platBad++;
    } else if (n < allow) {
      err(`${r} 的白名单写着 ${allow} 处 addEventListener，实际只有 ${n} 处 —— `
        + `豁免条目过期了，请从第 ㊱ 节的 ADD_EV_ALLOW 里删掉它`); platBad++;
    }
  });
  if (!platBad) ok(`src 下除 platform.js 外的 ${checked.length} 个模块都没有直连浏览器专有 API；`
    + 'addEventListener 字面量只出现在 platform.js 与 util.js（U.on，恰 1 处）');
})();

/* ---------------- 36-b. `document.*` 的字面量同样只管位置 ----------------
   上面那套「按名枚举」漏掉了最常见的一族：直接用 `document.createElement` /
   `document.getElementById` / `document.body` 建 DOM。它既不碰 localStorage 也不碰
   visibilityState，所以一条 FORBID 都命中不了 —— 但同一份代码的别处一律走 `U.$` / `U.el`。
   踩过的：`src/ui/devtools.js` 六处裸调 `document.*`（同一文件里的面板逻辑却全走 U.el），
   靠人读代码才发现；2026-10-08 的一次全项目统计才把它翻出来。
   与 `addEventListener` 同型处理：**字面量只许出现在平台层与 `util.js`（DOM 助手本体）**。
   白名单条目写多写少都报红 —— 免得豁免过期，或有人照着它继续加。
   ⚠️ 已知网眼（与 36-a 同）：绕开 `.` 的写法（`document['body']`）扫不到；那是刻意规避。 */
console.log('\n[36-b] `document.*` 字面量只许出现在 platform.js 与 util.js');
let docLitBad = 0;
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rel = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) walk(dir + '/' + n);
      else if (/\.js$/.test(n)) rel.push(dir + '/' + n);
    });
  })('src');
  const DOC_ALLOW = { 'src/core/util.js': 1 };   // U.el 的 createElement（U.$ / U.$$ 走 (root||document) 不计数）
  let live = 0;
  rel.forEach(r => {
    if (r === 'src/core/platform.js') return;
    const n = (strip(fs.readFileSync(path.join(ROOT, r), 'utf8')).match(/\bdocument\s*\./g) || []).length;
    const allow = DOC_ALLOW[r] || 0;
    if (n > allow) {
      err(`${r} 里出现了 ${n} 处裸 document.* 字面量（白名单只允许 ${allow} 处）—— `
        + `建 / 查 DOM 请走 U.$ / U.el，除非先想清楚为什么必须在这儿`);
      docLitBad++;
    } else if (n < allow) {
      err(`${r} 的白名单写着 ${allow} 处 document.* 字面量，实际只有 ${n} 处 —— `
        + `豁免条目过期了，请从第 36-b 节的 DOC_ALLOW 里删掉它`);
      docLitBad++;
    }
    live += n;
  });
  if (!docLitBad) ok(`裸 document.* 字面量只剩 util.js 的 ${live} 处（平台层之外无其他直连）`);
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


/* ---------------- 38. 源码子串比对必须折行不敏感 ----------------
   第 33-f 节踩过的坑的**通用化**：本文件大量断言靠「源码里还有没有这句话」
   来判红。一旦被比对的那句话在源码里**被折成两行**（或 Python 的「引号 换行
   引号」隐式拼接），裸 `indexOf` 就再也找不到它 → 报「这句话被删了」。
   内容是好的，红的却是排版 —— 这类误报攒多了，门禁就成了没人看的噪音。
   所以定一条机械规则，而不是靠自觉：
     **散文式 needle（含空格 / 连续 ≥4 个汉字）不许出现在 `indexOf(` / `includes(`
       的字面量里** —— 它必须走顶部共用的 `has()` / `idx()`（布尔判断）
       或 `at()`（要拿原始偏移去 slice）。
   豁免（判据见 isProseNeedle）：含反斜杠转义的是**结构锚点**（`'\n  }'`），
   纯标识符 / 路径 / 表达式（无空格、汉字 <4）折不了行，裸比无妨。
   ⚠️ 自指风险：本节只扫**剥掉注释后**的代码 —— 否则上面这段说明里的示例
      会把自己喂饱（这个坑在 ㉓ / 33-f 已经栽过两次）。 */
console.log('\n[38] 源码子串比对必须走 has()/idx()/at()（折行不许误报）');
(function () {
  const self = fs.readFileSync(path.join(ROOT, 'tools/verify.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /\.(?:indexOf|includes)\(\s*(['"])((?:[^'"\\]|\\.)*?)\1/g;
  const bad = [];
  let m;
  while ((m = re.exec(self))) {
    if (isProseNeedle(m[2])) bad.push(m[2]);
  }
  if (bad.length) {
    bad.forEach(n => err(`源码子串比对用了裸 indexOf/includes：\`${n}\` —— `
      + `它会被折行误伤，改走 has() / idx()（布尔）或 at()（要 slice）`));
  } else {
    ok('本文件的源码子串比对全部折行不敏感（散文式 needle 无一裸比）');
  }

  /* 行为自检：光有规则不够 —— 还得证明 has() 真的接得住折行，
     而**旧的裸 indexOf 在同样输入下确实找不到**（否则规则只是装饰）。
     ⚠️ 这里必须用变量传 needle（`NEEDLE`），不能写字面量 ——
        否则本节自己的两条「反例」会被上一段扫描当成违规，自己把自己报红
        （自指型断言的老坑，㉓ / 33-f 都栽过）。 */
  const NEEDLE = 'alpha beta gamma delta';
  const LINE_BREAK = 'const A = 1;  // alpha beta\ngamma delta';
  const PY_CONCAT = 'const B = "alpha beta "\n    "gamma delta";';
  if (!has(LINE_BREAK, NEEDLE) || !has(PY_CONCAT, NEEDLE)) {
    err('has() 没能接回折行 / 隐式拼接 —— 第 ㊳ 节的规则形同虚设'); return;
  }
  if (LINE_BREAK.indexOf(NEEDLE) >= 0 || PY_CONCAT.indexOf(NEEDLE) >= 0) {
    err('用例本身就没有折行，这条行为自检证明不了任何事（改了用例请同步改判据）'); return;
  }
  ok('has() 实测能接回「折行」与「引号 换行 引号」隐式拼接（裸 indexOf 在同样输入下找不到）');
})();


/* ---------------- 39. 拼装 HTML 的工具：产物脚本必须真 check 过 ----------------
   🔴 回归（2026-10-08，用户报「咋现在卡片评审台打不开了？」）：
   `tools/review-cards.py` 的 `TEMPLATE` 是 Python 三引号**非 raw** 字符串。
   我在页内 JS 里写了 `x.join('\n')` —— Python 把 `\n` **提前**解释成真换行，
   于是字符串字面量被截断成跨行，**整段 `<script>` 语法失效**，浏览器打开
   就是**一片空白**，而 `python tools/review-cards.py` 一句错都不报、退出码 0。
   「工具跑成功」与「产物能用」是两件事 —— 这一节就是钉住这条缝。
   判据两条，缺一不可：
     (a) TEMPLATE 块里不许出现**单反斜杠**的控制类转义（页内想写字面量 `\n`
         必须写成 `\\n`，由 Python 还原成 `\n` 交给 JS）；
     (b) `docs/卡片评审.html` 存在时，其页内每一段 `<script>` 都必须过 `node --check`。
   ⚠️ 静态文本判据最容易写成「装饰」：所以下面每条都配了**行为自检** ——
      合成的坏样本必须被抓、好样本必须放过，产物文件是**真读真 check**。
   ⚠️ 为什么还要 (b)：(a) 只盯得住这一个文件、这一种转义；将来若换别的拼装方式
      （模板字符串 / 正则替换 / 数据里带 `</script>`），只有「把产物真喂给解析器」
      才拦得住。两道一起才叫门禁。 */
console.log('\n[39] 拼装 HTML 的工具：产物脚本必须真解析过（不许静默写出空白页）');
(() => {
  const PYFILE = path.join(ROOT, 'tools', 'review-cards.py');
  if (!fs.existsSync(PYFILE)) { err('找不到 tools/review-cards.py（第 39 节的判据没地方落）'); return; }
  const py = fs.readFileSync(PYFILE, 'utf8');

  /* 单反斜杠 + 会被 Python 解释成控制字符的字母。
     双反斜杠（`\\n`）不能命中 —— 用「后面不是反斜杠」的前瞻挡掉。 */
  const BAD_ESC = /(?<!\\)\\[ntrbfva0xuN]/;
  const TPL_RE = /TEMPLATE\s*=\s*u?"""([\s\S]*?)"""/;

  /* ---- 行为自检：先证明判据本身分得清好坏（用字符码拼反斜杠，避免自指混淆）---- */
  const BS = String.fromCharCode(92);
  const Q = String.fromCharCode(39);                     // 单引号
  const synBad  = 'TEMPLATE = u"""\nvar s = x.join(' + Q + BS + 'n' + Q + ');\n"""';
  const synGood = 'TEMPLATE = u"""\nvar s = x.join(' + Q + BS + BS + 'n' + Q + ');\n"""';
  const pick = src => (TPL_RE.exec(src) || [])[1] || '';
  const flagged = src => !!BAD_ESC.exec(pick(src));
  if (!flagged(synBad) || flagged(synGood)) {
    err('第 39 节判据不成立：它分不清「单反斜杠（坏）」与「双反斜杠（好）」——'
        + `坏样本命中=${flagged(synBad)}、好样本命中=${flagged(synGood)}`);
    return;
  }
  ok('判据自检：合成坏样本必被抓、好样本必放过（单反斜杠 vs 双反斜杠）');

  /* ---- (a) 真文件扫描 ---- */
  if (!TPL_RE.test(py)) {
    err('tools/review-cards.py 里认不出 TEMPLATE 三引号块 —— 拼装方式改过？判据要跟着改');
    return;
  }
  const tpl = pick(py);
  const tplBase = py.slice(0, py.indexOf(tpl)).split('\n').length;   // 模板起始行
  const badLines = tpl.split('\n')
    .map((l, i) => [tplBase + i, l.trim()])
    .filter(([, l]) => BAD_ESC.test(l));
  if (badLines.length) {
    err(`TEMPLATE 块里有 ${badLines.length} 处**单反斜杠**转义 —— Python 会提前解释掉，`
        + `产物脚本会断行（首处 L${badLines[0][0]}：${badLines[0][1].slice(0, 70)}）；`
        + '页内 JS 要字面量 \\n 必须写 \\\\n');
  } else {
    ok('TEMPLATE 块里没有单反斜杠控制转义（页内 JS 的 \\n 全部写成 \\\\n）');
  }

  /* ---- (a') 生成器里的**自检**本身也得在，而且真的被调用 ----
     第 (a) 条只盯得住「现在已经写错」。真正防回归的是 review-cards.py 里那道
     `check_inline_js()`：它在**落盘前**把产物喂给 node --check，写错就直接拒绝写出。
     少了它，下次改模板又会静默写出一个空白页 —— 所以这里钉住「函数在 + 有调用点」。 */
  if (!/def check_inline_js\(/.test(py)) {
    err('review-cards.py 里的 check_inline_js() 不见了 —— 生成物又失去了落盘前自检');
  } else {
    const bp = (/def build_page\([\s\S]*?\n(?=\ndef |\nclass )/.exec(py) || [''])[0];
    if (!/check_inline_js\(/.test(bp)) {
      err('build_page() 里没有调用 check_inline_js() —— 自检成了死代码（写了不跑等于没写）');
    } else {
      ok('review-cards.py 落盘前自检 check_inline_js() 在位、且 build_page() 真的调了它');
    }
  }

  /* ---- (b) 产物脚本真解析一遍 ----
     ⚠️ 这里**故意**不用 `spawnSync(node, ['--check'])`：本机实测起自己那个可执行文件
        会返回 `EBUSY`（status=null），于是「检查失败」和「起不来」混成同一个红，
        既报不出错在哪、又必然长期红着 —— 门禁一旦长期红就等于没有。
        语法校验其实不需要子进程：`new Function(code)` 只做**解析**、不执行，
        SyntaxError 一样抛出来 —— 也正是本文件开头加载各模块用的同一个办法。
     边界：`new Function` 是函数体作用域，顶层的 `return` 在它这里是合法的、
        在真脚本里不合法 ⇒ 这极少见的一类它放得过去（产物里本来也没有顶层 return）。 */
  const syntaxErr = code => { try { new Function(code); return null; } catch (e) { return e; } };

  /* 行为自检：先证明 syntaxErr 真的拦得住「字符串被截断成跨行」这一类 */
  const brokenSample = "var s = x.join('\n');";     // 真换行截断了字面量
  if (!syntaxErr(brokenSample)) {
    err('第 39 节 syntaxErr 自检不成立：连「字面量被真换行截断」都判成合法 —— 判据是装饰');
    return;
  }
  ok('syntaxErr 自检：字面量被真换行截断的脚本必被判非法（正是本次回归的形态）');

  const ART = path.join(ROOT, 'docs', '卡片评审.html');
  if (!fs.existsSync(ART)) {
    warn('docs/卡片评审.html 不在，跳过产物脚本语法检查（python tools/review-cards.py 生成）');
    return;
  }
  const html = fs.readFileSync(ART, 'utf8');
  const blocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
  if (!blocks.length) {
    err('docs/卡片评审.html 里一段 <script> 都没有 —— 页面必然是空白');
    return;
  }
  let bad = 0;
  blocks.forEach((blk, i) => {
    const code = blk.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    const e = syntaxErr(code);
    if (e) {
      bad++;
      const ln = (e.stack || '').match(/<anonymous>:(\d+)/);
      const lines = code.split('\n');
      const at = ln ? lines[Number(ln[1]) - 1] : '';
      err(`docs/卡片评审.html 第 ${i + 1} 段页内脚本语法不过 —— 打开就是空白。`
          + `${e.message}${at ? '（约在：' + at.trim().slice(0, 70) + '）' : ''}`);
    }
  });
  if (!bad) ok(`docs/卡片评审.html 的 ${blocks.length} 段页内脚本都能解析（${html.length} 字符）`);
})();


/* ---------------- 40. 评审台运行器：命令口径只有一处 + 注入面必须过白名单 ----------------
   用户口径 2026-10-08：「你就不能让我点击后自动打开 gen-art-loop.cmd 重新生图吗」
   ⇒ `tools/review-cards.py --serve` 有了三种跑法（后台 / 开窗口 / 开 gen-art-loop.cmd）。
   这一节钉的是这次**新增的两条口径**，两条都属于本项目明写的高危型：
     ① **同一个事实写两遍 = 高危**：「要跑什么」的命令行必须只有 `regen_argv()` 一处构造，
        后台跑与窗口跑都吃它。分家的表现是「页面上写的命令 ≠ 真的跑的命令」，
        而且**不报错** —— 你只会觉得「怎么没出图」。
     ② **拼进 shell 的命令必须过白名单**：窗口模式把 id / 档名写进 .cmd 再交给 cmd.exe
        以用户权限执行 ⇒ 必须过 `clean_groups()`。token 防的是「别的网页」，
        防不住 `C01 & del /f /q …` 这种参数注入。
   ⚠️ 判据都反向验证过：把 worker 改回自己拼命令行、把 clean_groups 摘掉，本节会报红。 */
console.log('\n[40] 评审台运行器：命令口径单源 + 窗口脚本注入面过白名单');
(() => {
  const P = path.join(ROOT, 'tools', 'review-cards.py');
  if (!fs.existsSync(P)) { err('找不到 tools/review-cards.py'); return; }
  const py = fs.readFileSync(P, 'utf8');

  /* ① 命令口径的源头在，而且真的被用 */
  if (!/def regen_argv\(/.test(py)) {
    err('regen_argv() 不见了 —— 「要跑什么」的命令行失去唯一构造处');
  } else if (!/g\["cmd"\]/.test(py)) {
    err('没有任何地方消费 regen_argv 的结果（g["cmd"]）—— 口径定义了却没用');
  } else {
    ok('regen_argv() 是命令行唯一构造处，且被消费（g["cmd"]）');
  }

  /* 函数体切片走顶层共享的 `bodyOf()`（它按「缩进 ≤ 该 def 自身的缩进」终止，
     对本文件的 JS 也成立：页内 JS 的函数体全部带缩进、闭合的 `}` 落在第 0 列）。
     2026-10-08 把它从本节提到顶层 —— 第 43 / 44 节也要切函数体，抄三份必然分家。 */

  /* ② 后台跑的 worker 不许自己拼命令行（必须吃 g["cmd"]） */
  const worker = bodyOf(py, 'def worker(');
  const dupRe = /gen-art\.py/;
  if (!worker) {
    warn('认不出 worker() 的形状 —— 判据要跟着改（别让它悄悄失效）');
  } else if (dupRe.test(worker)) {
    err('worker() 里又出现了 gen-art.py 字面量 —— 命令口径分家了（页面写的 ≠ 真的跑的）');
  } else if (!/g\["cmd"\]/.test(worker)) {
    err('worker() 没吃洗好的 g["cmd"] —— 它绕过了唯一口径');
  } else {
    ok('worker() 只吃洗好的 g["cmd"]，没有第二处命令行拼接');
  }
  /* 行为自检：上面这条判据真能抓到「自己拼」的写法 */
  const SYN_DUP = 'def worker(groups):\n    cmd = [sys.executable, "tools/gen-art.py"]\n';
  if (!dupRe.test(SYN_DUP)) {
    err('第 40 节的「重复拼命令行」判据不成立：连合成样本都抓不到');
    return;
  }
  ok('判据自检：合成「worker 自己拼命令行」样本能被抓到');

  /* ②-b 窗口脚本那份**也必须**吃 g["cmd"]（否则「窗口里跑的」与「后台跑的」又分家了） */
  const bcs = bodyOf(py, 'def build_console_script(');
  if (!bcs) {
    warn('认不出 build_console_script() 的形状 —— 判据要跟着改');
  } else if (!/g\["cmd"\]/.test(bcs)) {
    err('build_console_script() 没吃 g["cmd"] —— 窗口脚本里的命令与后台跑的不是同一条');
  } else {
    ok('build_console_script() 也吃 g["cmd"]（窗口脚本与后台跑同源）');
  }

  /* ③ 窗口模式那条路必须过白名单 */
  const post = bodyOf(py, 'def do_POST(');
  if (!post) {
    warn('认不出 do_POST() 的形状 —— 判据要跟着改');
  } else if (!/clean_groups\(/.test(post)) {
    err('do_POST() 里没有 clean_groups() —— 浏览器送来的 id 会直接被写进 .cmd 交给 cmd.exe');
  } else if (!/mode\s*==\s*"window"/.test(post)) {
    err('do_POST() 里没有 window 分支 —— 判据要跟着改（通道没了就别留着这条网）');
  } else {
    ok('do_POST() 的 window / loop / bg 三条路都要过 clean_groups() 白名单');
  }
  /* 行为自检：白名单函数本身必须真的拦得住注入（不能只看「调用点存在」） */
  const SYN_BAD = 'C01 & del /f /q C:\\';
  if (!/\[A-Za-z0-9_-\]\{1,16\}\$/.test('^[A-Za-z0-9_-]{1,16}$')) {
    err('白名单正则的形状变了 —— 判据要跟着改');
  } else if (/^[A-Za-z0-9_-]{1,16}$/.test(SYN_BAD)) {
    err('白名单正则竟然放过了注入样本 ' + SYN_BAD);
  } else {
    ok('判据自检：白名单正则拒绝注入样本（`' + SYN_BAD + '`）');
  }
})();


/* ---------------- 41. 背景音乐随「时段 / 天气」换参数（修饰量单一来源） ----------------
   由来（2026-10-08，队列 Q2）：BGM 原来只按钓场 —— 白天 / 夜里、晴天 / 暴雨是同一首，
   画面在变、音乐不变。做法：钓场主题 `theme.bgm` 是 **base**，
   `config.weather.times[].bgm` / `types[].bgm` 是那个条件的**修饰量**，
   `G.Weather.bgmSpec(base)` 是唯一把它们合起来的地方。

   三类「不报错但静默失效」在这里被钉住：
     ① **调式名写错一个字母** → `deg2freq` 里是 `SCALES[spec.mode] || SCALES.major`，
        静默退回大调。夜里"本来就没变"和"改了但没生效"听起来一模一样；
     ② **修饰表的键名打错**（`barmul`）→ 整条修饰被无声忽略，功能等于没做；
     ③ **有人在别处再合一遍**（或某个调用点直接把 `theme.bgm` 丢给 `startBgm`）
        → 同一件事的第二份真相，表现是「某个入口切过去音乐不跟着变」，极难发现。
   判据**全部现算**：真跑 `bgmSpec` 过 7 个钓场 × 4 天气 × 4 时段，不写死任何期望值。 */
console.log('\n[41] 背景音乐随条件换参数：修饰量单一来源、键名合法、且真的起作用');
(() => {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const Wx = sandbox.G && sandbox.G.Weather;
  const wxList = CFG.weather.types, tmList = CFG.weather.times;

  /* ① 修饰表的键名白名单 —— 键名是**数据**，拼错了没人会知道。
        · 时段能给 `mode` + `barMul`（20 分钟一轮，换调式是可预期的）
        · 天气**只给 `barMul`**（3~8 分钟随机换一次，跟着换调式会像音乐在抽风） */
  const ALLOW = { types: ['barMul'], times: ['mode', 'barMul'] };
  [['types', wxList], ['times', tmList]].forEach(([kind, list]) => {
    list.forEach(e => {
      const m = e.bgm;
      if (!m) return;
      Object.keys(m).forEach(k => {
        if (ALLOW[kind].indexOf(k) < 0) {
          err(`config.weather.${kind} 的「${e.key}」带了不该有的音乐修饰键 `
            + `（${kind} 只允许 ${ALLOW[kind].join(' / ')}）`
            + ' —— 拼错的键会被静默忽略，功能等于没做');
        }
      });
      if (m.barMul != null && !(isFinite(m.barMul) && m.barMul > 0.5 && m.barMul < 2)) {
        err(`config.weather.${kind} 的「${e.key}」速度修饰 = ${m.barMul}，超出 (0.5, 2)`);
      }
      if (m.mode != null && m.mode !== 'major' && m.mode !== 'minor') {
        err(`config.weather.${kind} 的「${e.key}」调式 = ${m.mode}，不是 major / minor`
          + '（写成别的值会让 deg2freq 静默退回大调）');
      }
    });
  });

  /* ② 现算：把 7 个钓场 × 每种「天气 × 时段」都过一遍 */
  if (!Wx || typeof Wx.bgmSpec !== 'function') {
    err('G.Weather.bgmSpec 不见了 —— 音乐与条件的合成口径没了（判据要跟着改）');
  } else {
    const badIdent = [], badRange = [], badMode = [], badRef = [], dirty = [];
    let neutralPairs = 0, movedPairs = 0, modeMoved = 0;
    const lo = { bar: Infinity }, hi = { bar: 0 };
    sandbox.G.FIELDS.forEach(f => {
      const b = f.theme.bgm, chords = b.chords;
      const snapshot = { mode: b.mode, bar: b.bar, root: b.root };
      wxList.forEach(wx => tmList.forEach(tm => {
        Wx.set(wx.key, tm.key);
        const s = Wx.bgmSpec(b);
        const neutral = !wx.bgm && !tm.bgm;
        if (neutral) {
          neutralPairs++;
          if (s.mode !== snapshot.mode || s.bar !== snapshot.bar
            || s.root !== snapshot.root || s.chords !== chords) {
            badIdent.push(`${f.id} @ ${wx.key}/${tm.key}`);
          }
        } else {
          movedPairs++;
          if (s.mode !== snapshot.mode) modeMoved++;
        }
        if (b.mode !== snapshot.mode || b.bar !== snapshot.bar || b.root !== snapshot.root) {
          dirty.push(`${f.id} @ ${wx.key}/${tm.key}`);
        }
        if (s.chords !== chords) badRef.push(`${f.id} @ ${wx.key}/${tm.key}`);
        if (s.mode !== 'major' && s.mode !== 'minor') badMode.push(`${f.id} @ ${wx.key}/${tm.key}=${s.mode}`);
        if (!(isFinite(s.bar) && s.bar > 0.5 && s.bar < 12)) badRange.push(`${f.id} @ ${wx.key}/${tm.key}=${s.bar}`);
        if (s.bar < lo.bar) lo.bar = s.bar;
        if (s.bar > hi.bar) hi.bar = s.bar;
      }));
    });

    if (badIdent.length) err(`「不带任何修饰」的条件本该是**恒等**（= 钓场原曲），这几处不是：${badIdent.join('、')}`);
    else ok(`基准态恒等：${neutralPairs} 组不带修饰的条件（${sandbox.G.FIELDS.length} 个钓场）与钓场原曲逐字段相同 —— 基线口径不漂`);

    if (!neutralPairs) err('一个「不带修饰」的条件都没有 —— 玩家永远听不到钓场原曲，也没有基线可比');
    if (!movedPairs) err('所有条件都没有音乐修饰 —— 这个功能等于没做（而文档 / 门禁都写着"已做"）');
    else if (!modeMoved) {
      err('没有任何条件改变调式 —— 昼夜只体现在速度上，对比弱到听不出来'
        + '（要么给它一个调式修饰，要么把这条判据连同理由一起删掉）');
    } else ok(`${movedPairs} 组带修饰的条件里 ${modeMoved} 组真的换了调式，且有效 bar 落在 `
      + `${lo.bar.toFixed(2)}~${hi.bar.toFixed(2)}s`);

    if (badMode.length) err(`有效 spec 的调式只许 major / minor：${badMode.join('、')}`);
    if (badRange.length) err(`有效 bar 必须落在 (0.5, 12) 秒内（倍率相乘跑飞了）：${badRange.join('、')}`);
    if (badRef.length) err(`有效 spec 应该复用 base 的 chords 引用（每换一次条件就复制一份是白给 GC 找活）：${badRef.join('、')}`);
    if (dirty.length) err(`bgmSpec 就地改了 fields.js 的常量对象（换了条件就把钓场数据污染了）：${dirty.join('、')}`);
  }

  /* ③ 合成口径不许分家（静态扫**全部 src/**，只扫代码不扫注释）：
        每个 `startBgm(<实参>)` 的实参只许是这两种形态 ——
          · `bgmOf()`            （main.js 的本地助手，内部调 bgmSpec）
          · `G.Weather.bgmSpec(<当前钓场的 base>)`
        实参里直接出现 `theme.bgm` = 绕开时段 / 天气修饰。
        ⚠️ **必须是全 src/ 扫描，不能只扫 main.js** —— 第一版只扫了 main.js，
           于是 `panels.js` 里那处「从设置面板重新打开音乐」漏了网：它的表现是
           「只有设置面板这一个入口恢复的音乐不随时段变」，其它入口全正常，极难复现。
           这正是本项目踩过的「同一件事的第二份真相」的形状。
        ⚠️ 取实参要**配平括号**：`[^)]*` 会在 `startBgm(bgmOf())` 的第一个 `)` 处刹住，
           切出 `startBgm(bgmOf()` → 明明写对了却报红（第一版就是这么假红的）。 */
  const srcFiles = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const rel = dir + '/' + n;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.js$/.test(n)) srcFiles.push(rel);
    });
  })('src');
  const calls = [];
  srcFiles.forEach(rel => {
    /* 扫源码里的**调用**，不扫 audio.js 自己的定义 */
    if (rel === 'src/core/audio.js') return;
    const js = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (let i = js.indexOf('startBgm('); i >= 0; i = js.indexOf('startBgm(', i + 1)) {
      let j = i + 'startBgm('.length, depth = 1;
      while (j < js.length && depth) {
        if (js[j] === '(') depth++;
        else if (js[j] === ')') depth--;
        j++;
      }
      calls.push({ rel, arg: js.slice(i + 'startBgm('.length, j - 1).trim() });
    }
  });
  const OK_ARG = /^(bgmOf\(\)|G\.Weather\.bgmSpec\([\s\S]+\))$/;
  const wrong = calls.filter(c => !OK_ARG.test(c.arg));
  const mainJs = strip(fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8'));
  if (!calls.length) err('src/ 里找不到 startBgm 调用 —— 判据要跟着改');
  else if (wrong.length) {
    err('这些 startBgm 调用点没走合成口径（实参不是 bgmOf() / G.Weather.bgmSpec(...)）：'
      + wrong.map(c => c.rel + ' → ' + c.arg).join('；')
      + ' —— 绕开修饰的表现是「只有这个入口的音乐不随时段变」');
  } else if (!/function bgmOf\(\)[\s\S]*?G\.Weather\.bgmSpec\(/.test(mainJs)) {
    err('main.js 的合成助手没去调 G.Weather.bgmSpec —— 那它自己算的是什么？');
  } else {
    const files = calls.map(c => c.rel).filter((v, i, a) => a.indexOf(v) === i).sort();
    ok(`src/ 里 ${calls.length} 处 startBgm 全部走合成口径（${files.join(' / ')}），`
      + 'main.js 的 bgmOf() 体内也真的调了 G.Weather.bgmSpec');
  }

  /* ④ 「修饰量只有那个合成函数读」的字面量白名单：
        扫 src/（**不含 tools/**，否则本文件里这条断言自己的文案就把网喂饱了 —— 32-g 同款坑）。
        多一处 / 少一处都报红 ⇒ 新增任何包装器都会立刻暴露，不用去猜还有什么写法能绕。 */
  const stray = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const rel = dir + '/' + n;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(js|html)$/.test(n)) {
        if (rel === 'src/data/config.js' || rel === 'src/core/weather.js') return;
        if (strip(fs.readFileSync(path.join(ROOT, rel), 'utf8')).indexOf('barMul') >= 0) stray.push(rel);
      }
    });
  })('src');
  if (stray.length) err(`速度修饰的字面量只许出现在 config.js（定义）与 weather.js（合成）：${stray.join('、')}`);
  else ok('速度修饰的字面量只出现在 config.js 与 weather.js 两处（其余模块无从"自己再算一遍"）');
})();


/* ---------------- 42. 接触表：判定口径不许有第二份 ----------------
   背景：`tools/contact-sheet.py`（把一批卡面拼成一张大图，人一次过 20~40 张）。
   它要在缩略图上画红 / 黄框，**最省事的写法就是自己再判一遍几何** ——
   一旦两处阈值分家，就会出现「评审台说合格、接触表画红框」（本项目最忌的「第二份真相」，
   同族事故见 §41 与 MEMORY.md 的「同一个事实被写 N 遍 = 高危」）。
   这里把五件事钉死：
     ① 接触表里**不许出现** check-cards 的任何阈值标识符与判定文案 —— 必须 import 现成的；
     ② 判定只有**一个入口** `judge()`，`main()` 自己不许再比一次阈值（这段原来就是inline在 main 里的）；
     ③ 接触表与 `docs/卡片评审.html` 用**同一套色**（一个视觉体系，颜色不许抄歪）；
     ④ **成组判据**（`check-cards.py` 的 ⑦ 跨档一致性，2026-10-08 加）：
        接触表必须走 `judge_group()`（逐张 `judge()` 读不到跨档提示），
        且跨档判据**只能是提示级** —— `judge_group()` 体内不许出现 `hard`，
        `judge()` 体内不许出现 `drift`（单张判定不许受成组结果影响，否则两套口径混在一处）。
     ⑤ **中位的样本口径**（Q33，2026-10-08 加）：同一档出了多版（传说闪光 2 版）时，
        每档在「该鱼中位」里**只投一票** —— 折版规则（槽位键 → 档键）只许有
        `morph_key()` 一处定义，且 `slot_of()` / `drift_warnings()` 都走它。
   ⚠️ ① 必须**只扫代码不扫注释**（开发者文档 §8 硬规矩第 1 条）：散文里提一句颜色判定
      是正当的，`stripPy()` 因此把 docstring 与 `#` 注释都拿掉再扫。
   ⚠️ 反向验证（两向都要做）：注释里写违规词 → 必须**仍然绿**；代码里写 → 必须红。 */
console.log('\n[42] 接触表与验收同源：判定单入口、阈值不重写、配色与评审页一致');
(() => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* Python 的「只扫代码」：先摘 docstring（三引号整块 = 散文），再摘 `#` 行注释。
     ⚠️ 单行字符串里的 `#`（如调色板的 "#16171a"）会被一并切掉 —— 对 ①② 无害
        （它们找的是标识符与判定文案，本来就不该出现在字符串里；真出现了更该报红）。
        ③ 用的是**原文**，不走本函数。 */
  const stripPy = t => t.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''")
    .replace(/#[^\n]*/g, '');

  const sheet = stripPy(read('tools/contact-sheet.py'));
  const cc = stripPy(read('tools/check-cards.py'));

  /* ① 阈值与判定文案：接触表里一个都不许有
        （含 ⑦ 跨档判据的阈值与主词 —— 它的文案也由 check-cards 拼好，接触表只显示原文） */
  const forbidden = ['AREA_MIN', 'AREA_MAX', 'BG_TOL', 'EDGE_PAD', 'MASK_THRESH',
    'DRIFT_AREA', 'DRIFT_WH', 'DRIFT_CX', 'DRIFT_TAG',
    '背景漂移', '贴边裁切', '主体占比越界', '跨档'];
  const hit = forbidden.filter(t => has(sheet, t));
  if (hit.length) {
    err(`tools/contact-sheet.py 里出现了 check-cards 的判定口径（${hit.join('、')}）`
      + ' —— 判定必须 import check-cards 的 judge()；阈值抄一份 = 两份真相');
  }

  /* ② 判定只有一个入口：`def judge(` 恰好一处，且 `main()` 体内不再比阈值 */
  let secBad = 0;
  const judgeDefs = (cc.match(/def\s+judge\s*\(/g) || []).length;
  if (judgeDefs !== 1) { err(`check-cards.py 里 def judge( 有 ${judgeDefs} 处（应为 1）`); secBad++; }
  const mi = at(cc, 'def main(');
  if (mi < 0) { err('check-cards.py 里找不到 def main( —— 本断言按它切片，改了名就来更新'); secBad++; }
  else {
    const body = cc.slice(mi);
    // 主入口调**任一个**判定入口都算接上了（成组工具的接入点是 `judge_group`，
    // 它自己再调 `judge` —— 那一条由下面 ④ 单独盯）。
    if (!has(body, 'judge(') && !has(body, 'judge_group(')) {
      err('check-cards.py 的 main() 既没调 judge() 也没调 judge_group() —— 判定入口没接上'); secBad++;
    }
    const dup = ['AREA_MIN', 'AREA_MAX', 'BG_TOL', 'EDGE_PAD', 'MASK_THRESH',
      'DRIFT_AREA', 'DRIFT_WH', 'DRIFT_CX']
      .filter(t => has(body, t));
    if (dup.length) {
      err(`check-cards.py 的 main() 里又出现了阈值（${dup.join('、')}）—— 判定只许有 judge() 一处`); secBad++;
    }
  }

  /* ④ 成组判据：唯一入口 + 提示级边界（两条判据都按**函数体切片**判，不是全文件 has） */
  const ggDefs = (cc.match(/def\s+judge_group\s*\(/g) || []).length;
  const drDefs = (cc.match(/def\s+drift_warnings\s*\(/g) || []).length;
  if (ggDefs !== 1) { err(`check-cards.py 里 def judge_group( 有 ${ggDefs} 处（应为 1）`); secBad++; }
  if (drDefs !== 1) { err(`check-cards.py 里 def drift_warnings( 有 ${drDefs} 处（应为 1）`); secBad++; }
  const ji = at(cc, 'def judge('), di = at(cc, 'def drift_warnings('),
    gi = at(cc, 'def judge_group(');
  if (ji < 0 || di < 0 || gi < 0 || mi < 0 || !(ji < di && di < gi && gi < mi)) {
    err('check-cards.py 的函数顺序变了（analyze → judge → drift_warnings → judge_group → main）'
      + ' —— 本条按位置切片，改了就来更新');
    secBad++;
  } else {
    const judgeBody = cc.slice(ji, di);
    const groupBody = cc.slice(gi, mi);
    // ⚠️ 判据用 `drift_warnings` / `DRIFT_` 而不是裸 `drift`：`bg_drift` 是**单张**判据
    //    自己的字段名，裸 `drift` 会把它当成跨档判据（第一版就这么误报过）。
    const leaked = ['drift_warnings', 'DRIFT_'].filter(n => has(judgeBody, n));
    if (leaked.length) {
      err(`check-cards.py 的 judge() 里出现了跨档判据（${leaked.join('、')}）—— `
        + '单张判定不许读成组结果（两套口径混在一处）');
      secBad++;
    }
    if (!has(groupBody, 'judge(')) {
      err('check-cards.py 的 judge_group() 没调 judge() —— 单张判定的口径没复用（等于又写了一份判定）');
      secBad++;
    }
    if (!has(groupBody, 'drift_warnings(')) {
      err('check-cards.py 的 judge_group() 没调 drift_warnings() —— 跨档提示没接上，等于白写');
      secBad++;
    }
    if (has(groupBody, 'hard')) {
      err('check-cards.py 的 judge_group() 里出现了 hard —— 跨档判据**只能是提示级**：'
        + '档间漂移是已知且接受的代价（IoU 0.997→0.93），判 FAIL 会把正常出图全否掉');
      secBad++;
    }
    if (!has(sheet, 'judge_group(')) {
      err('tools/contact-sheet.py 没走 judge_group()：逐张 judge 读不到跨档提示（⑦）'); secBad++;
    }
    if (has(sheet, 'cs.judge(')) {
      err('tools/contact-sheet.py 里还在逐张调 cs.judge( —— 整条鱼一起判请走 judge_group()'); secBad++;
    }
  }

  /* ⑤ 跨档中位的**样本口径**：同一档的多版只许投一票（Q33）
     `MORPH_RE` 认得第 N 版（`<id>-<档>-N.png`），评审台自 Q32 起给**每一版**一个槽位，
     接触表把**槽位键**原样喂进 `judge_group()` ⇒ 传说鱼（闪光 2 版）的组里有 6 个样本、
     其中 2 个同档。若按样本算中位，中位就被「候选数」拽走 —— 症状是**别的档被误标掉队**
     （谁掉队认错人）；而 4 条多版鱼当前恰好都还没触发 ⇒ 属于「不报错的静默口径错」。
     三条判据都按**函数体**切片（不扫全文件），且第三条盯的是**字面量的位置**：
       · 「槽位键 → 档键」的折版规则只许有**一处**定义（`morph_key()`）；
       · 从文件名推档键的 `slot_of()` 必须走它；
       · 算中位的 `drift_warnings()` 必须走它。 */
  const VER_SUFFIX = '-' + '\\d+$';
  const mkDefs = (cc.match(/def\s+morph_key\s*\(/g) || []).length;
  if (mkDefs !== 1) {
    err(`check-cards.py 里 def morph_key( 有 ${mkDefs} 处（应为 1 —— 「槽位键 → 档键」只许一处定义）`);
    secBad++;
  }
  const litCount = cc.split(VER_SUFFIX).length - 1;
  const mkBody = bodyOf(cc, 'def morph_key');
  if (litCount !== 1 || !has(mkBody, VER_SUFFIX)) {
    err(`check-cards.py 里版本后缀正则（${VER_SUFFIX}）出现 ${litCount} 处`
      + '（应为 1，且落在 morph_key() 里）—— 折版规则抄了第二份 ⇒ 同一档的多版会在'
      + '一条路上被折叠、在另一条路上没有');
    secBad++;
  }
  [['slot_of', bodyOf(cc, 'def slot_of')],
    ['drift_warnings', bodyOf(cc, 'def drift_warnings')]].forEach(pair => {
    if (!has(pair[1], 'morph_key(')) {
      err(`check-cards.py 的 ${pair[0]}() 没走 morph_key() —— 档键口径分家，`
        + '同一档的多版会被当成两个档（中位被候选数拽走）');
      secBad++;
    }
  });

  /* ③ 同一套色：评审页 `:root` 里的每个色都要在接触表里有同名常量、且逐值相同 */
  const root = /:root\s*\{([\s\S]*?)\}/.exec(read('tools/review-cards.py'));
  const vars = root ? (root[1].match(/--([a-z]+)\s*:\s*(#[0-9a-fA-F]{6})/g) || []) : [];
  if (vars.length < 8) {
    err(`解析不出评审页的调色板（只认出 ${vars.length} 个色）—— 改了措辞就来更新本断言`); secBad++;
  }
  let bad = 0;
  const sheetRaw = read('tools/contact-sheet.py');
  vars.forEach(v => {
    const m = /--([a-z]+)\s*:\s*(#[0-9a-fA-F]{6})/.exec(v);
    if (!new RegExp('\\b' + m[1].toUpperCase() + '\\s*=\\s*"' + m[2] + '"').test(sheetRaw)) {
      err(`接触表的调色板没跟上评审页：${m[1]} 应为 ${m[2]}`); bad++;
    }
  });

  if (!hit.length && !secBad && !bad) {
    ok(`接触表复用 check-cards 的判定（${forbidden.length} 项口径 0 处重复）、`
      + `judge() / judge_group() 各自唯一入口（跨档提示只进 soft）、`
      + `跨档中位按档投一票（折版规则只在 morph_key() 一处）、`
      + `且与评审页共用同一套 ${vars.length} 色`);
  }
})();


/* ---------------- 43. 评审页：内部形态模板键必须带中文标签 ----------------
   背景（2026-10-08 真浏览器复核的副产物）：探针打出 `溪哥C01 · 普通 · fish` ——
   我第一眼把 `fish` 当成占位符 / 脏数据。它其实是 `src/data/fish.js` 的**第 4 参**、
   由 `fishart.js` 的 `TPL[fish.shape] || TPL.fish` 取用的**画法键**，
   而画法恰恰是「画错物种」的根因线索（`shape=squid` 的章鱼、`shape=fish` 的八爪鱼）。

   本节钉三条，都是「同一类错法，换个地方再来一次」的通用网：
     ① **标签表与真实模板键集同源**：`SHAPE_CN` 的键 == `fishart.js` 里 `TPL.<键>` 的键集。
        少一个 ⇒ 页面上印裸英文；多一个 ⇒ 死配置（模板改名了没人发现）。
        这就是「同一个事实写两遍」的**反面**：键集只有 fishart 一处真相，这里只是要求它被覆盖。
     ② **内部键不许裸印**：页内 JS 里 `d.shape` 只许出现在 `shapeTag()` 函数体内
        （标签 + 提示都由 Python 侧算好，页内不许再写第二份映射）。
        判据是「位置白名单」而不是「不许出现」—— 键本身要显示出来供核对。
     ③ **提示词表里不许有零消费死词**：每个家族词都必须在 `G.FISH` 的名字里真命中过
        （实测排除过「鲼」「八爪」「柔鱼」「海蜇」—— 362 条里一条都不命中）。
   三条都**反向验证过**：改 fishart 的键名 / 把裸键印回卡片 / 往词表里塞一个死词，本节分别报红。 */
console.log('\n[43] 评审页：内部形态模板键必须带中文标签（表与 fishart 的 TPL 同源）');
(() => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* 「只扫代码」：摘三引号块与 `#` 行注释 —— 说明注释里提到键名不算违规（负对照验证过）。 */
  const stripPy = t => t.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''")
    .replace(/#[^\n]*/g, '');
  const pyRaw = read('tools/review-cards.py');
  const py = stripPy(pyRaw);
  const uniq = a => a.filter((x, i) => a.indexOf(x) === i);

  /* ---------- ① SHAPE_CN 的键集 == fishart.js 的 TPL 键集（双向） ---------- */
  const tplKeys = uniq((read('src/render/fishart.js').match(/\bTPL\.([A-Za-z][A-Za-z0-9]*)\s*=/g) || [])
    .map(s => /TPL\.([A-Za-z][A-Za-z0-9]*)/.exec(s)[1]));
  const dict = /SHAPE_CN\s*=\s*\{([\s\S]*?)\}/.exec(py);
  const labelKeys = dict ? uniq((dict[1].match(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g) || [])
    .map(s => /"([A-Za-z][A-Za-z0-9]*)"/.exec(s)[1])) : [];
  if (!tplKeys.length || !labelKeys.length) {
    err(`第 43 节键集抓不到（fishart 的 TPL ${tplKeys.length} 个 / SHAPE_CN ${labelKeys.length} 个）`
      + ' —— 空集会让下面的判断恒真，所以直接报错；改了写法就来更新本断言');
    return;
  }
  const missingIn = (have, want) => want.filter(k => have.indexOf(k) < 0);
  /* 判据自检：先证明差集函数真分得出「少一个键」（否则下面两条永远是绿的） */
  if (missingIn(['x'], ['x', 'y']).join() !== 'y' || missingIn(['x', 'y'], ['x']).length) {
    err('第 43 节判据自检不成立：差集函数分不出「少一个键」'); return;
  }
  const missLabel = missingIn(labelKeys, tplKeys);
  const extraLabel = missingIn(tplKeys, labelKeys);
  if (missLabel.length) {
    err(`fishart.js 有模板键却没有中文标签：${missLabel.join('、')} ——`
      + '评审页会把内部键裸印出来（去 review-cards.py 的 SHAPE_CN 补上）');
  }
  if (extraLabel.length) {
    err(`SHAPE_CN 里有 fishart.js 不存在的键：${extraLabel.join('、')} ——`
      + '死配置（模板改名 / 删掉了？）');
  }
  if (!missLabel.length && !extraLabel.length) {
    ok(`形态模板标签表与 fishart 的 TPL 键逐个对上（${tplKeys.length} 个：${tplKeys.join('/')}）`);
  }

  /* ---------- ② 页内 JS 里裸键只许出现在 shapeTag() 体内 ---------- */
  const tpl = (/TEMPLATE\s*=\s*u?"""([\s\S]*?)"""/.exec(pyRaw) || [])[1] || '';
  if (!tpl) { err('第 43 节：review-cards.py 里认不出 TEMPLATE 三引号块'); return; }
  /* ⚠️ 先剥页内 JS 的注释再判 —— 否则说明注释里写一句 `d.shapeHint` 就把断言喂饱了
     （本项目反复栽过的「自指喂饱」；反向验证第 ⑥ 条就是为此改的锚点）。 */
  const tplJS = tpl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');
  const bare = t => (t.match(/d\.shape\b/g) || []).length;   // `\b` 保证不把 d.shapeCn / d.shapeHint 算进来
  /* 函数体切片走顶层共享的 `bodyOf()`（本节原来自带一份 `fnBody`，第 40 / 44 节各一份 ⇒ 提到顶层） */
  const tagBody = t => bodyOf(t, 'function shapeTag(');
  const outside = t => bare(t) - bare(tagBody(t));
  /* 判据自检：好样本（裸键在 shapeTag 里）与坏样本（裸键印在 render 里）必须被分开 */
  const SYN_OK = "function shapeTag(d) { return d.shapeCn + '<code>' + d.shape + '</code>'; }\nfunction render() { return 1; }";
  const SYN_BAD = "function shapeTag(d) { return d.shapeCn; }\nfunction render() { return ' · ' + d.shape; }";
  if (outside(SYN_OK) !== 0 || outside(SYN_BAD) !== 1) {
    err(`第 43 节判据自检不成立：分不出「裸键印在 shapeTag 之外」（好样本 ${outside(SYN_OK)}、坏样本 ${outside(SYN_BAD)}）`);
    return;
  }
  const tb = tagBody(tplJS), rb = bodyOf(tplJS, 'function render(');
  if (!tb) {
    err('评审页的页内 JS 里找不到 shapeTag() —— 形态模板那一格必须走它，不许裸拼内部键');
  } else if (bare(tb) < 1) {
    err('shapeTag() 里没有 d.shape（原始键不再显示）—— 键要留着供核对');
  } else if (outside(tplJS) !== 0) {
    err(`评审页有 ${outside(tplJS)} 处把形态模板的内部键裸印在 shapeTag() 之外 ——`
      + '玩家看到的是 `fish` 这种英文原值，而不是「通用鱼形」');
  } else if (!has(tb, 'd.shapeCn') || !has(tb, 'd.shapeHint')) {
    err('shapeTag() 没同时用到中文标签与提示字段 —— 标签只算不用，等于没加');
  } else if (!rb) {
    err('第 43 节找不到页内 render() —— 判「调没调 shapeTag」要按它的函数体切片');
  } else if (!has(rb, 'shapeTag(')) {
    /* ⚠️ 必须切 render() 的函数体来判：直接 `has(tpl,'shapeTag(d)')` 会被
       **定义行** `function shapeTag(d)` 自己满足 —— 反向验证第 ④ 条实测过（假通过）。 */
    err('render() 里没有调 shapeTag(...) —— 函数写了但没人用（死代码），卡片还是印裸键');
  } else {
    ok('形态模板那一格走 shapeTag()：中文标签 + 原始键 + 提示，内部键没有别处裸印');
  }

  /* ---------- ③ 交叉提示词表：不许有零消费死词，家族键必须是真模板 ---------- */
  const hm = /SHAPE_NAME_HINTS\s*=\s*\(([\s\S]*?)\n\)/.exec(py);
  const fams = [];
  if (hm) {
    (hm[1].match(/\("([A-Za-z][A-Za-z0-9]*)",\s*\(([^)]*)\)\)/g) || []).forEach(s => {
      const g = /\("([A-Za-z][A-Za-z0-9]*)",\s*\(([^)]*)\)\)/.exec(s);
      fams.push({ key: g[1], words: (g[2].match(/"([^"]*)"/g) || []).map(w => w.slice(1, -1)) });
    });
  }
  if (!fams.length) {
    err('第 43 节抓不到 SHAPE_NAME_HINTS 的词表 —— 它空了的话这张网什么也不拦（改了写法就来更新本断言）');
    return;
  }
  const names = G.FISH.map(f => f.name);
  const dead = [], badKey = [], counts = [];
  fams.forEach(f => {
    if (labelKeys.indexOf(f.key) < 0) badKey.push(f.key);
    f.words.forEach(w => {
      const n = names.filter(x => x.indexOf(w) >= 0).length;
      counts.push([w, n]);
      if (!n) dead.push(w);
    });
  });
  if (badKey.length) {
    err(`提示词表里的家族键不是形态模板键：${badKey.join('、')}（拼错了？）`);
  }
  if (dead.length) {
    err(`提示词表里有零命中的死词：${dead.join('、')} ——`
      + ` ${G.FISH.length} 条名字里一条都不命中 ⇒ 加了也不会有任何提示，是死配置`);
  }
  if (!badKey.length && !dead.length) {
    const lo = counts.slice().sort((a, b) => a[1] - b[1])[0];
    ok(`${fams.length} 个家族 / ${counts.length} 个词全部真命中`
      + `（现算 ${G.FISH.length} 条名字，最少的是「${lo[0]}」${lo[1]} 条）`);
  }
})();


/* ---------------- 44. 档位槽的口径必须同源（含「一档多版」） ----------------
   背景（2026-10-08 用户报障）：传说档的闪光从这一天起**出 2 版**
   （`gen-art.py` 的 `MORPH_VERSIONS_BY_RAR` ⇒ `<id>-shiny.png` 与 `<id>-shiny-2.png`）。
   生图清单的勾选（`write_plan`）与 `check-cards.py` 的 `MORPH_RE` 各修过一次，
   但**评审页**的槽位是写死的 5 个（`MORPH_CN`）⇒ 第 2 版在页面上**根本不存在**：
   图出了、没人看过、也没法标记重出。这是「交付物扩了、检测/评审条件没扩」的同一个老坑。

   本节钉四件事（都是「同源一致」，不是「这次能过」）：
     ① **档位键集同源**：`review-cards.py` 的 `MORPH_CN` 键集 == {normal} ∪ `gen-art.py` 的
        `MORPH_ORDER`（双向）。少一个 ⇒ 那一档的卡**永远没人评审**；多一个 ⇒ 死配置。
        且 `MORPH_KEYS`（重出白名单）必须**派生自** `MORPH_CN`，不许再抄一份。
     ② **槽位按磁盘文件枚举**：`morph_slots()` 必须走 `morph_versions_of()`，
        且那里面认得 `-<数字>` 后缀；两处都**不许**读 `MORPH_VERSIONS_BY_RAR`
        —— 那是「**打算**出几版」，而评审页要覆盖的是「**盘上真有几版**」
        （盘上多出的版本、只剩第 2 版的鱼，按「打算」判会一起漏掉）。
     ③ **重出分组按档**：页内 `collectGroups()` / `refreshImages()` 必须按 `s.morph` 处理
        —— 送槽位键（`shiny-2`）过去会被 `clean_groups()` 白名单拒掉（表现：点了没能开跑）；
        按槽位键清结论则会留下「图换了、结论还是旧的」。
     ④ **档位中文只有一处真相**：页内 JS 不许再抄「键 → 中文」的字面表（分组标题走
        Python 给的 `morphLabel`）。抄了就会漂（`--only-morph` 那行的档名也是它印的），
        而且源码扫描看不出来。
   ⚠️ ③④ 必须按**函数体切片**判：全文件 `has()` 会被定义行 / 别处的同名字段喂饱。
   ⚠️ 行为侧（槽位键 / 标签 / 版本顺序）由 `test-review-cards.py` 第 [11] 节用
      **构造文件名**验 —— 那边不依赖真实卡面（用户随时在重出图）。 */
console.log('\n[44] 档位槽的口径必须同源（档位键集 / 按文件枚举 / 重出按档 / 中文一处）');
(() => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const stripPy = t => t.replace(/"""[\s\S]*?"""/g, '""').replace(/'''[\s\S]*?'''/g, "''")
    .replace(/#[^\n]*/g, '');
  const pyRaw = read('tools/review-cards.py');
  const py = stripPy(pyRaw);
  const uniq = a => a.filter((x, i) => a.indexOf(x) === i);
  const secBad = [];
  const bad = m => { err(m); secBad.push(1); };

  /* ---------- ① 档位键集同源 ---------- */
  const mcBlock = /MORPH_CN\s*=\s*\[([\s\S]*?)\]/.exec(py);
  const rcKeys = mcBlock ? uniq((mcBlock[1].match(/\("([a-z_]+)",/g) || [])
    .map(s => /"([a-z_]+)"/.exec(s)[1])) : [];
  const gaSrc = stripPy(read('tools/gen-art.py'));
  const ordBlock = /MORPH_ORDER\s*=\s*\(([^)]*)\)/.exec(gaSrc);
  const gaKeys = ordBlock ? uniq((ordBlock[1].match(/"([a-z_]+)"/g) || [])
    .map(s => s.slice(1, -1))) : [];
  /* 判据自检：差集函数必须真分得出「少一个键」—— 否则下面两条永远是绿的 */
  const missingIn = (have, want) => want.filter(k => have.indexOf(k) < 0);
  if (missingIn(['x'], ['x', 'y']).join() !== 'y' || missingIn(['x', 'y'], ['x']).length) {
    err('第 44 节判据自检不成立：差集函数分不出「少一个键」'); return;
  }
  if (!rcKeys.length || !gaKeys.length) {
    err(`第 44 节档位键集抓不到（review-cards 的 MORPH_CN ${rcKeys.length} 个 / `
      + `gen-art 的 MORPH_ORDER ${gaKeys.length} 个）—— 空集会让下面两条恒真（假通过），`
      + '所以直接报错；改了写法就来更新本断言');
    return;
  }
  const wantKeys = uniq(['normal'].concat(gaKeys));
  const miss = missingIn(rcKeys, wantKeys);
  const extra = missingIn(wantKeys, rcKeys);
  if (miss.length) {
    bad(`gen-art 会出的档位，评审页的 MORPH_CN 里没有：${miss.join('、')} ——`
      + '那一档的卡**永远没人评审**（图出了、没人看过；2026-10-08 的第 2 版就是这么漏的）');
  }
  if (extra.length) {
    bad(`评审页 MORPH_CN 里有 gen-art 不出的档位：${extra.join('、')} —— 死配置（档位改名 / 删了？）`);
  }
  if (!has(py, 'MORPH_KEYS = ("master",) + tuple(k for k, _ in MORPH_CN')) {
    bad('MORPH_KEYS（重出白名单）不再派生自 MORPH_CN —— 两份档位清单迟早分家'
      + '（分家的表现：明明有的档，点重出被白名单拒掉）');
  }

  /* ---------- ② 槽位按磁盘文件枚举 ---------- */
  const ms = bodyOf(py, 'def morph_slots(');
  const mv = bodyOf(py, 'def morph_versions_of(');
  if (!ms || !mv) {
    bad('第 44 节切不出 morph_slots() / morph_versions_of() —— 改了名就来更新本断言');
  } else {
    if (!has(ms, 'morph_versions_of(')) {
      bad('morph_slots() 没走 morph_versions_of() —— 「档位 → 版本」的唯一入口被绕开了');
    }
    if (!has(ms, '%s-%d')) {
      bad('morph_slots() 的槽位键里没有版本后缀 —— 第 N 版会与第 1 版同一个键'
        + '（两个槽共用一份结论，点一个另一个跟着变）');
    }
    [['morph_slots()', ms], ['morph_versions_of()', mv]].forEach(([who, body]) => {
      if (has(body, 'MORPH_VERSIONS_BY_RAR')) {
        bad(`${who} 读了 gen-art 的 MORPH_VERSIONS_BY_RAR —— 那是「打算出几版」，`
          + '而评审页要覆盖的是「盘上真有几版」（盘上多出的版本 / 只剩第 2 版的鱼都会漏）');
      }
    });
  }

  /* ---------- ③ 页内 JS：重出分组按档 + 档位中文只有一处真相 ---------- */
  const tpl = (/TEMPLATE\s*=\s*u?"""([\s\S]*?)"""/.exec(pyRaw) || [])[1] || '';
  if (!tpl) { bad('第 44 节：认不出 review-cards.py 的 TEMPLATE 三引号块'); }
  else {
    /* 先剥页内 JS 的注释 —— 说明注释里提到档位名是正当的（负对照验证过） */
    const tplJS = tpl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');
    const cg = bodyOf(tplJS, 'function collectGroups(');
    const rf = bodyOf(tplJS, 'function refreshImages(');
    if (!cg) bad('页内 JS 里找不到 collectGroups() —— 本判据按它切片');
    else if (!has(cg, '.morph')) {
      bad('collectGroups() 不按档分组 —— 槽位键（`shiny-2`）送过去会被 clean_groups() '
        + '白名单拒掉，表现是「点了重出，没能开跑」');
    } else if (has(cg, 'indexOf(s.k)')) {
      bad('collectGroups() 还在按槽位键去重 / 分组 —— 重出命令的粒度是**档**');
    }
    if (!rf) bad('页内 JS 里找不到 refreshImages() —— 本判据按它切片');
    else if (!has(rf, '.morph')) {
      bad('refreshImages() 按槽位键清结论 —— 重出是按**档**跑的（同档每一版一起换图），'
        + '只清被标记的那一版会留下「图换了、结论还是旧的」');
    }
    /* 档位中文的**唯一真相**是 Python 侧的 `MORPH_CN`（经 slot.label / slot.morphLabel 注入）。
       页内再抄一份「键 → 中文」的字面表 ⇒ 两份必然分家，而源码扫描看不出来。 */
    const lit = /['"]?(bright|albino|golden|shiny)['"]?\s*:\s*['"][^'"]+['"]/.exec(tplJS);
    if (lit) {
      bad(`页内 JS 里又抄了一份「档位键 → 中文」的表（${lit[0].slice(0, 40)}）——`
        + '分组标题必须走 DATA 里的 morphLabel（抄了就会漂：重出清单上印的档名就是它）');
    }
    if (!has(tplJS, 'MORPH_LABEL') || !has(tplJS, 's.morphLabel')) {
      bad('页内 JS 没有从 DATA 建 MORPH_LABEL（`s.morphLabel`）—— 分组标题的中文没来源');
    }
  }

  /* ---------- ④ 接触表 --morph 按**档**筛（不然只看闪光时第 2 版看不见） ---------- */
  const sheet = stripPy(read('tools/contact-sheet.py'));
  const pickB = bodyOf(sheet, 'def pick(');
  if (!pickB) {
    bad('第 44 节切不出 contact-sheet.py 的 pick() —— 改了名就来更新本断言');
  } else if (!has(pickB, '["morph"]')) {
    bad('contact-sheet 的 --morph 没按档筛（`s["morph"]`）—— 某一档出了多版时'
      + '只看得见第 1 版，第 2 版又成了「出了但没人看」');
  } else if (has(pickB, '["k"]')) {
    bad('contact-sheet 的 --morph 还在按槽位键筛 —— 多版档位会漏掉第 2 版');
  }

  if (!secBad.length) {
    ok(`档位槽口径同源：MORPH_CN（${rcKeys.join('/')}）== {normal} ∪ gen-art 的 MORPH_ORDER`
      + `（${gaKeys.join('/')}）；槽位按文件枚举、重出分组按档、档位中文只在 Python 一处`);
  }
})();


console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
