/* =========================================================
   tools/gen-collect-time.js  —  生成《收集耗时表》文档
   =========================================================
   输出：docs/收集耗时表.html
   内容：每个钓场每一条鱼的期望钓出时间；把颜色也算进去之后的期望时间。
   数据直接取自游戏本体（config / fields / fish / loot），
   改任何数值后重跑本脚本即可刷新。

   用法： node tools/gen-collect-time.js
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, CFG = G.CONFIG;

const FIGHT_EXP = [7.3, 22, 34, 50];

/* 收齐指定集合的期望竿数：E[T] = ∫₀^∞ [1 − Π(1 − e^(−p·t))] dt */
function expectedAll(ps) {
  if (!ps.length) return 0;
  let pmin = Infinity;
  for (const p of ps) if (p < pmin) pmin = p;
  if (!(pmin > 0)) return Infinity;
  const q = ps.map(p => p / pmin);
  const M = 1600, U = 95, h = U / M;
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

/* 单竿期望耗时（含咬口倍率） */
function cycleOf(field) {
  const w = G.Loot.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  const mul = field.biteMul || 1;
  let c = 0;
  for (let t = 0; t < 4; t++) {
    const bite = (CFG.rarity[t].timeMin + CFG.rarity[t].timeMax) / 2 * (t <= 1 ? mul : 1);
    c += (w[t] / tw) * (bite + FIGHT_EXP[t]);
  }
  return c;
}

function fmtHour(h) {
  if (!isFinite(h)) return '—';
  if (h < 1 / 60) return (h * 3600).toFixed(0) + ' 秒';
  if (h < 1) return (h * 60).toFixed(0) + ' 分钟';
  if (h < 48) return h.toFixed(1) + ' 小时';
  if (h < 24 * 60) return (h / 24).toFixed(1) + ' 天';
  if (h < 24 * 365 * 2) return (h / 24 / 365).toFixed(2) + ' 年';
  return (h / 24 / 365).toFixed(0) + ' 年';
}
function fmtNum(n) {
  if (!isFinite(n)) return '—';
  if (n < 1) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  return Math.round(n).toLocaleString('en-US');
}

const RAR_NAME = ['普通', '稀有', '史诗', '传说'];
const RAR_COLOR = ['#8b98a5', '#2b8fe0', '#8b5cf6', '#e8901a'];
/* 颜色表里最稀有 / 次稀有的颜色（用于明细表的两个额外列）
   ⚠️ 必须走 `G.Loot.colorProb()`：配置里的 `cm.prob`（单值写法）**早就删了**，
   原来这里是 `sort((a,b) => a.prob - b.prob)` → 比较器拿到 undefined，
   `undefined - undefined` 是 NaN → **排序完全没生效**（数组保持原顺序），
   于是「最稀有 · 最贵」被标在了**原色**那一行，两个额外列也印成了「该鱼原色 / 该鱼彩虹色」。
   不报任何错，只是把最稀有的颜色（闪光）和最贵的说反了。 */
const RAREST = CFG.colorMorphs.slice().sort((a, b) => G.Loot.colorProb(a, 0) - G.Loot.colorProb(b, 0));
const C_RARE = RAREST[0], C_NEXT = RAREST[1];

/* ---------------- 计算 ---------------- */
const fieldData = [];

G.FIELDS.forEach(field => {
  const list = G.FISH_BY_FIELD[field.id];
  const w = G.Loot.rarityWeights(field, {});
  const tw = w.reduce((a, b) => a + b, 0);
  const cyc = cycleOf(field);

  const rows = list.map(f => {
    const tier = G.FISH_BY_FIELD_RARITY[field.id][f.rar];
    const W = tier.reduce((a, b) => a + b.w, 0);
    const p = (w[f.rar] / tw) * (f.w / W);
    return {
      f, p,
      casts: 1 / p,
      hours: (1 / p) * cyc / 3600,
      /* 最稀有颜色（闪光）的期望 */
      rarestColor: CFG.colorMorphs[CFG.colorMorphs.length - 1],
    };
  });

  /* 品种全收 */
  const eAll = expectedAll(rows.map(r => r.p));
  /* 品种 × 颜色 全收 */
  const expanded = [];
  rows.forEach(r => CFG.colorMorphs.forEach(cm => expanded.push(r.p * G.Loot.colorProb(cm, r.f.rar))));
  const eColor = expectedAll(expanded);

  /* 各颜色在该场的综合出现概率与期望等待 */
  const colorStat = CFG.colorMorphs.map(cm => {
    let pc = 0;
    rows.forEach(r => { pc += r.p * G.Loot.colorProb(cm, r.f.rar); });
    return { cm, p: pc, casts: 1 / pc, hours: (1 / pc) * cyc / 3600 };
  });

  fieldData.push({
    field, rows, cyc, eAll, eColor, colorStat,
    hoursAll: eAll * cyc / 3600,
    hoursColor: eColor * cyc / 3600,
    combos: expanded.length,
  });
});

/* ---------------- 输出 HTML ---------------- */
let totalCombos = 0, totalColorHours = 0, totalAllHours = 0;
let cumAll = 0;
const summaryRows = fieldData.map(d => {
  totalCombos += d.combos;
  totalColorHours += d.hoursColor;
  totalAllHours += d.hoursAll;
  cumAll += d.hoursAll;
  return {
    rank: d.field.rank, name: d.field.name, n: d.rows.length,
    cyc: d.cyc, all: d.hoursAll, color: d.hoursColor,
    combos: d.combos, cum: cumAll,
    maxFish: d.rows.reduce((a, b) => (b.hours > a.hours ? b : a)),
  };
});

const worst = fieldData[fieldData.length - 1].rows.reduce((a, b) => (b.hours > a.hours ? b : a));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>收集耗时表 · 钓鱼人生</title>
<style>
  :root{ --ink:#1d3446; --ink2:#5b7488; --ink3:#93a9b8; --line:#d8e6f0; --bg:#eef6fb;
         --pri:#1f8fd6; --gold:#e8901a; --r0:#8b98a5; --r1:#2b8fe0; --r2:#8b5cf6; --r3:#e8901a; }
  *{box-sizing:border-box;}
  body{margin:0;padding:0 0 70px;background:var(--bg);color:var(--ink);
       font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
       font-size:14px;line-height:1.75;}
  .wrap{max-width:1400px;margin:0 auto;padding:0 26px;}
  header.top{background:linear-gradient(160deg,#1f8fd6,#1668a8);color:#fff;padding:42px 26px 36px;margin-bottom:26px;}
  header.top .wrap{padding:0;}
  h1{font-size:30px;margin:0 0 8px;letter-spacing:1px;}
  header.top p{margin:0;opacity:.92;font-size:14.5px;max-width:900px;}
  h2{font-size:20px;margin:44px 0 12px;padding-bottom:9px;border-bottom:2px solid #cfe3f0;}
  h3{font-size:16px;margin:30px 0 8px;}
  code{background:#e2eef7;border-radius:5px;padding:1px 6px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#1668a8;}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 20px;margin:14px 0;}
  .note{border-left:4px solid var(--pri);background:#f4fafe;padding:12px 18px;border-radius:0 10px 10px 0;margin:14px 0;font-size:13.5px;}
  .warn{border-left-color:var(--gold);background:#fffbf2;}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:12.5px;}
  th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;white-space:nowrap;}
  th{background:#f2f8fc;font-weight:700;font-size:12px;position:sticky;top:0;z-index:2;}
  tbody tr:nth-child(even){background:#fafdff;}
  .num{text-align:right;font-variant-numeric:tabular-nums;}
  .rk{display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:6px;color:#fff;font-weight:800;font-size:11px;}
  .tag{display:inline-block;padding:1px 8px;border-radius:8px;color:#fff;font-size:10.5px;font-weight:700;}
  .scroll{max-height:none;overflow:visible;}
  .fh{font-size:19px;font-weight:700;}
  .fmeta{font-size:12.5px;color:var(--ink2);}
  .kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:14px 0;}
  .kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 16px;}
  .kpi b{display:block;font-size:20px;line-height:1.3;}
  .kpi span{font-size:11.5px;color:var(--ink3);}
  a.toc{display:inline-block;padding:4px 12px;border-radius:14px;background:#fff;border:1px solid var(--line);
        color:var(--ink2);text-decoration:none;font-size:12px;margin:3px 5px 3px 0;}
  a.toc:hover{border-color:var(--pri);color:var(--pri);}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <h1>🎣 收集耗时表 · 钓鱼人生</h1>
  <p>每个钓场里每一条鱼的期望钓出时间，以及把「颜色变异」也算进去之后的期望时间。
     本页由 <code>tools/gen-collect-time.js</code> 从游戏数据直接生成，改数值后重跑即可刷新。</p>
</div></header>

<div class="wrap">
  <div class="card">
    <div class="toc">
      ${G.FIELDS.map(f => `<a class="toc" href="#f-${f.id}">${f.rank} ${f.name}</a>`).join('')}
      <a class="toc" href="#colors">颜色系统</a>
    </div>
  </div>

  <div class="card">
    <h3 style="margin-top:0">怎么读这张表</h3>
    <p><b>期望竿数</b> = 1 ÷ 这条鱼的单竿概率。注意这是「见到它一次」的期望，不是「收齐全部鱼」的期望。</p>
    <p><b>期望时间</b> = 期望竿数 × 该钓场的平均单竿耗时（含咬口倍率）。</p>
    <p><b>收齐全部品种</b>用精确公式算：
      <code>E[T] = ∫₀^∞ [1 − Π(1 − e^(−p·t))] dt</code>，
      它比「Σ(1/p)」小得多 —— Σ(1/p) 是「某一条鱼」的期望，不是「收齐所有鱼」的期望。</p>
    <p><b>把颜色也算进去</b>就是同一个公式，但目标集合扩成「品种 × 颜色」。
      颜色概率<b>随鱼的稀有度提高</b>（普通 1% &rarr; 传说 5%），它要求「每一条鱼都要出一次最稀有色」，所以这一列的数字会明显长于只收品种 —— 那是刻意的。</p>
  </div>

  <h2>一、总览</h2>
  <div class="kpis">
    <div class="kpi"><b>${G.FISH.length}</b><span>鱼种总数</span></div>
    <div class="kpi"><b>${G.FIELDS.length}</b><span>钓场</span></div>
    <div class="kpi"><b>${CFG.colorMorphs.length}</b><span>颜色变异</span></div>
    <div class="kpi"><b>${totalCombos}</b><span>品种×颜色 组合</span></div>
    <div class="kpi"><b>${fmtHour(totalAllHours)}</b><span>收齐全部品种</span></div>
    <div class="kpi"><b>${fmtHour(totalColorHours)}</b><span>收齐全部品种×颜色</span></div>
  </div>

  <table>
    <tr>
      <th>钓场</th><th class="num">鱼种</th><th class="num">单竿耗时</th>
      <th class="num">收齐品种</th><th class="num">累计</th>
      <th class="num">品种×颜色</th><th class="num">组合数</th>
      <th>最耗时的那条鱼</th>
    </tr>
    ${summaryRows.map(r => `<tr>
      <td><span class="rk" style="background:${{D:'#8b98a5',C:'#5aa9d6',B:'#3f8f5f',A:'#2b6fc4',S:'#3b4a8f',SS:'#5b3fa8',SSS:'#a87a1f'}[r.rank]}">${r.rank}</span> ${r.name}</td>
      <td class="num">${r.n}</td>
      <td class="num">${r.cyc.toFixed(1)} s</td>
      <td class="num"><b>${fmtHour(r.all)}</b></td>
      <td class="num">${fmtHour(r.cum)}</td>
      <td class="num" style="color:#e8595c">${fmtHour(r.color)}</td>
      <td class="num">${r.combos}</td>
      <td>${r.maxFish.f.name} <span style="color:var(--ink3)">（${fmtHour(r.maxFish.hours)}）</span></td>
    </tr>`).join('')}
  </table>

  <div class="note warn">
    <b>全场最难的一条鱼</b>：<b>${worst.f.name}</b>（${worst.f.field} 场）——
    单竿概率 ${(worst.p * 100).toExponential(2)}%（约 1/${Math.round(worst.casts).toLocaleString('en-US')}），
    期望 ${fmtHour(worst.hours)} 才能见到一次。
  </div>

  <h2 id="colors">二、颜色系统</h2>
  <div class="card">
    <p>每条鱼上钩时会额外掷一次颜色。颜色<b>不影响任何解锁判定</b>，只影响外观与售价系数。</p>
    <table>
      <tr><th>颜色</th><th class="num">售价系数</th>${RAR_NAME.map(n => `<th class="num">${n}</th>`).join('')}<th>说明</th></tr>
      ${CFG.colorMorphs.map(cm => `<tr>
        <td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${cm.tint || '#8b98a5'};border:1px solid rgba(0,0,0,.18);vertical-align:-1px"></span> <b>${cm.name}</b></td>
        <td class="num">&times;${cm.valueMul.toFixed(2)}</td>
        ${[0,1,2,3].map(t => `<td class="num">${(G.Loot.colorProb(cm, t) * 100).toFixed(1)}%</td>`).join('')}
        <td>${cm.key === C_RARE.key ? '<b style="color:#e8595c">最稀有 · 最贵</b>' : (cm.key === C_NEXT.key ? '第二稀有' : '')}</td>
      </tr>`).join('')}
    </table>
    <div class="note">
      ✅ <b>概率按鱼的稀有度分档</b>：<b>鱼越稀有，出稀有颜色的概率越高</b>。<br>
      <b>普通鱼这一行不变</b>（原色 76% / 彩虹色 10% / 白化 10% / 黄金 3% / 闪光 1%）；
      稀有 / 史诗 / 传说依次上调：彩虹色&middot;白化 10 &rarr; 11 &rarr; 16 &rarr; 20%，
      黄金 3 &rarr; 6 &rarr; 9 &rarr; 12%，闪光 1 &rarr; 2 &rarr; 3 &rarr; 5%。<br>
      每档内部始终保持 <b>原色 &gt; 彩虹色 &ge; 白化 &gt; 黄金 &gt; 闪光</b>，
      所以<b>闪光在所有档位都是最稀有的颜色</b>。
      售价系数 <b>闪光 ×100 最高</b>、黄金 ×10 —— 越稀有越值钱。
    </div>

    <h3>每个钓场里，各颜色的期望出现间隔</h3>
    <table>
      <tr>
        <th>钓场</th>
        ${CFG.colorMorphs.map(cm => `<th class="num">${cm.name}</th>`).join('')}
      </tr>
      ${fieldData.map(d => `<tr>
        <td><span class="rk" style="background:${{D:'#8b98a5',C:'#5aa9d6',B:'#3f8f5f',A:'#2b6fc4',S:'#3b4a8f',SS:'#5b3fa8',SSS:'#a87a1f'}[d.field.rank]}">${d.field.rank}</span> ${d.field.name}</td>
        ${d.colorStat.map(cs => `<td class="num">${fmtHour(cs.hours)}</td>`).join('')}
      </tr>`).join('')}
    </table>
    <p style="font-size:12.5px;color:var(--ink2)">
      含义：在该钓场随便下竿，平均要等这么久才会碰到一条「这种颜色」的鱼（不论品种）。
      颜色概率随稀有度提高，所以这里比按普通档算出来的要短一些。
    </p>
  </div>

  <h2>三、各钓场逐条明细</h2>
${fieldData.map(d => `
  <h3 id="f-${d.field.id}">
    <span class="rk" style="background:${{D:'#8b98a5',C:'#5aa9d6',B:'#3f8f5f',A:'#2b6fc4',S:'#3b4a8f',SS:'#5b3fa8',SSS:'#a87a1f'}[d.field.rank]}">${d.field.rank}</span>
    ${d.field.name}
    <span class="fmeta">· ${d.rows.length} 种 · 平均单竿 ${d.cyc.toFixed(1)} 秒 · 咬口倍率 ×${d.field.biteMul}</span>
  </h3>
  <div class="card">
    <div class="kpis">
      <div class="kpi"><b>${fmtHour(d.hoursAll)}</b><span>收齐全部品种（${d.rows.length} 种）</span></div>
      <div class="kpi"><b style="color:#e8595c">${fmtHour(d.hoursColor)}</b><span>连颜色一起收齐（${d.combos} 组合）</span></div>
      <div class="kpi"><b>×${(d.hoursColor / d.hoursAll).toFixed(1)}</b><span>颜色带来的放大倍数</span></div>
    </div>
    <div class="scroll">
    <table>
      <tr>
        <th>#</th><th>鱼名</th><th>稀有度</th><th>体型</th>
        <th class="num">单竿概率</th><th class="num">期望竿数</th><th class="num">期望时间</th>
        <th class="num">该鱼${C_RARE.name}<br><span style="font-weight:400">按档位</span></th><th class="num">该鱼${C_NEXT.name}<br><span style="font-weight:400">按档位</span></th>
      </tr>
      ${d.rows.map((r, i) => {
        const th = (cm) => (1 / (r.p * G.Loot.colorProb(cm, r.f.rar))) * d.cyc / 3600;
        return `<tr>
          <td class="num" style="color:var(--ink3)">${i + 1}</td>
          <td><b>${r.f.name}</b></td>
          <td><span class="tag" style="background:${RAR_COLOR[r.f.rar]}">${RAR_NAME[r.f.rar]}</span></td>
          <td style="color:var(--ink3)">${r.f.shape}</td>
          <td class="num">${(r.p * 100).toFixed(3)}%</td>
          <td class="num">${fmtNum(r.casts)}</td>
          <td class="num"><b>${fmtHour(r.hours)}</b></td>
          <td class="num" style="color:#e8595c">${fmtHour(th(C_RARE))}</td>
          <td class="num">${fmtHour(th(C_NEXT))}</td>
        </tr>`;
      }).join('')}
    </table>
    </div>
  </div>
`).join('')}

  <h2>四、结论</h2>
  <div class="card">
    <ul>
      <li><b>收齐全部品种</b>：${fmtHour(totalAllHours)}（7 个钓场累计）</li>
      <li><b>连颜色一起收齐</b>：${fmtHour(totalColorHours)}，共 ${totalCombos} 个组合</li>
      <li>放大倍数约 <b>${Math.round(totalColorHours / totalAllHours)} 倍</b> —— 原因就是${C_RARE.name}在普通鱼上只有 ${(G.Loot.colorProb(C_RARE, 0) * 100).toFixed(0)}%，
          而它要求「每一条鱼都要闪一次」</li>
      <li>所以颜色只能当收藏彩蛋，<b>绝不能写进解锁条件</b></li>
    </ul>
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, 'docs/收集耗时表.html'), html);
console.log('生成 docs/收集耗时表.html');
summaryRows.forEach(r => {
  console.log(`  ${r.rank.padEnd(4)} ${String(r.n).padStart(3)} 种  收齐品种 ${fmtHour(r.all).padStart(9)}  连颜色 ${fmtHour(r.color).padStart(10)}`);
});
console.log(`  合计：收齐品种 ${fmtHour(totalAllHours)} ｜ 连颜色 ${fmtHour(totalColorHours)}（${totalCombos} 组合）`);
