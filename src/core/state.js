/* =========================================================
   state.js  —  存档 / 进度 / 图鉴 / 商店逻辑
   ========================================================= */
window.G = window.G || {};

G.State = (function () {
  var U = G.U, CFG = G.CONFIG;

  var S = null;          // 当前存档对象
  var saveTimer = null;
  var listeners = [];

  /* 存档结构版本。改动存档字段时把它 +1，并在 migrate() 里补一条分支。
     版本 2：新增 net / tank / netCap / tankCap / netEx / tankEx
     版本 3：新增每日任务 / 纪念币 / 称号，以及 stats 的分维计数
             （byRar / byField / byBait / byWx / byTm / streak / maxStreak）
     版本 4：新增新手引导进度 tut（老存档直接视为「已看过」，不刷教学气泡）
     版本 5：新增周常挑战 weekly（与每日任务同一套派生逻辑；
             老存档留 null，由 G.Goals.init() 按 ISO 周键自动生成，无需迁移数据） */
  var SAVE_V = 5;

  /* 数字兜底：任何来自存档或计算的数值都要过一遍，
     否则 NaN 会被 JSON.stringify 写成 null，静默污染整个存档。 */
  function safeNum(v, dft) {
    v = Number(v);
    return isFinite(v) ? v : (dft || 0);
  }

  /* 新手引导一共几步 —— 只由 config 决定，存档里不冗余记录 */
  function tutStepCount() {
    return (CFG.tutorial && CFG.tutorial.steps) ? CFG.tutorial.steps.length : 0;
  }

  function blank() {
    var baits = {};
    G.BAITS.forEach(function (b) { baits[b.id] = b.free ? -1 : 0; });
    return {
      v: SAVE_V,
      coin: CFG.economy.startCoin,
      playTime: 0,
      field: 'D',
      unlocked: { D: true },
      book: {},                        // fishId -> {n, maxKg, colors:{}, first}
      baits: baits,
      baitSel: 'worm',
      rods: ['bamboo'],
      rodSel: 'bamboo',
      lines: ['n2'],
      lineSel: 'n2',
      decors: [],
      net: [],                         // 鱼护：[{f:鱼种id, kg, c:颜色key}]
      tank: [],                        // 水族箱：同上，从鱼护转移进来
      netCap: CFG.storage.netCap,
      tankCap: CFG.storage.tankCap,
      netEx: 0,                        // 已扩容次数（用于取价格）
      tankEx: 0,
      locked: [],                      // 隐藏钓场被「发现」时记录，用于解锁提示
      /* ---- 长线目标（v3 / v5）---- */
      daily: null,                     // 当日任务（由 G.Goals 生成，跨天自动重掷）
      weekly: null,                    // 本周挑战（v5，由 G.Goals 按 ISO 周键生成）
      medals: 0,                       // 纪念币：只能换限定装饰（纯外观）
      eco: 0,                          // 生态值：放生得到的收集货币，只能换限定装饰
      tankSec: 0,                      // 水族箱被动收益的「未结算秒数」余量
      tankFrac: 0,                     // 水族箱被动收益的「不足 1 金的零头」
      medalSeen: {},                   // 已播报过的纪念币里程碑
      titleSel: '',                    // 佩戴中的称号 id
      achSeen: [],                     // 已播报过的成就 id（成就是纯派生的，不存状态）
      achInit: false,                  // 老存档首次接入成就系统时静默补登记
      /* ---- 新手引导（v4）----
         step = 已经学会的步数（0 = 还没开始，= config.tutorial.steps.length = 全学会）
         done = 是否已完成（完成后永不再弹，设置里可重看） */
      tut: { step: 0, done: false },
      stats: {
        casts: 0, catches: 0, escapes: 0, snaps: 0, idleCatches: 0,
        maxKg: 0, maxKgFish: '', totalValue: 0, days: 0,
        /* 分维计数：供每日任务 / 成就取数（不要删，Goals 依赖它们） */
        byRar: [0, 0, 0, 0],           // 各稀有度的钓获条数
        byField: {},                   // 各钓场钓获条数
        byBait: {},                    // 各鱼饵成功上鱼条数
        byWx: {},                      // 各天气下钓获条数
        byTm: {},                      // 各时段钓获条数
        netKept: 0,                    // 收进鱼护的累计条数
        released: 0,                   // 放生累计条数
        netMax: 0, tankMax: 0,         // 鱼护 / 水族箱的**历史最大占用**（成就用）
        streak: 0, maxStreak: 0,       // 当前 / 历史最长「连续成功」竿数
      },
      settings: { sound: true, volume: 0.55, ambient: true, idle: false },
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
  }

  /* ---------------- 存读档 ---------------- */
  function load() {
    var PS = G.Platform.storage;
    var raw = PS.get(CFG.saveKey);
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!data) {
      try { var bak = PS.get(CFG.saveKeyBak); if (bak) data = JSON.parse(bak); } catch (e) {}
    }
    S = data && typeof data === 'object' ? migrate(data) : blank();
    return S;
  }

  function migrate(d) {
    var b = blank();
    var from = safeNum(d.v, 1);

    // 浅合并，保证新增字段有默认值
    Object.keys(b).forEach(function (k) { if (d[k] === undefined) d[k] = b[k]; });
    Object.keys(b.settings).forEach(function (k) { if (!d.settings || d.settings[k] === undefined) d.settings[k] = b.settings[k]; });
    Object.keys(b.stats).forEach(function (k) { if (!d.stats || d.stats[k] === undefined) d.stats[k] = b.stats[k]; });
    G.BAITS.forEach(function (x) { if (d.baits[x.id] === undefined) d.baits[x.id] = x.free ? -1 : 0; });
    if (!Array.isArray(d.net)) d.net = [];
    if (!Array.isArray(d.tank)) d.tank = [];
    if (d.netCap == null) d.netCap = CFG.storage.netCap;
    if (d.tankCap == null) d.tankCap = CFG.storage.tankCap;
    if (d.netEx == null) d.netEx = 0;
    if (d.tankEx == null) d.tankEx = 0;
    if (!d.unlocked || !d.unlocked.D) d.unlocked = Object.assign({ D: true }, d.unlocked || {});

    /* ---- 长线目标（v3）：字段兜底 + 类型纠正 ---- */
    if (!Array.isArray(d.achSeen)) d.achSeen = [];
    if (!d.medalSeen || typeof d.medalSeen !== 'object') d.medalSeen = {};
    if (typeof d.titleSel !== 'string') d.titleSel = '';
    d.medals = Math.max(0, Math.round(safeNum(d.medals, 0)));
    d.eco = Math.max(0, Math.round(safeNum(d.eco, 0)));
    d.tankSec = Math.max(0, safeNum(d.tankSec, 0));
    d.tankFrac = Math.min(0.999, Math.max(0, safeNum(d.tankFrac, 0)));
    if (d.daily && (typeof d.daily !== 'object' || !Array.isArray(d.daily.q))) d.daily = null;
    /* v5：周常挑战。字段类型不对就当没有 —— init() 会自动补一份新的 */
    if (d.weekly && (typeof d.weekly !== 'object' || !Array.isArray(d.weekly.q))) d.weekly = null;
    if (!Array.isArray(d.stats.byRar) || d.stats.byRar.length !== 4) d.stats.byRar = [0, 0, 0, 0];
    d.stats.byRar = d.stats.byRar.map(function (v) { return Math.max(0, Math.round(safeNum(v, 0))); });
    ['byField', 'byBait', 'byWx', 'byTm'].forEach(function (k) {
      if (!d.stats[k] || typeof d.stats[k] !== 'object' || Array.isArray(d.stats[k])) d.stats[k] = {};
      var src = d.stats[k], clean = {};
      Object.keys(src).forEach(function (id) { clean[id] = Math.max(0, Math.round(safeNum(src[id], 0))); });
      d.stats[k] = clean;
    });
    d.stats.netKept = Math.max(0, Math.round(safeNum(d.stats.netKept, 0)));
    d.stats.released = Math.max(0, Math.round(safeNum(d.stats.released, 0)));
    /* netMax / tankMax：历史最大占用。没有这个字段的老档用「当前条数」起步，
       至少保证不会因为缺字段而被判成 0 之后又永远追不上。 */
    d.stats.netMax = Math.max(0, Math.round(safeNum(d.stats.netMax, (d.net || []).length)));
    d.stats.tankMax = Math.max(0, Math.round(safeNum(d.stats.tankMax, (d.tank || []).length)));
    d.stats.streak = Math.max(0, Math.round(safeNum(d.stats.streak, 0)));
    d.stats.maxStreak = Math.max(0, Math.round(safeNum(d.stats.maxStreak, 0)));
    if (d.stats.maxStreak < d.stats.streak) d.stats.maxStreak = d.stats.streak;

    /* ---- 新手引导（v4）----
       老存档（v < 4）显然不是新手，直接标成「已看过」，
       否则一更新就弹教学气泡，等于往老玩家脸上糊提示。 */
    if (!d.tut || typeof d.tut !== 'object' || Array.isArray(d.tut)) d.tut = { step: 0, done: false };
    d.tut.step = Math.max(0, Math.min(tutStepCount(), Math.round(safeNum(d.tut.step, 0))));
    d.tut.done = !!d.tut.done;
    if (from < 4) d.tut.done = true;
    if (d.tut.step >= tutStepCount()) d.tut.done = true;

    /* ---- 按版本号迁移 ---- */
    if (from < 2) {
      // v1 → v2：新增鱼护 / 水族箱
      if (!Array.isArray(d.net)) d.net = [];
      if (!Array.isArray(d.tank)) d.tank = [];
      d.netCap = safeNum(d.netCap, CFG.storage.netCap);
      d.tankCap = safeNum(d.tankCap, CFG.storage.tankCap);
      d.netEx = safeNum(d.netEx, 0);
      d.tankEx = safeNum(d.tankEx, 0);
    }
    if (from < 3) {
      // v2 → v3：长线目标系统（每日任务 / 纪念币 / 称号 / 分维计数）。
      // 全部走上面的兜底逻辑，这里只标记「成就还没补登记」，
      // 由 G.Goals.init() 静默登记已满足的成就，避免老档一进来刷屏。
      d.achInit = false;
    }
    if (from < 5) {
      // v4 → v5：周常挑战。没有历史数据要换算 —— weekly 留 null，
      // 由 G.Goals.init() 按当前 ISO 周键生成一份，老档不会缺当周挑战。
      d.weekly = null;
    }
    d.v = SAVE_V;

    /* ---- 数值兜底：任何一条脏数据都不该毁掉整个存档 ---- */
    d.coin = Math.max(0, safeNum(d.coin, CFG.economy.startCoin));
    d.playTime = Math.max(0, safeNum(d.playTime, 0));
    d.stats.maxKg = Math.max(0, safeNum(d.stats.maxKg, 0));
    d.stats.totalValue = Math.max(0, safeNum(d.stats.totalValue, 0));
    ['casts', 'catches', 'escapes', 'snaps', 'idleCatches', 'days'].forEach(function (k) {
      d.stats[k] = Math.max(0, Math.round(safeNum(d.stats[k], 0)));
    });
    if (!G.FIELD_MAP[d.field] || !d.unlocked[d.field]) d.field = 'D';
    // 清掉失效的鱼种 id（比如以后删过鱼）
    d.net = (d.net || []).filter(function (e) {
      return e && G.FISH_ID[e.f] && isFinite(Number(e.kg)) && Number(e.kg) > 0;
    }).slice(0, d.netCap);
    d.tank = (d.tank || []).filter(function (e) {
      return e && G.FISH_ID[e.f] && isFinite(Number(e.kg)) && Number(e.kg) > 0;
    }).slice(0, d.tankCap);

    return d;
  }

  /* 存档导入：先校验再落地，避免一段烂 JSON 直接毁档 */
  function importSave(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { return { ok: false, msg: '不是合法的 JSON' }; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, msg: '存档格式不对' };
    if (typeof d.coin !== 'number' && typeof d.playTime !== 'number') {
      return { ok: false, msg: '这看起来不是本游戏的存档' };
    }
    try {
      S = migrate(d);
      save(true);
      emit('import');
      return { ok: true, coin: S.coin, book: Object.keys(S.book).length };
    } catch (e) {
      return { ok: false, msg: '导入失败：' + e.message };
    }
  }

  /* 鱼护 / 水族箱的「历史最大占用」。
     成就不能直接看当前条数 —— 玩家卖光之后进度会回退，
     而成就判定只在「上岸 / 失败」时触发，可能永远抓不到那个峰值。 */
  function notePeaks() {
    var st = S.stats;
    if (S.net.length > (st.netMax || 0)) st.netMax = S.net.length;
    if (S.tank.length > (st.tankMax || 0)) st.tankMax = S.tank.length;
  }

  function save(now) {
    if (!S) return;
    notePeaks();
    S.lastSeen = Date.now();
    var txt = JSON.stringify(S);
    var PS = G.Platform.storage;
    PS.set(CFG.saveKey, txt);
    if (now !== false) PS.set(CFG.saveKeyBak, txt);
  }

  function scheduleSave() {
    notePeaks();
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; save(false); }, 1200);
  }

  function reset() {
    S = blank();
    save(true);
    emit('reset');
  }

  /* ---------------- 订阅 ---------------- */
  function on(evt, fn) { listeners.push({ evt: evt, fn: fn }); }
  function emit(evt, payload) {
    listeners.forEach(function (l) { if (l.evt === evt || l.evt === '*') l.fn(payload, evt); });
  }

  /* ---------------- 取用 ---------------- */
  function get() { return S; }
  function bait(id) { for (var i = 0; i < G.BAITS.length; i++) if (G.BAITS[i].id === id) return G.BAITS[i]; return G.BAITS[0]; }
  function rod(id)  { for (var i = 0; i < G.RODS.length; i++)  if (G.RODS[i].id === id)  return G.RODS[i];  return G.RODS[0]; }
  function line(id) { for (var i = 0; i < G.LINES.length; i++) if (G.LINES[i].id === id) return G.LINES[i]; return G.LINES[0]; }
  function curBait() { return bait(S.baitSel); }
  function curRod()  { return rod(S.rodSel); }
  function curLine() { return line(S.lineSel); }
  function baitCount(id) { return S.baits[id] == null ? 0 : S.baits[id]; }

  /* ---------------- 金币 ---------------- */
  function addCoin(n) {
    /* n 可能是 NaN（价格算错、存档被改），这里兜住不让它污染存档 */
    n = safeNum(n, 0);
    S.coin = Math.max(0, safeNum(S.coin, 0) + n);
    scheduleSave();
    emit('coin', S.coin);
    return S.coin;
  }
  function spend(n) {
    n = safeNum(n, 0);
    if (safeNum(S.coin, 0) < n) return false;
    S.coin = safeNum(S.coin, 0) - n;
    scheduleSave(); emit('coin', S.coin); return true;
  }

  /* ---------------- 鱼护 / 水族箱 ----------------
     鱼护和「图鉴」是两件事：
       · 图鉴 = 永久记录，钓到就登记，跟卖不卖无关
       · 鱼护 = 你真的把这条鱼留下了，可以再卖、放生、或移进水族箱
     --------------------------------------------------------- */
  function netCount()  { return S.net.length; }
  function tankCount() { return S.tank.length; }
  function netFull()   { return S.net.length >= S.netCap; }
  function tankFull()  { return S.tank.length >= S.tankCap; }

  function toNet(fish, kg, colorKey) {
    if (netFull()) return false;
    S.net.push({ f: fish.id, kg: kg, c: colorKey });
    S.stats.netKept = (S.stats.netKept || 0) + 1;   // 每日任务「收进鱼护 N 条」要用
    scheduleSave();
    emit('net');
    return true;
  }

  function netPrice(entry) {
    var fish = G.FISH_ID[entry.f];
    if (!fish) return 0;
    return G.Loot.price(fish, entry.kg, G.Loot.colorByKey(entry.c), false);
  }
  function netValue() {
    var sum = 0;
    S.net.forEach(function (e) { sum += netPrice(e); });
    return sum;
  }

  function sellNetAt(i) {
    if (i < 0 || i >= S.net.length) return 0;
    var p = netPrice(S.net[i]);
    S.net.splice(i, 1);
    S.coin += p;
    S.stats.totalValue += p;
    save(); emit('coin'); emit('net');
    return p;
  }
  function sellAllNet() {
    var p = netValue();
    if (!S.net.length) return 0;
    S.net.length = 0;
    S.coin += p;
    S.stats.totalValue += p;
    save(); emit('coin'); emit('net');
    return p;
  }
  /* ---------------- 放生 → 生态值 ----------------
     放生不再只是「删掉一条鱼」。得到的生态值是**收集货币**，
     只能换限定装饰（纯外观），换不到任何影响玩法/收益的东西。
     口径：稀有度基础值 × 体重系数 × 颜色系数，见 config.eco。 */
  function ecoValue(entry) {
    var fish = G.FISH_ID[entry.f];
    if (!fish) return 0;
    var mid = Math.max(1e-6, (fish.minKg + fish.maxKg) / 2);
    var kgMul = U.clamp(entry.kg / mid, CFG.eco.kgMin, CFG.eco.kgMax);
    var cm = G.Loot.colorByKey(entry.c);
    var cmMul = CFG.eco.colorBase + CFG.eco.colorSpan * (cm ? cm.valueMul : 1);
    var base = CFG.eco.base[fish.rar] != null ? CFG.eco.base[fish.rar] : CFG.eco.base[0];
    return Math.max(1, Math.round(base * kgMul * cmMul));
  }

  function releaseNetAt(i) {
    if (i < 0 || i >= S.net.length) return { ok: false, eco: 0 };
    var eco = ecoValue(S.net[i]);
    S.net.splice(i, 1);
    S.eco = (S.eco || 0) + eco;
    S.stats.released = (S.stats.released || 0) + 1;
    save(); emit('net'); emit('eco');
    return { ok: true, eco: eco };
  }

  /* ---------------- 水族箱被动收益 ----------------
     养着的鱼每小时产出金币。产出与「这条鱼现在能卖多少钱」成正比，
     所以稀有度 / 颜色 / 重量全都自然计入，不需要额外三套系数。
     ⚠️ 不是售价本身：约 1/rate 小时才回本（默认 5% → 20 小时），
        而且养在水族箱里的鱼是卖不掉的（机会成本由玩家自己权衡）。 */
  function tankYieldPerHour() {
    var per = 0;
    /* 公式在 loot.js 里（与 tools/balance.js 共用一份），别在这里再写一遍 */
    S.tank.forEach(function (e) { per += G.Loot.tankYield(netPrice(e)); });
    return per;
  }

  /* 只加钱，不走 addCoin 的 emit（主循环里调用，避免金币数字每 30 秒闪一次没必要）
     ⚠️ 必须留「不足 1 金的零头」（S.tankFrac），否则便宜的鱼永远产不出东西：
        一条池塘鲫鱼每小时才 ~4 金，30 秒是 0.03 金，取整就是 0，
        余量再被清零的话这个系统对早期玩家等于不存在。 */
  function tankAward(seconds) {
    var per = tankYieldPerHour();
    if (per <= 0 || seconds <= 0) return 0;
    S.tankFrac = safeNum(S.tankFrac, 0) + per * seconds / 3600;
    var coin = Math.floor(S.tankFrac);
    if (coin <= 0) return 0;
    S.tankFrac -= coin;
    S.coin = Math.max(0, safeNum(S.coin, 0) + coin);
    /* 被动收益**不计入** stats.totalValue —— 那个字段的口径是「累计卖鱼收入」，
       成就要用它，混进来会失真。 */
    scheduleSave();
    /* 单独的 'tankyield' 事件：不要复用 'coin'。
       'coin' 的订阅方会闪一下金币数字，而这笔钱是躺着来的，
       每 30 秒凭空闪一次会让玩家以为出了问题。 */
    emit('tankyield', coin);
    return coin;
  }

  /* 在线：每 tankYieldTick 秒结算一次，余量存在 tankSec 里不丢 */
  function tankTick(dt) {
    if (!S.tank.length) { S.tankSec = 0; S.tankFrac = 0; return 0; }
    S.tankSec += dt;
    if (S.tankSec < CFG.storage.tankYieldTick) return 0;
    var secs = S.tankSec;
    S.tankSec = 0;
    return tankAward(secs);
  }

  /* 离线：页面关闭期间也在产出，上限沿用 idle.maxCatchUp（默认 8 小时）。
     ⚠️ 刻意**不**看 settings.idle —— 那条开关管的是「挂机钓鱼」，
        水族箱是被动收益，玩家没开挂机也该产。 */
  function tankCatchUp(seconds) {
    seconds = Math.min(Math.max(0, safeNum(seconds, 0)), CFG.idle.maxCatchUp);
    if (seconds < 60 || !S.tank.length) return { coin: 0, seconds: 0, capped: false };
    var coin = tankAward(seconds);
    return { coin: coin, seconds: seconds, capped: seconds >= CFG.idle.maxCatchUp };
  }

  function moveToTank(i) {
    if (tankFull() || i < 0 || i >= S.net.length) return false;
    S.tank.push(S.net.splice(i, 1)[0]);
    scheduleSave(); emit('net');
    return true;
  }
  function takeFromTank(i) {
    if (netFull() || i < 0 || i >= S.tank.length) return false;
    S.net.push(S.tank.splice(i, 1)[0]);
    scheduleSave(); emit('net');
    return true;
  }
  function sellTankAt(i) {
    if (i < 0 || i >= S.tank.length) return 0;
    var p = netPrice(S.tank[i]);
    S.tank.splice(i, 1);
    S.coin += p;
    S.stats.totalValue += p;
    save(); emit('coin'); emit('net');
    return p;
  }

  /* 扩容：价格表走 config.storage.*Costs，用完就到底 */
  function netExpandCost() {
    var c = CFG.storage.netCosts;
    return S.netEx < c.length ? c[S.netEx] : null;
  }
  function tankExpandCost() {
    var c = CFG.storage.tankCosts;
    return S.tankEx < c.length ? c[S.tankEx] : null;
  }
  function expandNet() {
    var cost = netExpandCost();
    if (cost == null) return { ok: false, msg: '鱼护已经扩到最大了' };
    if (S.coin < cost) return { ok: false, msg: '金币不足' };
    S.coin -= cost;
    S.netCap += CFG.storage.netStep;
    S.netEx++;
    save(); emit('coin'); emit('net');
    return { ok: true, cost: cost, cap: S.netCap };
  }
  function expandTank() {
    var cost = tankExpandCost();
    if (cost == null) return { ok: false, msg: '水族箱已经扩到最大了' };
    if (S.coin < cost) return { ok: false, msg: '金币不足' };
    S.coin -= cost;
    S.tankCap += CFG.storage.tankStep;
    S.tankEx++;
    save(); emit('coin'); emit('net');
    return { ok: true, cost: cost, cap: S.tankCap };
  }

  /* ---------------- 图鉴 ---------------- */
  function bookEntry(id) { return S.book[id] || null; }
  function isCaught(id) { return !!S.book[id]; }

  /* ctx（可选）：{ bait: 鱼饵 id, env: { wx, tm } }
     用于填写分维计数，每日任务与成就要靠它取数。
     ⚠️ 老的调用点（devtools / 离线补算）不传 ctx 也完全合法。 */
  function recordCatch(fish, kg, colorKey, ctx) {
    if (!fish) return { isNew: false, isRecord: false };
    kg = Math.max(0, safeNum(kg, 0));
    var e = S.book[fish.id];
    var isNew = !e;
    if (!e) {
      e = S.book[fish.id] = { n: 0, maxKg: 0, colors: {}, first: Date.now() };
    }
    e.n++;
    e.colors[colorKey] = (e.colors[colorKey] || 0) + 1;
    var isRecord = kg > e.maxKg;
    if (isRecord) e.maxKg = kg;

    // 全局统计
    if (kg > S.stats.maxKg) { S.stats.maxKg = kg; S.stats.maxKgFish = fish.name; }
    recordDims(fish, ctx);

    scheduleSave();
    return { isNew: isNew, isRecord: isRecord };
  }

  /* 分维计数：每日任务 / 成就的取数来源 */
  function recordDims(fish, ctx) {
    var st = S.stats;
    if (fish.rar >= 0 && fish.rar < 4) st.byRar[fish.rar] = (st.byRar[fish.rar] || 0) + 1;
    st.byField[fish.field] = (st.byField[fish.field] || 0) + 1;
    if (ctx) {
      if (ctx.bait) st.byBait[ctx.bait] = (st.byBait[ctx.bait] || 0) + 1;
      if (ctx.env) {
        if (ctx.env.wx) st.byWx[ctx.env.wx] = (st.byWx[ctx.env.wx] || 0) + 1;
        if (ctx.env.tm) st.byTm[ctx.env.tm] = (st.byTm[ctx.env.tm] || 0) + 1;
      }
    }
  }

  /* 「连续成功竿数」的记账。断线 / 脱钩 / 错过咬口都算断。
     成就有「连续成功 N 竿」，所以要留 maxStreak。 */
  function noteResult(ok) {
    var st = S.stats;
    if (ok) {
      st.streak = (st.streak || 0) + 1;
      if (st.streak > (st.maxStreak || 0)) st.maxStreak = st.streak;
    } else {
      st.streak = 0;
    }
    scheduleSave();
    return st.streak;
  }

  function fieldProgress(fid) {
    var all = G.FISH_BY_FIELD[fid] || [];
    var got = 0;
    for (var i = 0; i < all.length; i++) if (S.book[all[i].id]) got++;
    return { got: got, total: all.length, pct: all.length ? got / all.length : 0 };
  }

  /* 达成 80% 需要的数量（向上取整） */
  function needCount(total, pct) { return Math.max(1, Math.ceil(total * pct)); }

  /* ---------------- 钓场解锁 ---------------- */
  function fieldState(fid) {
    var f = G.FIELD_MAP[fid];
    var prog = fieldProgress(fid);
    if (S.unlocked[fid]) return { unlocked: true, prog: prog, missing: 0, need: 0, reason: '' };

    if (!f) return { unlocked: false, prog: prog, reason: '钓场不存在' };

    // 前置钓场条件
    var pre = f.requires;
    var preList = pre == null ? [] : (Array.isArray(pre) ? pre : [pre]);
    var ok = true, reason = '';

    if (f.requireFull) {
      // 需要前面所有钓场 100% 收满
      var totG = 0, totT = 0;
      for (var i = 0; i < preList.length; i++) {
        var p = fieldProgress(preList[i]);
        totG += p.got; totT += p.total;
        if (p.got < p.total && ok) {
          ok = false;
          reason = '需 ' + preList.join(' / ') + ' 全部 100% 收满（当前 ' + totG + '/' + totT + '）';
        }
      }
      if (!ok && !reason) reason = '需前置钓场全部 100%';
    } else if (preList.length) {
      var pp = fieldProgress(preList[0]);
      var need = needCount(pp.total, f.collectionPct);
      if (pp.got < need) {
        ok = false;
        reason = '需 ' + preList[0] + ' 级钓场图鉴 ' + Math.round(f.collectionPct * 100) + '%（' + pp.got + '/' + pp.total + '）';
      }
    }

    if (ok && CFG.unlockHoursAsGate && f.unlockHours > 0) {
      var needSec = f.unlockHours * 3600;
      if (S.playTime < needSec) {
        ok = false;
        reason = '还需累计游玩 ' + U.dur(needSec - S.playTime);
      }
    }

    return { unlocked: ok, prog: prog, reason: reason };
  }

  /* 检查并实际解锁，返回新解锁的钓场数组 */
  function checkUnlocks() {
    var news = [];
    G.FIELDS.forEach(function (f) {
      if (S.unlocked[f.id]) return;
      var st = fieldState(f.id);
      if (st.unlocked) {
        S.unlocked[f.id] = true;
        news.push(f);
      }
    });
    if (news.length) { save(); emit('unlock', news); }
    return news;
  }

  function setField(fid) {
    if (!S.unlocked[fid]) return false;
    S.field = fid; scheduleSave(); emit('field', fid); return true;
  }

  /* ---------------- 玩耍时长 ---------------- */
  function tick(dt) {
    S.playTime += dt;
    S.stats.days = Math.floor(S.playTime / 86400);
  }

  /* ---------------- 鱼饵消耗 ----------------
     **返回这一竿实际生效的鱼饵对象**（不是布尔值）。
     ⚠️ 调用方必须用它、而不是回头再读 `curBait()`：
        以前 fishing.js 是「先 consumeBait() 再 curBait()」，
        而消耗掉最后一枚的瞬间 baitSel 已经被切回蚯蚓 →
        **那一枚鱼饵白花了**（付了它的价、没吃到它的 speed / rareMul 加成），
        而且不报任何错。 */
  function consumeBait() {
    var b = curBait();
    if (b.free) return b;
    if (baitCount(b.id) <= 0) {
      // 自动回退到免费饵
      S.baitSel = 'worm'; emit('bait'); return bait('worm');
    }
    S.baits[b.id]--;
    if (S.baits[b.id] <= 0) {
      S.baits[b.id] = 0;
      S.baitSel = 'worm';
      emit('bait');
      emit('toast', { text: '鱼饵用完了，已切回蚯蚓', kind: 'warn' });
    }
    scheduleSave();
    emit('bait');
    return b;
  }

  /* 退还鱼饵 —— 「提前收杆」用：鱼还没咬钩就收线，这一竿的饵不该收钱。
     · 免费饵（蚯蚓）没有库存概念，直接返回 false
     · 返回是否真的退了东西（调用方据此决定文案） */
  function refundBait(baitId, n) {
    var b = bait(baitId);
    if (!b || b.free) return false;
    n = Math.max(1, Math.round(safeNum(n, 1)));
    S.baits[b.id] = Math.max(0, (S.baits[b.id] || 0) + n);
    scheduleSave();
    emit('bait');
    return true;
  }

  /* ---------------- 购买 ---------------- */
  function buyBait(baitId, packs) {
    packs = packs || 1;
    var b = bait(baitId);
    if (!b || b.free) return { ok: false, msg: '无需购买' };
    var cost = b.price * b.pack * packs;
    if (S.coin < cost) return { ok: false, msg: '金币不足' };
    S.coin -= cost;
    S.baits[b.id] = (S.baits[b.id] || 0) + b.pack * packs;
    save(); emit('coin'); emit('bait');
    return { ok: true, cost: cost, amount: b.pack * packs };
  }

  function buyRod(id) {
    if (S.rods.indexOf(id) >= 0) return { ok: false, msg: '已拥有' };
    var r = rod(id);
    if (!r) return { ok: false, msg: '不存在' };
    if (S.coin < r.price) return { ok: false, msg: '金币不足' };
    S.coin -= r.price; S.rods.push(id);
    save(); emit('coin'); emit('shop');
    return { ok: true };
  }

  function buyLine(id) {
    if (S.lines.indexOf(id) >= 0) return { ok: false, msg: '已拥有' };
    var l = line(id);
    if (!l) return { ok: false, msg: '不存在' };
    if (S.coin < l.price) return { ok: false, msg: '金币不足' };
    S.coin -= l.price; S.lines.push(id);
    save(); emit('coin'); emit('shop');
    return { ok: true };
  }

  /* 装饰有三种货币（见 items.js 的 cur 字段）：
       coin  金币     —— 常规装饰，通关后的金币沉淀
       eco   生态值   —— 放生换来的限定装饰
       medal 纪念币   —— 每日任务换来的限定装饰
     限定装饰**只换外观**，不带任何数值。 */
  function decor(id) {
    for (var i = 0; i < G.DECORS.length; i++) if (G.DECORS[i].id === id) return G.DECORS[i];
    return null;
  }
  function decorCur(d) { return (d && d.cur) || 'coin'; }
  function curLabel(cur) {
    return cur === 'eco' ? '生态值' : (cur === 'medal' ? '纪念币' : '金币');
  }
  function curHave(cur) {
    return cur === 'eco' ? (S.eco || 0) : (cur === 'medal' ? (S.medals || 0) : safeNum(S.coin, 0));
  }

  function buyDecor(id) {
    if (S.decors.indexOf(id) >= 0) return { ok: false, msg: '已拥有' };
    var d = decor(id);
    if (!d) return { ok: false, msg: '不存在' };
    var cur = decorCur(d);
    if (curHave(cur) < d.price) return { ok: false, msg: curLabel(cur) + '不足' };
    if (cur === 'coin') { S.coin -= d.price; emit('coin'); }
    else if (cur === 'eco') { S.eco -= d.price; emit('eco'); }
    else { S.medals -= d.price; emit('goals'); }
    S.decors.push(id);
    save(); emit('shop');
    return { ok: true, cur: cur, price: d.price };
  }

  function selectBait(id) { S.baitSel = id; scheduleSave(); emit('bait'); }
  function selectRod(id)  { if (S.rods.indexOf(id) < 0) return false; S.rodSel = id; scheduleSave(); emit('shop'); return true; }
  function selectLine(id) { if (S.lines.indexOf(id) < 0) return false; S.lineSel = id; scheduleSave(); emit('shop'); return true; }

  /* ---------------- 挂机开关 ---------------- */
  function setIdle(v) { S.settings.idle = !!v; scheduleSave(); emit('idle', !!v); }

  /* ---------------- 颜色收集进度（纯收集度，不影响解锁） ---------------- */
  var _colorTotal = null;
  function colorProgress() {
    if (_colorTotal == null) _colorTotal = G.FISH.length * CFG.colorMorphs.length;
    var got = 0;
    for (var i = 0; i < G.FISH.length; i++) {
      var e = S.book[G.FISH[i].id];
      if (!e || !e.colors) continue;
      for (var c = 0; c < CFG.colorMorphs.length; c++) {
        if (e.colors[CFG.colorMorphs[c].key]) got++;
      }
    }
    return { got: got, total: _colorTotal, pct: _colorTotal ? got / _colorTotal : 0 };
  }

  /* 单个钓场的「品种 × 颜色」收集进度（图鉴要按钓场分别展示） */
  function fieldColorProgress(fid) {
    var list = G.FISH_BY_FIELD[fid] || [];
    var total = list.length * CFG.colorMorphs.length;
    var got = 0;
    for (var i = 0; i < list.length; i++) {
      var e = S.book[list[i].id];
      if (!e || !e.colors) continue;
      for (var c = 0; c < CFG.colorMorphs.length; c++) {
        if (e.colors[CFG.colorMorphs[c].key]) got++;
      }
    }
    return { got: got, total: total, pct: total ? got / total : 0 };
  }

  /* ---------------- 各钓场图鉴进度统计 ---------------- */
  function globalProgress() {
    var got = 0;
    for (var i = 0; i < G.FISH.length; i++) if (S.book[G.FISH[i].id]) got++;
    return { got: got, total: G.FISH.length, pct: got / G.FISH.length };
  }

  return {
    SAVE_V: SAVE_V,          // 暴露给测试与调试用（断言「升档后写回的就是它」）
    load: load, save: save, scheduleSave: scheduleSave, reset: reset,
    importSave: importSave,
    get: get, on: on, emit: emit,
    curBait: curBait, curRod: curRod, curLine: curLine,
    bait: bait, rod: rod, line: line, baitCount: baitCount,
    addCoin: addCoin, spend: spend,
    bookEntry: bookEntry, isCaught: isCaught, recordCatch: recordCatch, noteResult: noteResult,
    netCount: netCount, tankCount: tankCount, netFull: netFull, tankFull: tankFull,
    toNet: toNet, netPrice: netPrice, netValue: netValue,
    sellNetAt: sellNetAt, sellAllNet: sellAllNet, releaseNetAt: releaseNetAt,
    ecoValue: ecoValue,
    tankYieldPerHour: tankYieldPerHour, tankTick: tankTick, tankCatchUp: tankCatchUp,
    decor: decor, decorCur: decorCur, curLabel: curLabel, curHave: curHave,
    moveToTank: moveToTank, takeFromTank: takeFromTank, sellTankAt: sellTankAt,
    netExpandCost: netExpandCost, tankExpandCost: tankExpandCost,
    expandNet: expandNet, expandTank: expandTank,
    fieldProgress: fieldProgress, fieldState: fieldState, checkUnlocks: checkUnlocks,
    setField: setField, tick: tick, consumeBait: consumeBait, refundBait: refundBait,
    buyBait: buyBait, buyRod: buyRod, buyLine: buyLine, buyDecor: buyDecor,
    selectBait: selectBait, selectRod: selectRod, selectLine: selectLine,
    setIdle: setIdle, globalProgress: globalProgress, colorProgress: colorProgress,
    fieldColorProgress: fieldColorProgress,
    needCount: needCount,
  };
})();
