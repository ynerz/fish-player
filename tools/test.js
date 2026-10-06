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
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js', 'src/core/state.js']
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

/* 卖出 / 放生 */
St.get().coin = 0;
const idx = 0;
const one = St.netPrice(St.get().net[idx]);
const got = St.sellNetAt(idx);
ok(got === one && St.get().coin === one, `单条卖出入账 ${one} 金`);
const before = St.netCount();
St.releaseNetAt(0);
ok(St.netCount() === before - 1 && St.get().coin === one, '放生不产生金币');

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
ok(St.get().v === 2, '老存档版本号被升到 2');
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

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (fail) { console.log(`\u2716 测试未通过：${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`\u2714 全部通过：${pass} 项\n`);
