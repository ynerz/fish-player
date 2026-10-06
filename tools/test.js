/* =========================================================
   tools/test.js  —  单元测试（Node 直跑，零依赖）
   =========================================================
   覆盖：抽卡内核 Loot / 张力玩法 Fight / 存档与图鉴 State

   用法： node tools/test.js       ← 有失败时退出码为 1
   ========================================================= */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- 最小测试框架 ---------- */
let pass = 0, fail = 0, group = '';
const G_ = t => { group = t; console.log('\n' + t); };
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  \u2714 ' + msg); }
  else { fail++; console.log('  \u2716 ' + msg + (extra ? '  → ' + extra : '')); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg, `期望 ${b}±${tol}，实际 ${a.toFixed(4)}`); }

/* ---------- 模拟浏览器环境 ---------- */
global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/data/goals.js',
 'src/core/util.js', 'src/core/platform.js', 'src/core/loot.js', 'src/core/fight.js', 'src/core/state.js',
 'src/core/goals.js',
 'src/ui/tutorial.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));

const G = global.G, CFG = G.CONFIG, L = G.Loot, F = G.Fight, St = G.State, U = G.U;

/* =========================================================
   1. Loot —— 颜色
   ========================================================= */
G_('Loot · 颜色抽取');
[0, 1, 2, 3].forEach(t => {
  const N = 40000, cnt = {};
  for (let i = 0; i < N; i++) { const c = L.rollColor(t); cnt[c.key] = (cnt[c.key] || 0) + 1; }
  let worst = 0, wn = '';
  CFG.colorMorphs.forEach(c => {
    const want = L.colorProb(c, t) / L.colorProbTotal(t);
    const got = (cnt[c.key] || 0) / N;
    const rel = Math.abs(got - want) / want;
    if (rel > worst) { worst = rel; wn = c.name; }
  });
  ok(worst < 0.2, `${CFG.rarity[t].name}档分布吻合（最大偏差 ${(worst * 100).toFixed(1)}% · ${wn}）`);
});
ok(L.rollColor() != null, 'rollColor() 不传稀有度时不崩（兜底为普通档）');
ok(L.colorProb(CFG.colorMorphs[0], 99) === L.colorProb(CFG.colorMorphs[0], 0), 'rarIdx 越界时退回普通档');

/* =========================================================
   2. Loot —— 上鱼耗时与 biteMul
   ========================================================= */
G_('Loot · 咬口时长与 biteMul');
function biteExpect(t, field, n = 1200) {
  let s = 0;
  for (let i = 0; i < n; i++) s += L.biteTime(t, { field });
  return s / n;
}
const fD = G.FIELD_MAP.D, fSSS = G.FIELD_MAP.SSS;
near(biteExpect(0, fD), (CFG.rarity[0].timeMin + CFG.rarity[0].timeMax) / 2, 1.0, 'D 场普通档咬口 ≈ 区间中点（biteMul = 1）');
near(biteExpect(0, fSSS) / biteExpect(0, fD), fSSS.biteMul, 0.12, 'SSS 场普通档咬口 ≈ D 场 × biteMul');
near(biteExpect(3, fSSS) / biteExpect(3, fD), 1, 0.12, '传说档不吃 biteMul（与设计一致）');
ok(L.biteTime(0, { bait: { speed: 0.6 }, field: fD }) >= 0, '鱼饵速度系数不产生负值');

/* =========================================================
   3. Loot —— 售价与重量
   ========================================================= */
G_('Loot · 售价与重量');
const fish = G.FISH[0];
const gold = L.colorByKey('golden'), shiny = L.colorByKey('shiny');
ok(L.price(fish, fish.minKg, shiny, false) > L.price(fish, fish.minKg, gold, false),
   '闪光鱼比黄金鱼贵（售价系数 ×4.00 > ×2.30）');
ok(L.price(fish, fish.maxKg, gold, false) > L.price(fish, fish.minKg, gold, false), '同色下大鱼更贵');
const pNew = L.price(fish, fish.minKg, gold, true), pOld = L.price(fish, fish.minKg, gold, false);
ok(Math.abs(pNew - pOld * CFG.economy.firstCatchBonus) <= 1,
   `首捕奖励 = ×${CFG.economy.firstCatchBonus}（${pOld} → ${pNew}，四舍五入允许 ±1）`);
let bad = 0;
for (let i = 0; i < 3000; i++) {
  const k = L.rollKg(fish);
  if (!isFinite(k) || k <= 0) bad++;
}
ok(bad === 0, 'rollKg 3000 次全部为有限正数');
const kBig = (() => { let m = 0; for (let i = 0; i < 5000; i++) m = Math.max(m, L.rollKg(fish)); return m; })();
ok(kBig > fish.maxKg, `巨物溢出生效（最大 ${kBig.toFixed(2)}kg > 上限 ${fish.maxKg}kg）`);

/* =========================================================
   4. Fight —— 张力拉扯
   ========================================================= */
G_('Fight · 张力拉扯');
function fight(fishRar, kg, opts) {
  opts = opts || {};
  const f = G.FISH.filter(x => x.rar === fishRar)[0];
  F.begin({ fish: f, kg: kg || (f.minKg + f.maxKg) / 2, tensionMax: 100, reelMul: 1 });
  return f;
}
/* 一直按住 → 必断线 */
(() => {
  fight(2, null);
  let g = 0;
  while (!F.get().over && g++ < 60000) F.update(1 / 60, true);
  ok(F.get().result === 'snap', '全程按住 → 断线');
})();
/* 一直松手 → 必脱钩 */
(() => {
  fight(2, null);
  let g = 0;
  while (!F.get().over && g++ < 60000) F.update(1 / 60, false);
  ok(F.get().result === 'escape', '全程松手 → 脱钩');
})();
/* 自动驾驶 AI（与游戏内挂机同一套阈值）→ 各档胜率 */
(() => {
  const a = CFG.idle.auto;
  [0, 1, 2, 3].forEach(r => {
    let win = 0;
    for (let i = 0; i < 120; i++) {
      const f = fight(r, null);
      let hold = true, t = 0, g = 0;
      while (!F.get().over && g++ < 60000) {
        t += 1 / 60;
        if (t >= a.react) {
          t = 0;
          const st = F.get();
          if (st.dashing || st.warn > a.warn) hold = false;
          else if (st.tension >= st.tensionMax * a.hi) hold = false;
          else if (st.tension <= st.tensionMax * a.lo) hold = true;
        }
        F.update(1 / 60, hold);
      }
      if (F.get().result === 'success') win++;
      void f;
    }
    const rate = win / 120;
    ok(rate >= 0.85, `挂机 AI 在「${CFG.rarity[r].name}」档胜率 ${(rate * 100).toFixed(0)}%（≥85%）`);
  });
})();
/* 力竭机制：进度越高 tire 越小 */
(() => {
  fight(3, null);
  const st = F.get();
  st.progress = 10; F.update(1 / 60, true); const t1 = F.get().tire;
  st.progress = 95; F.update(1 / 60, true); const t2 = F.get().tire;
  ok(t2 < t1, `力竭生效：进度 10% 时 tire=${t1.toFixed(3)} > 进度 95% 时 tire=${t2.toFixed(3)}`);
})();
/* 超时兜底不在 Fight 内，由 fishing.js 负责 —— 这里测 snapshot 不崩 */
(() => {
  fight(1, null);
  const s = F.snapshot();
  ok(s && s.tension01 >= 0 && s.tension01 <= 1, 'snapshot() 数值在 0~1 之间');
  ok(s.safe01 === CFG.fight.safeRatio, 'snapshot 的安全线来自 config.fight.safeRatio');
  F.end();
  ok(F.snapshot() === null, 'Fight.end() 后 snapshot 返回 null');
})();

/* =========================================================
   5. State —— 存档 / 图鉴 / 解锁
   ========================================================= */
G_('State · 存档与图鉴');
St.load();
const s0 = St.get();
ok(s0.coin === CFG.economy.startCoin, '全新存档金币 = config.economy.startCoin');
ok(s0.unlocked.D === true && !s0.unlocked.C, '初始只解锁 D 钓场');

const f0 = G.FISH_BY_FIELD.D[0];
const r1 = St.recordCatch(f0, 0.5, 'normal');
ok(r1.isNew === true, '首次钓到 → isNew');
const r2 = St.recordCatch(f0, 0.9, 'shiny');
ok(r2.isNew === false && r2.isRecord === true, '再次钓到 + 更重 → isRecord');
const e = St.bookEntry(f0.id);
ok(e.n === 2 && e.maxKg === 0.9, '图鉴累计条数与最大重量正确');
ok(e.colors.normal === 1 && e.colors.shiny === 1, '颜色分项计数正确');

const p0 = St.fieldProgress('D');
ok(p0.got === 1 && p0.total === G.FISH_BY_FIELD.D.length, '钓场进度 = 1 / 本场鱼种数');
ok(St.needCount(16, 0.8) === 13, 'needCount(16, 80%) = 13（向上取整）');
ok(St.needCount(20, 1.0) === 20, 'needCount(20, 100%) = 20');

const cp = St.colorProgress();
ok(cp.total === G.FISH.length * CFG.colorMorphs.length, `颜色全集 = ${G.FISH.length} × ${CFG.colorMorphs.length} = ${cp.total}`);
ok(cp.got === 2, '已收集颜色数 = 2');

/* 金币安全 */
St.get().coin = 0;
St.addCoin(100); ok(St.get().coin === 100, 'addCoin 正常累加');
St.addCoin(-999); ok(St.get().coin === 0, 'addCoin 不会把金币扣成负数');
ok(St.spend(50) === false && St.get().coin === 0, '金币不足时 spend 返回 false');
St.addCoin(1000);
ok(St.spend(400) === true && St.get().coin === 600, 'spend 正常扣款');

/* 存读档往返 */
St.save(true);
const raw = store[CFG.saveKey];
ok(!!raw && raw.length > 100, `存档已写入 localStorage（${raw.length} 字节）`);
St.load();
ok(St.get().book[f0.id].n === 2, '重载后图鉴数据保持');

/* migrate：缺字段的老存档要能补上 */
G_('State · 老存档迁移');
const legacy = { v: 1, coin: 777, field: 'D', unlocked: { D: true }, book: {}, baits: {}, rods: ['bamboo'], lines: ['n2'], decors: [] };
store[CFG.saveKey] = JSON.stringify(legacy);
St.load();
const sm = St.get();
ok(sm.coin === 777, '老存档的既有字段保留');
ok(sm.stats && sm.stats.casts === 0, '缺失的 stats 被补成默认值');
ok(sm.settings && sm.settings.sound === true, '缺失的 settings 被补成默认值');
ok(sm.baitSel === 'worm', '缺失的 baitSel 补成 worm');
ok(!!sm.baits.worm, '缺失的鱼饵库存被补全');
ok(Array.isArray(sm.stats.byRar) && sm.stats.byRar.length === 4, '缺失的分维计数（byRar）被补全');

/* =========================================================
   5b. 鱼护 / 水族箱
   ========================================================= */
G_('State · 鱼护与水族箱');
St.reset();
const nf = G.FISH_BY_FIELD.D[1];
ok(St.netCount() === 0 && St.tankCount() === 0, '初始鱼护与水族箱都是空的');
ok(St.toNet(nf, 0.4, 'normal') === true, 'toNet 能把鱼放进鱼护');
ok(St.netCount() === 1, '鱼护数量 +1');
const nv = St.netValue();
ok(nv === St.netPrice(St.get().net[0]) && nv > 0, `鱼护估值 = ${nv} 金`);
ok(St.moveToTank(0) === true && St.netCount() === 0 && St.tankCount() === 1, '进水族箱后从鱼护移出');
ok(St.takeFromTank(0) === true && St.netCount() === 1 && St.tankCount() === 0, '取出后回到鱼护');

/* 容量上限 */
const cap = St.get().netCap;
for (let i = 0; i < cap + 5; i++) St.toNet(nf, 0.4, 'normal');
ok(St.netCount() === cap, `鱼护不会超过容量上限（${cap}）`);
ok(St.netFull() === true && St.toNet(nf, 0.4, 'normal') === false, '满了之后 toNet 返回 false');
ok(St.moveToTank(0) === false || St.tankCount() <= St.get().tankCap, '水族箱同样受容量约束');
/* 峰值占用：成就不能看当前条数，否则卖光之后进度会回退 */
ok(St.get().stats.netMax === cap, `鱼护历史最大占用被记到 ${cap}（成就「满载而归」用这个）`);

/* 卖出 / 放生 */
St.get().coin = 0;
const idx = 0;
const one = St.netPrice(St.get().net[idx]);
const got = St.sellNetAt(idx);
ok(got === one && St.get().coin === one, `单条卖出入账 ${one} 金`);
const before = St.netCount();
St.releaseNetAt(0);
ok(St.netCount() === before - 1 && St.get().coin === one, '放生不产生金币');
St.sellAllNet();
ok(St.netCount() === 0 && St.get().stats.netMax === cap, '卖光鱼护后历史峰值不回退（成就进度不会倒退）');
ok(G.Goals.metrics.netMax(St.get()) === cap, '成就取数走 stats.netMax，而不是当前条数');

/* 扩容 */
St.get().coin = 1e9;
const c0 = St.get().netCap;
const ex = St.expandNet();
ok(ex.ok === true && St.get().netCap === c0 + CFG.storage.netStep, `扩容后容量 ${c0} → ${St.get().netCap}`);
const t0c = St.get().tankCap;
const tex = St.expandTank();
ok(tex.ok === true && St.get().tankCap === t0c + CFG.storage.tankStep, '水族箱扩容量正确');
/* 扩到顶之后不能再扩 */
for (let i = 0; i < 10; i++) St.expandNet();
for (let i = 0; i < 10; i++) St.expandTank();
ok(St.netExpandCost() === null && St.expandNet().ok === false, '鱼护扩到上限后拒绝继续扩');
ok(St.tankExpandCost() === null && St.expandTank().ok === false, '水族箱扩到上限后拒绝继续扩');

/* =========================================================
   5c. 存档导入与数值兜底
   ========================================================= */
G_('State · 存档导入与 NaN 兜底');
St.reset();
St.addCoin(NaN);
ok(isFinite(St.get().coin), `addCoin(NaN) 不会污染金币（当前 ${St.get().coin}）`);
St.spend(NaN);
ok(isFinite(St.get().coin), 'spend(NaN) 不会污染金币');
St.recordCatch(nf, NaN, 'normal');
ok(isFinite(St.bookEntry(nf.id).maxKg), '重量 NaN 被兜成有限值');

ok(St.importSave('不是 json').ok === false, '导入非 JSON 被拒绝');
ok(St.importSave('[1,2,3]').ok === false, '导入数组被拒绝');
ok(St.importSave('{"foo":"bar"}').ok === false, '导入无关对象被拒绝');
const good = JSON.stringify({
  v: 1, coin: 12345, playTime: 3600, field: 'D', unlocked: { D: true },
  book: { [nf.id]: { n: 3, maxKg: 0.5, colors: { normal: 3 }, first: 1 } },
  baits: { worm: -1 }, rods: ['bamboo'], lines: ['n2'], decors: [],
});
const imp = St.importSave(good);
ok(imp.ok === true, '导入合法存档成功');
ok(St.get().coin === 12345, '导入后金币 = 12345（v1 老存档被正确迁移）');
ok(St.get().v === 4, '老存档版本号被升到 4（当前 SAVE_V）');
ok(Array.isArray(St.get().net) && Array.isArray(St.get().tank), 'v1 → v2 迁移补齐了鱼护字段');
ok(St.bookEntry(nf.id).n === 3, '导入后图鉴数据保留');

/* 脏数据：鱼护里塞了不存在的鱼种 */
const dirty = JSON.parse(good);
dirty.net = [{ f: 'NOT_A_FISH', kg: 1, c: 'normal' }, { f: nf.id, kg: 1, c: 'normal' }];
ok(St.importSave(JSON.stringify(dirty)).ok === true && St.netCount() === 1, '导入时会剔掉失效的鱼种条目');

/* =========================================================
   6. 数据一致性（轻量版，完整版见 tools/verify.js）
   ========================================================= */
G_('数据一致性');
let sumBad = 0;
G.FIELDS.forEach(f => { if (Math.abs(f.rarity.reduce((a, b) => a + b, 0) - 100) > 0.01) sumBad++; });
ok(sumBad === 0, '各钓场稀有度权重合计 100%');
let cBad = 0;
[0, 1, 2, 3].forEach(t => { if (Math.abs(L.colorProbTotal(t) - 1) > 1e-9) cBad++; });
ok(cBad === 0, '各稀有度档位的颜色概率合计 100%');
ok(G.FISH.length === 362, `鱼种总数 362（实际 ${G.FISH.length}）`);
ok(G.FIELDS.length === 7, `钓场总数 7（实际 ${G.FIELDS.length}）`);
ok(G.FIELDS.every(f => f.biteMul >= 1), '所有钓场 biteMul ≥ 1');
ok(G.FIELDS[0].biteMul === 1, '起始钓场 biteMul = 1');
ok(U.clamp(5, 0, 10) === 5 && U.clamp(-1, 0, 10) === 0, 'U.clamp 边界正确');

/* =========================================================
   6b. 放生生态值 / 水族箱被动收益 / 装饰货币（v0.5.2）
   ========================================================= */
const midKg = f => (f.minKg + f.maxKg) / 2;
const cCommon = G.FISH.filter(f => f.rar === 0)[0];
const cLegend = G.FISH.filter(f => f.rar === 3)[0];
const cEpic   = G.FISH.filter(f => f.rar === 2)[0];

G_('State · 放生生态值');
St.reset();
const ecoBase = St.ecoValue({ f: cCommon.id, kg: midKg(cCommon), c: 'normal' });
ok(ecoBase >= 1 && isFinite(ecoBase), `放生一条普通原色鱼 = ${ecoBase} 生态值`);
ok(St.ecoValue({ f: cCommon.id, kg: midKg(cCommon), c: 'shiny' }) > ecoBase, '闪光鱼放生给得更多');
ok(St.ecoValue({ f: cLegend.id, kg: midKg(cLegend), c: 'normal' }) > ecoBase, '传说鱼放生给得更多');
ok(St.ecoValue({ f: cCommon.id, kg: midKg(cCommon) * 2, c: 'normal' }) > ecoBase, '同种鱼更重给得更多');
ok(St.ecoValue({ f: 'NOT_A_FISH', kg: 1, c: 'normal' }) === 0, '失效鱼种返回 0，不崩');

St.reset();
St.toNet(cCommon, midKg(cCommon), 'normal');
const ecoBefore = St.get().eco || 0;
const rel = St.releaseNetAt(0);
ok(rel.ok === true && rel.eco > 0, `放生返回生态值 +${rel.eco}`);
ok(St.get().eco === ecoBefore + rel.eco, '生态值累加进存档');
ok(St.netCount() === 0 && St.get().coin === CFG.economy.startCoin, '放生不给金币，鱼从鱼护移除');
ok(St.get().stats.released === 1, '累计放生数 +1');
ok(St.releaseNetAt(99).ok === false, '越界放生返回 ok=false，不崩');

G_('State · 水族箱被动收益');
St.reset();
ok(St.tankYieldPerHour() === 0, '空水族箱产出 0');
St.toNet(cEpic, midKg(cEpic), 'normal');
St.toNet(cEpic, midKg(cEpic), 'shiny');
St.moveToTank(0); St.moveToTank(0);
ok(St.tankCount() === 2 && St.netCount() === 0, '两条鱼都进了水族箱');
const wN = G.Loot.tankYield(St.netPrice({ f: cEpic.id, kg: midKg(cEpic), c: 'normal' }));
const wS = G.Loot.tankYield(St.netPrice({ f: cEpic.id, kg: midKg(cEpic), c: 'shiny' }));
near(St.tankYieldPerHour(), wN + wS, 0.01, '产出 = 各条之和，且与 Loot.tankYield 同源');
ok(wS > wN, '闪光鱼产得更多（售价系数进了公式）');
/* 开平方压缩：身价 ×100 倍，产出只涨 10 倍（防止顶级鱼躺着赚超过主动钓） */
near(G.Loot.tankYield(20000) / G.Loot.tankYield(200), 10, 0.01, '产出随身价开平方增长（×100 身价 → ×10 产出）');

let tst = St.get();
tst.coin = 0; tst.tankSec = 0; tst.tankFrac = 0;
ok(St.tankTick(5) === 0, '不满一个结算周期不给钱');
let hourSum = 0;
for (let i = 0; i < 120; i++) hourSum += St.tankTick(CFG.storage.tankYieldTick);
near(hourSum, St.tankYieldPerHour(), Math.max(1, St.tankYieldPerHour() * 0.02),
     '累计结算满 1 小时 ≈ 每小时产出（分次结算不丢余量）');
ok(tst.coin === hourSum, '金币到账且与结算返回值一致');
ok(tst.stats.totalValue === 0, '被动收益不计入 stats.totalValue（成就要用「卖鱼收入」）');

/* 便宜的鱼：半小时产出不足 1 金，也必须能攒出来（零头不能被取整吃掉） */
St.reset();
St.toNet(cCommon, cCommon.minKg, 'normal');
St.moveToTank(0);
const cheapPer = St.tankYieldPerHour();
ok(cheapPer > 0 && cheapPer < 6, `一条小鱼每小时只产 ${cheapPer.toFixed(2)} 金`);
tst = St.get(); tst.coin = 0; tst.tankSec = 0; tst.tankFrac = 0;
let cheapGot = 0;
for (let i = 0; i < 360; i++) cheapGot += St.tankTick(CFG.storage.tankYieldTick);   // 3 小时
const expect3h = cheapPer * 3;
ok(cheapGot >= Math.floor(expect3h) && cheapGot <= Math.ceil(expect3h) + 1,
   `小鱼 3 小时拿到 ${cheapGot} 金（期望 ≈ ${expect3h.toFixed(2)}）—— ` +
   `单次取整会把它抹成 0，靠 tankFrac 零头累积才对`);

G_('State · 水族箱离线补算');
St.reset();
ok(St.tankCatchUp(36000).coin === 0, '空水族箱离线结算为 0');
St.toNet(cEpic, midKg(cEpic), 'normal');
St.moveToTank(0);
const per4 = St.tankYieldPerHour();
tst = St.get(); tst.coin = 0; tst.tankSec = 0; tst.tankFrac = 0;
ok(St.tankCatchUp(30).coin === 0, '离线不足 60 秒不结算');
const off1 = St.tankCatchUp(600);
ok(off1.coin > 0 && off1.seconds === 600 && off1.capped === false, `离线 10 分钟结算 ${off1.coin} 金`);
tst.tankFrac = 0;
const off2 = St.tankCatchUp(100 * 3600);
ok(off2.seconds === CFG.idle.maxCatchUp && off2.capped === true,
   `超长离线按 config.idle.maxCatchUp = ${CFG.idle.maxCatchUp}s 封顶`);
ok(off2.coin <= Math.ceil(per4 * CFG.idle.maxCatchUp / 3600), '封顶后不会多给');

G_('State · 装饰的三种货币');
St.reset();
const dGold = G.DECORS.filter(d => St.decorCur(d) === 'coin');
const dEco  = G.DECORS.filter(d => St.decorCur(d) === 'eco');
const dMed  = G.DECORS.filter(d => St.decorCur(d) === 'medal');
ok(G.DECORS.length >= 10, `装饰总数 ${G.DECORS.length} 件（≥10）`);
ok(dGold.length >= 8, `金币装饰 ${dGold.length} 件`);
ok(dEco.length >= 3 && dMed.length >= 2, `限定装饰：生态值 ${dEco.length} 件 / 纪念币 ${dMed.length} 件`);
ok(G.DECORS.every(d => d.draw), '每件装饰都有 draw 实现（不然玩家买了看不见）');
ok(G.DECORS.every(d => d.price > 0), '每件装饰都有正价格');
ok(Math.max.apply(null, dGold.map(d => d.price)) >= 1000000,
   `金币装饰最高价 ${Math.max.apply(null, dGold.map(d => d.price))}（通关后的金币沉淀）`);
let dupD = 0, seenD = {};
G.DECORS.forEach(d => { if (seenD[d.id]) dupD++; seenD[d.id] = 1; });
ok(dupD === 0, '装饰 id 无重复');

/* 金币买不到限定装饰 —— 这是「收集货币」和「数值货币」的分界线 */
St.get().coin = 1e9;
const badBuy = St.buyDecor(dEco[0].id);
ok(badBuy.ok === false && badBuy.msg.indexOf('生态值') >= 0, '金币再多也买不到生态值限定装饰');
ok(St.get().decors.indexOf(dEco[0].id) < 0, '失败的购买不会把装饰塞进存档');
St.get().coin = 0;
St.get().eco = dEco[0].price;
const ecoBuy = St.buyDecor(dEco[0].id);
ok(ecoBuy.ok === true && St.get().eco === 0, '生态值足够时能买，并扣掉生态值');
ok(St.buyDecor(dEco[0].id).ok === false, '同一件装饰不能买两次');
ok(St.buyDecor('NOT_A_DECOR').ok === false, '不存在的装饰被拒绝');
St.get().medals = 0;
ok(St.buyDecor(dMed[0].id).msg.indexOf('纪念币') >= 0, '纪念币不足时提示正确');
St.get().medals = dMed[0].price;
ok(St.buyDecor(dMed[0].id).ok === true && St.get().medals === 0, '纪念币足够时能买，并扣掉纪念币');
/* 买完之后金币不会被误扣 */
St.get().coin = 500;
St.get().eco = dEco[1].price;
St.buyDecor(dEco[1].id);
ok(St.get().coin === 500, '用生态值买装饰不会动金币');

/* =========================================================
   7. Goals —— 每日任务 / 成就 / 称号（B5）
   ========================================================= */
G_('Goals · 每日任务生成');
St.reset();
G.Goals.init();
const daily0 = G.Goals.day();
ok(daily0 && /^\d{4}-\d{2}-\d{2}$/.test(daily0.day), `任务归属日期格式正确（${daily0 && daily0.day}）`);
const qs = G.Goals.quests();
ok(qs.length === G.QUEST_PER_DAY, `每天生成 ${G.QUEST_PER_DAY} 条任务`);
ok(new Set(qs.map(q => q.t.id)).size === qs.length, '同一天的任务类型不重复');
ok(qs.every(q => q.need > 0 && isFinite(q.cur) && q.pct >= 0 && q.pct <= 1), '任务目标与进度都是有限数，进度在 0~1');
ok(qs.every(q => q.text && q.text.length > 3), '每条任务都有可读文案');
ok(daily0.q.every(q => typeof q.key === 'string'), '任务的上下文 key 都是字符串');
const snapQ = JSON.stringify(G.Goals.day().q);
G.Goals.ensureDay(true);
ok(JSON.stringify(G.Goals.day().q) === snapQ, '同一天重复 ensureDay 不会重掷任务');
ok(typeof daily0.base[qs[0].t.metric] === 'number', `当天基准值已记录（${qs[0].t.metric} = ${daily0.base[qs[0].t.metric]}）`);

/* 进度 = 当前累计 − 当天基准；基准高于当前时必须 clamp 到 0 */
daily0.base[qs[0].t.metric] += 5;
ok(G.Goals.quests()[0].cur === 0, '进度不会算成负数（clamp 到 0）');

/* 跨天重掷 */
St.get().daily.day = '1999-01-01';
G.Goals.ensureDay(true);
ok(St.get().daily.day !== '1999-01-01', '跨天后旧任务被重掷');

G_('Goals · 进度推进与领取');
St.reset();
G.Goals.init();
const d2 = St.get().daily;
d2.q[0] = { tpl: 'catch', need: 3, key: '', seen: false };
d2.base = { catch: St.get().stats.catches };
d2.claimed = [false, false, false];
ok(G.Goals.quests()[0].cur === 0, '重写任务后进度从 0 开始');
St.get().stats.catches += 3;
const q2 = G.Goals.quests()[0];
ok(q2.done === true && q2.pct === 1, '统计推进 3 条 → catch 任务达成');
ok(G.Goals.medalClaimable() === 1, '有 1 条可领取');
const m0 = G.Goals.medals();
const cl = G.Goals.claim(0);
ok(cl.ok === true && G.Goals.medals() === m0 + 1, `领取任务 +1 纪念币（${m0} → ${G.Goals.medals()}）`);
ok(G.Goals.claim(0).ok === false, '同一条任务不能重复领取');
ok(G.Goals.claim(99).ok === false, '越界下标不会崩');
d2.q[0].need = 0;
ok(G.Goals.quests()[0].done === true, 'need 归零 → 判定完成（作弊面板用的就是这招）');

/* 取数口径 */
const S_ = St.get();
ok(G.Goals.metrics.catch(S_) === S_.stats.catches, 'metrics.catch = stats.catches');
ok(G.Goals.metrics.rareUp(S_) === S_.stats.byRar[1] + S_.stats.byRar[2] + S_.stats.byRar[3],
   'metrics.rareUp = 稀有+史诗+传说 三档之和');
ok(G.Goals.fmtVal({ fmt: null }, 3.7) === '4', 'fmtVal 默认取整');
ok(G.Goals.fmtVal({ fmt: v => v.toFixed(1) + ' kg' }, 3.25) === '3.3 kg', 'fmtVal 走自定义格式化');

G_('Goals · 成就（纯派生）');
St.reset();
G.Goals.init();
const ap0 = G.Goals.achProgress();
ok(ap0.total === G.ACHIEVEMENTS.length && ap0.total >= 30, `成就总数 ${ap0.total}（≥30）`);
ok(ap0.got === 0, '全新存档没有任何成就达成');

St.noteResult(true); St.noteResult(true); St.noteResult(true);
ok(St.get().stats.streak === 3 && St.get().stats.maxStreak === 3, '连续成功计数正确');
St.noteResult(false);
ok(St.get().stats.streak === 0 && St.get().stats.maxStreak === 3, '失败归零但保留历史最长纪录');
for (let i = 0; i < 10; i++) St.noteResult(true);
ok(G.Goals.achievements().find(a => a.id === 's10').done === true, '连续成功 10 竿 → 成就「手感来了」达成');

const ff = G.FISH[0];
St.recordCatch(ff, 1, 'normal', { bait: 'worm', env: { wx: 'rain', tm: 'night' } });
const stt = St.get().stats;
ok(stt.byRar[ff.rar] === 1, 'byRar 按稀有度分档计数');
ok(stt.byField[ff.field] === 1, 'byField 按钓场计数');
ok(stt.byBait.worm === 1 && stt.byWx.rain === 1 && stt.byTm.night === 1, 'byBait / byWx / byTm 分别计数');
ok(G.Goals.metrics.baitUsed(St.get()) === 1, 'baitUsed = 已上过鱼的鱼饵种类数');
/* 不传 ctx 也必须合法（devtools / 离线补算就是这么调的） */
St.recordCatch(ff, 1, 'normal');
ok(St.get().stats.byRar[ff.rar] === 2, '不传 ctx 的 recordCatch 不会崩，byRar 照常累加');

G.FISH.forEach(f => { if (!St.isCaught(f.id)) St.recordCatch(f, (f.minKg + f.maxKg) / 2, 'normal'); });
const ach = G.Goals.achievements();
ok(ach.find(a => a.id === 'b1').done && ach.find(a => a.id === 'b362').done, '填满图鉴 → 图鉴类成就全部达成');
ok(ach.find(a => a.id === 'f7').got < 7, '没解锁的钓场不会被算进「七海旅人」');
ok(ach.every(a => isFinite(a.got) && a.pct >= 0 && a.pct <= 1), '所有成就进度都是有限数且在 0~1');
/* 成就是纯派生的：不占存档字段 */
ok(St.get().ach === undefined, '成就状态没有被写进存档（只有「已播报 id」列表）');
ok(St.get().daily.q.some(q => q.need > 0), '每日任务仍然独立存在');

G_('Goals · 称号与纪念币');
const ts = G.Goals.titles();
ok(ts[0].id === '', '称号列表第一位是「无称号」（默认）');
ok(ts.some(t => t.name === '万鱼之书'), '达成成就后解锁对应称号');
ok(G.Goals.equipped().id === '', '默认不佩戴称号');
ok(G.Goals.equip('ach:b362') === true && G.Goals.equipped().name === '万鱼之书', '可以佩戴已解锁的称号');
ok(G.Goals.equip('ach:zzz') === false && G.Goals.equipped().name === '万鱼之书', '不能佩戴不存在的称号');
ok(G.Goals.equip('') === true && G.Goals.equipped().id === '', '可以卸下称号');
St.get().medals = 40; St.save(true);
ok(G.Goals.medals() === 40 && G.Goals.titles().some(t => t.name === '赶海人'), '纪念币到 40 解锁称号「赶海人」');
ok(!G.Goals.titles().some(t => t.name === '纪念收藏家'), '纪念币不够时不解锁更高档称号');
/* 称号只解锁不消耗，纪念币没有消费出口 —— 这是设计约束，不是漏做 */
ok(G.Goals.medals() === 40, '解锁称号不消耗纪念币（纪念币是纯计数，买不到任何数值）');

G_('Goals · 老存档迁移（v2 → v3）');
const legacy2 = {
  v: 2, coin: 500, playTime: 3600, field: 'D', unlocked: { D: true },
  book: {}, baits: { worm: -1 }, rods: ['bamboo'], lines: ['n2'], decors: [],
  net: [], tank: [], netCap: 30, tankCap: 6, netEx: 0, tankEx: 0,
  stats: { casts: 3, catches: 4, escapes: 0, snaps: 0, idleCatches: 0,
           maxKg: 2, maxKgFish: 'x', totalValue: 100, days: 0 },
  settings: { sound: true, volume: 0.5, ambient: true, idle: false },
};
store[CFG.saveKey] = JSON.stringify(legacy2);
St.load();
const sv = St.get();
ok(sv.v === 4, '老存档版本号被升到 4');
ok(Array.isArray(sv.stats.byRar) && sv.stats.byRar.length === 4, 'byRar 被补成 4 档');
ok(sv.stats.byRar.every(x => x === 0), 'byRar 初始全 0');
ok(sv.stats.byField && typeof sv.stats.byField === 'object' && !Array.isArray(sv.stats.byField), 'byField 被补成对象');
ok(sv.stats.netKept === 0 && sv.stats.streak === 0 && sv.stats.maxStreak === 0, '新增统计字段都有默认值');
ok(sv.medals === 0 && sv.titleSel === '' && sv.daily === null, '纪念币 / 称号 / 每日任务都有默认值');
ok(sv.stats.catches === 4 && sv.coin === 500, '老存档既有数据不受影响');
ok(sv.achInit === false, 'v2 → v3 标记「成就还没补登记」，避免老档一进来刷屏');

const dirty2 = JSON.parse(JSON.stringify(legacy2));
dirty2.stats.byRar = 'oops'; dirty2.stats.byField = [1, 2]; dirty2.medals = -5; dirty2.titleSel = 123;
dirty2.stats.streak = NaN;
store[CFG.saveKey] = JSON.stringify(dirty2);
St.load();
const sd = St.get();
ok(Array.isArray(sd.stats.byRar) && sd.stats.byRar.length === 4, '脏 byRar 被纠正成 4 档数组');
ok(!Array.isArray(sd.stats.byField), '脏 byField 被纠正成对象');
ok(sd.medals === 0, '负数纪念币被纠正为 0');
ok(typeof sd.titleSel === 'string', '非字符串称号被纠正成字符串');
ok(isFinite(sd.stats.streak), 'NaN 的连续成功计数被兜住');
/* 迁移完仍然能正常接入目标系统 */
G.Goals.init();
ok(G.Goals.quests().length === G.QUEST_PER_DAY, '迁移后的存档也能正常生成每日任务');
ok(G.Goals.achProgress().total === G.ACHIEVEMENTS.length, '迁移后的存档也能算出成就列表');

G_('Goals · 数据完整性');
const ids = new Set(); let dup = 0;
G.ACHIEVEMENTS.forEach(a => { if (ids.has(a.id)) dup++; ids.add(a.id); });
ok(dup === 0, `成就 id 无重复（${G.ACHIEVEMENTS.length} 条）`);
ok(G.ACHIEVEMENTS.every(a => G.Goals.metrics[a.metric] && typeof G.Goals.metrics[a.metric] === 'function'),
   '每条成就的 metric 都有对应实现');
ok(G.ACHIEVEMENTS.every(a => a.need > 0 && a.name && a.desc), '每条成就都有 need / name / desc');
ok(G.ACHIEVEMENTS.every(a => G.ACH_CATS.some(c => c.key === a.cat)), '每条成就的分类合法');
const tids = new Set(); let tdup = 0;
G.QUEST_TPL.forEach(t => { if (tids.has(t.id)) tdup++; tids.add(t.id); });
ok(tdup === 0, `任务模板 id 无重复（${G.QUEST_TPL.length} 条）`);
ok(G.QUEST_TPL.every(t => G.Goals.metrics[t.metric] && typeof t.text === 'function' && (t.pool || t.poolFn)),
   '每个任务模板字段完整（metric / text / pool）');
ok(G.QUEST_TPL.every(t => !t.pool || t.pool.every(n => n > 0)), '任务目标值都是正数');
ok(G.QUEST_TPL.every(t => typeof t.text(1, '', St.get()) === 'string'), '任务文案函数都能正常产出字符串');
ok(G.QUEST_PER_DAY >= 1 && G.QUEST_PER_DAY <= G.QUEST_TPL.length, '每日条数不超过模板总数');
const titled = G.ACHIEVEMENTS.filter(a => a.title).length + G.MEDAL_TITLES.length;
ok(titled >= 10, `称号数量 ≥10（成就 ${G.ACHIEVEMENTS.filter(a => a.title).length} + 纪念币 ${G.MEDAL_TITLES.length}）`);

/* =========================================================
   8. Tutorial —— 新手引导（B6 / v0.5.3）
   ========================================================= */
G_('Tutorial · 配置');
const T = G.Tutorial;
const tSteps = CFG.tutorial.steps;
const tById = id => tSteps.filter(s => s.id === id)[0];
ok(tSteps.length === 5, `引导共 ${tSteps.length} 步（抛竿 / 提竿 / 收线 / 放线 / 躲逃窜）`);
ok(tSteps.map(s => s.id).join(',') === 'cast,strike,hold,release,dash', '步骤顺序正确');
const tIds = {}; let tDup = 0;
tSteps.forEach(s => { if (tIds[s.id]) tDup++; tIds[s.id] = 1; });
ok(tDup === 0, '步骤 id 无重复');
ok(tSteps.every(s => s.text && s.tip && ['btn', 'fight'].indexOf(s.place) >= 0),
   '每步都有文案 / 提示 / 合法的挂载位置');
ok(tSteps.every(s => ['idle', 'bite', 'fight'].indexOf(s.showWhen) >= 0), '每步的 showWhen 都是合法阶段');
/* 阶段必须对得上：浮漂还没动静就喊「快提竿」等于教坏人 */
ok(tById('cast').showWhen === 'idle', '「抛竿」只在可以抛竿时出现');
ok(tById('strike').showWhen === 'bite', '「提竿」只在咬钩窗口内出现');
ok(['hold', 'release', 'dash'].every(id => tById(id).showWhen === 'fight'),
   '收线 / 放线 / 躲逃窜三步都只在拉扯中出现');
ok(CFG.tutorial.enabled === true && CFG.tutorial.holdNeed > 0 && CFG.tutorial.doneHold > 0,
   '引导总开关与时长参数都是有效值');

G_('Tutorial · 状态机');
St.reset();
ok(T.stepCount() === tSteps.length, 'stepCount() 与 config.tutorial.steps 一致');
ok(T.active() === true && T.stepIndex() === 0, '全新存档 → 从第 1 步开始');
ok(St.get().tut.done === false, '存档里记着「还没看过」');
T.update(0.016, 'idle', null);
ok(T.stepIndex() === 0, '停在 idle 不推进（等玩家抛竿）');
T.update(0.016, 'flying', null);
ok(T.stepIndex() === 1, '抛竿（→ flying）→ 学会第 1 步');
T.update(0.016, 'waiting', null);
ok(T.stepIndex() === 1, '等鱼期间不推进（这一步要等咬钩）');
T.update(0.016, 'bite', null);
ok(T.stepIndex() === 1, '咬钩本身不算学会提竿');
T.update(0.016, 'fight', { holding: false, dashing: false });
ok(T.stepIndex() === 2, '进入拉扯（= 提竿成功）→ 学会第 2 步');
T.update(0.5, 'fight', { holding: true, dashing: false });
ok(T.stepIndex() === 2, `按住不足 ${CFG.tutorial.holdNeed}s 不算学会`);
T.update(0.6, 'fight', { holding: true, dashing: false });
ok(T.stepIndex() === 3, `按住累计到 ${CFG.tutorial.holdNeed}s → 学会第 3 步`);
T.update(0.1, 'fight', { holding: true, dashing: false });
ok(T.stepIndex() === 3, '还按着，不推进');
T.update(0.1, 'fight', { holding: false, dashing: false });
ok(T.stepIndex() === 4, '松手 → 学会第 4 步');
T.update(0.1, 'fight', { holding: false, dashing: true });
ok(T.stepIndex() === 4, '鱼刚开始发力还不算躲过');
T.update(0.1, 'fight', { holding: false, dashing: false });
ok(T.stepIndex() === 5, '逃窜结束且没断线 → 学会第 5 步');
ok(T.active() === false && St.get().tut.done === true, '5 步走完 → 引导永久关闭并写进存档');
ok(St.get().tut.step === tSteps.length, '存档里的 step = 总步数');
T.update(CFG.tutorial.doneHold + 0.1, 'idle', null);
ok(T.active() === false, '收尾提示自己消失，之后不再回到引导');
St.save(true); St.load();
ok(St.get().tut.done === true, '读档后「已看过」保持（不会重复弹）');

G_('Tutorial · 跳过 / 重看 / 挂机');
St.reset();
T.restart();
ok(T.active() === true && T.stepIndex() === 0, '「重看引导」把进度清零');
T.finish();
ok(T.active() === false && St.get().tut.done === true, '「跳过」直接标成已看过');
St.reset(); T.restart();
St.setIdle(true);
T.update(0.016, 'flying', null);
ok(T.stepIndex() === 0, '挂机模式下不推进（AI 替你操作，教不了人）');
St.setIdle(false);
/* 关掉挂机后玩家自己抛竿：引导从当前步骤继续（挂机期间 AI 的操作不算「学会」） */
T.update(0.016, 'idle', null);
T.update(0.016, 'flying', null);
ok(T.stepIndex() === 1, '关掉挂机后，玩家自己抛竿仍然能推进引导');
St.save(true); St.load();
ok(St.get().tut.step === 1 && St.get().tut.done === false, '中途进度写进了存档（关页面不会重来）');

G_('Tutorial · 老存档迁移与脏数据');
const legacy3 = JSON.parse(JSON.stringify(legacy2));
store[CFG.saveKey] = JSON.stringify(legacy3);
St.load();
ok(St.get().v === 4, '老存档版本号被升到 4（当前 SAVE_V）');
ok(St.get().tut && St.get().tut.done === true, '老存档（v<4）默认「已看过」，不往老玩家脸上糊教学');
ok(T.active() === false, '所以老存档不会弹教学气泡');
const dirtyT = JSON.parse(JSON.stringify(legacy2));
dirtyT.tut = { step: 'oops', done: 'yes' };
store[CFG.saveKey] = JSON.stringify(dirtyT);
St.load();
ok(St.get().tut.step === 0 && St.get().tut.done === true, '脏 tut 被纠正成 0..N 的整数 + 布尔');
const overT = JSON.parse(JSON.stringify(legacy2));
overT.v = 4; overT.tut = { step: 99, done: false };
store[CFG.saveKey] = JSON.stringify(overT);
St.load();
ok(St.get().tut.step === tSteps.length && St.get().tut.done === true, 'step 越界被夹回总步数并视为已完成');
const badT = JSON.parse(JSON.stringify(legacy2));
badT.v = 4; badT.tut = 'nonsense';
store[CFG.saveKey] = JSON.stringify(badT);
St.load();
ok(!!St.get().tut && St.get().tut.step === 0 && St.get().tut.done === false, 'tut 不是对象时重建为默认值');
St.reset();
ok(St.get().tut.step === 0 && St.get().tut.done === false, '重置存档后引导重新开始');

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (fail) { console.log(`\u2716 测试未通过：${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`\u2714 全部通过：${pass} 项\n`);
