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
   和原文偏移对不上（栽过一次：第 33-c / 33-f 节当场读歪，报「少了 build_prompt(」）。
   🔴 **不许把 needle 变成正则**（Q39，2026-10-09）：旧实现是
   `new RegExp(needle 里每个空格换成空白类)` —— 正则源随 needle **无上限增长**：
   把 tools/review-cards.py 的 25 KB HTML 模板喂进来时当场
   `SyntaxError: Invalid regular expression: … Stack overflow`。
   ⚠️ 它的失败态是**整份门禁崩掉**（不是报红一条）：`new RegExp()` 是惰性编译所以不报错，
   到 `.exec()` 才炸 ⇒ 第一眼极易误判成「写法有问题」。而「拿 at() 反查一大段文本的位置」
   这个动作以后还会出现（第 ㊴ 节就被它绊过）⇒ 改成**纯扫描**：把 needle 按空白切成
   「空白要求 + 字面段」，逐段走 indexOf。于是**没有规模上限**，也就不必再立一条
   「needle 长度上限」的阈值（阈值要拿理由去撑）。第 ㊷ 节 ⑪ 盯住这条（含超长 needle 行为 + 等价表）。
   ⚠️ 语义与旧实现**逐字等价**（差分对拍过，见 ⑪ 的等价表）：
     · needle 里连续 n 个空格 ⇒ 原文那里要有 **≥ n 个空白**（n 个空白类正则是「≥ n 个空白」）；
     · 其余字符一律**字面量**比对（旧实现靠转义达到同样效果）；
     · 找不到返回 **-1**；空 needle 返回 **0**（旧实现 `new RegExp('')` 命中 0）；
     · needle 以空白开头时，匹配位置落在**那段空白的起点**（旧实现同）。 */
function at(t, phrase) {
  const s = String(t), p = String(phrase);
  const isWs = c => c !== undefined && c !== '' && /\s/.test(c);
  /* 把 needle 拆成交替的「空白要求 / 字面段」（可能以空白开头 / 结尾） */
  const parts = [];
  for (let i = 0; i < p.length;) {
    const ws = p[i] === ' ';
    let j = i;
    while (j < p.length && (p[j] === ' ') === ws) j++;
    parts.push(ws ? { ws: j - i } : { text: p.slice(i, j) });
    i = j;
  }
  if (!parts.length) return 0;
  /* 从 q 起能不能**整段**对上：空白段要求「至少 n 个」，字面段必须紧接在空白段之后 */
  const matchAt = q => {
    for (let k = 0; k < parts.length; k++) {
      const pt = parts[k];
      if (pt.ws !== undefined) {
        let n = 0;
        while (q + n < s.length && isWs(s[q + n])) n++;
        if (n < pt.ws) return false;
        q += n;
      } else {
        if (!s.startsWith(pt.text, q)) return false;
        q += pt.text.length;
      }
    }
    return true;
  };
  if (parts[0].ws !== undefined) {          // needle 以空白开头 ⇒ 位置落在空白段起点
    for (let i = 0; i < s.length; i++) {
      if (!isWs(s[i]) || (i > 0 && isWs(s[i - 1]))) continue;   // 只在空白段的**起点**试
      if (matchAt(i)) return i;
    }
    return -1;
  }
  let from = 0;                             // 左起第一个字面段的位置逐个试（indexOf 递增 ⇒ 首个命中即最左）
  while (from <= s.length) {
    const i = s.indexOf(parts[0].text, from);
    if (i < 0) return -1;
    if (matchAt(i)) return i;
    from = i + 1;
  }
  return -1;
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
/* 从「开括号」起按**括号配平**找它的配对闭括号，返回闭括号**之后**的偏移（找不到返回 -1）。
   只认 `{` / `[` / `(` 三种；字符串 / 模板串 / 注释里的括号一律跳过（只数真正的代码括号）。
   为什么需要它（Q38，2026-10-09）—— 用「某字符的**首次出现**」当块尾会**静默**截断 / 越界：
     · `txt.indexOf('};')`：返回的对象里写 `function () { return {}; }`（里面的 `};`）就提前收；
     · `mainSrc.indexOf('});')`：回调里调一次 `Hud.toast({ ... });`（`});`）就提前收；
     · `indexOf('\n}')` / `search(/\nVIEWS\.x =/)`：被嵌套结构提前命中，或（该段是本文件最后一段时）
       一路切到文件尾 —— 段尾彻底错，**但文本照样拿得出来**，判据于是被喂饱。
   ⚠️ 它只管「开括号 → 配对闭括号」这一种结构。找「当前行的行尾」「某个唯一标记的偏移」
      属于**位置**语义（`bodyOf()` 里那个 `indexOf('\n')`、`at()` 自身），不归它管、也别硬套。 */
function closeOf(src, openAt) {
  const s = String(src);
  const open = s[openAt];
  const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openAt; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === c) break;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return i + 1; }
  }
  return -1;
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

/* 从模块里取出「顶层 return 的导出块」。两种写法都认：
     `return { ... };`（多数模块）与 `var API = { ... }; return API;`（audio.js）
   ⚠️ 2026-10-09 提到顶层共用（原来写在第 32 节内部）：第 ㊻ 节也要读导出面
      （反作弊的 L1 白名单），各抄一份必然分家（规范 §9.1 第 1 条）。 */
function exportKeys(txt) {
  let m = [...txt.matchAll(/^  return \{/gm)];
  let open = -1;
  if (m.length) open = m[m.length - 1].index + '  return {'.length - 1;
  else {
    m = [...txt.matchAll(/^  var API = \{/gm)];
    if (m.length) open = m[m.length - 1].index + '  var API = {'.length - 1;
  }
  if (open < 0) return [];
  /* 段尾走**括号配平**（Q38）：原来找 `'}' + ';'` 的首次出现 —— 返回的对象里只要写
     `function () { return {}; }` 之类，里面的 `};` 就会提前命中，导出键清单被截断，
   「死导出」网于是**少看一段**（静默假通过）。 */
  const end = closeOf(txt, open);
  if (end < 0) return [];
  const block = txt.slice(open + 1, end - 1);
  const keys = [];
  (block.match(/(^|[\s{,])([A-Za-z_$][\w$]*)\s*:/g) || []).forEach(s => {
    const k = s.replace(/^[\s{,]+/, '').replace(/\s*:$/, '');
    if (keys.indexOf(k) < 0) keys.push(k);
  });
  return keys;
}

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
  'U', 'Platform', 'Audio', 'Loot', 'State', 'Goals', 'FishArt', 'CardArt', 'Scene', 'Fight', 'Weather', 'Track',
  'Fishing', 'Assistant', 'Story', 'Panels', 'Hud', 'Tutorial'];
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
  /* 🔴 2026-10-10 补：**最后一行必须就是当前版本** ——
     原判据只盯标题与递增，于是「升了版本却没补行」照样全绿。
     实测代价：自 v0.5.7 起攒了 8 个方向没进表（N1/N2/N3-1/N6/N7/N10/音频/图鉴卡面），
     直到用户拍板「补行并正式升 v0.6.0」才发现。**「表里有这版」这件事必须有人盯。 */
  if (rows.length && headM) {
    const last = rows[rows.length - 1];
    const cur = CFG.version.split('.').map(Number);
    if (last[0] !== cur[0] || last[1] !== cur[1] || last[2] !== cur[2]) {
      err(`GDD 版本历史的**最后一行是 v${last.join('.')}**，而当前版本是 v${CFG.version}`
        + ' —— 升了版本就必须补一行（否则「这一版做了什么」永远查不到）');
      entryBad++;
    }
  }
  if (!bad && rows.length >= 5) ok(`GDD 版本历史表 ${rows.length} 行按版本号递增、末行 = 当前版本 v${CFG.version}，标题对齐`);
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

/* 11-i 文档里的「原本 N 个网络请求」必须能现算出来
   同一句里还写着「产物 ≈ 601 KB / 1 个网络请求（原本 29 个）」——
   而「29」= index.html 自身 + `<script src>` 数 + `<link stylesheet>` 数，
   **每加一个模块就多一个请求**。⑪-h 只盯了 KB，这个数字一直没人管：
   N3-1 加了 cardart.js 就从 27 漂成 29，是靠人肉发现才改的。
   判据同样只认「原本 N 个」这种写法，且**抓不到就报错**（口径删了要显式改这里）。 */
const realReq = 1 + listed.length + cssListed.length;   // 1 = index.html 自身
let reqClaimCount = 0;
['docs/GDD.md', 'docs/开发者文档.md', 'README.md'].forEach(function (file) {
  /* ⚠️ 判据必须**同行**同时出现「网络请求」与「原本 N 个」——
     第一版只认「原本 N 个」，反向验证当场发现：文档里写一句「本节原本 3 个分组」
     也会被它当成对外承诺而报红（匹配条件写宽了 = 假报）。
     口径与 34-b 一致（那条也是「同一行里既有 A 又有 B」）。 */
  fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach(function (line) {
    if (!/网络请求/.test(line)) return;
    const m = line.match(/原本\s*(\d+)\s*个/);
    if (!m) return;
    reqClaimCount++;
    const claimed = +m[1];
    if (claimed !== realReq) {
      err(`${file} 里写着「原本 ${claimed} 个」网络请求，而 index.html 现在有 `
        + `${listed.length} 个脚本 + ${cssListed.length} 个样式表 + 自身 = ${realReq} 个请求`);
      entryBad++;
    }
  });
});
if (!reqClaimCount) { err('三份对外文档里都找不到「原本 N 个网络请求」（改了措辞就来更新这条断言）'); entryBad++; }

if (!entryBad) {
  ok(`入口 ${listed.length} 个脚本 == src/ 下 ${onDisk.length} 个模块，顺序正确`);
  ok(`按 index.html 顺序加载：${ranCount} 个模块在 Node 里跑通` +
     (deferred.length ? `（${deferred.length} 个需要 DOM，跳过执行：${deferred.join('、')}）` : ''));
  ok(`${WANT.length} 个全局模块齐全（G.CONFIG … G.Tutorial）`);
  ok(`文档里的请求数现算相符：index.html ${listed.length} 个脚本 + ${cssListed.length} 个样式表 + 自身 = ${realReq} 个`);
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
  /* 回调块的段尾走**括号配平**（Q38）：原来找 `'})'+';'` 的首次出现 ——
     回调里只要调一次 `Hud.toast({ ... });` 就会在那里提前截断（`});`），
     而截断后的文本照样能喂饱下面两条判据（漏掉后面的状态白名单 = 静默假通过）。 */
  const cbOpen = mainSrc.indexOf('{', sceneAt);
  const cbEnd = cbOpen < 0 ? -1 : closeOf(mainSrc, cbOpen);
  if (cbEnd < 0) {
    err('main.js 的画布按下回调块切不出配对闭括号 —— 本节按括号配平切（Q38），'
      + '写法改过就要跟着改这一节（不然下面两条判据会被一段空文本喂饱）');
    inputBad++;
  } else {
    const body = mainSrc.slice(sceneAt, cbEnd);
    if (!/handlePress\(\)/.test(body)) { err('画布按下回调没有调用 handlePress()'); inputBad++; }
    if (/getState\(\)|\bst\s*===\s*'/.test(body)) {
      err('画布按下回调里仍按 state 白名单过滤 —— 漏一个状态就是「按住不收线」，应直接透传 handlePress()');
      inputBad++;
    }
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

  /* 鱼必须走离屏精灵（tankSprite），不许在每帧循环里直接 FishArt.draw：
     drawTank 传给它的 `t` 是常量 0.8 ⇒ 每条鱼形状完全静态，
     逐条重画是同一张图每秒重画 60 遍（实测满仓 24 条 ≈ 42.5ms/秒）。 */
  const fishDraws = (drawTankBody.match(/G\.FishArt\.draw\s*\(/g) || []).length;
  if (fishDraws) {
    err(`drawTank 里直接调了 G.FishArt.draw() ${fishDraws} 处 —— 每帧逐条重画静态的鱼` +
        '（改成 tankSprite() 的离屏精灵，首帧画一次、之后 drawImage）');
    tankGradBad++;
  } else if (!/tankSprite\s*\(/.test(drawTankBody)) {
    err('drawTank 里既没有 FishArt.draw 也没走 tankSprite() —— 鱼是怎么画出来的？');
    tankGradBad++;
  } else if (!/function tankSprite\s*\(/.test(panelsSrcG) ||
             !/tankSprites\s*=\s*\{\}/.test(panelsSrcG)) {
    err('找不到 tankSprite() 定义或 tankSprites = {} 的清空语句 —— 精灵缓存不完整' +
        '（close() 必须清，否则 dpr 换了还在用旧精度的图）');
    tankGradBad++;
  } else {
    ok('水族箱的鱼走 tankSprite() 离屏精灵（每帧 0 次 FishArt.draw），close() 会清缓存');
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

/* ---- [19-b] 结算卡待决时底栏只禁左半（`#btnAction` 保持可用）----
   由来（Q23）：`.catch-card` 是**居中卡片**、**不盖底栏**（实测：待决时 `elementFromPoint`
   在槽位中心命中的就是槽位本身），所以结算卡弹出时三个槽位仍然可点 —— 点一下真的会
   **在结算卡上面**再叠一个面板（`z-index` card 60 > modal 50，两层叠着谁都不完整）。
   拍板口径（2026-10-10 用户）：**只把槽位 + 挂机开关变灰**（`#app.catch-open #deck .deck-left`），
   `#btnAction` **保持可用**（`main.js` 的 `handlePress()` 里 `P.isCatchOpen()` 那一支：
   点它 = `dismissCatch()` = 收下），**禁掉就改了手感**；结算卡**不加**遮罩。
   本节钉三件事（行为侧的「挂 / 摘对称」由 `test.js` 的 catch-open 一节兜住）：
     ① 禁用**外观**只有一处声明（与面板那条共用同一段），且带 `pointer-events:none`
        —— 少了它只是「看起来灰」，槽位其实仍可点（口径要显式，见第 ⑲ 节同款理由）；
     ② `catch-open` 只许**限定到 `.deck-left`** —— 冒出「把整条 `#deck` 禁掉」的规则就报红
        （那样抛竿键也点不动了，与口径正好相反）；
     ③ `panels.js` 的 `showCatch()` / `hideCatch()` 必须分别挂上 / 摘掉**同一个**类，
        且那个词与样式里那个逐字相同（类名单源）。
   ⚠️ 判据都先剥注释再判（硬规矩 ①）：否则本段说明里写的 `catch-open` 会把断言喂饱。 */
console.log('\n[19-b] 结算卡待决时只禁底栏左半（#btnAction 保持可用）');
let deckBad = 0;
(function () {
  const CSS = fs.readFileSync(path.join(ROOT, 'assets/css/style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /* 剥掉注释后逐块取「选择器 { 声明 }」（只取最内层块；本项目没有 @media 里再套选择器的写法） */
  const one = s => s.replace(/\s+/g, ' ').trim();
  const rules = [];
  CSS.replace(/([^{}]+)\{([^{}]*)\}/g, (all, sel, decl) => {
    rules.push({ parts: one(sel).split(',').map(one), decl: one(decl) });
    return all;
  });
  if (!rules.length) { err('第 19-b 节：style.css 一条规则都解析不出来（判据会恒真，先修解析）'); deckBad++; return; }

  /* 面板那条（Q22 的旧规则）——顺带补上它一直没被网盯住的事实。
     ⚠️ 选择器存成变量再 indexOf：含空格的字面量会被第 ㊳ 节当「散文式裸比」拦下。 */
  const PANEL_SEL = '#app.modal-open #deck';
  const panelRule = rules.filter(r => r.parts.indexOf(PANEL_SEL) >= 0)[0] || null;
  /* 结算卡那条：**类名从选择器里现推**，不写死 —— 这样「两端一起改名」是绿的，
     只有「一端改了 / 少了 `.deck-left` 限定」才红（否则断言会拿死字面量卡住合法重构）。 */
  const CATCH_RE = /^#app\.([a-z][\w-]*) #deck \.deck-left$/;
  const catchRule = rules.filter(r => r.parts.some(p => CATCH_RE.test(p)))[0] || null;
  if (!panelRule) {
    err('style.css 里找不到管面板禁用态的 `#app.modal-open #deck` 规则（底栏压暗的基准没了）');
    deckBad++;
  }
  if (!catchRule) {
    err('style.css 里找不到「结算卡待决时只禁 `.deck-left`」的规则 —— '
      + '形状必须是 `#app.<某类名> #deck .deck-left`（少了 `.deck-left` 会连抛竿键一起禁）；'
      + '这也是 Q23 要落地的那条口径');
    deckBad++;
  }
  let cls = '';
  if (catchRule) {
    cls = (catchRule.parts.map(p => (p.match(CATCH_RE) || [])[1]).filter(Boolean)[0]) || '';
    if (!/pointer-events\s*:\s*none/.test(catchRule.decl)) {
      err('结算卡禁用态那条规则丢了 `pointer-events:none` —— 那样只是「看起来灰」，'
        + '槽位其实仍然可点（Q23 要修的正是这个）');
      deckBad++;
    }
    if (panelRule && panelRule.decl !== catchRule.decl) {
      err('面板与结算卡的「禁用外观」声明不一致 —— 同一个观感两份真相，改一处忘一处不会报错；'
        + `\n      面板：\`${panelRule.decl}\`\n      结算卡：\`${catchRule.decl}\``);
      deckBad++;
    }
    /* ② 不许有规则把整条 #deck 在同一个类下禁掉（那会连 #btnAction 一起禁） */
    const WHOLE_NEEDLE = '#app.' + cls + ' #deck';   /* 存成变量再 indexOf：字面量含空格会被第 ㊳ 节拦下 */
    if (rules.some(r => r.parts.indexOf(WHOLE_NEEDLE) >= 0)) {
      err(`style.css 里有 \`${WHOLE_NEEDLE}\`（少了 \`.deck-left\` 限定）—— 它会把 \`#btnAction\` 一起禁掉，`
        + '而口径是「抛竿键保持可用」（点它 = 收下结算卡）');
      deckBad++;
    }
  }
  /* ③ 类名单源：panels.js 的挂 / 摘必须用的正是样式里那个词 */
  const stripC = t => String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const showB = stripC(bodyOf(panelsSrc, 'function showCatch('));
  const hideB = stripC(bodyOf(panelsSrc, 'function hideCatch('));
  if (!showB || !hideB) {
    err('panels.js 里找不到 showCatch() / hideCatch() 的函数体（按缩进切）'); deckBad++;
  } else if (cls) {
    const addNeedle = "classList.add('" + cls + "')";
    const rmNeedle = "classList.remove('" + cls + "')";
    if (showB.indexOf(addNeedle) < 0) {
      err(`showCatch() 没有给 #app 挂 \`${cls}\`（或挂的是别的词）—— 结算卡弹出时底栏左半照旧可点`
        + '（Q23 就是修这个）');
      deckBad++;
    }
    if (hideB.indexOf(rmNeedle) < 0) {
      err(`hideCatch() 没有摘 \`${cls}\`（或摘的是别的词）—— 漏摘一次，底栏左半永久压暗**且永久不可点**`
        + '（玩家只能重开页面）');
      deckBad++;
    }
  }
})();
if (!deckBad) ok('结算卡待决时只禁 .deck-left（含槽位 + 挂机开关）；禁用外观与面板同款、类名从样式现推、与 panels.js 同源');

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
  /* 函数体切片走顶层共用的 `bodyOf()`（按**缩进**终止，不看「下一处 `}` / 下一个 def」）——
     「一个名字只许在两处出现」之外还有一条：**切函数体只许有一种机制**，见第 ㊷ ⑧。 */
  const body = bodyOf(st, 'function ecoValue(');
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
    /* ⚠️ 2026-10-09（N3-1）**本条白名单已按约定删除** —— `Assets.card` 现在被
       `src/render/cardart.js` 真调用（图鉴的回退链），不再是零消费导出。
       历史：它此前是靠 `docs/*.html` 里 CSS 的 `.card{...}` 类选择器混过本节的（Q3 实证）。 */
    /* 定点调试用（按 key 强制天气 / 时段，复现某个环境下的数值），文档 §11 已列。 */
    'src/core/weather.js': ['set'],
  };

  /* 从模块里取出「顶层 return 的导出块」的 `exportKeys()` 已提到**顶层共用**
     （第 ㊻ 节也要读导出面），见文件开头 `closeOf` 附近。 */

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
    /* `story.js` 的 **NPC 表键 = NPC id**（`G.STORY_NPCS` 的 `chen` / `hai` / `chuan`）：
       引擎拿到的是一串 id 字符串，靠 `Object.keys()` + 内容表里的 `spots`（站位表）
       动态挑人（`core/story.js` 的 `idsAt()`）—— 静态扫看不到这层间接，
       与上面那行「按 key 动态取值表的行名」是同一类。
       ⚠️ 这里**不是**放行「随便加个人名」：第 50 节另有两道更硬的闸门 ——
       每个 NPC 必须有**非空站位表**，且必须有**事件或闲聊池**（不然他就是个站着不动的空壳）。 */
    'src/data/story.js': ['chen', 'hai', 'chuan'],
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
      + '（白名单只留 2 类：按 key 动态取值表的行名 —— 稀有度档 / NPC 表行名，理由见代码注释）');
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
    /* 段的终点 = blank() 的**函数体**，按缩进切、走顶层 `bodyOf()`（Q38）。
       原来找「换行 + 4 个空格 + `};`」的首次出现：缩进写死 4 个空格，文件一重排 /
       换个缩进就切歪；而切歪之后 `v:` 那行**照样认得出来** ⇒ 顶层键清单静默多收 / 少收
       （多收的键会被当成「零消费」误报，少收的键则整条网看不见）。 */
    blankSrc = bodyOf(stSrc, 'function blank(');
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
    /* 段的终点 = 这个**对象字面量的配对闭括号**（Q38）。原来找「下一个 `VIEWS.<名> =`」：
       该 view 若是本文件最后一段，段尾会一路切到文件尾（把后面所有 view 都算进来 ⇒
       任何一处 `settings.<键>` 都能喂饱下面的检查）；段内若嵌套了 `VIEWS.x =` 又会提前收。
       ⚠️ 段内不含最外层那对花括号 —— 测的是「段内出现 `settings.<键>`」，与括号无关。 */
    const sOpen = pSrc.indexOf('{', setAt);
    const sEnd = sOpen < 0 ? -1 : closeOf(pSrc, sOpen);
    block = sEnd < 0 ? '' : pSrc.slice(sOpen + 1, sEnd - 1);
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


/* ---------------- 32-i. 陪伴助手的台词表：每个场景键都要被核心取用 ----------------
   由来（2026-10-09，N6）：台词表（`src/data/assistant.js`）是**新长出来的一类数据文件** ——
   它的键不是「字段」而是「场景」，而场景键有两个独立的失效方向：
     ① **加了键却没接线** —— 台词写得再漂亮，`core/assistant.js` 里没人 `say('新键')`
        ⇒ 一句永远没人听见的台词（32-g 拦不住：它只要求「别处出现过一次」，
        而这个键只要出现在 config 的 `speakKeys` 里就算「有消费方」了）。
     ② **数组是空的 / 有空白条目** —— 表现是「触发了，但什么都没说」，同样不报错。
   判据（三条，抓不到就报错）：
     ① 键集**现算**（从真实加载进沙箱的 `G.ASSISTANT_LINES` 取），空集 ⇒ 报红；
     ② 每个键必须**真的出现在 `say('<键>')` 的实参位置**（整词，`legendaryX` 不算）；
     ③ 每个键的值必须是「非空数组 + 每项都是非空字符串」；
     ④ `CFG.assistant.speakKeys` 必须是键集的**子集**（点名了不存在或写错的场景键 ⇒ 报红）。
   🔴 判据 ② 在 2026-10-09（N6 二期）**收紧过一次**：上一版只要求「键这个词在 core 里
   出现过一次」，于是**语气表**（`TONE`）成了合法掩体 —— 一个键只要被写进 `TONE`，
   哪怕从来没人 `say()` 它，判据照样绿，而那正是「台词写了但永远没人说」的坏法。
   ⇒ 现在只认 `say('键')` 这个形态（`TONE` 之类的「提过一嘴」不再算数）。
   为什么不用 32-g 代劳：两网的判据方向不同 —— 32-g 问「这个键有没有人提过」，
   本节点问「**核心到底说不说它**」，后者才是「台词能不能被听见」的充要条件。 */
console.log('\n[32-i] 陪伴助手的台词表：场景键必须被核心取用、数组不许空');
(function () {
  const AP = sandbox.G && sandbox.G.ASSISTANT_LINES;
  const ACCFG = sandbox.G && sandbox.G.CONFIG && sandbox.G.CONFIG.assistant;
  const CORE = 'src/core/assistant.js';
  if (!AP || typeof AP !== 'object') {
    err('沙箱里没有 G.ASSISTANT_LINES —— 台词表没被 index.html 加载，或挂载名改了（本节必须跟着改）');
    return;
  }
  if (!ACCFG || !Array.isArray(ACCFG.speakKeys)) {
    err('CFG.assistant.speakKeys 不是数组 —— 节目的 ④ 无从判定（不许当成「没有要检查的」而空过）');
    return;
  }
  const keys = Object.keys(AP);
  if (!keys.length) {
    err('台词表里一个场景键都没有（空集会让下面所有判据恒真）—— 台词被搬走 / 改名了？');
    return;
  }
  /* 判据：`say('<键>')`（单双引号都认）。**不看 `say(变量)`** —— 那是分析不了的形态，
     真出现时本节会报红，逼着人把键写实（本项目的门禁一贯宁可报红也不放过）。
     ⚠️ 这里必须拆成「**先造正则**（`callRe(k)`）→ 再 `test(文本)`」两步：
        上一版写成 `called(k)` 直接把 `core` 焊死在闭包里，自检里就变成
        「拿样本当键去匹配 core」—— 自检永远报红（当场就栽了一次，别退回去）。 */
  const callRe = k => new RegExp("(^|[^A-Za-z0-9_$])say\\s*\\(\\s*(['\"])" + k.replace(/\$/g, '\\$') + '\\2');
  const core = fs.readFileSync(path.join(ROOT, CORE), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 判据自检：**认得出真调用**，且**拒收**三种「提过一嘴但没调用」的伪形态
     （只多带一截的名字 / 变量 / 别的表里的同名键）—— 少了后半截，
     收紧判据就只是换了句报错文案（第 6 条硬规矩：守卫必须能被样本证明它在起作用）。 */
  const SELF_OK = ["  return say('zzz');", 'say("zzz", true);', "if (x) return say(\n  'zzz');"];
  const SELF_BAD = ['var zzz = 1;', "return say('zzzMore');", 'var TONE = { zzz: 1 };', 'return say(zzz);'];
  const selfRe = callRe('zzz');
  if (!SELF_OK.every(s => selfRe.test(s)) || SELF_BAD.some(s => selfRe.test(s))) {
    err('32-i 的取值判据自检失败：它认不出 `say("键")`，或把「只在别处提过一次」当成了取用');
    return;
  }
  const unbound = keys.filter(k => !callRe(k).test(core));
  if (unbound.length) {
    err('这些场景键在 ' + CORE + ' 里没有出现在 `say(\'键\')` 调用里（台词写了但没人会说，'
      + '或者只被写进语气表 / 注释：那不等于会被念到）：' + unbound.join('、'));
  }
  const badShape = keys.filter(k => {
    const t = AP[k];
    return !Array.isArray(t) || !t.length
      || t.some(s => typeof s !== 'string' || !s.trim());
  });
  if (badShape.length) {
    err('这些场景键的台词不是「非空数组 + 每项都是非空字符串」：' + badShape.join('、'));
  }
  const stray = ACCFG.speakKeys.filter(k => keys.indexOf(k) < 0);
  if (stray.length) {
    err('CFG.assistant.speakKeys 点名了台词表里没有的场景键：' + stray.join('、')
      + '（拼错 / 删了台词忘了改名单 ⇒ 那个场景永远不出声，而且不报任何错）');
  }
  if (!unbound.length && !badShape.length && !stray.length) {
    ok(`台词表 ${keys.length} 个场景键都出现在 ${CORE} 的 say() 调用里、台词都非空；`
      + `出声名单 ${ACCFG.speakKeys.length} 个键全部命中（键集与名单都是现算的）`);
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
    /* 🔴 2026-10-09：原先的 `/\d+\s*种?体型/` 会把**章节号**读成体型数 ——
       `### 17.16 体型表补 3 种…` → 「16 体型」、`### 17.14 体型专属措辞` → 「14 体型」，
       一天里连报两次红。加个负向后顾把 `NN.N` 排掉。
       ⚠️ 判据自检在下面（坏样本必抓、好样本必放过）——**改这条正则就要连它一起看**。 */
    const SHAPE_N = /(?<![.\d])\d+\s*种?体型/g;
    /* 判据自检：坏样本（章节号）必须 0 命中、好样本（真体型数）必须 1 命中。
       ⚠️ 不要用裸 `indexOf` 判「含不含」—— 第 ㊳ 节会抓（折行会误伤）。 */
    const SELF_BAD = ['### 17.16 体型表补 3 种', '### 17.14 体型专属措辞'];
    const SELF_GOOD = 'v0.5.4 的 9 种体型';
    if (SELF_BAD.some(s => (s.match(SHAPE_N) || []).length) || (SELF_GOOD.match(SHAPE_N) || []).length !== 1) {
      err('§33 ① 的体型数正则自检不成立：章节号应被排掉、真体型数应命中 —— 改正则必须同步这条');
      shapeBad++;
    }
    (txt.match(SHAPE_N) || []).forEach(hit => {
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

  /* ③ 🔴 2026-10-09 加：**还有两份「体型清单」会跟着漂，而且都不报错** ——
     ① `docs/画风与颜色标准.md` §7.3「三十七种体型句」表：加一个体型就得加一行，
        原先只有 prose 里的数字被现算比对，**表格行本身没人管**；
     ② `docs/图鉴文案.md` 每条鱼的标题里带 `（稀有度 · shape）` —— 改 `fish.js` 的 shape
        而不重跑 `tools/gen-captions.py`，那张表就静默留着旧键
        （本次实测：D08/S19/S20/S21/S22 五条全留着 `squid/jelly/eel`）。
     ⚠️ 两份都按**现算**比对，不写死任何键名。 */
  const stdTxt = fs.readFileSync(path.join(ROOT, 'docs/画风与颜色标准.md'), 'utf8');
  const stdSec = (stdTxt.match(/### 7\.3[\s\S]*?(?=\n### |\n## )/) || [''])[0];
  const uq = a => a.filter((x, i) => a.indexOf(x) === i);
  const stdKeys = uq((stdSec.match(/^\|\s*([a-z_]+)\s*\|/gm) || [])
    .map(s => s.replace(/[|\s]/g, '')));
  const missStd = shapes.filter(s => stdKeys.indexOf(s) < 0);
  if (!stdKeys.length) {
    err('读不到「画风与颜色标准 §7.3 体型句表」的键列 —— 表被改名/改格式了？'); shapeBad++;
  } else if (missStd.length) {
    err(`docs/画风与颜色标准.md §7.3「三十七种体型句」表漏了 ${missStd.length} 种体型：${missStd.join(' / ')}`
      + ' —— 它是对外说「这 12 种体型长什么样」的表，缺行 = 标准参考图会漏做');
    shapeBad++;
  }
  const capTxt = fs.readFileSync(path.join(ROOT, 'docs/图鉴文案.md'), 'utf8');
  const capRows = capTxt.match(/^##\s+([A-Z]+\d+)\s+[^（]*（[^·]+·\s*([a-z_]+)）/gm) || [];
  const capBad = [];
  capRows.forEach(line => {
    const m = /^##\s+([A-Z]+\d+)\s+[^（]*（[^·]+·\s*([a-z_]+)）/.exec(line);
    const f = G.FISH_ID[m[1]];
    if (f && f.shape !== m[2]) capBad.push(`${m[1]} 文案写 ${m[2]} / 数据是 ${f.shape}`);
  });
  if (capRows.length < G.FISH.length * 0.95) {
    err(`docs/图鉴文案.md 只认出 ${capRows.length} 行带体型标签的标题（应有 ${G.FISH.length} 条）`
      + ' —— 标题格式改了就同步这条正则，别让它恒真');
    shapeBad++;
  } else if (capBad.length) {
    err(`docs/图鉴文案.md 的体型标签与 fish.js 不一致（${capBad.length} 条）：${capBad.slice(0, 8).join('；')}`
      + ' —— 改 shape 之后忘了重跑 `python tools/gen-captions.py`');
    shapeBad++;
  }
  /* ④ 🔴 2026-10-10 用户口径：「我希望同一个体型的生物最好不要超过 20 个」。
     为什么要有这条：体型一旦超过 20，图鉴按体型筛出来的那一屏就跟没分一样
     （拆之前 `fish` 一个键压着 185 条 = 全鱼表 51%），而这**不会**触发任何现有判据。
     ⚠️ 口径是「最好**不要**」⇒ 这里是 `warn` 不是 `err`：真超了由人来决定
        「改派到别的体型」还是「再拆一个新的」，门禁不该替人拍这个板。 */
  const over = Object.keys(G.FISH.reduce((a, f) => (a[f.shape] = (a[f.shape] || 0) + 1, a), {}))
    .filter(k => G.FISH.filter(f => f.shape === k).length > 20)
    .map(k => `${k}=${G.FISH.filter(f => f.shape === k).length}`);
  if (over.length) {
    warn(`有 ${over.length} 个体型超过 20 条（${over.join('、')}）—— 用户口径是`
      + '「同一个体型最好不要超过 20 个」：要么把其中几条改派到别的体型，'
      + '要么再拆一个新体型（改法见 `tools/gen-fish.py` 的 FIELD_FISH 表第三列）');
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
  /* 函数体切片走 bodyOf()：原来那句是「从 `def build_morph_prompt` 切到**下一个 def**」，
     会把紧随其后的模块常量（`MORPH_SCOPE`）也算进来 —— 范围偏大 ⇒ 判据可能被无关文本喂饱。 */
  const fn = bodyOf(src, 'def build_morph_prompt(');
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

  /* ⑤ 🔴 体型专属措辞必须**处处按体型分流**（2026-10-09 用户报障：水母的五档彩色卡被画成鱼）。
     病根是 5 处公共段写成了鱼的解剖、却对所有体型无条件生效：
       构图句 `facing left` / 颜色句部件词 `fins` / 明暗句 `belly + back` /
       `LIGHT` 的 `back and tail` / `MORPH_SCOPE` 的 `the whole fish … the fins`（只有五档有 ⇒ 母版侥幸没跑偏）。
     ⚠️ 这几处**改错了不报错、只是图变样**（一屏水母全变成鱼也没人会看到红字），
        所以这里逐个盯「消费点真的走了按体型分流的那条路」，而不是只盯常量有没有定义。 */
  if (!/^SHAPE_WORDS\s*=\s*\{/m.test(src)) {
    err('gen-art.py 里没有 `SHAPE_WORDS` —— 体型专属措辞表不见了，公共段会退回写死鱼类解剖'); return;
  }
  const shapeBlock = (src.match(/^SHAPE_WORDS\s*=\s*\{[\s\S]*?\n\}/m) || [''])[0];
  const knownShapes = (src.match(/^SHAPES\s*=\s*\{[\s\S]*?\n\}/m) || [''])[0];
  const realShapes = (knownShapes.match(/^\s{4}"([a-z]+)":\s*\{/gm) || [])
    .map(x => x.replace(/[\s":{]/g, ''));
  const declared = (shapeBlock.match(/^\s{4}"([a-z]+)":\s*\{/gm) || [])
    .map(x => x.replace(/[\s":{]/g, ''));
  if (!declared.length) { err('读不到 SHAPE_WORDS 的体型键'); return; }
  const ghost = declared.filter(s => realShapes.indexOf(s) < 0);
  if (ghost.length) {
    err(`SHAPE_WORDS 里有不存在的体型：${ghost.join('、')}（真实体型：${realShapes.join('/')}）`
      + ' —— 体型名打错 = 覆写永远读不到，那条鱼照旧收到鱼类措辞'); return;
  }
  /* ⑤a 默认占位符必须还是**改动前那几句话** —— 它们就是「301 条鱼族的卡逐字不变」的保证 */
  const DEF = (src.match(/^COLOR_TOKEN_DEFAULTS\s*=\s*\{[^}]*\}/m) || [''])[0];
  const WANT_DEF = { part: 'fins', partsg: 'fin', sides: 'flanks', head: 'head',
                     under: 'belly', over: 'back', surface: 'scales' };
  const defBad = Object.keys(WANT_DEF).filter(k => !new RegExp(`"${k}":\\s*"${WANT_DEF[k]}"`).test(DEF));
  if (defBad.length) {
    err(`COLOR_TOKEN_DEFAULTS 里 ${defBad.join('、')} 不再是原值 —— 默认体型（fish 等 301 条）的`
      + '提示词会跟着变，已出的卡会全部被判成过期'); return;
  }
  /* ⑤b 六个消费点必须走「按体型 / 物种」的那条路（写死常量就会在这里被抓住） */
  const NEED = [
    ['def palette_color(', 'color_tokens(', '颜色句部件词'],
    ['def build_prompt(', 'light_for(', 'LIGHT 锚点'],
    ['def build_prompt(', 'shape_word(f, "frame"', '构图句朝向'],
    ['def build_prompt(', 'shade_for(morph, f', '明暗句'],
    ['def build_morph_prompt(', 'scope_for(', '五档收尾从句'],
    ['def build_morph_prompt(', 'fill_color_tokens(', '颜色句占位符'],
  ];
  const nt = NEED.filter(([d, w]) => !has(bodyOf(src, d), w))
    .map(([d, , label]) => `${label}（${d}里缺 ${w}）`);
  if (nt.length) {
    err('这些公共段没有走「按体型 / 物种」的分流：' + nt.join('；')
      + ' —— 写死常量对非鱼类型就是错的解剖（水母被要求长 fins，实测彩图变鱼）'); return;
  }
  /* ⑤b2 **物种层**（`SPECIES_WORDS`，按鱼 id）—— `shape` 只是几何模板，
     甲壳类 / 海参类 / 棘皮 / 环节会被兜底到「最接近但不同类」的体型上，
     光换体型层的词救不回来（小龙虾拿到「arms」、海猪拿到「tentacles」、海蛇尾拿到「fins」）。
     ⚠️ 这里能拿到 G.FISH，所以**逐个 id 核对它真是一条鱼** ——
        gen-art.py 的加载期自检只查得到 id 的格式，查不到「这条鱼在不在表里」。 */
  if (!/^SPECIES_WORDS\s*=\s*\{/m.test(src)) {
    err('gen-art.py 里没有 `SPECIES_WORDS` —— 体型兜底的那几条非鱼类又会拿到不属于自己的部件词'); return;
  }
  const spBlock = (src.match(/^SPECIES_WORDS\s*=\s*\{[\s\S]*?\n\}/m) || [''])[0];
  const spIds = (spBlock.match(/^\s{4}"([A-Z]+\d+)":\s*\{/gm) || [])
    .map(x => x.replace(/[\s":{]/g, ''));
  if (!spIds.length) { err('读不到 SPECIES_WORDS 的鱼 id'); return; }
  const allIds = {};
  G.FISH.forEach(f => { allIds[f.id] = f; });
  const ghostIds = spIds.filter(i => !allIds[i]);
  if (ghostIds.length) {
    err(`SPECIES_WORDS 里有不存在的鱼 id：${ghostIds.join('、')}`
      + ' —— id 打错 = 覆写永远读不到，那条鱼照旧收到不属于自己的部件词'); return;
  }
  /* ⑤b3 物种层只许落在**非鱼形家族**的兜底条目上 —— 往鱼身上加物种覆写会让
     「鱼族逐字不变」这条保证悄悄失效（图上什么都看不出来）。
     🔴 2026-10-10：判据从「`shape === 'fish'`」改成「在 `FISH_SHAPES` 里」——
        通用鱼形拆成 20 个体型之后，写单键会让这条判据**只看得到 1/20 的鱼**
        （旧写法：把覆写加到「鲤形」的鱼上照样全绿）。集合从 gen-art.py **现算**。 */
  const fishShapes = ((src.match(/^FISH_SHAPES = \(([\s\S]*?)\)/m) || [, ''])[1].match(/"([a-z_]+)"/g) || [])
    .map(s => s.slice(1, -1));
  if (fishShapes.length < 10) {
    err(`读不到 gen-art.py 的 \`FISH_SHAPES\`（实得 ${fishShapes.length} 个）—— `
      + '空集会让下面这条判据恒真，所以直接报错；改了写法就来更新本断言'); return;
  }
  const onFish = spIds.filter(i => fishShapes.indexOf(allIds[i].shape) >= 0);
  if (onFish.length) {
    err(`SPECIES_WORDS 覆盖了鱼形家族的条目：${onFish.join('、')}`
      + ' —— 物种层的用途是救「体型兜底救不回的非鱼类」，加到鱼身上只会让口径漂、且不报错'); return;
  }
  /* ⑤c 自检必须真被调用（「记得手动跑一下」在本项目反复栽跟头） */
  if (!/def check_shape_words\(/.test(src) || !/^check_shape_words\(\)\s*$/m.test(src)) {
    err('check_shape_words() 没定义或**没在模块加载时被调用** —— '
      + '占位符打错 / 不存在的体型名 / 没人替换的 `{xxx}` 会静默写进提示词'); return;
  }
  /* ⑤c2 🔴 2026-10-10：**不许再按单键 `== "fish"` 判体型**。
     通用鱼形拆成 20 个体型之后，任何一处 `shape == "fish"` 都会让 180 条鱼的门禁
     （比例句 / 名字族 / 花纹族 / 特征位 / 背棘 / 躯干）**静默失效** ——
     提示词只是「短了一句」，出图照跑、图鉴照显示。
     判据：gen-art.py 的可执行代码里（注释已剥）`== "fish"` / `!= "fish"` 必须 0 处；
     改用集合 `FISH_SHAPES`。 */
  const liveFish = (src.match(/(?:==|!=)\s*"fish"/g) || []).length;
  if (liveFish) {
    err(`gen-art.py 里有 ${liveFish} 处按单键比较体型（\`== "fish"\` / \`!= "fish"\`）——`
      + '改成 `in FISH_SHAPES`（见 `FISH_SHAPES` 的注释：写单键会让 180 条鱼的门禁静默失效）');
    return;
  }
  if (!/^FISH_SHAPES = \(/m.test(src) || !/shape(?:\(\))? .{0,30}in FISH_SHAPES|in FISH_SHAPES/.test(src)) {
    err('gen-art.py 里没有 `FISH_SHAPES` 这张集合表（或定义了没人用）—— '
      + '它是「鱼形家族」的唯一真相，加了新体型就该往它里面放');
    return;
  }
  /* ⑤d 传说级点题只许挂在 `rar == 3` 上，且只许有一处调用 */
  const motHits = (src.match(/fantasy_motif/g) || []).length;
  const bpBody = bodyOf(src, 'def build_prompt(');
  const iGuard = idx(bpBody, 'if rar_i == 3:');
  const iCall = idx(bpBody, 'fantasy_motif(');
  if (motHits !== 2 || iGuard < 0 || iCall < 0 || iGuard > iCall) {
    err(`传说点题的接线不对（fantasy_motif 出现 ${motHits} 次，只许 2 次＝定义 + build_prompt 里那一处调用；`
      + '且必须在 `if rar_i == 3:` 之后）—— 给普通鱼加奇幻句 = 362 条卡口径全变、稀有度递进当场作废');
    return;
  }
  /* ⑤e 🔴 体型的形态句 `d` **不许点自己的名**（2026-10-09 补）。
     背景：`SHAPES[shape]["d"]` 只在「没有物种名、也没有查证过的 `form`」时才当主语输出
     （见 `build_prompt` ⓪）。而 362 条**全都有 `form`** ⇒ 现在它一句都不输出，
     所以旧稿里那些 `squid with…` / `jellyfish with…` **看着一点问题都没有** ——
     直到哪天新增一条没有 `form` 的鱼：它会拿这句当主语，
     2026-10-08 那个坑（小龙虾被画成乌贼）**原样复发**。**这就是「潜伏的坑」的定义。**
     ⚠️ 判据只查「点自己的名」（键名 + 别名表 + 词边界），**不查别的动物名** ——
        后者该靠数据（`form`）而不是靠正则，硬查会误伤（"ribbon fish" 对 oarfish 是成立的）。
     ⚠️ 带判据自检：喂一条旧稿式的坏句子必须被抓到。 */
  const ALIAS = { jelly: ['jellyfish', 'jelly'], star: ['starfish', 'star'],
                  ray: ['manta ray', 'ray'] };
  const selfNames = (k, text) => [k].concat(ALIAS[k] || [])
    .some(w => new RegExp('\\b' + w + '\\b').test(text));
  if (!selfNames('squid', 'squid with an elongated mantle') || selfNames('squid', 'a soft muscular mantle')) {
    err('§33-c ⑤e 的判据自检不成立：旧稿式的「squid with…」没被抓到 / 干净句子被误伤'); return;
  }
  const dSelf = realShapes.filter(k => {
    const m = new RegExp('"' + k + '":\\s*\\{"d":\\s*"([^"]*)"').exec(src);
    return !m || selfNames(k, m[1]);
  });
  if (dSelf.length) {
    err(`这些体型的 \`d\` 点了自己的名：${dSelf.join('、')}`
      + ' —— 没有 `form` 的鱼会拿它当主语，等于给模型下物种指令'
      + '（2026-10-08「小龙虾被画成乌贼」就是这条）；改成只描述构造'); return;
  }
  ok(`措辞三层分流（体型层 ${declared.join('/')}、物种层 ${spIds.join('/')}；其余 ${realShapes.filter(s => declared.indexOf(s) < 0).length} `
    + '个体型走默认值）＋ 默认占位符＝原句 ＋ 自检加载即跑 ＋ 传说点题只挂 rar3');
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
  const mediumHits = (src.match(/GEOM_MEDIUM/g) || []).length;
  if (mediumHits !== 2) {
    err(`GEOM_MEDIUM 在代码里出现了 ${mediumHits} 次（只许 2 次：定义 + GEOM_BY_MORPH 引用）`
      + ' —— 多出来的那处可能在运行期把它加到别的档上（那会让「只有黄金档例外」失效）');
    return;
  }
  const coarse = toStr(src.match(/^GEOM_COARSE\s*=\s*\(([\s\S]*?)\)\s*$/m));
  const medium = toStr(src.match(/^GEOM_MEDIUM\s*=\s*\(([\s\S]*?)\)\s*$/m));
  const byMorph = (src.match(/^GEOM_BY_MORPH\s*=\s*(\{[^}]*\})/m) || [])[1] || '';
  if (!coarse) {
    err('闪光档的 `GEOM_COARSE` 不见了 —— 用户口径「闪光档不用很多面的格式」被改掉了');
    return;
  }
  if (!medium) {
    err('黄金档的 `GEOM_MEDIUM` 不见了 —— Q29 定的「黄金档单开一档中间面片措辞」被改回来了');
    return;
  }
  if (/dense triangular polygon mesh|many small|tessellation/.test(coarse)) {
    err('`GEOM_COARSE` 里又出现了「密集 / 碎小」的措辞 —— 那正是闪光档要避免的东西（尾鳍会碎成小像素块）');
    return;
  }
  /* 🔴 例外面的口径（2026-10-10 Q29 改）：**只许 golden 与 shiny 两档**，而且两档必须
     指向**两个不同**的常量 —— 母版与另两档（彩虹 / 白化）继续走 `GEOM`（v9 标定、最贴靶子 3.6）。
     把 `golden` 指回 `GEOM` ⇒ 色块被面片高光切碎（实测 5.16）；把别的档挂上来 ⇒ 报红。 */
  const keys = (byMorph.match(/"([a-z]+)"\s*:/g) || []).map(x => x.replace(/["\s:]/g, ''));
  const want = ['golden', 'shiny'];
  if (keys.length !== want.length || want.some(k => keys.indexOf(k) < 0)) {
    err('`GEOM_BY_MORPH` 的例外只许挂 ' + want.join(' 与 ') + ' 两档，现在挂的是 ' + JSON.stringify(keys)
      + ' —— 母版与另两档（彩虹 / 白化）必须继续用 GEOM（那是 v9 标定过、最贴靶子 3.6 的措辞）');
    return;
  }
  if (!/golden"\s*:\s*GEOM_MEDIUM/.test(byMorph) || !/shiny"\s*:\s*GEOM_COARSE/.test(byMorph)) {
    err('`GEOM_BY_MORPH` 把两档指错了常量：golden 必须指 `GEOM_MEDIUM`（实测 3.68 贴靶子）、'
      + 'shiny 必须指 `GEOM_COARSE`（用户 2026-10-08 的定向例外）');
    return;
  }
  ok('面片措辞的例外在位：闪光档 `GEOM_COARSE`（不含「密集」措辞）+ 黄金档 `GEOM_MEDIUM`（Q29 实测 3.68 贴靶子），'
    + '两档各指各的常量、各只出现两次，母版与另两档仍走 `GEOM`');

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
  /* ⚠️ 原来这一处是「切到下一个 def」+ `: 400` 兜底 —— 实测它把 steps_for() **之后的**
     一批模块常量（MODEL / CFG / BASE / GEOM）一起算了进来（997 字符 vs 函数体 184），
     典型「被后面的人喂饱」；改成 bodyOf() 后范围收到函数体本身（三个 needle 都在体内）。 */
  const sfBody = bodyOf(src, 'def steps_for(');
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
  /* 字典体走**括号配平**（Q38）：原来找「换行 + `}`」的首次出现 —— 池子里若嵌套了
     以行首 `}` 结尾的结构，或 `MORPH_POOL` 的闭括号不在行首，段尾就错；姑且不改写法
     也无从发现。切不出来**必须报错**，不许静默退化成「没有元组要检查」。 */
  const poolOpen = poolStart < 0 ? -1 : src.indexOf('{', poolStart);
  const poolEnd = poolOpen < 0 ? -1 : closeOf(src, poolOpen);
  if (poolEnd < 0) {
    err('MORPH_POOL 的字典体切不出配对闭括号（本节按括号配平切，Q38）—— '
      + 'gen-art.py 的写法改过就要跟着改这一节，不许当成「没有元组要检查」而空过'); return;
  }
  const poolBody = src.slice(poolOpen + 1, poolEnd - 1);
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
  const pickFn = bodyOf(src, 'def morph_pick(');
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
     而它想抓的其实是「句子本身被改了」。折行与内容无关，不该影响判定。
     ⚠️ 2026-10-09：albino 基准句里的 `fins` 现在是 `{part}` 占位符（水母要它变 `tentacles`），
        所以这里比的是**带占位符的形式**。占位符的默认值另有断言（§33-c 的 `COLOR_TOKEN_DEFAULTS`
        ），两边合起来才等价于「默认体型那句没被改」。 */
  const BASE = {
    bright: 'from magenta and orange through yellow and cyan to blue and violet',
    albino: 'pale creamy white body, soft pink translucent {part}, pale pink eye',
    golden: 'rich brass and gold tones, brilliant golden sheen, high luminance',
    shiny: 'star-shaped sparkle highlights, prismatic sheen',
  };
  const miss = Object.keys(BASE).filter(k => !has(src, BASE[k]));
  if (miss.length) {
    err(`基准颜色句被删了或改动了：${miss.join('、')} —— 池子第 0 项引用的就是它们，不许动`);
    return;
  }
  /* ⑤ 按稀有度覆盖池子 / 一档多版（2026-10-08 用户口径：传说档定死；2026-10-10 改为「闪光一律 2 版」）
     🔴 盯「覆盖会被绕过」这一型：只要有人绕过 `pool_for()` 直接读 `MORPH_POOL`，
        传说鱼就照旧轮换出参差 —— 图上看不出来是哪一步漏了，也不报任何错。
     🔴 2026-10-10 追加盯三件事（用户口径：「闪光生成两个版本的，我会选一个最好看的」）：
        · 闪光必须 ≥2 版（`MORPH_VERSIONS`）—— 少了它「两个版本」这条口径当场失效，
          而图**照样出得来**（只出一版），没人会去数；
        · 版数判据只许有 `morph_version_count()` 一处 —— 出图 / 清单排期 / prompt-ab
          各写一遍的话，「清单说 6 张、实际出 7 张」不会报错，只会让工期估计悄悄失真；
        · 挑选用 `tools/pick-card.py`，且它必须**文件与 manifest 一起换** ——
          只换文件会让台账开始描述另一张图（`report_stale()` / 可复现全跟着错）。 */
  if (!/MORPH_POOL_BY_RAR\s*=\s*\{/.test(src) || !/MORPH_VERSIONS_BY_RAR\s*=\s*\{/.test(src)
      || !/MORPH_VERSIONS\s*=\s*\{/.test(src)) {
    err('缺少 MORPH_POOL_BY_RAR / MORPH_VERSIONS / MORPH_VERSIONS_BY_RAR —— '
      + '传说档定死与「闪光出 2 版」没了'); return;
  }
  /* 现算「**传说档**的闪光几版」：口径是「**只有传说档闪光**才需要两档让我选一档」
     （2026-10-10 用户当场更正；中途那版「所有稀有度都 2 版」已废）。
     判据按**解析后的值**算，不写死、也不只看某一张表 ——
     口径写在 `MORPH_VERSIONS_BY_RAR[3]["shiny"]`，通用回退写在 `MORPH_VERSIONS["shiny"]`，
     **两张表里任意一张被删都该报红**（只查一张会漏掉另一半的回归）。 */
  const mvDefault = (/MORPH_VERSIONS\s*=\s*\{([^}]*)\}/.exec(src) || [, ''])[1];
  const mvByRar = (/MORPH_VERSIONS_BY_RAR\s*=\s*\{([\s\S]*?)\n\}/.exec(src) || [, ''])[1];
  const shinyDefault = parseInt((/["']?shiny["']?\s*:\s*(\d+)/.exec(mvDefault) || [, '1'])[1], 10);
  const r3Block = (/\b3\s*:\s*\{([^}]*)\}/.exec(mvByRar) || [, ''])[1];
  const morphVersions = parseInt((/["']?shiny["']?\s*:\s*(\d+)/.exec(r3Block)
    || [, String(shinyDefault)])[1], 10);
  const peFn = bodyOf(src, 'def pool_entries(');
  if (!/pool_for\(/.test(peFn)) {
    err('pool_entries() 没有走 pool_for() —— 按稀有度的覆盖会被**静默绕过**（传说鱼照旧轮换）');
    return;
  }
  /* 多版的后缀：第 1 版必须落在**主文件名**上（否则清单勾选 / check-cards / --skip-existing 全失配） */
  const mvFn = bodyOf(src, 'def morph_versions(');
  if (!/""\s*if\s+i\s*==\s*0/.test(mvFn)) {
    err('morph_versions() 没把第 1 版的后缀留成空串 —— 主文件名会漂，清单/验收/断点续跑的既有口径全部失配');
    return;
  }
  /* ⑤a 版数走唯一判据；判据本身必须两张表都读 */
  if (morphVersions < 2) {
    err(`**传说档**的闪光只有 ${morphVersions} 版 —— 用户口径是`
      + '「只有传说档闪光才需要两档让我选一档」（`MORPH_VERSIONS_BY_RAR[3]["shiny"]`）。'
      + '砍掉它 = 悄悄少一个候选版，而图照样出得来、清单照样打勾');
    return;
  }
  const mvcFn = bodyOf(src, 'def morph_version_count(');
  if (!mvcFn || !/MORPH_VERSIONS_BY_RAR\.get\(/.test(mvcFn) || !/MORPH_VERSIONS\.get\(/.test(mvcFn)) {
    err('`morph_version_count()` 不存在，或没把「按稀有度覆写 / 每档默认」两张表都读上 —— '
      + '它是版数的**唯一判据**，缺一张表就会漏算或错算'); return;
  }
  if (/MORPH_VERSIONS_BY_RAR\.get\(/.test(mvFn)) {
    err('`morph_versions()` 自己去读 `MORPH_VERSIONS_BY_RAR` 了 —— 版数判据必须只有'
      + ' `morph_version_count()` 一处，否则出图与清单会各算一套'); return;
  }
  if (!/morph_version_count\(/.test(mvFn)) {
    err('`morph_versions()` 没有走 `morph_version_count()` —— 出图张数与口径分家了'); return;
  }
  const wpFn = bodyOf(src, 'def write_plan(') || '';
  /* ⚠️ 判据要**切到 `extra_shots = …` 那一条语句**再查，不能只看「函数里出现过
     `morph_version_count(`」—— 同一段代码后面拼文案时还会再引用一次它，
     于是「把版数算回旧表」的坏样本照样绿（本轮反向验证第 ③ 组当场逮到）。 */
  const exStmt = (/extra_shots\s*=[^\n]*(?:\n[ \t]+[^\n]*)*/.exec(wpFn) || [''])[0];
  if (!exStmt || !/morph_version_count\(/.test(exStmt)) {
    err('`write_plan()` 里算「多出来的张数」的那条语句（`extra_shots = …`）没有走 '
      + '`morph_version_count()` —— 清单会**低估工期**，而清单是排期与「还剩多少」的唯一依据');
    return;
  }
  /* ⑤b 挑选用具：文件与 manifest 必须一起换（只换一处不会报错，只会让台账描述另一张图） */
  const pk = path.join(ROOT, 'tools/pick-card.py');
  if (!fs.existsSync(pk)) {
    err('缺 `tools/pick-card.py` —— 闪光两版出完之后没有「把选中那版扶正」的用具，'
      + '手工改名会让 manifest 里的候选记录与盘上的图对不上'); return;
  }
  const pkSrc = fs.readFileSync(pk, 'utf8').replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
  const pair = [['os\\.replace\\(', '真的动了文件'],
                ['sub\\[key1\\], sub\\[key2\\] =', 'manifest 里两个槽位的记录跟着换'],
                ['morphVariant', 'morphVariant 也跟着换']];
  const pkMiss = pair.filter(([re]) => !new RegExp(re).test(pkSrc)).map(([, why]) => why);
  if (pkMiss.length) {
    err(`tools/pick-card.py 缺了：${pkMiss.join('、')} —— 只换文件不换台账 = `
      + '「可复现」与 report_stale() 从此描述另一张图，而且不报错'); return;
  }
  ok('候选总表 + 权重池 + 按稀有度覆盖 + 一档多版齐备；MORPHS 派生、池内只存键与权重；'
    + '覆盖必须走 pool_for()；第 1 版落在主文件名；**传说档闪光 ' + morphVersions + ' 版（唯一判据 '
    + 'morph_version_count，出图/清单/AB 三处共用）**；pick-card 文件与台账一起换；'
    + 'check_pools() 加载即校验；morph_pick 走 md5；四档基准句在册');
})();

/* ---------------- 33-g. 图鉴**手写文案**（`docs/图鉴文案-手写.md`）的口径不许漂 ----------------
   🔴 为什么要有这一节（2026-10-11，W1 收尾）：这份 362 条的文案**不被游戏读取**、
   也不在任何门禁的视野里 —— 它漂开的时候一句报错都没有。而它是对外说
   「这条鱼是怎么活的」的唯一一份逐条文字（将来接进图鉴 / 拿去做别的产物都用它）。
   判据全部**从数据现算**（`fish.js` / `fields.js` / `config.js` / `docs/新物种名册.md`），
   不写死任何鱼名、档位名、条数：
     ① 条数 / 序号 / id：与 `fish.js` 一一对应，序号 1..N 连续；
     ② 表头：每条标题的「名字（钓场 · 最小体重 · 价格）」必须等于现算值 ——
        它由 `_tmp/merge_captions.py` 一次性生成，改完数值没人重算就**永远停在旧数上**；
     ③ 档位：分界**从 `CFG.rarity` 现算**（`epic` 那个下标）——
        普通 / 稀有只写「原色 + 闪光」，史诗 / 传说写全五档（用户口径）；
     ④ 正文不许把**生图提示词**抄进来（用户口径「图鉴文案中不需要有生成图的提示词」）；
     ⑤ 旧物种：`docs/新物种名册.md` 的「原名」列是**已经删掉的真实物种**
        （鲷 / 鲳 / 金枪鱼 / 章鱼 / 鲸 …），W1 把 104 条按新物种重写了 ⇒
        同一条的正文里不许再出现那个旧名，**也不许出现它的末字**（属名）。
        ⚠️ 新名里含末字时跳过（例：`终焉之影·忘川` 的末字「川」在新名里）。
     ⑥ 文末「待重写清单」的勾选状态必须与正文**一致**：勾了 ⇒ 正文认不出旧物种；
        没勾 ⇒ 正文**必须**还认得出旧物种（不然勾选就是个装饰）。
   ⚠️ 这一节**不计数**（名字带字母后缀，㉞ 只数纯数字节号）。
*/
(function () {
  const rel = 'docs/图鉴文案-手写.md';
  const P = path.join(ROOT, rel);
  if (!fs.existsSync(P)) { err(`缺 ${rel} —— 逐条手写文案是「这条鱼怎么活的」唯一一份文字`); return; }
  const txt = fs.readFileSync(P, 'utf8');
  const lines = txt.split('\n');
  const HEAD = /^## (\d+) · ([A-Z]{1,3}\d{2,3}) (.+)（([^（）]*)）\s*$/;

  /* 一趟扫完：标题 + 正文块 */
  const items = [];
  let cur = null;
  lines.forEach(l => {
    const m = HEAD.exec(l);
    if (m) { cur = { no: +m[1], id: m[2], name: m[3], meta: m[4], body: [] }; items.push(cur); }
    else if (cur) cur.body.push(l);
  });
  if (!items.length) { err(`${rel} 一条都没认出（标题格式变了？）—— 以下判据会恒真，先修解析`); return; }
  let bad = 0;

  /* ① 条数 / 序号 / id 一一对应 */
  const fname = {}, fieldOf = {};
  (G.FIELDS || []).forEach(f => { fname[f.id] = f.name; });
  Object.keys(G.FISH_BY_FIELD || {}).forEach(fid => {
    (G.FISH_BY_FIELD[fid] || []).forEach(f => { fieldOf[f.id] = fid; });
  });
  if (!Object.keys(fieldOf).length) { err('拿不到 G.FISH_BY_FIELD —— 33-g 的钓场判据抓不到数据（先修判据本身）'); return; }
  if (items.length !== G.FISH.length) {
    err(`${rel} 有 ${items.length} 条，而 fish.js 有 ${G.FISH.length} 条`); bad++;
  }
  const seqBad = items.filter((h, i) => h.no !== i + 1);
  if (seqBad.length) {
    err(`${rel} 的序号不连续（第 ${seqBad[0].no} 条排在 ${seqBad[0].id} 前面）—— `
      + '合并脚本那次「序号连续」的断言管不住后续的人工编辑'); bad++;
  }
  const cnt = {}; items.forEach(h => { cnt[h.id] = (cnt[h.id] || 0) + 1; });
  const dup = Object.keys(cnt).filter(k => cnt[k] !== 1);
  if (dup.length) { err(`${rel} 有重复 id：${dup.slice(0, 8).join(' / ')}`); bad++; }
  const ghost = items.filter(h => !G.FISH_ID[h.id]).map(h => h.id);
  if (ghost.length) { err(`${rel} 有 fish.js 里不存在的 id：${ghost.slice(0, 8).join(' / ')}`); bad++; }
  const missing = G.FISH.filter(f => !cnt[f.id]).map(f => f.id);
  if (missing.length) { err(`${rel} 漏了 ${missing.length} 条鱼：${missing.slice(0, 8).join(' / ')}`); bad++; }

  /* ② 表头三个数必须现算。体重口径**与 merge_captions.py 同源**：
      <1kg → g、<1000kg → kg、再往上 吨 / 万吨 / 亿吨 / 万亿吨。
      ⚠️ 与游戏内 `U.kg()`（一律 g/kg）**不是同一个口径**，是有意的（文件头写明）。 */
  function handKg(w) {
    if (w < 1) return Math.round(w * 1000) + ' g';
    if (w < 1000) return (w.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + ' kg';
    const t = w / 1000;
    const units = [[1e12, '万亿吨'], [1e8, '亿吨'], [1e4, '万吨'], [1, '吨']];
    for (const [div, unit] of units) {
      if (t >= div) return (t / div).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' ' + unit;
    }
    return Math.round(t) + ' 吨';
  }
  const metaBad = [];
  items.forEach(h => {
    const f = G.FISH_ID[h.id];
    if (!f) return;
    if (f.name !== h.name) metaBad.push(`${h.id} 名字写「${h.name}」，fish.js 是「${f.name}」`);
    const parts = h.meta.split(' · ');
    if (parts.length !== 3) { metaBad.push(`${h.id} 标题括号里不是「钓场 · 体重 · 价格」三段：「${h.meta}」`); return; }
    const want = [fname[fieldOf[h.id]] || fieldOf[h.id], handKg(f.minKg), f.price + ' 金'];
    parts.forEach((got, i) => { if (got !== want[i]) metaBad.push(`${h.id} 表头第 ${i + 1} 段写「${got}」，现算是「${want[i]}」`); });
  });
  if (metaBad.length) {
    err(`${rel} 的表头有 ${metaBad.length} 处与数据对不上（前 6 处：${metaBad.slice(0, 6).join('；')}）—— `
      + '表头是「现算」的，改完数值要重算；它是最容易被手抄成旧值的一处'); bad++;
  }

  /* ③ 档位覆盖：分界从 CFG.rarity 现算 */
  const cn = (CFG.colorMorphs || []).map(c => c.name);
  const epicIdx = (CFG.rarity || []).findIndex(r => r.key === 'epic');
  if (cn.length < 2 || epicIdx < 0) {
    err('读不到 `CFG.colorMorphs` / `CFG.rarity` 的 `epic` 档 —— 33-g 的档位判据会恒真，先修判据'); return;
  }
  const few = [cn[0], cn[cn.length - 1]];      /* 原色 + 闪光 */
  const all = cn.slice();
  const MORPH = /^- \*\*(.+?)\*\*：/;
  const lvBad = [], alien = [];
  items.forEach(h => {
    const f = G.FISH_ID[h.id];
    const bold = h.body.map(l => (MORPH.exec(l) || [, null])[1]).filter(Boolean);
    /* 档位行 = 名字∈`CFG.colorMorphs`；其余粗体行只许是写稿期的旁注（`⚠️ 备注`） */
    bold.forEach(b => { if (cn.indexOf(b) < 0 && !/^⚠️/.test(b)) alien.push(`${h.id} 的「${b}」`); });
    const got = bold.filter(b => cn.indexOf(b) >= 0);
    const want = (f && f.rar >= epicIdx) ? all : few;
    if (got.join('|') !== want.join('|')) lvBad.push(`${h.id} 写的是 [${got.join('/')}]，应为 [${want.join('/')}]`);
  });
  if (alien.length) {
    err(`${rel} 里有 ${alien.length} 行粗体标题不是档位名、也不是 ⚠️ 旁注（${alien.slice(0, 6).join('；')}）—— `
      + '多半是档位名写错（写错了只会被静默忽略，等于那一档没写）'); bad++;
  }
  if (lvBad.length) {
    err(`${rel} 有 ${lvBad.length} 条的档位不对（前 6 条：${lvBad.slice(0, 6).join('；')}）—— `
      + '口径是「普通 / 稀有只写原色 + 闪光，史诗 / 传说写全五档」'); bad++;
  }

  /* ④ 正文不许抄进生图提示词 */
  const leak = items.filter(h => h.body.some(l => /提示词|prompt/i.test(l))).map(h => h.id);
  if (leak.length) {
    err(`${rel} 里 ${leak.length} 条的正文出现了「提示词 / prompt」（${leak.slice(0, 8).join(' / ')}）—— `
      + '用户口径：「图鉴文案中不需要有生成图的提示词」'); bad++;
  }

  /* ⑤ 旧物种不许再出现在同一条的正文里（名册「原名」列现算） */
  const rosterP = path.join(ROOT, 'docs/新物种名册.md');
  if (!fs.existsSync(rosterP)) { err('缺 `docs/新物种名册.md` —— 33-g 的旧物种判据抓不到名单（先修判据本身）'); return; }
  const roster = {};
  (fs.readFileSync(rosterP, 'utf8').match(/^\|\s*([A-Z]{1,3}\d{2,3})\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*\*\*([^*]+)\*\*\s*\|/gm) || [])
    .forEach(r => {
      const m = /^\|\s*([A-Z]{1,3}\d{2,3})\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*\*\*([^*]+)\*\*\s*\|/.exec(r);
      if (m) roster[m[1]] = { old: m[2], neu: m[3] };
    });
  if (!Object.keys(roster).length) { err('`docs/新物种名册.md` 的「原名」列一条都认不出 —— 33-g 的旧物种判据会恒真'); return; }
  const byId = {}; items.forEach(h => { byId[h.id] = h; });
  const dirty = {};                       /* id -> 正文里还留着旧物种的证据 */
  Object.keys(roster).forEach(id => {
    const h = byId[id]; if (!h) return;
    const body = h.body.join('\n');
    const { old, neu } = roster[id];
    if (body.includes(old)) { dirty[id] = `整串旧名「${old}」`; return; }
    /* 旧属名：用**末两字**，不用末一字 —— 末一字会假报（实测 S41「已经不是鱼了」/ S47「鱼雷」
       都是正常行文，而它们的旧名末字恰好是「鱼」，见反向验证第 ② 组）。
       新名里已经含它时跳过（例「终焉之影·忘川」的「忘川」）。 */
    const tail2 = old.slice(-2);
    if (old.length > 2 && !neu.includes(tail2) && body.includes(tail2)) dirty[id] = `旧属名「${tail2}」`;
  });

  /* ⑥ 清单勾选状态必须与正文一致 */
  const chk = [];
  lines.forEach(l => {
    const m = /^- \[([ x])\] `([A-Z]{1,3}\d{2,3})`/.exec(l);
    if (m) chk.push({ done: m[1] === 'x', id: m[2] });
  });
  if (!chk.length) { err(`${rel} 文末的「待重写清单」一条都没认出（格式变了？）—— 勾选判据会恒真`); return; }
  const chkGhost = chk.filter(c => !G.FISH_ID[c.id]).map(c => c.id);
  if (chkGhost.length) { err(`${rel} 的清单里有 fish.js 不存在的 id：${chkGhost.slice(0, 8).join(' / ')}`); bad++; }
  const lieNo = chk.filter(c => c.done && dirty[c.id]).map(c => `${c.id}（${dirty[c.id]}）`);
  if (lieNo.length) {
    err(`${rel} 的清单已经勾掉、但正文还认得出旧物种：${lieNo.slice(0, 8).join(' / ')}`); bad++;
  }
  const lieYes = chk.filter(c => !c.done && roster[c.id] && !dirty[c.id]).map(c => c.id);
  if (lieYes.length) {
    warn(`${rel} 的清单还留着未勾项，但那些条的正文已认不出旧物种（${lieYes.slice(0, 8).join(' / ')}）`
      + ' —— 勾选状态与事实不符，去把清单勾上'); 
  }
  if (!bad) {
    ok(`${rel}：${items.length} 条与 fish.js 一一对应、序号连续、表头三个数现算一致；`
      + `档位覆盖按 rarity 现算（\`epic\` 以下 ${few.join(' + ')}、以上 ${all.length} 档全写）；`
      + `旧物种名 ${Object.keys(roster).length} 条无一回流；清单勾选与正文一致`);
  }
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
     让**唯一的现行基线**留在 `docs/优化队列.md` §1「当前状态」的「门禁基线」行（每轮收工都要更新）。
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
          `改成「以实跑输出为准」，现行基线只留 docs/优化队列.md §1「当前状态」`);
      gateNumBad++;
    });
  });
  if (!scanned) { err('34-b 要扫的文档一个都不存在（改了文件名就来更新这条断言）'); gateNumBad++; }
})();
if (!gateNumBad) ok('7 份现行口径文档都没写死 test.js 的总项数（现行基线只留在 docs/优化队列.md §1「当前状态」）');


/* ---------------- 35. 主循环的三条守则（三条都是踩过的坑） ----------------
   ① **失焦时不许渲染**：失焦 = 暂停（St.tick / Weather / F.update 全按 focused 拦住了），
      画面本来就静止；原来无条件 `S.render(dt)`，切到别的应用还在 60fps 重画水面与粒子。
      浏览器只在**标签页不可见**时节流 rAF，「窗口失焦但页面可见」不节流 → 纯烧电。
   ② **帧率上限**：`FRAME_MIN` 锁 60fps（高刷屏原本跑满 144 帧）。
   ③ **浏览面板不暂停「挂机」钓**：挂机时打开图鉴鱼就不咬 = 挂机游戏的核心预期被废
      （2026-10-08 的老坑：`paused` 写成 `P.isCatchOpen() || P.isOpen()`）。
      ⚠️ 但**手动**钓必须被普通面板暂停（2026-10-09 修）：面板开着时输入通道是关的
      （`#deck` pointer-events:none + `handlePress` 的 `P.isOpen()` 守卫），逻辑却照跑，
      咬口 / 逃窜照常倒计时 —— 玩家一步都操作不了，必然断线或漏咬口。
      ⇒ 判据三条：结算卡必停（`isCatchOpen`）· 手动 / 挂机要分开（`isIdleMode`）·
      **不许出现无守卫的 `|| P.isOpen()`**（老坑的精确形态）。 */
/* 34-c 存档结构必须有网（2026-10-09 立）
   `blank()` 是整份存档结构的**唯一真相**，而 GDD §11 是玩家/后续开发者读的那份。
   两边一旦漂移不会报错：加了字段忘了写文档 → 后来人照着文档写迁移，老档就悄悄丢字段。
   这条只做**单向**断言（blank() 的字段必须都在 §11 出现过）——
   反方向会误报，因为 §11 里有「`locked` / `createdAt` 已删除」这类历史说明。 */
console.log('\n[34-c] GDD 的存档结构必须覆盖 blank() 的每个顶层字段');
(function () {
  const stateSrc = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
  const blankBody = (stateSrc.match(/function blank\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  if (!blankBody) { err('state.js 里找不到 blank()（存档结构的唯一真相）'); return; }
  const fields = [...blankBody.matchAll(/^ {6}([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map(m => m[1]);
  if (fields.length < 20) {
    err(`blank() 只解析出 ${fields.length} 个顶层字段 —— 缩进或写法变了，先修这条断言本身`);
    return;
  }
  const gdd = fs.readFileSync(path.join(ROOT, 'docs/GDD.md'), 'utf8');
  const sec = (gdd.match(/## 11\. 存档结构[\s\S]*?(?=\n## )/) || [''])[0];
  if (!sec) { err('GDD.md 里找不到「## 11. 存档结构」'); return; }
  const missing = fields.filter(f => !new RegExp('\\b' + f + '\\b').test(sec));
  if (missing.length) {
    err(`GDD §11 没写这些存档字段：${missing.join(' / ')} —— blank() 加了字段就必须同步 GDD §11` +
        '（迁移逻辑是照着文档写的，漏一处老档就会静默丢字段）');
    return;
  }
  ok(`GDD §11 覆盖了 blank() 的全部 ${fields.length} 个顶层字段`);
})();

console.log('\n[35] 主循环守则：失焦不渲染 / 锁 60fps / 浏览面板只停手动钓');
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
  if (!pausedLine || pausedLine.indexOf('isCatchOpen') < 0) {
    err(`main.js 的 paused 判定丢了结算卡：「${pausedLine.trim()}」—— 结算卡待决时钓鱼必须停`);
    loopBad++;
  }
  if (!pausedLine || pausedLine.indexOf('isIdleMode') < 0) {
    err(`main.js 的 paused 判定没有分手动 / 挂机：「${pausedLine.trim()}」—— ` +
        '普通面板只许停手动钓（!isIdleMode()），挂机时浏览面板继续钓是核心预期');
    loopBad++;
  }
  if (/\|\|\s*P\.isOpen\(\)/.test(pausedLine)) {
    err(`main.js 的 paused 判定里有无守卫的「|| P.isOpen()」：「${pausedLine.trim()}」—— ` +
        '挂机时一开图鉴鱼就不咬（2026-10-08 的老坑）');
    loopBad++;
  }
})();
if (!loopBad) ok('失焦不渲染、锁 60fps、结算卡必停 / 普通面板只停手动钓（三条守则都还在）');

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
       ⚠️ 边界（2026-10-08 明确，见 `docs/每小时优化轮次规范.md` §9「自主决策：质量优先」）：
          `requestAnimationFrame` / `cancelAnimationFrame` **算**平台能力；
          `setTimeout` / `setInterval` **不算**（任何宿主都有，连 Node 都有），
          所以在业务代码里直接写定时器是**合法**的 —— 这条边界由用户提问触发、
          由「质量优先」拍定为「收口帧调度、不收口通用计时器」，别再反复摇摆。 */
    ['requestAnimationFrame（直接调度帧）', /(^|[^\w$.])requestAnimationFrame\s*\(/],
    ['cancelAnimationFrame（直接调度帧）', /(^|[^\w$.])cancelAnimationFrame\s*\(/],
    /* 语音合成（N6）也是平台能力（Web 端是系统 TTS，小程序端要换成云端 TTS 或整组 no-op）
       —— 业务代码一律走 `G.Platform.speech`。
       ⚠️ 这一条**必须按名枚举**：它既不碰 localStorage 也不碰 document，上面任何一条都拦不住它，
          与当年 `performance.now` 漏网时一模一样（那次是「按名枚举的规则从没覆盖过它」）。
       🔴 也**不能**照抄上面那批的 `(^|[^\w$.])` 前缀 ——那个 `.` 是给
          `G.Platform.dialog.confirm(` 这类**自己的包装器**留的；
          而 `speechSynthesis` 是 window 的全局属性，真实写法就是 **`window.speechSynthesis`**
          ⇒ 带 `.` 的否定类会让这一条**恰好漏掉唯一一种真写法**（反向验证当场逮到：
          注入 `window.speechSynthesis.cancel()` 时 ㊱ 全绿）。这里收紧成 `[^\w$]`。 */
    ['speechSynthesis（直连语音合成）', /(^|[^\w$])speechSynthesis\b/],
    ['SpeechSynthesisUtterance（直连语音合成）', /(^|[^\w$])SpeechSynthesisUtterance\b/],
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
  const tplM = TPL_RE.exec(py);
  if (!tplM) {
    err('tools/review-cards.py 里认不出 TEMPLATE 三引号块 —— 拼装方式改过？判据要跟着改');
    return;
  }
  const tpl = tplM[1];
  /* ⚠️ 模板的偏移**直接用正则的匹配位置**，不许另拿 `tpl` 反查（Q38）：
     · `indexOf` 找不到时返回 -1，而 `py.slice(0, -1)` **不报错** —— 只是把最后一行算少一行
       ⇒ 报出来的行号整体偏 1（静默）；
     · `at()` **当时**也不行：它把空格换成 `\s+` 建**正则**，25 KB 的 needle 会当场
       `Invalid regular expression: Stack overflow`（实测，2026-10-09）。
       ⚠️ 这条已经在 Q39 里从根上修掉了（`at()` 改成纯扫描、没有规模上限，见第 ㊷ 节 ⑪），
       所以现在 `at(py, tpl)` 也能查（第 ⑪ 节 ② 就是这么用的）。这里仍保留
       「用正则自己的匹配位置」—— 它最直接，且不必多建一次扫描。 */
  const tplBase = py.slice(0, tplM.index).split('\n').length;   // 模板起始行
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
    /* 函数体切片走 bodyOf()：原正则「切到下一个 def / class」同样会超范围（实测 1456 vs 332）。 */
    const bp = bodyOf(py, 'def build_page(');
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


/* ---------------- 41-b. 环境音的循环采样通道：入口唯一 + 素材对得上 + BGM 不许被顺手接采样 ----------------
   🔎 由来（2026-10-09，队列 Q20 的剩余那半件）：环境音从「纯合成」升级成
   「采样优先 + 合成回退」。这一层会出的两种退化**都是静默的**，所以必须上机制：
     ① 有人为了「BGM 也换成素材」顺手把采样接到 `startBgm` 上 —— 那会丢掉
        「随时段 / 天气换参数」这个**已拍板保留**的特性（`Weather.bgmSpec`），
        而且换完还照常出声，只有细心听才发现「每场每时的音乐都一样了」。
     ② 键名改了 / 素材文件没跟上 —— `G.Assets.sfx()` 拿不到就**静默回退合成**，
        不报错、不写日志，表现只是「换了素材怎么好像没差别」。
   ⇒ 本节两件事：**入口唯一**（`G.Assets.sfx(` 全项目只许那两个已知调用点）与
      **素材对得上**（键从代码里**现算**，不是本节写死的）。
   ⚠️ 判据一律「抓不到就报错」：取不到函数体 / 表体 = 报红，不许因此恒真。 */
console.log('\n[41-b] 环境音的循环采样通道：入口唯一 + 素材对得上 + BGM 不许被顺手接采样');
(() => {
  const AUD = fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8');
  const code = AUD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = (m, what) => {
    const b = bodyOf(code, m);
    if (!b) { err(`取不到 ${what} —— 改写法了来更新第 41-b 节的判据`); return null; }
    return b;
  };
  let bad = 0, subBad = 0;

  /* ① 采样入口唯一：全项目恰 2 处 —— 一次性音效的自动包装层 + 环境音的 requestAmbSample。
        多一处（有人绕开它自己取素材）少一处（包装层被拆了）都报红。 */
  const hits = (code.match(/G\.Assets\.sfx\s*\(/g) || []).length;
  const wrap = body('Object.keys(API).forEach(', '一次性音效包装层');
  const req = body('function requestAmbSample(', 'requestAmbSample() 的函数体');
  if (wrap !== null && req !== null) {
    const nWrap = (wrap.match(/G\.Assets\.sfx\s*\(/g) || []).length;
    const nReq = (req.match(/G\.Assets\.sfx\s*\(/g) || []).length;
    if (hits !== 2 || nWrap !== 1 || nReq !== 1) {
      err(`audio.js 里 G.Assets.sfx( 共 ${hits} 处（包装层 ${nWrap} / 环境音 ${nReq}）——`
        + '采样入口只许这两个已知调用点，多一处就是有人绕开它们自己取素材');
      bad++;
    }
  } else bad++;

  /* ② BGM **保持程序化**（已拍板）：音乐那几条路里不许出现素材取用 */
  const bgmBad = [];
  ['startBgm: function', 'function bgmPump(', 'stopBgm: function'].forEach(m => {
    const b = body(m, m + ' 的函数体');
    if (b === null) { bad++; return; }
    if (/Assets|sample/i.test(b)) bgmBad.push(m.replace(/: function$/, '').replace('function ', ''));
  });
  if (bgmBad.length) {
    err(`背景音乐那几条路里出现了素材取用（${bgmBad.join(' / ')}）—— BGM 按拍板`
      + '**保持程序化合成**：换成采样会丢掉「随时段 / 天气换参数」这个已有特性');
    bad++;
  }

  /* ③ 素材对得上：键从 audio.js **现算**，再核对磁盘 */
  const km = /AMB_KEY\s*=\s*'([a-z][a-z0-9]*)'/.exec(code);
  if (!km) { err('audio.js 里找不到 AMB_KEY 的定义（格式：`var AMB_KEY = \'小写字母数字\';`）'); bad++; }
  else if (!fs.existsSync(path.join(ROOT, 'assets/audio/' + km[1] + '.mp3'))) {
    err(`audio.js 的采样键是 ${km[1]}，但 assets/audio/${km[1]}.mp3 不存在 —— `
      + '那就永远只放合成音（G.Assets 拿不到会静默回退，不报任何错）');
    bad++;
  } else ok(`循环采样键 ${km[1]} 与磁盘上的 assets/audio/${km[1]}.mp3 对得上（键是现算的）`);

  /* ④ 环境音仍在 NO_SAMPLE 里（它要自己管「起 / 热切换 / 收」），
        **电平**两条路共用同一份；**低通自 2026-10-10 起故意分开**
        （拍板第 6 条「只给采样放宽低通到 ~1.5kHz，BGM / 音效不动」）——
        判据反过来：两条路各读**自己那个**常量，且谁都不许读到对方那个。 */
  const i0 = at(code, 'var NO_SAMPLE');
  const e0 = i0 < 0 ? -1 : closeOf(code, code.indexOf('{', i0));
  if (e0 < 0) { err('取不到 NO_SAMPLE 的表体 —— 改写法了来更新第 41-b 节的判据'); bad++; }
  else if (!/startAmbience:\s*1/.test(code.slice(i0, e0))) {
    err('startAmbience 从 NO_SAMPLE 里出来了 —— 它要管节点生命周期，不该被'
      + '「放一次就完」的自动包装层包住');
    bad++;
  }
  const nGain = (code.match(/\bAMB_GAIN\b/g) || []).length;
  if (nGain < 2) {
    err(`AMB_GAIN 在 audio.js 里只出现 ${nGain} 次（定义 + 至少一处使用）——`
      + '**电平**两条路必须共用同一份（各写各的就会分家，换素材会顺手改掉音量平衡）');
    subBad++;
  }
  const ambFn = m => {
    const b = bodyOf(code, m);
    if (!b) { err(`取不到 ${m} 的函数体 —— 改写法了来更新第 41-b 节的判据`); subBad++; }
    return b || '';
  };
  const synthN = ambFn('function startSynthAmbience(');
  const sampN = ambFn('function startAmbSample(');
  ['AMB_FILTER_HZ_SYNTH', 'AMB_FILTER_HZ_SAMPLE'].forEach(k => {
    if ((code.match(new RegExp('\\b' + k + '\\b', 'g')) || []).length < 2) {
      err(`${k} 在 audio.js 里只出现不到 2 次（定义 + 它在自己那条路里的使用）——`
        + '拍板第 6 条是「只给采样放宽低通」，两个常量各管一条路');
      subBad++;
    }
  });
  if (synthN && !/AMB_FILTER_HZ_SYNTH/.test(synthN)) {
    err('合成那条路（startSynthAmbience）读的不是 `AMB_FILTER_HZ_SYNTH` —— 拍板只放采样，合成必须留在原值');
    subBad++;
  }
  if (sampN && !/AMB_FILTER_HZ_SAMPLE/.test(sampN)) {
    err('采样那条路读的不是 `AMB_FILTER_HZ_SAMPLE` —— 拍板要的就是「只给采样放宽」');
    subBad++;
  }
  if (synthN && /AMB_FILTER_HZ_SAMPLE/.test(synthN)) {
    err('合成那条路**读到了采样的低通** —— 两条路又合回一个了：那样「只给采样放宽」'
      + '会变成「两条一起变亮」，而那是拍板明确不要的');
    subBad++;
  }
  if (sampN && /AMB_FILTER_HZ_SYNTH/.test(sampN)) {
    err('采样那条路读到了合成的低通 —— 同上一类：两个常量必须各管一条路');
    subBad++;
  }
  bad += subBad;

  if (!bad) ok('循环采样只有那两个已知入口、BGM 保持程序化、素材键与磁盘对得上、'
    + '环境音仍自管生命周期；**电平两条路共用、低通按拍板分开（只放采样到 1.5k）**');
})();


/* ---------------- 42. 接触表：判定口径不许有第二份 ----------------
   背景：`tools/contact-sheet.py`（把一批卡面拼成一张大图，人一次过 20~40 张）。
   它要在缩略图上画红 / 黄框，**最省事的写法就是自己再判一遍几何** ——
   一旦两处阈值分家，就会出现「评审台说合格、接触表画红框」（本项目最忌的「第二份真相」，
   同族事故见 §41 与 MEMORY.md 的「同一个事实被写 N 遍 = 高危」）。
   这里把七件事钉死：
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
     ⑥ **判定的单位是槽位、中位的单位是档**（Q34，2026-10-09 加）：`main()` 原来按**档**
        归并 ⇒ 同一档出 2 版时只判其中一个、另一个「沿用」别人的判定，而报表里印的仍是
        自己的数字 = 一条**假阴性通道**（被挤掉那张本该 fail 也照样写 ok）。
        三条：`slot_key()`（槽位键，**不折**版本后缀）只许一处；`slot_verdicts()` 的归组
        必须走 `slot_key()` 且**不许**出现 `slot_of(` / `morph_key(`；`slot_of()` 必须走
        `slot_key()`。⚠️ 与 ⑤ 合起来才说得清：**槽位键不折、档键折，折的地方只有一处**。
     ⑦ **报表两个「一行一槽」段落口径合一**（Q35，2026-10-09 加）：FAIL 清单原来按**文件**
        累加、跨档提示段按**槽位**累加 ⇒ 原色档那一对同槽位被印两遍、头条计数双计。
        三条：`slot_tally()` 只许一处；它按 `sorted(slots)` 遍历且**不许**出现 `per_path`；
        `main()` 必须走它、且**不许**再自己 `fails.append(` / `drift.append(`。
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

  /* ② 判定只有一个入口：`def judge(` 恰好一处，且 `main()` 体内不再比阈值
     ⚠️ 取 main() 的**函数体**走顶层 `bodyOf()`（按缩进终止）。原来写成
     `const mi = at(cc, 'def main('); … cc.slice(mi)` —— 那会一路切到**文件尾**
     （把结尾的 `if __name__ == '__main__': main()` 也算进 main 的体里），正是 Q36 要收的
     「范围越过函数体」形状；它漏过了 Q36 的两条网（那两条只认「下一个 def 当终止符」与内联
     `.slice(at(`），由本轮新增的 ⑨ 判据兜住，并把这一处一并收掉。 */
  let secBad = 0;
  const judgeDefs = (cc.match(/def\s+judge\s*\(/g) || []).length;
  if (judgeDefs !== 1) { err(`check-cards.py 里 def judge( 有 ${judgeDefs} 处（应为 1）`); secBad++; }
  const mainBody = bodyOf(cc, 'def main(');
  if (!mainBody) { err('check-cards.py 里找不到 def main( —— 本断言按它切片，改了名就来更新'); secBad++; }
  else {
    const body = mainBody;
    // 主入口必须接上**判定入口**：自 Q34（2026-10-09）起那唯一一处是 `slot_verdicts()`
    // （它内部再调 `judge_group()` → `judge()`，那两条由下面 ④ / ⑥ 单独盯）。
    // ⚠️ 原来这里放行 `judge(` / `judge_group(`：判定逻辑一旦被抽进 `slot_verdicts()`，
    //    main() 里残留的那两个名字就只是「曾经接上」的痕迹 ⇒ 改成要求**那个唯一入口**。
    if (!has(body, 'slot_verdicts(')) {
      err('check-cards.py 的 main() 没走 slot_verdicts() —— 判定入口没接上'
        + '（主线是 analyze → slot_verdicts → judge_group → judge）'); secBad++;
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
  /* 函数体一律走顶层共用的 `bodyOf()`（按缩进切），**不再**用「两个位置锚点之间的全部文本」
     —— 那套写法靠「两者之间恰好没夹别的函数」成立（Q35 往中间加 `slot_tally()` 时当场假红），
     而且把「谁在谁前面」变成一条本不该存在的耦合（函数顺序本来可以随便调）。
     ⇒ 因此**连「函数顺序」那条断言一起摘掉**：它守护的那个前提（按位置切片要算得对）
     已经不存在了；留一条守不住任何东西的守卫 = 让下一个人以为这条路还封着（见 §8 硬规矩 6）。
     存在性仍然要报错（找不到函数 = 本节形同虚设），改由 `bodyOf()` 返回空串来体现。 */
  const judgeBody = bodyOf(cc, 'def judge(');
  const groupBody = bodyOf(cc, 'def judge_group(');
  if (!judgeBody || !groupBody || !has(cc, 'def drift_warnings(')) {
    err('check-cards.py 里认不出判定链的函数（judge / drift_warnings / judge_group）—— '
      + '本节按**函数名**切片，改名 / 搬家就来更新（不许静默跳过）');
    secBad++;
  } else {
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
  const mkBody = bodyOf(cc, 'def morph_key(');
  if (litCount !== 1 || !has(mkBody, VER_SUFFIX)) {
    err(`check-cards.py 里版本后缀正则（${VER_SUFFIX}）出现 ${litCount} 处`
      + '（应为 1，且落在 morph_key() 里）—— 折版规则抄了第二份 ⇒ 同一档的多版会在'
      + '一条路上被折叠、在另一条路上没有');
    secBad++;
  }
  [['slot_of', bodyOf(cc, 'def slot_of(')],
    ['drift_warnings', bodyOf(cc, 'def drift_warnings(')]].forEach(pair => {
    if (!has(pair[1], 'morph_key(')) {
      err(`check-cards.py 的 ${pair[0]}() 没走 morph_key() —— 档键口径分家，`
        + '同一档的多版会被当成两个档（中位被候选数拽走）');
      secBad++;
    }
  });

  /* ⑥ 判定的单位 = **槽位**（Q34，2026-10-09）。
     `main()` 原来按**档**归并：同一档出 2 版（传说闪光）时只判其中一个、另一个「沿用」
     它的判定 —— 而报表里印的仍是自己的数字 ⇒ 留下那张 ok、被挤掉那张本该 fail 也照样写 ok，
     这是**验收工具里的一条假阴性通道**（「留下了但没人看」正是这一页存在的唯一理由）。
     三条判据，全部按**函数体**切片（不扫全文件）：
       · `slot_key()`（槽位键，**不折版本后缀**）只许一处定义；`slot_verdicts()` 只许一处；
       · `slot_verdicts()` 必须走 `slot_key()`，且**不许**出现 `slot_of(` / `morph_key(`
         —— 拿档键去归并**判定**就是要堵的那个漏口（判据用带括号的调用形态，
         免得「槽位」这两个字在别处撞名；两条都做过负对照：注释里写它仍绿）；
       · `slot_of()`（档键，给中位用）必须走 `slot_key()`，两条口径串在一处。
     ⚠️ 「折版规则只许一处」由上面 ⑤ 盯（版本后缀正则只许出现在 `morph_key()` 里）——
        ⑤ 与 ⑥ 合起来才说得清：**槽位键不折、档键折，折的地方只有一处**。 */
  const skDefs = (cc.match(/def\s+slot_key\s*\(/g) || []).length;
  const svDefs = (cc.match(/def\s+slot_verdicts\s*\(/g) || []).length;
  if (skDefs !== 1) {
    err(`check-cards.py 里 def slot_key( 有 ${skDefs} 处（应为 1 —— 槽位口径只许一处定义）`);
    secBad++;
  }
  if (svDefs !== 1) {
    err(`check-cards.py 里 def slot_verdicts( 有 ${svDefs} 处（应为 1 —— 判定归组只许一处）`);
    secBad++;
  }
  const svBody = bodyOf(cc, 'def slot_verdicts(');
  if (!has(svBody, 'slot_key(')) {
    err('check-cards.py 的 slot_verdicts() 没走 slot_key() —— 判定按什么单位归组分家了'
      + '（原色档那一对会判出两种结论 / 同一档的多版会共用一份判定）');
    secBad++;
  }
  const svLeak = ['slot_of(', 'morph_key('].filter(n => has(svBody, n));
  if (svLeak.length) {
    err(`check-cards.py 的 slot_verdicts() 里出现了 ${svLeak.join('、')} —— `
      + '判定的单位是**槽位**：拿档键归并 ⇒ 同一档的多版只判一个、另一个沿用别人的判定，'
      + '被挤掉那张本该 fail 也照样写 ok（假阴性通道）');
    secBad++;
  }
  if (!has(bodyOf(cc, 'def slot_of('), 'slot_key(')) {
    err('check-cards.py 的 slot_of() 没走 slot_key() —— 槽位键与档键两条口径分家');
    secBad++;
  }

  /* ⑦ 报表两个「一行一槽」段落的**口径合一**（Q35，2026-10-09）。
     FAIL 清单与跨档提示段原来是**两处各写一遍遍历**：FAIL 在 `for p in order`（按**文件**）
     里累加，提示段在 `for fid in sorted(slots)`（按**槽位**）里累加 —— 而原色档那一对
     （`<id>.png` / `<id>-normal.png`）是**同一个槽位、两个文件** ⇒ 一个坏槽被印成两行、
     头条「硬性不合格 N 张」也双计（实测：母版与抠图都裁到贴边 ⇒ 报「2 张」+ 两行 ✗）。
     现在两段都从 `slot_tally()` 出来。三条判据（都按**函数体**切片）：
       · `slot_tally()` 只许一处定义 —— 「一个槽位一行」只有一处真相；
       · 它的遍历必须按**槽位**（`sorted(slots)`），**不许**出现 `per_path`（那是按文件的口径）；
       · `main()` 必须走它，且 `main()` 里**不许**再自己 `fails.append(` / `drift.append(`
         —— 那就是又开了一处口径。 */
  const stDefs = (cc.match(/def\s+slot_tally\s*\(/g) || []).length;
  if (stDefs !== 1) {
    err(`check-cards.py 里 def slot_tally( 有 ${stDefs} 处（应为 1 —— 「一个槽位一行」只许一处）`);
    secBad++;
  }
  const stBody = bodyOf(cc, 'def slot_tally(');
  if (!has(stBody, 'sorted(slots)')) {
    err('check-cards.py 的 slot_tally() 没按槽位遍历（`sorted(slots)`）—— '
      + '报表段落按什么单位列组分家了');
    secBad++;
  }
  if (has(stBody, 'per_path')) {
    err('check-cards.py 的 slot_tally() 里出现了 per_path —— 那是按**文件**的口径：'
      + '原色档那一对（同一个槽位、两个文件）会被印两遍、头条计数也双计（Q35）');
    secBad++;
  }
  /* ⑦ 复用 ② 已算出的 `mainBody`（同一节里原本也是共用 `mi`，不重复报「找不到 def main(」） */
  if (mainBody) {
    if (!has(mainBody, 'slot_tally(')) {
      err('check-cards.py 的 main() 没走 slot_tally() —— FAIL 清单与跨档提示段的口径会分家'
        + '（一个按文件、一个按槽位）');
      secBad++;
    }
    const dup2 = ['fails.append(', 'drift.append('].filter(t => has(mainBody, t));
    if (dup2.length) {
      err(`check-cards.py 的 main() 里又自己累加了 ${dup2.join('、')} —— `
        + '「一个槽位一行」只许在 slot_tally() 一处（FAIL 段按文件加会把同槽位印两遍）');
      secBad++;
    }
  }

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

  /* ⑧ 切函数体只许有**一种机制**：`bodyOf()`（Q36，2026-10-09）。
     「两个位置锚点之间的全部文本」与「切到下一个 def」这两种写法有两个共同毛病：
       ① **靠巧合成立** —— 「中间恰好没夹别的函数」「中间恰好只有一个 def」。加个函数就假红
          （Q35 往 `judge_group` 与 `main` 之间加 `slot_tally()` 时当场踩到），
          而且让「函数写的顺序」变成一条本不该存在的耦合；
       ② **范围会超** —— 实测 `steps_for()` 的原写法把**后面**的 MODEL / CFG / BASE / GEOM
          常量一起算了进来（997 vs 函数体 184 字符）⇒ 判据可能被无关文本喂饱（假通过那一类）。
     本节的函数体切片已全部改走顶层 `bodyOf()`（按缩进终止，全项目只有一处实现）。三条判据：
       · 不许出现「反斜杠 + ndef + 空格」这个字面量（= 拿「下一个 def」当终止符）；
       · 不许出现内联形式的「两个位置锚点」（`X.slice(at(`）；
       · 每个 `bodyOf()` 的 marker 必须是**带左括号的定义形态**（`'def xxx('` / `'function xxx('`）
         —— marker 少了左括号就会先命中**调用点**（`judge(`），缩进按调用点算 ⇒ 函数体被切成
         一行 ⇒ 判据静默变成摆设（「放行条件写宽了」那一类）。
     ⚠️ needle 全部用 `String.fromCharCode` / 拼接**造出来**，不写成字面量 —— 否则本断言自己
        就把自己喂饱了（本项目反复栽过的自指）。扫之前先剥行注释与块注释（硬规矩 ①）。
     ⚠️ 这两条网**只认字面形态**：把锚点先存进变量再切片（`const a = at(...); cc.slice(a, b)`）
        它们抓不到 —— 而 `blank()` 那处「挖空定义段」正是这种形状（`stSrc.slice(0, fnAt)`），
        它与「切函数体」语义不同，硬套会误报。⇒ 由下面的 **⑨** 用**位置白名单**兜住（Q37，2026-10-09）。 */
  {
    const selfSrc = fs.readFileSync(__filename, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const BS = String.fromCharCode(92), OP = String.fromCharCode(40);
    const NDEF = BS + 'ndef ';                    // 反斜杠 + ndef + 空格
    const ANCHOR = '.' + 'slice' + OP + 'at' + OP;   // 内联的双位置锚点
    const MARKER = /bodyOf\(\s*[^,()]+,\s*'([^']*)'/g;
    const badMarker = (selfSrc.match(MARKER) || [])
      .filter(s => !/'(def|function)\s+[A-Za-z_$][\w$]*\s*\(/.test(s));
    const posBody = t => t.indexOf(NDEF) >= 0 || t.indexOf(ANCHOR) >= 0;
    /* 判据自检：坏样本必被抓、好样本必放过（三个 needle 各来一个）
       ⚠️ 坏样本 1 用拼接写：写字面量 `.indexOf(` 会让**第 ㊳ 节**把这条合成样本当成真违规
          （它扫的是本文件，且只剥整行注释）—— 自指喂饱的老坑。 */
    const SYN_OK = "const b = bodyOf(src, 'def judge(');";
    const SYN_BAD1 = 'const b = body.' + 'indexOf(' + JSON.stringify(NDEF) + ', 10);';
    const SYN_BAD2 = 'const b = src' + ANCHOR + "src, 'def main('));";
    if (!posBody(SYN_BAD1) || !posBody(SYN_BAD2) || posBody(SYN_OK)) {
      err('第 42 节 ⑧ 判据自检不成立：分不出「按位置切函数体」（坏）与 bodyOf()（好）——'
        + `坏样本1 ${posBody(SYN_BAD1)} / 坏样本2 ${posBody(SYN_BAD2)} / 好样本 ${posBody(SYN_OK)}`);
      secBad++;
    }
    const posN = selfSrc.split(NDEF).length - 1;
    const anchorN = selfSrc.split(ANCHOR).length - 1;
    if (posN || anchorN) {
      err(`verify.js 自己又出现了「按位置切函数体」的写法（拿下一个 def 当终止 ${posN} 处 /`
        + ` 内联双锚点 ${anchorN} 处）—— 切函数体只许走 bodyOf()（按缩进切）：`
        + '按位置切片靠「中间恰好没夹别的函数」成立，且范围会越过函数体（会喂饱自己的判据）');
      secBad++;
    }
    if (badMarker.length) {
      err(`verify.js 里有 ${badMarker.length} 处 bodyOf() 的 marker 不是带左括号的定义形态`
        + `（${badMarker.join(' | ')}）—— marker 少了左括号会先命中调用点，函数体被切成一行，`
        + '整条判据静默失效；写成 `\'def 名字(\'` / `\'function 名字(\'`');
      secBad++;
    }
  }

  /* ⑨ 「变量形式的按位置切片」只许出现在白名单里（Q37，2026-10-09）。
     Q36 的两条网（「下一个 def 当终止符」/ 内联 `.slice(at(`）都**抓不到**这种形状：
     先把锚点存进变量、再拿变量去切 —— 而 Q35 出事那一处正是它，Q36 收掉的 10 处里也有 4 处是它。
     它本身不一定错：`blank()` 的「**挖空**定义段」就该这么写（语义是挖洞，不是切块 ——
     取块 / 取段落的段尾一律走 `closeOf()`，见下面的 ⑩）。危险的是**新增**一处而没人发现：
     按位置切片靠「中间恰好没夹东西」成立，范围还容易越过目标（Q37 就顺手收掉了 §42② 那处
     `cc.slice(mi)` —— 它一路切到文件尾，把 `if __name__` 那两行也算进了 main 的体）。
     判据是**多重集相等**（双向一步到位，缺一条就退化成摆设）：
       · 每一处「`at()` 的锚点变量出现在 `.slice(...)` 参数里」都必须在白名单里 —— 多一处即报红；
       · 白名单每一条都必须在文件里**恰好出现一次** —— 删了 / 改了 / 抄了第二份都报红。
     ⚠️ 只认 `at()`（项目自己的「返回**原文偏移**」助手）。`indexOf()` 的短名锚点
        （i / nl / end / nx …）在同一文件里会**撞名**（只读探针实测 31 个候选里 10 处是撞名误报，
        连 `bodyOf()` 自己内部的 `nl` 也会中枪）⇒ 那批是**结构边界**问题，不按名在这里硬套 ——
        已由下面的 **⑩** 用「结构边界」收口（Q38，2026-10-09）。
     ⚠️ 自指防线两道，缺一不可：先剥**注释**（硬规矩 ①），再剥**字符串字面量** ——
        白名单本身就是一堆 `.slice(…)` 文本，不剥就会被自己扫到（自指喂饱）；
        白名单里的 `.slice(` 另用拼接造（`'.' + 'slice' + '('`）再加一道保险。 */
  let sliceN = 0;
  {
    /* 本文件、剥注释后的源码（与 ⑧ 同一份口径；⑧ 的 selfSrc 是它块内私有的，这里自算一份） */
    const selfSrc = fs.readFileSync(__filename, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const STRIP = t => String(t)
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const norm = s => STRIP(s).replace(/\s+/g, '');
    const SL = '.' + 'slice' + String.fromCharCode(40);   // `.slice(`（拼接造，防自指）
    /* 扫出「at() 锚点变量出现在 .slice(...) 参数里」的每一处，返回**归一化**的调用文本 */
    const sliceSites = text => {
      const t = STRIP(text);
      const anchors = [];
      const reA = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\bat\s*\(/g;
      let am;
      while ((am = reA.exec(t))) anchors.push(am[1]);
      const out = [];
      let k = 0;
      while ((k = t.indexOf(SL, k)) >= 0) {
        const open = k + SL.length;
        let depth = 1, j = open;
        while (j < t.length && depth) { const c = t[j++]; if (c === '(') depth++; else if (c === ')') depth--; }
        const args = t.slice(open, j - 1);
        if (anchors.some(v => new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\b').test(args))) {
          let s0 = k;                                    // 把接收者一起切进来（`stSrc` / `src` …）
          while (s0 > 0 && /[\w$.]/.test(t[s0 - 1])) s0--;
          out.push(norm(t.slice(s0, j)));
        }
        k = j;
      }
      return out;
    };
    /* 白名单：逐处点名 + 写明为什么不是 bodyOf()。改这里必须同步改代码（多重集相等会拦）。 */
    const AL = [
      'stSrc' + SL + '0, fnAt)',                  // §32-h ② 挖空 blank 定义段（前半）
      'stSrc' + SL + 'fnAt + blankSrc.length)',   // §32-h ② 挖空（后半）—— 与前半合成「挖洞」
      /* 41-b（2026-10-09）：`NO_SAMPLE` 是**对象字面量**（不是函数体）⇒ 按缩进切不适用；
         段尾走 ⑩ 的 closeOf()，这里只把「表头 → 表尾之后」那一段取出来做一次「名单里有没有
         startAmbience」的判断（`e0` 已经是 closeOf() 给的**结构边界**，不是位置锚点）。 */
      'code' + SL + 'i0, e0)',
      /* Q38（2026-10-09）把「取段落」那三条收成结构边界后，它们不再按位置切：
         blank() 的段走 bodyOf()、VIEWS.settings 段与 MORPH_POOL 字典走 closeOf() ⇒ 条目已随代码删掉。 */
    ].map(norm);
    /* 判据自检：合成样本 —— 带 at() 锚点变量的切片必被认出、纯数组切片必被放过 */
    const SYN_YES = "const zzAt = at(cc, 'x'); const q = cc" + SL + 'zzAt, 2);';
    const SYN_NO = 'const q = cc' + SL + '0, 3);';
    if (sliceSites(SYN_YES).length !== 1 || sliceSites(SYN_NO).length !== 0 || !AL.length) {
      err('第 42 节 ⑨ 判据自检不成立：分不出「at() 锚点变量 + slice」（坏）与纯数组切片（好）'
        + `—— 坏样本 ${sliceSites(SYN_YES).length} / 好样本 ${sliceSites(SYN_NO).length} / 白名单 ${AL.length} 条`);
      secBad++;
    }
    const got = sliceSites(selfSrc);
    sliceN = got.length;
    if (got.slice().sort().join('\n') !== AL.slice().sort().join('\n')) {
      const extra = got.filter(s => AL.indexOf(s) < 0);
      const missing = AL.filter(s => got.indexOf(s) < 0);
      if (extra.length) {
        err(`verify.js 新增了「变量形式的按位置切片」而没进 ⑨ 白名单（${extra.join(' | ')}）—— `
          + '取段落 / 挖空允许，但必须逐处写进白名单并说明为什么不是 bodyOf()（切**函数体**一律走 bodyOf()）');
      }
      if (missing.length) {
        err(`第 42 节 ⑨ 白名单里有 ${missing.length} 条在文件里已不存在（${missing.join(' | ')}）—— `
          + '删了 / 改了 / 抄了第二份都算，请同步白名单（否则白名单会烂成摆设）');
      }
      if (!extra.length && !missing.length) {
        err(`第 42 节 ⑨：「变量形式的按位置切片」的出现次数（${got.length}）与白名单条数（${AL.length}）`
          + '不符 —— 同一处写法被抄了第二份也算');
      }
      secBad++;
    }
  }

  /* ⑩ 「块尾」不许押在「字符 / 模式的**首次出现**」上（Q38，2026-10-09）。
     ⑧ 管「按位置切**函数体**」、⑨ 管「变量形式的按位置切片」的位置白名单，
     ⑩ 管的是**块边界本身**：`.slice(a, b)` 的 `b` 由 `indexOf(<含 } 的字面量>)` /
     `search(<模式>)` 给出。这种写法把段尾押在「那个字符恰好只出现一次」上：
       · 返回的对象里写 `function () { return {}; }` ⇒ 里面的 `};` 提前命中（exportKeys）；
       · 回调里调一次 `Hud.toast({ ... });` ⇒ `});` 提前命中（§12 画布回调）；
       · 「换行 + 4 个空格 + `};`」把缩进写死 4（32-h 的 blank 段）；
       · 「下一个 `VIEWS.<名> =`」在该 view 是本文件最后一段时**一路切到文件尾**（32-h 面板段）；
       · 「换行 + `}`」被嵌套结构提前命中（§33 MORPH_POOL 字典）。
     截断 / 越界之后文本**照样拿得出来**，判据于是被喂饱 —— 全是**静默**假通过。
     正解 = 结构边界：`closeOf()`（括号配平，跳过字符串 / 模板串 / 注释里的括号）。
     ⚠️ 「某一行 / 某个唯一标记」这类**位置**语义不归它管（`bodyOf()` 里的 `indexOf('\n')`、
        §39 用正则匹配位置取模板行号都是），所以判据只认下面两种「块边界」形状：
       · 直接形式：`.slice(...)` 的实参里出现 `.indexOf(` / `.search(`；
       · 变量形式：变量由 `.search(` 或 `.indexOf(<含 } 的字面量>)` 赋值，且出现在 slice 实参里。
     ⚠️ 变量形式**只认「正则 / 含 `}` 的字面量」**：`i = s.indexOf(marker)`、`nl = s.indexOf('\n')`
        是「找位置 / 找行尾」，不是块边界 —— 宽口径实测 33 个候选里 29 个只是**短名撞名**
        （`i` / `end` / `missing` 各被当成同一个变量），全收进来只会变成噪音（Q37 的教训）。
        收窄后实测命中 = **恰好 Q38 列的 5 处 + §39 的 tplBase**，0 误报（只读探针）。
     ⚠️ 自指防线两道（与 ⑨ 同理）：剥注释 + 剥**字符串字面量**（判据自检里全是
        `.slice(` / `.indexOf(` 文本），关键 needle 另用拼接 / 字符码造。 */
  let blockN = 0;
  {
    /* 保留字符串的源码（判「哪个变量是块边界」要看 needle 里的 `}`）与剥字符串的源码（判切片点）各一份 */
    const selfNS = fs.readFileSync(__filename, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const STRIP = t => String(t)
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const norm = s => STRIP(s).replace(/\s+/g, '');
    const SL = '.' + 'slice' + String.fromCharCode(40);
    const IDXC = '.' + 'indexOf' + String.fromCharCode(40);
    const SERC = '.' + 'search' + String.fromCharCode(40);
    const Q1 = String.fromCharCode(39);
    /* 「块边界变量」：由 `.search(` 或 `.indexOf(<含 } 的字面量>)` 赋值（按**定义形状**认，
       不是按名字白名单 —— 短名撞名正是 Q37 放弃按名扫的原因）。
       ⚠️ 判 needle 必须在**保留字符串**的文本上做：`'};'` 里的 `}` 一剥就没了。 */
    const blockVars = text => {
      const out = [];
      const reS = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*?\\'
        + SERC.slice(0, -1), 'g');
      const reI = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*?\\'
        + IDXC.slice(0, -1), 'g');
      let m;
      while ((m = reS.exec(text))) out.push(m[1]);
      while ((m = reI.exec(text))) {
        const needle = text.slice(m.index + m[0].length).split(')')[0];
        if (needle.indexOf('}') >= 0) out.push(m[1]);
      }
      return out;
    };
    /* 扫出「.slice() 的边界来自 indexOf/search」的每一处，返回**归一化**的调用文本 */
    const sites = (text, vs) => {
      const out = [];
      let k = 0;
      while ((k = text.indexOf(SL, k)) >= 0) {
        const open = k + SL.length;
        let depth = 1, j = open;
        while (j < text.length && depth) { const c = text[j++]; if (c === '(') depth++; else if (c === ')') depth--; }
        const args = text.slice(open, j - 1);
        const viaVar = vs.some(v => new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\b').test(args));
        if (args.indexOf(IDXC) >= 0 || args.indexOf(SERC) >= 0 || viaVar) {
          let s0 = k;                                    // 把接收者一起切进来（`src` / `stSrc` …）
          while (s0 > 0 && /[\w$.]/.test(text[s0 - 1])) s0--;
          out.push(norm(text.slice(s0, j)));
        }
        k = j;
      }
      return out;
    };
    /* 白名单：目前**为空** —— 块尾一律走 closeOf() / bodyOf()。确有非结构边界的正当需求时
       才加进来（并写明理由）；加了之后「多重集相等」会同时盯住「多一处」与「白名单烂成摆设」。 */
    const AL = [];
    /* 判据自检：直接形式 / 变量形式必被抓，「位置语义」与结构边界必被放过（四组各一） */
    const SYN_BAD1 = 'const q = cc' + SL + '0, cc' + IDXC + Q1 + '};' + Q1 + '));';
    const SYN_BAD2 = 'const e = cc' + IDXC + Q1 + '};' + Q1 + '); const q = cc' + SL + '0, e);';
    const SYN_OK1 = 'const i = cc' + IDXC + 'x); const q = cc' + SL + '0, i);';
    const SYN_OK2 = "const b = bodyOf(cc, 'def x(');";
    const n1 = sites(STRIP(SYN_BAD1), []).length;
    const n2 = sites(STRIP(SYN_BAD2), blockVars(SYN_BAD2)).length;
    const n3 = sites(STRIP(SYN_OK1), blockVars(SYN_OK1)).length;
    const n4 = sites(STRIP(SYN_OK2), []).length;
    if (n1 !== 1 || n2 !== 1 || n3 !== 0 || n4 !== 0) {
      err('第 42 节 ⑩ 判据自检不成立：分不出「块尾来自 indexOf/search」（坏）与'
        + '「位置语义 / 结构边界」（好）—— 直接形式 ' + n1 + ' / 变量形式 ' + n2
        + ' / 位置语义 ' + n3 + ' / 结构边界 ' + n4 + '（期望 1 / 1 / 0 / 0）');
      secBad++;
    }
    const got = sites(STRIP(selfNS), blockVars(selfNS));
    blockN = got.length;
    if (got.slice().sort().join('\n') !== AL.slice().sort().join('\n')) {
      const extra = got.filter(s => AL.indexOf(s) < 0);
      const missing = AL.filter(s => got.indexOf(s) < 0);
      if (extra.length) {
        err(`verify.js 里出现了「块尾押在字符首次出现上」的切片（${extra.join(' | ')}）—— `
          + '块尾一律走 closeOf()（括号配平）/ bodyOf()（按缩进）；真的要按位置切，'
          + '就得逐处写进 ⑩ 白名单并说明理由');
      }
      if (missing.length) {
        err(`第 42 节 ⑩ 白名单里有 ${missing.length} 条在文件里已不存在（${missing.join(' | ')}）—— `
          + '删了 / 改了 / 抄了第二份都算，请同步白名单（否则白名单会烂成摆设）');
      }
      if (!extra.length && !missing.length) {
        err(`第 42 节 ⑩：块尾切片的出现次数（${got.length}）与白名单条数（${AL.length}）`
          + '不符 —— 同一处写法被抄了第二份也算');
      }
      secBad++;
    }
  }

  /* ⑪ 取位置的助手 `at()` 不许把 needle 变成**正则**（Q39，2026-10-09）。
     旧实现是「needle 里每个空格换成空白类，再 `new RegExp(...)`」—— 正则源随 needle
     **无上限增长**：把 `tools/review-cards.py` 的 25 KB HTML 模板喂进来时当场
     `SyntaxError: Invalid regular expression: … Stack overflow`（2026-10-09 实测）。
     ⚠️ 它的失败态是**整份门禁崩掉**而不是报红一条：`new RegExp()` 是惰性编译所以不报错，
     到 `.exec()` 才炸 ⇒ 第一眼极易误判成「写法有问题」（Q38 就被它绊了一次）。
     而「拿 `at()` 反查一大段文本的位置」这个动作以后还会出现 ⇒ 要做成机制，不能只写进注释。
     ⇒ 现在改成**纯扫描**（把 needle 按空白切成「空白要求 + 字面段」，逐段走 indexOf）：
     没有规模上限，也就不必再立一条「needle 长度上限」的阈值（阈值要拿理由去撑）。
     判据四条（②③④ 都包 try/catch：`at()` 抛了要**报红一条**，不许把整份门禁带崩）：
       ① 结构：`at()` 的函数体（走 `bodyOf()`）里不许出现建正则的写法 —— 含判据自检
          （合成的坏样本必被抓、好样本必放过）；
       ② 现实数据：25 KB 的真实模板必须返回**正确偏移且不抛**（这一条以前会崩）；
       ③ 构造样本：~36 KB 的「折行」needle 必须命中，且**裸 indexOf 找不到它**
          （证明它真是靠折行匹配过的，不是「恰好一字不差」）；
       ④ 等价表：与**旧实现**逐例相等 —— 折行 / 连续空格要求 ≥ n / 元字符当字面量 /
          空 needle → 0 / 前导空白落在空白段起点 / 找不到 → -1。旧实现只当**参考**照抄在
          这里，样本全是十几字符的短 needle（不会触发它的栈溢出）。
     ⚠️ `new RegExp` / `indexOf(` 这些词一律用拼接造 —— 写字面量会招来自指（本项目老坑）。 */
  let atCases = 0, tplPos = 0;
  {
    const atBody = bodyOf(fs.readFileSync(__filename, 'utf8'), 'function at(');
    const NEWRE = 'new ' + 'RegExp' + String.fromCharCode(40);
    const stripJs = t => String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const hasNewRe = body => stripJs(body).indexOf(NEWRE) >= 0;
    if (!atBody) {
      err('第 42 节 ⑪：verify.js 里找不到 at() 的定义（按 `function at(` 切函数体）——'
        + '改了签名就来更新本断言'); secBad++;
    } else {
      /* ① 结构 + 判据自检 */
      const SYN_BAD = 'function at(t, p) { const r = ' + NEWRE + 'p); return r.index; }';
      const SYN_OK = 'function at(t, p) { return scanInto(t, p); }';
      if (!hasNewRe(SYN_BAD) || hasNewRe(SYN_OK)) {
        err('第 42 节 ⑪ ① 判据自检不成立：分不出「at() 里建正则」（坏）与纯扫描（好）');
        secBad++;
      }
      if (hasNewRe(atBody)) {
        err('at() 的函数体里又出现了「把 needle 变成正则」的写法 —— 正则源随 needle 无上限增长，'
          + '一大段文本会 `Invalid regular expression: … Stack overflow`，而失败态是'
          + '**整份门禁崩掉**（不是报红一条）。取位置一律走扫描（按空白切段 + indexOf）');
        secBad++;
      }
      /* ② 现实数据：review-cards.py 的 25 KB 模板（就是当初崩掉的那一段） */
      try {
        const py = read('tools/review-cards.py');
        const tpl = (/TEMPLATE\s*=\s*u?"""([\s\S]*?)"""/.exec(py) || [])[1] || '';
        if (tpl.length < 8000) {
          err(`第 42 节 ⑪ ② 的样本失效：review-cards.py 的模板只剩 ${tpl.length} 字符 ——`
            + '本判据盯的就是「一大段文本」，模板缩水了请换一个样本');
          secBad++;
        } else {
          tplPos = at(py, tpl);
          if (tplPos !== py.indexOf(tpl)) {
            err(`at() 对 ${tpl.length} 字符的真实模板返回 ${tplPos}，原文字面位置是 ${py.indexOf(tpl)}`
              + ' —— 折行折叠不该改变「原文里本来就有」的匹配位置');
            secBad++;
          }
        }
      } catch (e) {
        err(`at() 喂一大段 needle 时抛了（${e.name}）—— at() 不许把 needle 变成正则`
          + '（needle 一大就栈溢出，整份门禁跟着崩）');
        secBad++;
      }
      /* ③ 构造样本：折行长 needle（原文里一字不差地**找不到**） */
      try {
        const CH = 'alpha beta gamma delta epsilon zeta eta theta';
        const hay = 'PREFIX\n' + Array.from({ length: 800 }, () => CH).join('\n') + '\nSUFFIX';
        const huge = Array.from({ length: 800 }, () => CH).join(' ');
        const pos = at(hay, huge);
        if (pos !== 7) {
          err(`at() 对 ${huge.length} 字符的折行 needle 返回 ${pos}（期望 7）——`
            + '长 needle 要么崩、要么匹配错位');
          secBad++;
        } else if (hay.indexOf(huge) >= 0) {
          err('第 42 节 ⑪ ③ 的样本失效：needle 在原文里一字不差地存在 ⇒ 这条证明不了折行能接回来');
          secBad++;
        }
      } catch (e) {
        err(`at() 喂 ${'~36 KB'} 的折行 needle 时抛了（${e.name}）—— 长 needle 必须能吃下`);
        secBad++;
      }
      /* ④ 等价表：与旧实现逐例相等（`at()` 可以换实现，语义不许变） */
      const refAt = (t, phrase) => {          // 旧实现照抄，只当参考
        const re = new RegExp(String(phrase)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/ /g, '\\s+'));
        const m = re.exec(String(t));
        return m ? m.index : -1;
      };
      try {
        const CASES = [
          ['zz alpha\nbeta zz', 'alpha beta', 3],      // 折行
          ['zz alpha   beta zz', 'alpha beta', 3],     // 原文多空格也算「一个空白」
          ['A B', 'A  B', -1],                         // needle 里 n 个空格 ⇒ 要求 ≥ n 个空白
          ['A  B', 'A  B', 0],
          ['abc', 'xyz', -1],                          // 找不到 → -1
          ['axb', 'a.b', -1],                          // 元字符当**字面量**（不是通配）
          ['a.b', 'a.b', 0],
          ['x axb y', 'x a.b y', -1],                  // 同上，但元字符在第 2 段之后（走 startsWith 那条路）
          ['x a.b y', 'x a.b y', 0],
          ['', '', 0],                                 // 空 needle → 0（沿用旧口径）
          ['  x', ' x', 0],                            // 前导空白 ⇒ 位置落在空白段起点
          ['x y', 'y ', -1],                           // 尾随空白要求原文那里真有空白
          ['src\n  main.js', 'src main.js', 0],
          ['a\tb', 'a b', 0],                          // 制表符也是空白
          ['AA', 'aa', -1],                            // 大小写敏感
        ];
        const badRows = CASES.filter(r => at(r[0], r[1]) !== r[2] || refAt(r[0], r[1]) !== r[2]);
        if (badRows.length) {
          err(`at() 与旧实现的等价表有 ${badRows.length} 条不符（${badRows.map(r => JSON.stringify(r[1])).join(' / ')}）`
            + ' —— 换实现可以，语义不许变：折行折叠、连续空格要求 ≥ n、元字符当字面量、'
            + '空 needle → 0、找不到 → -1');
          secBad++;
        } else {
          atCases = CASES.length;
        }
      } catch (e) {
        err(`第 42 节 ⑪ ④ 等价表执行时抛了（${e.name}）—— at() 不许抛，找不到就返回 -1`);
        secBad++;
      }
    }
  }

  if (!hit.length && !secBad && !bad) {
    ok(`接触表复用 check-cards 的判定（${forbidden.length} 项口径 0 处重复）、`
      + `judge() / judge_group() / slot_verdicts() / slot_tally() 各自唯一入口`
      + `（跨档提示只进 soft；FAIL 清单与提示段同走槽位口径）、`
      + `跨档中位按档投一票、判定按槽位归组（折版规则只在 morph_key() 一处）、`
      + `切函数体只走 bodyOf()、「变量形式的按位置切片」${sliceN} 处全在 ⑨ 白名单内、`
      + `块尾全走结构边界（⑩ 命中 ${blockN} 处，白名单 0 条）、`
      + `at() 是纯扫描（⑪ 等价表 ${atCases} 条逐例相符、25 KB 模板命中位置 ${tplPos}）、`
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
  /* 标签表的**唯一真相**是 `CONFIG.shapeCn`（2026-10-10 起：游戏内图鉴的体型筛选
     与评审台共用同一份）。以前是 review-cards.py 里的一份字面 dict ——
     给图鉴也加体型筛选时顺势提上来了：**两处叫法不同**这种漂移，键集对齐是验不出来的。 */
  const labelKeys = Object.keys(CFG.shapeCn || {});
  if (!/SHAPE_CN\s*=\s*load_shape_cn\(\)/.test(py)) {
    err('review-cards.py 的 SHAPE_CN 不再由 `load_shape_cn()` 从 config.js 派生 —— '
      + '体型中文表出现了第二份拷贝（唯一真相在 `CONFIG.shapeCn`）');
  }
  /* ---------- ①b 钓场名同理：**必须从 fields.js 读**，不许手抄 ------------------
     实证（2026-10-10）：给评审页加「钓场」筛选时我手写了一张表，**七条错了五条**
     —— `fields.js` 的 id 是**倒着排**的（`D` 村口小池塘 → `C` 溪流浅滩 →
     `B` 湖心半岛 → `A` 深海断崖），而手抄时按「A 是第一个钓场」去猜。
     最要命的是它**看上去完全正常**：下拉里有名字、筛出来也有鱼。
     手抄一张「id → 中文名」的表就是会错，所以这里钉住「派生」这件事本身。 */
  if (!/FIELD_CN\s*=\s*dict\(load_fields\(\)\)/.test(py)) {
    err('review-cards.py 的钓场名不再由 `load_fields()` 从 `src/data/fields.js` 派生 —— '
      + '手抄一张钓场名表**一定会错**（实测 id 是倒着排的，第一版七条错了五条）');
  }
  if (!tplKeys.length || !labelKeys.length) {
    err(`第 43 节键集抓不到（fishart 的 TPL ${tplKeys.length} 个 / CONFIG.shapeCn ${labelKeys.length} 个）`
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
      + '图鉴与评审页都会把内部键裸印出来（去 config.js 的 CONFIG.shapeCn 补上）');
  }
  if (extraLabel.length) {
    err(`CONFIG.shapeCn 里有 fishart.js 不存在的键：${extraLabel.join('、')} ——`
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
  /* ⚠️ 第二处允许出现 `d.shape` 的地方：**条件筛选的比较**（2026-10-10 加）。
     它把 `d.shape` 与下拉框的 value 比大小，**从不显示给用户** ——
     「裸印」管的是「用户看到英文键」，比较不在此列。
     ⇒ 只减掉**有名字的**这一处；`render()` 里再出现 `d.shape` 照样报红（负对照见下）。 */
  const fmBody = t => bodyOf(t, 'function facetMatch(');
  const outside = t => bare(t) - bare(tagBody(t)) - bare(fmBody(t));
  /* 判据自检：好样本（裸键在 shapeTag / facetMatch 里）与坏样本（印在 render 里）必须被分开 */
  const SYN_OK = "function shapeTag(d) { return d.shapeCn + '<code>' + d.shape + '</code>'; }\n"
    + "function facetMatch(d) { return d.shape === 'eel'; }\nfunction render() { return 1; }";
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


/* ---------------- 45. 素材路线的硬约束要有机制（文档的「必留 / 已删」两张清单 == 磁盘现状） ----------------
   `docs/AI素材方案.md` §8.4「清理清单」写着两张清单 —— 一张是「⛔ 两个绝对不能删」（`fishpaint.js` /
   `fishart.js`），一张是「3D 撤销时已清理」的产物清单 —— §8.5 还写着「改结论时要连门禁一起改」。
   但 2026-10-08 写下这些时**没有任何东西盯着它们**：规矩写在文档里、没有机制 ⇒ 这条规矩不成立
   （同型已栽多次：2026-10-07 那句「项数不再写进文档」就是这么漂回来的，后来才补了 34-b）。
   本节把两张清单接上机制，形态与 32-b「已清理过的死接口不许复活」**同源** ——
   只是对象从「运行时接口」换成「磁盘文件」。
   三条判据：
     ① 必留：两颗文件必须存在（`fishpaint.js` = 出图管线的颜色口径唯一来源，删了管线当场断；
        `fishart.js` = 3D 一撤之后**唯一活着的画鱼代码**）。
     ② 已删：§8.4 清单里的 3D 产物必须继续**不存在** —— 要复活它就得连 §8.4 / §8.5 与本节
        的清单一起改（一次显式决策），不许悄悄加回来。
     ③ 自检：两张清单都不许为空（空集 ⇒ 断言恒真 = 假通过）。
   🔴 2026-10-09 改：两张清单**不再在 verify 里硬编码**，改成**从 §8.4 现算**
      —— 原先它们是「同一个事实的第二份真相」：文档那张表改了、数组不跟，本节一声不吭
      （只有文件被真删/真复活时才响，**清单本身漂了它不管**）。这与本书反复栽的坑型同源
      （`33-b` 的钓场数字、`34` 的节数都是这个修法）。
      现算规则（先量后改：实测派生结果与旧硬编码**逐元素相等、0 误报**）：
        · MUST_KEEP    = §8.4 里含「必须留」的行中**第一个**反引号里的路径
        · MUST_BE_GONE = §8.4「已删」表的**第一列**里的反引号路径（要求含 `/`，
                         排掉 `改进待办.md` 这类非文件行）
      ⚠️ **只取第一列**是关键：第 2 列「谁在引用」里写着 `tools/test.js` / `fishmesh.js`，
         整行取反引号会把**不该删的**也算进来（实测过）。
      ⚠️ 判据只查**文件在不在**，不查内容 —— 「在不在」是这里唯一要守的不变量。 */
console.log('\n[45] 素材路线的硬约束要有机制（文档的「必留 / 已删」两张清单 == 磁盘现状）');
(function () {
  const ex = rel => fs.existsSync(path.join(ROOT, rel));
  let bad45 = 0;

  /* ---------- 从 docs/AI素材方案.md §8.4「清理清单」现算两张清单 ---------- */
  const docSrc = fs.readFileSync(path.join(ROOT, 'docs/AI素材方案.md'), 'utf8');
  const sec = (docSrc.match(/### 8\.4[\s\S]*?(?=\n### )/) || [''])[0];
  const parse = txt => {
    const keep = [];
    (txt.split('\n')).forEach(line => {
      const m = /`([^`]*)`[^`\n]*必须留/.exec(line);
      if (m) keep.push(m[1]);
    });
    const gone = [];
    (txt.match(/^\|\s*`[^|]*?\s*\|/gm) || []).forEach(col => {
      (col.match(/`([^`]*)`/g) || []).forEach(x => {
        const v = x.slice(1, -1);
        if (v.indexOf('/') >= 0) gone.push(v);
      });
    });
    return { keep: keep, gone: gone };
  };
  /* 判据自检：喂一段合成的 §8.4，确认「只取第一列」与「必须留取第一个」都对 */
  const SYNTH = [
    '### 8.4 清理清单', '',
    '| 已删 | 谁在引用 | 已同步改动 |', '|---|---|---|',
    '| `src/render/aaa.js` | `tools/test.js` / `bbb.js` | x |',
    '| `改进待办.md` 的队列 | — | y |',
    '| `bbb.js` 本身 | — | z |', '',
    '- **`src/render/keep1.js` 必须留** —— 理由',
    '- **`src/render/keep2.js` 必须留，而且更关键** —— 理由', '',
    '### 8.5 下一节', ''].join('\n');
  const self = parse(SYNTH);
  if (self.keep.join() !== 'src/render/keep1.js,src/render/keep2.js'
      || self.gone.join() !== 'src/render/aaa.js'
      || self.gone.indexOf('tools/test.js') >= 0 || self.gone.indexOf('bbb.js') >= 0) {
    err('第 45 节的 §8.4 解析器判据自检不成立：应只取第一列、且「必须留」只取第一个反引号'
      + `（实测 keep=${JSON.stringify(self.keep)} gone=${JSON.stringify(self.gone)}）`);
    return;
  }
  const derived = parse(sec);
  const MUST_KEEP = derived.keep;
  const MUST_BE_GONE = derived.gone;
  if (!sec) { err('docs/AI素材方案.md 里找不到 §8.4 —— 清单的来源没了'); return; }
  if (!MUST_KEEP.length || !MUST_BE_GONE.length) {
    err('第 45 节从 §8.4 现算出的两张清单有一个是空的 —— 空集会让本节断言恒真（判据自检）');
    bad45++;
  }
  MUST_KEEP.forEach(rel => {
    if (!ex(rel)) {
      err(rel + ' 不见了 —— 它是 §8.4 的「⛔ 绝对不能删」：'
        + (rel.indexOf('fishpaint') >= 0
            ? 'paint-card.py 靠 node -e 调它的 palette()，删了出图管线当场断'
            : '游戏内的鱼 / 剪影 / 鱼护与水族箱小图全靠它，删了画面全废'));
      bad45++;
    }
  });
  MUST_BE_GONE.forEach(rel => {
    if (ex(rel)) {
      err(rel + ' 又出现了 —— 3D 路线已撤销（§8.4 清单）：要复活它就得连 '
        + 'docs/AI素材方案.md §8.4「清理清单」/ §8.5 与本节清单一起改，不能悄悄加回来');
      bad45++;
    }
  });
  if (!bad45) {
    ok('§8.4 的两张清单与磁盘一致：必留 ' + MUST_KEEP.length + ' 颗都在、已删 '
      + MUST_BE_GONE.length + ' 项都没复活');
  }
})();


/* ---------------- 46. 反作弊只许 L1 标记（不碰游戏数据、没有处置口） ----------------
   由来（2026-10-09，N2）：`src/core/integrity.js` 是用户点名方向「反作弊」的**第一层**。
   本项目是**纯前端单机** ⇒ 没有服务端、没有权威数据源 ⇒ 做不出安全边界，
   所以这一层的定位是 **L1 标记**：记下来，**不拦、不封、不改任何游戏数据**。
   「只标记」这句话如果不接机制，下一个人加个 `ban()` 就能把它悄悄变成「会处置」——
   本节把它钉成三条可执行的判据：
     ① 不碰游戏数据：整个文件（**剥掉注释**）里不出现 `G.State` / `G.Cheat` 这两个挂载点；
     ② 导出面 = L1 白名单，**恰好**那几个名字（多一个动作就报红）；
     ③ 阈值必须可达：`oddsFloor` / `gapMargin` 这类取值的合法区间**现算** ——
        定在区间外 = 判据永不触发（或恒触发），且不报错、无告警（与第 32-f 节同族）。
   ⚠️ 判据自检：① 的正形态必须被正则认出来、且注释里的同样字样不许算；
             ② 的白名单比较必须**双向**（少一个 / 多一个都要报红）。 */
console.log('\n[46] 反作弊只许 L1 标记（不碰游戏数据、没有处置口）');
(function () {
  const REL = 'src/core/integrity.js';
  const stripC = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/[^\n]*/gm, '$1');
  const raw = fs.readFileSync(path.join(ROOT, REL), 'utf8');
  const js = stripC(raw);
  let bad46 = 0;

  /* ① 挂载点黑名单：本模块不许碰 G.State / G.Cheat（= 不许改任何游戏数据） */
  const BANNED = ['G.State', 'G.Cheat'];
  const reOf = n => new RegExp(n.replace(/\./g, '\\.') + '(?![A-Za-z0-9_$])');
  BANNED.forEach(n => {
    if (reOf(n).test(js)) {
      err(REL + ' 里出现了 ' + n + ' —— 这一层只做 L1 标记（不拦 / 不封 / 不改游戏数据）；'
        + '要动游戏数据说明它被改成「会处置」了，那是 L2/L3 的事（口径见 docs/改进待办.md N2）');
      bad46++;
    }
  });
  if (!reOf(BANNED[0]).test('var x = ' + BANNED[0] + '.get();')) {
    err('第 46 节判据自检不成立：正则认不出 ' + BANNED[0] + ' 的正形态'); bad46++;
  }
  if (reOf(BANNED[0]).test(stripC('/* ' + BANNED[0] + ' */'))) {
    err('第 46 节判据自检不成立：注释没被剥掉（说明注释里的字样会被算成违规）'); bad46++;
  }

  /* ② 导出面 == L1 白名单（顺序无关） */
  const L1 = ['audit', 'clear', 'count', 'flags', 'init', 'note', 'stats'];
  const keys = exportKeys(js).slice().sort();
  if (!keys.length) {
    err(REL + ' 里取不到导出块 —— 改名 / 换写法了，本节必须跟着改，不许当成「没有导出要检查」');
    bad46++;
  } else {
    const extra = keys.filter(k => L1.indexOf(k) < 0);
    const miss = L1.filter(k => keys.indexOf(k) < 0);
    if (extra.length || miss.length) {
      err('G.Integrity 的导出面不是 L1 白名单：多出 [' + extra.join('、') + ']、缺 [' + miss.join('、')
        + '] —— 「只标记不处置」靠导出面保证，多一个 ban / lock / punish 就破了');
      bad46++;
    }
  }
  (function () {
    const cmp = (a, b) => [a.filter(k => b.indexOf(k) < 0), b.filter(k => a.indexOf(k) < 0)];
    if (!cmp(L1.slice(0, -1), L1)[1].length || !cmp(L1.concat(['zzBan']), L1)[0].length) {
      err('第 46 节判据自检不成立：白名单比较分不出「少一个键 / 多一个键」（双向各测一次）'); bad46++;
    }
  })();

  /* ③ 阈值必须可达（区间现算，不写死判定点） */
  const GI = CFG.integrity || {};
  const gate = (name, v, lo, hi, hiOpen) => {
    const bad = !(v > lo) || (hiOpen ? !(v < hi) : !(v <= hi));
    if (bad) {
      err('config.integrity.' + name + ' = ' + v + ' 落在合法区间 (' + lo + ', ' + hi
        + (hiOpen ? ')' : ']') + ' 之外 —— 判据会永不触发或恒触发（不报错、无告警）');
      bad46++;
    }
  };
  gate('oddsFloor', GI.oddsFloor, 0, 1, true);     // 概率上界 ∈ (0,1)：≥1 永不报、≤0 恒报
  gate('gapMargin', GI.gapMargin, 0, 1, false);    // 余量 ∈ (0,1]：>1 会把正常节奏判成「不可能」
  if (!(GI.evCap >= 2)) { err('config.integrity.evCap = ' + GI.evCap + ' —— 物理不可能判据要看「两竿」，至少装得下 2 条'); bad46++; }
  if (!(GI.flagCap >= 1)) { err('config.integrity.flagCap = ' + GI.flagCap + ' —— 标记一条都不留 = 白审'); bad46++; }
  if (!(GI.minOddsK >= 2)) { err('config.integrity.minOddsK = ' + GI.minOddsK + ' —— 样本为 1 就判 = 误报源（『罕见但会发生』）'); bad46++; }

  if (!bad46) {
    ok('反作弊层只做 L1 标记：不碰游戏数据（无 State/Cheat 引用）、导出面恰为 '
      + L1.length + ' 个动作（无 ban/lock）、阈值全部落在可达区间'
      + '（oddsFloor ' + GI.oddsFloor + ' / gapMargin ' + GI.gapMargin + '）');
  }
})();

/* ---------------- 47. 图鉴卡面的回退链（N3-1） ----------------
   本轮第一次把**异步**素材接进**同步**绘制路径。回退链本身只有一句话：
   **有 AI 卡面就用图，拿不到就程序化绘制**。它最容易在三个地方静默失效：
     ① 只有 AI 分支、没有兜底  ⇒ 缺图的鱼在外网就是一块空白（而缺图是常态）；
     ② 只有兜底、没有 AI 分支  ⇒ 接了等于没接（图鉴永远是程序化的，没人会发现）；
     ③ 兜底散落在每个调用点  ⇒ 口径分家（网格用 0.6 的 t、详情用 0.8，谁漏了一处都不知道）。
   ⇒ 判据：**回退链只许有一个入口**（`paintFish()`），两个分支必须在**同一个函数体**里，
      图鉴的两条绘制路径不许绕开它直接调 `G.FishArt.draw`。
   ⚠️ 另有一条「母版禁令」：游戏侧只吃**透明抠图**（`<id>-<档位>.png`），
      `<id>.png` 是灰底母版，只供人工评审。它的**行为**在 test.js 里钉（空档位必须被拒），
      这里盯的是它的**口径来源**：档位名只许来自 `config.colorMorphs`，
      `cardart.js` 里出现任何档位名字面量就报红（写第二份档位表必然分家）。 */
console.log('\n[47] 图鉴卡面回退链：AI 图优先 + 程序化兜底，且只有一处入口');
let fallbackBad = 0;
(function () {
  /* 🔴 连**行尾**注释一起剥（硬规矩 ① 只剥「整行都是注释」的行注释与块注释）。
     本节有两处判据是**数出现次数**的（档位字面量个数、取图口调用次数），
     一句行尾注释写上一个档位字面量就能把它们喂饱 —— 那是本项目踩过两次的坑型
     （见 `docs/改进待办.md`「反向验证里『行尾注释喂饱判据』是独立的一类」）。 */
  const stripC = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const P = 'src/ui/panels.js', C = 'src/render/cardart.js';
  const jsP = stripC(fs.readFileSync(path.join(ROOT, P), 'utf8'));
  const jsC = stripC(fs.readFileSync(path.join(ROOT, C), 'utf8'));
  const count = (t, n) => String(t).split(n).length - 1;

  /* ① 回退链的唯一入口：两个分支必须在同一个函数体里 */
  const entry = bodyOf(jsP, 'function paintFish(');
  if (!entry) {
    err(P + ' 里找不到 `function paintFish(` —— 回退链的入口改名 / 挪走了，'
      + '本节判据必须跟着改，不许当成「没有回退链要检查」');
    fallbackBad++;
  } else {
    if (!has(entry, 'G.CardArt.held(')) {
      err(P + ' 的 paintFish() 里没有 `G.CardArt.held(` —— 只有程序化绘制 = 接了等于没接'
        + '（图鉴永远看不到 AI 卡面）');
      fallbackBad++;
    }
    if (!has(entry, 'G.FishArt.draw(')) {
      err(P + ' 的 paintFish() 里没有 `G.FishArt.draw(` —— 没有兜底：'
        + '缺图 / 坏图 / file:// 下玩家看到的就是一块空白');
      fallbackBad++;
    }
    /* 判据自检：`bodyOf` 必须只切出这一个函数（切宽了会把别人的分支算进来） */
    const synth = 'function paintFish(a) {\n  G.CardArt.held(a);\n}\nfunction other() {\n  G.FishArt.draw(a);\n}';
    const sb = bodyOf(synth, 'function paintFish(');
    if (has(sb, 'G.FishArt.draw(') || !has(sb, 'G.CardArt.held(')) {
      err('第 47 节判据自检不成立：bodyOf() 把 paintFish 之外的函数也算进来了'); fallbackBad++;
    }
  }

  /* ② 四条绘制路径不许绕开入口（直接调 FishArt.draw = 那条路没有 AI 卡面）
     ⚠️ marker 一律写成完整字面量（第 ㊷ 节 ⑧ 盯这个）：拼出来的 marker 它会看不见。
     🔎 Q9 起把**鱼护 / 水族箱**两条也收进来 —— 它们原来各写一遍 `G.FishArt.draw`，
        于是「图鉴里是 AI 图、鱼护里是程序化图」，同一个事实两条口径。 */
  const pathBook = bodyOf(jsP, 'function paintBookItem(');
  const pathDetail = bodyOf(jsP, 'function renderFishDetail(');
  const pathMini = bodyOf(jsP, 'function miniFish(');
  const pathTank = bodyOf(jsP, 'function tankSprite(');
  const pathCatch = bodyOf(jsP, 'function showCatch(');
  [[pathBook, 'paintBookItem', '图鉴网格'], [pathDetail, 'renderFishDetail', '图鉴详情页'],
   [pathMini, 'miniFish', '鱼护 / 水族箱列表小图'], [pathTank, 'tankSprite', '水族箱精灵'],
   [pathCatch, 'showCatch', '结算卡（刚钓上来那条鱼）']]
    .forEach(([b, fn, cn]) => {
      if (!b) {
        err(P + ' 里找不到 `function ' + fn + '(`（' + cn + '）—— 改名了就来更新本节');
        fallbackBad++;
        return;
      }
      if (has(b, 'G.FishArt.draw(')) {
        err(P + ' 的 ' + fn + '()（' + cn + '）里直接调了 `G.FishArt.draw(` —— '
          + '必须经 paintFish()：绕开入口的那条路没有 AI 卡面，而且两处口径会分家');
        fallbackBad++;
      }
      if (!has(b, 'paintFish(')) {
        err(P + ' 的 ' + fn + '()（' + cn + '）里没有调 paintFish() —— 这条路上没有任何鱼被画出来');
        fallbackBad++;
      }
    });

  /* ②-b 档位（tier）：每个绘制点必须**自己声明**要多大的图，而且声明得对。
     病根形态很安静：档位写反不报任何错 —— 小框用详情档 = 白下 10 倍流量（图鉴一屏 362 项），
     大框用列表档 = dpr>1 时发虚。两件事都只有真看画面才发现。
     🔴 判据里**不许出现档位名的第二份真相**：合法档位集合从 `assets.js` 的 `TIER_SUB` 现算。 */
  const jsA = stripC(fs.readFileSync(path.join(ROOT, 'src/core/assets.js'), 'utf8'));
  const tierTab = /var TIER_SUB = \{([^}]*)\}/.exec(jsA);
  /* ⚠️ 取 `tier: '<字面量>'` 只认带引号的写法：`tier: xxx` 这种变量形式**认不出来**，
     所以要额外断言「box 里的 tier 全是字面量」，否则判据会被变量喂饱（硬规矩 ⑨ 同族）。 */
  const tierLits = (jsP.match(/tier:\s*'([a-z]+)'/g) || []).map(s => /'([a-z]+)'/.exec(s)[1]);
  const paintCalls = count(jsP, 'paintFish(') - 1;         // 减掉 `function paintFish(` 那一处
  if (!tierTab) {
    err('src/core/assets.js 里找不到 `var TIER_SUB = {...}` —— 卡面档位表是唯一真相，'
      + '挪走 / 改名了就来更新本节（取不到就报错，不许静默跳过）');
    fallbackBad++;
  }
  if (tierLits.length !== paintCalls) {
    /* ⚠️ 这条报错文案里**不许再套单引号** —— 上一版写成 `' 个 `tier: '<字面量>'` —— ...'`，
       内层的单引号把 JS 字符串提前闭掉，整句变成 `"…" < 字面量 > "…"`：**语法合法**（CJK 是合法
       标识符），于是它躲过了「文件写崩」的直觉，只在判据真的要报红时抛 ReferenceError。
       表现正是本项目最怕的那种：退出码 1、却没有「自检未通过」——反向验证 V5 当场逮到。 */
    err(P + ' 有 ' + paintCalls + ' 处 paintFish() 调用，但只写了 ' + tierLits.length
      + ' 个 `tier:` 加字面量 —— 少写的那些会拿不到对应的档，静默回退程序化绘制'
      + '（写成变量的那处本条也认不出来，一并算「少写」）');
    fallbackBad++;
  }
  const TIER_OF = [['function paintBookItem(', 'list', '图鉴网格 260×112'],
    ['function renderFishDetail(', 'detail', '图鉴详情 380×190'],
    ['function miniFish(', 'list', '鱼护 / 水族箱列表小图 96×52'],
    ['function tankSprite(', 'detail', '水族箱精灵（宽 2.2L）'],
    ['function showCatch(', 'detail', '结算卡 360×200']];
  TIER_OF.forEach(([mk, want, cn]) => {
    const b = bodyOf(jsP, mk);
    if (b && !has(b, "tier: '" + want + "'")) {
      err(P + ' 的 ' + cn + ' 用的不是 `' + want + '` 档 —— 写反不报错：'
        + '小框用详情档白下 10 倍流量，大框用列表档在高 dpi 屏上发虚');
      fallbackBad++;
    }
  });

  /* ③ 取用口只许出现在入口里（别处要画鱼必须走入口，否则又会冒出一处「没有兜底的取图」）
     ⚠️ **白名单**（逐条写「哪个函数里几次」；marker 一律写成**完整字面量** —— 拼出来的
        marker 第 ㊷ 节 ⑧ 看不见它）：写多、写少、条目指向的函数被改名，三种都报红。
        · `held` 在 `tankSprite()` 里还有 1 处 —— 它要**先**知道有没有图才能定精灵的框尺寸
          （卡面 2:1、程序化要按 L 留外晕 pad），而那个判定发生在 `paintFish` 体内，
          外面拿不到。它只用来**选尺寸 / 拼精灵键**，图本身仍然只由 `paintFish` 贴上去。
          尺寸一旦定错（拿程序化的框装卡面）会**静默**画成拉伸 / 切边，所以这处有
          测试兜着（`test.js`「鱼护 / 水族箱真的走卡面」那一段）。
        · `want` 一处都不许外放：要图 = 要有人重画，那件事只有入口说得清。 */
  const GATE_ALLOW = [
    { call: 'G.CardArt.held(', fn: 'function paintFish(', n: 1 },
    { call: 'G.CardArt.held(', fn: 'function tankSprite(', n: 1 },
    { call: 'G.CardArt.want(', fn: 'function paintFish(', n: 1 },
  ];
  const callSet = [];
  GATE_ALLOW.forEach(e => { if (callSet.indexOf(e.call) < 0) callSet.push(e.call); });
  callSet.forEach(call => {
    const all = count(jsP, call);
    const rows = GATE_ALLOW.filter(e => e.call === call);
    const got = rows.map(e => count(bodyOf(jsP, e.fn) || '', call));
    const sum = got.reduce((s, v) => s + v, 0);
    const desc = rows.map((e, i) => e.fn.replace('function ', '').replace('(', '')
      + ' ' + got[i] + '/' + e.n).join('、');
    if (all !== sum || rows.some((e, i) => got[i] !== e.n)) {
      err(P + ' 里 `' + call + '` 共 ' + all + ' 处，白名单是 ' + desc + ' —— 取图口只许留在'
        + '入口那一处（散出去就会出现「取了图但没兜底」的路径）；确实要多一处就写进'
        + '第 47 节 ③ 的白名单并说明理由');
      fallbackBad++;
    }
    if (all === 0) {
      err(P + ' 里一处 `' + call + '` 都没有 —— 回退链没接上（或写法变了，来更新本节）');
      fallbackBad++;
    }
  });
  /* 自检：计数口径必须认得出「多出来的那一处」 */
  if (count('a G.CardArt.want( b G.CardArt.want(', 'G.CardArt.want(') !== 2) {
    err('第 47 节判据自检不成立：调用点计数认不出重复出现'); fallbackBad++;
  }

  /* ④ 档位名只许来自 config.colorMorphs（母版禁令的口径来源） */
  if (!jsC) {
    err(C + ' 读不到内容 —— 文件被删 / 改名了？'); fallbackBad++;
  } else {
    const lit = CFG.colorMorphs.filter(cm => new RegExp('\\b' + cm.key + '\\b').test(jsC)).map(cm => cm.key);
    if (lit.length) {
      err(C + ' 里出现了档位名 ' + lit.join('、') + ' —— 档位表只许来自 '
        + 'config.colorMorphs（写第二份必然分家；本节同样拦「顺手放行某个档位」）。'
        + '⚠️ 判据按**词边界**扫，不是只扫引号形式 —— 写成对象键 `{ golden: 1 }` 也算违规');
      fallbackBad++;
    }
    /* 判据自检：两种写法（带引号 / 当对象键）都必须被认出来，正常写法不许误报 */
    const probeKey = CFG.colorMorphs[CFG.colorMorphs.length - 1].key;
    if (!new RegExp('\\b' + probeKey + '\\b').test("var a = '" + probeKey + "';")
        || !new RegExp('\\b' + probeKey + '\\b').test('var m = { ' + probeKey + ': 1 };')
        || new RegExp('\\b' + probeKey + '\\b').test('var ' + probeKey + 'ish = 1;')) {
      err('第 47 节判据自检不成立：档位名词边界扫描分不出「引号形式 / 对象键形式」与「同前缀的别的标识符」');
      fallbackBad++;
    }
    if (!has(jsC, 'colorMorphs')) {
      err(C + ' 里没有 `colorMorphs` —— 档位校验收哪去了？空档位（灰底母版）会溜进游戏');
      fallbackBad++;
    }
    /* 空档位必须被显式拒绝：这是「母版不进游戏」那句注释的**代码证据** */
    const km = bodyOf(jsC, 'function knownMorph(');
    if (!km || !/if\s*\(!\s*morph\s*\)\s*return\s+null/.test(km)) {
      err(C + ' 的 knownMorph() 里没有「空档位直接返回 null」—— 空档位会拼出 `<id>.png`'
        + '（灰底母版），贴进图鉴的浅蓝底上会糊一块灰方块');
      fallbackBad++;
    }
  }

  /* ⑤ 🔴 **跨文件同源**：`assets.js` 的目录 / 档位表必须与 `tools/prep-cards.py` 的
     `OUT_DIR` / `LIST_SUB` / `SPEC` 现算相等。
     这是本节最值钱的一条：两处都不是「同一份代码里的两个地方」，而是**两种语言的两份真相**
     —— JS 说 `assets/cards-ui/list/`、python 往别处写，没有任何编译器管得着，
     表现是**全体静默 404 ⇒ 所有鱼回退程序化绘制**，而画面「看起来还行」。
     ⚠️ 档位**集合**也要对拍（不多不少）：多一个档 = 指向一个没人产出的目录；
        少一个档 = `prep-cards.py` 白出一半的图（零消费方）。 */
  const prepSrc = fs.readFileSync(path.join(ROOT, 'tools', 'prep-cards.py'), 'utf8');
  const mOutDir = /OUT_DIR = os\.path\.join\(ROOT, "assets", "([^"]+)"\)/.exec(prepSrc);
  const mListSub = /LIST_SUB = "([^"]+)"/.exec(prepSrc);
  /* 档位**集合**从 python 里现算：`assert_spec()` 的 `for _k in ("detail", "list")` 是
     prep-cards.py 里唯一一处把「有哪些档」列全的地方（它同时是「两档尺寸都得等于 padAspect」
     那道自校验的枚举）。⛔ 不许在 verify 里抄一份 `['detail','list']` —— 那就是第三份真相。 */
  const mTierTuple = /for _k in \(([^)]*)\)/.exec(prepSrc);
  const prepTiers = (mTierTuple ? (mTierTuple[1].match(/"([a-z]+)"/g) || []) : [])
    .map(s => s.replace(/"/g, ''));
  if (!mOutDir || !mListSub || prepTiers.length !== 2) {
    err('tools/prep-cards.py 里读不出 OUT_DIR / LIST_SUB / 档位元组（取不到就报错，不许静默跳过）');
    fallbackBad++;
  } else if (tierTab) {
    const table = {};
    tierTab[1].split(',').forEach(kv => {
      const m = /^\s*([a-z]+)\s*:\s*'([^']*)'\s*$/.exec(kv);
      if (m) table[m[1]] = m[2];
    });
    const wantDir = 'assets/' + mOutDir[1] + '/';
    const jsDir = /var CARD_DIR = '([^']+)'/.exec(jsA);
    if (!jsDir || jsDir[1] !== wantDir) {
      err('卡面目录两处不一致：assets.js 说 `' + (jsDir ? jsDir[1] : '(读不出)')
        + '`、prep-cards.py 往 `' + wantDir + '` 写 —— 全体静默 404 ⇒ 所有鱼回退程序化绘制');
      fallbackBad++;
    }
    const names = Object.keys(table).sort().join(',');
    if (names !== prepTiers.slice().sort().join(',')) {
      err('卡面档位集合两处不一致：assets.js 有 [' + names + ']、prep-cards.py 有 ['
        + prepTiers.join(',') + '] —— 多一个档指向没人产出的目录，少一个档那份图零消费方');
      fallbackBad++;
    }
    if (table.detail !== '' || table.list !== mListSub[1] + '/') {
      err('卡面档位的子目录两处不一致：assets.js 是 detail=`' + table.detail + '` / list=`'
        + table.list + '`、prep-cards.py 的 LIST_SUB 是 `' + mListSub[1] + '`');
      fallbackBad++;
    }
    /* 判据自检：集合比较必须认得出「多一个档」与「少一个档」（拿合成样本试） */
    const same = (a, b) => Object.keys(a).sort().join(',') === b.slice().sort().join(',');
    if (!same({ detail: '', list: '' }, prepTiers) || same({ detail: '', list: '', tiny: '' }, prepTiers)
        || same({ detail: '' }, prepTiers)) {
      err('第 47 节判据自检不成立：档位集合比较分不出「相等 / 多一个 / 少一个」'); fallbackBad++;
    }
  }

  if (!fallbackBad) {
    ok('回退链只有一处入口（paintFish 里 AI 图 + 程序化兜底同处一体），'
      + '图鉴网格 / 详情页 / 鱼护小图 / 水族箱精灵 / 结算卡五条路都不绕开它，取图口没有散出去，'
      + '颜色档只来自 config；**档位（tier）**：' + paintCalls + ' 个绘制点各自声明、'
      + '必须是 list / detail 里对的那一个，且目录与档位集合与 `tools/prep-cards.py` 现算一致');
  }
})();


/* ---------------- 48. 源码里的文档节号引用必须连标题一起写 ----------------
   🔎 由来（2026-10-09，自动化轮）：`src/core/assets.js` 的「规格：」行指着
   开发者文档的第 7 节 —— 而第 7 节是「存档与兼容」，素材表其实在 17.13。
   **照这行注释去翻文档的人一定先翻错一节**，而且错了不报任何错：
   引用不是代码，没有编译器管它（同一个错还在 `tools/test.js` 的 Assets 段头抄了一遍）。

   判据：扫描面里每个文件，凡出现「文档文件名 + 节号」形态的引用，
   **必须紧跟该节标题**（写在「」里），且标题必须真能在那份文档的**该节号**下找到。
   ⇒ 节号写错 / 标题抄错 / 文档改了标题忘同步，三种都当场报红。

   ⚠️ 扫描面 = `src/` 下的 `.js` + `tools/` 下的 `.js` / `.py`（2026-10-09 扩面）。
      分界线就是**「引用前面带不带 `docs/` 全路径」**：带 ⇒ 指文档；
      不带 ⇒ 指本文件自己的节（`verify.js` 里实测 65 处，天生不匹配）。
      扩面前担心「套同一条规则会大面积误伤」，实测下来**误报 0**（带路径的引用共 15 处）。
      已知网眼：写成「裸文件名 + 节号」（不像现在这样带 `docs/`）会溜过去 ——
      实测当前 **0** 处，等真出现再加网（那时才有样本可验「网真的抓得住」）。
   ⚠️ 豁免清单只许放「**暂时不能改**」的文件（生图在跑时的 `gen-art.py` 就是这么一例），
      且必须写明**还账条件**；豁免条目**必须仍然命中至少一处**，否则报红 ——
      不许让豁免活过它要遮的那个问题。
   ⚠️ 自指防线：本节说明与错误文案里**不写**完整形态的样例（那会被自己扫到）；
      示例一律用不含真文档名 / 不含数字节号的占位写法。 */
console.log('\n[48] 源码里的文档节号引用必须连标题一起写（节号 / 标题对不上就报红）');
let refBad = 0, refFound = 0, refExempt = 0;
(function () {
  const files = [];
  [['src', /\.js$/], ['tools', /\.(js|py)$/]].forEach(function (scan) {
    (function walk(dir) {
      fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
        const rel = dir + '/' + name;
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (scan[1].test(name)) files.push(rel);
      });
    })(scan[0]);
  });

  /* 豁免（文件 → 原因，原因里必须写还账条件）。只许放「暂时不能改」的文件。 */
  const EXEMPT = {
    'tools/gen-art.py': '生图批次在跑时它是禁区，改它要等批次停；'
      + '批次停后把画风与颜色标准 §7.4 那处补上标题「生成参数（v8/v9 实测值）」，然后删掉本条豁免',
  };
  const hit = {};

  /* 归一化：两边的写法本来就允许不同（行内代码 / 粗体 / 空白都不算差异） */
  const norm = s => String(s).replace(/[`*]/g, '').replace(/\s+/g, '');
  /* 引用形态 = `docs/` + 文件名 + 节号 +（**必须有**）「标题」。
     ⚠️ 标题那一组是**可选**的 —— 第一版写成必选，反向验证当场发现：
       把标题删掉之后这处引用**整个匹配不上**，于是「不带标题」反而溜过去（绿）。
       ⇒ 匹配要能认出「没有标题」这种形态，再单独报「你没带标题」。
     ⚠️ 节号必须是**数字** —— 占位写法（`§<节号>`）不匹配，写说明时不会自己逮自己。 */
  const REF = /docs\/([0-9A-Za-z._\-\u4e00-\u9fa5]+\.md)[^\S\n]*§[^\S\n]*([0-9]+(?:\.[0-9]+)*)[^\S\n]*(?:「([^」\n]+)」)?/g;
  /* 标题行：`## 7. xxx` / `### 17.13 xxx` / （别的文档允许 `## §1 xxx`） */
  const headRe = num => new RegExp('^#{2,4}[^\\S\\n]*§?[^\\S\\n]*'
    + num.replace(/\./g, '\\.') + '\\.?[^\\S\\n]+(.*)$', 'gm');

  files.forEach(rel => {
    /* 反引号一并剥掉：文档名包在反引号里与不包，是同一个引用（占位写法，不写真文档名/节号） */
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/`/g, '');
    REF.lastIndex = 0;
    let m;
    while ((m = REF.exec(txt))) {
      refFound++;
      hit[rel] = (hit[rel] || 0) + 1;
      const docRel = 'docs/' + m[1], num = m[2], rawTitle = m[3];
      if (rawTitle === undefined) {
        if (EXEMPT[rel]) { refExempt++; continue; }   /* 暂时不能改的文件：只放过「没写标题」这一项 */
        err(`${rel} 引用了 ${docRel} 的第 ${num} 节，但**没写该节标题** —— `
          + '`docs/<文件名>.md` + 节号 + 「标题」三件套缺一不可（节号会漂，标题不会）');
        refBad++;
        continue;
      }
      const want = norm(rawTitle);
      const p = path.join(ROOT, docRel);
      if (!fs.existsSync(p)) {
        err(`${rel} 引用了不存在的文档 ${docRel}（第 ㊽ 节）`);
        refBad++;
        continue;
      }
      const titles = [];
      const re = headRe(num);
      let h;
      while ((h = re.exec(fs.readFileSync(p, 'utf8')))) titles.push(norm(h[1]));
      if (!titles.length) {
        err(`${rel} 指向 ${docRel} 的第 ${num} 节，但那份文档里没有这个节号的标题`);
        refBad++;
        continue;
      }
      if (!titles.some(t => t.indexOf(want) >= 0)) {
        err(`${rel} 把 ${docRel} 第 ${num} 节写成「${m[3]}」，`
          + `而文档里那一节叫「${titles[0]}」—— 照它翻文档会翻错一节`);
        refBad++;
      }
    }
  });
  /* 抓不到就报错：豁免条目必须仍然命中，否则它已经没用了（问题修完了 / 文件被改了） */
  Object.keys(EXEMPT).forEach(f => {
    if (!hit[f]) {
      err(`第 ㊽ 节的豁免「${f}」现在一处引用都命中不到 —— 它要遮的问题已经没了，请删掉这条豁免`);
      refBad++;
    }
  });
  if (!refFound) {
    err('源码下一处「文档文件名 + 节号」形态的引用都找不到 —— 要么全删了、'
      + '要么写法变了（改了措辞就来更新第 ㊽ 节）');
    refBad++;
  }
})();
if (!refBad) {
  ok(`源码里 ${refFound} 处文档节号引用都连标题写，且标题与文档里该节的实际标题相符`
    + `（含 tools/；另有 ${refExempt} 处按豁免待还账）`);
}



/* ---------------- 49. SS / SSS 两场的奇幻点题（逐条描述 + 四张网） ----------------
   由来（2026-10-09 晚，用户口径）：「SS 鱼场和 SSS 渔场的鱼的名字基本都不是现实中的鱼了，
   都有一定的奇幻元素，看看现有的提示词是不是还是不够奇幻，一定要符合它的名称，
   使生成的图看起来就比前面渔场的要高级」。

   第一版（分场语汇 `SS_MOTIFS` / `SSS_MOTIFS` + `deep_motif()`）**已作废**，原因是实测数字：
   病根不在「句子不够奇幻」，在**门开得太小 + 语汇没覆盖名字** ——
   旧表唯一的门是 `rar == 3`，180 条里只有 15 条真拿到句子，另外 165 条一个字都没有。

   第二版（2026-10-10，用户口径「你写几版提示词分别生图让我看一下」→ 选定 E 版 →
   「就按这个方向，每一条都对着名字重写」）：改成**逐条**写 ——
   `DEEP_LINES` 一鱼一条、每条两句，句子由那条鱼**自己的名字**推出。
   实测代价：180 条 × 2 句全部手写，但换来「名字里说什么，图上就画什么」。

   本节钉住五件事（都在 `tools/gen-art.py` 里，**不依赖 python** —— `verify` 跑不了外部命令）：
     ① **结构**：七张表都在；`check_deep_motifs()` 是**模块级**调用且**恰好一处**
        （定义了没人调 = 和没有一样）；
     ② **四张网真的在函数体里**：覆盖网（`missing`）、多行网（`extra`）、用词纪律
        （`DEEP_MOTIF_BANNED`）、太短网（`< 12` 词）、否定式网（`NEG_RE` + `BODY_RE`）；
     ③ **唯一入口 + 提前 return**：`build_deep_prompt(` / `deep_lines(` 各只许**一处**调用点
        （定义行不算），且 `build_prompt` 里那道 `in DEEP_FIELDS` 必须在 `rar_i == 3` **之前**
        ——它提前 return，写在后面这 180 条会掉进旧表；
     ④ **用词纪律的静态版**：`DEEP_LINES` 里**每一句**都不许含形态档案里的高频词
        （实测 glowing 覆盖 140/180 条 —— 拿「会发光」当奇幻卖点等于什么都没说），
        也不许用**否定式**描述身体缺什么（实测 `with no legs` 反而让龙长出四条腿）。
        ⚠️ 这条在本节里做静态扫描，比 `check_deep_motifs()` 更早生效（`git commit` 时就拦得住）。
     ⑤ **五档锚点**：颜色句必须是 `palette_color(f)` **原样**接 `shade_for(morph, f)`
        —— `build_morph_prompt()` 靠 `p.replace(pc, …)` 换那半句，少一个字就整批抛
        `RuntimeError`（或更糟：换不上却没报错，五档与母版分家）。 */
console.log('\n[49] SS / SSS 奇幻点题：逐条描述、唯一入口、用词纪律');
let deepBad = 0;
(function () {
  const REL = 'tools/gen-art.py';
  const raw = fs.readFileSync(path.join(ROOT, REL), 'utf8');
  /* 只剥**整行注释**（`^\s*#`）—— 句子与键都在字符串里，粗暴剥 `#` 会把它们一起削掉。
     ⚠️ 结构性判据用剥过的；④ 抽句子用**原文**（句子本身就该被读到）。 */
  const code = raw.replace(/^[ \t]*#[^\n]*$/gm, '');

  /* ① 结构：七张表 + 模块级调用恰一处 */
  ['DEEP_LINES', 'DEEP_LEAD', 'DEEP_FIELDS', 'DEEP_COLOR_HEAD', 'DEEP_ANCHOR',
   'DEEP_MOTIF_BANNED', 'DEEP_BANNED_NEG'].forEach(n => {
    if (!new RegExp('^' + n + ' = ', 'm').test(code)) {
      err(REL + ' 里找不到 `' + n + ' = ` —— 逐条骨架的表没了/改名了，本节要来更新');
      deepBad++;
    }
  });
  const calls = (code.match(/^check_deep_motifs\(\)$/gm) || []).length;
  if (calls !== 1) {
    err(REL + ' 的 `check_deep_motifs()` 不是**恰好一处**顶格调用（实得 ' + calls + ' 处）—— '
      + '定义了没人调 = 漏词 / 缺行照样能出图，这张网等于没有');
    deepBad++;
  }

  /* ② 四张网真的写在函数体里 */
  const ck = bodyOf(code, 'def check_deep_motifs(');
  if (!ck) {
    err(REL + ' 里找不到 `def check_deep_motifs(` —— 改名了就来更新本节（不许当成「没有网要检查」）');
    deepBad++;
  } else {
    [['missing', '覆盖网（有鱼没命中）'], ['extra', '多行网（表里有鱼表里没有的行）'],
     ['DEEP_MOTIF_BANNED', '用词纪律（句子里用了禁用词）'],
     ['NEG_RE', '否定式网（否定词 + 身体部位）'], ['BODY_RE', '否定式网的身体部位词表']]
      .forEach(([n, what]) => {
        if (!has(ck, n)) { err(REL + ' 的 check_deep_motifs() 里没有 ' + what + ' —— 网格缺一张'); deepBad++; }
      });
    /* 太短网：`len(txt.split()) < 12` —— 少于 12 词的句子定不住形，等于没写 */
    if (!/< 12\b/.test(ck) || !has(ck, 'txt.split()')) {
      err(REL + ' 的 check_deep_motifs() 里没有「太短网」（找不到 `len(txt.split()) < 12`）—— '
        + '一句 6 个词的描述定不住形，实测等于没写');
      deepBad++;
    }
  }

  /* ③ 唯一入口 + 提前 return + 顺序 */
  const cnt = (t, n) => (t.match(new RegExp('(^|[^\\w.])' + n + '\\(', 'g')) || []).length;
  const entryDeep = bodyOf(code, 'def build_deep_prompt(');
  const entryLines = bodyOf(code, 'def deep_lines(');
  const bp = bodyOf(code, 'def build_prompt(');
  if (!entryDeep || !entryLines || !bp) {
    err(REL + ' 里找不到 `def build_deep_prompt(` / `def deep_lines(` / `def build_prompt(` 之一 '
      + '—— 改名了就来更新本节');
    deepBad++;
  } else {
    /* 调用点 = 全文件里的调用数 − 定义行自己那一次。
       ⚠️ 必须**先剥掉文档字符串**：说明里常提到别的函数名，不剥就会多数一处（本节第一次跑就栽在这里）。 */
    const noDoc = code.replace(/"""[\s\S]*?"""/g, '""');
    const deepCalls = cnt(noDoc, 'build_deep_prompt') - 1;
    const lineCalls = cnt(noDoc, 'deep_lines') - 1;
    if (deepCalls !== 1 || lineCalls !== 1) {
      err('逐条骨架的调用点不是各一处（build_deep_prompt ' + deepCalls + ' / deep_lines '
        + lineCalls + '）—— 点题要**只能从 build_prompt 里出一道门**，'
        + '散出去就会出现「同一句被加两遍」或「某条鱼两条路都走」');
      deepBad++;
    }
    /* 提前 return：不是 return 就会继续往下拼「解剖档案」，逐条描述被冲淡 */
    if (!has(bp, 'return build_deep_prompt(f, morph)')) {
      err('`build_prompt()` 里 SS / SSS 那道门**不是提前 return**（找不到 `return build_deep_prompt(f, morph)`）'
        + '—— 不 return 就会接着拼「解剖档案 + 稀有度递进」，逐条描述被冲淡');
      deepBad++;
    }
    const iDeep = at(bp, 'in DEEP_FIELDS');
    const iRar = at(bp, 'rar_i == 3');
    if (iDeep < 0 || iRar < 0) {
      err('build_prompt() 的两道门不齐（按钓场 ' + (iDeep >= 0 ? '在' : '缺')
        + ' / 按稀有度 ' + (iRar >= 0 ? '在' : '缺') + '）');
      deepBad++;
    } else if (iDeep > iRar) {
      err('build_prompt() 里两道门的**顺序反了**（按稀有度写在按钓场之前）—— '
        + 'SS/SSS 那 15 条传说鱼会走旧表，逐条描述静默少 15 条（能跑，所以更危险）');
      deepBad++;
    }
  }

  /* ④ 用词纪律（静态扫 `DEEP_LINES` 里的每一句） */
  const dictBlock = (name) => {
    const i = code.indexOf(name + ' = {');
    if (i < 0) return '';
    const e = closeOf(code, code.indexOf('{', i));
    return e > 0 ? code.slice(i, e) : '';
  };
  const BANNED = ['glow', 'glowing', 'luminous', 'translucent', 'crystalline', 'concentric',
    'ring', 'rings', 'sparkle', 'sparkling', 'glitter', 'glittering', 'glint', 'scintillating'];
  const NEGW = ['with no', 'without', 'legless'];
  const BODY = ['legs', 'limbs', 'arms', 'fins', 'eye', 'eyes', 'mouth', 'tail', 'head', 'jaw', 'scales'];
  const wordRe = (w) => new RegExp('\\b' + w.replace(/ /g, '\\s+') + '\\b', 'i');
  const scanSentence = (s) => {
    const bad = [];
    BANNED.filter(w => new RegExp('\\b' + w + '\\b', 'i').test(s)).forEach(w => bad.push('禁用词 ' + w));
    if (NEGW.some(w => wordRe(w).test(s)) && BODY.some(w => new RegExp('\\b' + w + '\\b', 'i').test(s))) {
      bad.push('否定式说身体缺什么');
    }
    if (String(s).trim().split(/\s+/).length < 12) bad.push('少于 12 词');
    return bad;
  };
  const dl = dictBlock('DEEP_LINES');
  const lits = dl ? [...dl.matchAll(/'([^'\n]{20,})'/g)].map(m => m[1]) : [];
  if (lits.length !== 180) {
    err('DEEP_LINES 里认出 ' + lits.length + ' 句（应为 180，每条鱼两句里的「句子段」）—— '
      + '取不到句子 = 本节判据恒真（必须报错而不是放行）；条目数对不上就来更新本节');
    deepBad++;
  }
  const badSent = [];
  lits.forEach(s => {
    const b = scanSentence(s);
    if (b.length) badSent.push(b.join('/') + ' → ' + s.slice(0, 56));
  });
  if (badSent.length) {
    err('逐条描述里有 ' + badSent.length + ' 句不合格 —— '
      + '「会发光 / 否定式说缺什么 / 太短」这三类都是实测踩过的坑：\n     ' + badSent.join('\n     '));
    deepBad++;
  }
  /* 判据自检：**期望值表**（句子, 该不该被判为坏）。
     ⚠️ 夹具自己是踩过的坑的复现：`ring` 只许按词边界（不许命中 creeping / growth 之外的词）、
        `without hurry` 这类正常说法不许被否定式网误伤、长句不许被太短网误判。 */
  const SELFCHECK = [
    ['thin luminous veins running in long straight lines across its flat body', true],
    ['deep concentric growth-ring bands wrapped around the body from end to end', true],
    ['a coiled body with no legs at all along the whole length of this creature', true],
    ['an armoured beast without limbs crawling slowly over the cold dark stone', true],
    ['a pale stone slab', true],                       /* 太短：定不住形 */
    ['a cold frost-white film creeping across the facets of a slow stone body', false],
    ['thin embossed veins drawn straight across the facets of its wide ancient body', false],
    ['a long serpent that moves without hurry through the deep and silent water', false],
  ];
  const wrong = SELFCHECK.filter(([s, want]) => (scanSentence(s).length > 0) !== want)
    .map(([s, want]) => '「' + s.slice(0, 44) + '…」应为' + (want ? '坏' : '好') + '句，判反了');
  if (wrong.length) {
    err('第 49 节判据自检不成立（' + wrong.length + '/' + SELFCHECK.length + ' 条夹具判反）：\n     '
      + wrong.join('\n     '));
    deepBad++;
  }

  /* ⑤ 五档锚点 + 三条「口径不许被悄悄放开」的守卫 */
  if (entryDeep) {
    /* 颜色句必须原样留着 `palette_color(f)`：五档的替换是 `p.replace(pc, …)`，
       缺了它 `build_morph_prompt()` 会抛 RuntimeError；而 shape 一变（例如按体型换成
       `palette_color(f, shape)`）锚点就变了 —— 那时必须回来更新本节，不许静默改口径。 */
    if (!has(entryDeep, 'palette_color(f)')) {
      err('`build_deep_prompt()` 里没有 `palette_color(f)` 原样出现 —— '
        + '五档靠 `p.replace(pc, …)` 换那半句，锚点一变整批五档会抛 RuntimeError 或静默分家');
      deepBad++;
    }
    if (!has(entryDeep, 'shade_for(morph, f)')) {
      err('`build_deep_prompt()` 里没有 `shade_for(morph, f)` —— '
        + '背腹明暗是 `paint-card.py` 灰度渐变映射的前提（见 `build_morph_prompt` 的注释），'
        + '少了它明暗差会直接变成颜色差');
      deepBad++;
    }
    if (!/def build_deep_prompt\(f, morph=None\)/.test(code)) {
      err('`build_deep_prompt()` 的签名不是 `(f, morph=None)` —— 母版与五档要共用同一个骨架');
      deepBad++;
    }
  }
  const banLine = (code.match(/^DEEP_MOTIF_BANNED = \([\s\S]*?\)$/m) || [''])[0];
  if (!banLine) {
    err(REL + ' 里取不到 `DEEP_MOTIF_BANNED = (…)` 的取值行 —— 改写法了就来更新本节');
    deepBad++;
  } else {
    const need = ['sparkle', 'glitter', 'glint', 'glow', 'luminous', 'ring'];
    const miss = need.filter(w => !has(banLine, '"' + w + '"'));
    if (miss.length) {
      err('DEEP_MOTIF_BANNED 少了 ' + miss.join('、') + ' —— 禁用表是逐条描述唯一的用词闸门，'
        + '少一个词就等于那条纪律没有（闪烁族尤其：它是闪光档的卖点，原色档不许先用掉）');
      deepBad++;
    }
  }
  const pcBody = bodyOf(code, 'def palette_color(');
  if (!pcBody || !has(pcBody, 'DEEP_COLOR_HEAD.get(')) {
    err('`palette_color()` 里没有用 `DEEP_COLOR_HEAD.get(` —— 「弱化原色的颜色提示词」这条口径'
      + '定义了却没人用（两场仍会说 natural realistic colouring）');
    deepBad++;
  }
  const leadMap = (code.match(/^DEEP_LEAD = \{[^}]*\}/m) || [''])[0];
  if (!has(leadMap, '"SS"') || !has(leadMap, '"SSS"') || !has(leadMap, 'ordinary fish')) {
    err('`DEEP_LEAD` 不完整（SS / SSS 两场各要一句，且必须点明「不是普通的鱼」）—— 实得：'
      + leadMap.slice(0, 80));
    deepBad++;
  }
  /* 体型锚点：**每一个真出现过的体型都不能漏**（不点体型时「无相巨鲲」会被画成一条普通大鱼），
     且 `dragon` 的锚点必须是**正面物种词** —— 实测 `dragon` 这个词直接画出四条腿的西方龙，
     而 `with no legs` 这种否定式反而让它长腿（见 `DEEP_ANCHOR` 的注释）。
     🔴 2026-10-10：这张清单原来是**手抄的 12 个键**，加了新体型它照样全绿 ——
        改成从 `fish.js` **现算**（`G.FISH` 里真出现过的 shape），手抄这一步彻底删掉。 */
  const anchorMap = dictBlock('DEEP_ANCHOR');
  const SHAPE_KEYS = Object.keys(G.FISH.reduce((m, f) => { m[f.shape] = 1; return m; }, {})).sort();
  if (SHAPE_KEYS.length < 10) {
    err(`第 ㊾ 节的体型清单现算出 ${SHAPE_KEYS.length} 个 —— 空集会让下面这条判据恒真`);
    deepBad++;
  }
  const missShape = SHAPE_KEYS.filter(k => !has(anchorMap, '"' + k + '":'));
  if (missShape.length) {
    err('`DEEP_ANCHOR` 少了 ' + missShape.join('、') + ' —— 这几种体型会退回 fish 锚点，'
      + '于是「无相巨鲲」被画成一条普通大鱼');
    deepBad++;
  }
  if (!has(anchorMap, 'sea-serpent') || has(anchorMap, '"a dragon"')) {
    err('`DEEP_ANCHOR` 的 dragon 档没走「正面物种词」（应含 `sea-serpent`、不含 `"a dragon"`）—— '
      + '实测 `dragon` 会画出四条腿的西方龙，而 `with no legs` 反而让它长腿');
    deepBad++;
  }

  if (!deepBad) {
    ok('SS / SSS 逐条点题在位：' + lits.length + ' 句、' + SHAPE_KEYS.length + ' 个体型锚点齐全（现算，不手抄）、'
      + '模块级加载即校验、'
      + '提前 return 且只此一处入口、句子满足用词纪律与 ≥12 词');
  }
})();

/* ---------------- 50. 隔壁钓鱼佬：事件可复现 + 奖励硬约束 + 内容与接线都有人消费 ----------------
   由来（2026-10-10，自动化轮 · N7 骨架）：「1 个 NPC + 2 个事件」这套东西的坏法**全是静默的** ——
     · 事件配了却没人调 `consider()` ⇒ 永远不触发（界面上看不出少了什么）；
     · NPC 表里站着、场景却不画他 ⇒ 玩家根本不知道有这么个人；
     · 台词写在数据里、没人渲染 ⇒ 说了等于没说；
     · `reward` 悄悄加上数值奖励 ⇒ 绕过了「奖励只许纯外观」这条红线（经济系统多一个入口）。
   四条都不报错，所以这里逐条钉住。**判据全走 `has()`（折行不敏感）**。

   ⚠️ **自指防线**：本节会把数据表里的字段名**动态**取出来（`Object.keys(...)`），
      不在本文件里写死 `skin` / `shirt` 这类名字 —— 否则 verify.js 自己就成了
      第 32-g 眼里的一个「消费方」，真消费方被删掉都不报红（㉓ / 33-f 同款坑）。
      只有四个「元字段」（id / name / tag / x 这类通用名）例外，它们在别处本来就有消费方。
   ⚠️ 阈值 / 冷却这些数字**不在这里断言**（它们逐条写在内容表与 config 里，
      写死一份就成了第二份真相）；这里只断言「它们是正数 / 在区间里」这种结构性质。

   2026-10-10（N7 三期）**加的三组**（有分支的互动）——
     · ③-b `choices` / `need` 的**结构**：选项至少 2 个、每项有 label 与非空台词；
       `need` 必须指向**真实存在**的那条事件、下标必须落在那条事件的选项范围里。
       ⚠️ 写错 id / 下标**不报错**，只会让那条事件**永远不出现** —— 与本节其余各条同一类静默失效。
     · ⑦ 新增两条接线（`Story.choose` / `d.choices` / `onPick`）：缺一条就是「点了没反应」。
     · ⑦-d 分支的**链路同源**：`tryFire()` 必须问过 `needOk()`、`needOk()` 必须读存档里的
       选择计数、`choose()` 必须把选择写进存档 —— 三段断任何一段，`need` 就退化成一个
       没人读的字段（门恒开 / 恒关，都不报错）。 */
console.log('\n[50] 隔壁钓鱼佬：事件可复现、奖励只许纯外观、NPC / 台词 / 接线都有消费方');
let storyBad = 0;
(function () {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/story.js'), 'utf8');
  /* ⚠️ 判据一律吃**剥过注释**的这一份（硬规矩 第 1 条：只扫代码不扫注释）——
     `core/story.js` 的文件头注释里逐条写着 `needOk()` / `st.pick` 这类词，
     拿原文当判据等于让注释喂饱自己（注释里写同样的词必须仍能报红）。 */
  const coreCode = strip(coreSrc);
  const stateSrc = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
  const panelSrc = strip(fs.readFileSync(path.join(ROOT, 'src/ui/panels.js'), 'utf8'));
  const sceneSrc = strip(fs.readFileSync(path.join(ROOT, 'src/render/scene.js'), 'utf8'));
  const mainSrc = strip(fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8'));
  const hudSrc = strip(fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8'));
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  /* ① 内容表：取**按序加载过的那一份**（不重新解析，免得同一份内容出现两个真相） */
  const NPCS = (sandbox.G && sandbox.G.STORY_NPCS) || null;
  const EVS = (sandbox.G && sandbox.G.STORY_EVENTS) || null;
  if (!NPCS || !EVS || !Object.keys(NPCS).length || !EVS.length) {
    err('src/data/story.js 没有给出 STORY_NPCS / STORY_EVENTS（隔壁钓鱼佬的 NPC 与事件表）');
    storyBad++;
    return;
  }
  const npcIds = Object.keys(NPCS);

  /* ② 字段名必须合法（下面要拿它拼正则） */
  const badKeys = [];
  const allKeys = [];
  npcIds.forEach(id => Object.keys(NPCS[id]).forEach(k => allKeys.push('NPC ' + id + '.' + k)));
  EVS.forEach(ev => Object.keys(ev).forEach(k => allKeys.push('事件 ' + (ev.id || '?') + '.' + k)));
  allKeys.forEach(s => {
    const k = s.replace(/^.*\./, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) badKeys.push(s);
  });
  if (badKeys.length) { err('内容表的字段名不是合法标识符：' + badKeys.join('、')); storyBad++; return; }

  /* ③ 每条事件：id 唯一、能解出 NPC、字段齐全且类型对、台词非空 */
  const evBad = [], seenEv = {};
  EVS.forEach(ev => {
    if (!ev.id || seenEv[ev.id]) evBad.push('事件 id 缺失或重复：' + ev.id);
    seenEv[ev.id] = 1;
    if (npcIds.indexOf(ev.npc) < 0) evBad.push(ev.id + ' 指向不存在的 NPC「' + ev.npc + '」');
    if (typeof ev.title !== 'string' || !ev.title) evBad.push(ev.id + ' 没有 title（对话面板标题会是空的）');
    if (!(ev.chance > 0 && ev.chance <= 1)) evBad.push(ev.id + ' 的 chance 不在 (0,1]');
    if (!(ev.cooldownMs > 0)) evBad.push(ev.id + ' 的 cooldownMs 不是正数');
    if (typeof ev.once !== 'boolean') evBad.push(ev.id + ' 的 once 不是布尔值');
    if (!ev.cond || typeof ev.cond !== 'object' || Array.isArray(ev.cond)) {
      evBad.push(ev.id + ' 没有 cond —— 无条件的邻居会每竿都来搭话');
    }
    if (!ev.reward || typeof ev.reward !== 'object' || Array.isArray(ev.reward)) {
      evBad.push(ev.id + ' 的 reward 不是对象');
    }
    if (!Array.isArray(ev.lines) || !ev.lines.length
      || ev.lines.some(s => typeof s !== 'string' || !s.trim())) {
      evBad.push(ev.id + ' 的 lines 为空、或含非字符串 / 空行');
    }
  });
  if (evBad.length) { err('事件表这些地方不对：' + evBad.join('；')); storyBad++; }

  /* ③-b 🔴 有分支的互动（N7 三期）：`choices` / `need` 的**结构**必须能撑起「点一下继续」。
     两种坏法都是静默的：
       · 选项缺 `label` ⇒ 界面上一个没有字的按钮（玩家不知道那是什么）；
         选项缺 `lines` ⇒ 点了之后他不会说话（面板要么空白要么直接关掉）；
       · `need.pick` / `need.opt` 写错 ⇒ 那条事件**永远不出现**（不报错、也不会有人发现）。
     判据拿内容表**现算**（不写死任何 id / 下标），且与本节其余各条一样只断言结构性质。 */
  const evById = {};
  EVS.forEach(ev => { evById[ev.id] = ev; });
  const brBad = [];
  let withChoices = 0, withNeed = 0;
  EVS.forEach(ev => {
    if (ev.choices !== undefined) {
      withChoices++;
      if (!Array.isArray(ev.choices) || ev.choices.length < 2) {
        brBad.push(ev.id + ' 的 choices 不是「至少 2 项」的数组（只有一个选项就不叫分支）');
      } else {
        ev.choices.forEach((c, i) => {
          const at1 = ev.id + ' 的第 ' + (i + 1) + ' 个选项';
          if (!c || typeof c !== 'object' || Array.isArray(c)) { brBad.push(at1 + '不是对象'); return; }
          if (typeof c.label !== 'string' || !c.label.trim()) brBad.push(at1 + '没有 label（按钮上没字）');
          if (!Array.isArray(c.lines) || !c.lines.length
            || c.lines.some(s => typeof s !== 'string' || !s.trim())) {
            brBad.push(at1 + '没有台词 —— 点了之后他不会说话');
          }
        });
      }
    }
    if (ev.need !== undefined) {
      withNeed++;
      const n = ev.need;
      if (!n || typeof n !== 'object' || Array.isArray(n)) { brBad.push(ev.id + ' 的 need 不是对象'); return; }
      if (typeof n.opt !== 'number' || n.opt < 0 || n.opt % 1 !== 0) {
        brBad.push(ev.id + ' 的 need.opt 不是非负整数（它是选项下标）');
      }
      const src = evById[n.pick];
      if (!src) {
        brBad.push(ev.id + ' 的 need.pick 指向不存在的事件「' + n.pick + '」—— 这条事件永远不会出现');
      } else if (!Array.isArray(src.choices) || !(n.opt >= 0 && n.opt < src.choices.length)) {
        brBad.push(ev.id + ' 的 need 指向「' + n.pick + '」的第 ' + n.opt
          + ' 项，而那条事件没有这一项 —— 门永远打不开（他会一直等一个不存在的选择）');
      }
    }
  });
  if (brBad.length) { err('分支互动配得不对：' + brBad.join('；')); storyBad++; }

  /* ③-c 🔴 限时比试（N7 四期）：`duel` 块要能撑起「开一场、到点结算」。
     四种坏法都是**静默**的：
       · `ms` / `pool` 不是正数 / 非负整数 ⇒ 窗口是 0 毫秒（开完立刻结算）或抽不出鱼；
       · `win` / `lose` 缺一边 ⇒ 那一种结果**永远说不出话**，玩家只会看到面板一闪；
       · `cond.field` 列了隐藏钓场 ⇒ 那里一竿十几分钟，限时比试变成**必输**；
       · `pool` 那一档在某个列出钓场里没有鱼 ⇒ 开不了赛（引擎按「不开」处理，什么都不说）。
     判据一律**拿内容表 + 鱼种表现算**（不写死任何钓场 id / 档位），且带空集自检。 */
  const RAR_BUCKETS = (sandbox.G && sandbox.G.FISH_BY_FIELD_RARITY) || null;
  const FIELDS_T = (sandbox.G && sandbox.G.FIELDS) || null;
  const duelBad = [];
  let duelEvs = 0;
  const TOKEN_ALLOW = ['name', 'rival', 'best', 'score'];
  EVS.forEach(ev => {
    if (ev.duel === undefined) return;
    duelEvs++;
    const dd = ev.duel;
    const at1 = ev.id + ' 的 duel';
    if (!dd || typeof dd !== 'object' || Array.isArray(dd)) { duelBad.push(at1 + ' 不是对象'); return; }
    if (!(dd.ms > 0) || dd.ms % 1 !== 0) duelBad.push(at1 + '.ms 不是正整数（窗口 0 毫秒 = 开完立刻结算）');
    if (!(dd.pool >= 0) || dd.pool % 1 !== 0) duelBad.push(at1 + '.pool 不是非负整数（它是稀有度下标）');
    /* 结算台词：两段都要非空，而且**都要真的带占位符** ——
       不带就等于「比完了但看不出谁重」，玩家没有任何可核对的东西。 */
    const seenTok = {};
    ['win', 'lose'].forEach(k => {
      const lines = dd[k];
      if (!Array.isArray(lines) || !lines.length
        || lines.some(s => typeof s !== 'string' || !s.trim())) {
        duelBad.push(at1 + '.' + k + ' 不是非空字符串数组（那一种结果永远说不出话）');
        return;
      }
      const seenKey = {};
      lines.forEach(s => {
        /* 占位符形态固定是 `{英文}`；写错名字**不报错**，只会把 `{xxx}` 原样念出来 */
        (s.match(/\{[A-Za-z_$][\w$]*\}/g) || []).forEach(t => {
          const name = t.slice(1, -1);
          seenTok[name] = 1;
          seenKey[name] = 1;
          if (TOKEN_ALLOW.indexOf(name) < 0) {
            duelBad.push(at1 + '.' + k + ' 用了不认识的占位符 ' + t
              + '（只许 ' + TOKEN_ALLOW.map(x => '{' + x + '}').join(' / ') + '）');
          }
        });
      });
      /* 🔴 两段台词**都要**同时给出他的重量与你的成绩（`{rival}` + `{best}`）——
         只留 `{score}` 的话就是「比完了但看不出谁重」，玩家没有任何可核对的东西。
         这一条 2026-10-10 的反向验证逮到过：第一版只判「这一段里至少有 1 个占位符」，
         把 win 第一段三个占位符全删掉仍然绿（第二段那个 {score} 替它满足了）。 */
      ['rival', 'best'].forEach(tk => {
        if (!seenKey[tk]) {
          duelBad.push(at1 + '.' + k + ' 没用 {' + tk + '} —— 那一段里看不出两边各多重');
        }
      });
    });
    if (!seenTok.score) {
      duelBad.push(at1 + ' 的结算台词里没有 `{score}` —— 存档里那本战绩（wins / losses）**没有消费方**');
    }
    /* 场地：必须显式列，且**不许列隐藏钓场**（`requireFull` 那两处一竿就要十几分钟）。 */
    const cf = ev.cond && ev.cond.field;
    if (!Array.isArray(cf) || !cf.length) {
      duelBad.push(ev.id + ' 的 cond.field 没有列钓场 —— 隐藏钓场（SS / SSS）会跟着办比试，'
        + '那里一竿十几分钟，限时比试变成必输');
    } else if (!FIELDS_T) {
      duelBad.push('拿不到 G.FIELDS，判据抓不到钓场表（先修本节判据本身）');
    } else {
      const hidden = {};
      FIELDS_T.forEach(f => { if (f.requireFull) hidden[f.id] = 1; });
      cf.forEach(fid => {
        if (!FIELDS_T.some(f => f.id === fid)) duelBad.push(ev.id + ' 的 cond.field 列了不存在的钓场「' + fid + '」');
        if (hidden[fid]) duelBad.push(ev.id + ' 在隐藏钓场「' + fid + '」办比试 —— 那里一竿十几分钟，限时比试变成必输');
      });
      /* `pool` 那一档在每个列出钓场里都要抽得出鱼，否则引擎按「不开赛」处理 */
      if (!RAR_BUCKETS) duelBad.push('拿不到 G.FISH_BY_FIELD_RARITY，判不出 pool 那一档有没有鱼');
      else cf.forEach(fid => {
        const b = (RAR_BUCKETS[fid] || [])[dd.pool];
        if (!Array.isArray(b) || !b.length) {
          duelBad.push(ev.id + ' 的 duel.pool=' + dd.pool + ' 在钓场「' + fid + '」里一条鱼都没有 —— 那里开不了赛');
        }
      });
    }
  });
  if (duelBad.length) { err('限时比试配得不对：' + duelBad.join('；')); storyBad++; }

  /* ④ 🔴 奖励硬约束：**键只许在纯外观白名单里**，绝不许给金币 / 鱼饵 / 装备 / 掉率。
     白名单现在**是空的** —— 本轮两条事件都是「纯剧情、零奖励」，那是**有意**的。
     要给东西的那一轮必须同时改这里并写明是纯外观（这是有意留的一道闸门）。 */
  const REWARD_ALLOW = [];
  const REWARD_FORBID = ['coin', 'bait', 'rod', 'line', 'luck', 'odds', 'rate'];
  const rwBad = [];
  EVS.forEach(ev => {
    Object.keys(ev.reward || {}).forEach(k => {
      if (REWARD_FORBID.indexOf(k) >= 0) rwBad.push(ev.id + ' 的 reward 里出现了数值奖励「' + k + '」');
      else if (REWARD_ALLOW.indexOf(k) < 0) rwBad.push(ev.id + ' 的 reward 有个没进白名单的键「' + k + '」');
    });
  });
  if (rwBad.length) {
    err('事件奖励越了红线：' + rwBad.join('；')
      + '（奖励只许纯外观 —— 称号 / 限定装饰；数值与经济类一律不许）');
    storyBad++;
  }

  /* ⑤ 确定性：引擎里不许出现 `Math.random()` —— 它是「同一份存档两次跑出不同结果」的唯一入口 */
  if (has(strip(coreSrc), 'Math.random')) {
    err('src/core/story.js 用了 Math.random() —— 事件触发就不可定点复现了'
      + '（口径①：同一份存档 + 同一组条件 + 同一个序号必须给同一个结果）');
    storyBad++;
  }

  /* ⑥ 消费方：**数据表里的每一个字段都必须有人读**（动态取键，见本节头注的自指防线）
     · 事件的字段 → 引擎或 UI 层里出现 `ev.<字段>`
     · NPC 的字段 → 场景层出现 `nb.<字段>`，或引擎 / UI 层出现 `npc.<字段>`
       （引擎会读 `npc.talk` 那个闲聊池 —— N7 二期起它也是 NPC 内容的消费方，
       不能只认「画面层读没读」） */
  const unread = [];
  EVS.forEach(ev => Object.keys(ev).forEach(k => {
    if (!has(coreCode, 'ev.' + k) && !has(mainSrc, 'ev.' + k)) unread.push('事件 ' + ev.id + '.' + k);
  }));
  npcIds.forEach(id => Object.keys(NPCS[id]).forEach(k => {
    /* 🔴 N11 一期起场景层拿的是**引擎算好的那一项**：NPC 字段一律经 `nb.npc.<字段>`
       （`nb` 是 `{ id, x, npc }` 那一项，站位 x 由引擎从同一张表里取）。
       ⇒ 判据只认 `nb.npc.<字段>` **与** UI 侧的 `npc.<字段>`；
          写回 `nb.<字段>`（场景层自己查内容表）**不再算数** —— 那正是这一轮要拆掉的
          「站位与‘他在哪几片’两处各查一次」的第二份真相。 */
    const inScene = new RegExp('nb\\.npc\\.' + k + '(?![A-Za-z0-9_$])').test(sceneSrc);
    const inUi = new RegExp('npc\\.' + k + '(?![A-Za-z0-9_$])').test(panelSrc)
      || new RegExp('npc\\.' + k + '(?![A-Za-z0-9_$])').test(mainSrc)
      || new RegExp('npc\\.' + k + '(?![A-Za-z0-9_$])').test(coreCode);
    if (!inScene && !inUi) unread.push('NPC ' + id + '.' + k);
  }));
  if (unread.length) { err('内容表里这些字段没人读：' + unread.join('、')); storyBad++; }

  /* ⑦ 三处接线必须都在（缺一条 = 静默失效） */
  const wires = [
    [mainSrc, 'G.Story.init(', 'main.js 没初始化事件引擎 —— 事件表配得再好也永远不触发'],
    [mainSrc, 'G.Story.consider(', 'main.js 没在「一竿结算完」之后调 consider() —— 事件永远不触发'],
    [mainSrc, 'G.Story.neighbors()', 'main.js 没把 NPC 交给场景层 —— 隔壁钓鱼佬画不出来'],
    [panelSrc, 'VIEWS.dialog', 'panels.js 没有对话面板 —— 他的话说不出来'],
    [sceneSrc, 'function drawNeighbor(', 'scene.js 没有 drawNeighbor() —— NPC 画不出来'],
    [sceneSrc, 'drawNeighbor(th)', 'scene.js 的渲染流程里没调 drawNeighbor() —— NPC 不会出现'],
    /* ⬇ N7 二期：点他主动搭话 —— 这四环缺任何一环，功能就是「点了没反应」（且不报错） */
    [sceneSrc, 'function hitNeighbor(', 'scene.js 没有 hitNeighbor() —— 点不中他'],
    [sceneSrc, 'function neighborH(', 'scene.js 没有 neighborH() —— 画法与命中框会各算一遍身高'],
    [mainSrc, 'S.hitNeighbor(', 'main.js 没问过「点在不在他身上」—— 点他会变成抛竿'],
    [mainSrc, 'G.Story.talk(', 'main.js 没调 talk() —— 点中了也不说话'],
    [coreSrc, 'o.lines =', 'core/story.js 的 talk() 没给出对话内容（面板会弹一张空卡）'],
    /* ⬇ N7 三期：有分支的互动 —— 这四环缺任何一环，玩法就是「点了没反应」（且不报错） */
    [coreSrc, 'function choose(', 'core/story.js 没有 choose() —— 玩家选了也没人把下一段交回来'],
    [mainSrc, 'G.Story.choose(', 'main.js 没把玩家的选择交回引擎 —— 分支不落存档、后续事件永远不出现'],
    [panelSrc, 'd.choices', 'panels.js 的对话面板不渲染选项 —— 分支在界面上根本不存在'],
    [panelSrc, 'onPick', 'panels.js 没把点击交出去 —— 点了选项没有任何反应'],
    /* ⬇ N7 四期：限时比试 —— 这条链路最长（渔获管线 → 判定 → 顶栏芯片 → 结算对话），
       断任何一环都**不报错**，只是「比了一场没人知道」。 */
    [coreCode, 'function startDuel(', 'core/story.js 没有 startDuel() —— 命中带 duel 的事件也不会开赛'],
    [mainSrc, 'G.Story.noteCatch(', 'main.js 没把「这一竿的成果」喂给判定 —— 比试时你上的鱼永远不算'],
    [coreCode, 'function settleDuel(', 'core/story.js 没有 settleDuel() —— 到点了也没人结算这场比试'],
    [mainSrc, 'G.Story.settleDuel(', 'main.js 没在主循环里问「到点没有」—— 窗口过了也不会有结果'],
    [coreCode, 'function duelInfo(', 'core/story.js 没有 duelInfo() —— 界面拿不到「还在比」的证据'],
    [mainSrc, 'G.Story.duelInfo(', 'main.js 没把比试进度交给顶栏 —— 玩家不知道还在比'],
    [hudSrc, 'function setDuel(', 'hud.js 没有 setDuel() —— 顶栏那枚倒计时芯片画不出来'],
    [mainSrc, 'Hud.setDuel(', 'main.js 没调 setDuel() —— 比试进行中界面上一点痕迹都没有'],
    [hudSrc, "'#duelChip'", 'hud.js 没抓比试芯片的元素'],
    [htmlSrc, 'id="duelChip"', 'index.html 里没有 #duelChip 容器 —— 芯片无处安放'],
    /* ⬇ N7 五期 / N11 一期：按钓场挑人（一片水里可以有两位）—— 少一个入口，
       「现在站着的有谁」就没处回答。 */
    [coreCode, 'function curNpcIds(', 'core/story.js 没有 curNpcIds() —— 「现在站着的有谁」没有唯一回答处'],
    [coreCode, 'function idsAt(', 'core/story.js 没有 idsAt() —— 「这一片里站着谁」没有一个按钓场查表的实现'],
  ];
  const miss = wires.filter(w => !has(w[0], w[1]));
  if (miss.length) { err('隔壁钓鱼佬的接线缺了 ' + miss.length + ' 处：\n     ' + miss.map(w => w[2]).join('\n     ')); storyBad++; }

  /* ⑦-a-2 🔴 切钓场要**换人**（N7 五期 / N11 一期：还可能要换站位、由一位变两位）：
     `main.js` 里必须两处把邻居交给场景层 —— 一处是启动（第一次画他们）、
     一处是切钓场（换人）。只留启动那处的话，画面会一直画着开局那几位
     （不报错，像鬼影），而对话里的人早就换了。
     ⚠️ 认的是**调用次数**：同一个调用式出现两次才算接上（写成别的形态会被判红，
        这是有意收紧的 —— 这条本身就要求「两处都走同一个入口」）。 */
  const nbWires = (mainSrc.match(/S\.setNeighbors\(G\.Story\.neighbors\(\)\)/g) || []).length;
  if (nbWires < 2) {
    err('main.js 只有 ' + nbWires + ' 处把邻居交给场景层 —— 少了「切钓场换人」那一处，'
      + '画面会一直画着上一个钓场那几位（对话里的人却已经换了，而且不报错）');
    storyBad++;
  }

  /* ⑦-b 🔴 命中框与画法**必须同源**：两边都要经过 `neighborH()` 现算身高。
     抄一份公式（`Math.min(H * 0.155, 72)`）的后果是「画在这儿、点在那儿」，
     而且**不报任何错** —— 玩家只会觉得这游戏点了没反应。走同一个函数就不可能出现。 */
  const noSrc = [];
  const drawBody = bodyOf(sceneSrc, 'function drawNeighbor(');
  const hitBody = bodyOf(sceneSrc, 'function hitNeighbor(');
  if (!has(drawBody, 'neighborH()')) noSrc.push('drawNeighbor() 没走 neighborH()');
  if (!has(hitBody, 'neighborH()')) noSrc.push('hitNeighbor() 没走 neighborH()');
  if (!has(drawBody, 'nb.x') || !has(hitBody, 'nb.x')) noSrc.push('画法与命中框没共用 `nb.x` 这个站位');
  if (noSrc.length) {
    err('邻居的命中框与画法不同源：' + noSrc.join('、')
      + '（两处各算一遍 ⇒ 点和画的不是同一个位置，且不报错）');
    storyBad++;
  }

  /* ⑦-c 闲聊池（`talk`）：结构必须能撑起「点一下搭一句」。
     ⚠️ 只断言**结构**，不写死句子数 —— 池子长度是内容，随时会加。 */  const talkBad = [];
  let withPool = 0;
  npcIds.forEach(id => {
    const t = NPCS[id].talk;
    if (t === undefined) return;                 /* 允许 NPC 没闲聊池（他就只是站着） */
    if (!Array.isArray(t) || !t.length) { talkBad.push(id + ' 的 talk 不是非空数组'); return; }
    if (t.some(s => typeof s !== 'string' || !s.trim())) talkBad.push(id + ' 的 talk 里有非字符串 / 空行');
    withPool++;
  });
  if (!withPool) {
    talkBad.push('没有任何 NPC 有闲聊池 —— 「点他搭话」这条通路整条是死的');
  }
  /* ⚠️ 空集自检：判据取自内容表，抓不到内容表时**必须报错**而不是空过 */
  if (!npcIds.length) talkBad.push('NPC 表是空的（判据抓不到任何东西，先修本节判据本身）');
  if (talkBad.length) { err('闲聊池不对：' + talkBad.join('；')); storyBad++; }

  /* ⑦-d 🔴 分支互动的**三段链路**必须都在（与 ⑦-b「命中框同源」同一类判据）：
     · `tryFire()` 要问过 `needOk()` —— 不然 `need` 只是个没人读的字段（门恒开）；
     · `needOk()` 要读存档里的选择计数（`.pick` / `.opt` 至少各一处）—— 不然门恒关；
     · `choose()` 要把选择写进存档（`st.pick`）—— 不然「他借到过线」留不住，
       后续那条 `need` 门永远打不开（选完就忘，玩家会以为选项是装饰）。
     三段断任何一段都**不报错**，只是那条机制静默失灵。 */
  const brChain = [];
  const fireBody = bodyOf(coreCode, 'function tryFire(');
  const needBody = bodyOf(coreCode, 'function needOk(');
  const chooseBody = bodyOf(coreCode, 'function choose(');
  /* ⚠️ 判「某个字段真的被读了」必须**认标识符边界**：`has(body,'st.pick')` 这种子串比对
     会被一次改名喂饱 —— 反向验证 V10 当场抓到（把 `st.pick[…]` 改成 `st.picks[…]` 之后，
     断言照样是绿的，而选择其实没写进存档）。与 ⑥ 里 `nb\.x(?![A-Za-z0-9_$])` 同一套写法：
     前缀排除 `.`/`$`/词字符、后缀不许再跟词字符 —— 于是 `st.picks` / `an.opt` 都不算命中。 */
  const readsField = (src, expr) => new RegExp('(?:^|[^\\w$.])' + expr + '(?![\\w$])').test(src);
  if (!has(fireBody, 'needOk(')) brChain.push('tryFire() 没问过 needOk()（事件上的 need 没人读 ⇒ 门恒开）');
  if (!readsField(needBody, 'n\\.pick') || !readsField(needBody, 'n\\.opt')) {
    brChain.push('needOk() 没读存档里的选择计数（.pick / .opt 少了哪个就判不出「选过没」）');
  }
  if (!readsField(chooseBody, 'st\\.pick')) brChain.push('choose() 没读存档里的选择（s.story.pick）');
  /* ⚠️ 「写进存档」必须认**赋值**本身，不能只认「提到过 st.pick」—— `choose()` 里本来
     就有一次**读**（`var arr = st.pick[ev.id]`），只比对子串的话把赋值那句改名照样绿
     （反向验证 V10 抓到）。 */
  if (!/st\.pick\s*\[[^\]]*\]\s*=(?!=)/.test(chooseBody)) {
    brChain.push('choose() 没把选择写进存档（只读到、没写：分支的下一次触发就查无此事）');
  }
  if (brChain.length) { err('分支互动的链路没接上：' + brChain.join('、')); storyBad++; }

  /* ⑦-e 🔴 限时比试的**四段链路**必须都在（与 ⑦-b / ⑦-d 同一类判据）。
     断哪一段都不报错，只是这场比试**静默地不成立**：
       · `tryFire()` 里没有「已有未结算的比试 ⇒ 跳过 duel 事件」的守卫
         ⇒ 第二场把第一场的窗口整个覆盖，玩家刚比到一半那局凭空消失；
       · `noteCatch()` 没把重量写进 `d.best` ⇒ 你上多少鱼，结算时都是 0（永远输）；
       · `settleDuel()` 没同时读 `d.best` 与 `d.target` ⇒ 判不出谁赢（要么恒赢要么恒输）；
       · `settleDuel()` 没清窗口字段 ⇒ 守卫永远挡住下一场（比过一场就再也开不了赛）。
     ⚠️ 与 ⑦-d 同款：判「字段真被读了 / 写了」必须**认标识符边界与赋值本身** ——
        子串比对会被一次改名喂饱（`st.duel.end` → `st.duels.end` 照样命中）。 */
  const duelChain = [];
  const noteBody = bodyOf(coreCode, 'function noteCatch(');
  const settleBody = bodyOf(coreCode, 'function settleDuel(');
  if (!readsField(fireBody, 'st\\.duel\\.end')) {
    duelChain.push('tryFire() 没读「已有未结算的比试」——第二场会把第一场覆盖掉（刚比到一半那局凭空消失）');
  }
  if (!/d\.best\s*=(?!=)/.test(noteBody)) {
    duelChain.push('noteCatch() 没把这一竿的重量写进 best —— 比试时你上多少鱼都算 0（永远输）');
  }
  if (!readsField(noteBody, 'd\\.end')) {
    duelChain.push('noteCatch() 没看「有没有进行中的比试」——不在比试时也会乱记账');
  }
  if (!readsField(settleBody, 'd\\.best') || !readsField(settleBody, 'd\\.target')) {
    duelChain.push('settleDuel() 没同时读 best 与 target —— 判不出谁赢（恒赢或恒输）');
  }
  /* 「窗口清零」认的是**写**：`d.best = 0` / `d.target = 0` 这类赋值，不是「提到过」。 */
  if (!/d\.(best|target|end)\s*=(?!=)/.test(bodyOf(coreCode, 'function clearDuel('))) {
    duelChain.push('clearDuel() 没把窗口字段清零 —— 之后再也开不了新的一场（守卫永久挡着）');
  }
  if (duelChain.length) { err('比试的链路没接上：' + duelChain.join('、')); storyBad++; }

  /* ⑦-f 🔴 「现在站着的有谁」= 一处回答（N7 五期 / **N11 一期改口径：一片水里可以有两位**）：
     内容表用一张**站位表**说「他站哪几片、站在哪儿」（钓场 id → 站位比例），
     引擎的 `idsAt()` 拿当前钓场去查。五种坏法**全是静默的**：
       · 钓场 id 写错 ⇒ 那个人从那一钓场**凭空消失**（不画人、不触发、点不到）；
       · 有人没站位表 / 表是空的 ⇒ 他永远不出现（等于白写一位 NPC）；
       · 站位不是正数（写成字符串 / null）⇒ 引擎按类型判「他没站这一片」⇒ 同上，凭空消失；
       · 事件列的钓场里**没有**它自己那位 NPC ⇒ 那条事件永远不触发（引擎按当前钓场挑人）；
       · 🔴 **同场两位的站位挨太近 / 站到玩家右边**（N11 一期新立的）⇒ 两张脸叠在一起
         （认不出点的是谁、命中框也互相压住）或者两根竿交叉 —— 画面上很糟，
         但**没有任何报错**（只有真拿眼睛看才发现）。
     判据拿内容表**现算**（不写死任何钓场 id / NPC id），并带空集自检。 */
  const fieldIds = FIELDS_T ? FIELDS_T.map(f => f.id) : null;
  if (!fieldIds) { err('拿不到 G.FIELDS，第 50 节的站位表判据抓不到钓场表（先修本节判据本身）'); storyBad++; }
  /* ⚠️ 站位表的**键名动态认**（本节头注的自指防线）：本文件的**代码**里不写死那个键名 ——
     写死了，verify.js 自己就成了第 32-g 眼里的一个「消费方」，真读它的那处被删也不报红。
     认法：某个 NPC 身上「值是**对象**、且它的键里至少有一个是**真钓场 id**」的那个键
     （闲聊池是字符串数组，不会命中）。
     认出来之后所有 NPC 用同一个键名读 ⇒ 单个 NPC 把钓场写错 / 把站位写成字符串，
     也能被如实报出来（换形态不换键名）。 */
  let placeKey = '';
  npcIds.some(id => Object.keys(NPCS[id]).some(k => {
    const v = NPCS[id][k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (!Object.keys(v).some(x => fieldIds && fieldIds.indexOf(x) >= 0)) return false;
    placeKey = k; return true;
  }));
  if (!placeKey) {
    err('§50 没能从 NPC 对象上认出站位表（键是**真钓场 id**、值是站位比例的那个对象）'
      + ' —— 抓不到就报错，不许空过');
    storyBad++;
  }
  /* 玩家钓位（比例）—— **从 scene.js 现算**，不写死数字：邻居得站得比他靠左，
     否则两根竿在画面上交叉。读不到就报错（抓不到就空过等于没这条判据）。 */
  let playerX = null;
  const fxM = /fisherX\(\)\s*\{\s*return W\s*\*\s*([\d.]+)/.exec(sceneSrc);
  if (fxM) playerX = parseFloat(fxM[1]);
  if (playerX === null || !isFinite(playerX)) {
    err('§50 没能从 scene.js 的 fisherX() 里读出玩家钓位 —— 「邻居站在玩家左边」这条判据没基准');
    storyBad++;
  }
  /* 同场两位的**最小站位间距**（画布宽度比例）。口径是「实测松一点、但叠住了必报红」：
     现状最近的一对是 0.078 / 0.124（相距 0.046）⇒ 阈值取 0.04（不锁死现值，改站位不必改这里），
     而「两张脸叠住」那个量级（≤0.02）必报红。 */
  const MIN_GAP = 0.04;
  /* 一片水里最多几位（N11 一期定的口径：可以两位，第三位就要重新谈站位了）。 */
  const MAX_PER_FIELD = 2;
  const npcFields = {};                 /* NPC → 它站得住的钓场 id 数组（现算） */
  const claim = {};                     /* 钓场 → 认领它的那几位（现算） */
  const placeBad = [];
  let npcWithFields = 0;
  npcIds.forEach(id => {
    const sp = placeKey ? NPCS[id][placeKey] : null;
    const fs2 = (sp && typeof sp === 'object' && !Array.isArray(sp)) ? Object.keys(sp) : [];
    if (!fs2.length) {
      placeBad.push('NPC ' + id + ' 没有非空的站位表（' + (placeKey || '站位表') + '）'
        + ' —— 他永远不出现，等于白写一位邻居');
      npcFields[id] = [];
      return;
    }
    npcFields[id] = fs2;
    npcWithFields++;
    fs2.forEach(f => {
      if (fieldIds && fieldIds.indexOf(f) < 0) {
        placeBad.push('NPC ' + id + ' 的站位表里有不存在的钓场「' + f + '」—— 他会从那个钓场凭空消失');
        return;
      }
      /* 站位必须是**正数**：引擎那一句判据是 `typeof … === 'number'` —— 写成字符串 /
         null 时它会判「他没站这一片」，人凭空消失，而且不报错。 */
      const x = sp[f];
      if (typeof x !== 'number' || !isFinite(x) || x <= 0) {
        placeBad.push('NPC ' + id + ' 在钓场「' + f + '」的站位不是正数（现算得到 '
          + JSON.stringify(x) + '）—— 引擎按类型判「他在不在场」，这位会凭空消失');
        return;
      }
      if (playerX !== null && x >= playerX) {
        placeBad.push('NPC ' + id + ' 在钓场「' + f + '」站到了玩家右边（站位 ' + x
          + ' ≥ 玩家钓位 ' + playerX + '）—— 两根竿在画面上会交叉');
      }
      if (!claim[f]) claim[f] = [];
      claim[f].push(id);
    });
  });
  if (!npcWithFields) placeBad.push('没有任何 NPC 有站位表（判据抓不到东西，先修本节判据本身）');
  /* 🔴 同场那几位的站位必须拉开（N11 一期）。阈值口径见上面 `MIN_GAP` 的注释。 */
  let pairCount = 0;
  Object.keys(claim).forEach(f => {
    const who = claim[f];
    if (who.length > MAX_PER_FIELD) {
      placeBad.push('钓场「' + f + '」站着 ' + who.length + ' 位（' + who.join(' / ') + '）'
        + ' —— 一片水里最多 ' + MAX_PER_FIELD + ' 位（再多就得重新谈站位与画面了）');
    }
    for (let a = 0; a < who.length; a++) {
      for (let b = a + 1; b < who.length; b++) {
        pairCount++;
        const xa = NPCS[who[a]][placeKey][f], xb = NPCS[who[b]][placeKey][f];
        if (typeof xa === 'number' && typeof xb === 'number' && Math.abs(xa - xb) < MIN_GAP) {
          placeBad.push('钓场「' + f + '」上的 ' + who[a] + ' 与 ' + who[b] + ' 站得太近（'
            + xa + ' / ' + xb + '，相距 ' + Math.abs(xa - xb).toFixed(3) + ' < ' + MIN_GAP
            + '）—— 两张脸会叠在一起，玩家认不出点的是谁');
        }
      }
    }
  });
  /* ⚠️ **空集自检**：一处共场都没有 ⇒ 「一片水里可以有两位」这条口径被改回去了
     （有人把某处站位表退回一对一）—— 那正是本轮要立的规矩，得报出来。
     要是**有意**改回一対一，就一并把这条判据改掉（不许让它自己空过）。 */
  if (!pairCount) {
    placeBad.push('没有任何钓场站着两位 —— 口径退回了「一片只许一位」'
      + '（N11 一期定的是一片水里可以有两位；真要改回去就一并改掉这条判据）');
  }
  /* 每一位至少得有点事做：一条以他为说话人的事件，或者一个闲聊池。
     两样都没有 ⇒ 他只是一撮挡在岸边的像素（点了没反应、也永远不会开口）。 */
  npcIds.forEach(id => {
    const withEv = EVS.some(ev => ev.npc === id);
    const withTalk = Array.isArray(NPCS[id].talk) && NPCS[id].talk.length > 0;
    if (!withEv && !withTalk) {
      placeBad.push('NPC ' + id + ' 既没有事件也没有闲聊池 —— 他站在那儿什么都不会做');
    }
  });
  /* 🔴 事件的人必须在**它列出的每个钓场**都在场（不列钓场 = 他在哪几片就哪几片）。 */
  EVS.forEach(ev => {
    const fs3 = npcFields[ev.npc] || [];
    const cf2 = ev.cond && ev.cond.field;
    if (!Array.isArray(cf2) || !cf2.length) {
      if (!fs3.length) {
        placeBad.push('事件 ' + ev.id + ' 没列 cond.field，而它的 NPC「' + ev.npc
          + '」又没有站位表 —— 这条事件永远不会触发');
      }
      return;
    }
    cf2.forEach(f => {
      if (fieldIds && fieldIds.indexOf(f) < 0) {
        placeBad.push('事件 ' + ev.id + ' 的 cond.field 列了不存在的钓场「' + f + '」');
      } else if (fs3.indexOf(f) < 0) {
        placeBad.push('事件 ' + ev.id + ' 会发生在钓场「' + f + '」，而它的 NPC「' + ev.npc
          + '」不站那一片 —— 这条事件永远不会触发（引擎按当前钓场挑人，不报错）');
      }
    });
  });
  if (placeBad.length) { err('站位表配得不对：' + placeBad.join('；')); storyBad++; }

  /* 🔴 「谁在场」必须真的**按钓场挑人**（N11 一期拆成三跳，每一跳都盯住）：
       ① `fieldNow()` 读当前钓场；② `idsAt(f)` 按站位表挑人（用它**传进来的**那个钓场）；
       ③ `curNpcIds()` 把两者接起来。
     三跳里任何一跳退回旧写法，坏法都是静默的：
       · 退回「取列表里第一个」⇒ 同场的第二位永远不出现（只会觉得这人怎么老不来）；
       · `idsAt()` 不按传进来的钓场查 ⇒ 换钓场还是原来那位；
       · `curNpcIds()` 绕过 `idsAt()` 自己查一份 ⇒ 场景层与事件门可能各查一份（两份真相）。
     ⚠️ 与 ⑦-d / ⑦-e 同款：认标识符边界（`npc.fieldset` 之类糊不过去）。 */
  const curChain = [];
  const fieldBody = bodyOf(coreCode, 'function fieldNow(');
  const idsBody = bodyOf(coreCode, 'function idsAt(');
  const curBody = bodyOf(coreCode, 'function curNpcIds(');
  /* ⚠️ 判据的 needle 用**拼接**造（不把那个键名写成本文件里的一个字面量）—— 见上面那条注释。
     认不出键名时上面已经报过错了，这里不再重复报。 */
  const placeNeedle = 'npc\\.' + placeKey;
  if (placeKey && !readsField(idsBody, placeNeedle)) {
    curChain.push('idsAt() 没读站位表（NPC.' + placeKey + '）—— 「谁站这一片」就不可能按钓场挑');
  }
  if (!readsField(fieldBody, 's\\.field')) {
    curChain.push('fieldNow() 没读当前钓场 —— 「谁在场」就不可能随钓场变（换钓场还是原来那位）');
  }
  if (!has(curBody, 'idsAt(')) {
    curChain.push('curNpcIds() 没走 idsAt() —— 「谁在场」可能被两处各答一次（两份真相）');
  }
  if (curChain.length) { err('「谁在场」没按钓场挑：' + curChain.join('、')); storyBad++; }

  /* ⑦-g 🔴 「上一竿的结局」这道门（N7 六期）：`cond.after` = 只在**刚丢了鱼**之后才开口。
     五种坏法**全是静默的**：
       · 值写错（拼错 / 用了引擎永远不会给出的结局）⇒ 那条事件**永远不出现**；
       · 值不是非空数组 ⇒ 同上（写了个永远不匹配的门）；
       · 引擎那一侧没把结局读进门（`cond` 白写）⇒ 同上；
       · `main.js` 没把丢竿回调的参数转交下去 ⇒ 所有带这道门的事件全是死的；
       · 🔴 **时序**：`fishing.js` 的 `resolve()` 若先回调 `cb.onMiss`、后把状态收到 `idle`，
         那么 `main.js` 在丢竿回调里那次 `consider()` 的 idle 门**恒不通过** ——
         「丢了一竿」这条触发路**整条**是死的（不只是这道门）：不报错、也没人看得出来。
         ⇒ 判据：`resolve()` 里「一竿收尾」（`state = 'idle'`）必须**早于** `cb.onMiss(`。
     值域**现算**（不写死任何结局名）：`fishing.js` 的 `resolve('…')` + `fight.js` 的
     `finish('…')` 里的字面量，去掉成功那个（它不走丢竿回调）。
     ⚠️ 键名**动态认**（「值是丢竿结局组成的数组」的那个键）—— 理由同 ⑦-f：
        写死了，verify.js 自己就成了 32-g 眼里的一个消费方。
     ⚠️ 判据一律吃**剥过注释**的那两份源码（硬规矩 第 1 条），而且要**连行尾注释一起剥**
        （`x = 1; // 这里写着 resolve('xxx')`）—— §50 那只 `strip` 只认「整行都是注释」，
        行尾那种剥不掉 ⇒ 这一组单用 `stripAll`。不剥的话，注释里那一句就能把「值域」或
        「收尾早于回调」喂饱（反向验证 V1c / V2c 就是专门为这一口设计的）。 */
  const stripAll = t => String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fishSrc = stripAll(fs.readFileSync(path.join(ROOT, 'src/core/fishing.js'), 'utf8'));
  const fightSrc = stripAll(fs.readFileSync(path.join(ROOT, 'src/core/fight.js'), 'utf8'));
  const outcomes = [];
  [[fishSrc, /resolve\(\s*'([^']+)'\s*\)/g], [fightSrc, /finish\(\s*'([^']+)'\s*\)/g]]
    .forEach(pair => {
      let m;
      while ((m = pair[1].exec(pair[0])) !== null) {
        /* ⚠️ 成功那一侧不走丢竿回调，不是「结局」的候选 */
        if (m[1] !== 'success' && outcomes.indexOf(m[1]) < 0) outcomes.push(m[1]);
      }
    });
  const outBad = [];
  if (!outcomes.length) {
    outBad.push('拿不到「丢竿结局」的值域（resolve / finish 的字面量一个都没扫到）—— 抓不到就报错，不许空过');
  }
  let afterKey = '';
  EVS.some(ev => Object.keys(ev.cond || {}).some(k => {
    const v = (ev.cond || {})[k];
    if (Array.isArray(v) && v.length
      && v.every(x => typeof x === 'string' && outcomes.indexOf(x) >= 0)) { afterKey = k; return true; }
    return false;
  }));
  let withAfter = 0;
  if (!afterKey) {
    outBad.push('没有任何事件用「上一竿的结局」这道门 —— 引擎里那条通路没有内容喂它（整条是死的）');
  } else {
    EVS.forEach(ev => {
      const c = ev.cond || {};
      if (!(afterKey in c)) return;
      withAfter++;
      const v = c[afterKey];
      if (!Array.isArray(v) || !v.length) {
        outBad.push('事件 ' + ev.id + ' 的 cond.' + afterKey + ' 不是非空数组 —— 这条门永不匹配（事件永不出现）');
        return;
      }
      v.forEach(x => {
        if (outcomes.indexOf(x) < 0) {
          outBad.push('事件 ' + ev.id + ' 的 cond.' + afterKey + ' 里写了引擎不会给出的结局「' + x
            + '」（现算值域：' + outcomes.join(' / ') + '）—— 这条事件永远不会触发');
        }
      });
    });
    if (!readsField(bodyOf(coreCode, 'function condOk('), 'c\\.' + afterKey)) {
      outBad.push('condOk() 没读 cond.' + afterKey + ' —— 内容表写了这道门，引擎不当回事'
        + '（事件会在任意时刻冒出来）');
    }
    if (!/consider\(\s*result\s*\)/.test(mainSrc)) {
      outBad.push('main.js 的丢竿回调没把这一竿的结局交给 consider() —— 所有带这道门的事件全是死的');
    }
  }
  /* 时序（见上面第 5 种坏法）：只做**先后**判断，所以走压平坐标（`idx()`）是够的。 */
  const resBody = bodyOf(fishSrc, 'function resolve(');
  const atIdle = idx(resBody, "state = 'idle'");
  const atMissCall = idx(resBody, 'cb.onMiss(');
  if (atIdle < 0 || atMissCall < 0) {
    outBad.push('§50 没能从 fishing.js 的 resolve() 里认出「一竿收尾」与「cb.onMiss(」—— 抓不到就报错');
  } else if (atIdle > atMissCall) {
    outBad.push('fishing.js 的 resolve() 先回调 cb.onMiss、后把状态收到 idle —— '
      + '丢竿那一刻 consider() 的 idle 门恒不通过：「丢了一竿」这条触发路整条是死的，且不报错');
  }
  if (outBad.length) { err('「上一竿的结局」这道门 / 链路不对：' + outBad.join('；')); storyBad++; }

  /* ⑦-h 🔴 图鉴门（N7 七期）：`cond` 里那道「这几条里**任意一条**已经钓到过」。
     四种坏法**全是静默的**：
       · 值不是非空数组 ⇒ 门恒关（那条事件永远不出现）；
       · 写错鱼种 id ⇒ 同上，而且没有任何提示；
       · 引擎那一侧没把这道门读进 `condOk()` ⇒ 内容表白写（事件在任意时刻冒出来）；
       · 判定绕过 `G.State.isCaught()` 自己去翻存档 ⇒ 「钓到过没有」多出第二份真相
         （图鉴字段口径改一次，两边就开始各说各话，而且不报错）。
     键名与值域**都现算**（键 = 「值是真实鱼种 id 组成的数组」的那个 cond 键；
     值域 = `G.FISH_ID`）—— 理由同 ⑦-f / ⑦-g：写死了，verify.js 自己就成了 32-g 眼里的
     一个「消费方」，真读它的那处被删也不报红。
     ⚠️ 与 ⑦-g 一样吃**剥过行尾注释**的那一份源码（注释里写同样的词必须仍能报红）。 */
  const coreCode2 = stripAll(coreSrc);
  const FISH_T = (sandbox.G && sandbox.G.FISH_ID) || null;
  const gateBad = [];
  let gateKey = '';
  let withGate = 0;
  if (!FISH_T || !Object.keys(FISH_T).length) {
    gateBad.push('拿不到 G.FISH_ID —— 图鉴门的判据抓不到鱼种表（抓不到就报错，先修本节判据本身）');
  } else {
    const fishIds = Object.keys(FISH_T);
    const litKeys = [];
    EVS.forEach(ev => Object.keys(ev.cond || {}).forEach(k => {
      const v = (ev.cond || {})[k];
      if (Array.isArray(v) && v.length
        && v.every(x => typeof x === 'string' && fishIds.indexOf(x) >= 0)) {
        if (litKeys.indexOf(k) < 0) litKeys.push(k);
      }
    }));
    if (!litKeys.length) {
      gateBad.push('没有任何事件用「图鉴门」—— 引擎里那条通路没有内容喂它（整条是死的）');
    } else if (litKeys.length > 1) {
      /* 两个键都「长得像图鉴门」⇒ 本节只认得出一个，另一条会从网里漏出去（静默漏网）。
         与其猜哪个是，不如报红让人把内容表说清楚。 */
      gateBad.push('有多个 cond 键的值都是「真实鱼种 id 的数组」（' + litKeys.join(' / ')
        + '）—— 本节只认得出一个，另一条会漏出网；请把内容表写清楚');
    } else {
      gateKey = litKeys[0];
      EVS.forEach(ev => {
        const c = ev.cond || {};
        if (!(gateKey in c)) return;
        withGate++;
        const v = c[gateKey];
        if (!Array.isArray(v) || !v.length) {
          gateBad.push('事件 ' + ev.id + ' 的 cond.' + gateKey
            + ' 不是非空数组 —— 这道门永不匹配（事件永不出现）');
          return;
        }
        v.forEach(x => {
          if (typeof x !== 'string' || fishIds.indexOf(x) < 0) {
            gateBad.push('事件 ' + ev.id + ' 的 cond.' + gateKey + ' 里写了不存在的鱼种 id「' + x
              + '」—— 这条事件永远不会触发');
          }
        });
      });
      const okBody2 = bodyOf(coreCode2, 'function condOk(');
      if (!readsField(okBody2, 'c\\.' + gateKey)) {
        gateBad.push('condOk() 没读 cond.' + gateKey + ' —— 内容表写了这道门，引擎不当回事'
          + '（事件会在任意时刻冒出来）');
      }
      const gateBody = bodyOf(coreCode2, 'function caughtOne(');
      if (!gateBody) {
        gateBad.push('core/story.js 没有 caughtOne() —— 图鉴门的判定没有唯一入口'
          + '（抓不到就报错，先修本节判据本身）');
      } else {
        if (!has(gateBody, 'G.State.isCaught')) {
          gateBad.push('图鉴门的判定没走 G.State.isCaught() —— 「钓到过没有」会出现第二份真相'
            + '（图鉴字段口径改一次，两边就开始各说各话）');
        }
        if (!has(okBody2, 'caughtOne(')) {
          gateBad.push('condOk() 没经过 caughtOne() —— 这道门可能只读了字段、没真查图鉴（门恒开）');
        }
      }
    }
  }
  if (gateBad.length) { err('「图鉴门」这道门 / 链路不对：' + gateBad.join('；')); storyBad++; }

  /* ⑧ 存档：字段要在 blank() 里，migrate() 要纠正**每一个**容器类型（脏档兜底）
     ⚠️ 判据必须认**字段声明 / 赋值本身**，不能只认「这段文字里出现过 story 这个词」——
        第一版写成 `has(body, 'story')`，反向验证当场假通过：把 `story:` 那一行删掉之后，
        `blank()` 里那段**注释**（里面写着 `src/data/story.js`）照样让判据变绿。
        与 32-h 同款做法：字段按**行首缩进 + 冒号**认，且先证明「解析出的字段数不为零」。 */
  const blankBody = bodyOf(stateSrc, 'function blank(');
  const blankFields = [...blankBody.matchAll(/^ {6}([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map(m => m[1]);
  if (blankFields.length < 20) {
    err(`§50 只从 blank() 里解析出 ${blankFields.length} 个顶层字段 —— 缩进或写法变了，先修这条断言本身`);
    storyBad++;
  } else if (blankFields.indexOf('story') < 0) {
    err('state.js 的 blank() 里没有 story 字段 —— 隔壁钓鱼佬的事件记录无处可存'); storyBad++;
  }
  /* 三个容器逐个查（**不是**「至少有一个」）—— 少纠正哪个，那个键是脏档时就会把引擎读崩。
     🔴 清单**不从任一边写死**：`blank()` 里的 `story: {…}` 是存档结构的真相，
        `rec()` 里「缺字段就给空壳」的那几行是引擎的真相 ⇒ **两边现算、双向相等**。
        单看一边会漏：比如新加一个容器时另一处忘了改（这正是本条要防的静默失效），
        或者把 `if (!t.talk ||` 写成别的形态，解析面就悄悄少一格。 */
  const storyLit = (() => {
    /* ⚠️ 不能写 `/story:\s*\{([^}]*)\}/` —— 值本身就是 `{}`，
       第一版这样写只吃到第一个 `}`，于是 blank() 那边永远只解析出 1 个键，
       而「两边对不上」这条断言会**一直报红**（反向验证时才发现：⑤-b 判红的原因不是它）。
       走**括号配平**取整段，再收里面的 `键:`。 */
    const m = /story:\s*\{/.exec(blankBody);
    if (!m) return '';
    const openAt = m.index + m[0].length - 1;
    const end = closeOf(blankBody, openAt);
    return end < 0 ? '' : blankBody.slice(openAt + 1, end - 1);
  })();
  const blankConts = storyLit
    ? [...storyLit.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map(m => m[1]) : [];
  const migBody = bodyOf(stateSrc, 'function migrate(');
  const recBody = bodyOf(coreSrc, 'function rec(');
  const conts = [...recBody.matchAll(/if \(!t\.([a-zA-Z_$][\w$]*)\s*\|\|/g)].map(m => m[1]);
  const contKeys = conts.filter((k, i) => conts.indexOf(k) === i);
  if (!blankConts.length || !contKeys.length) {
    err('§50 没能解析出存档 `story` 的容器键（blank() 拿到 ' + blankConts.length
      + ' 个 / rec() 拿到 ' + contKeys.length + ' 个）—— 抓不到就报错，不许空过');
    storyBad++;
  } else if (blankConts.slice().sort().join(',') !== contKeys.slice().sort().join(',')) {
    err('存档 `story` 的容器键两边对不上：blank() 写着 [' + blankConts.join(' / ')
      + ']、core/story.js 的 rec() 只兜底 [' + contKeys.join(' / ')
      + '] —— 少一边就是「某个键是脏档时引擎读崩」或「声明了却没人用」');
    storyBad++;
  }
  const migMiss = contKeys.filter(k => !new RegExp('d\\.story\\.' + k + '\\s*=').test(migBody));
  if (migMiss.length) {
    err('state.js 的 migrate() 没纠正 d.story.' + migMiss.join(' / d.story.')
      + ' 的容器类型 —— 脏档（那几个键是数字 / 字符串）会把引擎读崩');
    storyBad++;
  }

  /* ⑪-b 🔴 NPC 之间互相搭话（N11 二期）：第二张内容表 + 第二个触发时机。
     这一段的判据全部**从内容表现算**，抓的是「写了但永远不会发生」这一类静默坏法：
       · `pair` 里的两位**必须真的在某一片共场**（`spots` 有交集）——
         写一对从不共场的人（老陈守内陆、阿海在海那四片）不报错，只会永远不出现；
       · `lines` 每个说话人必须是 `pair` 里的 id；
       · 掷点必须**另有其盐**（`banterRoll` 里那个 `'banter'`）：与 `rollFor()` 同源的话，
         加一条内容就会挪动既有事件的命中时机（口径 ① 明令不许，而且**不报错**）。 */
  const BNC = (sandbox.G && sandbox.G.STORY_BANTER) || null;
  const bncBad = [];
  if (!BNC || !BNC.length) {
    bncBad.push('src/data/story.js 里没有 STORY_BANTER 表（NPC 之间互相搭话的内容）');
  } else {
    const evIds = EVS.map(e => e.id);
    const seenIds = {};
    BNC.forEach((b, bi) => {
      const tag = 'STORY_BANTER[' + bi + ']（' + (b && b.id) + '）';
      if (!b || typeof b !== 'object') { bncBad.push(tag + ' 不是对象'); return; }
      if (typeof b.id !== 'string' || !b.id) bncBad.push(tag + ' 没有 id');
      else if (seenIds[b.id]) bncBad.push(tag + ' 的 id 与另一条重复');
      else if (evIds.indexOf(b.id) >= 0) {
        bncBad.push(tag + ' 的 id 与事件表里的一条**重名** —— 两张表各有一个 `fired` 容器，'
          + '重名会让人以为「记在一起」；分开的容器本来就是有意分开的，id 也别撞');
      } else seenIds[b.id] = 1;
      if (typeof b.title !== 'string' || !b.title) bncBad.push(tag + ' 没有 title（面板标题）');
      if (!Array.isArray(b.pair) || b.pair.length !== 2) {
        bncBad.push(tag + ' 的 pair 必须是**恰好两位**的数组（现在是 ' + JSON.stringify(b.pair) + '）');
      } else {
        if (b.pair[0] === b.pair[1]) bncBad.push(tag + ' 的 pair 是同一个人');
        const unknown = b.pair.filter(x => npcIds.indexOf(x) < 0);
        if (unknown.length) bncBad.push(tag + ' 的 pair 里有不存在的 NPC：' + unknown.join('、'));
        else {
          /* **真的共场吗** —— 从站位表现算（这一条抓的就是「写了根本不共场的两个人」） */
          const fields0 = new Set();
          npcIds.forEach(id => {
            const sp = (NPCS[id] && NPCS[id].spots) || {};
            Object.keys(sp).forEach(f => { if (typeof sp[f] === 'number') fields0.add(f); });
          });
          const coFields = [...fields0].filter(f => {
            const here = npcIds.filter(id => {
              const sp = (NPCS[id] && NPCS[id].spots) || {};
              return typeof sp[f] === 'number';
            });
            return b.pair.every(x => here.indexOf(x) >= 0);
          });
          if (!coFields.length) {
            bncBad.push(tag + ' 的两个人**没有任何一片钓场共场** ⇒ 这条内容永远不会出现'
              + '（老陈守内陆、阿海在海那四片就是这种组合）');
          }
          if (b.cond && Array.isArray(b.cond.field)) {
            const dead = b.cond.field.filter(f => coFields.indexOf(f) < 0);
            if (dead.length) {
              bncBad.push(tag + ' 的 cond.field 里有他们俩不共场的钓场：' + dead.join('、')
                + '（那几片永远不会命中，等于写了个死条件）');
            }
          }
        }
      }
      if (!(typeof b.chance === 'number' && b.chance > 0 && b.chance <= 1)) {
        bncBad.push(tag + ' 的 chance 必须是 (0,1] 里的数（现在是 ' + b.chance + '）');
      }
      if (b.once !== true && b.once !== false) bncBad.push(tag + ' 的 once 必须是布尔');
      if (!Array.isArray(b.lines) || !b.lines.length) {
        bncBad.push(tag + ' 没有 lines（旁观对话至少要一句）');
      } else {
        b.lines.forEach((row, ri) => {
          if (!Array.isArray(row) || row.length !== 2) {
            bncBad.push(tag + ' 第 ' + (ri + 1) + ' 句不是 [谁, 台词] 两元组');
            return;
          }
          if (Array.isArray(b.pair) && b.pair.indexOf(row[0]) < 0) {
            bncBad.push(tag + ' 第 ' + (ri + 1) + ' 句的说话人 `' + row[0] + '` 不在 pair 里');
          }
          if (typeof row[1] !== 'string' || !row[1].trim()) {
            bncBad.push(tag + ' 第 ' + (ri + 1) + ' 句台词不是非空字符串');
          }
        });
      }
      /* 字段零消费：这些键必须在引擎里真被读过 */
      Object.keys(b).forEach(k => {
        if (!new RegExp('\\.' + k + '(?![A-Za-z0-9_$])').test(coreCode)) {
          bncBad.push(tag + ' 的字段 `' + k + '` 在 core/story.js 里没人读（零消费字段）');
        }
      });
    });
    /* 掷点必须另有其盐 + 链路必须在（`arriveSoon` → `arrive` → `tryBanter`） */
    const brBody = bodyOf(coreSrc, 'function banterRoll(');
    if (!brBody || !has(brBody, "'banter'")) {
      bncBad.push('`banterRoll()` 里没有 `\'banter\'` 这个盐 —— 与 `rollFor()` 同源的话，'
        + '加一条旁观对话就会挪动既有事件的命中时机（口径 ① 明令不许，而且不报错）');
    }
    const arrBody = bodyOf(coreSrc, 'function arrive(');
    if (!arrBody || !has(arrBody, 'tryBanter(') || !has(arrBody, 'markBanter(')) {
      bncBad.push('`arrive()` 没有走 `tryBanter()` / `markBanter()` —— 触发链路断了');
    }
    if (!/setTimeout\(/.test(bodyOf(coreSrc, 'function arriveSoon(') || '')) {
      bncBad.push('`arriveSoon()` 没有延后（`setTimeout`）—— 切钓场是从面板里点的，'
        + '那一刻面板还开着，直接问必然被门拦掉，而且**不报错**（表现只是「从没听见过他们聊天」）');
    }
    if (!has(mainSrc, 'G.Story.arriveSoon(')) {
      bncBad.push('main.js 没有在切钓场那处调 `G.Story.arriveSoon(` —— 第二个触发时机没人接');
    }
    /* 序号必须各记各的：`aseq` / `seq` 是两个计数器。
       ⚠️ 判据盯的是**两个函数体**（`arrive()` 里不许出现裸 `seq`、`consider()` 里不许出现 `aseq`）——
          行为层验不准这件事（共用序号只让掷点整体挪一格，命中序列**常常照样一样**，
          实测反向验证第 8 组：行为断言假绿、这条静态判据真红）。 */
    if (!/var\s+aseq\s*=\s*0/.test(coreCode) || !/var\s+seq\s*=\s*0/.test(coreCode)) {
      bncBad.push('core/story.js 里 `seq` 与 `aseq` 不再各记各的 —— 两个触发时机共用一个序号，'
        + '会让「加一条旁观对话」顺带改变事件的掷点');
    }
    if (/\bseq\b/.test(bodyOf(coreSrc, 'function arrive(') || '')
      || /aseq/.test(bodyOf(coreSrc, 'function consider(') || '')) {
      bncBad.push('两个触发时机共用了序号（`arrive()` 里出现裸 `seq` 或 `consider()` 里出现 `aseq`）'
        + ' —— 口径 ① 不许，「加一条内容就挪动既有事件的命中」是静默的');
    }
    /* UI：面板必须真的画两位说话人（`duo` 与 `head` 都有消费方） */
    if (!has(panelSrc, 'd.duo.forEach(') || !has(panelSrc, 'd.head')) {
      bncBad.push('panels.js 的对话面板没有消费 `duo` / `head` —— 旁观对话会渲染成空白卡');
    }
    if (!has(mainSrc, 'ev.duo')) {
      bncBad.push('main.js 的 dialogPayload() 没有把 `ev.duo` 交给面板 —— 上面那句消费不到东西');
    }
  }
  if (bncBad.length) {
    err('「NPC 之间互相搭话」（N11 二期）不对：' + bncBad.join('；'));
    storyBad++;
  } else {
    ok('NPC 之间互相搭话：' + BNC.length + ' 条旁观对话（'
      + BNC.map(b => b.id + '(' + b.pair.join('+') + ')').join(' / ')
      + '）、每一对都**真有共场的钓场**、说话人都在 pair 里、掷点另有其盐（不挪动事件命中）、'
      + '链路 arriveSoon → arrive → tryBanter 齐全、面板真画两位说话人');
  }

  if (!storyBad) {
    ok('隔壁钓鱼佬在位：' + npcIds.length + ' 个 NPC / ' + EVS.length + ' 条事件，'
      + '字段全有人读、接线齐全（含点他搭话、分支选项与限时比试三条通路）、命中框与画法同源、'
      + '站位表齐全（' + npcWithFields + ' 位邻居 / ' + Object.keys(claim).length
      + ' 片钓场，其中 ' + pairCount + ' 片站着两位且站位相距 ≥ ' + MIN_GAP
      + '、人人都在玩家钓位左边，事件的人与钓场对得上）、'
      + withPool + ' 个闲聊池结构合法、'
      + (withChoices ? withChoices + ' 条事件带分支（其中 ' + withNeed + ' 条按先前的选择开门）'
        : '没有带分支的事件') + '、'
      + (duelEvs ? duelEvs + ' 条事件办限时比试（占位符只许 '
        + TOKEN_ALLOW.map(x => '{' + x + '}').join(' / ') + '、场地不含隐藏钓场且 pool 有鱼）'
        : '没有办比试的事件') + '、'
      + (withAfter ? withAfter + ' 条事件认「上一竿的结局」（值域现算 ' + outcomes.length
        + ' 个、门与链路都在，且丢竿回调早于状态收尾）' : '没有认得上一竿结局的事件') + '、'
      + (gateKey ? withGate + ' 条事件认「图鉴门」（值域现算 ' + Object.keys(FISH_T).length
        + ' 条鱼、门与链路都在，且判定只走 G.State.isCaught()）' : '没有认图鉴门的事件') + '、'
      + '存档 story 的 ' + contKeys.length + ' 个容器两边对得上且有迁移纠正、'
      + '奖励白名单为空（纯剧情）、引擎不用 Math.random');
  }
})();

/* ---------------- 51. 生图管线：跳过判据与过期判据必须同源 ----------------
   由来（2026-10-10，用户批量拍板第 8️⃣ 条「Q14 判据改」+ 第 🔟 条「gen-art.py 三处等一个不跑图的窗口」）：
   `--skip-existing` 原来判的是「**文件在不在**」，而 `--stale` 判的是「**内容对不对**」——
   两份判据各写各的。口径一改（比如 SS/SSS 那 180 条提示词重写），前者照旧**静默跳过**、
   后者报过期，而图上完全看不出来：文件在、图也不坏，**只是不是这一版口径**。
   实测代价：2026-10-10 全部 362 条鱼的卡都出齐了，其中 **373 张**仍是旧口径
   （提示词已变 354 ／ 无台账 15 ／ 步数已变 4）。

   本节钉住五件事（都在 `tools/gen-art.py` 里，**不依赖 python** —— verify 跑不了外部命令）：
     ① **唯一判据**：`card_state()` 只定义**一处**，且 `--skip-existing` 与 `report_stale()`
        **都调用它** —— 谁要是自己再算一遍，两张表必然分家（这正是 Q14 的成因）；
     ② **判据覆盖四件事**：文件在、**母版派生 `-normal.png` 在**（Q28）、提示词一致、步数一致；
     ③ **跳过分支不许再出现「只看文件在不在」**（`args.skip_existing and os.path.exists(`）；
     ④ 两条**静默过期**的顺带修复：`--stale` 必须把「无文件」排除出「过期」（那是「待出」）；
        生图收尾必须刷新 `docs/生图清单.md`（否则勾会一直停在旧状态 —— 实测有 **81 批**）；
     ⑤ **耗时估计必须有实测来源**：`write_plan()` 优先用 `measured_sec()`（manifest 里逐张记的
        `sec` 取中位），常数只当兜底 —— 手填常数换机器 / 改步数就悄悄过期（Q16）。

   ⚠️ 这里只做**文本结构**检查。真实行为由两个探针证明，都跑过：
     · 判据的 8 组注入（移文件 / 移派生 / 删台账 / 改提示词 / 改步数 / 负对照 / 改口径），
       每条还原后逐字节 md5 复核；
     · 两次**真跑**：最新口径的卡 `--skip-existing` 全跳过（零 ComfyUI 调用）、
       过期卡**不跳过**而是走重出。 */
console.log('\n[51] 生图管线：跳过判据与过期判据必须同源');
let skipBad = 0;
(function () {
  const REL = 'tools/gen-art.py';
  const raw = fs.readFileSync(path.join(ROOT, REL), 'utf8');
  /* 只剥整行注释；结构性判据用剥过的，句子/字符串留在里面（③ 的正则要在代码上跑） */
  const code = raw.replace(/^[ \t]*#[^\n]*$/gm, '');

  /* `main()` 的函数体在 ① 与 ③ 都要用 ⇒ 提到最前面（`const` 不会提升，写后面会 TDZ 报错） */
  const mbody0 = bodyOf(code, 'def main(');
  if (!mbody0) {
    err(REL + ' 里找不到 `def main(` —— 改名了就来更新本节');
    skipBad++;
  }

  /* ① 唯一判据 + 两个消费者 */
  const defs = (code.match(/^def card_state\(/gm) || []).length;
  if (defs !== 1) {
    err(REL + ' 的 `def card_state(` 不是**恰好一处**（实得 ' + defs + ' 处）—— '
      + '判据只能有一份；两份必然分家，而分家的表现是「图上完全看不出来」（Q14）');
    skipBad++;
  }
  const rs = bodyOf(code, 'def report_stale(');
  if (!rs) {
    err(REL + ' 里找不到 `def report_stale(` —— 改名了就来更新本节（不许当成「没有报告要检查」）');
    skipBad++;
  } else if (!has(rs, 'card_state_label(') && !has(rs, 'card_state(')) {
    err('`report_stale()` 既没调 `card_state(` 也没调 `card_state_label(` —— '
      + '过期报告自己另算了一套判据，于是与 `--skip-existing` 分家（这正是 Q14 的病根）');
    skipBad++;
  }
  /* ⚠️ 判据是**一条链路**，只认中间那层的名字会被「中转函数自己另写一套」骗过去：
     `report_stale()` → `card_state_label()` → `card_state()`，每一跳都得接上。 */
  if (rs && has(rs, 'card_state_label(')) {
    const csl = bodyOf(code, 'def card_state_label(');
    if (!csl || !has(csl, 'card_state(')) {
      err('`report_stale()` 走 `card_state_label()`，但后者没有调用 `card_state(` —— '
        + '链路断了，等于过期报告还是在算自己那一套判据');
      skipBad++;
    }
  }
  /* 跳过分支：`main()` → `skip_note()` → `card_state()`，每一跳都要接上。
     ⚠️ 这里全程走 `bodyOf()` 的**定义形态** marker（`'def 名字('`）——
        不按位置切片（§42 ⑧ 的禁形）、也不给 marker 省左括号（§42 ⑧ 的第二条网）。 */
  const sn = bodyOf(code, 'def skip_note(');
  if (!sn) {
    err(REL + ' 里找不到 `def skip_note(` —— 改名了就来更新本节');
    skipBad++;
  } else if (!has(sn, 'card_state(')) {
    err('`skip_note()` 没有调用 `card_state(` —— 跳过判据在它这里另起了一套，'
      + '于是与 `--stale` 分家（Q14 的病根）');
    skipBad++;
  } else if (!has(sn, 'enabled')) {
    err('`skip_note()` 没有接「开关」（找不到 `enabled`）—— 不启用 `--skip-existing` 时'
      + '它会把所有卡都判成可跳过，整轮一张都不出');
    skipBad++;
  }
  if (!mbody0 || !has(mbody0, 'skip_note(')) {
    err('`main()` 的出图循环没有调用 `skip_note(` —— 跳过这一步又散回循环里自己算，'
      + '两处判据必然分家');
    skipBad++;
  }
  /* 「只看文件在不在」这个写法**一处都不许留** */
  if (/args\.skip_existing\s+and\s+os\.path\.exists\(/.test(code)) {
    err(REL + ' 里还有 `args.skip_existing and os.path.exists(` 这种写法 —— 那正是 Q14 的病根'
      + '（判据是「文件在不在」而不是「内容对不对」），必须走 `card_state()`');
    skipBad++;
  }

  /* ② 判据必须覆盖四件事 —— 缺一项就是一类卡被静默放过 */
  const cs = bodyOf(code, 'def card_state(');
  if (!cs) {
    err(REL + ' 里找不到 `def card_state(` —— 改名了就来更新本节（不许当成「没有判据要检查」）');
    skipBad++;
  } else {
    [['-normal.png', '母版派生 `<id>-normal.png` 在不在（Q28：单独删它永远补不回来）'],
     ['os.path.exists(dst)', '文件本身在不在'],
     ['old != want', '提示词一致'],
     ['old_steps != steps', '步数一致']].forEach(([n, what]) => {
      if (!has(cs, n)) {
        err('`card_state()` 没检查 ' + what + ' —— 缺一项就是一类卡被静默放过');
        skipBad++;
      }
    });
  }

  /* ③ 两条「静默过期」的顺带修复 */
  if (rs && !has(rs, '无文件')) {
    err('`report_stale()` 没有把「无文件」排除出「过期」—— 还没出过的卡会被算成「过期」，'
      + '报告的数字从此对不上（「待出」与「过期」是两件事）');
    skipBad++;
  }
  if (!mbody0 || !has(mbody0, 'write_plan(')) {
    err('`main()` 收尾没有刷新 `docs/生图清单.md`（找不到 `write_plan(`）—— '
      + '清单的勾会一直停在旧状态，而它正是「下一轮跳不跳」的依据'
      + '（实测：卡全出齐了，清单还有 81 批打着「未完成」）');
    skipBad++;
  }

  /* ④ 耗时估计必须有实测来源 */
  const wp = bodyOf(code, 'def write_plan(');
  if (!wp || !has(wp, 'measured_sec(')) {
    err('`write_plan()` 没有用 `measured_sec()` —— 清单的「单条耗时 / 还要多久」又退回手填常数，'
      + '换台机器 / 改了步数就悄悄过期（Q16），而清单是排期的唯一依据');
    skipBad++;
  }
  if (!/^SEC_SAMPLE_MIN\s*=/m.test(code)) {
    err(REL + ' 里找不到 `SEC_SAMPLE_MIN =` —— 实测样本不足时的兜底阈值没了'
      + '（会拿两三个样本去排期）');
    skipBad++;
  }
  /* 逐张耗时：母版与档位**各记一次**，少一处就少一半样本 */
  const secRec = (code.match(/"sec":\s*sec/g) || []).length;
  if (secRec !== 2) {
    err('manifest 的 `sec` 不是母版与档位**各记一次**（实得 ' + secRec + ' 处）—— '
      + '少一处就等于少一半样本，`measured_sec()` 的中位失去代表性');
    skipBad++;
  }

  /* ⑤ 判据自检：唯一入口的计数与「只看文件在不在」的注入样本都必须认得出 */
  /* ⚠️ **不许写字面 `\n`** —— 源码里出现「反斜杠 + ndef + 空格」会被 §42 ⑧ 当成
     「拿下一个 def 当终止符」，本节的夹具自己就先撞了那条禁形（第一次就是这么报红的）。
     用 `String.fromCharCode(10)` 拼出来。 */
  const NL = String.fromCharCode(10);
  const dupSample = ['def card_state(a):', '    pass', '',
                     'def card_state(b):', '    pass', ''].join(NL);
  if ((dupSample.match(/^def card_state\(/gm) || []).length !== 2) {
    err('第 51 节判据自检不成立：`^def card_state(` 的计数认不出「两处定义」');
    skipBad++;
  }
  if (!/args\.skip_existing\s+and\s+os\.path\.exists\(/
      .test('        if args.skip_existing and os.path.exists(dst):')) {
    err('第 51 节判据自检不成立：「只看文件在不在」的注入样本没被那条正则认出来');
    skipBad++;
  }
  if (has('        if args.skip_existing:', 'card_state(')) {
    err('第 51 节判据自检不成立：空片段被认成「调用了 card_state」—— ③ 的判据恒真');
    skipBad++;
  }

  /* ⑥ 🔴 2026-10-10：**互斥锁的判据也只许有一处**（`lock_state()`），
     且一键启动器必须**去问出图脚本**（`--who`）而不是自己看一眼锁文件就拦住。
     为什么：启动器自写一份「看到锁就拦」必然**比出图脚本更严** —— 上一轮非正常退出
     留下的陈旧锁（pid 已死 / 心跳过期）明明可以接管，却白挡一轮；而进程被回收、
     锁留在盘上在本环境是**常态**。实测就是这么栽的：第一版 preflight 真拦住了一次
     「其实可以开跑」的启动。 */
  const lockDefs = (code.match(/^def lock_state\(/gm) || []).length;
  if (lockDefs !== 1) {
    err(`\`lock_state()\` 有 ${lockDefs} 处定义（应恰 1 处）—— 互斥锁判据分家 ⇒ `
      + '启动器与出图脚本会对「能不能开跑」给出不同答案，而且**两边都不报错**');
    skipBad++;
  }
  const lockBody = bodyOf(code, 'def lock_state(') || '';
  if (!has(lockBody, 'lock_alive(') || !has(lockBody, 'LOCK_STALE_SEC')) {
    err('`lock_state()` 没有同时用上 pid 存活判据与心跳阈值 —— '
      + '少了任一条，死进程留下的陈旧锁就会挡住下一轮（本项目最高频的坑型）');
    skipBad++;
  }
  if (!/^LOCK_STALE_SEC\s*=/m.test(code)) {
    err(REL + ' 里找不到 `LOCK_STALE_SEC =` —— 心跳过期阈值没了');
    skipBad++;
  }
  const mainLock = bodyOf(code, 'def main(') || '';
  /* ⚠️ 判据要盯**互斥那一段**（`if not args.plan:` 之后紧跟 `st = lock_state()` 与 `st["busy"]`），
     不能只问「main 里有没有出现过 `lock_state(`」—— `--who` 那一支自己也会调一次，
     于是「把互斥那段改成 `st = None`」的坏样本照样绿（本轮反向验证第 ③ 组当场逮到，
     改成「只搜赋值语句」也还是假的 —— `--who` 那一支同样有 `st = lock_state()`）。 */
  const lockSeg = (/if not args\.plan:[\s\S]{0,400}/.exec(mainLock) || [, ''])[0];
  if (!/st\s*=\s*lock_state\(\)/.test(lockSeg) || !/st\["busy"\]/.test(lockSeg)
      || !has(mainLock, 'lock_write()')) {
    err('`main()` 的互斥段不再由 `lock_state()` 决定（或 `lock_write()` 没了）—— '
      + '出图时的互斥判据被就地重写/绕开了');
    skipBad++;
  }
  const rr = path.join(ROOT, 'tools/rerender.py');
  if (!fs.existsSync(rr)) {
    err('缺 `tools/rerender.py` —— 一键启动器（`tools/gen-art-loop.cmd`）的编排层不见了；'
      + '`.cmd` 里写不了逻辑（ANSI 码页 + 会话里执行不了 cmd.exe ⇒ 写完等于没验证）');
    skipBad++;
  } else {
    const rrFull = fs.readFileSync(rr, 'utf8');
    if (!/--who/.test(rrFull)) {
      err('`tools/rerender.py` 的 preflight 没有走 `gen-art.py --who` —— '
        + '它自己写了一份锁判据（必然比出图脚本更严：陈旧锁会白挡一轮）');
      skipBad++;
    }
    /* 🔴 「有没有自己去读锁」的判据是**按行**判：锁的文件名**只许出现在给用户看的提示句里**
       （`say(...)` / `print(...)`，例如「删掉 assets/cards/.gen-art.lock 再重试」——
       那条提示对用户有用，不该被误判）。
       ⚠️ 第一版把「剥掉字符串再搜」当判据 ⇒ 假绿：真去读锁的写法 `os.path.exists(".../.gen-art.lock")`
       里路径**恰好就在字符串里**，剥完就什么都搜不到了（本轮反向验证第 ④ 组当场逮到）。
       ⚠️ 第二版「搜原文件」又假红：把上面那条提示句也算成「自己判锁」。按行判才对。 */
    const lockLines = rrFull.split('\n').filter(l => /\.gen-art\.lock/.test(l));
    const badLockLines = lockLines.filter(l => !/(say\(|print\()/.test(l));
    if (badLockLines.length) {
      err(`\`tools/rerender.py\` 里有 ${badLockLines.length} 行在**代码里**碰锁的路径（不是提示句）：`
        + badLockLines.map(l => '\n       ' + l.trim().slice(0, 90)).join('')
        + '\n       —— 自己判断锁 = 第二份判据，要问就问 `gen-art.py --who`');
      skipBad++;
    }
  }
  const loopCmd = path.join(ROOT, 'tools/gen-art-loop.cmd');
  if (fs.existsSync(loopCmd)) {
    const cmdSrc = fs.readFileSync(loopCmd, 'utf8');
    /* ⚠️ 要搜**可执行行**（非 `rem` 注释）—— 文件头那段说明里本来就写着
       「judgement lives in tools\rerender.py」，搜全文会让「实际调用被换掉」的
       坏样本照样绿（本轮反向验证第 ⑥ 组当场逮到）。 */
    const cmdLines = cmdSrc.split('\n').filter(l => !/^\s*rem\b/i.test(l)).join('\n');
    if (!/rerender\.py/.test(cmdLines)) {
      err('`tools/gen-art-loop.cmd` 没有调 `rerender.py` —— 逻辑又回到 `.cmd` 里了'
        + '（`.cmd` 只能纯 ASCII、且本项目的工具执行不了它，等于没验证）');
      skipBad++;
    }
    /* .cmd 必须纯 ASCII：cmd.exe 用系统 ANSI 码页读脚本，中文会被撕碎成乱命令。
       ⚠️ 只查这几份启动器，不扫全仓（`tools/` 下别的文件不是启动器）。 */
    const nonAscii = ['gen-art-loop.cmd', 'pick-shiny.cmd', 'review-desk.cmd', '评审台.cmd']
      .map(n => path.join(ROOT, 'tools', n)).filter(p => fs.existsSync(p))
      .filter(p => /[^\x00-\x7F]/.test(fs.readFileSync(p, 'utf8')));
    if (nonAscii.length) {
      err(`这些 .cmd 里有非 ASCII 字符：${nonAscii.map(p => path.basename(p)).join('、')}`
        + ' —— cmd.exe 用系统 ANSI 码页读脚本，中文会被撕碎成乱命令');
      skipBad++;
    }
  }

  if (!skipBad) {
    ok('生图管线判据同源：`card_state()` 一处定义、`--skip-existing` 与 `--stale` 共用它，'
      + '覆盖 文件 / 派生 / 提示词 / 步数 四项，清单收尾自动刷新，耗时估计有实测来源；'
      + '**互斥锁判据也只有 `lock_state()` 一处，启动器（`.cmd` → `rerender.py`）走 `--who` 问它、'
      + '自己不判锁，且四份启动器都是纯 ASCII**');
  }
})();


/* ---------------- 52. 传说档配色：色相必须铺开（Q5） ----------------
   病根（先量出来的）：取色一直是 `pal[i % len(pal)]`，而**七个钓场色带的第 0 位都是
   同一个偏青蓝的灰蓝**，传说档恰好落在每条色带的**头 / 尾** ⇒ 27 条传说里 **23 条（85%）
   挤在 180°~270°**，而 30°/60°/90°/120°/330° 五个 30° 带**全空**。
   这不是配色品味问题，是「传说恰好落在色带同一头」的必然结果。

   判据两条（都**从 fish.js 现算**，不写死任何颜色）：
     ① 数据侧：传说档（rar 3）的 body 色相铺在 12 个 30° 带里 —— **不许有空档**，
        且**最挤的一带不超过 `MAX_IN_BAND`**（27 条铺 12 带，平均 2.25 ⇒ 6 是「又挤成堆」的线）。
     ② 源头侧：`gen-fish.py` 里传说那一支**必须真的读那张专用表**（`rar == 3` 分叉里
        出现 `LEGEND_COLORS[`）—— 改回取模取色时 ① 会报红，这一条是「那张表还活着」的网。
   ⚠️ 判据只认**色相**，不看明度 / 饱和度：那两样是设计选择，色相挤不挤才是 Q5 的病。 */
console.log('\n[52] 传说档配色：色相必须铺开（不许再挤在同一头）');
{
  const MAX_IN_BAND = 6;              /* 12 带 × 6 = 72 席，27 条铺开绰绰有余 */
  const BANDS = 12;                   /* 每 30° 一带 */
  const rgbOf = (s) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => x / 255);
  };
  const hueOf = (s) => {
    const c = rgbOf(s);
    if (!c) return null;
    const mx = Math.max(...c), mn = Math.min(...c), d = mx - mn;
    if (d === 0) return 0;            /* 纯灰：色相无意义，归 0 带 */
    let h;
    if (mx === c[0]) h = ((c[1] - c[2]) / d) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  const legend = G.FISH.filter(f => f.rar === 3);
  const bad = [];
  const hist = new Array(BANDS).fill(0);
  const noHue = [];
  if (!legend.length) {
    bad.push('抓不到传说档（rar 3）—— 判据抓不到东西，先修本节判据本身');
  }
  legend.forEach(f => {
    const h = hueOf(f.body);
    if (h === null) { noHue.push(f.id); return; }
    hist[Math.floor(h / (360 / BANDS)) % BANDS]++;
  });
  if (noHue.length) bad.push('这些传说鱼的 body 不是 #rrggbb：' + noHue.join('、'));
  if (legend.length) {
    const empty = hist
      .map((n, i) => (n === 0 ? (i * 30) + '°~' + (i * 30 + 30) + '°' : null))
      .filter(Boolean);
    const top = Math.max(...hist);
    if (empty.length) {
      bad.push('这些 30° 色相带是空的：' + empty.join('、')
        + ' —— 传说配色又挤在同一头了（Q5 的病根就是这个）');
    }
    if (top > MAX_IN_BAND) {
      bad.push('最挤的一带里有 ' + top + ' 条（上限 ' + MAX_IN_BAND + '）—— 又挤成堆了');
    }
    /* ② 源头侧：那一支必须真的读专用表（`rar == 3` 分叉 → `LEGEND_COLORS[`）。 */
    const gfRaw = fs.readFileSync(path.join(ROOT, 'tools/gen-fish.py'), 'utf8');
    if (!/rar\s*==\s*3[\s\S]{0,500}?LEGEND_COLORS\s*\[/.test(gfRaw)) {
      bad.push('tools/gen-fish.py 里看不到「rar == 3 那一支读 LEGEND_COLORS[...]」'
        + ' —— 传说档多半又走回取模取色了');
    }
    if (bad.length) {
      err('传说档配色的色相没铺开：' + bad.join('；'));
    } else {
      ok('传说档配色：' + legend.length + ' 条铺在 ' + BANDS + ' 个 30° 色相带里（每带 '
        + Math.min(...hist) + '~' + top + ' 条，**无空档**、最挤的一带 ≤ ' + MAX_IN_BAND
        + '）、且取色走的是专用表（`gen-fish.py` 的 `rar == 3` 那一支读 `LEGEND_COLORS[...]`）');
    }
  } else if (bad.length) {
    err('传说档配色的色相没铺开：' + bad.join('；'));
  }
}

/* ===== 第 53 节：卡面后处理的规格必须单源（Q8）======================
   这一步（`tools/prep-cards.py`）把生图的 1152×768 抠图派生成 UI 直接能贴的两档。
   它有四处**改一处忘另一处就不报错**的地方，本节把它们钉在一起：
     · 规格常量（补边比例 / 两档尺寸）—— 只许一处，文档只描述、不抄出一份独立真相；
     · 派生物目录名 —— 脚本里的 `OUT_DIR` 与 `.gitignore` 必须同名（否则 `git add -A`
       会把 GB 级派生物卷进版本库，那是规范 §4 里唯一的高危动作）；
     · 目录名在两处之外必须**零出现**，且那两处（`src/core/assets.js` / `tools/test.js`）
       必须**真的出现** —— Q8 与 Q9 之间曾有顺序依赖（待办明写「顺序反了就要返工」），
       接线前是「零出现」，Q9 落地后翻转成「只许这两处、且必须出现」（详见 ④ 的注释）；
     · 主体度量（占比 / 包围盒 / 重心）只许经 `stats_of()` 出来，不许第二处按 alpha 再算。
   ⚠️ 判据取不到东西时**直接报错**（空集会让断言恒真 —— 本项目反复栽过的形态）。 */
console.log('\n[53] 卡面后处理：规格单源 + 派生物已 ignore + 文档数字现算（Q8）');
(function () {
  const bad = [];
  const prepSrc = fs.readFileSync(path.join(ROOT, 'tools', 'prep-cards.py'), 'utf8');
  /* 剥注释 / docstring（硬规矩 ①：只扫代码不扫注释）。本脚本的散文里点了几次
     `analyze()` 与目录名，不剥的话判据会被注释喂饱 —— 那是本项目反复栽过的假通过。 */
  const stripPy = t => String(t)
    .replace(/"""[\s\S]*?"""/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '').replace(/#[^\n]*/g, '');
  const prepCode = stripPy(prepSrc);
  /* ① 规格常量从此处现算（别处不许再写一遍） */
  let spec = null;
  const si = at(prepSrc, 'SPEC = {');
  if (si < 0) {
    bad.push('tools/prep-cards.py 里找不到 `SPEC = {`');
  } else {
    const ob = prepSrc.indexOf('{', si);
    const ce = closeOf(prepSrc, ob);
    const raw = (ob >= 0 && ce > 0) ? prepSrc.slice(ob, ce) : '';
    const mAsp = /"padAspect"\s*:\s*([0-9.]+)/.exec(raw);
    const mDet = /"detail"\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(raw);
    const mLst = /"list"\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(raw);
    if (mAsp && mDet && mLst) {
      spec = { asp: parseFloat(mAsp[1]), det: [+mDet[1], +mDet[2]], lst: [+mLst[1], +mLst[2]] };
    } else {
      bad.push('SPEC 里读不出 padAspect / detail / list 三个值（取不到就报错，不许静默跳过）');
    }
    if (spec && (Math.abs(spec.det[0] / spec.det[1] - spec.asp) > 1e-9
      || Math.abs(spec.lst[0] / spec.lst[1] - spec.asp) > 1e-9)) {
      bad.push('SPEC 自相矛盾：两档尺寸的宽高比不等于 padAspect');
    }
  }
  /* ② 模块级自校验必须在（规格写错时 import 就该炸，而不是安静地派生一整批）。
     ⚠️ 判据认的是「**这个函数在 + 它真的被调用**」两件事，不是「文本里出现过 raise」——
       认后者会被同一个文件里**另一处** `raise` 喂饱（本轮反向验证当场所见：把宽高比那道
       guard 整段删掉，剩下的「源/输出目录不许相同」那条照样让判据变绿 = 假通过）。 */
  const guardDef = (prepCode.match(/def assert_spec\(/g) || []).length;
  /* ⚠️ 数「被调用」不能拿 `assert_spec()` 直接 match：`def assert_spec():` 这个**定义行**
     本身就含这个子串 ⇒ 恒得 2、判据永远假通过（本轮反向验证当场逮到）。改成数
     **整行就是那句调用**的行。 */
  const guardCall = prepCode.split('\n').filter(l => l.trim() === 'assert_spec()').length;
  const ratioGuard = has(prepCode, 'SPEC["padAspect"]) > 1e-9');
  if (!ratioGuard || guardDef !== 1 || guardCall !== 1) {
    bad.push('prep-cards.py 的规格自校验不完整（宽高比 guard '
      + (ratioGuard ? '在' : '缺') + '；assert_spec 定义 ' + guardDef + ' 次 / 模块级调用 '
      + guardCall + ' 次，应为 1 / 1）');
  }
  /* ③ 目录名：源 ≠ 输出，且派生物目录已进 .gitignore */
  const mOut = /OUT_DIR = os\.path\.join\(ROOT, "assets", "([^"]+)"\)/.exec(prepSrc);
  const mSrc = /SRC_DIR = os\.path\.join\(ROOT, "assets", "([^"]+)"\)/.exec(prepSrc);
  if (!mOut || !mSrc) {
    bad.push('读不出 SRC_DIR / OUT_DIR（目录名只能有一处，别在别处重写）');
  } else {
    if (mOut[1] === mSrc[1]) bad.push('源目录 == 输出目录（会把源图覆盖掉）');
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    if (!has(gi, 'assets/' + mOut[1] + '/')) {
      bad.push('.gitignore 里没有 `assets/' + mOut[1] + '/` —— 派生物会被 git add -A 卷进库');
    }
    /* ④ 第二处写者 / 游戏侧接线：目录名只许出现在两处，且**必须**出现在第一处。
       ⚠️ 先剥注释（开发者文档 §8 硬规矩 ①：只扫代码不扫注释）—— 散文里提一句目录名
          是正常的（`check-cards.py` 的字段注释就点了名）；注释能把判据喂饱 = 假通过。
       ⚠️ 一律按 latin1 读（`.cmd` 可能是别的编码，用 utf8 读会抛）—— 要抓的是 ASCII 目录名。
       🔎 白名单的由来（Q9 接线时定的）：
          · `tools/prep-cards.py` —— 产出方（被扫时跳过）；
          · `src/core/assets.js`  —— **唯一取用口径**（Q9 之前这里是「零出现」，接线后翻转成
            「必须出现一次，且只许是它」）。做成「必须出现」是因为反过来也得防：
            把接线整段删掉（游戏侧又回到程序化绘制）不会有任何报错；
          · `tools/test.js` —— 自测里对拍 `resolve()` 拼出来的路径，**必须写死**才验得了。
            它不是第二份真相，恰恰是那份真相的**验证**。
        ⛔ 别处（`devtools.js` 的面板文案、任何一个 ui 模块）都不许再写一遍 ——
           写第二遍的唯一后果是「改了脚本忘改这里」，而它什么都不影响，没人会发现。 */
    const ALLOWED = ['src/core/assets.js', 'tools/test.js'];
    const stripAll = t => String(t)
      .replace(/"""[\s\S]*?"""/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '').replace(/#[^\n]*/g, '');
    const dup = [], seen = [];
    const scan = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).forEach(n => {
      const rel = dir + '/' + n, p = path.join(ROOT, rel);
      if (fs.statSync(p).isDirectory()) return scan(rel, re);
      if (!re.test(n) || rel === 'tools/prep-cards.py') return;
      if (stripPy(fs.readFileSync(p, 'latin1')).indexOf(mOut[1]) >= 0) {
        seen.push(rel);
        if (ALLOWED.indexOf(rel) < 0) dup.push(rel);
      }
    });
    scan('src', /\.(js|html)$/);
    scan('tools', /\.(js|py|cmd)$/);
    if (dup.length) {
      bad.push('这些文件里也出现了派生物目录名（' + dup.join('、') + '）—— 只许 src/core/assets.js '
        + '（唯一取用口径）与 tools/test.js（自测对拍）出现；别处出现 = 改脚本忘改它，静默漂开');
    }
    const miss = ALLOWED.filter(a => seen.indexOf(a) < 0);
    if (miss.length) {
      bad.push('派生物目录名没有出现在 ' + miss.join('、') + ' —— Q9 的接线被删掉了？'
        + '（游戏侧不再取 `assets/' + mOut[1] + '/` 的图，全体回退程序化绘制，而且不报错）');
    }
  }
  /* ⑤ 文档数字必须与 SPEC 现算值相等（§18 第 1 步「找反向陈述」的机器版） */
  if (spec) {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', '开发者文档.md'), 'utf8');
    const wantD = spec.det[0] + '\u00d7' + spec.det[1], wantL = spec.lst[0] + '\u00d7' + spec.lst[1];
    if (!has(doc, wantD) || !has(doc, wantL)) {
      bad.push('docs/开发者文档.md 里找不到现算的档位尺寸 ' + wantD + ' / ' + wantL + '（改了常量忘改文档）');
    }
  }
  /* ⑥ 主体度量入口唯一：`analyze(` 只许在 stats_of() 体内出现一次
     ⚠️ 两份都**先剥注释 / docstring**（硬规矩 ①）：本脚本的散文里点了几次 `analyze()`，
        不剥的话计数全是注释，判据等于没写。 */
  const stBody = stripPy(bodyOf(prepSrc, 'def stats_of('));
  const anaAll = (prepCode.match(/analyze\(/g) || []).length;
  const anaIn = (stBody.match(/analyze\(/g) || []).length;
  if (!stBody || anaAll !== 1 || anaIn !== 1) {
    bad.push('主体度量入口不唯一：全脚本 `analyze(` 共 ' + anaAll + ' 次、stats_of() 体内 '
      + anaIn + ' 次（应为 1 / 1）—— 第二处按 alpha 再算一遍就是两个「主体在哪」的口径');
  }
  /* ⑦ Q11 边缘去污染：轮数从 SPEC 现算、实现只有一处、**只改 RGB 并把原 alpha 原样带回**。
     ⚠️ 三个坑各有一条判据：
       · 轮数写死在小函数里 ⇒ 规格改了不去改它（反向验证：把 rounds 改成 1，这里的判据不动、
         但 test-review-cards.py 的 [19] 会报「污染只抹掉最外一层」）；
       · `bleed()` 多出一份实现 ⇒ 两个「边缘怎么补色」的口径（本项目的经典坑型）；
       · 忘了把原 alpha 带回去（顺手 `merge("RGBA", rgb.split() + (a,))` 用错变量）⇒
         **轮廓被改**且没有任何断言看得见 —— 这一条是本节最值钱的判据。 */
  const df = /"defringe"\s*:\s*\{[^}]*"rounds"\s*:\s*(\d+)[^}]*"alphaHi"\s*:\s*(\d+)/.exec(prepSrc);
  const mAlphaMin = /"alphaMin"\s*:\s*(\d+)/.exec(prepSrc);
  if (!df || !mAlphaMin) {
    bad.push('SPEC 里读不出 defringe（rounds / alphaHi）或 alphaMin（取不到就报错，不许静默跳过）');
  } else {
    const rounds = +df[1], alphaHi = +df[2], alphaMin = +mAlphaMin[1];
    if (!(rounds >= 4)) bad.push('defringe.rounds = ' + rounds + '（实测羽化 4~5px，<4 只抹最外一层）');
    if (!(alphaHi > alphaMin && alphaMin > 0)) {
      bad.push('defringe.alphaHi ' + alphaHi + ' 必须 > alphaMin ' + alphaMin + ' > 0（否则没有「边缘」可补）');
    }
    const bleedDef = (prepCode.match(/def bleed\(/g) || []).length;
    const bleedAll = (prepCode.match(/bleed\(/g) || []).length;
    const rdBody = stripPy(bodyOf(prepSrc, 'def render('));
    if (bleedDef !== 1 || bleedAll !== 2 || (rdBody.match(/bleed\(/g) || []).length !== 1) {
      bad.push('去污染入口不唯一：`def bleed(` ' + bleedDef + ' 处、脚本内 `bleed(` 共 ' + bleedAll
        + ' 次（应 def 1 + 调用 1 = 2）、render() 体内 ' + (rdBody.match(/bleed\(/g) || []).length
        + ' 次（应 1）—— 第二处实现 = 两个「边缘怎么补色」的口径');
    }
    const blBody = stripPy(bodyOf(prepSrc, 'def bleed('));
    if (!has(blBody, 'SPEC["defringe"]["rounds"]')) {
      bad.push('bleed() 体内没读 SPEC["defringe"]["rounds"]（轮数必须从规格现算）');
    }
    if (!has(blBody, 'Image.merge("RGBA", rgb.split() + (al,)')) {
      bad.push('bleed() 没有把**原 alpha** 原样带回（少了这句 = 抠图轮廓被改，且没有任何断言看得见）');
    }
    /* ⑧ 文档必须描述这一步，且轮数从 SPEC 现算（改了常量忘改文档 ⇒ 报红） */
    const doc2 = fs.readFileSync(path.join(ROOT, 'docs', '开发者文档.md'), 'utf8');
    if (!has(doc2, '边缘去污染')) {
      bad.push('docs/开发者文档.md 里没有描述「边缘去污染」（Q11 的落地只能有一处说明）');
    } else if (!has(doc2, '去污染 ' + rounds + ' 轮')) {
      bad.push('docs/开发者文档.md 里找不到现算的去污染轮数（要写成「去污染 ' + rounds
        + ' 轮」）—— 改了 SPEC 忘改文档');
    }
  }
  if (bad.length) {
    err('卡面后处理规格不一致：' + bad.join('；'));
  } else {
    ok('卡面后处理：规格单源（补边 ' + spec.asp + ':1、详情 ' + spec.det.join('\u00d7')
      + '、列表 ' + spec.lst.join('\u00d7') + '、边缘去污染 ' + df[1] + ' 轮只改 RGB 不动 alpha）、'
      + '派生物目录 `assets/' + mOut[1]
      + '/` 已进 .gitignore 且只出现在 src/core/assets.js（唯一取用口径）与 tools/test.js（自测对拍）两处、'
      + '文档数字与常量现算一致、主体度量只有 stats_of() 一处');
  }
})();

console.log('\n' + '='.repeat(52));
if (errors) {
  console.log(`\u2716 自检未通过：${errors} 个错误、${warns} 个警告\n`);
  process.exit(1);
} else {
  console.log(`\u2714 自检通过（${warns} 个警告）\n`);
}
