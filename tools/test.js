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
 'src/core/goals.js', 'src/core/weather.js', 'src/core/fishing.js', 'src/core/track.js',
 'src/render/mesh3d.js', 'src/render/fishmesh.js', 'src/render/fishpaint.js',
 'src/ui/tutorial.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));

const G = global.G, CFG = G.CONFIG, L = G.Loot, F = G.Fight, St = G.State, U = G.U;
/* fishing.js 是纯逻辑（渲染靠 G.Scene，只在运行时才碰），所以能在 Node 里单测。
   让离线补算这类「只有关闭页面才走到」的路径也有断言覆盖。 */
const Fish = G.Fishing;

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
   '闪光鱼比黄金鱼贵（售价系数 ×100 > ×10）');
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
/* 安全线只有一处来源：config.js。fight.js 与 UI 都必须读它。 */
ok(F.SAFE === CFG.fight.safeRatio, 'Fight.SAFE 直接取自 CFG.fight.safeRatio（没有第二份常数）',
   `Fight.SAFE=${F.SAFE} / CFG=${CFG.fight.safeRatio}`);
ok(CFG.fight.safeRatio > 0 && CFG.fight.safeRatio < 1, 'safeRatio 是 0~1 的占比');
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
   5a. 鱼饵消耗的返回值（最后一枚不能白花）
   ========================================================= */
G_('State · 鱼饵消耗返回「实际生效的饵」');
St.reset();
const freeB = St.bait('worm');
ok(St.consumeBait() === freeB, '蚯蚓是免费饵，消耗后仍返回它自己');
ok(St.get().baits.worm === -1, '免费饵的库存不会被扣（-1 = 无限）');

const paid = G.BAITS.find(b => !b.free);
St.get().baits[paid.id] = 3;
St.selectBait(paid.id);
ok(St.curBait().id === paid.id, `已选中付费饵「${paid.name}」`);
const usedB = St.consumeBait();
ok(usedB && usedB.id === paid.id, '库存还有时，返回的就是选中的付费饵');
ok(St.get().baits[paid.id] === 2, '库存正常 -1');

/* 🔴 关键回归：用掉**最后一枚**时，baitSel 会被切回蚯蚓，
   但本竿生效的必须还是那枚付费饵 —— 否则「付了它的价、没吃到它的加成」。 */
St.get().baits[paid.id] = 1;
St.selectBait(paid.id);
const lastB = St.consumeBait();
ok(lastB && lastB.id === paid.id, '🔴 用掉最后一枚时，返回的仍是那枚付费饵（而不是已切回的蚯蚓）');
ok(lastB.rareMul === paid.rareMul && lastB.speed === paid.speed, '它的 speed / rareMul 加成确实作用于本竿');
ok(St.get().baits[paid.id] === 0, '最后一枚被扣到 0');
ok(St.get().baitSel === 'worm' && St.curBait().id === 'worm', '同时自动切回蚯蚓（下一竿用免费饵）');

/* 🔴 回归：「用掉最后一枚」这一竿只能发**一次** bait 事件。
   以前 `consumeBait()` 在「切回蚯蚓」分支里发了一次、函数末尾又发一次
   → 同一竿底栏同步两遍（不报错，只是白跑）。 */
let baitEvtN = 0, countBaitEvt = false, baitToastN = 0, countBaitToast = false;
St.on('bait', function () { if (countBaitEvt) baitEvtN++; });
St.on('toast', function () { if (countBaitToast) baitToastN++; });
St.get().baits[paid.id] = 1;
St.selectBait(paid.id);
countBaitEvt = true; countBaitToast = true;
St.consumeBait();
countBaitEvt = false; countBaitToast = false;
ok(baitEvtN === 1, '🔴 用掉最后一枚时只发一次 bait 事件', `实际 ${baitEvtN} 次`);
ok(baitToastN === 1, '用掉最后一枚时发一次「已切回蚯蚓」提示', `实际 ${baitToastN} 次`);

/* 库存还有时同样只发一次（别在正常路径上退回两次） */
St.get().baits[paid.id] = 3;
St.selectBait(paid.id);
baitEvtN = 0; countBaitEvt = true;
St.consumeBait();
countBaitEvt = false;
ok(baitEvtN === 1, '库存正常消耗时也只发一次 bait 事件', `实际 ${baitEvtN} 次`);

/* 选了一个库存为 0 的付费饵 → 回退到蚯蚓，且返回的是蚯蚓（不能返回一个用不了的饵） */
St.get().baits[paid.id] = 0;
const fallback = St.consumeBait();
ok(fallback && fallback.id === 'worm' && St.curBait().id === 'worm', '库存为 0 时消耗返回蚯蚓（回退生效）');

/* 抛竿链路：fishing.js 必须用 consumeBait() 的返回值决定渔获
   （用桩函数把传给 Loot.generate 的 opts 截下来看，不改生产代码） */
St.reset();
St.get().baits[paid.id] = 1;
St.selectBait(paid.id);
G.Fishing.init({});
/* fishing.js 会调 G.Scene 做表现；Node 里没有渲染层，给个空壳顶上 */
const origScene = G.Scene;
G.Scene = {
  cast() {}, beginWait() {}, bite() {}, endFight() {}, beginFight() {},
  floatNudge() {}, setRodBend() {}, splash() {}, sparkle() {}, showShadow() {},
};
const origGen = L.generate;
let seenOpts = null;
L.generate = function (f, opts) { seenOpts = opts; return origGen(f, opts); };
G.Fishing.cast();
L.generate = origGen;
G.Fishing.hardReset();
G.Scene = origScene;
ok(seenOpts && seenOpts.bait && seenOpts.bait.id === paid.id,
   '🔴 抛竿用掉最后一枚付费饵时，本竿渔获仍是按这枚饵算的',
   `传给 Loot.generate 的 bait = ${seenOpts && seenOpts.bait && seenOpts.bait.id}`);

/* =========================================================
   5a-2. 提前收杆不消耗鱼饵（用户口径，v0.5.7）
   ========================================================= */
G_('Fishing · 提前收杆不消耗鱼饵');
const sceneStub = {
  cast() {}, beginWait() {}, bite() {}, endFight() {}, beginFight() {},
  floatNudge() {}, setRodBend() {}, splash() {}, sparkle() {},
  showShadow(fish, kg) { shadowSeen.push({ fish: fish, kg: kg }); },
};
let shadowSeen = [];
let toastSeen = [];
/* fishing.js 收杆时会调 G.Audio.click()；Node 里没有音频层，也给个空壳。
   ⚠️ 这个空壳**要一直留着**（不要还原成 origAudio）：
      `resolve()` 里有一句 `setTimeout(function () { G.Audio.newRecord(); }, 320)`，
      测试是同步跑完的，定时器在「测试已结束」之后才触发 ——
      还原成 Node 里的 undefined 就会炸成未捕获异常。 */
const audioStub = { click() {}, snap() {}, escape() {}, bite() {}, hint() {}, success() {}, newRecord() {}, unlock() {} };
const origAudio = G.Audio;
G.Audio = audioStub;
function newFishing() {
  toastSeen = [];
  G.Scene = sceneStub;
  G.Fishing.init({ onToast: o => toastSeen.push(o) });
  return G.Fishing;
}

/* ① 付费饵：抛竿扣 1 → 进入 waiting → 提前收杆 → 退回 1 */
St.reset();
G.Goals.init();   // resolve() 会调 G.Goals.check()，先让它就位
St.get().baits[paid.id] = 5;
St.selectBait(paid.id);
let Fh = newFishing();
Fh.cast();
ok(St.get().baits[paid.id] === 4, '抛竿照常扣 1 枚');
Fh.update(1.0);                       // flying → waiting
ok(Fh.getState() === 'waiting', `抛竿动画走完进入等待（${Fh.getState()}）`);
ok(Fh.giveUp() === true, '等待中可以提前收杆');
ok(St.get().baits[paid.id] === 5, '🔴 提前收杆后鱼饵退回来了（这一竿不消耗饵料）');
ok(Fh.getState() === 'idle', '收杆后回到 idle');
ok(toastSeen.length && /退回/.test(toastSeen[0].text), `给了「已退回」的提示（${toastSeen[0] && toastSeen[0].text}）`);

/* ② 用掉最后一枚 → consumeBait 会把选饵切回蚯蚓；收杆后要一并还原 */
St.reset();
St.get().baits[paid.id] = 1;
St.selectBait(paid.id);
Fh = newFishing();
Fh.cast();
ok(St.get().baits[paid.id] === 0 && St.get().baitSel === 'worm', '用掉最后一枚时自动切回蚯蚓');
Fh.update(1.0);
Fh.giveUp();
ok(St.get().baits[paid.id] === 1, '饵退回来了');
ok(St.get().baitSel === paid.id, '顺带把选饵也还原成那枚付费饵（不然背包里有饵、选中的还是蚯蚓）');

/* ③ 免费饵（蚯蚓）：无限，不涉及库存，也不该报错 */
St.reset();
Fh = newFishing();
Fh.cast();
Fh.update(1.0);
const wormBefore = St.get().baits.worm;
Fh.giveUp();
ok(St.get().baits.worm === wormBefore, '免费饵的库存不受影响（-1 = 无限）');
ok(toastSeen.length === 1 && /放弃/.test(toastSeen[0].text), '免费饵收杆只提示「放弃」，不编一句假退款');

/* ④ 鱼已经咬过钩就不退：错过咬口 / 钓上来之后都不能再退 */
St.reset();
St.get().baits[paid.id] = 5;
St.selectBait(paid.id);
Fh = newFishing();
Fh.cast();
Fh.update(1.0);
const pendWait = Fh.getPending().wait;
Fh.update(pendWait + 0.001);           // 进入 bite
ok(Fh.getState() === 'bite', '等待结束进入咬钩窗口');
Fh.update(99);                         // 不操作 → 错过咬口
ok(Fh.getState() === 'idle', '错过咬口后回到 idle');
ok(St.get().baits[paid.id] === 4, '错过咬口不退饵（鱼已经咬过钩了）');
ok(Fh.giveUp() === false, '不在 waiting 状态时收杆是空操作');

/* ⑤ 一次抛竿只能退一次（防止反复调用刷饵） */
St.reset();
St.get().baits[paid.id] = 3;
St.selectBait(paid.id);
Fh = newFishing();
Fh.cast();
Fh.update(1.0);
Fh.giveUp();
Fh.giveUp();
Fh.giveUp();
ok(St.get().baits[paid.id] === 3, '连调三次 giveUp 也只退回一枚');

/* ⑥ 等待期要叫水下鱼影
   `S.fishShadow` 原来全项目零调用（showShadow 只有定义 + 导出），
   于是 updateShadow() 和 drawUnderwater() 里那两段鱼影代码从来没跑过 ——
   「文档里写着、代码里没人调」是上一批死代码的同一个坑。 */
St.reset();
shadowSeen = [];
Fh = newFishing();
Fh.cast();
ok(shadowSeen.length === 0, '抛竿动画期间还没有鱼影（等浮漂落定才出现）');
Fh.update(1.0);                       // flying → waiting
ok(Fh.getState() === 'waiting', `抛竿动画走完进入等待（${Fh.getState()}）`);
ok(shadowSeen.length === 1, '进入等待时叫一次水下鱼影');
ok(!!(shadowSeen[0].fish && shadowSeen[0].fish.id), '鱼影带着这一竿的鱼种');
ok(shadowSeen[0].kg > 0, `鱼影带着这一竿的体重（影子大小按体重算，kg = ${shadowSeen[0].kg}）`);
Fh.update(0.5);
Fh.update(0.5);
ok(shadowSeen.length === 1, '等待期不重复叫鱼影（每竿只该叫一次）');
Fh.giveUp();                          // 收杆回到 idle，别把状态留给下一段
G.Scene = origScene;
G.Audio = origAudio;

/* =========================================================
   5a-3. 渔获归因：鱼饵 / 天气用「抛竿那一刻」的值
   =========================================================
   resolve() 原来写的是 `St.curBait().id` 和 `G.Weather.env()` ——
   都是「上鱼那一刻」的现值。而用掉最后一枚鱼饵时 baitSel 已被切回蚯蚓，
   于是那一竿被错记到蚯蚓名下（「用面团钓 N 条」永远差一条）；
   同理，一场传说鱼要拉扯几分钟，中途变天会把渔获记到错误的天气上。
   ========================================================= */
G_('Fishing · 渔获归因用抛竿时的鱼饵与环境');
{
  /* 让这一竿必然上岸：把 G.Fight 换成「立刻成功」的桩（fishing.js 走的是全局 G.Fight） */
  const fightStub = {
    begin() {}, end() {}, update() {}, drainEvents() { return []; },
    get() {
      return { over: true, result: 'success', tensionMax: 100, tension: 0,
               struggle: 0, warn: 0, dashing: false, elapsed: 1 };
    },
    snapshot() { return {}; },
  };
  const origFight = G.Fight;
  G.Scene = sceneStub;
  G.Audio = audioStub;

  /* ① 鱼饵：只剩最后一枚 → 抛竿时被自动切回蚯蚓 → 这一竿仍该记在付费饵名下 */
  St.reset();
  G.Goals.init();
  St.get().baits[paid.id] = 1;
  St.selectBait(paid.id);
  G.Fight = fightStub;
  G.Fishing.init({ onToast: o => toastSeen.push(o) });
  const Fz = G.Fishing;
  Fz.cast();
  ok(St.get().baits[paid.id] === 0 && St.get().baitSel === 'worm',
     '用掉最后一枚 → 选饵被自动切回蚯蚓（这就是原本记错名字的时刻）');
  Fz.update(1.0);                                   // flying → waiting
  Fz.update(Fz.getPending().wait + 0.001);          // → bite
  Fz.strike();                                      // → fight
  const bBait = { paid: St.get().stats.byBait[paid.id] || 0, worm: St.get().stats.byBait.worm || 0 };
  Fz.update(0.05);                                  // 桩判 over:'success' → resolve
  ok(Fz.getState() === 'idle', '这一竿成功上岸并回到 idle');
  ok((St.get().stats.byBait[paid.id] || 0) === bBait.paid + 1,
     `这一竿记在真正用掉的那枚鱼饵名下（${paid.name}）`);
  ok((St.get().stats.byBait.worm || 0) === bBait.worm,
     '没有被错记到蚯蚓名下（即便选饵已被自动切走）');

  /* ② 天气 / 时段：抛竿后变天，仍按抛竿那一刻记账 */
  St.reset();
  G.Goals.init();
  G.Fishing.init({ onToast: () => {} });
  const origWx = G.Weather;
  const wxAt = (wx, tm) => ({ isReady: () => true, neutral: () => ({ wx: null, tm: null, rareMul: 1, colorBoost: 1 }),
                              env: () => ({ wx: wx, tm: tm, rareMul: 1, colorBoost: 1 }) });
  G.Weather = wxAt('rain', 'night');
  G.Fishing.hardReset();
  G.Fishing.cast();                                 // 这一竿是在「雨天 / 夜里」抛的
  G.Weather = wxAt('clear', 'day');                 // 抛完之后变天
  G.Fishing.update(1.0);
  G.Fishing.update(G.Fishing.getPending().wait + 0.001);
  G.Fishing.strike();
  G.Fishing.update(0.05);
  ok((St.get().stats.byWx.rain || 0) === 1 && !St.get().stats.byWx.clear,
     '抛竿后变天，渔获仍记在「抛竿时的天气」上');
  ok((St.get().stats.byTm.night || 0) === 1 && !St.get().stats.byTm.day,
     '时段同理记抛竿时的');
  G.Weather = origWx;

  G.Fight = origFight;
  G.Scene = origScene;
  G.Audio = audioStub;   // 见 audioStub 的注释：不能还原成 undefined
}

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

/* 卖鱼进账必须和 addCoin 共用同一套兜底。
   漏洞入口：netPrice → Loot.price → `Math.max(1, Math.round(NaN))` 仍然是 NaN
   （Math.max 只要有一个 NaN 就返回 NaN），所以脏鱼护（kg 是 NaN）
   能算出一个 NaN 价，而 `S.coin += NaN` 会把金币**永久**污染成 NaN
   （存档再写出去就是 null）。 */
St.reset();
St.get().coin = 100;
St.get().net.push({ f: nf.id, kg: NaN, c: 'normal' });
ok(!isFinite(St.netPrice(St.get().net[0])), 'NaN 体重确实能算出一个非有限价（这就是漏洞入口）');
const sellBad = St.sellNetAt(0);
ok(sellBad === 0 && St.get().coin === 100,
   `脏条目的卖出不污染金币（入账 ${sellBad}，金币仍是 ${St.get().coin}）`);
St.get().coin = NaN;
St.get().stats.totalValue = NaN;
St.toNet(nf, 0.4, 'normal');
const sellFix = St.sellNetAt(0);
ok(isFinite(St.get().coin) && St.get().coin === sellFix, '金币本身已是 NaN 时，卖一条鱼能把它救回来');
ok(isFinite(St.get().stats.totalValue) && St.get().stats.totalValue === sellFix,
   '累计卖鱼收入（totalValue）同样带兜底，不会变成 NaN');
St.get().coin = 50;
St.get().tank.push({ f: nf.id, kg: NaN, c: 'normal' });
ok(St.sellTankAt(0) === 0 && St.get().coin === 50, '水族箱卖出走同一条路径，同样不污染金币');
St.get().coin = 80;
St.get().net.push({ f: nf.id, kg: NaN, c: 'normal' });
ok(St.sellAllNet() === 0 && St.get().coin === 80, '全部卖出（含脏条目）同样不污染金币');

/* =========================================================
   5b-2. 卖鱼入账只有一个出口
   =========================================================
   金币与「累计卖鱼收入」(stats.totalValue) 必须一起涨。挂机自动卖出
   （fishing.js）与结算卡「卖出」（main.js）原来各自 `addCoin(p)`
   之后再手写一行 `stats.totalValue += p`：漏写一处，成就「累计卖鱼收入」
   的口径就悄悄偏了，而且那一行没有 NaN 兜底。
   ========================================================= */
G_('State · 卖鱼入账的统一出口');
St.reset();
St.get().coin = 0; St.get().stats.totalValue = 0;
const fishGot = St.sellFish(1234);
ok(fishGot === 1234 && St.get().coin === 1234 && St.get().stats.totalValue === 1234,
   'sellFish 同时写入金币与累计卖鱼收入');
ok(St.sellFish(NaN) === 0 && St.get().coin === 1234 && St.get().stats.totalValue === 1234,
   'sellFish(NaN) 两个字段都不会被污染');
let coinEvents = 0;
St.on('coin', () => coinEvents++);
St.sellFish(10);
ok(coinEvents === 1, 'sellFish 发一次 coin 事件（HUD 的金币数字要跟着刷新）');

/* 整竿跑一遍：挂机自动卖出走的也是这条出口 */
(function () {
  const prevFight = G.Fight;
  const idleFightStub = {
    begin() {}, end() {}, update() {}, drainEvents() { return []; },
    get() {
      return { over: true, result: 'success', tensionMax: 100, tension: 0,
               struggle: 0, warn: 0, dashing: false, elapsed: 1 };
    },
    snapshot() { return {}; },
  };
  St.reset();
  St.get().settings.idle = true;
  G.Goals.init();
  G.Scene = sceneStub; G.Audio = audioStub; G.Fight = idleFightStub;
  G.Fishing.init({ onToast: () => {} });
  const c0 = St.get().coin, v0 = St.get().stats.totalValue;
  G.Fishing.cast();
  G.Fishing.update(1.0);
  G.Fishing.update(G.Fishing.getPending().wait + 0.001);
  G.Fishing.strike();
  G.Fishing.update(0.05);
  const dc = St.get().coin - c0, dv = St.get().stats.totalValue - v0;
  ok(G.Fishing.getState() === 'idle' && dc > 0, `挂机自动卖出入账 ${dc} 金`);
  ok(dc === dv, '金币增量与「累计卖鱼收入」增量逐位一致（成交口径只有一个出口）',
     `coin +${dc} / totalValue +${dv}`);
  G.Fight = prevFight;
})();

/* 离线补算同理 */
St.reset();
G.Goals.init();
Fish.init({});
const ocIncome = Fish.offlineCatchUp(3600, 30);
ok(ocIncome.coin > 0 && St.get().stats.totalValue === ocIncome.coin,
   '离线补算的收入同样同时写进金币与「累计卖鱼收入」',
   `coin ${ocIncome.coin} / totalValue ${St.get().stats.totalValue}`);

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
/* 「像不像本游戏的存档」不能只看 coin/playTime —— 导入是整档覆盖，
   一段 {coin:1} 的无关 JSON 被收下就等于把玩家的档清空 */
ok(St.importSave('{"coin":1,"playTime":0}').ok === false, '只有 coin/playTime 的对象仍被拒绝（必须含本游戏特有字段）');
ok(St.importSave('{"name":"x","coin":99}').ok === false, '别的应用里带 coin 字段的 JSON 被拒绝');
ok(St.importSave('{"book":{},"unlocked":{"D":true}}').ok === false, '只有本游戏字段但没有 coin/playTime 的也拒绝（多半是残缺数据）');
const good = JSON.stringify({
  v: 1, coin: 12345, playTime: 3600, field: 'D', unlocked: { D: true },
  book: { [nf.id]: { n: 3, maxKg: 0.5, colors: { normal: 3 }, first: 1 } },
  baits: { worm: -1 }, rods: ['bamboo'], lines: ['n2'], decors: [],
});
const imp = St.importSave(good);
ok(imp.ok === true, '导入合法存档成功');
ok(St.get().coin === 12345, '导入后金币 = 12345（v1 老存档被正确迁移）');
ok(St.get().v === St.SAVE_V, `老存档版本号被升到 ${St.SAVE_V}（当前 SAVE_V，不写死）`);
ok(Array.isArray(St.get().net) && Array.isArray(St.get().tank), 'v1 → v2 迁移补齐了鱼护字段');
ok(St.bookEntry(nf.id).n === 3, '导入后图鉴数据保留');

/* `locked` 是零消费的历史遗留字段（每档都写、全项目没人读）——
   现在新档不再写它，老档里残留的那份也在迁移时删掉 */
ok(St.get().locked === undefined, '新档 / 迁移结果里不再有 locked 字段');
const legacyLocked = JSON.parse(good);
legacyLocked.locked = ['X'];
ok(St.importSave(JSON.stringify(legacyLocked)).ok === true && St.get().locked === undefined,
   '带 locked 的老存档导入后该字段被清掉');

/* 脏数据：鱼护里塞了不存在的鱼种 */
const dirty = JSON.parse(good);
dirty.net = [{ f: 'NOT_A_FISH', kg: 1, c: 'normal' }, { f: nf.id, kg: 1, c: 'normal' }];
ok(St.importSave(JSON.stringify(dirty)).ok === true && St.netCount() === 1, '导入时会剔掉失效的鱼种条目');

/* 脏数据：图鉴条目缺 colors / 不是对象 —— 这条路径每钓一条鱼都会走，绝不能炸
   （实测过：导入 { book: { D01: { n: 1 } } } 之后钓到 D01，
    recordCatch 会在 e.colors[colorKey] 上抛 TypeError，整条上鱼流程断掉） */
const nf2 = G.FISH_BY_FIELD.C[0];      // 换一个钓场的鱼，别和上面用过的 nf 撞 id
const dirtyBook = JSON.parse(good);
dirtyBook.book = { [nf.id]: { n: 2 }, GHOST_ID: { n: 1 }, [nf2.id]: 'not-an-object' };
ok(St.importSave(JSON.stringify(dirtyBook)).ok === true, '导入「图鉴条目缺字段」的存档仍然成功（会被就地修好）');
ok(St.bookEntry(nf.id) && typeof St.bookEntry(nf.id).colors === 'object' && !Array.isArray(St.bookEntry(nf.id).colors),
   '缺 colors 的条目在导入时补成对象');
ok(St.get().book.GHOST_ID === undefined, '图鉴里不认识的鱼种 id 会被剔掉');
ok(St.get().book[nf2.id] === undefined, '图鉴条目不是对象时直接丢掉（当没收集过）');
let dirtyThrew = false, dirtyRes = null;
try { dirtyRes = St.recordCatch(nf2, 2.5, 'normal'); } catch (e) { dirtyThrew = true; }
ok(!dirtyThrew && !!dirtyRes && St.bookEntry(nf2.id).n === 1,
   '条目被剔掉之后照样能重新记录渔获（不会因为脏档而断掉上鱼流程）');
/* 直接对内存里的脏条目动手（绕开迁移，模拟运行期被改坏） */
St.get().book[nf.id] = { n: 5 };
ok(St.recordCatch(nf, 1, 'rare') !== null && St.bookEntry(nf.id).colors.rare === 1,
   'recordCatch 自己也会补齐缺 colors 的条目（迁移不是唯一防线）');
ok(St.bookEntry(nf.id).n === 6, '补条目时不会丢掉已有的渔获计数');
St.get().book[nf2.id] = 42;
ok(St.recordCatch(nf2, 1, 'normal') !== null && St.bookEntry(nf2.id).n === 1,
   '条目是数字这类非法类型时当成「没收集过」，重建一条');

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
// ⚠️ 容差要留 **±1 金**，不能卡死在 floor/ceil：
//    每次结算都要取整，3 小时正好落在整数边界（如 3.00）时，
//    逐次取整的累积会少 1 金 —— 这不是 bug，是「零头累积」机制的边界表现。
//    （原先写的是 `>= Math.floor(expect3h)`，数值一改到边界就误报。）
ok(cheapGot >= Math.floor(expect3h) - 1 && cheapGot <= Math.ceil(expect3h) + 1,
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

G_('Goals · 徽标计数（不生成文案 + 语义不变）');
{
  /* 语义：换实现不许改结果 */
  const byFull = G.Goals.quests().filter(q => q.done && !q.claimed).length
               + G.Goals.weekly().filter(q => q.done && !q.claimed).length;
  ok(G.Goals.medalClaimable() === byFull,
     `medalClaimable() 与逐条统计一致（${byFull} 条）`);

  /* 开销：徽标每 0.4 秒被 syncStats() 问一次数，不许生成展示文案 */
  const badgeTpls = G.QUEST_TPL.concat(G.WEEKLY_TPL || []);
  const badgeOrig = badgeTpls.map(t => t.text);
  let badgeTextCalls = 0;
  badgeTpls.forEach(t => { t.text = function () { badgeTextCalls++; return ''; }; });
  G.Goals.quests();
  const questTextCalls = badgeTextCalls;
  badgeTextCalls = 0;
  G.Goals.medalClaimable();
  const badgeOnly = badgeTextCalls;
  badgeTpls.forEach((t, i) => { t.text = badgeOrig[i]; });
  ok(questTextCalls > 0, `quests() 会生成展示文案（对照：${questTextCalls} 次）`);
  ok(badgeOnly === 0, 'medalClaimable() 生成 0 段文案（徽标只做数值比较）');
}

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
ok(sv.v === St.SAVE_V, `老存档版本号被升到 ${St.SAVE_V}（不写死数字）`);
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
   7b. Goals · 周常挑战（v0.5.6 的中周期目标）
   ========================================================= */
G_('Goals · 周常挑战生成');
St.reset();
G.Goals.init();
const wk1 = G.Goals.week();
ok(/^\d{4}-W\d{2}$/.test(wk1), `周键是 ISO 周格式（${wk1}）`);
const wq1 = G.Goals.weekly();
ok(wq1.length === G.WEEKLY_PER_WEEK, `每周生成 ${G.WEEKLY_PER_WEEK} 条周常挑战`);
ok(wq1.every(q => q.need > 0 && isFinite(q.cur) && q.pct >= 0 && q.pct <= 1), '周常的目标与进度都是有限数，进度在 0~1');
ok(wq1.every(q => q.text && q.text.length > 3), '每条周常都有可读文案');
ok(new Set(wq1.map(q => q.t.id)).size === wq1.length, '同一周的挑战类型不重复');
const wSnap = JSON.stringify(G.Goals.weekBoard().q);
G.Goals.ensureWeek(true);
ok(JSON.stringify(G.Goals.weekBoard().q) === wSnap, '同一周重复 ensureWeek 不会重掷挑战');
ok(G.Goals.weekBoard().week === wk1, '周常 board 上记着归属的周键');
ok(typeof G.Goals.weekBoard().base[wq1[0].t.metric] === 'number',
   `周常基准值已记录（${wq1[0].t.metric} = ${G.Goals.weekBoard().base[wq1[0].t.metric]}）`);
/* 基准高于当前累计时必须 clamp 到 0（否则会显示负数进度） */
G.Goals.weekBoard().base[wq1[0].t.metric] += 5;
ok(G.Goals.weekly()[0].cur === 0, '周常进度不会算成负数（clamp 到 0）');

/* 周常和每日是两条独立的时间轴：改日期不该动到本周挑战 */
const beforeWeek = JSON.stringify(G.Goals.weekBoard().q);
St.get().daily.day = '1999-01-01';
G.Goals.ensureDay(true);
ok(JSON.stringify(G.Goals.weekBoard().q) === beforeWeek, '跨天重掷每日任务不会连带重掷周常挑战');
/* 反过来：把周键改旧 → 才重掷 */
St.get().weekly.week = '1999-W01';
G.Goals.ensureWeek(true);
ok(St.get().weekly.week === wk1, '跨周后旧挑战被重掷');

G_('Goals · 周常领取与奖励');
St.reset();
G.Goals.init();
const wb = St.get().weekly;
wb.q[0] = { tpl: 'wcatch', need: 3, key: '', seen: false };
wb.base = { catch: St.get().stats.catches };
wb.claimed = wb.q.map(() => false);
ok(G.Goals.weekly()[0].cur === 0, '重写挑战后进度从 0 开始');
St.get().stats.catches += 3;
ok(G.Goals.weekly()[0].done === true, '统计推进 3 条 → 周常达成');
const wMedals0 = G.Goals.medals();
const wc = G.Goals.claimWeekly(0);
const wantW = (CFG.goals && CFG.goals.weeklyMedals) || 1;
ok(wc.ok === true && G.Goals.medals() === wMedals0 + wantW,
   `领取周常 +${wantW} 纪念币（${wMedals0} → ${G.Goals.medals()}，数值来自 config.goals.weeklyMedals）`);
ok(G.Goals.claimWeekly(0).ok === false, '同一条周常不能重复领取');
ok(G.Goals.claimWeekly(99).ok === false, '周常越界下标不会崩');

/* 徽标数要同时算上每日与周常，否则挂机时周常的奖励永远不提醒 */
St.reset();
G.Goals.init();
ok(G.Goals.medalClaimable() === 0, '全新存档没有可领取的奖励');
St.get().daily.q.forEach((q, i) => { St.get().daily.claimed[i] = false; });
St.get().daily.q[0] = { tpl: 'catch', need: 0, key: '', seen: true };
const dailyReady = G.Goals.quests().filter(q => q.done && !q.claimed).length;
St.get().weekly.q[0] = { tpl: 'wcatch', need: 0, key: '', seen: true };
const weekReady = G.Goals.weekly().filter(q => q.done && !q.claimed).length;
ok(G.Goals.medalClaimable() === dailyReady + weekReady,
   `徽标数 = 每日 ${dailyReady} + 周常 ${weekReady}（两边都算进去）`);

G_('Goals · 周常：maxKg 与成就的联动');
St.reset();
G.Goals.init();
St.get().daily.q[0] = { tpl: 'big', need: 99, key: '', seen: false };
St.get().weekly.q[0] = { tpl: 'wbig', need: 99, key: '', seen: false };
St.get().daily.base = { maxKg: 0 };
St.get().weekly.base = { maxKg: 0 };
St.get().daily.meta.maxKg = 0;
St.get().weekly.meta.maxKg = 0;
G.Goals.check({ kg: 4.2, rar: 1, fish: G.FISH[0] });
ok(St.get().daily.meta.maxKg === 4.2, '每日 board 的当日最大重量被更新');
ok(St.get().weekly.meta.maxKg === 4.2, '周常 board 的最大重量也被更新（只喂一边会让周常那条永远不动）');
ok(G.Goals.weekly()[0].cur === 4.2, '周常「钓到 N kg 以上」的进度跟着走');
G.Goals.check({ kg: 1.1, rar: 0, fish: G.FISH[0] });
ok(St.get().weekly.meta.maxKg === 4.2, '更小的鱼不会把最大重量顶回去');

G_('Goals · 周常模板数据完整性');
const wIds = new Set(); let wDup = 0;
G.WEEKLY_TPL.forEach(t => { if (wIds.has(t.id)) wDup++; wIds.add(t.id); });
ok(wDup === 0, `周常模板 id 无重复（${G.WEEKLY_TPL.length} 条）`);
ok(G.WEEKLY_TPL.every(t => G.Goals.metrics[t.metric] && typeof t.text === 'function' && (t.pool || t.poolFn)),
   '每个周常模板字段完整（metric / text / pool）');
ok(G.WEEKLY_TPL.every(t => !t.pool || t.pool.every(n => n > 0)), '周常目标值都是正数');
ok(G.WEEKLY_TPL.every(t => typeof t.text(t.pool ? t.pool[0] : 1, '', St.get()) === 'string'),
   '周常文案函数都能正常产出字符串');
ok(G.WEEKLY_PER_WEEK >= 1 && G.WEEKLY_PER_WEEK <= G.WEEKLY_TPL.length, '每周条数不超过模板总数');
/* base 是按 metric 记的 —— 同表两条共用一个 metric 会互相覆盖基准，进度永远算不对 */
const wMetrics = G.WEEKLY_TPL.map(t => t.metric);
ok(new Set(wMetrics).size === wMetrics.length, '周常模板的 metric 互不重复（进度基准按 metric 记）');
const dMetrics = G.QUEST_TPL.map(t => t.metric);
ok(new Set(dMetrics).size === dMetrics.length, '每日模板的 metric 也互不重复');
/* tplById 要能同时找到两张表里的模板，否则周常在面板上会显示成「已下架的任务」 */
const allTplIds = G.QUEST_TPL.map(t => t.id).concat(G.WEEKLY_TPL.map(t => t.id));
ok(new Set(allTplIds).size === allTplIds.length, '每日与周常的模板 id 不冲突（tplById 同时在两张表里找）');
ok(G.Goals.weekly().every(q => q.text.indexOf('已下架') < 0), '周常条目都能解析到模板文案');

G_('Goals · ISO 周键（周数算法很容易写错，定点验）');
const wkOf = (y, m, d) => G.Goals.weekOf(new Date(y, m - 1, d));
ok(wkOf(2026, 10, 7) === '2026-W41', `2026-10-07 属于 2026-W41（实得 ${wkOf(2026, 10, 7)}）`);
/* 2026-01-01 是周四 → ISO 第 1 周是 2025-12-29（周一）~ 2026-01-04（周日） */
ok(wkOf(2025, 12, 29) === '2026-W01', `跨年：2025-12-29 属于 2026-W01（实得 ${wkOf(2025, 12, 29)}）`);
ok(wkOf(2026, 1, 1) === '2026-W01', `2026-01-01 与本年第 1 周同属（实得 ${wkOf(2026, 1, 1)}）`);
ok(wkOf(2025, 12, 28) === '2025-W52', `2025-12-28 仍属 2025-W52（实得 ${wkOf(2025, 12, 28)}）`);
ok(wkOf(2026, 1, 5) === '2026-W02', `2026-01-05 进入第 2 周（实得 ${wkOf(2026, 1, 5)}）`);
/* 同一周的周一到周日必须给出同一个键（否则一周里会重掷好几次） */
const wk7 = [];
for (let i = 0; i < 7; i++) wk7.push(G.Goals.weekOf(new Date(2026, 9, 5 + i)));   // 2026-10-05（周一）起 7 天
ok(new Set(wk7).size === 1 && wk7[0] === '2026-W41', '同一周的 7 天给出同一个周键');
ok(G.Goals.weekOf(new Date(2026, 9, 12)) !== wk7[0], '下一周（周一）给出新的周键');

G_('Goals · 周常存档字段（SAVE_V 5）');
St.reset();
ok(St.get().weekly === null, '全新存档的 weekly 是 null，由 Goals.init() 现生成');
ok(St.SAVE_V === 5, `SAVE_V = ${St.SAVE_V}（v5 新增周常挑战）`);
St.get().weekly = 'garbage';
const legacyW = JSON.parse(JSON.stringify(St.get()));
legacyW.v = 4; legacyW.weekly = 'garbage';
store[CFG.saveKey] = JSON.stringify(legacyW);
St.load();
ok(St.get().weekly === null, 'v4 老存档里的脏 weekly 被清成 null');
ok(St.get().v === St.SAVE_V, '迁移后写回当前 SAVE_V');
G.Goals.init();
ok(Array.isArray(St.get().weekly.q) && St.get().weekly.q.length === G.WEEKLY_PER_WEEK,
   '老存档接入后能正常拿到当周挑战');

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
ok(St.get().v === St.SAVE_V, `老存档版本号被升到 ${St.SAVE_V}（当前 SAVE_V，不写死）`);
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

/* =========================================================
   Fishing —— 离线补算
   ========================================================= */
G_('Fishing · 离线补算');
St.reset();
Fish.init({});
ok(Fish.offlineCatchUp(30, 30) === null, '离线不足 60 秒不补算');
const oc = Fish.offlineCatchUp(3600, 30);
ok(!!oc, '一小时离线能补算出结果');
ok(oc.count === Math.floor(3600 / 30), '竿数 = 离线秒数 ÷ 单竿耗时', '实际 ' + (oc && oc.count));
ok(oc.coin > 0, '补算收入为正', '实际 ' + (oc && oc.coin));
ok(oc.kinds >= 0 && oc.rare >= 0 && oc.rare <= oc.count, '史诗/传说条数与新增图鉴数都在合理范围');
ok(Array.isArray(oc.recent) && oc.recent.length >= 1 && oc.recent.length <= 5,
   '带回 1~5 条代表渔获（主循环要它们进播报栏）', '实际 ' + (oc.recent && oc.recent.length));
ok(oc.recent.every(x => x.fish && x.fish.name && x.color && x.color.name &&
   x.kg > 0 && x.price > 0 && x.rar >= 0 && x.rar <= 3 && typeof x.isNew === 'boolean'),
   '代表渔获的字段与真实渔获同构（Hud.pushCatch 能直接吃）');
const ocCap = Fish.offlineCatchUp(999999, 30);
ok(ocCap.seconds === CFG.idle.maxCatchUp, '离线补算按 idle.maxCatchUp 封顶', '实际 ' + (ocCap && ocCap.seconds));
ok(ocCap.recent.length <= 5, '离线再久，代表渔获也不超过 5 条（播报栏不会刷屏）');

G_('Fishing · 离线补算的分维计数');
St.reset();
const baitId = St.curBait().id;
const byBait0 = St.get().stats.byBait[baitId] || 0;
const oc2 = Fish.offlineCatchUp(1800, 30);
const byBait1 = St.get().stats.byBait[baitId] || 0;
ok(byBait1 > byBait0, '离线补算也计进「按鱼饵」分维（每日任务「用某鱼饵钓 N 条」不再停摆）',
   `${byBait0} → ${byBait1}`);
ok(byBait1 - byBait0 <= oc2.count && byBait1 - byBait0 >= 1, 'byBait 增量不超过总竿数且至少 1');
ok(Object.keys(St.get().stats.byWx).length === 0 && Object.keys(St.get().stats.byTm).length === 0,
   '离线补算不写天气 / 时段分维（离线跨很多次变天，硬记一个反而失真）');

/* =========================================================
   Track —— 错误采集（E4 空壳）
   ========================================================= */
G_('Track · 错误采集（空壳）');
(() => {
  const Tk = G.Track;
  const realErr = console.error;
  console.error = function () {};    // error() 会往控制台补一条，测的时候别刷屏
  try {
    Tk.clear();
    ok(Tk.count() === 0, 'clear() 后缓冲为空');
    ok(Tk.enabled() === true, '默认开启（CFG.track.enabled）');

    const e1 = Tk.error('测试', new Error('boom'), { a: 1 });
    ok(e1 && e1.level === 'error' && e1.msg === 'boom', 'error() 记下消息文本');
    ok(!!e1.stack && e1.stack.indexOf('boom') >= 0, '异常连栈一起记下（不然拿不到崩溃点）');
    ok(e1.extra && e1.extra.a === 1, 'extra 被安全序列化');
    ok(e1.ctx && e1.ctx.phase && e1.ctx.ver === CFG.version,
       'ctx 记下「卡在哪一步」：版本 + 钓鱼阶段 + 钓场', JSON.stringify(e1.ctx));

    Tk.error('测试', new Error('boom'));
    ok(Tk.count() === 1, '连续重复的同名同文只累加次数，不新占一条（渲染循环报错是每帧一次）');
    ok(Tk.list()[0].n === 2, '连击次数累加正确');

    for (let i = 0; i < CFG.track.buffer + 10; i++) Tk.warn('w' + i, 'msg' + i);
    ok(Tk.count() === CFG.track.buffer, `环形缓冲封顶在 ${CFG.track.buffer} 条`, '实际 ' + Tk.count());
    ok(Tk.list()[Tk.count() - 1].msg === 'msg' + (CFG.track.buffer + 9), '留在缓冲里的是最新那条（旧的从头部丢）');

    const cyc = { name: 'x' }; cyc.self = cyc;
    ok(Tk.error('循环引用', new Error('cyc'), { c: cyc }) !== null, 'extra 里有循环引用也不抛异常');
    ok(Tk.error('无异常对象', 'plain string') !== null, '第二个参数不是 Error 时也不崩');

    let initThrew = false;
    try { Tk.init(); } catch (e) { initThrew = true; }
    ok(!initThrew, 'init() 在没有 addEventListener 的环境里也不抛（采集点仍然可用）');

    const dumped = Tk.dump();
    ok(typeof dumped === 'string' && dumped.indexOf('v' + CFG.version) >= 0, 'dump() 能导出可粘贴的纯文本');
    ok(typeof Tk.dumpJson() === 'string' && Tk.dumpJson().indexOf('records') >= 0, 'dumpJson() 输出 JSON');

    ok(Tk.flush([]) === false, 'flush() 仍是空壳：明确返回 false，说明没接外部服务');

    /* ---- 落盘：白屏那条最值钱，刷新后必须还在 ---- */
    Tk.clear();
    Tk.error('落盘测试', new Error('persist-me'));
    const raw = localStorage.getItem(CFG.track.storageKey);
    ok(typeof raw === 'string' && raw.indexOf('persist-me') >= 0,
       'error 记录会立刻落到 CFG.track.storageKey（不等节流窗口）');
    ok(Tk.persist() === true, 'persist() 能手动写盘');
    /* 模拟刷新：重新执行一份 track.js，再 init（init 里会 load） */
    const TkOld = G.Track;
    const reload = () => {
      new Function(fs.readFileSync(path.join(ROOT, 'src/core/track.js'), 'utf8')).call(global);
      G.Track.init();
      return G.Track;
    };
    let Tk2 = reload();
    ok(Tk2.count() >= 1 && Tk2.restored() >= 1, 'init() 把上次会话的日志接回来了', 'restored=' + Tk2.restored());
    ok(Tk2.list()[0].prev === true && Tk2.list()[0].msg === 'persist-me',
       '接回来的记录带 prev 标记，dump 里能分清「这次崩的」和「上次崩的」');
    ok(Tk2.dump().indexOf('上次会话') >= 0, 'dump() 抬头标明有多少条来自上次会话');
    Tk2.clear();
    ok(localStorage.getItem(CFG.track.storageKey).indexOf('persist-me') < 0,
       'clear() 会把磁盘一起清掉（否则刷新一次旧日志又冒出来）');
    ok(reload().count() === 0, '清空后刷新，缓冲是空的');
    /* 脏数据 / 存储不可用都不许把游戏带崩 */
    localStorage.setItem(CFG.track.storageKey, '{{{ 不是 JSON');
    ok(reload().count() === 0, '磁盘上是坏 JSON 时按「没有日志」处理，不抛异常');
    localStorage.setItem(CFG.track.storageKey, JSON.stringify({
      records: [null, 42, 'x', { level: 'weird', msg: 123, i: 'NaN' }],
    }));
    Tk2 = reload();
    ok(Tk2.count() === 1 && Tk2.list()[0].level === 'event' && Tk2.list()[0].msg === '123',
       '磁盘上的脏记录被逐字段纠正（非法 level 归 event、数字 msg 转字符串）');
    localStorage.removeItem(CFG.track.storageKey);
    G.Track = TkOld;                                  // 换回原来的实例，别影响后面的用例
    G.Track.clear();

    const saved = CFG.track.enabled;
    const beforeDisabled = localStorage.getItem(CFG.track.storageKey);
    CFG.track.enabled = false; Tk.clear();
    Tk.error('x', new Error('y'));
    ok(Tk.count() === 0, 'CFG.track.enabled=false 时采集是 no-op（不占内存）');
    ok(localStorage.getItem(CFG.track.storageKey) === beforeDisabled,
       'CFG.track.enabled=false 时也不写盘');
    CFG.track.enabled = saved;
  } finally {
    console.error = realErr;
    G.Track.clear();
  }
})();

/* =========================================================
   State · 容器字段的类型纠正（脏档不能让存档「静默半失效」）
   `migrate()` 一路把 stats / settings / baits / rods… 当对象或数组用，
   却从没确认过类型。脏档（手改过的导入 JSON / 老版本写坏的字段）会让它们
   变成数字或字符串，而且后果大多看不见：
     · `stats: 5`    → byRar 是 undefined，`.map` 抛异常（走 load() 就是白屏）
     · `settings: 5` → 迁移看着成功，但 setIdle() 在数字上赋值静默无效
                       → 挂机开关永远打不开
     · `baits: 5`    → 买鱼饵扣了金币却加不进库存
     · `rods: 5`     → S.rods.indexOf 不是函数，换竿直接 TypeError
   这一节用「真跑一遍 load() + 真调一次对应 API」来验，
   而不是只看字段类型 —— 类型对了但行为还是坏的才最坑。
   ⚠️ 放在最后几节之一：它会反复 St.load()，别影响前面依赖存档内容的断言。
   ========================================================= */
G_('State · 容器字段的类型纠正（脏档兜底）');
const goodSave = JSON.parse(JSON.stringify(St.get()));
function loadWith(mut) {
  const d = JSON.parse(JSON.stringify(goodSave));
  mut(d);
  store[CFG.saveKey] = JSON.stringify(d);
  const before = St.get();
  St.load();
  return { before, after: St.get() };
}
function loadThrew(mut) {
  try { loadWith(mut); return null; } catch (e) { return e; }
}

/* ① stats 是标量：原来直接抛在这 */
ok(!loadThrew(d => { d.stats = 5; }), 'stats 是数字时 load() 不抛异常（原来 .map 直接炸）',
   (loadThrew(d => { d.stats = 5; }) || {}).message);
ok(!loadThrew(d => { d.stats = 'oops'; }), 'stats 是字符串时 load() 不抛异常');
{
  const r = loadWith(d => { d.stats = 5; });
  ok(r.after.stats && typeof r.after.stats === 'object' && !Array.isArray(r.after.stats),
     'stats 被纠正成对象');
  ok(Array.isArray(r.after.stats.byRar) && r.after.stats.byRar.length === 4, '统计字段补全（byRar 4 档）');
}

/* ② settings 是标量：类型对不对，要看「挂机开关还能不能打开」 */
{
  const r = loadWith(d => { d.settings = 5; });
  ok(r.after.settings && typeof r.after.settings === 'object', 'settings 被纠正成对象');
}
St.setIdle(true);
ok(St.get().settings.idle === true, '脏 settings 档里 setIdle(true) 真的写进去了（原来静默无效）');
ok(St.get().settings.sound === true && isFinite(St.get().settings.volume),
   '音效 / 音量也有默认值（否则 G.Audio 会收到 undefined）');
St.setIdle(false);

/* ③ baits 是标量：买鱼饵必须真的到账 */
{
  const paidBaitId = G.BAITS.filter(b => !b.free)[0].id;
  const r = loadWith(d => { d.baits = 5; d.coin = 999999; });
  ok(r.after.baits && typeof r.after.baits === 'object', 'baits 被纠正成对象');
  ok(St.baitCount(paidBaitId) === 0, '免费 / 收费鱼饵的初始数量都补上了（收费为 0）');
  const got = St.buyBait(paidBaitId, 1);
  const want = G.BAITS.filter(b => b.id === paidBaitId)[0].pack;
  ok(got.ok && St.baitCount(paidBaitId) === want,
     `脏 baits 档里买鱼饵真的到账了（${want} 枚，原来扣了金币却加不进库存）`);
}

/* ④ rods / lines / decors 是标量或含垃圾 id */
ok(!loadThrew(d => { d.rods = 5; d.lines = 5; d.decors = { a: 1 }; }), '拥有列表是标量时 load() 不抛异常');
{
  const r = loadWith(d => { d.rods = 5; d.lines = ['n2', 123]; d.decors = ['tent', 42, null]; });
  ok(Array.isArray(r.after.rods) && Array.isArray(r.after.lines) && Array.isArray(r.after.decors),
     'rods / lines / decors 都被纠正成数组');
  ok(r.after.rods.indexOf(G.RODS[0].id) >= 0, '起手鱼竿被补回来了（否则换竿永远失败）');
  ok(r.after.lines.indexOf(G.LINES[0].id) >= 0, '起手鱼线被补回来了');
  ok(r.after.decors.indexOf(42) < 0 && r.after.decors.indexOf(null) < 0,
     '拥有列表里的垃圾 id 被清掉了（否则选竿面板会把所有竿都显示成已拥有）');
  ok(r.after.decors.indexOf('tent') >= 0, '合法的装饰 id 保留');
}

/* ⑤ 修完之后整档仍然可用 */
{
  loadWith(d => { d.stats = 'x'; d.settings = 7; d.baits = 'y'; d.rods = null; });
  const s = St.get();
  ok(s.stats.casts === goodSave.stats.casts, '迁移不会把既有统计清零');
  ok(s.coin === goodSave.coin, '迁移不会把金币清零');
  G.Goals.init();
  ok(G.Goals.quests().length === G.QUEST_PER_DAY, '脏容器档也能正常生成每日任务');
}

/* =========================================================
   State · 读档失败不再白屏（主存档 → 备份 → 新档）
   load() 原来直接把 migrate() 的结果赋给 S：JSON 半截、或迁移抛异常时，
   异常会一路冒到 boot() → **白屏**（存档其实还在 localStorage 里，
   页面却打不开，玩家既看不到原因也没有自救入口）。
   现在：每个存档源都单独 try，坏了退下一级；全废才开新档，
   并且把原始文本挪到 rescue 键（否则下一个自动存档就把证据盖掉了），
   再通过 St.loadNote() 让 main.js 播一条 toast。
   ⚠️ 会反复覆盖 store[CFG.saveKey]，放在最后几节之一。
   ========================================================= */
G_('State · 读档失败不再白屏（退备份 → 再退新档）');
const realErrLoad = console.error;
console.error = () => {};        // G.Track.error 会打 console，这里不希望刷屏
const pristine = JSON.parse(JSON.stringify(St.get()));

/* ① 主存档是半截 JSON（写到一半断电 / 手改坏了），备份是好的 → 用备份 */
store[CFG.saveKey] = '{"v":5,"coin":99,';
const bakGood = JSON.parse(JSON.stringify(pristine)); bakGood.coin = 4321;
store[CFG.saveKeyBak] = JSON.stringify(bakGood);
let loadErr1 = null;
try { St.load(); } catch (e) { loadErr1 = e; }
ok(!loadErr1, '主存档是半截 JSON 时 load() 不抛异常（原来会冒到 boot 变白屏）', loadErr1 && loadErr1.message);
ok(St.get().coin === 4321, '退到备份档，进度真的恢复了');
ok(/备份/.test(St.loadNote()), '并且给出「已从备份恢复」的提示语');

/* ② 主存档是合法 JSON 但不是对象 → 同样退备份 */
store[CFG.saveKey] = '"not an object"';
St.load();
ok(St.get().coin === 4321 && /备份/.test(St.loadNote()), '主存档不是对象时也退备份');

/* ③ 主 + 备份全废 → 开新档，但原始内容必须留一份 */
store[CFG.saveKey] = '{oops';
store[CFG.saveKeyBak] = 'also not json';
let loadErr3 = null;
try { St.load(); } catch (e) { loadErr3 = e; }
ok(!loadErr3, '两份存档都读不出来时 load() 也不抛异常（原来直接白屏）', loadErr3 && loadErr3.message);
ok(St.get().coin === CFG.economy.startCoin, '两份都读不出来时开新档而不是白屏');
ok(/重置/.test(St.loadNote()), '并且明确告诉玩家「已重置为新档」');
const rescueTxt = String(store[CFG.saveKeyRescue] || '');
ok(rescueTxt.indexOf('{oops') >= 0,
   '原始坏档被挪到 rescue 键留存（否则下一个自动存档就把证据盖掉了）');
ok(rescueTxt.indexOf('also not json') >= 0, '备份的原始内容也一起留存');

/* ④ 一切正常时不打扰玩家 */
store[CFG.saveKey] = JSON.stringify(pristine);
St.load();
ok(St.loadNote() === '', '正常读档时不产生任何提示语（别没事找事弹警告）');
ok(St.get().coin === pristine.coin, '正常读档走的还是主存档');
console.error = realErrLoad;

/* =========================================================
   Util —— 导出面
   G.U 里曾躺着 rnd / irange / pick / chance / normalize 五个零调用函数：
   它们长得像「基础设施」，读代码时会被当成常用工具，实际全项目没人用。
   用白名单把导出面钉住：删函数要显式改这里（所以删不干净会立刻红），
   加函数同样要显式登记（逼着加的人想清楚有没有消费方）。verify 第 ㉕ 节
   另有一条源码级断言，扫「每个导出函数都必须有消费方」。
   ========================================================= */
G_('Util · 导出面（不留零消费的死函数）');
const UTIL_KEYS = ['$', '$$', 'clamp', 'clock', 'coin', 'darken', 'dur', 'easeOut',
  'el', 'hex2rgb', 'kg', 'lerp', 'lighten', 'mix', 'num', 'on', 'range',
  'rgb2hex', 'rgba', 'skew', 'weighted'];
ok(Object.keys(U).sort().join(',') === UTIL_KEYS.join(','),
   'G.U 的导出集合与白名单完全一致（共 ' + UTIL_KEYS.length + ' 个）',
   Object.keys(U).sort().join(','));
['rnd', 'irange', 'pick', 'chance', 'normalize'].forEach(k => {
  ok(U[k] === undefined, '零调用死函数 U.' + k + ' 已从导出面移除');
});

/* =========================================================
   Platform —— 输入通道
   踩过的坑：input.up 曾写成 up(el, fn)，调用方按 up(fn) 传参 →
   真正注册的是 addEventListener('pointerup', undefined)，
   「松手」永不生效（按住能收线、松开不收线，张力必拉满断线），且不报错。
   ========================================================= */
G_('Platform · 输入通道的按下 / 松开');
(function () {
  const PI = G.Platform.input;
  const seen = [];
  const prevWin = global.addEventListener;
  const prevDoc = global.document;
  /* 假装一个 window：把监听记下来，再手动触发 */
  global.addEventListener = (type, fn) => { seen.push({ type, fn, on: 'window' }); };
  const fakeEl = {
    _l: [],
    addEventListener(type, fn) { this._l.push({ type, fn }); },
  };

  ok(PI.up.length === 1, 'input.up 的签名是 up(fn)（只有回调一个参数）', '实际参数个数 ' + PI.up.length);

  seen.length = 0;
  const hitUp = [];
  PI.up(() => hitUp.push(1));
  const upL = seen.filter(s => s.type === 'pointerup' && typeof s.fn === 'function');
  ok(upL.length === 1, 'input.up 真的把回调绑到了 window 的 pointerup 上',
     '拿到 ' + upL.length + ' 个可用监听' + (seen.length ? '（注册了 ' + seen.length + ' 个）' : ''));
  upL.forEach(s => s.fn({}));
  ok(hitUp.length === 1, '触发 window 的 pointerup 会回调到 onRelease（松手能放线）');

  fakeEl._l.length = 0;
  const hitDown = [];
  PI.down(fakeEl, () => hitDown.push(1));
  ok(fakeEl._l.some(x => x.type === 'pointerdown' && typeof x.fn === 'function'),
     'input.down(el, fn) 绑在元素上且回调可用');
  fakeEl._l.forEach(x => { if (typeof x.fn === 'function') x.fn({ preventDefault() {} }); });
  ok(hitDown.length === 1, '元素上的 pointerdown 能触发按下回调');

  fakeEl._l.length = 0;
  PI.cancel(fakeEl, () => {}); PI.leave(fakeEl, () => {});
  ok(fakeEl._l.filter(x => x.type === 'pointercancel').length === 1 &&
     fakeEl._l.filter(x => x.type === 'pointerleave').length === 1,
     'input.cancel / input.leave 都绑成了可用监听（手指划出按钮也要放线）');

  global.addEventListener = prevWin;
  void prevDoc;
})();

/* =========================================================
   Platform —— 对话框 / 剪贴板 / 环境能力
   这些在纯 Node 里都拿不到（没有 location / document / 原生 confirm），
   正好用来验「拿不到时**必须兜底**而不是抛异常」——
   设置面板的重置 / 导出 / 导入就是靠这层兜底才不会整块崩掉。
   ========================================================= */
G_('Platform · 对话框 / 剪贴板 / 环境能力的兜底');
(function () {
  const P = G.Platform;
  ok(typeof P.dialog.confirm === 'function' && typeof P.dialog.prompt === 'function',
     'dialog.confirm / dialog.prompt 都在导出面上（设置面板不再直连原生对话框）');
  ok(P.dialog.confirm('要不要清空？') === false,
     '拿不到原生 confirm 时按「取消」处理（返回 false，不抛异常）');
  ok(P.dialog.prompt('粘贴存档：') === null,
     '拿不到原生 prompt 时返回 null（导入流程安全退出）');

  ok(typeof P.clipboard.write === 'function', 'clipboard.write 在导出面上（导出存档不再直连 navigator.clipboard）');
  const pw = P.clipboard.write('{"v":5}');
  ok(pw && typeof pw.then === 'function', 'clipboard.write 返回 Promise，调用方可以按结果改提示');

  ok(typeof P.sys.reload === 'function', 'sys.reload 在导出面上');
  let reloadThrew = false;
  try { P.sys.reload(); } catch (e) { reloadThrew = true; }
  ok(!reloadThrew, 'Node 环境（没有 location）调 sys.reload 不抛异常');

  ok(P.sys.isVisible() === true,
     '拿不到 document 时 isVisible() 默认「可见」（纯逻辑环境不会把自己误判成暂停）');
  ok(typeof P.sys.onResize === 'function', 'sys.onResize 在导出面上（渲染层不再直连 window resize）');
})();

/* =========================================================
   Panels —— 面板 render 的入参兜底与「现算文案」
   panels.js 的 render 只在**运行期**碰 DOM（模块加载时不碰），所以能在 Node 里
   用最小 DOM 桩真跑一遍 —— 比「扫源码断言」可信得多：源码断言只能证明
   「某句话还在 / 某个名字被调用了」，真跑一遍才能证明「渲染出来是对的」。
   这一节守着两件事：
     ① 面板被「不带 payload 重绘」（refresh → renderCurrent()）时不许崩、
        也不许把 NaN / undefined 渲染成字面量；
     ② 界面里的门槛百分比 / 钓场数量必须与 fields.js 的现值一致。
   ========================================================= */
G_('Panels · 面板入参兜底与现算文案');
function mkEl(tag) {
  return {
    tagName: tag, className: '', innerHTML: '', textContent: '', children: [],
    style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getContext() { return null; },
  };
}
/* 面板渲染出来的文字 = 自身的 innerHTML / textContent + 全部后代的（两层足够） */
function panelText(node) {
  let out = String(node.innerHTML || '') + String(node.textContent || '');
  (node.children || []).forEach(c => { out += panelText(c); });
  return out;
}
global.document = { createElement: mkEl, querySelector: () => null, querySelectorAll: () => [] };
new Function(fs.readFileSync(path.join(ROOT, 'src/ui/panels.js'), 'utf8')).call(global);
const Panels = G.Panels;
ok(!!(Panels && Panels.VIEWS && Panels.VIEWS.offline), 'panels.js 能在 Node 里加载并导出 VIEWS');

/* ---- ① 挂机收获：没有 payload 时不能崩 ---- */
let offErr1 = null;
const offRoot1 = mkEl('div');
try { Panels.VIEWS.offline.render(offRoot1, undefined); } catch (e) { offErr1 = e; }
ok(!offErr1, 'VIEWS.offline.render(root) 不带 payload 不抛错（refresh 走的就是这条路）',
   offErr1 && offErr1.message);
ok(panelText(offRoot1).indexOf('没有挂机记录') >= 0, '不带 payload 时渲染空态提示');

/* ---- ② 半截 payload：数字兜底，不许出现字面 NaN / undefined ---- */
let offErr2 = null;
const offRoot2 = mkEl('div');
try { Panels.VIEWS.offline.render(offRoot2, { seconds: 600 }); } catch (e) { offErr2 = e; }
ok(!offErr2, 'VIEWS.offline.render 只给一半字段也不抛错', offErr2 && offErr2.message);
const offTxt2 = panelText(offRoot2);
ok(offTxt2.indexOf('10 分钟') >= 0, '离开时长按 U.dur 渲染（600 秒 → 10 分钟）');
ok(!/NaN|undefined/.test(offTxt2), '缺字段不会渲染成字面 NaN / undefined');

/* ---- ③ 完整 payload：内容与「上限 / 倍率来自 config」都要对 ---- */
const offRoot3 = mkEl('div');
let offErr3 = null;
try {
  Panels.VIEWS.offline.render(offRoot3, {
    seconds: 7200, count: 180, coin: 12345, rare: 3, kinds: 2,
    recent: [{ fish: { name: '测试鱼' }, color: { name: '黄金' }, kg: 2.5, price: 900 }],
    unlocks: [{ name: '测试钓场' }],
  });
} catch (e) { offErr3 = e; }
ok(!offErr3, 'VIEWS.offline.render 带完整 payload 不抛错', offErr3 && offErr3.message);
const offTxt3 = panelText(offRoot3);
ok(offTxt3.indexOf('2 小时') >= 0 && offTxt3.indexOf('180') >= 0 && offTxt3.indexOf('测试鱼') >= 0 &&
   offTxt3.indexOf('测试钓场') >= 0, '离开时长 / 竿数 / 代表渔获 / 解锁钓场都渲染出来');
ok(offTxt3.indexOf('上限 ' + Math.round(CFG.idle.maxCatchUp / 3600) + ' 小时') >= 0 &&
   offTxt3.indexOf('×' + CFG.idle.rareWeightMul.toFixed(2)) >= 0,
   '底部说明的离线上限与挂机倍率现算自 config（改 config 文案会跟着变）');

/* ---- ④ 钓场选择页的门槛文案必须与 fields.js 一致 ---- */
const fRoot = mkEl('div');
let fErr = null;
try { Panels.VIEWS.fields.render(fRoot); } catch (e) { fErr = e; }
ok(!fErr, 'VIEWS.fields.render 能跑通', fErr && fErr.message);
const fTxt = panelText(fRoot).replace(/<[^>]*>/g, '');
const normField = G.FIELDS.filter(f => f.requires != null && !f.requireFull)[0];
const normPct = Math.round(normField.collectionPct * 100) + '%';
const hiddenFields = G.FIELDS.filter(f => f.requireFull);
const hiddenPct = Math.round(hiddenFields[0].collectionPct * 100) + '%';
const hiddenRanks = hiddenFields.map(f => f.rank).join(' / ');
ok(fTxt.indexOf('图鉴收集达 ' + normPct) >= 0,
   `解锁门槛现算自 f.collectionPct（普通钓场 ${normPct}）`);
ok(fTxt.indexOf('收满') >= 0 && fTxt.indexOf(hiddenPct) >= 0,
   `隐藏钓场的门槛现算自 f.collectionPct（${hiddenPct}）`);
ok(fTxt.indexOf(hiddenRanks) >= 0, `隐藏钓场名单现算自 fields.js（${hiddenRanks}）`);
ok(fTxt.indexOf(G.FIELDS.length + ' 个钓场') >= 0,
   `钓场数量现算自 G.FIELDS.length（${G.FIELDS.length} 个）`);

/* ---- ⑤ 鱼护 / 水族箱：整面板能不能渲染完（含懒绘制的降级路径） ----
   这个面板此前从没在 Node 里被真跑过，而 render() 里有 requestAnimationFrame /
   canvas 取上下文这类只有浏览器才有的东西 —— 真跑一遍才知道它有没有依赖环境。
   Node 里没有 IntersectionObserver，走的就是「观察不到就直接画」的兜底分支。 */
const realCanvasCreate = G.Platform.canvas.create;
const noop = () => {};
const fakeCtx = {
  setTransform: noop, clearRect: noop, save: noop, restore: noop,
  translate: noop, scale: noop, beginPath: noop, moveTo: noop, lineTo: noop,
  closePath: noop, fill: noop, stroke: noop, ellipse: noop, fillRect: noop,
  createLinearGradient: () => ({ addColorStop: noop }),
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
};
G.Platform.canvas.create = () => ({ width: 0, height: 0, style: {}, className: '', getContext: () => fakeCtx });
const realFishArt = G.FishArt;
G.FishArt = { draw: noop };
const realRAF = global.requestAnimationFrame, realCAF = global.cancelAnimationFrame;
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = noop;

const netA = G.FISH_BY_FIELD.D[0], netB = G.FISH_BY_FIELD.C[0];
const savedNet = St.get().net, savedTank = St.get().tank;
St.get().net = [{ f: netA.id, kg: 1.2, c: 'normal' }];
St.get().tank = [{ f: netB.id, kg: 3.4, c: 'gold' }];
const netRoot = mkEl('div');
let netErr = null;
try { Panels.VIEWS.net.render(netRoot); } catch (e) { netErr = e; }
ok(!netErr, 'VIEWS.net.render 能跑通（Node 里没有 IntersectionObserver，走同步绘制兜底）',
   netErr && netErr.message);
const netTxt = panelText(netRoot);
ok(netTxt.indexOf(netA.name) >= 0 && netTxt.indexOf(netB.name) >= 0,
   '鱼护与水族箱里的鱼都渲染出了名字');

/* 还原环境，别影响后面的断言 */
St.get().net = savedNet; St.get().tank = savedTank;
G.FishArt = realFishArt;
G.Platform.canvas.create = realCanvasCreate;
if (realRAF === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = realRAF;
if (realCAF === undefined) delete global.cancelAnimationFrame; else global.cancelAnimationFrame = realCAF;

/* =========================================================
   Build —— 单文件打包（tools/build.js）
   ========================================================= */
const B = require(path.join(ROOT, 'tools/build.js'));

G_('Build · 模块拼接');
const twoMods = [{ rel: 'a.js', body: 'G.A = 1;' }, { rel: 'b.js', body: 'G.B = G.A + 1;' }];
const bun = B.assemble(twoMods);
ok(bun.indexOf('a.js') >= 0 && bun.indexOf('b.js') > bun.indexOf('a.js'), '模块按传入顺序拼进产物');
ok(bun.indexOf('G.A = 1;') >= 0 && bun.indexOf('G.B = G.A + 1;') >= 0, '模块正文原样保留，没有被改写');
ok(B.assemble(twoMods) === bun, '拼接是确定性的（同一输入 → 同一产物）');
/* 上一段末尾缺分号时，直接接下一段的 (function(){})() 会被解析成「函数调用」，静默改语义 */
ok(/\n;\n/.test(bun), '模块之间插了独立一行 `;` 作分隔（防 ASI 粘连）');
ok(/\n;\n/.test(B.assemble([{ rel: 'x.js', body: 'var s = 1\n(function(){})()' }])),
   '末尾缺分号的模块之后仍然有分隔符');

G_('Build · 产物断言会拦住危险内容');
ok(B.auditBundle(bun, {}).length === 0, '干净的内联内容不报错');
ok(B.auditBundle('var s = "</script>";', {}).length > 0, '内容里出现 </script 会被拦下（会提前闭合脚本标签）');
ok(B.auditBundle('import x from "y"', {}).length > 0, 'ES Module 的 import 会被拦下（file:// 下会被 CORS 拦）');
ok(B.auditBundle('  export default 1', {}).length > 0, '带缩进的 export 也能被拦下');
ok(B.auditBundle('G.Cheat = {};', {}).length === 0, '非 release 版允许调试面板');
ok(B.auditBundle('G.Cheat = {};', { release: true }).length > 0, 'release 版里出现 G.Cheat 会被拦下');
ok(B.auditHtml('<script src="a.js"></script>', { bytes: 10 }).length > 0, '产物里残留 <script src= 会被拦下');
ok(B.auditHtml('<link rel="stylesheet" href="x.css">', { bytes: 10 }).length > 0, '产物里残留外链样式表会被拦下');
ok(B.auditHtml('<img src="data:image/png;base64,AA"><a href="#x">y</a>', { bytes: 10 }).length === 0,
   'data: / # 这类内联引用被正确放过');
ok(B.auditHtml('<script>var a=1;</script>', { bytes: B.MAX_BYTES + 1 }).length > 0, '体积超上限会被拦下');
ok(B.collectScripts('<script src="a.js"></script>\n<script src="b.js"></script>').join() === 'a.js,b.js',
   'collectScripts 按出现顺序取路径');
ok(B.collectScripts('<script src="a.js" defer></script>').join() === 'a.js', '带其他属性的 <script src> 也能取到');
ok(B.collectStyles('<link rel="stylesheet" href="x.css">').join() === 'x.css', 'collectStyles 能取到样式表路径');

G_('Build · 真实入口干跑');
const bDev = B.build({});
const N_SCRIPTS = B.collectScripts(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')).length;
ok(bDev.errors.length === 0, '真实 index.html 干跑构建 0 错误', bDev.errors.join('；'));
ok(bDev.meta.moduleCount === N_SCRIPTS,
   `开发版内联了 index.html 里的全部 ${N_SCRIPTS} 个模块（数字来自 index.html，不写死）`);
ok(bDev.meta.version === CFG.version, `产物横幅版本号取自 config.js（${bDev.meta.version}）`);
ok(bDev.meta.bytes < B.MAX_BYTES, `产物体积 ${(bDev.meta.bytes / 1024).toFixed(1)} KB，在上限内`);
ok(bDev.html.indexOf('<script src=') < 0, '产物里没有任何 <script src=');
ok(bDev.html.indexOf('<link rel="stylesheet"') < 0, '产物里没有外链样式表');
ok(bDev.html.indexOf('G.Tutorial') >= 0, '开发版产物含 tutorial.js');
ok(bDev.html.indexOf('G.Track') >= 0, '开发版产物含 track.js（错误采集）');
ok(bDev.html.indexOf('G.Cheat') >= 0, '开发版产物含调试面板（?dev 用）');
const bRel = B.build({ release: true });
ok(bRel.errors.length === 0, 'release 干跑构建 0 错误', bRel.errors.join('；'));
ok(bRel.meta.moduleCount === N_SCRIPTS - 1,
   `release 版只少 debug 面板那 1 个（${bRel.meta.moduleCount} / ${N_SCRIPTS}）`);
ok(bRel.html.indexOf('G.Cheat') < 0, 'release 版剔除了 devtools（产物里没有 G.Cheat）');
ok(bRel.html.indexOf('G.Track') >= 0, 'release 版保留 track.js（上线要靠它拿崩溃栈）');
ok(bRel.meta.bytes < bDev.meta.bytes, 'release 版比开发版小');

/* =========================================================
   数值链 —— fix-rarity-price 的幂等性
   （放最后：它会把 Math.random 换成定种子的实现，别影响上面的随机性断言）
   ========================================================= */
G_('数值链 · fix-rarity-price 幂等');
const FP = require(path.join(ROOT, 'tools/fix-rarity-price.js'));
ok(FP.TARGET.length === 4 && FP.TARGET[0] === 1, '收益目标比值表完整（普通档为基准 ×1）');
const dr1 = FP.dryRun(), dr2 = FP.dryRun();
ok(dr1.converged && dr1.changed === 0 && dr1.residual === 0,
   'fish.js 已在归一化不动点上（重跑数值链是 0 条改动）', JSON.stringify(dr1));
ok(dr1.changed === dr2.changed && dr1.rounds === dr2.rounds && dr1.drift === dr2.drift,
   '连跑两次干跑结果逐位一致（随机源已固定，工作区不会再莫名变脏）');

/* =========================================================
   Audio —— 环境音反复开关，不许留下还在跑的节点
   audio.js 在这里才真加载（前面用的是空壳 stub）；Node 里没有 AudioContext，
   所以先用一个「只记录谁 start / 谁 stop」的最小 ctx 桩替掉 createContext。
   ========================================================= */
G_('Audio · 环境音的开启 / 停止');
(function () {
  const made = { osc: [], src: [], gain: [] };
  const mkNode = () => ({ _dis: false, connect() {}, disconnect() { this._dis = true; } });
  const fakeCtx = {
    sampleRate: 48000, currentTime: 0, state: 'running',
    destination: mkNode(),
    resume() {},
    createGain() { const g = mkNode(); g.gain = { value: 0 }; made.gain.push(g); return g; },
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() {
      const s = mkNode();
      s.start = () => { s._started = true; }; s.stop = () => { s._stopped = true; };
      made.src.push(s); return s;
    },
    createBiquadFilter() { const f = mkNode(); f.frequency = { value: 0 }; f.Q = { value: 0 }; return f; },
    createOscillator() {
      const o = mkNode();
      o.frequency = { value: 0 }; o.start = () => { o._started = true; }; o.stop = () => { o._stopped = true; };
      made.osc.push(o); return o;
    },
  };
  const realCreate = G.Platform.audio.createContext;
  G.Platform.audio.createContext = () => fakeCtx;
  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const A = G.Audio;

  A.setEnabled(true);
  A.startAmbience();
  A.startAmbience();   // 重复开只该有一套
  ok(made.src.length === 1 && made.osc.length === 1, '重复 startAmbience 不会叠出第二套环境音节点');
  ok(made.src[0]._started === true && made.osc[0]._started === true, '环境音的 buffer 源与起伏 LFO 都起来了');

  A.stopAmbience();
  ok(made.src[0]._stopped === true && made.osc[0]._stopped === true,
     'stopAmbience 连 LFO 一起停（只停 buffer 源会留下一个永远在跑的振荡器）');
  ok(made.gain.some(g => g._dis), 'stopAmbience 断开了环境音的 gain 节点（否则它一直挂在 master 上）');

  A.startAmbience();
  ok(made.src.length === 2 && made.src[1]._started === true,
     '停掉之后还能重新开启（设置里「环境音」关 → 开走的就是这条路）');
  A.stopAmbience();

  G.Platform.audio.createContext = realCreate;
  G.Audio = audioStub;   // 还原成空壳：后面还有 resolve() 的定时器会调它
})();

/* =========================================================
   模块导出面 · 清掉的零消费死接口不许悄悄回来
   第 ㉕ 节用白名单钉住了 `G.U`；本轮把同一件事扩到**全部模块**：
   verify 第 ㉜ 节从源码层扫「每个导出都要有消费方」，这里再从运行期
   把这一轮删掉的那批逐个点名（删函数要显式改这里，所以删不干净会立刻红）。
   `G.Hud` / `G.Scene` / `G.FishArt` 没在 Node 里加载，它们的死接口由 ㉜ 节管。
   ========================================================= */
G_('模块导出面 · 清掉的零消费接口不许回来');
[
  ['G.Platform', 'isWeb'],            // 同一个事实顶层与 sys 各写一份、都没人读
  ['G.Platform.sys', 'isWeb'],
  ['G.Platform.input', 'upOn'],       // 未文档化、全项目零调用（up 才是松手通道）
  ['G.Loot', 'envWeight'],            // 只是 rollFish 的内部实现
  ['G.Loot', 'pickInBucket'],
  ['G.Fight', 'isRunning'],
  ['G.Goals', 'today'],               // weekOf / week 有人用，today 没有
  ['G.Tutorial', 'isFinished'],
  ['G.Audio', 'isEnabled'],
  ['G.Audio', 'getVolume'],
  ['G.Panels', 'getPendingCatch'],
  ['G.Panels', 'hideCatch'],          // 内部实现（fire / dismissCatch 用）
].forEach(([hostPath, key]) => {
  const host = hostPath.split('.').reduce((o, k) => (o == null ? o : o[k]), global);
  ok(!!host && host[key] === undefined, `${hostPath}.${key} 已从导出面移除（零消费死接口）`);
});

/* =========================================================
   低多边形 3D · Mesh3D + FishMesh（3D 化改造队列 T1 / T2）
   这两块是**纯逻辑**（不碰 DOM / Canvas / Fishing），所以能在 Node 里跑。
   验的是「不报错但结果错」那一类：角度当弧度用、近平面除零、
   顶点算出 NaN、排序方向反了、每个面没描边导致露发丝缝。
   规格：docs/3D渲染方案.md §3 / §4
   ========================================================= */
(function () {
G_('Mesh3D —— 投影 / 法线 / 光照 / 排序 / 绘制');
const M3 = G.Mesh3D, FM = G.FishMesh;

near(M3.rad(180), Math.PI, 1e-9, 'rad()：180° == π');
near(M3.rad(60), 1.0472, 1e-4,
  'rad()：60° ≈ 1.0472 弧度（参考实现曾把 60 当弧度用 → 197° 视角错位，且不报错）');

const vw0 = M3.view(200, 100, 0, 0, 3);
ok(vw0.cx === 100 && vw0.cy === 50, 'view()：画面中心在 (w/2, h/2)');
near(vw0.f, 100 * 1.45, 1e-9, 'view()：焦距 = min(w,h) × 1.45');

const pj0 = M3.projectVerts(vw0, [{ x: 0, y: 0, z: 0 }], []);
near(pj0[0].x, 100, 1e-9, 'projectVerts()：原点投影在画面中心 x');
near(pj0[0].y, 50, 1e-9, 'projectVerts()：原点投影在画面中心 y');
near(pj0[0].d, 3, 1e-9, 'projectVerts()：原点相机距离 = camZ');

const pjNear = M3.projectVerts(vw0, [{ x: 0, y: 0, z: 99 }], []);
ok(pjNear[0].d === 0.35,
  'projectVerts()：越过相机的顶点被夹到近平面 0.35（否则透视除零 / 三角面翻面）');

const pjFwd = M3.projectVerts(vw0, [{ x: 0, y: 0, z: 0.5 }], [])[0];
const pjBack = M3.projectVerts(vw0, [{ x: 0, y: 0, z: -0.5 }], [])[0];
ok(pjFwd.s > pjBack.s, 'projectVerts()：离相机越近缩放越大');

const nf = M3.norm(M3.faceNormal(
  { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }));
near(nf[2], 1, 1e-9, 'faceNormal()：XY 平面上的三角形法线朝 +z');
ok(Math.abs(nf[0]) < 1e-9 && Math.abs(nf[1]) < 1e-9, 'faceNormal()：法线已归一化');

near(M3.toViewNormal([0, 0, 1], vw0)[2], 1, 1e-9, 'toViewNormal()：无旋转时法线不变');

const palAmb = { back: [1, 1, 1], belly: [1, 1, 1], rim: [0, 0, 0], rimK: 0, spec: 0, metallic: 0 };
// 光照模型（按 v9 参考图重标定过）：亮度 = max(环境项 + 主光, 腹部反射补光 × (1-t))
const shTop = M3.shade(M3.norm([0, 1, 0]), [0, 0, 1], palAmb, M3.LIGHT);
near(shTop[0], M3.LIGHT.ambient + 0.806 * M3.LIGHT.keyGain, 0.02,
  'shade()：正朝上的面被主光打亮（v9 的亮面是真的亮，不是一片灰）');
const shBelly = M3.shade(M3.norm([0, -1, 0]), [0, 0, 1], palAmb, M3.LIGHT);
near(shBelly[0], M3.LIGHT.bellyFloor, 1e-6,
  'shade()：正朝下的面亮度 = 腹部反射补光下限（v9 参考图里鱼肚是亮的，没有这一项会黑成一块）');
ok(M3.LIGHT.bellyFloor < 1 && M3.LIGHT.ambient < M3.LIGHT.bellyFloor,
  'shade()：腹部补光只作用于朝下的面，不是「把整条鱼提亮」的环境光（口径仍是「无环境补光」）');

const palRim = { back: [0.5, 0.5, 0.5], belly: [0.5, 0.5, 0.5], rim: [1, 1, 1], rimK: 1, spec: 0, metallic: 0 };
const shEdge = M3.shade([0, 0, 1], [1, 0, 0], palRim, M3.LIGHT);   // 法线 ⟂ 视线 → 边缘项拉满
const shFace = M3.shade([0, 0, 1], [0, 0, 1], palRim, M3.LIGHT);   // 法线正对视线 → 边缘项为 0
ok(shEdge[0] > shFace[0] + 0.2,
  'shade()：侧对视线（边缘）显著亮于正对视线（中间）—— 这是「边缘光」成立的前提');

const palNoSpec = { back: [0.2, 0.2, 0.2], belly: [0.2, 0.2, 0.2], rim: [0, 0, 0], rimK: 0, spec: 0, metallic: 0 };
const palSpec = { back: [0.2, 0.2, 0.2], belly: [0.2, 0.2, 0.2], rim: [0, 0, 0], rimK: 0, spec: 0.9, metallic: 1 };
let specOk = true;
[[0, 0, 1], [0.5, 0.5, 0.7], [0.32, -0.72, -0.42]].forEach(v => {
  const n2 = M3.norm(v);
  const a = M3.shade(n2, [0, 0, 1], palNoSpec, M3.LIGHT)[0];
  const b = M3.shade(n2, [0, 0, 1], palSpec, M3.LIGHT)[0];
  if (b < a - 1e-9) specOk = false;
});
ok(specOk, 'shade()：开镜面后各角度都不会比关闭时更暗（黄金 / 闪光档靠它出高光）');

const ord = M3.sortOrder(
  [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
  [{ d: 3 }, { d: 3 }, { d: 3 }, { d: 1 }, { d: 1 }, { d: 1 }, { d: 2 }, { d: 2 }, { d: 2 }],
  [0, 1, 2], new Float32Array(3));
ok(ord[0] === 0 && ord[1] === 2 && ord[2] === 1,
  'sortOrder()：远的先画（画家算法），顺序 = 相机距离降序');

const meshFish = FM.build('fish');
const tgt = M3.makeTarget(meshFish);
ok(tgt.proj.length === meshFish.verts.length && tgt.order.length === meshFish.tris.length,
  'makeTarget()：投影 / 排序缓冲长度与网格一致（每帧复用，不新建数组）');

M3.freeze(meshFish, tgt);
ok(Math.abs(tgt.ax[10] - meshFish.verts[10].x) < 1e-6 &&
   Math.abs(tgt.az[10] - meshFish.verts[10].z) < 1e-6,
  'freeze()：不开动画时顶点原样拷贝（缓冲是 Float32Array，比较要给容差）');

M3.animate(meshFish, 0.81, tgt);
let dispNear = 0, dispTail = 0;
meshFish.verts.forEach((v, i) => {
  const dz = Math.abs(tgt.az[i] - v.z);
  if (v.t > 0.1 && v.t < 0.3) dispNear = Math.max(dispNear, dz);
  if (v.t > 0.85) dispTail = Math.max(dispTail, dz);
});
ok(dispTail > dispNear * 2 && dispTail > 0.01,
  'animate()：越靠尾摆动越大（身体行进波，幅度按 t^1.7 增长）');
M3.freeze(meshFish, tgt);        // 还原，别影响后面的渲染断言

let fills = 0, strokes = 0;
const fakeCtx = {
  fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '',
  beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
  fill() { fills++; }, stroke() { strokes++; }
};
const drawn = M3.render(fakeCtx, meshFish, {
  target: tgt, view: M3.view(400, 300, 0, 0, 3.05),
  palette: { back: [0.3, 0.4, 0.5], belly: [0.8, 0.85, 0.85], rim: [0.7, 0.9, 1], rimK: 0.9, spec: 0, metallic: 0 },
  time: 0, animate: false
});
ok(drawn === meshFish.tris.length && fills === meshFish.tris.length,
  'render()：每个三角面恰好画一次（填充次数 == 面数）');
ok(strokes === fills,
  'render()：每面填充后都用同色描一遍（不描的话三角面之间会露底色的发丝缝，像线框）');

G_('FishMesh —— 全 9 种体型的三角网格（队列 T3）');
const SHAPES9 = ['fish', 'eel', 'ray', 'squid', 'jelly', 'oarfish', 'shark', 'whale', 'dragon'];
ok(Object.keys(FM.TYPES).length === 9 && SHAPES9.every(k => !!FM.TYPES[k]),
  'TYPES：9 种体型齐全（与 fishart.js 的 TPL 同一批；漏一种就会有鱼画不出网格）');

// 与 fish.js 实际用到的体型集合对齐（现算，不写死数字）
const usedShapes = {};
G.FISH.forEach(f => { usedShapes[f.shape] = true; });
const shapeMissing = Object.keys(usedShapes).filter(s => !FM.TYPES[s]);
ok(shapeMissing.length === 0,
  `渔获实际用到的 ${Object.keys(usedShapes).length} 种体型都能建网格（缺：${shapeMissing.join('、') || '无'}）`);

SHAPES9.forEach(k => {
  const m = FM.build(k);
  ok(m.verts.every(v => isFinite(v.x) && isFinite(v.y) && isFinite(v.z)),
    `build('${k}')：顶点坐标都是有限数（无 NaN / Infinity）`);
  ok(m.tris.length > 100 && m.tris.length < 900,
    `build('${k}')：面数落在 100~900（实际 ${m.tris.length}）`);
  ok(m.verts.every(v => v.t >= 0 && v.t <= 1),
    `build('${k}')：顶点 t 都在 [0,1]（动画按 t 施加，越界会算出畸形）`);
  ok(m.verts.every(v => v.b >= -1.001 && v.b <= 1.001),
    `build('${k}')：顶点 b 都在 [-1,1]（两色身体按 b 分背腹）`);
  ok(m.tris.every(t => t.length === 3 && t.every(i => i >= 0 && i < m.verts.length)),
    `build('${k}')：所有三角面的顶点索引都在范围内（越界会画出乱线）`);
});

function bboxOf(m) {
  const b = M3.bbox(m);
  return { x: b.x1 - b.x0, y: b.y1 - b.y0, z: b.z1 - b.z0 };
}
const bFish = bboxOf(FM.build('fish'));
const bRay = bboxOf(FM.build('ray'));
const bJelly = bboxOf(FM.build('jelly'));
ok(bFish.x > 1.8 && bFish.x < 2.4, `fish：体长跨度合理（${bFish.x.toFixed(2)}，含尾鳍）—— 比例按 v9 参考图量过`);
ok(bFish.y > 0.5 && bFish.y < 1.0, `fish：体高跨度合理（${bFish.y.toFixed(2)}，含背鳍 / 胸鳍）`);
ok(bRay.z > bRay.y * 5, `ray：极扁的盘（展向 ${bRay.z.toFixed(2)} 是厚度 ${bRay.y.toFixed(2)} 的 ${(bRay.z/bRay.y).toFixed(1)} 倍）`);
ok(bRay.x > bRay.z * 0.9,
  `ray：算上鞭尾，总长（${bRay.x.toFixed(2)}）与展向（${bRay.z.toFixed(2)}）同量级 —— 不是「一个大盘拖着短线」`);
ok(bRay.y < 0.3, `ray：极扁（厚度 ${bRay.y.toFixed(2)}）—— 车削式做不出这个平面型，所以它走独立生成器`);
ok(bJelly.y > bJelly.x, `jelly：伞盖 + 触手在竖直方向展开（高 ${bJelly.y.toFixed(2)} > 宽 ${bJelly.x.toFixed(2)}）`);

near(FM.profileAt('fish', 0.37).hy, 0.3378, 0.05,
  'profileAt()：最粗处在体长约 37% 位置（流线型鱼的重心偏前）');
ok(FM.profileAt('fish', 0).hy < 0.05 && FM.profileAt('fish', 1).hy < 0.05,
  'profileAt()：吻端与尾根趋近于 0（环退化成一个点，三角面自然收尖）');
ok(FM.profileAt('没这个体型', 0.5) === null, 'profileAt()：未知体型返回 null，不是抛异常');
near(FM.rad(90), Math.PI / 2, 1e-9, 'rad()：导出给调用方用（角度参数一律过它转弧度）');

// 默认视角必须按体型给：鳐侧视只是一条细缝，正 / 侧面都没有辨识度
const dvRay = FM.defaultView('ray'), dvFish = FM.defaultView('fish'), dvJelly = FM.defaultView('jelly');
ok(dvRay.pitch > 1.3 && dvRay.pitch < 1.6,
  `defaultView('ray')：俯仰 ${(dvRay.pitch * 180 / Math.PI).toFixed(0)}° —— 鳐必须接近正俯视；60° 是斜俯，展向会被压扁`);
ok(dvFish.pitch === 0 && dvFish.yaw === 0, 'defaultView()：常规鱼默认侧视（辨识度最高的角度）');
ok(dvJelly.pitch !== 0, 'defaultView()：水母不是正侧视（要看到伞盖内侧）');
ok(FM.defaultView('没这个体型') === null, 'defaultView()：未知体型返回 null');

G_('FishPaint —— 颜色变异 → 材质参数（队列 T4）');
const FP = G.FishPaint;
ok(FP.MORPH_KEYS.length === CFG.colorMorphs.length &&
   FP.MORPH_KEYS.every((k, i) => CFG.colorMorphs[i].key === k),
  'MORPH_KEYS 的顺序与 config.colorMorphs 完全一致（不许有第二份顺序）');

const ORANGE = ['#e0683c', '#8a3a1c'];
const pN = FP.palette(ORANGE[0], ORANGE[1], 'normal');
const pB = FP.palette(ORANGE[0], ORANGE[1], 'bright');
const pA = FP.palette(ORANGE[0], ORANGE[1], 'albino');
const pG = FP.palette(ORANGE[0], ORANGE[1], 'golden');
const pS = FP.palette(ORANGE[0], ORANGE[1], 'shiny');

const satOf = c => Math.max.apply(null, c) - Math.min.apply(null, c);
const hueOrange = c => c[0] > c[1] && c[1] > c[2];        // 橙：红 > 绿 > 蓝

// ⚠️ 2026-10-07 口径变更：亮色从「同色系提亮提饱和」改成「**彩虹**」
//    （用户口径「之前的亮色就用现在的彩虹色吧」）。旧断言「保留原色相」按新口径已作废。
//    新口径要验四件事：给出多色带 / 带内色相确实在走 / 起点是本鱼色相 / 不压过黄金。
ok(hueOrange(pN.back), '原色档保留本色（橙仍是红>绿>蓝）');
ok(pB.bands && pB.bands.length >= 4,
  `彩虹色档：必须给出多色带 bands（实得 ${pB.bands ? pB.bands.length : 0} 段）`);
const bandSpread = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
// ⚠️ 不能拿「首尾」比 —— 5 段 × 0.25 刚好走完一圈色相环，首尾本来就是同一个色
//    （实测首尾色距 = 0.000，这条断言一开始就是这么写错的）。要拿「首 vs 中」比。
ok(bandSpread(pB.bands[0], pB.bands[2]) > 0.5,
  '彩虹带的半圈必须明显变色（否则退化成单色 = 等于没换色相）');
ok(hueOrange(pB.bands[0]),
  '彩虹的**起点**用本鱼自己的色相（橙鱼的带首仍是暖色）—— 同类之间才有区分度');
ok(pG.rimK > pB.rimK,
  `黄金的边缘光强度必须压过彩虹色（亮 ${pB.rimK} < 金 ${pG.rimK}）—— 价格梯度的视觉契约`);
// 白化 = 去色，但要**分开判身体与鳍**（用户口径「颜色要稍微区分一点点」）：
//   · 身体（belly）必须真的去色 —— 这才是「白化」的定义
//   · 鳍（back）允许带**淡粉**（v8 标准的「白身 + 淡粉鳍」），所以只要求它**比原色淡**
// ⚠️ 初版拿 back 一刀切（要求 < 原色 × 0.45），粉比例一提到 0.70 就报红，
//    但那是**口径变了**不是 bug —— 断言得跟着口径走。
ok(satOf(pA.belly) < satOf(pN.belly) * 0.45,
  `白化档把**身体**的饱和压得很低（${satOf(pN.belly).toFixed(2)} → ${satOf(pA.belly).toFixed(2)}）—— 手段 = 去色`);
ok(satOf(pA.back) < satOf(pN.back),
  `白化档的鳍仍比原色淡（${satOf(pN.back).toFixed(2)} → ${satOf(pA.back).toFixed(2)}），但保留淡粉 —— 方向不反转`);
ok(pG.metallic === 1 && pS.metallic === 0,
  '黄金 = 换材质（metallic 1）；闪光不是金属（手段必须互不重叠）');
ok(pS.spin === 1 && pS.sparkle === 1 && pG.sparkle === 0 && pA.sparkle === 0,
  '闪光 = 加光效（移动高光 + 星点），黄金 / 白化都没有');
ok(pG.rimK > pN.rimK && pS.rimK > pG.rimK,
  `边缘光强度逐级递增：${pN.rimK} → ${pG.rimK} → ${pS.rimK} —— 越稀有轮廓越亮`);

const pN2 = FP.palette('#5f8fd0', '#2f4f80', 'normal');
ok(Math.abs(pN.back[0] - pN2.back[0]) > 0.15 && Math.abs(pN.back[2] - pN2.back[2]) > 0.15,
  `原色档按鱼自己的配色走（橙鱼的背色 R=${pN.back[0].toFixed(2)}，蓝鱼 R=${pN2.back[0].toFixed(2)}）` +
  ' —— 不是套一个统一灰');
ok(FP.fromFish(null, 'normal').back.length === 3,
  'fromFish()：空鱼给兜底配色，不抛异常');
ok(FP.hexToRgb('nope').length === 3 && FP.hexToRgb(null).length === 3,
  'hexToRgb()：认不出的输入退回中灰（脏档不该把整条渲染链带崩）');
ok(FP.hexToRgb('#abc')[0] > 0.6, 'hexToRgb()：支持三位简写 #abc');
ok(FP.isSparkly('shiny') && !FP.isSparkly('golden'), 'isSparkly()：只有闪光档叠星点');
ok(FP.shouldAnimate(3, 'normal') === true && FP.shouldAnimate(0, 'normal') === false &&
   FP.shouldAnimate(0, 'shiny') === true,
  'shouldAnimate()：传说档与闪光色开动画，普通原色不开 —— 「稀有的东西才配动」');
ok(FP.mix([0, 0, 0], [1, 1, 1], 0.5)[0] === 0.5, 'mix()：线性插值');

const realFish = G.FISH.filter(f => f.rar === 3)[0] || G.FISH[0];
ok(!!FP.fromFish(realFish, 'golden').back,
  `fromFish()：能吃下 fish.js 的真实字段（body/accent）—— 试了「${realFish.name}」`);

G_('FishMesh —— 传说细节层级（用户口径：传说鱼细节明显更足）');
ok(FM.detailForRar(0) === 0 && FM.detailForRar(1) === 0 &&
   FM.detailForRar(2) === 1 && FM.detailForRar(3) === 2,
  'detailForRar()：普通 / 稀有 = 0 级，史诗 = 1 级，传说 = 2 级');
ok(FM.DETAIL_TIERS.length === 4 && FM.DETAIL_TIERS[3].detail === 2,
  'DETAIL_TIERS：稀有度 → 细节层级是单一来源（不在别处再写一份映射）');

/* 稀有度递进按**剪影**验，不按面数：
   基础档已经给全解剖结构，史诗档是「同样的鳍更长」，面数不变但轮廓变大。
   按面数验会漏掉这一档（实测踩过：改完之后 detail 1 与 detail 0 面数完全相同）。 */
const thinTier = [];
const flatTier = [];
SHAPES9.forEach(k => {
  const d0 = FM.build(k, { detail: 0 }), d1 = FM.build(k, { detail: 1 }), d2 = FM.build(k, { detail: 2 });
  const b0 = bboxOf(d0), b1 = bboxOf(d1), b2 = bboxOf(d2);
  const g1 = Math.max(b1.x - b0.x, b1.y - b0.y, b1.z - b0.z);
  const g2 = Math.max(b2.x - b1.x, b2.y - b1.y, b2.z - b1.z);
  if (g1 < 0.008) flatTier.push(k + '(+' + g1.toFixed(3) + ')');
  if (g2 < 0.008) thinTier.push(k + '(+' + g2.toFixed(3) + ')');
  // 加了附属结构之后坐标仍必须是有限数 —— 锚点算错时最容易出 NaN，
  // 而 NaN 只是「什么都不显示」，不会报错（实测踩过：鳐鱼飘带锚点漏了 span）
  ok(d2.verts.every(v => isFinite(v.x) && isFinite(v.y) && isFinite(v.z)),
    `build('${k}', detail 2)：加了飘带 / 棘刺后坐标仍是有限数`);
});
ok(flatTier.length === 0,
  `史诗档比普通档的剪影更大（鳍更长）${flatTier.length ? '；没变的：' + flatTier.join('、') : ''}`);
ok(thinTier.length === 0,
  `传说档比史诗档的剪影更大（再叠飘带 / 棘刺）${thinTier.length ? '；没变的：' + thinTier.join('、') : ''}`);

// 关键：细节必须落在**剪影**上 —— 缩到 64px 时表面全糊，只有轮廓外的突起读得出来
let silBad = [];
SHAPES9.forEach(k => {
  const b0 = bboxOf(FM.build(k, { detail: 0 })), b2 = bboxOf(FM.build(k, { detail: 2 }));
  const grow = Math.max(b2.x - b0.x, b2.y - b0.y, b2.z - b0.z);
  if (grow < 0.02) silBad.push(k + '(+' + grow.toFixed(3) + ')');
});
ok(silBad.length === 0,
  `传说档的剪影确实变大（不是贴表面纹理）${silBad.length ? '；没变的：' + silBad.join('、') : ''}`);

const f0 = FM.build('fish', { detail: 0 }), f1 = FM.build('fish', { detail: 1 }), f2 = FM.build('fish', { detail: 2 });
ok(f2.tris.length > f0.tris.length,
  `传说档的三角面多于普通档（${f0.tris.length} → ${f2.tris.length}）—— 飘带 / 双层尾鳍是新增几何`);
ok(f2.tris.length >= f0.tris.length * 1.05,
  `fish：传说档面数至少多 10%（${f0.tris.length} → ${f2.tris.length}）`);
const bb0 = bboxOf(f0), bb2 = bboxOf(f2);
ok(bb2.x > bb0.x + 0.2,
  `fish：传说档尾鳍飘带把剪影拉长（${bb0.x.toFixed(2)} → ${bb2.x.toFixed(2)}）—— 64px 下靠它认出来`);
})();

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (fail) { console.log(`\u2716 测试未通过：${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`\u2714 全部通过：${pass} 项\n`);
