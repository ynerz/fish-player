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
 'src/data/goals.js', 'src/data/assistant.js', 'src/data/story.js',
 'src/core/util.js', 'src/core/platform.js', 'src/core/profile.js', 'src/core/assets.js', 'src/core/loot.js', 'src/core/fight.js', 'src/core/state.js',
 'src/core/integrity.js',
 'src/core/goals.js', 'src/core/weather.js', 'src/core/fishing.js', 'src/core/assistant.js', 'src/core/story.js', 'src/core/track.js',
 'src/render/fishpaint.js',
 'src/ui/tutorial.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));

/* ⚠️ 档案（N1）必须先 init：真实运行时 main.js 就是这么做的，
   存档键因此是 `<saveKey>.<uid>`。整套测试都在「默认档案」下跑，
   所以下面凡是要读写「当前存档」的地方都必须走 G.Profile.key()，
   直接写 CFG.saveKey 会落到一个没人读的老键上（曾经的 20 项失败就这么来的）。 */
if (global.G.Profile && global.G.Profile.init) global.G.Profile.init();

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
/* 力竭提示：tireHint() 自己管「报过没有」，UI 不许往战局对象上挂字段 */
(() => {
  const drop = CFG.fight.tireMaxDrop, rng = CFG.fight.tireRampFrom, below = CFG.fight.tireHintBelow;

  /* ① 触发线必须落在 tire 的真实取值区间内，否则提示永远不弹（旧值 0.62 < 下限 0.78 就是这样） */
  const tireMin = 1 - drop;
  ok(below > tireMin,
    `力竭提示线 ${below} 落在 tire 取值区间 (${tireMin.toFixed(3)}, 1] 内（低于下限 = 提示永不弹）`);
  const pAt = rng + (100 - rng) * (1 - below) / drop;   // 现算：tire 跌破阈值时的进度
  ok(pAt < 100, `提示线对应进度 ${pAt.toFixed(1)}% < 100%（能在对局内触发，而不是只有打完才到）`);

  /* ② 一次对局只提示一次 */
  fight(3, null);
  const st = F.get();
  ok(st.tire === 1, 'begin() 后 tire 已初始化（不是 undefined，免得首帧拿不到值）');
  st.progress = rng; F.update(1 / 60, true);
  ok(F.tireHint() === false, `进度 ${rng}% 时 tire≈1 → 不提示`);
  st.progress = 80; F.update(1 / 60, true);
  ok(F.get().tire < below, `进度 80% 时 tire=${F.get().tire.toFixed(3)} 已跌破 ${below}`);
  ok(F.tireHint() === true, '力竭提示第一次问 → true');
  ok(F.tireHint() === false, '同一次对局再问 → false（只报一次）');
  ok(F.get().tiredNoted === true, '「报过没有」记在战局对象自己的字段上（不是外面挂的 _xxx）');
  ok(F.snapshot().tire01 === F.get().tire, 'snapshot 带 tire01（提示线同族，供 UI 读）');
  ok(F.snapshot().struggle01 !== undefined, 'snapshot 带 struggle01（画面表现量走同一出口）');

  F.end();
  ok(F.tireHint() === false, 'Fight.end() 后 tireHint() 返回 false（不崩）');

  /* ③ 阈值真读 config，不是写死在 fight.js 里 */
  const keep = CFG.fight.tireHintBelow;
  CFG.fight.tireHintBelow = 1;              // 只有 tire 严格小于 1 才提示 → 开局即满足
  fight(3, null); F.get().progress = rng + 1; F.update(1 / 60, true);
  ok(F.tireHint() === true, '阈值改成 1 → 刚开始乏力就提示（说明读的是 config）');
  F.end();
  CFG.fight.tireHintBelow = keep;
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
const raw = store[G.Profile.key()];
ok(!!raw && raw.length > 100, `存档已写入 localStorage（${raw.length} 字节）`);
St.load();
ok(St.get().book[f0.id].n === 2, '重载后图鉴数据保持');

/* migrate：缺字段的老存档要能补上 */
G_('State · 老存档迁移');
const legacy = { v: 1, coin: 777, field: 'D', unlocked: { D: true }, book: {}, baits: {}, rods: ['bamboo'], lines: ['n2'], decors: [] };
store[G.Profile.key()] = JSON.stringify(legacy);
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
G_('Profile · 本机档案（uid / 存档键 / 老档迁移）');
(function () {
  const P = G.Profile;
  ok(!!P, 'profile.js 已加载且导出 G.Profile');
  if (!P) return;

  /* 干净起步：清空所有存储 */
  Object.keys(store).forEach(k => delete store[k]);

  const uid1 = P.init();
  ok(!!uid1 && P.current() && P.current().uid === uid1, '首次启动自动建出默认档案');
  ok(P.key() === CFG.saveKey + '.' + uid1,
     '存档键按 uid 分档（' + P.key() + '）—— 每个档案一份档');
  ok(P.list().length === 1 && P.list()[0].locked === false, '默认档案是免密档');
  ok(P.keyBak() === P.key() + '.bak' && P.keyRescue() === P.key() + '.rescue',
     '备份键 / 救援键都跟着当前档案走（不再指向老的单档键）');

  /* 老档迁移：账号表没了但老键有内容 ⇒ 进度必须被搬进新档案键 */
  delete store['fishplayer.accounts.v1'];
  store[CFG.saveKey] = '{"v":5,"coin":1234}';
  const uid2 = P.init();
  ok(uid2 !== uid1, '重新 init 会建一个新档案（uid 不重复）');
  ok(store[P.keyFor(uid2)] === '{"v":5,"coin":1234}',
     '🔴 老档被搬到新档案键下 —— 升级不丢进度',
     '实际：' + store[P.keyFor(uid2)]);
  ok(store[CFG.saveKey] === '{"v":5,"coin":1234}',
     '老键原样保留（迁移是复制不是剪切，出问题还能捞回来）');

  /* 最后一个档案不许删 */
  const r = P.remove(uid2);
  ok(r.ok === false, '只剩一个档案时拒绝移除（否则玩家会把自己锁在门外）');

  /* 能力探测要如实回报 */
  ok(typeof P.isSecure() === 'boolean', 'isSecure() 如实回报「有没有 crypto.subtle」');
  ok(typeof P.NAME_MAX === 'number' && typeof P.PW_MIN === 'number',
     '昵称 / 密码的长度约束从这里出（界面文案与它同源）');

  /* 收尾：留一个干净档，别影响后面的用例 */
  Object.keys(store).forEach(k => delete store[k]);
  P.init();
})();

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
const audioStub = {
  setEnabled() {}, setVolume() {}, setMusicVolume() {},
  cast() {}, splash() {}, bite() {}, hint() {}, tick() {}, snap() {}, escape() {},
  success() {}, legendary() {}, glint() {}, reward() {}, newRecord() {},
  coin() {}, click() {}, deny() {}, unlock() {},
  startAmbience() {}, stopAmbience() {}, startBgm() {}, stopBgm() {},
};
const origAudio = G.Audio;
G.Audio = audioStub;
/* ⚠️ 空壳必须覆盖真实模块的**全部**导出方法。漏一个，生产代码在某个用例里调到它
   就炸成 `TypeError: G.Audio.xxx is not a function`，而堆栈指向 test.js 里的某一行
   （不是在 audio.js），第一眼很难看出「是桩缺方法」——2026-10-08 加 `glint` 时就是这么炸的。
   所以这里**从真实模块现取一份方法名**来对账，而不是在两边各抄一张清单（抄必然分家）。 */
(function () {
  const keep = G.Audio;
  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const keys = Object.keys(G.Audio);
  G.Audio = keep;
  const miss = keys.filter(k => typeof audioStub[k] !== 'function');
  ok(miss.length === 0,
     `audioStub 覆盖真实音频模块的全部 ${keys.length} 个导出方法（缺一个就会在某个用例里炸成 TypeError）`,
     '缺：' + miss.join('、'));
})();
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
store[G.Profile.key()] = JSON.stringify(legacy2);
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
store[G.Profile.key()] = JSON.stringify(dirty2);
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
ok(St.SAVE_V >= 5, `SAVE_V = ${St.SAVE_V}（v5 起有周常挑战字段；这里只断言「不退回 5 之前」）`);
St.get().weekly = 'garbage';
const legacyW = JSON.parse(JSON.stringify(St.get()));
legacyW.v = 4; legacyW.weekly = 'garbage';
store[G.Profile.key()] = JSON.stringify(legacyW);
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
store[G.Profile.key()] = JSON.stringify(legacy3);
St.load();
ok(St.get().v === St.SAVE_V, `老存档版本号被升到 ${St.SAVE_V}（当前 SAVE_V，不写死）`);
ok(St.get().tut && St.get().tut.done === true, '老存档（v<4）默认「已看过」，不往老玩家脸上糊教学');
ok(T.active() === false, '所以老存档不会弹教学气泡');
const dirtyT = JSON.parse(JSON.stringify(legacy2));
dirtyT.tut = { step: 'oops', done: 'yes' };
store[G.Profile.key()] = JSON.stringify(dirtyT);
St.load();
ok(St.get().tut.step === 0 && St.get().tut.done === true, '脏 tut 被纠正成 0..N 的整数 + 布尔');
const overT = JSON.parse(JSON.stringify(legacy2));
overT.v = 4; overT.tut = { step: 99, done: false };
store[G.Profile.key()] = JSON.stringify(overT);
St.load();
ok(St.get().tut.step === tSteps.length && St.get().tut.done === true, 'step 越界被夹回总步数并视为已完成');
const badT = JSON.parse(JSON.stringify(legacy2));
badT.v = 4; badT.tut = 'nonsense';
store[G.Profile.key()] = JSON.stringify(badT);
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

/* ---- 非数的秒数必须被拒之门外 ----
   lastSeen 是从存档里读出来的：脏档兜底扫不到的键可能不是数字，
   `(Date.now() - lastSeen) / 1000` 就是 NaN —— 原实现里 NaN 会一路
   溜进抽样与累加，`stats.catches += NaN` 把统计永久污染（且不报错）。 */
(function () {
  St.reset(); Fish.init({});
  const casts0 = St.get().stats.catches, coin0 = St.get().coin;
  const bad = [NaN, Infinity, -Infinity, -3600];
  const allNull = bad.every((v) => Fish.offlineCatchUp(v, 30) === null);
  ok(allNull, 'NaN / ±Infinity / 负数的离线秒数一律不补算（返回 null）');
  ok(St.get().stats.catches === casts0, '拒绝后不写 stats.catches（NaN 不许进统计）');
  ok(St.get().coin === coin0, '拒绝后不动金币');
  ok(Fish.offlineCatchUp(3600, NaN) !== null && isFinite(Fish.offlineCatchUp(3600, NaN).count),
     '单竿耗时为非数时退回默认 35 秒，照常补算');
})();

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
  store[G.Profile.key()] = JSON.stringify(d);
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
   ⚠️ 会反复覆盖 store[G.Profile.key()]，放在最后几节之一。
   ========================================================= */
G_('State · 读档失败不再白屏（退备份 → 再退新档）');
const realErrLoad = console.error;
console.error = () => {};        // G.Track.error 会打 console，这里不希望刷屏
const pristine = JSON.parse(JSON.stringify(St.get()));

/* ① 主存档是半截 JSON（写到一半断电 / 手改坏了），备份是好的 → 用备份 */
store[G.Profile.key()] = '{"v":5,"coin":99,';
const bakGood = JSON.parse(JSON.stringify(pristine)); bakGood.coin = 4321;
store[G.Profile.keyBak()] = JSON.stringify(bakGood);
let loadErr1 = null;
try { St.load(); } catch (e) { loadErr1 = e; }
ok(!loadErr1, '主存档是半截 JSON 时 load() 不抛异常（原来会冒到 boot 变白屏）', loadErr1 && loadErr1.message);
ok(St.get().coin === 4321, '退到备份档，进度真的恢复了');
ok(/备份/.test(St.loadNote()), '并且给出「已从备份恢复」的提示语');

/* ② 主存档是合法 JSON 但不是对象 → 同样退备份 */
store[G.Profile.key()] = '"not an object"';
St.load();
ok(St.get().coin === 4321 && /备份/.test(St.loadNote()), '主存档不是对象时也退备份');

/* ③ 主 + 备份全废 → 开新档，但原始内容必须留一份 */
store[G.Profile.key()] = '{oops';
store[G.Profile.keyBak()] = 'also not json';
let loadErr3 = null;
try { St.load(); } catch (e) { loadErr3 = e; }
ok(!loadErr3, '两份存档都读不出来时 load() 也不抛异常（原来直接白屏）', loadErr3 && loadErr3.message);
ok(St.get().coin === CFG.economy.startCoin, '两份都读不出来时开新档而不是白屏');
ok(/重置/.test(St.loadNote()), '并且明确告诉玩家「已重置为新档」');
const rescueTxt = String(store[G.Profile.keyRescue()] || '');
ok(rescueTxt.indexOf('{oops') >= 0,
   '原始坏档被挪到 rescue 键留存（否则下一个自动存档就把证据盖掉了）');
ok(rescueTxt.indexOf('also not json') >= 0, '备份的原始内容也一起留存');

/* ④ 一切正常时不打扰玩家 */
store[G.Profile.key()] = JSON.stringify(pristine);
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

  /* ---- 注册型能力：注册了没有？回调到底挂到了哪个目标的哪个事件上？ ----
     这一节原来只覆盖「拿不到就返回默认值」的**兜底**，注册型能力（on*）完全没人管：
     注册没注册、挂对没挂对，只能靠人读源码。踩过的坑就在隔壁 ——
     `input.up` 曾写成 up(el, fn)，真正注册的是 addEventListener('pointerup', undefined)，
     「松手」永不生效且不报错。所以这里把「目标 + 事件名」写成**表**，
     并且要求**每个 sys.on\* 都必须在这张表里** —— 将来加一个能力，忘了补断言会直接报红。 */
  const prevWinAdd = global.addEventListener;
  const prevDocReal = global.document;
  const reg = [];
  global.addEventListener = t => { reg.push('window:' + t); };
  global.document = { readyState: 'loading', addEventListener: t => { reg.push('document:' + t); } };
  const ON_TABLE = [
    ['onResize', 'window:resize'],
    ['onVisibility', 'document:visibilitychange'],   // 可见性挂在 document 上
    ['onFocus', 'window:focus'],
    ['onBlur', 'window:blur'],
    ['onError', 'window:error'],                     // G.Track 的全局兜底
    ['onRejection', 'window:unhandledrejection'],
    ['onReady', 'document:DOMContentLoaded'],        // readyState=loading 时才挂
  ];
  let regBad = 0;
  try {
    ON_TABLE.forEach(([fn, want]) => {
      reg.length = 0;
      P.sys[fn](() => {});
      if (reg.length !== 1 || reg[0] !== want) {
        ok(false, `sys.${fn}() 把回调挂到 ${want}`, '实际注册了 ' + (reg.join(' / ') || '（一个都没有）'));
        regBad++;
      } else {
        ok(true, `sys.${fn}() 把回调挂到了 ${want}`);
      }
    });
  } finally {
    global.addEventListener = prevWinAdd;
    global.document = prevDocReal;
  }
  /* 完整性：sys.on* 里的每一个都得在表里（否则「加了能力没人验」这个缺口会重开）*/
  const onNames = Object.keys(P.sys).filter(k => /^on[A-Z]/.test(k));
  const notCovered = onNames.filter(k => ON_TABLE.every(x => x[0] !== k));
  ok(notCovered.length === 0, `sys 的 ${onNames.length} 个注册型能力全部有断言覆盖`,
     '漏了 ' + notCovered.join('、') + ' —— 请补进 ON_TABLE');

  /* onReady 的两条「不挂监听」分支：已就绪 / 没有 DOM → 立即执行（不许把启动卡住）*/
  global.document = { readyState: 'complete', addEventListener: () => { throw new Error('不该挂监听'); } };
  let readyHits = 0;
  try { P.sys.onReady(() => { readyHits++; }); } catch (e) { readyHits = -1; }
  ok(readyHits === 1, 'DOM 已就绪时 onReady 立即执行（不再挂 DOMContentLoaded）');
  global.document = undefined;
  let noDomHits = 0;
  try { P.sys.onReady(() => { noDomHits++; }); } catch (e) { noDomHits = -1; }
  ok(noDomHits === 1, '没有 document（Node / 小程序）时 onReady 也立即执行');
  global.document = prevDocReal;

  /* 传 null 回调也不许抛（正常环境下的注册路径不因缺参数崩掉）*/
  let lifeThrew = false;
  try {
    ON_TABLE.forEach(([fn]) => P.sys[fn](null));
  } catch (e) { lifeThrew = true; }
  ok(!lifeThrew, `${ON_TABLE.length} 个注册型能力传 null 回调都不抛（缺参数不炸整块 UI）`);
  void regBad;
})();

/* =========================================================
   Platform · 帧调度 raf / cancelRaf（含「拿不到 raf」的兜底）
   =========================================================
   帧调度原来散在 main.js（主循环）与 panels.js（水族箱动画）里直接调全局，
   2026-10-08 收进 `sys.raf` / `sys.cancelRaf`：小程序（非小游戏）页面**没有**全局
   `requestAnimationFrame`，要换成 `canvas.requestAnimationFrame`。
   ⚠️ 兜底路径不传时间戳是**会出真故障**的：主循环 `dt = (now - last)` 而 last 来自
      `sys.now()`，退回 `setTimeout` 时若不补时间戳，下一帧 dt 就是天文数字。
      所以下面这条断言盯的就是「退回路径也把平台时钟传进回调」。 */
G_('Platform · 帧调度 raf / cancelRaf 的兜底');
(function () {
  const P = G.Platform.sys;
  const keep = {
    raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame,
    st: global.setTimeout, ct: global.clearTimeout,
  };
  const restore = () => {
    global.requestAnimationFrame = keep.raf; global.cancelAnimationFrame = keep.caf;
    global.setTimeout = keep.st; global.clearTimeout = keep.ct;
  };

  /* ① 宿主有 raf：透传，句柄与回调参数都原样交给调用方 */
  let seized = null;
  global.requestAnimationFrame = fn => { seized = fn; return 77; };
  const seen1 = [];
  const h1 = P.raf(n => seen1.push(n));
  seized(1234);
  ok(h1 === 77 && seen1[0] === 1234,
     'sys.raf 走宿主 requestAnimationFrame：句柄与回调参数原样透传');

  /* ② 宿主没有 raf：退回 setTimeout，**但时间戳必须补上** */
  delete global.requestAnimationFrame;
  let fired = null, delay = -1;
  global.setTimeout = (fn, ms) => { fired = fn; delay = ms; return 123; };
  const seen2 = [];
  const h2 = P.raf(n => seen2.push(n));
  ok(h2 === 123 && typeof fired === 'function' && delay > 0,
     `拿不到 raf 时退回 setTimeout（不抛；实得句柄 ${h2}、延迟 ${delay}ms）`);
  const t0 = P.now();
  fired();
  ok(seen2.length === 1 && isFinite(seen2[0]) && Math.abs(seen2[0] - t0) < 1000,
     `退回路径仍把平台时钟当时间戳传给回调（实得 ${seen2[0]}，sys.now() ≈ ${Math.round(t0)}）`
     + ' —— 不补的话主循环下一帧的 dt 会是天文数字');

  /* ③ cancelRaf 要跟着换：没 raf 时该清的是 setTimeout，不是 cancelAnimationFrame */
  let cleared = null;
  global.clearTimeout = h => { cleared = h; };
  P.cancelRaf(123);
  ok(cleared === 123, '拿不到 raf 时 cancelRaf 清的是 setTimeout 句柄（清错对象等于没停）');
  global.cancelAnimationFrame = h => { cleared = 'caf:' + h; };
  global.requestAnimationFrame = fn => 1;
  P.cancelRaf(9);
  ok(cleared === 'caf:9', '有 raf 时 cancelRaf 走宿主 cancelAnimationFrame');

  /* ④ 面板里「关掉水族箱」会把句柄归零后**再调一次**，所以缺参不许抛 */
  let cafThrew = '';
  try { P.cancelRaf(0); P.cancelRaf(null); P.cancelRaf(undefined); }
  catch (e) { cafThrew = e.message; }
  ok(!cafThrew, 'cancelRaf 传 0 / null / undefined 都不抛（句柄归零后还会被再调一次）', cafThrew);

  restore();
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

/* ---- ⑤-b 鱼护行的下标必须「点击时现查」----
   `refresh()` 是 setTimeout(0) 排队的：状态已经变了、DOM 还没重建。
   这个窗口里对着同一行再点一次，若还用渲染时闭包里的下标，
   就会落在**另一条鱼**身上（卖出 / 放生的是玩家没选的那条）。
   真跑：渲染两行 → 对其中一行连点两次「卖出」→ 第二次必须是拒绝，
   鱼护里剩下的还得是原本那条。 */
(function () {
  const clickEl = (tag) => {
    const n = mkEl(tag);
    n._l = [];
    n.addEventListener = (t, fn) => { if (t === 'click') n._l.push(fn); };
    return n;
  };
  const prevCreate = global.document.createElement;
  const prevDoc = global.document;
  global.document.createElement = clickEl;
  const prevAudio = G.Audio;
  G.Audio = { coin() {}, deny() {}, splash() {}, click() {} };
  /* 点击回调里会喊 refresh() → isOpen() → 读 modal：给一个「恒为隐藏」的 modal 桩，
     让 refresh 走「面板没开 → 不重绘」的分支 —— 恰好就是真实浏览器里
     「状态已变、DOM 还没重建」的那个窗口。 */
  const modalEl = clickEl('div');
  modalEl.classList = { add() {}, remove() {}, toggle() {}, contains: () => true };
  global.document = {
    createElement: clickEl,
    querySelector: (s) => (s === '#modal' ? modalEl : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  Panels.init();

  const fa = G.FISH_BY_FIELD.D[0], fb = G.FISH_BY_FIELD.C[0];
  const savedNet2 = St.get().net;
  St.get().net = [{ f: fa.id, kg: 1.2, c: 'normal' }, { f: fb.id, kg: 2.0, c: 'normal' }];
  const root2 = mkEl('div');
  let err2 = null;
  try { Panels.VIEWS.net.render(root2); } catch (e) { err2 = e; }
  ok(!err2, '鱼护面板带「点击监听桩」也能渲染', err2 && err2.message);

  const lists = [];
  const rows = [];
  (function walk(n) {
    if (!n || !n.children) return;
    if (n.className === 'net-list') lists.push(n);
    if (n.className === 'net-row') rows.push(n);
    n.children.forEach(walk);
  })(root2);
  /* 鱼护与水族箱的行都叫 net-row —— 只数第一块 net-list（鱼护在前面）里的 */
  const netRows = lists.length ? (() => {
    const out = [];
    (function w2(n) {
      if (!n || !n.children) return;
      if (n.className === 'net-row') out.push(n);
      n.children.forEach(w2);
    })(lists[0]);
    return out;
  })() : rows;
  ok(netRows.length === 2, '两格鱼护渲染出两行', '实际 ' + netRows.length + ' 行');

  const rowA = netRows.find((r) => {
    const info = r.children.find((c) => c.className === 'net-info');
    return info && info.innerHTML.indexOf(fa.name) >= 0;
  });
  ok(!!rowA, '能按名字找到要点的那一行');
  if (rowA) {
    const opsA = rowA.children.find((c) => c.className === 'net-ops');
    const sellA = opsA.children[0]._l[0];
    sellA();   // 第一次点：卖掉这一行自己的鱼
    ok(St.get().net.length === 1 && St.get().net[0].f === fb.id,
       '第一次点击卖掉的就是这一行的鱼');
    sellA();   // 同一窗口里再点同一行（DOM 尚未重建 = 旧下标已过期）
    ok(St.get().net.length === 1 && St.get().net[0].f === fb.id,
       '窗口期里的第二次点击不许落在别的鱼身上（下标现查 → 拒绝）',
       '鱼护现在剩 ' + JSON.stringify(St.get().net));
  }
  St.get().net = savedNet2;
  global.document = prevDoc;
  global.document.createElement = prevCreate;
  G.Audio = prevAudio;
})();

/* 还原环境，别影响后面的断言 */
St.get().net = savedNet; St.get().tank = savedTank;
G.FishArt = realFishArt;
G.Platform.canvas.create = realCanvasCreate;
if (realRAF === undefined) delete global.requestAnimationFrame; else global.requestAnimationFrame = realRAF;
if (realCAF === undefined) delete global.cancelAnimationFrame; else global.cancelAnimationFrame = realCAF;

/* =========================================================
   Panels · 底栏禁用态（`#app` 上的 `modal-open`）
   =========================================================
   口径（2026-10-08 用户拍板）：**面板打开时底栏不可点**。
   ⚠️ 而「不可点」原来只是遮罩几何 + z-index 的**巧合结果** —— 谁哪天改了 `.modal` 的
      `top` 或 `z-index`，底栏就会**静默变成可点**，而口径早就定了（这种失效不报错）。
      所以 panels.js 现在显式维护一个类，由 style.css 的 `#app.modal-open #deck` 画出来。
   这一节盯的是**最容易坏的那一半**：`close()` 必须把类摘干净 ——
   漏一次，底栏就永久压暗**且永久不可点**（玩家只能重开页面）。
   （真正的压暗与命中测试在浏览器里做，见 `docs/每小时优化轮次规范.md` §6「收尾」；
     Node 里只验「类名的挂 / 摘是对称的」。）
   ========================================================= */
G_('Panels · 底栏禁用态的类名挂载与摘除');
(function () {
  const mkCls = set => ({
    add: c => set.add(c),
    remove: c => set.delete(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
    contains: c => set.has(c),
  });
  const node = (tag, set) => { const e = mkEl(tag); if (set) e.classList = mkCls(set); return e; };

  const appSet = new Set(), modalSet = new Set(['hidden']);
  const els = {
    '#app': node('div', appSet), '#modal': node('div', modalSet),
    '#modalTitle': node('div'), '#modalBody': node('div'), '#modalClose': node('button'),
    '#catchCard': node('div'), '#catchCanvas': node('canvas'),
  };
  const realDoc = global.document;
  global.document = {
    createElement: mkEl, querySelector: s => els[s] || null, querySelectorAll: () => [],
    addEventListener() {},
  };

  Panels.init();
  ok(appSet.size === 0 && modalSet.has('hidden'),
     '初始态：弹层隐藏、`#app` 上没有任何类（底栏正常可用）');

  Panels.open('offline');
  ok(!modalSet.has('hidden') && appSet.has('modal-open'),
     'open() 显示弹层并给 #app 挂上 modal-open（底栏进入禁用态）');

  Panels.close();
  ok(modalSet.has('hidden') && !appSet.has('modal-open'),
     'close() 摘掉 modal-open（底栏恢复）—— 漏一次底栏就永久压暗且不可点');

  for (let i = 0; i < 3; i++) { Panels.open('offline'); Panels.close(); }
  ok(appSet.size === 0, '连开连关 3 次后 #app 的类名集合为空（不许残留状态）',
     Array.from(appSet).join(','));

  let closeThrew = '';
  try { Panels.close(); } catch (e) { closeThrew = e.message; }
  ok(!closeThrew && !appSet.has('modal-open'), '没开面板时调 close() 不抛、也不留残影', closeThrew);

  global.document = realDoc;
})();

/* =========================================================
   Panels · 设置键必须能从界面改（真渲染 + 真触发注册上来的回调）
   =========================================================
   由来（2026-10-08，Q26）：`state.js` 的 `blank().settings` 是设置键的唯一真相，
   新增一个键却忘了在设置面板补一行时，界面上永远看不见 —— **不报错、不告警**。
   verify `[32-h]` 用静态扫描盯「键有没有出现在设置面板那一段里」；
   这一节盯**它盯不到的那一半**：控件画出来了、**却写不回去**
   （例如只调了 `G.Audio.setEnabled(v)`、忘了 `s.settings.<键> = v`）——
   这种坏法两边自洽，源码扫描看不出任何异常。
   做法：造一个「会记录监听器」的 DOM 桩 → 真渲染一次设置面板 →
   逐个触发注册上来的回调 → 看**哪个设置键真的变了**（对照触发前后各拍一份快照）。
   ⚠️ 面板里还有「重置 / 导出 / 导入」三个危险按钮，所以先把它们的
      `dialog.confirm` / `dialog.prompt` / `clipboard.write` 换成无害桩，
      再统一触发 —— 否则一次「重置」就把整轮测试的存档清了。
   ========================================================= */
G_('Panels · 设置键必须能从界面改（真渲染 + 真触发注册的回调）');
(function () {
  const handlers = [];
  function mkNode(tag) {
    const n = {
      tagName: tag, className: '', innerHTML: '', textContent: '', value: '', checked: false,
      children: [], style: {}, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { n.children.push(c); return c; },
      removeChild(c) { n.children = n.children.filter(x => x !== c); return c; },
      insertBefore(c) { n.children.unshift(c); return c; },
      get lastChild() { return n.children[n.children.length - 1] || null; },
      /* 关键：把监听器记下来，后面逐个触发（这是本节唯一比源码扫描强的地方） */
      addEventListener(type, fn) { handlers.push({ type: type, fn: fn }); },
      setAttribute() {}, getAttribute() { return null; },
      querySelector() { return mkNode('span'); },
      querySelectorAll() { return []; },
      getContext() { return null; },
    };
    return n;
  }
  const els = {};
  ['#modal', '#app', '#modalTitle', '#modalBody', '#modalClose',
   '#catchCard', '#catchCanvas', '#chkIdle'].forEach(s => { els[s] = mkNode('div'); });
  const realDoc = global.document;
  global.document = {
    createElement: mkNode,
    querySelector: s => els[s] || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const realDialog = G.Platform.dialog, realClip = G.Platform.clipboard;
  G.Platform.dialog = { confirm: () => false, prompt: () => null, alert() {} };
  /* 剪贴板那条路是异步回调（只发一条 toast，与设置键无关）——
     用一个「then 空转」的 thenable 把它挂住，免得它的回调在本节收尾之后才跑。 */
  G.Platform.clipboard = { write: () => ({ then() {} }), read: () => ({ then() {} }) };

  Panels.init();
  handlers.length = 0;            // init 挂的（关闭按钮 / 遮罩）不参与
  let openErr = null;
  try { Panels.open('settings'); } catch (e) { openErr = e; }
  ok(!openErr, 'VIEWS.settings.render 能在 Node 里真跑完（不依赖浏览器专有 API）', openErr && openErr.message);
  ok(handlers.length > 0,
     `设置面板渲染时注册了 ${handlers.length} 个控件回调（桩把每个 addEventListener 都记下来了）`);

  const keys = Object.keys(St.get().settings);
  const before = JSON.parse(JSON.stringify(St.get().settings));
  const writable = {}, threw = [];
  handlers.slice().forEach(h => {
    const was = JSON.parse(JSON.stringify(St.get().settings));
    try { h.fn({ target: { value: '37' }, key: '', preventDefault() {} }); }
    catch (e) { threw.push(e.message); return; }
    const now = JSON.parse(JSON.stringify(St.get().settings));
    keys.forEach(k => { if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) writable[k] = true; });
  });
  ok(threw.length === 0,
     '逐个触发设置面板的控件都不抛错（含重置 / 导出 / 导入三个危险按钮，它们的对话框已被换成无害桩）',
     threw.join(' / '));

  /* ---- ② 语音音色下拉：存档里的音色**不在这台设备上**时要如实说（队列 Q41）----
     背景：`settings.voice` 存的是**这台机器**的 `voiceURI`，换台电脑就匹配不到。
     原来的表现是**界面与数据分家**：没有任何 option 带 `selected` ⇒ 下拉显示成第一项
     「系统默认」，而存档里那个 id 还留着 —— 玩家看到的是一个、存档里是另一个，谁也不报错。
     三条边界：① 不在列表里 ⇒ 有 selected 的占位项 + 警示文案；
              ② 在列表里 ⇒ 那个选项 selected、**没有**警示文案；
              ③ 列表还没拿到（`getVoices()` 第一次返回空）⇒ **不**警示（那是异步加载中，
                 不是「这台设备没有」—— 报错了玩家会去删一个其实还能用的音色）。 */
  const realSpeech = G.Platform.speech;
  const fetchVoiceRow = (voiceId, list) => {
    G.Platform.speech = {
      available: () => true, list: () => list, onVoices() {},
      speak: () => true, stop() {},
    };
    St.get().settings.voice = voiceId;
    els['#modalBody'].children.length = 0;      // 桩不清 innerHTML，得手动清一遍再重画
    Panels.open('settings');
    const r = els['#modalBody'].children.filter(x =>
      x.children[0] && String(x.children[0].innerHTML).indexOf('id="setVoice"') >= 0)[0];
    return r ? { desc: String(r.innerHTML || ''), ctl: String(r.children[0].innerHTML) } : null;
  };
  const HERELIST = [{ id: 'voice-here', name: '本机音色', lang: 'zh-CN' }];
  const gone = fetchVoiceRow('gone-machine-id', HERELIST);
  ok(!!gone, '设置面板里画出了语音音色下拉（能找到带 id="setVoice" 的那一行）');
  ok(gone && gone.ctl.indexOf('value="gone-machine-id" selected') >= 0,
     '存档里的音色不在这台设备上 ⇒ 下拉里插一条 **selected** 的占位项（不再假装成「系统默认」）');
  ok(gone && gone.desc.indexOf('这台设备上没有') >= 0,
     '……并且那一行的说明文字如实写出「上次选的音色在这台设备上没有」');
  const here = fetchVoiceRow('voice-here', HERELIST);
  ok(here && here.ctl.indexOf('value="voice-here" selected') >= 0 && here.desc.indexOf('这台设备上没有') < 0,
     '音色就在这台设备上 ⇒ 正常选中那一项，不出现任何警示文案');
  const pending = fetchVoiceRow('gone-machine-id', []);
  ok(pending && pending.desc.indexOf('这台设备上没有') < 0,
     '声音列表还没拿到（`getVoices()` 第一次返回空）⇒ **不**警示：那是异步加载中，不是「没有」');
  G.Platform.speech = realSpeech;

  /* 还原成触发前的值 —— 后面还有一大堆断言在用同一份存档 */
  keys.forEach(k => { St.get().settings[k] = before[k]; });
  Panels.close();
  global.document = realDoc;
  G.Platform.dialog = realDialog;
  G.Platform.clipboard = realClip;

  const missing = keys.filter(k => !writable[k]);
  ok(missing.length === 0,
     `设置面板的控件真的能改每一个设置键：${keys.length} 个键逐个触发后都变了`
     + (missing.length ? '' : `（${keys.join(' / ')}）`),
     '改不动：' + missing.join('、'));
})();

/* =========================================================
   Hud —— 拉扯提示的四个分支，以及阈值必须来自 config
   ========================================================= */
new Function(fs.readFileSync(path.join(ROOT, 'src/ui/hud.js'), 'utf8')).call(global);
const Hud = global.G.Hud;

G_('Hud · 拉扯提示文案');
ok(!!(Hud && typeof Hud.fightTip === 'function'), 'hud.js 能在 Node 里加载并导出 fightTip');
if (Hud && Hud.fightTip) {
  /* 按「有 bug 时会不会报红」设计：warn 取 0.75（离写死的 0.4 很远），
     若有人把阈值重新写死成 0.4，下面两条 config 驱动的断言必红。 */
  const FT_WARN = 0.75;
  const withThr = (thr, s) => {
    const old = CFG.fight.warnTipAt;
    CFG.fight.warnTipAt = thr;
    try { return Hud.fightTip(s); } finally { CFG.fight.warnTipAt = old; }
  };
  const sBase = { warn: FT_WARN, dashing: false, danger: false };
  ok(withThr(FT_WARN - 0.1, sBase).indexOf('要逃窜了') >= 0,
     `warn ${FT_WARN} > 阈值 ${FT_WARN - 0.1} → 提示「要逃窜了」（阈值真的来自 config）`);
  ok(withThr(FT_WARN + 0.1, sBase).indexOf('要逃窜了') < 0,
     `warn ${FT_WARN} < 阈值 ${FT_WARN + 0.1} → 不再提示逃跑（阈值抬高即延后提示）`);
  /* 另外三个分支也要真能走到 —— 之前只扫源码，看不出分支被遮挡 */
  ok(Hud.fightTip({ warn: 1, dashing: true, danger: true }).indexOf('鱼在发力') >= 0,
     '逃窜中优先级最高（即使同时满足预警与危险）');
  ok(Hud.fightTip({ warn: 0, dashing: false, danger: true }).indexOf('张力偏高') >= 0,
     '没到预警但张力偏高 → 提示「张力偏高」');
  ok(Hud.fightTip({ warn: 0, dashing: false, danger: false }).indexOf('收线') >= 0,
     '常态下提示收线操作');
  ok(Hud.fightTip(null) === '', 'snapshot 缺失时不抛错、返回空串');
  /* 阈值可达性的**行为**侧：warn 由 fight.js 现算，取满 [0, 1] 时两个分支都能出现 */
  const wLo = 1 - Math.max(0, 0) / CFG.fight.dashWarnLead;
  const wHi = 1 - Math.max(0, CFG.fight.dashWarnLead) / CFG.fight.dashWarnLead;
  ok(wLo === 1 && wHi === 0, `fight.js 的 warn 取值区间是 [${wHi}, ${wLo}]，阈值 ${CFG.fight.warnTipAt} 落在区间内`);
}

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
   Audio —— 环境音的**循环采样通道**（2026-10-09，队列 Q20 剩余那半件）
   ⚠️ 判据刻意不是「有没有调用 G.Assets」——那是实现细节；
      这里要钉的是行为：**采样就绪后真的接管、并且接缝被处理过**。
      素材用一段「1.0s 有信号 + 0.2s 数字静音」的合成 buffer，
      复刻真实素材那个毛病（本地出的那一段结尾有 1.4 秒静音）。
   ========================================================= */
G_('Audio · 环境音的循环采样通道');
(function () {
  const SR = 8000, ALIVE = Math.floor(SR * 1.0), LEN = Math.floor(SR * 1.2);
  const made = { osc: [], src: [], gain: [] };
  const param = () => ({
    value: 0,
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  });
  const mkNode = () => ({ _dis: false, connect() {}, disconnect() { this._dis = true; } });
  const fakeCtx = {
    sampleRate: SR, currentTime: 10, state: 'running',
    destination: mkNode(),
    resume() {},
    createGain() { const g = mkNode(); g.gain = param(); made.gain.push(g); return g; },
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() {
      const s = mkNode();
      s.start = () => { s._started = true; }; s.stop = () => { s._stopped = true; };
      made.src.push(s); return s;
    },
    createBiquadFilter() { const f = mkNode(); f.frequency = { value: 0 }; f.Q = { value: 0 }; return f; },
    createOscillator() {
      const o = mkNode(); o.frequency = { value: 0 };
      o.start = () => { o._started = true; }; o.stop = () => { o._stopped = true; };
      made.osc.push(o); return o;
    },
  };
  const data = new Float32Array(LEN);
  let sd = 12345;
  for (let i = 0; i < ALIVE; i++) {
    sd = (sd * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (sd / 0x7fffffff * 2 - 1) * 0.3;      // 有信号段（后 0.2s 保持全 0 = 静音）
  }
  const head0 = data[0];                            // 淡化前的首样本
  const tail0 = data[ALIVE - Math.floor(SR * 0.125)];// 淡化后「应当被搬到开头」的那个样本
  const buf = { sampleRate: SR, length: LEN, duration: LEN / SR, getChannelData: () => data };

  let feed = null;
  const realCreate = G.Platform.audio.createContext;
  const realSfx = G.Assets.sfx;
  const realTimeout = global.setTimeout;
  const timers = [];
  global.setTimeout = fn => { timers.push(fn); return 0; };   // 不许留真定时器（会挂住进程）
  G.Platform.audio.createContext = () => fakeCtx;
  G.Assets.sfx = () => ({ then(res) { feed = res; } });
  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const A = G.Audio;

  A.setEnabled(true);
  A.startAmbience();
  ok(made.src.length === 1 && made.osc.length === 1,
     '采样还没回来时先出合成音（未就绪 ≠ 静音）');

  feed(buf);                                         // 采样到位 → 热切换
  ok(made.src.length === 2 && made.src[1]._started === true,
     '采样到位就热切换（新起一个采样源），不是等下一次 startAmbience');
  ok(made.osc[0]._stopped === true,
     '热切换时旧的 LFO 立刻停（它连在旧 gain 上，留着淡不干净）');
  timers.forEach(fn => fn());                        // 交叉淡化结束后收旧节点
  ok(made.src[0]._stopped === true && made.gain.some(g => g._dis),
     '淡出结束后旧的缓冲源与 gain 都收掉（不在后台留节点）');

  const s2 = made.src[1];
  ok(s2.loop === true && Math.abs(s2.loopEnd - 0.875) < 1e-6,
     `循环终点 = 有信号段末尾再减去 0.125s 淡化（loopEnd=${s2.loopEnd.toFixed(3)}s，应当 0.875s）`);
  ok(s2.loopEnd < 1.0, '循环终点落在数字静音段之前（否则每圈都要静 0.2 秒）');
  ok(Math.abs(data[0] - tail0) < 1e-6 && data[0] !== head0,
     '接缝做过交叉淡化：新首样本 = 尾段对应样本（不是原首样本）');

  A.stopAmbience();
  ok(made.src[1]._stopped === true && made.gain.filter(g => g._dis).length >= 2,
     'stopAmbience 把采样那一套也收干净（两条路同一套收法）');

  G.Platform.audio.createContext = realCreate;
  G.Assets.sfx = realSfx;
  global.setTimeout = realTimeout;
  G.Audio = audioStub;
})();

/* =========================================================
   Audio —— 背景音乐：lookahead 调度 + 收声 + 「意图位」
   ⚠️ 这一节额外把 `setInterval` / `setTimeout` 换成**只记录、不真跑**的版本：
     调度器要能手动推着走（时序可控），而且测试跑完不许留下真定时器
     —— 留一个 `setInterval` 会让 Node 永远不退出，CI 直接挂住。
   ========================================================= */
G_('Audio · 背景音乐的调度与收声');
(function () {
  const made = { osc: [], gain: [] };
  /* 参数对象要把**排进去的值**记下来：不然「大调三度 / 小调三度」这种断言无从下手 */
  const param = () => {
    const o = { value: 0, calls: [] };
    o.setValueAtTime = v => { o.calls.push(v); o.value = v; return o; };
    ['exponentialRampToValueAtTime', 'linearRampToValueAtTime', 'cancelScheduledValues']
      .forEach(k => { o[k] = () => o; });
    return o;
  };
  const mkNode = () => ({ _dis: false, connect() {}, disconnect() { this._dis = true; } });
  let T = 100;                                   // 假音频时钟
  const fakeCtx = {
    sampleRate: 48000, state: 'running',
    get currentTime() { return T; },
    destination: mkNode(),
    resume() {},
    createGain() { const g = mkNode(); g.gain = param(); made.gain.push(g); return g; },
    createOscillator() {
      const o = mkNode();
      o.type = ''; o.frequency = param();
      o.start = () => { o._started = true; }; o.stop = () => { o._stopped = true; };
      made.osc.push(o);
      return o;
    },
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() { const s = mkNode(); s.start = () => {}; s.stop = () => {}; return s; },
    createBiquadFilter() { const f = mkNode(); f.frequency = param(); f.Q = param(); return f; },
  };

  const realCreate = G.Platform.audio.createContext;
  G.Platform.audio.createContext = () => fakeCtx;
  const realSI = global.setInterval, realCI = global.clearInterval, realST = global.setTimeout;
  const ticks = [], waits = [];
  global.setInterval = (fn, ms) => { const h = { fn, ms }; ticks.push(h); return h; };
  global.clearInterval = h => { if (h && ticks.indexOf(h) >= 0 && !h.dead) { h.dead = true; } };
  global.setTimeout = (fn, ms) => { const h = { fn, ms }; waits.push(h); return h; };

  const restore = () => {
    global.setInterval = realSI; global.clearInterval = realCI; global.setTimeout = realST;
    G.Platform.audio.createContext = realCreate;
    A.stopBgm(); A.setEnabled(false);
    G.Audio = audioStub;
  };

  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const A = G.Audio;
  const liveTicks = () => ticks.filter(t => !t.dead);
  const pump = () => liveTicks().forEach(t => t.fn());       // 「定时器醒了」
  const MAJ = { root: 261.63, mode: 'major', chords: [1, 6, 4, 5], bar: 3.6 };
  /* ⚠️ 换曲这条用**只有一个和弦**的 spec：`bgmIdx` 是延续的（换曲不重启调度器），
     所以下一小节轮到哪个级数是不确定的。单和弦才能把「新 root / 新模式」钉死断言。 */
  const MIN = { root: 220.00, mode: 'minor', chords: [1], bar: 3.8 };

  /* ---------- ① 起播：立刻排一小节，且排的是「三件东西」 ---------- */
  A.setEnabled(true);
  A.startBgm(MAJ);
  ok(made.osc.length >= 6 && made.osc.length <= 7,
     `startBgm 立刻排出 1 小节（${made.osc.length} 个音：1 低音 + 3 和弦 + 2~3 铃音），不等第一次定时器`);
  ok(made.osc.every(o => o._started === true), '排进去的音都 start 了');
  ok(ticks.length === 1 && ticks[0].ms <= 500,
     `只建了 1 个定时器，间隔 ${ticks[0] && ticks[0].ms}ms —— lookahead 的「醒来」节奏必须远短于一小节（${MAJ.bar}s）`);

  /* ---------- ② 调性真的按 mode 算：大调放的是大三度 ---------- */
  const bar1 = made.osc.map(o => o.frequency.calls[0]).filter(f => f > 0);
  const padRoot = MAJ.root / 2;                       // 和弦垫在主音下一个八度
  const major3 = padRoot * Math.pow(2, 4 / 12);
  const minor3 = padRoot * Math.pow(2, 3 / 12);
  const has = f => bar1.some(v => Math.abs(v - f) < 0.01);
  ok(Math.abs(Math.min.apply(null, bar1) - MAJ.root / 4) < 0.01,
     `最低音是主音的 1/4（低音声部 = ${(MAJ.root / 4).toFixed(1)}Hz）`);
  ok(has(padRoot) && has(major3) && !has(minor3),
     `大调的和弦垫放的是**大三度**（${major3.toFixed(1)}Hz），不是小三度（${minor3.toFixed(1)}Hz）`);

  /* ---------- ③ 时钟跳一大截：只重新对齐，绝不把欠的小节补上 ---------- */
  const n0 = made.osc.length;
  T += 100;                                           // 模拟标签页被系统挂起
  pump();
  const caught = made.osc.length - n0;
  ok(caught >= 6 && caught < 20,
     `时钟跳 100 秒后只重排 1 小节（${caught} 个音）；真去「补课」会一次排 ${Math.round(100 / MAJ.bar)} 小节、几百个节点`);

  /* ---------- ④ 换钓场：只换参数，不重启调度器 ---------- */
  const g0 = made.gain.length;
  A.startBgm(MIN);
  ok(made.gain.length === g0 && liveTicks().length === 1,
     '换曲不重建节点、不重建定时器（切钓场时音乐接着走，不从头来一遍）');
  const m0 = made.osc.length;
  T += MIN.bar; pump();
  const barN = made.osc.slice(m0).map(o => o.frequency.calls[0]).filter(f => f > 0);
  const mPadRoot = MIN.root / 2, mPad3 = mPadRoot * Math.pow(2, 3 / 12);
  const hasN = f => barN.some(v => Math.abs(v - f) < 0.01);
  ok(hasN(MIN.root / 4) && !hasN(MAJ.root / 4),
     `换成新 root（低音 ${(MIN.root / 4).toFixed(1)}Hz 在、旧 root 的低音 ${(MAJ.root / 4).toFixed(1)}Hz 没了）`);
  ok(hasN(mPadRoot) && hasN(mPad3) && !hasN(mPadRoot * Math.pow(2, 4 / 12)),
     `换成小调（和弦垫 ${mPadRoot.toFixed(1)}Hz 上叠的是小三度 ${mPad3.toFixed(1)}Hz，不是大三度）`);

  /* ---------- ⑤ 收声：定时器清掉、总线淡出后断开、不再排音 ---------- */
  A.stopBgm();
  ok(liveTicks().length === 0, 'stopBgm 清掉了定时器（留着它 Node 进程会永远不退出）');
  ok(waits.length === 1 && waits[0].ms <= 300,
     `收声是一次「淡出后断开」（${waits[0] && waits[0].ms}ms），不是硬切 —— 硬切会「啪」一声`);
  waits.forEach(w => w.fn());
  ok(made.gain.some(g => g._dis), '淡出结束后 bgmBus 被 disconnect（不留在音乐总线上）');
  const n1 = made.osc.length;
  T += 40; pump();
  ok(made.osc.length === n1, 'stopBgm 之后不再排任何音');

  /* ---------- ⑥ 意图位：总开关关掉再开，音乐要自己回来 ---------- */
  A.startBgm(MAJ);
  A.setEnabled(false);
  const n2 = made.osc.length;
  T += 40; pump();
  ok(made.osc.length === n2, 'setEnabled(false) 之后不再排音（音乐与环境音一起收）');
  A.setEnabled(true);
  T += 1; pump();
  ok(made.osc.length > n2, 'setEnabled(true) 音乐自己回来了 —— 意图位没被 setEnabled 清掉');

  /* ---------- ⑦ 但 stopBgm 是「用户不想听了」，不许被 setEnabled 偷偷恢复 ---------- */
  A.stopBgm();
  A.setEnabled(false); A.setEnabled(true);
  const n3 = made.osc.length;
  T += 40; pump();
  ok(made.osc.length === n3, 'stopBgm 之后 setEnabled(true) 不会偷偷把音乐放回来');

  /* ---------- ⑧ 没参数 / 没上下文时不许抛 ---------- */
  let threw = '';
  try { A.startBgm(); A.startBgm({}); A.startBgm({ chords: [] }); A.stopBgm(); }
  catch (e) { threw = e.message; }
  ok(!threw, 'startBgm 传空参数 / 空和弦表时不抛（设置面板恢复播放会走这条路）', threw);

  restore();
})();

/* =========================================================
   Audio —— 音乐音量：只动音乐子总线一个节点（Q1）
   ⚠️ **必须新加载一份 audio.js**，不能挂在上面那节后面：那一节跑到末尾时
     AudioContext 早建好了，`ensure()` 一进来就短路返回 ——
     「建总线时读不读 volBgm」这条路径**根本没被走到**。
     （实测：第一版把 `ensure()` 改回写死 `1.00`，断言照样全绿 —— 假通过。
      这正是本项目反复吃的「看起来对」的亏，所以这条证据单独放在这里。）
   ========================================================= */
G_('Audio · 音乐音量（只作用在音乐子总线）');
(function () {
  const made = { gain: [] };
  const param = () => {
    const o = { value: 0 };
    o.setValueAtTime = v => { o.value = v; return o; };
    ['exponentialRampToValueAtTime', 'linearRampToValueAtTime', 'cancelScheduledValues']
      .forEach(k => { o[k] = () => o; });
    return o;
  };
  const mkNode = () => ({ _dis: false, connect() {}, disconnect() { this._dis = true; } });
  const fakeCtx = {
    sampleRate: 48000, state: 'running', get currentTime() { return 10; },
    destination: mkNode(), resume() {},
    createGain() { const g = mkNode(); g.gain = param(); made.gain.push(g); return g; },
    createOscillator() {
      const o = mkNode(); o.type = ''; o.frequency = param();
      o.start = () => {}; o.stop = () => {}; return o;
    },
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    createBufferSource() { const s = mkNode(); s.start = () => {}; s.stop = () => {}; return s; },
    createBiquadFilter() { const f = mkNode(); f.frequency = param(); f.Q = param(); return f; },
  };
  const realCreate = G.Platform.audio.createContext;
  G.Platform.audio.createContext = () => fakeCtx;
  /* 调度器只留个句柄、不真跑（留真 `setInterval` 会让 Node 永远不退出） */
  const realSI = global.setInterval, realCI = global.clearInterval;
  global.setInterval = () => ({ ms: 250 });
  global.clearInterval = () => {};

  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const A = G.Audio;

  /* **先设置、再起上下文** —— 就是「音频还没被首次手势激活时玩家先拖了滑块」那条路 */
  A.setMusicVolume(0.4);
  A.setEnabled(true);
  A.startBgm({ root: 261.63, mode: 'major', chords: [1, 6, 4, 5], bar: 3.6 });

  /* 前 4 个 gain 就是既定结构：master / busSfx / busAmb / busBgm。
     断言「值 0.4 落在第 4 条上」= 同时钉住「建总线时读到了这个值」与「它确实是音乐那条」。 */
  const musicBus = made.gain.filter(g => g.gain.value === 0.4)[0];
  ok(!!musicBus && made.gain.indexOf(musicBus) === 3,
     `setMusicVolume 在设置**早于**上下文建立时也不丢（0.4 落在第 4 条 gain = busBgm，`
     + `实得第 ${musicBus ? made.gain.indexOf(musicBus) : '—'} 条）；写死 1.00 会静默吃掉这个设置`);

  A.setMusicVolume(0.7);
  ok(musicBus.gain.value === 0.7,
     'setMusicVolume 改的是同一个节点（不是每次新建一条总线 —— 那样旧节点会继续响着）');
  ok(made.gain[1].gain.value === 1 && made.gain[2].gain.value === 1,
     '音效 / 环境音总线没被一起改（音乐音量不许顺手把水声调小）');

  A.setMusicVolume(5);
  ok(musicBus.gain.value === 1, `setMusicVolume 越界值夹到 0~1（实得 ${musicBus.gain.value}）`);
  A.setMusicVolume(-1);
  ok(musicBus.gain.value === 0, `setMusicVolume 负值夹到 0（实得 ${musicBus.gain.value}）`);

  /* 总开关关着时也**必须记下**这个值：`setVolume` 一直是这么做的（它在 `NO_SAMPLE` 里），
     音乐音量得同款 —— 否则关着音效拖滑块，开回来时滑块显示 30% 而实际还在放 100%。
     这一条同时是 `NO_SAMPLE` 少写一个名字的哨兵。 */
  A.setMusicVolume(0.3);
  A.setEnabled(false);
  A.setMusicVolume(0.8);
  ok(musicBus.gain.value === 0.8,
     '音效总开关关着时调音乐音量同样生效（采样层不许把它当音效包一层，见 NO_SAMPLE）');
  A.setEnabled(true);

  A.stopBgm(); A.setEnabled(false);
  global.setInterval = realSI; global.clearInterval = realCI;
  G.Platform.audio.createContext = realCreate;
  G.Audio = audioStub;
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
   颜色变异 → 材质参数（FishPaint）
   ⚠️ 2026-10-08：程序化 3D 已整体撤销（用户口径「之前的方式生成 3D 基本不可行，
   太粗糙了」）→ `mesh3d.js` / `fishmesh.js` 两个模块与它们的断言块一并删除。
   **FishPaint 保留**：它有独立于 3D 的消费方 ——
     · `tools/paint-card.py` 靠 `node -e` 调 `palette()` 取 5 档颜色，
       它是**颜色口径的唯一来源**（同口径写两遍必然分家）
     · `rim` / `rimK` / `metallic` / `sparkle` 仍是卡面 5 档视觉跃迁的设计口径
   规格：`docs/画风与颜色标准.md` §3「亮色改彩虹带来的连锁」
   ========================================================= */
(function () {
G_('FishPaint —— 颜色变异 → 材质参数');
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
})();

/* =========================================================
   Weather —— 游戏内时钟的偏移必须来自 config
   踩过的（2026-10-07 自动化发现）：`CLOCK_OFFSET_H = 4` 与 24 小时换算被写死在
   weather.js 模块里，而 dayLen / times 这些同族常量都在 config。
   这条断言把四个时段的钟点与 `config.weather.clockOffsetH` 绑在一起 ——
   偏移一旦被丢掉（或又写死回模块里）：「晨」会从 04:00 掉回 00:00，立刻报红。
   ========================================================= */
G_('Weather · 游戏内时钟的偏移读自 config');
(function () {
  const W = G.CONFIG.weather;
  if (!G.Weather.isReady()) G.Weather.init(0);
  const prev = G.Weather.snapshot();

  W.times.forEach((t, i) => {
    G.Weather.set(prev.wx.key, t.key);
    const hour = Math.floor(((i / W.times.length) * 24 + W.clockOffsetH) % 24);
    const exp = (hour < 10 ? '0' : '') + hour + ':00';
    ok(G.Weather.snapshot().clock === exp,
       `${t.name}（第 ${i} 段）钟点 = ${exp} —— tClock 起点 + config.weather.clockOffsetH=${W.clockOffsetH}`);
  });

  /* 复位：把时段放回原样（`set` 会把 tClock 对齐到该时段的起点，天气本身不变） */
  G.Weather.set(prev.wx.key, prev.tm.key);
})();

/* =========================================================
   Weather —— 同一帧里的「换天 + 跨时段」只播报一次
   天气到期（left ≤ 0）与游戏内时钟跨过时段边界可能落在同一个 update(dt) 里；
   原来各自 emit，订阅方一帧连收两次快照：顶栏芯片重写两遍、
   BGM 参数也连换两遍（第二次才是最终态）。用固定随机种子把
   「天气时长」钉在最小值上，就能确定性造出同帧双变。
   ========================================================= */
G_('Weather · 同帧双变只播报一次');
(function () {
  const rnd = Math.random;
  Math.random = () => 0;                       // rollWeather 挑第一个 / U.range 取下界 → left = minDur
  const prevSnap = G.Weather.snapshot();
  let n = 0;
  const fn = () => { n++; };
  G.Weather.on(fn);
  try {
    G.Weather.init(0);                         // tClock = 0 → 第 0 段（晨）
    n = 0;
    G.Weather.update(119);                     // left: 180 → 61（还不换）
    ok(n === 0, '未到期且未跨时段时不播报', '实际播报 ' + n + ' 次');
    G.Weather.update(181);                     // tClock 恰好跨过 300s 边界，left 同时到期
    ok(n === 1, '同一帧里「换天 + 跨时段」合并成一次播报', '实际播报 ' + n + ' 次');
  } finally {
    Math.random = rnd;
    /* 复位条件（监听函数是纯计数、留着无害；on 没有退订接口） */
    G.Weather.set(prevSnap.wx.key, prevSnap.tm.key);
  }
})();

/* =========================================================
   Weather —— 背景音乐随「时段 / 天气」换参数（队列 Q2）
   口径：钓场主题的 `theme.bgm` 是 **base**；`config.weather.times[].bgm` /
   `types[].bgm` 是那个条件的**修饰量**；`G.Weather.bgmSpec(base)` 是唯一合成点。
   这一节钉住四件容易静默失效的事：
     ① **基准态（昼 + 晴）必须恒等** —— 否则「钓场原曲」这个基线口径就悄悄漂了，
        而且没有任何报错（玩家只会觉得音乐怎么变了）；
     ② **只认 major / minor** —— `deg2freq` 写的是 `SCALES[spec.mode] || SCALES.major`，
        调式名打错一个字母会**静默退回大调**（夜晚听不出是"没生效"还是"本来就该这样"）；
     ③ **不许就地改 base** —— base 是 `fields.js` 里的常量对象，就地改会把钓场数据污染掉；
     ④ **有效 bar 必须落在人耳舒服的区间** —— 倍率相乘跑飞（比如 0.2 秒一小节）不报错。
   ⚠️ 这里用**真实钓场**的 base（不自造假对象）：假对象永远发现不了
      「fields.js 里 mode 打错字」这类问题，而那恰恰是要防的。
   ========================================================= */
G_('Weather · 背景音乐随条件换参数（修饰量单一来源）');
(function () {
  const W = G.CONFIG.weather;
  if (!G.Weather.isReady()) G.Weather.init(0);
  const snapshotBefore = G.Weather.snapshot();

  const baseD = G.FIELD_MAP.D.theme.bgm;     // 大调钓场
  const baseS = G.FIELD_MAP.S.theme.bgm;     // 本来就写小调的钓场
  const beforeD = { mode: baseD.mode, bar: baseD.bar, root: baseD.root };
  /* 所有条件 key 由数据自己列（不写死 'night' / 'rain' —— 加一个时段不用回来改这里） */
  const wxKeys = W.types.map(t => t.key);
  const tmKeys = W.times.map(t => t.key);
  const wxName = k => (W.types.filter(t => t.key === k)[0] || {}).name;
  const tmName = k => (W.times.filter(t => t.key === k)[0] || {}).name;
  const specAt = (wx, tm, base) => { G.Weather.set(wx, tm); return G.Weather.bgmSpec(base); };

  /* ---------- ① 域：调式只有两个合法值，bar 是有限正数 ---------- */
  let badMode = [], badBar = [];
  wxKeys.forEach(w => tmKeys.forEach(t => {
    [baseD, baseS].forEach(b => {
      const s = specAt(w, t, b);
      if (s.mode !== 'major' && s.mode !== 'minor') badMode.push(`${w}/${t}=${s.mode}`);
      if (!(isFinite(s.bar) && s.bar > 0.5 && s.bar < 12)) badBar.push(`${w}/${t}=${s.bar}`);
    });
  }));
  ok(badMode.length === 0,
     `所有 天气×时段 组合的调式都是 major / minor（${wxKeys.length}×${tmKeys.length}×2 个钓场）`,
     badMode.join('、'));
  ok(badBar.length === 0,
     `所有组合的有效 bar 都落在 (0.5, 12) 秒内（跑出这个区间就是倍率相乘飞了）`,
     badBar.join('、'));

  /* ---------- ② 基准态恒等：昼 + 晴 = 钓场原曲 ---------- */
  const idD = specAt('clear', 'day', baseD);
  ok(idD.mode === beforeD.mode && idD.bar === beforeD.bar && idD.root === beforeD.root,
     `基准态（${wxName('clear')} + ${tmName('day')}）与钓场原曲逐字段相同 —— 基线口径不漂`);

  /* ---------- ③ 夜：大调钓场转小调、速度放慢 ---------- */
  const nightD = specAt('clear', 'night', baseD);
  ok(nightD.mode === 'minor',
     `夜里大调钓场转小调（${beforeD.mode} → ${nightD.mode}）`);
  ok(nightD.bar > beforeD.bar,
     `夜的 bar 比基准慢（${beforeD.bar} → ${nightD.bar.toFixed(2)}s）`);

  /* ---------- ④ 本来就写小调的钓场：调式不动，但速度照样变 ---------- */
  const baseSBefore = { mode: baseS.mode, bar: baseS.bar };
  const nightS = specAt('clear', 'night', baseS);
  ok(nightS.mode === baseSBefore.mode,
     `小调钓场夜里仍是小调（${nightS.mode}）—— 「转小调」是相对 base 的，不是硬写 minor`);
  ok(nightS.bar > baseSBefore.bar,
     `小调钓场夜间辨识度来自速度（${baseSBefore.bar} → ${nightS.bar.toFixed(2)}s）`);

  /* ---------- ⑤ 晨：比基准快 ---------- */
  const dawnD = specAt('clear', 'dawn', baseD);
  ok(dawnD.bar < beforeD.bar,
     `${tmName('dawn')}的 bar 比基准快（${beforeD.bar} → ${dawnD.bar.toFixed(2)}s）`);

  /* ---------- ⑥ 天气只改速度，不许动调式 ---------- */
  const rainD = specAt('rain', 'day', baseD);
  ok(rainD.mode === beforeD.mode && rainD.bar > beforeD.bar,
     `${wxName('rain')}白天：调式不变（${rainD.mode}）、速度放慢（→ ${rainD.bar.toFixed(2)}s）`
     + ' —— 天气每几分钟随机换一次，跟着换调式会像音乐在抽风');

  /* ---------- ⑦ 合成不许就地改 base（fields.js 的常量对象被污染了没人会知道） ---------- */
  ok(baseD.mode === beforeD.mode && baseD.bar === beforeD.bar && baseD.root === beforeD.root,
     'base 一个字段都没被就地改（换条件不该动钓场数据）');
  ok(specAt('fog', 'night', baseD).chords === baseD.chords,
     '有效 spec 的 chords 仍是 base 那个数组的引用（只读，没必要每换一次条件就复制一份）');

  /* ---------- ⑧ 空参数不抛（调用方拿不到钓场时会传 null） ---------- */
  let threw = '';
  try { if (G.Weather.bgmSpec(null) !== null) threw = 'null 应返回 null'; }
  catch (e) { threw = e.message; }
  ok(!threw, 'bgmSpec(null) 返回 null 且不抛（audio.js 那条「没参数静默返回」的口径）', threw);

  /* 复位：条件放回本节开始时那样（后面的用例还在用同一份 Weather 实例） */
  G.Weather.set(snapshotBefore.wx.key, snapshotBefore.tm.key);
})();

/* =========================================================
   Assets —— 素材表（外部素材的唯一取用口径）
   规格：docs/开发者文档.md §17.13「素材接入：G.Assets 素材表」
   ⚠️ 这里**只测「键 → 地址」这一段纯逻辑**。真正的图片加载是异步的，
      本文件是同步测试器（跑不了 promise），那一段在浏览器里实跑验证。
      但**风险最大的恰恰是这一段** —— 路径拼错 / 档位名打错 / 键认不出来，
      都是「不报错但拿到 404」的静默失效，所以必须在这儿钉住。
   ========================================================= */
G_('Assets —— 键 → 地址（纯逻辑）');
(function () {
  const A = G.Assets;

  ok(A.mode() === 'inline' || A.mode() === 'external',
     `mode()：只可能是 inline / external（Node 没有 location ⇒ 实得「${A.mode()}」）`);

  ok(A.resolve('fishcard:A01') === 'assets/cards/A01.png',
     'resolve()：原色卡 = <id>.png');
  ok(A.resolve('fishcard:A01:golden') === 'assets/cards/A01-golden.png',
     'resolve()：档位卡 = <id>-<档位>.png');

  /* 档位名必须来自 config.colorMorphs —— 写错要**直接拦掉**，而不是拼出一个不存在的路径。
     这是本模块最容易出的静默失效：拼错了不会报错，只会 404。 */
  ok(A.resolve('fishcard:A01:noSuchMorph') === null,
     'resolve()：不在 config.colorMorphs 里的档位 → null（拦掉拼错的路径）');
  CFG.colorMorphs.forEach(cm => ok(!!A.resolve('fishcard:A01:' + cm.key),
     `resolve()：档位「${cm.name}」（${cm.key}）认得`));

  ok(A.resolve('fishcard:') === null, 'resolve()：没有 id → null');
  ok(A.resolve('fishcard:A01:golden:extra') === null, 'resolve()：键段数过多 → null');
  ok(A.resolve('nope:A01') === null, 'resolve()：不认识的键前缀 → null');
  ok(A.resolve('') === null && A.resolve(null) === null && A.resolve(undefined) === null,
     'resolve()：空 / null / undefined 都不抛，返回 null');
  ok(A.resolve('fishcard:../etc/passwd') === null && A.resolve('fishcard:a/b') === null,
     'resolve()：id 里的路径字符被拦掉（只允许字母数字，不许穿目录）');

  ok(A.fishKey('A01') === 'fishcard:A01' && A.fishKey('A01', 'shiny') === 'fishcard:A01:shiny',
     'fishKey()：拼键口径与 resolve() 一致（不许两处各拼一套）');

  /* 上云：把前缀换掉即可，业务代码一行都不用改 */
  A.setBase('https://cdn.example.com/');
  ok(A.resolve('fishcard:A01') === 'https://cdn.example.com/assets/cards/A01.png',
     'setBase()：上云前缀生效（路径拼接只有这一处真相）');
  A.setBase('');
  ok(A.resolve('fishcard:A01') === 'assets/cards/A01.png', 'setBase(\'\')：还原回同目录');

  const u = A.used();
  ok(typeof u.ok === 'number' && typeof u.fail === 'number' && typeof u.cached === 'number',
     'used()：返回 { ok, fail, cached } 三个数（开发者面板读它显示家底）');
  ok(!!u.image && !!u.sfx &&
     u.ok === u.image.ok + u.sfx.ok && u.fail === u.image.fail + u.sfx.fail,
     'used()：图片与音效**分组记账**，总量由两组现算（不另存一份）');
  ok(A.reset() === undefined && A.used().ok === 0, 'reset()：清空统计（自测之间不许互相污染）');

  /* 分组家底的**行为**验证：手搓 thenable 把两组各落定一次。
     为什么必须有这一条 —— `file://` 形态下音效**必然**失败（fetch 被拦），
     两类共用一个 ok/fail 时，开发者面板那行永远显示「失败 1」，
     真正的卡面加载失败会被淹掉（做 N3-1 时当场误读成「卡面没加载上」）。 */
  (function () {
    const realImg = G.Platform.image, realAud = G.Platform.audio;
    const pend = [];
    G.Platform.image = { load: () => ({ then(res) { pend.push(res); } }) };
    G.Platform.audio = { load: () => ({ then(res) { pend.push(res); } }) };
    A.reset();
    A.card('A01', 'golden');   // 图片：稍后成功
    A.sfx('cast');             // 音效：稍后失败（file:// 下的常态）
    const z = A.used();
    ok(pend.length === 2 && z.ok === 0 && z.fail === 0,
       'used()：两组都还没落定时计数仍是 0（失败要在真拿到 null 时才记）');
    pend[0]({ width: 1 });
    pend[1](null);
    const g = A.used();
    ok(g.image.ok === 1 && g.image.fail === 0 && g.sfx.ok === 0 && g.sfx.fail === 1,
       `used()：图片成功 / 音效失败各记各的（实得 图片 ${g.image.ok}/${g.image.fail}`
       + ` · 音效 ${g.sfx.ok}/${g.sfx.fail}）`);
    ok(g.ok === 1 && g.fail === 1,
       'used()：总量是两组之和（1 ok + 1 fail），不是「某一类」的数');
    A.reset();
    G.Platform.image = realImg; G.Platform.audio = realAud;
  })();

  /* 音效键（2026-10-08 加）：与图片共用同一套 resolve，但音效名只许小写字母数字 */
  ok(A.resolve('sfx:cast') === 'assets/audio/cast.mp3',
     'resolve()：音效键 = assets/audio/<名>.mp3');
  ok(A.resolve('sfx:') === null && A.resolve('sfx:Cast') === null && A.resolve('sfx:has space') === null,
     'resolve()：音效名只许小写字母数字（空名 / 大写 / 空格都拦掉）');
  ok(A.resolve('sfx:a:b') === null, 'resolve()：音效键只有两段');
  A.setBase('https://cdn.example.com/');
  ok(A.resolve('sfx:cast') === 'https://cdn.example.com/assets/audio/cast.mp3',
     'setBase()：音效同样吃 CDN 前缀（路径真相仍只有一处）');
  A.setBase('');
})();

/* =========================================================
   CardArt —— 图鉴卡面的回退链（队列 N3-1）
   =========================================================
   本项目第一次把**异步**的东西接进**同步**绘制路径（画布是同步画的，图是异步来的）。
   最容易出的两种静默失效：
     ① 图没到 → 画布上一片空白（所以「拿不到图时先画程序化那张」必须有断言）；
     ② 图到了没人重画（所以「到了要回调」必须有断言）。
   ⚠️ 真正的网络行为（真的去 fetch 一张 PNG）在浏览器里实跑验证；
      这里用**可替换的加载器**把两个宿主形态都覆盖掉：同步桩 + 手搓 thenable。
   ========================================================= */
G_('CardArt —— 回退链（AI 卡面优先、程序化兜底）');
(function () {
  /* 按需加载：本文件顶部那份清单里没有它（它是渲染层模块，运行时才用画布） */
  new Function(fs.readFileSync(path.join(ROOT, 'src/render/cardart.js'), 'utf8')).call(global);
  const CA = G.CardArt;
  const img = (w, h) => ({ width: w, height: h });   // 画布只认 width / height
  let asks = [];
  const syncLoader = () => { asks.push(1); return img(1152, 768); };

  CA.reset();
  CA.setLoader(syncLoader);

  /* ---- 母版禁令：游戏侧只吃透明抠图，空 / 未知档位必须直接拒绝 ---- */
  let badCb = 0;
  ok(CA.held('A01') === null && CA.held('A01', '') === null && CA.held('A01', 'nope') === null,
     'held()：空档位与未知档位一律 null（`<id>.png` 是灰底母版，不许进游戏）');
  asks = [];
  ok(CA.want('A01', null, () => badCb++) === false &&
     CA.want('A01', 'noSuchMorph', () => badCb++) === false &&
     CA.want('', 'golden', () => badCb++) === false &&
     CA.want('../etc/passwd', 'golden', () => badCb++) === false,
     'want()：空档位 / 未知档位 / 空 id / 带路径字符的 id → 全部 false');
  ok(asks.length === 0 && badCb === 0,
     'want()：被拒的请求**连加载器都不碰**（不许拼出一个可能 404 的路径）');

  /* ---- 正常路径（同步宿主）---- */
  asks = [];
  let got = 0, gotImg = null;
  const first = CA.want('A01', 'golden', im => { got++; gotImg = im; });
  ok(first === true && got === 1 && !!gotImg,
     'want()：同步宿主下当场就把图交出来（返回 true ⇒ 调用方不必先画程序化的那张）');
  ok(asks.length === 1, 'want()：加载器只被叫了一次');
  ok(CA.held('A01', 'golden') === gotImg, 'held()：want() 之后拿到的是同一张图对象');

  /* ---- 已经有了：不再发请求，但仍要回调（消费方等着重画）---- */
  asks = []; got = 0;
  ok(CA.want('A01', 'golden', () => got++) === true && asks.length === 0 && got === 1,
     'want()：已有图时不再发请求，但仍回调一次（消费方据此重画）');

  /* ---- 异步宿主：同一张图并发只发一次请求，两个消费方都收到 ---- */
  CA.reset();
  asks = []; const resolveLater = [];
  CA.setLoader(() => { asks.push(1); return { then(res) { resolveLater.push(res); } }; });
  let a = 0, b = 0;
  ok(CA.want('B07', 'shiny', () => a++) === false, 'want()：异步宿主下返回 false（现在还没图）');
  ok(CA.want('B07', 'shiny', () => b++) === false, 'want()：同一张图第二次要 → 仍返回 false');
  ok(asks.length === 1, 'want()：同一张图并发只发一次请求（不许两张图各查一遍）');
  ok(a === 0 && b === 0 && CA.held('B07', 'shiny') === null,
     'want()：图还没到时回调不响、held() 仍是 null（画布上留着程序化那张）');
  const late = img(1152, 768);
  resolveLater[0](late);
  ok(a === 1 && b === 1 && CA.held('B07', 'shiny') === late,
     'want()：图到了 → 两个消费方各回调一次，held() 拿到图（这一步就是「重画」的触发点）');

  /* ---- 缺图 / 坏图：**一个回调都不发**，让程序化的那张留在画布上 ---- */
  CA.reset();
  CA.setLoader(() => null);
  let missCb = 0;
  const m0 = CA.used();
  ok(CA.want('ZZZ', 'normal', () => missCb++) === false && missCb === 0 &&
     CA.held('ZZZ', 'normal') === null,
     'want()：加载器给 null（缺图 / 坏图）→ 不回调、held() 仍 null ⇒ 回退程序化绘制');
  ok(CA.used().miss === m0.miss + 1,
     'used()：没拿到图要记进 miss（开发者面板靠它分「贴了卡面 / 回退了程序化」各多少张）');
  CA.setLoader(() => { throw new Error('boom'); });
  ok(CA.want('ZZZ', 'normal', () => missCb++) === false && missCb === 0,
     'want()：加载器自己抛了也不许把异常漏给调用方（绘制路径上抛 = 整个图鉴白屏）');

  /* ---- blit：等比放进框、居中、不裁切 ---- */
  CA.reset();
  const drawn = [];
  const ctx = { drawImage: (im, x, y, w, h) => drawn.push({ x, y, w, h }) };
  /* 卡面是固定 1152×768（3:2），两个调用点的框都比它扁 ⇒ 实际总是「高度贴合」 */
  const d1 = CA.blit(ctx, img(1152, 768), 130, 56, 260, 112);
  ok(Math.abs(d1.w - 168) < 0.01 && Math.abs(d1.h - 112) < 0.01,
     `blit()：图鉴网格 260×112 的框 → 168×112（高度贴合，实得 ${d1.w}×${d1.h}）`);
  ok(Math.abs(drawn[0].x - (130 - 168 / 2)) < 0.01 && Math.abs(drawn[0].y - (56 - 112 / 2)) < 0.01,
     'blit()：以 (cx, cy) 为中心画（x/y 是左上角，不是中心）');
  const d2 = CA.blit(ctx, img(1152, 768), 190, 90, 380, 190);
  ok(Math.abs(d2.w - 285) < 0.01 && Math.abs(d2.h - 190) < 0.01,
     `blit()：详情页 380×190 的框 → 285×190（实得 ${d2.w}×${d2.h}）`);
  const d3 = CA.blit(ctx, img(100, 100), 50, 50, 200, 120);   // 方形图：宽度先贴合
  ok(Math.abs(d3.w - 120) < 0.01 && Math.abs(d3.h - 120) < 0.01,
     'blit()：方图放进扁框时宽度贴合（contain 口径：两边都不许超框）');
  ok(d3.w <= 200 && d3.h <= 120 && d1.w <= 260 && d1.h <= 112,
     'blit()：任何情况下都不超框（超框 = 贴到隔壁条目上）');

  const u = CA.used();
  ok(typeof u.hit === 'number' && typeof u.miss === 'number' && typeof u.ask === 'number',
     'used()：返回 { hit, miss, ask }（开发者面板「素材家底」读它分 AI 图 / 回退各多少张）');
  CA.setLoader(null);   // 还原成默认（Assets.card）——别把桩留给别的用例
})();

/* =========================================================
   Audio —— 采样回退层没有改动公开 API
   =========================================================
   采样音效是「在 API 上包一层」而不是「换一套 API」，所以这里钉的是
   **公开方法名一个不少** —— 一旦有人把某个方法改成只在有素材时才存在，
   全项目 56 个播放点会开始静默不出声，而测试只有这一条能拦住。
   ⚠️ 真正的播放行为（采样 / 回退）在浏览器里实跑验证 —— 本文件没有 WebAudio。
   ========================================================= */
G_('Audio —— 采样回退层保持公开 API 不变');
(function () {
  /* 本文件早先把 `G.Audio` 换成了空壳 audioStub（见它旁边的注释：定时器要它常在）。
     这里跟「环境音」那节一样，**按需加载真实模块**，测完再还原成空壳。
     ⚠️ enabled=false 时采样层在 `ensure()` 之前就返回了，所以这一节**不需要**假 AudioContext。 */
  new Function(fs.readFileSync(path.join(ROOT, 'src/core/audio.js'), 'utf8')).call(global);
  const A = G.Audio;

  const NAMES = ['cast', 'splash', 'bite', 'hint', 'tick', 'snap', 'escape', 'success',
                 'legendary', 'glint', 'reward',
                 'newRecord', 'coin', 'click', 'deny', 'unlock',
                 'setEnabled', 'setVolume', 'setMusicVolume',
                 'startAmbience', 'stopAmbience',
                 'startBgm', 'stopBgm'];
  ok(NAMES.every(k => typeof A[k] === 'function'),
     `公开方法 ${NAMES.length} 个一个不少（采样层是包一层，不是替换）`);
  ok(Object.keys(A).length === NAMES.length,
     `导出面没有多出方法（实得 ${Object.keys(A).length} 个，期望 ${NAMES.length}）—— `
     + '采样层只许包已有方法，不许顺手导出 probe / reset 这类调试口');
  /* ⚠️ 这一条是「撞名假通过」的补丁：`G.Audio.sparkle` 曾经与视觉层的
     `G.Scene.sparkle` 同名，verify 第 ㉜ 节那套**裸名扫描**于是把它算成已消费。
     音效与渲染各有一套动作名字（cast / splash / bite 两边都有），撞名不可怕，
     **靠撞名通过门禁**才可怕 —— 所以这里按**限定名**去找真实调用点，撞名骗不过去。
     `legendary` 例外：它由 `success()` 在第 4 档内部委派（见 audio.js 的注释）。 */
  (function () {
    const srcFiles = [];
    (function walk(d) {
      fs.readdirSync(path.join(ROOT, d)).forEach(n => {
        const rel = d + '/' + n;
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.js$/.test(n)) srcFiles.push(rel);
      });
    })('src');
    const other = srcFiles.filter(r => r !== 'src/core/audio.js')
      .map(r => fs.readFileSync(path.join(ROOT, r), 'utf8')).join('\n');
    const orphan = NAMES.filter(k => k !== 'legendary'
      && other.indexOf('G.Audio.' + k + '(') < 0);
    ok(orphan.length === 0,
       `每个音效方法在 src/ 里都有真实调用点（限定名 G.Audio.<名>(，撞名骗不过去）`
       + (orphan.length ? '' : `；${NAMES.length - 1} 个逐一对上`),
       '零调用：' + orphan.join('、'));
  })();

  /* 关掉总开关后逐个调一遍：**必须不抛**。
     没素材、没 AudioContext 时「静默跳过」是允许的，「抛异常」不是。 */
  A.setEnabled(false);
  const threw = [];
  NAMES.filter(k => k !== 'setEnabled').forEach(k => {
    try { A[k](2); } catch (e) { threw.push(k); }
  });
  A.setEnabled(true);
  ok(threw.length === 0,
     `关掉音效后逐个调用都不抛（实得 ${threw.length} 个异常${threw.length ? '：' + threw.join(' / ') : ''}）`);

  ok(typeof G.Assets.sfx === 'function', 'G.Assets.sfx()：音效取用入口存在（采样层的唯一素材来源）');

  G.Audio = audioStub;   // 还原成空壳：后面还有 resolve() 的定时器会调它
})();

/* =========================================================
   反作弊 · 本地完整性检测（N2 · 只做 L1 标记）
   =========================================================
   用户口径「反作弊（概率异常 → 封禁）」的**第一层**：只记录、不处置。
   这一节要证明三件事（缺一条这个模块就是摆设）：
     ① 判据**真的会报**：构造数据逐条命中，且「反向（少算）」不报；
     ② 判据**不误报**：正常档 + 随机仿真一局都不许响 —— 用户最初给的
        「概率 < 1e-9 才算作弊」与游戏真实概率差 5 个数量级，照那个口径
        会把活跃玩家全封了（8 小时挂机能自然出 ~15 个闪光）；
     ③ 它**真的什么都没改**：跑完全量深对拍，除 `integrity` 外逐字节相同。
   ========================================================= */
G_('完整性 · 反作弊 L1 标记（N2）');
(function () {
  const I = G.Integrity;
  ok(!!I && typeof I.audit === 'function', 'G.Integrity 已加载（审查用纯函数 audit 在位）');

  /* ---------- ① 下界必须真是下界 ----------
     `GAP` 判据押在 `Loot.biteTimeMin()` 上：它若**高估**了最短咬口，
     正常玩家就会被误标。这里用采样对拍证明 `biteTimeMin ≤ biteTime` 恒成立。 */
  let worst = Infinity;
  CFG.rarity.forEach((r, ri) => {
    Object.keys(G.FIELD_MAP).forEach(fid => {
      G.BAITS.forEach(b => {
        const lo = L.biteTimeMin(ri, { fieldId: fid, bait: b });
        for (let i = 0; i < 30; i++) {
          worst = Math.min(worst, L.biteTime(ri, { fieldId: fid, bait: b }) - lo);
        }
      });
    });
  });
  ok(worst >= 0, `biteTimeMin() 恒为采样咬口的下界（最小差 ${worst.toFixed(4)} s ≥ 0；`
    + '高估下界 = 正常玩家被误标）');

  /* ---------- ② 正常档一个标记都不许有 ----------
     拿一份**真正的新档**：把存储清空再 load（`blank()` 是存档结构的唯一真相，
     不在这里手抄一份 schema —— 抄一遍就等于多一个会悄悄漂移的定义）。 */
  const mem = Object.assign({}, store);
  Object.keys(store).forEach(k => delete store[k]);
  St.load();
  const save = St.get();
  Object.assign(store, mem);
  I.init(save);
  ok(I.count() === 0, `新建默认档审计后零标记（实得 ${I.count()} 条）`);
  ok(Array.isArray(save.integrity.flags) && save.integrity.runs > 0,
     '审计次数会在存档里累加（观察期要能看出「跑过没有」）');
  ok(/L1 标记/.test(I.stats()), `stats() 是给开发者面板看的字符串：${I.stats()}`);

  /* ---------- ③ 物理不可能（GAP） ---------- */
  const T0 = 1700000000000;
  const evBad = [{ t: T0, rar: 0, fid: 'D', ck: 'normal' },
                 { t: T0 + 3000, rar: 3, fid: 'D', ck: 'normal' }];
  const evOk = [{ t: T0, rar: 0, fid: 'D', ck: 'normal' },
                { t: T0 + L.biteTimeMin(3, { fieldId: 'D' }) * 1000, rar: 3, fid: 'D', ck: 'normal' }];
  const stubSave = { stats: { casts: 9, catches: 9, byRar: [9, 0, 0, 0], maxKg: 1 }, book: {} };
  ok(I.audit(stubSave, evBad).some(f => f.code === 'GAP'),
     'GAP：传说鱼两竿只隔 3 秒 ⇒ 报（传说档最短咬口 380 s × 鱼饵/钓场倍率，缩不到 3 秒）');
  ok(!I.audit(stubSave, evOk).some(f => f.code === 'GAP'),
     'GAP：间隔恰好等于最短咬口 ⇒ 不报（判据不许在边界上乱咬）');
  ok(!I.audit(stubSave, [{ t: 5, rar: 0, fid: 'D' }, { t: 4, rar: 0, fid: 'D' }]).some(f => f.code === 'GAP'),
     'GAP：时间倒流（脏时间戳）跳过，不当成「超快两竿」');

  /* ---------- ④ 自相矛盾（SAVE_*）：只判「同一函数里一起写的两个量」 ---------- */
  const okSave = { stats: { casts: 9, catches: 6, byRar: [5, 1, 0, 0], maxKg: 3 }, book: { A01: { n: 6, maxKg: 3, colors: { normal: 6 } } } };
  ok(I.audit(okSave, []).length === 0, 'SAVE：完全自洽的存档不报');
  const withStat = (k, v) => Object.assign({}, okSave, { stats: Object.assign({}, okSave.stats, { [k]: v }) });
  ok(I.audit(Object.assign({}, okSave, { book: { A01: { n: 99, maxKg: 3, colors: {} } } }), [])
    .some(f => f.code === 'SAVE_BOOK'), 'SAVE_BOOK：图鉴条目合计 > 分维计数合计 ⇒ 报（两者在 recordCatch 里同步 +1）');
  ok(I.audit(withStat('maxKg', 1), []).some(f => f.code === 'SAVE_MAXKG'),
     'SAVE_MAXKG：图鉴里的最大体重 > 全局纪录 ⇒ 报（同一次 kg 一起写的）');
  /* ⚠️ 反向必须**不报**：少算可能是迁移把不认识的鱼种条目清掉了，
     把它当证据 = 误报正常玩家（这条是「只判严格不可能」的口径，别改宽）。 */
  ok(!I.audit(Object.assign({}, okSave, { stats: Object.assign({}, okSave.stats, { byRar: [99, 0, 0, 0] }) }), [])
    .some(f => f.code === 'SAVE_BOOK'), 'SAVE_BOOK：图鉴**少算**（迁移清理过）不报 —— 只判严格不可能');
  ok(!I.audit(withStat('maxKg', 99), []).some(f => f.code === 'SAVE_MAXKG'),
     'SAVE_MAXKG：全局纪录更大（更宽松）不报');

  /* ---------- ④-b 真代码路径：8 小时离线补算**不许**产生任何标记 ----------
     这条是「先量后改」的产物：最初还写了 `Σ byRar > catches` 与 `catches > casts` 两条
     看着很自然的判据，实测都被离线补算打破 —— 它按 `max(1, round(g·scale))` **逐鱼种**折算，
     且**只加 catches 不加 casts**（人不在场）。凡挂过机的正常玩家都会被那两条误标。 */
  Fish.init({});
  St.get().stats.casts = 40;                      // 在线抛过的竿（离线期间一次都不抛）
  /* 挂机 800 条会解锁一堆成就 / 称号 → `Goals.check()` 会去调 `G.Hud.toast()`，
     而 Node 里没有真 DOM。这里只把这一个方法临时换掉（别的 Hud 行为照旧）。 */
  const realToast = G.Hud && G.Hud.toast;
  let oc8 = null, ocFlags = [];
  try {
    if (G.Hud) G.Hud.toast = function () {};
    oc8 = Fish.offlineCatchUp(28800, 35);
    const ocSave = St.get();
    ocFlags = I.audit({ book: ocSave.book, stats: ocSave.stats }, []);
    ok(!!oc8 && ocSave.stats.catches > ocSave.stats.casts,
       `离线补算后 catches(${ocSave.stats.catches}) > casts(${ocSave.stats.casts}) —— `
       + '这正是「catches > casts 不能当判据」的实测依据');
  } finally { if (G.Hud) G.Hud.toast = realToast; }
  ok(ocFlags.length === 0, `8 小时挂机（${oc8 && oc8.count} 条）走真代码路径后零标记`
    + (ocFlags.length ? '：' + ocFlags.map(f => f.code).join('、') : ''));

  /* ---------- ⑤ 真·极端概率（ODDS）：先证明「可达」，再证明不误报 ---------- */
  const legend = G.FISH.filter(f => f.rar === CFG.rarity.length - 1);
  const lf = legend[0];
  const oddsSave = (nLegend, kShiny) => ({
    stats: { casts: nLegend, catches: nLegend, byRar: [0, 0, 0, nLegend], maxKg: 1 },
    book: (() => { const b = {}; b[lf.id] = { n: nLegend, maxKg: 1, colors: { normal: nLegend - kShiny, [CFG.colorMorphs[CFG.colorMorphs.length - 1].key]: kShiny } }; return b; })(),
  });
  /* 阈值可达（现算，不写死判定点）：从 minOddsK 往上扫，必须存在一个 k 命中；
     否则 `oddsFloor` 定得太低 = 这条判据永远不会响（不报错、无告警）。 */
  const N_REF = 200;
  let hitK = -1;
  for (let k = CFG.integrity.minOddsK; k <= N_REF; k++) {
    if (I.audit(oddsSave(N_REF, k), []).some(f => f.code === 'ODDS')) { hitK = k; break; }
  }
  ok(hitK > 0, `ODDS 阈值可达：${N_REF} 条传说档里闪光从 ${hitK} 条起命中`
    + `（最低要求 ${CFG.integrity.minOddsK} 条；不可达 = 判据形同不存在）`);
  ok(!I.audit(oddsSave(N_REF, CFG.integrity.minOddsK - 1), []).some(f => f.code === 'ODDS'),
     'ODDS：低于 minOddsK 的样本量一律不判（几条运气好的鱼不是证据）');
  /* 反过来：样本量小的时候，就算「全闪」也不该判（全靠运气，正常档真会碰到）。 */
  const tiny = CFG.integrity.minOddsK - 1;
  ok(!I.audit(oddsSave(tiny, tiny), []).some(f => f.code === 'ODDS'),
     `ODDS：只有 ${tiny} 条传说且恰好全闪光 ⇒ 不判（这就是用户最初口径会误封的场景）`);
  const od = I.audit(oddsSave(N_REF, hitK), []).find(f => f.code === 'ODDS');
  ok(!!od && /概率上界/.test(od.detail), `ODDS 的说明带实际概率上界：${od ? od.detail : '(无)'}`);

  /* ---------- ⑥ 判据是纯函数：不读时钟、不读随机数 ---------- */
  const snapIn = JSON.stringify({ s: okSave, e: evBad });
  const r1 = JSON.stringify(I.audit(okSave, evBad));
  const r2 = JSON.stringify(I.audit(okSave, evBad));
  ok(r1 === r2, '同一份输入两次审计逐字节相同（门禁里验的与运行时跑的是同一段代码）');
  const realRandom = Math.random, realNow = Date.now;
  let impure = '';
  try {
    Math.random = () => { impure = 'Math.random'; return 0; };
    Date.now = () => { impure = (impure || 'Date.now'); return 0; };
    I.audit(okSave, evBad);
    I.audit(oddsSave(N_REF, hitK), []);
  } catch (e) { impure = '抛异常：' + e.message; }
  Math.random = realRandom; Date.now = realNow;
  ok(impure === '', `审计不读时钟 / 随机数（构造数据可定点复现）${impure ? ' —— ' + impure : ''}`);
  ok(JSON.stringify({ s: okSave, e: evBad }) === snapIn, '审计不改传入的存档 / 证据（纯函数）');

  /* ---------- ⑦ 用户点名的第一条红线：不许拿「罕见但会发生」当证据 ----------
     场景 = 5 分钟内 3 个闪光。这是**正常档真的会碰到**的事（8 小时挂机期望 ~15 个），
     用户最初给的「概率 < 1e-9」口径会把这种玩家封掉 —— 这里钉死它不会被标记。 */
  const burst = [];
  for (let i = 0; i < 3; i++) {
    burst.push({ t: T0 + i * 100000, rar: 0, fid: 'D', ck: CFG.colorMorphs[CFG.colorMorphs.length - 1].key });
  }
  ok(I.audit({ stats: { casts: 3, catches: 3, byRar: [3, 0, 0, 0], maxKg: 1 }, book: {} }, burst).length === 0,
     '红线：5 分钟内 3 个闪光（正常节奏、没违反最短咬口）⇒ **零标记**（不许按稀有事封人）');

  /* ---------- ⑧ 只做 L1：它真的什么都没改 ---------- */
  const before = JSON.stringify(Object.assign({}, save, { integrity: null }));
  const again = I.audit(save, []);
  I.note(lf, 'normal', T0);
  I.note(lf, 'normal', T0 + 1000);          // 故意造一个 GAP 场景
  const after = JSON.stringify(Object.assign({}, save, { integrity: null }));
  ok(before === after, '跑完全量审计 + 记两条证据后，存档里除 `integrity` 外**逐字节相同**'
    + '（「不处置」的行为级证据，比静态扫代码强一个量级）');
  ok(I.count() > 0 && again !== null, `标记确实落了盘：${I.stats()}`);
  /* `flags()` 给的是**副本**：调用方（开发者面板 / 将来的申诉入口）改不动内部状态 */
  const flagCopy = I.flags();
  flagCopy.push({ code: '伪造', n: 99, at: 0, detail: '' });
  ok(I.count() === flagCopy.length - 1 && I.flags().every(f => f.code !== '伪造'),
     'flags() 返回副本：外面改它动不了模块内部状态');
  ok(Object.keys(G.Integrity).length === 7,
     `导出面恰好 7 个、没有多出「封禁 / 锁定」这类处置口（实得 ${Object.keys(G.Integrity).length} 个：`
     + Object.keys(G.Integrity).join('、') + '）');
  const had = I.count();
  ok(I.clear() === had && I.count() === 0, `clear() 清掉全部标记并返回条数（${had} → 0）；`
    + '它只是「把标记清空」，不是「解除处罚」—— 因为压根没有处罚');
})();

/* =========================================================
   陪伴助手（N6）—— 播报判定 / 语音降级 / 音量闸门
   ---------------------------------------------------------
   Node 里**没有** speechSynthesis（平台层退回 no-op），正好是
   「拿不到能力怎么办」那条边界的天然测试环境；要验「真会出声」那半边
   就把平台层的 speech 换成桩（与 G.Scene / G.Audio 的桩同一个手法）。
   ========================================================= */
G_('陪伴助手 · 播报判定与语音降级');
(function () {
  var A = G.Assistant, PL = G.Platform;
  var se = St.get().settings;
  var keep = {
    speech: se.speech, volume: se.volume, voice: se.voice,
    rate: se.speechRate, pitch: se.speechPitch, idle: se.idle, sound: se.sound,
  };
  var said = [];
  A.reset();
  A.init({ toast: function (line) { said.push(line); } });

  /* ---------- ① 平台层：没有能力时四件事都不许抛 ---------- */
  var noSpeech = { available: false, list: [], speak: false, stop: true };
  (function () {
    var threw = '';
    try {
      noSpeech.available = PL.speech.available();
      noSpeech.list = PL.speech.list();
      noSpeech.speak = PL.speech.speak('测试');
      PL.speech.stop();
      PL.speech.onVoices(function () {});
    } catch (e) { threw = e.message; }
    ok(threw === '', '没有 speechSynthesis 时，available/list/speak/stop/onVoices 都不抛'
      + (threw ? ' —— ' + threw : ''));
  })();
  ok(noSpeech.available === false, 'Node / 无该能力的宿主上 available() 返回 false');
  ok(Array.isArray(noSpeech.list) && noSpeech.list.length === 0, 'list() 兜底返回**空数组**（不是 null）');
  ok(noSpeech.speak === false, 'speak() 返回 false（调用方据此只留文字），而不是抛异常');
  ok(JSON.stringify(noSpeech.list) === JSON.stringify(PL.speech.list()), 'list() 两次调用结果一致（无副作用）');

  /* ---------- ② 平台层：有桩能力时的参数装配 ---------- */
  var real = PL.speech;
  var calls = [];
  PL.speech = {
    available: function () { return true; },
    list: function () { return [{ id: 'v1', name: '音色一', lang: 'zh-CN' }]; },
    onVoices: function () {},
    speak: function (t, o) { calls.push({ t: t, o: o }); return true; },
    stop: function () { calls.push({ stop: 1 }); },
  };
  try {
    ok(G.Assistant.preview() === true && calls.length === 1,
       'preview() 走平台层真发了一句，并返回 true');
    ok(calls[0].t.indexOf('试听') >= 0, 'preview() 念的是**试听专用**那句话（不是剧情台词）');
    ok(calls[0].o.volume === se.volume, '试听的音量 = 存档里的总音量（语音不走 AudioContext，闸门在这里）');
    ok(typeof calls[0].o.rate === 'number' && typeof calls[0].o.pitch === 'number',
       '试听带上了语速 / 音调（都来自 settings）');

    /* ---------- ③ 分档：传说 / 纪录出声，普通鱼与脱钩不接话 ---------- */
    A.reset(); said.length = 0; calls.length = 0;
    se.speech = true; se.volume = 0.55;
    var r1 = A.onCatch({ rar: 3, isRecord: false, isNew: true });
    ok(r1 && r1.key === 'legendary' && r1.spoken === true, '钓到传说档（rar ≥ 传说下标）⇒ 念一句并出声');
    ok(calls.length === 1 && calls[0].t === r1.text, '念的正文就是气泡里那一句（同一句话，两个通道）');

    A.reset();
    var r2 = A.onCatch({ rar: 0, isRecord: true });
    ok(r2 && r2.key === 'record' && r2.spoken === true, '刷新个人纪录 ⇒ 走「纪录」那条台词');
    A.reset();
    var r3 = A.onCatch({ rar: 2, isRecord: true });
    ok(r3 && r3.key === 'record', '史诗档破纪录也算纪录（只有传说档优先走 legendary）');
    A.reset();
    var r4 = A.onCatch({ rar: 3, isRecord: true });
    ok(r4 && r4.key === 'legendary', '传说档 + 破纪录同时成立 ⇒ 取传说那句（一次只出一句）');
    ok(A.onCatch({ rar: 0, isRecord: false }) === null, '普通鱼**不接话**（每竿一句 = 刷屏，不是陪伴）');
    A.reset();
    ok(A.onMiss('escape') === null, '脱钩不出声也不出气泡（游戏自己的提示已经说清了）');
    ok(A.onMiss('snap') && A.onMiss('snap') === null, '断线会说一句；同一句在节流窗口内不重复');

    /* ---------- ④ 节流与轮换 ---------- */
    A.reset(); said.length = 0;
    var a = A.onCatch({ rar: 3 }), b = A.onCatch({ rar: 3 });
    ok(a && b === null, `同一场景 ${CFG.assistant.minGapMs} ms 内不重复播报（第二次返回 null）`);
    /* 把节流窗口调成 0 = 每次都开口：既能证明 `minGapMs` 真的在起作用
       （上面那条不是「反正都不说」），也能看出台词是**轮换**的。 */
    var keepGap = CFG.assistant.minGapMs;
    CFG.assistant.minGapMs = 0;
    var t1 = A.onCatch({ rar: 3 }), t2 = A.onCatch({ rar: 3 });
    ok(t1 && t2 && t1.text !== t2.text, '节流窗口设 0 时连说两句 ⇒ 第二句是**下一句**台词（不是随机抽）');
    var seen = {}, prev = null, adj = 0, j;
    for (j = 0; j < 12; j++) {
      var lz = A.onCatch({ rar: 3 });
      if (prev !== null && lz.text === prev) adj++;
      prev = lz.text; seen[lz.text] = 1;
    }
    CFG.assistant.minGapMs = keepGap;
    ok(adj === 0, `连说 ${j} 句里没有相邻重复（游标推进，不靠随机数 ⇒ 结果可定点复现）`);
    ok(Object.keys(seen).length === G.ASSISTANT_LINES.legendary.length,
       `${j} 句里把传说档 ${G.ASSISTANT_LINES.legendary.length} 句台词全轮到了（游标会绕回开头）`);

    /* ---------- ⑤ 关掉语音：话还在，只是不出声 ---------- */
    A.reset(); said.length = 0; calls.length = 0;
    se.speech = false;
    var r5 = A.onCatch({ rar: 3 });
    ok(r5 && r5.spoken === false && calls.length === 0, '关掉语音 ⇒ 一声不吭');
    ok(said.length === 1 && said[0].text === r5.text, '……但**文字气泡照常**（这是「关掉后文字照常」的行为证据）');

    /* ---------- ⑥ 总音量 = 所有声音的总闸门（含语音） ---------- */
    A.reset(); calls.length = 0;
    se.speech = true; se.volume = 0;
    var r6 = A.onCatch({ rar: 3 });
    ok(calls.length === 0 && r6 && r6.spoken === false,
       '总音量 0 ⇒ **不调用** TTS（而不是发一句音量 0 的、界面上还显示「说了」）');
    /* 「音效」那条开关的文案写的是「开关全部**程序化音效**」⇒ 语音有自己的开关，
       不跟着它走。这条边界必须有一条行为断言钉着，否则下一个人「顺手」让它
       也守 settings.sound，表现就是「关掉音效后语音莫名其妙也没了」。 */
    A.reset(); calls.length = 0; se.volume = 0.55; se.sound = false;
    ok(A.onCatch({ rar: 3 }) && calls.length === 1,
       '「音效」开关只管程序化音效：关掉它，语音仍按 settings.speech 自己的开关走');
    se.sound = keep.sound; se.volume = keep.volume;

    /* ---------- ⑦ 挂机不刷屏 ---------- */
    A.reset();
    St.setIdle(true);
    var r7 = A.onCatch({ rar: 3 });
    St.setIdle(false);
    ok(r7 === null, '挂机（自动钓鱼）时助手完全不开口 —— 人不在屏幕前');

    /* ---------- ⑨ 图鉴新增：纯文字档 + 优先级（**必须排在「纪录」前面**） ---------- */
    A.reset(); said.length = 0; calls.length = 0;
    var n1 = A.onCatch({ rar: 0, isNew: true, isRecord: true });
    ok(n1 && n1.key === 'firstSee', '图鉴新增（`isNew`）走 firstSee 那句话，且**排在「纪录」前面**');
    ok(n1.spoken === false && calls.length === 0,
       '……而且它是**纯文字档**：只出气泡、不念（每来一条新鱼都开口念 = 播报，不是陪伴）');
    ok(said.length === 1 && said[0].text === n1.text, '……但气泡照常有（与「关掉语音后文字照常」同一条口径）');
    A.reset();
    ok(A.onCatch({ rar: 0, isNew: false, isRecord: true }).key === 'record',
       '普通破纪录仍然走 record（新加的优先级没把老场景挤掉）');
    A.reset();
    ok(A.onCatch({ rar: 3, isNew: true, isRecord: true }).key === 'legendary',
       '传说 + 图鉴新增同时成立 ⇒ 仍然只出传说那句（一次只出一句，信息量大的先）');

    /* ---------- ⑩ 真身数据：为什么「图鉴新增」必须排在「纪录」前面 ----------
       新鱼的 `book` 条目是 `maxKg: 0` ⇒ `kg > 0` 恒成立 ⇒ **isNew 必然 isRecord**。
       拿真的 `State` 跑一次（挑一条没钓到过的鱼），跑完把那条条目删掉还原 ——
       ⚠️ 这条不是「顺便验一下」，它正是 ⑨ 里那个顺序的**唯一理由**：
          顺序写反了不会报任何错，只是那句话永远没人听见。 */
    var probeFish = G.FISH.filter(function (f) { return !St.isCaught(f.id); })[0];
    var probeRec = probeFish ? St.recordCatch(probeFish, 0.1, 'normal') : null;
    ok(!!probeRec && probeRec.isNew === true && probeRec.isRecord === true,
       '真身数据：第一次钓到的鱼**必然同时**是「图鉴新增」和「个人纪录」'
       + '（所以 firstSee 排在 record 后面 = 那句台词永远没人听见）');
    if (probeFish) delete St.get().book[probeFish.id];

    /* ---------- ⑪ 长时空军（blank）：**两道门都要过** ----------
       假时钟从「现在之后」起：`say()` 的节流拿 `now()` 与上次播报比，
       把时钟往回拨会让所有断言被节流挡成「没说话」（假绿）。 */
    var realNowFn = PL.sys.now;
    var clock = 0;
    PL.sys.now = function () { return clock; };
    try {
      var NSTK = CFG.assistant.blankStreak, WMS = CFG.assistant.blankMinMs;
      var k2;
      /* 连丢 n 竿，返回**这一段里任何一次真说出口的那句**（null = 全程没开口）。
         🔴 不能只看「最后一次」的返回值：同一个假时刻下第一节说出口之后，
            后面的调用全被节流挡成 null ⇒「最后一次」永远是 null，断言恒真（假绿）。
            这条是反向验证当场逮出来的：不清零的坏代码照样过 —— 就是因为只看最后一次。 */
      function missRun(n, kind) {
        var spoke = null;
        for (var i = 0; i < n; i++) {
          var r = A.onMiss(kind || 'escape');
          if (r) spoke = r;
        }
        return spoke;
      }

      /* ① 竿数不够：时间早就过门，仍不开口 */
      A.reset();
      clock = realNowFn() + 3600000;
      A.onMiss('escape');                                   // 第 1 竿：这一轮空手从此刻起算
      clock += WMS * 2;                                     // 时长远远过门
      ok(missRun(NSTK - 2) === null,
         `只丢 ${NSTK - 1} 竿、时长早就过门 ⇒ 也不开口（竿数那道门在起作用）`);

      /* ② 时长不够：竿数丢满，也没开口（常见钓场一竿才十几秒 ⇒ 那不叫「长时」） */
      A.reset();
      clock = realNowFn() + 7200000;
      ok(missRun(NSTK) === null,
         `丢满 ${NSTK} 竿但这一轮空手几乎没有时长 ⇒ 不开口（时长那道门在起作用）`);

      /* ③ 两道门都过 ⇒ 开口（纯文字档） */
      clock += WMS;
      var l3 = A.onMiss('escape');
      ok(l3 && l3.key === 'blank' && l3.spoken === false,
         `竿数与空手时长都过门 ⇒ 说「长时空军」那句，且同样**只出文字**`);

      /* ④ 说出口就重新起算，不会每隔 minGapMs 复读一遍 */
      clock += WMS;
      ok(missRun(NSTK - 1) === null,
         `说完之后重新起算：再丢 ${NSTK - 1} 竿（时长早已过门）也不开口 —— 不会复读`);

      /* ⑤ 上鱼清零（普通鱼不出话，但账要清） */
      A.reset();
      clock = realNowFn() + 10800000;
      A.onMiss('escape');
      missRun(NSTK - 2);
      clock += WMS * 2;
      A.onCatch({ rar: 0 });
      ok(missRun(1) === null, '中间上过鱼 ⇒ 空手那一轮从零起算（不满竿数就不开口）');

      /* ⑥ 断线抢走那一竿的发言权，但**不吃掉**空手记账 */
      A.reset();
      clock = realNowFn() + 14400000;
      A.onMiss('escape');
      clock += WMS * 2;
      missRun(NSTK - 2);
      var sn = A.onMiss('snap');                            // 第 N 竿恰好是断线
      ok(sn && sn.key === 'snap', `第 ${NSTK} 竿恰好断线 ⇒ 出断线那句（更具体的先），不是「空军」那句`);
      var af = missRun(1);
      ok(af && af.key === 'blank', '……而且断线不吃掉空手记账：紧接着下一竿就补上了空军那句');

      /* ⑦ 挂机整段不记账 */
      A.reset();
      clock = realNowFn() + 18000000;
      St.setIdle(true);
      var idleSpoke = missRun(NSTK + 5);
      St.setIdle(false);
      ok(idleSpoke === null && missRun(1) === null,
         '挂机整段不记空手的账：人回来之后不会一上来就被告知「你空军了」');

      /* ⑧ 挂机时钓到的鱼也算「钓到了」⇒ 照样清账 */
      A.reset();
      clock = realNowFn() + 21600000;
      A.onMiss('escape');
      missRun(NSTK - 2);
      clock += WMS * 2;
      St.setIdle(true);
      A.onCatch({ rar: 3 });
      St.setIdle(false);
      ok(missRun(1) === null,
         '挂机时钓到的鱼也算「钓到了」：清掉空手记账（不然人回来还背着挂机那一轮的账）');
      A.reset();
    } finally {
      PL.sys.now = realNowFn;
      if (St.get().settings.idle) St.setIdle(false);
    }

    /* ---------- ⑧ 台词表本身 ---------- */
    var keys = Object.keys(G.ASSISTANT_LINES);
    var empty = keys.filter(function (k) {
      var t = G.ASSISTANT_LINES[k];
      return !Array.isArray(t) || !t.length || t.some(function (s) { return !String(s).trim(); });
    });
    ok(empty.length === 0, `${keys.length} 组台词都不是空的（${keys.join(' / ')}）`);
    var noLine = CFG.assistant.speakKeys.filter(function (k) { return keys.indexOf(k) < 0; });
    ok(noLine.length === 0, 'config 里点名的出声场景都有台词（' + CFG.assistant.speakKeys.join(' / ') + '）');
    ok(keys.indexOf('preview') >= 0 && CFG.assistant.speakKeys.indexOf('preview') < 0,
       '试听有自己的台词，但**不在**「剧情出声」名单里（否则它会跟着节流走）');
    ['firstSee', 'blank'].forEach(function (k) {
      ok(keys.indexOf(k) >= 0 && CFG.assistant.speakKeys.indexOf(k) < 0,
         `纯文字档场景 ${k} 有台词、且**不在**出声名单里（它比传说鱼常见得多，念出来就成了播报）`);
    });
    A.reset();
  } finally {
    PL.speech = real;
    se.speech = keep.speech; se.volume = keep.volume; se.voice = keep.voice;
    se.speechRate = keep.rate; se.speechPitch = keep.pitch; se.sound = keep.sound;
    if (se.idle !== keep.idle) St.setIdle(keep.idle);
    A.init({});
    A.reset();
  }
})();

/* =========================================================
   N7 · 隔壁钓鱼佬（事件引擎：可复现 / 冷却 / 四道门 / 奖励不落地）
   ========================================================= */
G_('隔壁钓鱼佬 · 事件引擎的可复现与四道门（N7）');
(function () {
  var S7 = G.Story, PL = G.Platform, Fish7 = G.Fishing;
  var realSnap = G.Weather.snapshot, realPanels = G.Panels;
  /* 三组受控条件：分别命中「借线」（傍晚）/「旧靴子」（有雾）/ 谁都不命中。
     ⚠️ 场地必须是**那一位真站得住的钓场**（N7 五期起事件过一道 NPC 门：`ev.npc`
        跟「当前钓场站着的那位」对不上就整条跳过）。老陈在内陆（D / C / B），
        阿海在海那四片（A / S / SS / SSS）—— 两个人各管各的事，不会串场。
        后两组刻意用**隐藏钓场 SS**（阿海的地盘）当场地：他那边两件事在那两组条件下
        都不满足（`spar` 只在 A / S 办，`swell` 要下雨）⇒「谁都不命中」才站得住。
        拿 D 场当场地的话：大晴天正午会命中老陈的「比试」、有雾白天则会与「旧靴子」抢掷点
        （谁先过概率门谁赢），这两条断言的**意图**（无人命中 / 命中哪一条）就守不住了。 */
  var DUSK = { field: 'D',  wx: 'clear', tm: 'dusk', npc: 'chen' };
  var FOG  = { field: 'D',  wx: 'fog',   tm: 'dusk', npc: 'chen' };
  var DRY  = { field: 'SS', wx: 'clear', tm: 'day',  npc: 'hai'  };

  function clean() { S7.reset(); St.get().story = { fired: {}, at: {} }; }
  /* 把**当前内容表里除某一条之外**的所有事件都推进冷却里（`at` 写一个比 `now=0` 大的数
     ⇒ `now - last < cooldownMs` 恒真 ⇒ 全被跳过）。用来隔离出「只想验的那一条」——
     不写死别的 id：改一次概率 / 加一条事件都不会让这组用例失效。 */
  function coolExcept(keepId) {
    var at = St.get().story.at;
    G.STORY_EVENTS.forEach(function (e) { if (e.id !== keepId) at[e.id] = 1; });
  }
  /* 从 seq=1 往下**扫**一个真能命中的序号（不写死数字：改一次台词 / chance 就会失效） */
  function firstHit(base) {
    for (var i = 1; i <= 600; i++) {
      var p = { field: base.field, wx: base.wx, tm: base.tm, npc: base.npc, seq: i, now: 0 };
      var ev = S7.tryFire(p);
      if (ev) return { seq: i, ev: ev, p: p };
    }
    return null;
  }
  function npcIdOf(obj) {
    var ks = Object.keys(G.STORY_NPCS);
    for (var i = 0; i < ks.length; i++) if (G.STORY_NPCS[ks[i]] === obj) return ks[i];
    return '';
  }

  try {
    /* ---------- ① 掷点是纯函数 ---------- */
    var ev0 = G.STORY_EVENTS[0];
    var p0 = { field: 'D', wx: 'clear', tm: 'dusk', seq: 7, now: 0 };
    ok(S7.rollFor(ev0, p0) === S7.rollFor(ev0, p0), 'rollFor() 同一入参两次结果相同（纯函数）');
    var v0 = S7.rollFor(ev0, p0);
    ok(v0 >= 0 && v0 < 1, 'rollFor() 落在 [0,1)');
    var uniq = {}, nUniq = 0;
    for (var i = 1; i <= 20; i++) {
      var v = S7.rollFor(ev0, { field: 'D', wx: 'clear', tm: 'dusk', seq: i, now: 0 });
      if (!uniq[v]) { uniq[v] = 1; nUniq++; }
    }
    ok(nUniq === 20, '20 个序号给出 20 个互不相同的掷点（否则事件要么永远触发、要么永远不触发）');

    /* ---------- ② 条件门 ---------- */
    clean();
    ok(firstHit(DRY) === null, '条件都不满足时（隐藏钓场 + 大晴天正午）一条事件都不触发');
    clean();
    var h1 = firstHit(DUSK);
    ok(h1 && h1.ev.id === 'borrow', '傍晚无雨 ⇒ 命中「借线」（条件门 + 概率门都过）'
      + (h1 ? '（第 ' + h1.seq + ' 次结算）' : ''));
    /* 「旧靴子」只认雨天 / 雾天，而这两个时段里「借线」也满足 —— 把其余事件推进冷却里，
       让候选只剩它一个（否则断言会变成「谁先过概率门谁赢」的运气题）。 */
    clean();
    coolExcept('boot');
    var h2 = firstHit(FOG);
    ok(h2 && h2.ev.id === 'boot', '有雾 ⇒ 命中「旧靴子」（其余事件都在冷却里，只剩它一个候选）');

    /* ---------- ③ 冷却 ---------- */
    clean();
    St.get().story.fired[h1.ev.id] = 1;
    St.get().story.at[h1.ev.id] = 1000000;
    var half = 1000000 + Math.round(h1.ev.cooldownMs / 2);
    ok(S7.tryFire({ field: 'D', wx: 'clear', tm: 'dusk', npc: h1.ev.npc, seq: h1.seq, now: half }) === null,
       '冷却期内同一条不再触发');
    var past = 1000000 + h1.ev.cooldownMs + 1;
    var again = S7.tryFire({ field: 'D', wx: 'clear', tm: 'dusk', npc: h1.ev.npc, seq: h1.seq, now: past });
    ok(again && again.id === h1.ev.id, '冷却过去之后又能触发（同一序号 ⇒ 同一掷点）');

    /* ---------- ④ once：一辈子一次 ---------- */
    clean();
    /* 把真事件全都推进冷却里 ⇒ 探针是唯一候选（否则得赌「比试」那条的掷点先不中，
       断言会因为一个跟 once 无关的原因时红时绿）。 */
    coolExcept('');
    var once = { id: 'zzz-once-probe', npc: DUSK.npc, title: '一次性', once: true,
                 cooldownMs: 1, chance: 1, cond: {}, reward: {}, lines: ['探测用'] };
    G.STORY_EVENTS.push(once);
    try {
      var pOnce = { field: DUSK.field, wx: 'clear', tm: 'day', npc: DUSK.npc, seq: 1, now: 0 };
      var got = S7.tryFire(pOnce);
      ok(got && got.id === once.id, 'once 事件第一次会出现（chance=1 必过）');
      St.get().story.fired[once.id] = 1;
      ok(S7.tryFire(pOnce) === null, 'once 事件写过一次之后永不再出现');
    } finally { G.STORY_EVENTS.pop(); }

    /* ---------- ⑤ 存档：字段与往返 ---------- */
    clean();
    ok(St.get().story && typeof St.get().story.fired === 'object',
       'blank() 里有 story 字段（容器齐备）');

    /* ---------- ⑥ consider() 的四道门 ---------- */
    G.Weather.snapshot = function () { return { wx: { key: 'fog' }, tm: { key: 'dusk' } }; };
    St.get().field = 'D';
    Fish7.hardReset();
    clean();
    St.setIdle(true);
    ok(S7.consider() === null, '挂机时不触发（人不在屏幕前，弹对话只会打断他回来后的操作）');
    St.setIdle(false);

    G.Panels = { isOpen: function () { return true; }, isCatchOpen: function () { return false; } };
    ok(S7.consider() === null, '面板开着时不触发（两层 modal 叠在一起会打架）');
    G.Panels = { isOpen: function () { return false; }, isCatchOpen: function () { return true; } };
    ok(S7.consider() === null, '结算卡还开着时不触发');
    /* 门都开了：面板层在测试的 DOM 桩下初始是「开着」的（stub 的 modal 元素没有 hidden 类），
       所以这里显式给一个「都关着」的桩 —— 真身 G.Panels 那套判定另有它自己的测试组。 */
    G.Panels = { isOpen: function () { return false; }, isCatchOpen: function () { return false; } };
    Fish7.hardReset();

    /* ---------- ⑦ 真触发：回调 / 记账 / 全局间隔 / 奖励不落地 ---------- */
    clean();
    var fired = null, gotNpc = null, gotRw = null;
    S7.init({ onEvent: function (ev, npc, rw) { fired = ev; gotNpc = npc; gotRw = rw; } });
    var cash = { coin: St.get().coin, medals: St.get().medals, eco: St.get().eco };
    for (var k = 0; k < 600 && !fired; k++) S7.consider();
    ok(!!fired, '条件合适时 consider() 真能触发一条事件');
    ok(gotNpc && gotNpc.name && gotNpc.tag, 'onEvent 回调收到 NPC 对象（对话面板要用它显示说话人）');
    ok(gotRw && typeof gotRw === 'object' && Object.keys(gotRw).length === 0,
       'onEvent 回调拿到的事件奖励是**空对象**（本轮纯剧情、零奖励）');
    ok(St.get().story.fired[fired.id] >= 1, '触发写进了存档：fired 计数 +1');
    ok(typeof St.get().story.at[fired.id] === 'number', '触发时刻也写进存档（冷却靠它算）');
    ok(S7.consider() === null, '全局最小间隔内不会紧接着再碰上一位邻居');
    ok(St.get().coin === cash.coin && St.get().medals === cash.medals && St.get().eco === cash.eco,
       '一次事件触发不动金币 / 纪念币 / 生态值（事件不是第二个经济系统）');

    /* ---------- ⑧ 存档往返：「这条我见过没」不该因为重开而忘 ---------- */
    St.save(true);
    St.load();
    ok(St.get().story.fired[fired.id] >= 1, '存档往返之后触发记录还在');

    /* ---------- ⑨ 场景层要的那份 NPC 数据 ---------- */
    var nb = S7.neighbor();
    ok(nb && typeof nb.x === 'number' && nb.x > 0 && nb.x < 1 && nb.name && nb.tag,
       'neighbor() 给出场景层要的站位与身份（x 是画布宽度比例）');
    ok(S7.neighbor() === nb, 'neighbor() 每次给同一个对象（场景每帧都拿它，不该新建）');

    /* ---------- ⑨-a 两位邻居与站位表（N7 五期） ----------
       🔴 「现在站着的是谁」只有一处回答（`curNpcId()`），它读的是内容表里的 `fields`。
       这里把**每一片钓场**都走一遍、跟站位表现算的人逐个对 —— 两处各判各的等于没判。 */
    var allIds = Object.keys(G.STORY_NPCS);
    ok(allIds.length >= 2, '内容表里有不止一位邻居（' + allIds.length + ' 位）—— 钓场不只一片');
    var byField = {};
    allIds.forEach(function (id) {
      (G.STORY_NPCS[id].fields || []).forEach(function (f) { byField[f] = id; });
    });
    ok(Object.keys(byField).length > 0, '有 NPC 列了站位表（fields）—— 一条都没有的话「谁在场」无从判起');
    var unreachable = allIds.filter(function (id) {
      var fs5 = G.STORY_NPCS[id].fields || [];
      return !fs5.some(function (f) {
        return G.FIELDS.some(function (ff) { return ff.id === f; });
      });
    });
    ok(unreachable.length === 0, '每位邻居都至少站得住一片**真钓场**（id 写错会让他凭空消失）'
      + (unreachable.length ? ' —— 站不住的是：' + unreachable.join('、') : ''));
    var mism = [];
    G.FIELDS.forEach(function (f) {
      St.get().field = f.id;
      var gotId = npcIdOf(S7.neighbor());
      var want = byField[f.id] || '';
      if (gotId !== want) mism.push(f.id + '：站位表说 ' + (want || '没人') + '、neighbor() 给 ' + (gotId || '没人'));
    });
    ok(mism.length === 0, '每一片钓场站的都正是站位表上那一位（' + Object.keys(byField).length + ' 片有人）'
      + (mism.length ? ' —— ' + mism.join('；') : ''));
    /* 没人站着的钓场（这里用一个不存在的 id 模拟）⇒ 不画人、也不抽签。
       ⚠️ 走 `consider()` 这条**真路径**（它自己从钓场现算「谁在场」），而不是手搓一个 npc 参数 ——
          手搓的话「没人时给空串」这条约定就永远验不到。 */
    clean();
    G.Weather.snapshot = function () { return { wx: { key: 'fog' }, tm: { key: 'dusk' } }; };
    St.get().field = 'ZZ-nosuch';
    var noneHere = null;
    for (var z1 = 0; z1 < 200 && !noneHere; z1++) noneHere = S7.consider();
    ok(S7.neighbor() === null, '没人站着的钓场：neighbor() 给 null（场景据此不画人）');
    ok(noneHere === null, '没人站着的钓场：consider() 一条都不触发（挡住它的是「谁在场」，不是概率）');
    St.get().field = 'D';

    /* ---------- ⑨-b 🔴 NPC 门：海边不会冒出内陆那位的事 ----------
       坏法全在**静默**里：画面上站着阿海、弹窗里却是老陈在说「借我一段线」。
       所以这里**同一组天气 / 时段**跑两遍：站在内陆那片要真的命中老陈的事（对照组），
       换到海那片则一件都不能有。只验「海边没有」的话，把事件条件写死成永不满足也会通过。 */
    clean();
    var hitsByNpc = function (field) {
      St.get().field = field;
      var bag = {};
      for (var i2 = 0; i2 < 300; i2++) {
        var e5 = S7.consider();
        if (e5) bag[e5.npc] = (bag[e5.npc] || 0) + 1;
      }
      return bag;
    };
    var bagD = hitsByNpc('D');
    clean();
    var bagA = hitsByNpc('A');
    ok(bagD[DUSK.npc] > 0, '同样的天气 / 时段，站在内陆那片 ⇒ 老陈的事真的会发生（对照组）');
    ok(!bagA[DUSK.npc], '换到海那片 ⇒ 老陈的事一件都不发生（NPC 门挡住串场）');
    St.get().field = 'D';
    clean();

    /* ---------- ⑩ 脏档兜底：story 被写成数字 / 字符串时不崩 ---------- */
    St.get().story = 5;
    var noThrow = '';
    try { S7.tryFire({ field: 'D', wx: 'fog', tm: 'dusk', npc: DUSK.npc, seq: 3, now: 0 }); }
    catch (e) { noThrow = e.message; }
    ok(noThrow === '', '存档里的 story 是数字时 tryFire() 不抛（脏档兜底）'
      + (noThrow ? ' —— ' + noThrow : ''));
    clean();

    /* ---------- ⑪ 主动搭话（N7 二期）：不走概率、轮流说话、计数落盘 ---------- */
    St.get().field = 'D';                       /* 老陈站得住的那片（N7 五期起按钓场挑人） */
    var npcId = npcIdOf(S7.neighbor());
    ok(npcId === 'chen' || !!npcId, 'neighbor() 给出的那一位能反查出 id（' + npcId + '）');
    var pool = G.STORY_NPCS[npcId].talk;
    ok(Array.isArray(pool) && pool.length > 1,
       'NPC 有闲聊池（' + (Array.isArray(pool) ? pool.length : 0) + ' 句）—— 点他才有回应');

    var d1 = S7.talk();
    ok(d1 && d1.npc === G.STORY_NPCS[npcId], 'talk() 给出对话载荷，NPC 就是内容表里那一位');
    ok(d1 && Array.isArray(d1.lines) && d1.lines.length === 1
      && typeof d1.lines[0] === 'string' && d1.lines[0].trim(),
       'talk() 一次只给一句非空台词（搭话是顺手动作，不弹一大段）');
    ok(St.get().story && typeof St.get().story.talk === 'object',
       'blank() 的 story 里有 talk 容器（搭话计数有处可存）');
    ok(d1.lines[0] === pool[0], '第一次搭话给池子第一句（计数从 0 起、取模）');

    /* 另一位邻居：talk() 跟的必须是**当前钓场站着的那位**，而且计数按 NPC 分开记
       （两个人各自的进度互不干扰）—— 这是「按钓场挑人」在搭话这条路上的可观测证据。 */
    var otherId = '';
    for (var oi = 0; oi < allIds.length; oi++) if (allIds[oi] !== npcId) otherId = allIds[oi];
    if (otherId) {
      var chenCount = St.get().story.talk[npcId];
      St.get().field = G.STORY_NPCS[otherId].fields[0];
      var dOther = S7.talk();
      ok(dOther && dOther.npc === G.STORY_NPCS[otherId],
         '换到另一个钓场 ⇒ 搭话换成那一位（不是「列表里第一个」）');
      ok(St.get().story.talk[otherId] === 1,
         '另一位的搭话次数记在它自己的键上（s.story.talk.' + otherId + '）');
      ok(St.get().story.talk[npcId] === chenCount,
         '另一位说话不动前一位的进度（计数按 NPC 分开记）');
      St.get().field = 'D';
    }

    /* 同一次点击在同一份存档上必须给同一句 —— 这是「不用随机数」的可观测证据 */
    St.get().story.talk[npcId] = 0;
    ok(S7.talk().lines[0] === d1.lines[0], '同一份存档 + 同一个计数 ⇒ 同一句（搭话不掷骰子）');

    /* 连点会走遍池子，不会卡在第一句 */
    St.get().story.talk[npcId] = 0;
    var seen = [];
    for (var q = 0; q < pool.length; q++) seen.push(S7.talk().lines[0]);
    ok(seen.join('\u0001') === pool.join('\u0001'),
       '连点 ' + pool.length + ' 次正好按表顺序走遍闲聊池');
    ok(St.get().story.talk[npcId] === pool.length, '搭话次数写进了存档（下次接着往下轮）');

    St.save(true);
    St.load();
    ok(St.get().story.talk[npcId] === pool.length, '存档往返之后搭话计数还在');

    /* 🔴 「立刻落盘」要**读盘**验，不能只验内存里的 S ——
       第一版只验了 `save(true) + load()`，反向验证当场抓到：把引擎里那句 save 删掉，
       这条照样是绿的（`save(true)` 自己会把内存整个写下去）。
       真正的口径是「玩家在自动保存那 1.2 秒节流窗口内关掉页面，这句也算数」。 */
    function diskTalk() {
      var k = (G.Profile && G.Profile.key) ? G.Profile.key() : CFG.saveKey;
      var raw = localStorage.getItem(k);
      if (!raw) return -1;
      try {
        var o = JSON.parse(raw);
        return (o.story && o.story.talk && o.story.talk[npcId]) || 0;
      } catch (e) { return -2; }
    }
    St.get().story.talk = {};
    St.save(true);
    var before = diskTalk();
    S7.talk();
    ok(before === 0 && diskTalk() === 1,
       '搭话**立刻落盘**（不等自动保存的节流窗口）—— 盘上 before=' + before + ' after=' + diskTalk());

    /* 经济红线：搭话不是第二个经济系统（与事件那条同一个口径） */
    var cash2 = { coin: St.get().coin, medals: St.get().medals, eco: St.get().eco };
    S7.talk();
    ok(St.get().coin === cash2.coin && St.get().medals === cash2.medals && St.get().eco === cash2.eco,
       '主动搭话不动金币 / 纪念币 / 生态值');

    /* 没有池子 / 脏档：给 null 或至少不抛（调用方据此落回「抛竿」，而不是弹空白对话卡） */
    var keepPool = G.STORY_NPCS[npcId].talk;
    delete G.STORY_NPCS[npcId].talk;
    var noPool = '';
    try { noPool = S7.talk(); } catch (e) { noPool = 'throw:' + e.message; }
    ok(noPool === null, 'NPC 没闲聊池时 talk() 给 null（不弹空白对话卡）');
    G.STORY_NPCS[npcId].talk = keepPool;

    St.get().story.talk = 7;
    var talkThrow = '';
    try { S7.talk(); } catch (e) { talkThrow = e.message; }
    ok(talkThrow === '', '存档里的 talk 是数字时 talk() 不抛（脏档兜底）'
      + (talkThrow ? ' —— ' + talkThrow : ''));
    clean();

    /* ---------- ⑫ 有分支的互动（N7 三期）：选项记账 + 后续事件按选择开门 ---------- */
    var brEv = null, gated = null;
    for (var bi = 0; bi < G.STORY_EVENTS.length; bi++) {
      var bEv = G.STORY_EVENTS[bi];
      if (!brEv && bEv.choices && bEv.choices.length) brEv = bEv;
      if (!gated && bEv.need) gated = bEv;
    }
    ok(!!brEv, '内容表里有带 choices 的事件（有分支的互动在位）');
    ok(!!gated, '内容表里有靠 need 开门的事件（选择真的要能改世界）');

    clean();
    /* 老档（story 里还没有 pick）走一次判定就会被 `rec()` 补成容器 —— 与 talk 那条同款 */
    S7.tryFire({ field: 'D', wx: 'clear', tm: 'day', npc: DUSK.npc, seq: 1, now: 0 });
    ok(St.get().story && typeof St.get().story.pick === 'object',
       '缺 pick 的（老）存档会被兜底补成容器（选项计数有处可存）');

    var db = S7.choose(brEv, 0);
    ok(db && db.npc === G.STORY_NPCS[brEv.npc], 'choose() 给出下一段载荷，说话人就是这条事件的 NPC');
    ok(db && db.title === brEv.title, '下一段带着这条事件的标题（面板不会半路降级成「搭话」）');
    ok(db && Array.isArray(db.lines) && db.lines.length
      && db.lines.join('|') === brEv.choices[0].lines.join('|'),
       '给的是**被选中那一项**的台词（不是别项的、也不是开场那段）');
    ok(St.get().story.pick[brEv.id] && St.get().story.pick[brEv.id][0] === 1,
       '选择写进了存档：pick[事件][选项] 计数 = 1');

    var db2 = S7.choose(brEv, 0);
    ok(db2.lines.join('|') === db.lines.join('|'), '同一项两次给出同一段台词（选项台词不掷骰子）');
    ok(St.get().story.pick[brEv.id][0] === 2, '再选一次是**累加**而不是覆盖（先前的选择留得住）');

    /* 计数数组必须是**密集**的：稀疏数组 JSON 化会写成 `[null,1]` —— 存档读起来像坏数据 */
    clean();
    S7.choose(brEv, 1);
    var arrPick = St.get().story.pick[brEv.id];
    ok(Array.isArray(arrPick) && arrPick.length === brEv.choices.length
      && arrPick.every(function (n) { return typeof n === 'number'; }),
       '选项计数数组是密集的（长度 = 选项数、每项都是数字，不会 JSON 成 [null,1]）');

    ok(S7.choose(brEv, brEv.choices.length) === null, '越界的选项下标给 null（调用方收起面板，不猜一项）');
    ok(S7.choose(brEv, -1) === null, '负数下标也给 null');
    var noCh = { id: 'zzz-no-choices', npc: brEv.npc, title: 'x', once: false,
                 cooldownMs: 1, chance: 1, cond: {}, reward: {}, lines: ['探测用'] };
    G.STORY_EVENTS.push(noCh);
    var rNo = '';
    try { rNo = S7.choose(noCh, 0); } catch (e) { rNo = 'throw:' + e.message; }
    G.STORY_EVENTS.pop();
    ok(rNo === null, '没有 choices 的事件调 choose() 给 null（不抛）');
    var emptyOpt = { id: 'zzz-empty-opt', npc: brEv.npc, title: 'x', once: false, cooldownMs: 1,
                     chance: 1, cond: {}, reward: {}, lines: ['探测用'],
                     choices: [{ label: '甲', lines: [] }, { label: '乙', lines: ['探测用'] }] };
    G.STORY_EVENTS.push(emptyOpt);
    var rEmpty = '';
    try { rEmpty = S7.choose(emptyOpt, 0); } catch (e) { rEmpty = 'throw:' + e.message; }
    G.STORY_EVENTS.pop();
    ok(rEmpty === null, '选项没台词时给 null（不弹一张空白对话卡）');

    /* 🔴 「选择真的改了世界」：把分支与它打开的那条事件**双向**验一遍 ——
       只验「选了之后会出现」会让「门恒开」也通过（那样选项就成了装饰）。 */
    var brBase = { field: 'D', wx: 'clear', tm: (gated.cond.tm && gated.cond.tm[0]) || 'day', npc: gated.npc };
    function seqHit(ev, base) {
      for (var s = 1; s <= 600; s++) {
        var pp = { field: base.field, wx: base.wx, tm: base.tm, npc: base.npc, seq: s, now: 0 };
        var got2 = S7.tryFire(pp);
        if (got2 && got2.id === ev.id) return s;
      }
      return 0;
    }
    clean();
    ok(seqHit(gated, brBase) === 0, '还没做过那次选择 ⇒ 靠 need 开门的事件一次都不出现');
    S7.choose(brEv, 0);
    ok(seqHit(gated, brBase) > 0, '选了它要的那一项之后 ⇒ 它真的会来（选择改了世界）');
    clean();
    S7.choose(brEv, 1);
    ok(seqHit(gated, brBase) === 0,
       '选了另一项 ⇒ 那条事件仍然不出现（门认的是**哪一项**，不是「选过就算」）');

    /* 立刻落盘：**读盘**验（与 talk 那条同款 —— 只验 save(true)+load() 无论如何都是绿的） */
    function diskPick() {
      var k2 = (G.Profile && G.Profile.key) ? G.Profile.key() : CFG.saveKey;
      var raw = localStorage.getItem(k2);
      if (!raw) return -1;
      try {
        var o = JSON.parse(raw);
        var a = o.story && o.story.pick && o.story.pick[brEv.id];
        return (a && a[0]) || 0;
      } catch (e) { return -2; }
    }
    clean();
    St.save(true);
    var pickBefore = diskPick();
    S7.choose(brEv, 0);
    ok(pickBefore === 0 && diskPick() === 1,
       '选择**立刻落盘**（不等自动保存的节流窗口）—— 盘上 before=' + pickBefore + ' after=' + diskPick());

    St.save(true);
    St.load();
    ok(St.get().story.pick[brEv.id] && St.get().story.pick[brEv.id][0] >= 1,
       '存档往返之后选项计数还在');

    var cash3 = { coin: St.get().coin, medals: St.get().medals, eco: St.get().eco };
    S7.choose(brEv, 0);
    ok(St.get().coin === cash3.coin && St.get().medals === cash3.medals && St.get().eco === cash3.eco,
       '分支选择不动金币 / 纪念币 / 生态值（选项不是第二个经济系统）');

    St.get().story.pick = 7;
    var pickThrow = '';
    try { S7.choose(brEv, 0); } catch (e) { pickThrow = e.message; }
    ok(pickThrow === '', '存档里的 pick 是数字时 choose() 不抛（脏档兜底）'
      + (pickThrow ? ' —— ' + pickThrow : ''));
    ok(Array.isArray(St.get().story.pick[brEv.id]),
       '脏档被纠正成数组（否则选项计数写不进去）');
    clean();

    /* ---------- ⑬ 限时比试（N7 四期）：开赛 / 记账 / 到点结算 ----------
       用的是**真内容表**那条（不加探针）：`consider()` 在「常规钓场 + 白天」下只会命中它
       —— `borrow` 要傍晚、`boot` 要有雾、`repay` 要先前借过线（`clean()` 把 pick 清了）。 */
    var duelEv = null;
    for (var di = 0; di < G.STORY_EVENTS.length; di++) {
      if (G.STORY_EVENTS[di].duel) { duelEv = G.STORY_EVENTS[di]; break; }
    }
    ok(!!duelEv, '内容表里有办限时比试的事件（比试在位）');
    ok(!!(duelEv && Array.isArray(duelEv.duel.win) && duelEv.duel.win.length
      && Array.isArray(duelEv.duel.lose) && duelEv.duel.lose.length),
      '比试配了赢 / 输两段结算台词（缺一边 = 那种结果永远说不出话）');

    G.Weather.snapshot = function () { return { wx: { key: 'clear' }, tm: { key: 'day' } }; };
    St.get().field = 'D';
    G.Panels = { isOpen: function () { return false; }, isCatchOpen: function () { return false; } };
    Fish7.hardReset();
    St.setIdle(false);

    /* 开赛要**扫**序号（内容表的 chance < 1 ⇒ 单次 consider() 多半不中，
       而「没中就当成没开赛」会让下面一堆断言**因为错误的原因**通过）。
       ⚠️ 从 seq=1 往下扫，不写死数字：改一次概率 / 台词都不会让这组用例失效。 */
    function fireDuel() {
      for (var n2 = 0; n2 < 600; n2++) { var e2 = S7.consider(); if (e2) return e2; }
      return null;
    }

    /* ① 开赛 */
    clean();
    var duelFired = fireDuel();
    ok(!!duelFired && duelFired.id === duelEv.id, '条件合适时真的会开一场比试');
    var inf1 = S7.duelInfo();
    ok(!!inf1, '开赛之后 duelInfo() 有数据（顶栏那枚倒计时芯片才有东西可显示）');
    ok(!!(inf1 && typeof inf1.target === 'number' && inf1.target > 0), '他这条鱼的重量是个正数');
    ok(!!(inf1 && typeof inf1.name === 'string' && inf1.name.trim()),
       '他这条鱼有名字（结算台词要念出来）');
    ok(!!(inf1 && inf1.best === 0 && inf1.casts === 0), '刚开赛时你这边还是空的');
    ok(!!(inf1 && inf1.leftMs > 0), '窗口还没到点（leftMs > 0）');
    ok(!!(St.get().story.duel && St.get().story.duel.end > 0),
       '窗口结束时刻写进了存档（story.duel.end）—— 关掉页面再回来这场还认');
    var tgt1 = inf1.target;

    /* ② 可复现：清掉推进态、同一组条件与序号 ⇒ 他永远是同一条同重的鱼（口径①） */
    S7.reset(); clean();
    fireDuel();
    ok(!!(S7.duelInfo() && S7.duelInfo().target === tgt1),
       '同一份存档 + 同一组条件 + 同一个序号 ⇒ 他永远是同一条同重的鱼（不用随机数）');

    /* ③ 窗口内上的鱼要算进来（`main.js` 的 onCatch 就是喂这一口） */
    S7.noteCatch(tgt1 / 2);
    ok(St.get().story.duel.best === tgt1 / 2 && St.get().story.duel.casts === 1,
       'noteCatch() 把这一竿的重量记进 best / casts');
    S7.noteCatch(tgt1 / 4);
    ok(St.get().story.duel.best === tgt1 / 2 && St.get().story.duel.casts === 2,
       '再来一条更轻的：best 取**最大**、casts 照样累加');

    /* ④ 挂机上的鱼不算（比的是「你亲手钓」） */
    St.setIdle(true);
    var idleRec = S7.noteCatch(tgt1 * 99);
    St.setIdle(false);
    ok(idleRec === false && St.get().story.duel.best === tgt1 / 2,
       '挂机时上的鱼不计入比试（否则开着挂机就能刷掉这一场）');

    /* ⑤ 「立刻落盘」要**读盘**验 —— 只验内存的话，把引擎里那句 save 删掉照样是绿的 */
    function diskDuelBest() {
      var k3 = (G.Profile && G.Profile.key) ? G.Profile.key() : CFG.saveKey;
      var raw = localStorage.getItem(k3);
      if (!raw) return -1;
      try {
        var o3 = JSON.parse(raw);
        var d3 = o3.story && o3.story.duel;
        return (d3 && typeof d3.best === 'number') ? d3.best : 0;
      } catch (e) { return -2; }
    }
    clean();
    fireDuel();
    var tgtDisk = S7.duelInfo().target;
    St.save(true);
    S7.noteCatch(tgtDisk / 8);
    ok(diskDuelBest() === tgtDisk / 8,
       '比试里的渔获**立刻落盘**（不等自动保存的节流窗口）—— 盘上 best=' + diskDuelBest());
    St.load();
    ok(St.get().story.duel.best === tgtDisk / 8, '存档往返之后这一场的成绩还在');

    /* ⑥ 🔴 一次只比一场：已有**未结算**的比试时，`tryFire` 必须跳过办比试的事件。
       **双向**验（只验一边会让「守卫写成恒真」也通过）—— 门是数据上的，不是注释。 */
    function seqHitDuel() {
      for (var s2 = 1; s2 <= 600; s2++) {
        var got3 = S7.tryFire({ field: 'D', wx: 'clear', tm: 'day', npc: duelEv.npc, seq: s2, now: 0 });
        if (got3 && got3.id === duelEv.id) return s2;
      }
      return 0;
    }
    clean();
    ok(seqHitDuel() > 0, '没有进行中的比试 ⇒ 办比试的事件能出现');
    St.get().story.duel = { id: duelEv.id, end: 1e15 };
    ok(seqHitDuel() === 0,
       '已经有一场没结算 ⇒ 不再开第二场（少了这条守卫，第二场会把第一场整个覆盖）');

    /* ⑦ 没到点不结算；三道门（打断钓鱼 / 挂机 / 面板）也都不结算 */
    clean();
    fireDuel();
    ok(!!S7.duelInfo(), '开了一场新的，窗口真的在进行中');
    ok(S7.settleDuel() === null, '窗口还没到点 ⇒ 不结算');
    St.get().story.duel.end = 1;                       /* 把窗口拨到过去 */
    Fish7.press();                                     /* idle → flying：玩家手里正忙 */
    ok(S7.settleDuel() === null, '玩家手里那一竿还没收（非 idle）⇒ 不结算，不打断');
    ok(!!S7.duelInfo(), '没结算时窗口还在（不会「闪一下就没」）');
    Fish7.hardReset();
    St.setIdle(true);
    ok(S7.settleDuel() === null, '挂机时不结算（人不在屏幕前，弹面板只会打断他回来后的操作）');
    St.setIdle(false);
    G.Panels = { isOpen: function () { return true; }, isCatchOpen: function () { return false; } };
    ok(S7.settleDuel() === null, '面板开着时不结算（两层 modal 叠在一起会打架）');
    G.Panels = { isOpen: function () { return false; }, isCatchOpen: function () { return false; } };

    /* ⑧ 到点结算：赢的那一侧 */
    var gotEv = null;
    S7.init({ onEvent: function (ev) { gotEv = ev; } });
    St.get().story.duel.end = 1;
    S7.noteCatch(tgt1 * 2);                            /* 比他那条沉 ⇒ 赢 */
    var before4 = { coin: St.get().coin, medals: St.get().medals, eco: St.get().eco };
    var out1 = S7.settleDuel();
    /* 判「给的是哪一侧」：把模板按占位符切开，**每一段原文都要在填好的台词里按序出现**
       —— 这样台词一个字不改也认得出，而且不写死任何句式（改文案这边不用跟着改）。 */
    var fromTpl = function (tpl, filled) {
      var parts = tpl.split(/\{[a-z]+\}/).filter(function (x) { return x.length; });
      var pos = 0;
      for (var pi = 0; pi < parts.length; pi++) {
        var at = filled.indexOf(parts[pi], pos);
        if (at < 0) return false;
        pos = at + parts[pi].length;
      }
      return true;
    };
    var sameSide = function (tpl, got) {
      return tpl.length === got.length && tpl.every(function (t, i) { return fromTpl(t, got[i]); });
    };
    ok(!!out1, '到点 + 前三条门都开 ⇒ 真结算');
    ok(!!out1 && sameSide(duelEv.duel.win, out1.lines),
       '结算给出的是**赢**那一侧（占位符换成了真数字，台词本身没被改写）');
    ok(!!out1 && !sameSide(duelEv.duel.lose, out1.lines), '赢的时候不会误用输的那段台词');
    ok(!!out1 && out1.lines.join('').indexOf('{') < 0,
       '结算台词里的占位符**都被替换掉了**（写错名字会把 `{xxx}` 原样念给玩家听）');
    ok(!!out1 && out1.lines.join('|').indexOf(G.U.kg(tgt1)) >= 0,
       '台词里真的出现了**他的重量**（比完了看得出谁重）');
    ok(!!out1 && out1.lines.join('|').indexOf(G.U.kg(tgt1 * 2)) >= 0,
       '台词里真的出现了**你的成绩**');
    ok(gotEv === out1, '结算结果走的是同一个对话回调（UI 层不必认识比试）');
    ok(S7.duelInfo() === null, '结算完窗口就收起来了（顶栏芯片跟着消失）');
    ok(St.get().story.duel.end === 0 && St.get().story.duel.best === 0
      && St.get().story.duel.target === 0,
       '窗口字段被清零 —— 否则「已有未结算的比试」那道守卫会永久挡住下一场');
    ok(St.get().story.duel.wins === 1 && St.get().story.duel.losses === 0,
       '战绩记了一笔胜，而且**两个数都在**（只写赢的那个的话，存档里就是 {wins:1}）');
    ok(St.get().coin === before4.coin && St.get().medals === before4.medals
      && St.get().eco === before4.eco,
       '比试结算不动金币 / 纪念币 / 生态值（比试不是第二个经济系统）');

    /* ⑨ 输的那一侧 + 平局算他赢 + 战绩不被下一场清掉 */
    S7.reset();
    clean();
    St.get().story.duel = { id: duelEv.id, end: 1, name: '探测鱼', target: 5, best: 5, casts: 1,
                            wins: 1, losses: 0 };
    var out2 = S7.settleDuel();
    ok(!!out2 && out2.lines.join('|').indexOf(G.U.kg(5)) >= 0,
       '成绩**等于**他的重量时算他赢（平局算他赢：严格大于才算你赢）');
    ok(!!out2 && St.get().story.duel.losses === 1 && St.get().story.duel.wins === 1,
       '输了一笔照记，**先前的胜场没有被清零**');
    ok(!!out2 && St.get().story.duel.wins === 1 && St.get().story.duel.losses === 1,
       '战绩两边都在（稀疏的存档读起来像坏数据）');
    /* 脏值：wins 是字符串时 `+1` 会变成**拼接**（"3"+1 === "31"），而且不报错 */
    clean();
    St.get().story.duel = { id: duelEv.id, end: 1, name: '探测鱼', target: 5, best: 0, casts: 0,
                            wins: '3', losses: -7 };
    S7.settleDuel();
    ok(St.get().story.duel.losses === 1 && St.get().story.duel.wins === 0,
       '战绩是脏值（字符串 / 负数）时先归一化再自增（否则会变成 "31"）');
    /* 一条都没上时，`{best}` 要写成「空手」而不是 `0 g`（0 g 看着像一条真鱼） */
    clean();
    St.get().story.duel = { id: duelEv.id, end: 1, name: '探测鱼', target: 5, best: 0, casts: 0,
                            wins: 0, losses: 0 };
    var out3 = S7.settleDuel();
    ok(!!out3 && out3.lines.join('|').indexOf('空手') >= 0,
       '一条都没上时台词写「空手」而不是 `0 g`（0 g 看着像一条真鱼）');

    /* ⑩ 脏档：story.duel 是数字 / 字符串时不抛 */
    St.get().story.duel = 7;
    var duelThrow = '';
    try { S7.settleDuel(); S7.duelInfo(); S7.noteCatch(1); }
    catch (e) { duelThrow = e.message; }
    ok(duelThrow === '', '存档里的 duel 是数字时 settleDuel / duelInfo / noteCatch 都不抛'
      + (duelThrow ? ' —— ' + duelThrow : ''));
    /* ---------- ⑬ 上一竿的结局（N7 六期）----------
       `cond.after` = 「只在刚丢了鱼之后才开口」。它有两件事要钉：
       ① **丢竿那条路必须是通的** —— 曾因 `fishing.js` 的时序（先回调、后收尾）整条死掉；
       ② 那道门要真的按「引擎收到的结局」开关，而且**不改变别的事件的掷点**。 */

    /* ⑬-a 🔴 行为级：驱动**一次真的丢竿**，看回调那一刻钓鱼状态收尾了没有。
       这条断言抓的是「`consider()` 的 idle 门在丢竿回调里恒不通过」那个静默失效 ——
       引擎那一侧永远看不出来（轮都轮不到它），只有真跑一遍才露头。 */
    G.Goals.init();                       /* resolve() 会调 Goals.check()，先让它就位 */
    if (St.get().settings.idle) St.setIdle(false);
    var missState = '?', missResult = '';
    Fish7.hardReset();
    Fish7.init({ onMiss: function (r) { missState = Fish7.getState(); missResult = r; } });
    try {
      Fish7.cast();
      var pend7 = Fish7.getPending();
      Fish7.update(1.0);                       /* flying → waiting */
      Fish7.update(pend7.wait + 0.001);        /* waiting → bite */
      Fish7.update(99);                        /* 不提竿 ⇒ 咬口窗口走完 */
    } finally { Fish7.init({}); }
    ok(missResult === 'miss', '驱动出的确实是「错过咬口」这一种丢竿（实测 ' + missResult + '）');
    ok(missState === 'idle', '丢竿回调里钓鱼状态**已经收尾**（idle）—— 否则 consider() 的 idle 门'
      + '恒不通过，「丢了一竿」这条触发路整条是死的，而且不报错（实测 ' + missState + '）');

    /* ⑬-b 门的行为：取内容表里**真带这道门**的事件现算（不写死 id / 值域） */
    var afterEvs = [];
    G.STORY_EVENTS.forEach(function (e) {
      if (e.cond && Array.isArray(e.cond.after)) afterEvs.push(e);
    });
    ok(afterEvs.length > 0, '内容表里至少有一条事件带「上一竿的结局」这道门');
    ok(afterEvs.every(function (e) { return e.cond.after.length > 0; }),
      '带这道门的事件都列了非空数组（空数组 = 永远不匹配 = 白写一条）');

    function probeHit(base, after) {
      for (var s = 1; s <= 600; s++) {
        var pp = { field: base.field, wx: base.wx, tm: base.tm, npc: base.npc,
                   after: after, seq: s, now: 0 };
        var got9 = S7.tryFire(pp);
        if (got9) return { seq: s, ev: got9 };
      }
      return null;
    }
    /* 老陈那片 + 大晴天正午（他另外两条事件都要傍晚 / 有雾 ⇒ 不会来抢） */
    var A9 = { field: 'D', wx: 'clear', tm: 'day', npc: 'chen' };
    var slipEv = null;
    afterEvs.forEach(function (e) { if (e.npc === 'chen') slipEv = e; });
    ok(!!slipEv, '老陈有一条带这道门的事件（跑鱼那条）');
    clean();
    coolExcept(slipEv ? slipEv.id : '');
    ok(probeHit(A9, undefined) === null, '**不带**结局时（= 结算卡关闭那条路）这条门恒关：一次都不出现');
    ok(probeHit(A9, '') === null, '结局是空串同样不出现（空串 = 没带，不是「随便哪种都行」）');
    ok(probeHit(A9, 'success') === null, '结局是值域外的东西（上鱼那一类）不出现');
    var hitSnap = probeHit(A9, 'snap');
    ok(!!hitSnap && hitSnap.ev.id === slipEv.id, '断线之后 ⇒ 他真会开口（门按引擎收到的那一个结局开）');
    var hitEsc = probeHit(A9, 'escape');
    ok(!!hitEsc && hitEsc.ev.id === slipEv.id, '脱钩之后同样会开口（这条门列了两种结局）');
    ok(slipEv.cond.after.indexOf('miss') < 0 && probeHit(A9, 'miss') === null,
      '没抓住咬口时**不**开口（这条门没列那个值；列了才该开口 —— 门不替你看语境）');

    /* 掷点与结局**无关**：它是门，不是条件指纹（否则加一道门会挪动别的事件的掷点） */
    var rollA = S7.rollFor(slipEv, { field: 'D', wx: 'clear', tm: 'day', seq: 9, now: 0, after: 'snap' });
    var rollB = S7.rollFor(slipEv, { field: 'D', wx: 'clear', tm: 'day', seq: 9, now: 0 });
    ok(rollA === rollB, '掷点不看「上一竿的结局」（它是门，不是条件指纹 —— 加门不会改掉别的事件的掷点）');

    /* ⑬-c 顺序真的有作用：反应句排在最前，同一次结算里别人抢不走它。
       ⚠️ 不能只断言「排最前那条赢了」—— 没有对手时它赢是废话。所以先造一个
       「两条都该赢」的序号：把反应句**临时挪到表尾**就能观察出对手是谁，
       再把顺序排回来 ⇒ 同一个序号上赢的必须换回反应句。 */
    clean();                                  /* 两条候选都留着（不推进冷却） */
    var comp = null;
    var rIdx = G.STORY_EVENTS.indexOf(slipEv);
    G.STORY_EVENTS.splice(rIdx, 1);
    G.STORY_EVENTS.push(slipEv);
    try {
      for (var s10 = 1; s10 <= 600 && !comp; s10++) {
        var pT = { field: 'D', wx: 'clear', tm: 'dusk', npc: 'chen', after: 'snap', seq: s10, now: 0 };
        var gT = S7.tryFire(pT);
        if (gT && gT.id !== slipEv.id && S7.rollFor(slipEv, pT) < slipEv.chance) {
          comp = { seq: s10, id: gT.id };
        }
      }
    } finally {
      G.STORY_EVENTS.pop();
      G.STORY_EVENTS.splice(rIdx, 0, slipEv);
    }
    ok(!!comp, '反向对照成立：有别的候选会在同一个序号上赢过它'
      + '（没有这条前提的话，「排最前」那条断言等于没验）');
    var backHit = comp
      ? S7.tryFire({ field: 'D', wx: 'clear', tm: 'dusk', npc: 'chen', after: 'snap',
                     seq: comp.seq, now: 0 })
      : null;
    ok(!!backHit && backHit.id === slipEv.id,
      '排回最前之后，同一个序号上赢的又是它（顺序 = 反应句的优先级，实打实）');

    /* ⑬-d 走**真正的那条路**：`consider(结局)` 能触发；不带结局（结算卡关闭那一路）不能。
       天气 / 钓场都换成受控值，其余事件全推进冷却里 ⇒ 只剩反应句一个候选。 */
    G.Weather.snapshot = function () { return { wx: { key: 'clear' }, tm: { key: 'day' } }; };
    St.get().field = 'D';
    Fish7.hardReset();
    clean(); coolExcept(slipEv.id);
    S7.reset();
    var condHit = null;
    for (var q9 = 0; q9 < 600 && !condHit; q9++) condHit = S7.consider('snap');
    ok(!!condHit && condHit.id === slipEv.id && Array.isArray(condHit.lines) && condHit.lines.length > 0,
      '丢竿之后 consider(结局) 真能触发反应句，而且带得出台词（面板不会弹空卡）');
    clean(); coolExcept(slipEv.id);
    S7.reset();
    var noOut = null;
    for (var q10 = 0; q10 < 600 && !noOut; q10++) noOut = S7.consider();
    ok(noOut === null, '不带结局时（= 上鱼 / 卖鱼之后的结算卡关闭那一路）反应句一次都不出现');
    clean(); coolExcept(slipEv.id);
    S7.reset();
    var dirtHit = null;
    for (var q11 = 0; q11 < 600 && !dirtHit; q11++) dirtHit = S7.consider(123);
    ok(dirtHit === null, '结局传了个数字（脏值）⇒ 当「没带」处理，门不会意外打开（也不抛）');

    clean();
    S7.init({});
  } finally {
    /* 恢复现场：引擎内存态、天气桩、面板层、存档里的触发记录、idle 开关 */
    G.Weather.snapshot = realSnap;
    G.Panels = realPanels;
    S7.init({});
    S7.reset();
    St.get().story = { fired: {}, at: {} };
    if (St.get().settings.idle) St.setIdle(false);
    Fish7.hardReset();
  }
})();

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(52));
if (fail) { console.log(`\u2716 测试未通过：${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
console.log(`\u2714 全部通过：${pass} 项\n`);
