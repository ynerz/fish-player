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
     版本 2：新增 net / tank / netCap / tankCap / netEx / tankEx */
  var SAVE_V = 2;

  /* 数字兜底：任何来自存档或计算的数值都要过一遍，
     否则 NaN 会被 JSON.stringify 写成 null，静默污染整个存档。 */
  function safeNum(v, dft) {
    v = Number(v);
    return isFinite(v) ? v : (dft || 0);
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
      stats: {
        casts: 0, catches: 0, escapes: 0, snaps: 0, idleCatches: 0,
        maxKg: 0, maxKgFish: '', totalValue: 0, days: 0,
      },
      settings: { sound: true, volume: 0.55, ambient: true, idle: false },
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
  }

  /* ---------------- 存读档 ---------------- */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(CFG.saveKey); } catch (e) {}
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!data) {
      try { var bak = localStorage.getItem(CFG.saveKeyBak); if (bak) data = JSON.parse(bak); } catch (e) {}
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

  function save(now) {
    if (!S) return;
    S.lastSeen = Date.now();
    var txt = JSON.stringify(S);
    try {
      localStorage.setItem(CFG.saveKey, txt);
      if (now !== false) localStorage.setItem(CFG.saveKeyBak, txt);
    } catch (e) {}
  }

  function scheduleSave() {
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
  function releaseNetAt(i) {
    if (i < 0 || i >= S.net.length) return false;
    S.net.splice(i, 1);
    save(); emit('net');
    return true;
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

  function recordCatch(fish, kg, colorKey) {
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

    scheduleSave();
    return { isNew: isNew, isRecord: isRecord };
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

  /* ---------------- 鱼饵消耗 ---------------- */
  function consumeBait() {
    var b = curBait();
    if (b.free) return true;
    if (baitCount(b.id) <= 0) {
      // 自动回退到免费饵
      S.baitSel = 'worm'; emit('bait'); return true;
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

  function buyDecor(id) {
    if (S.decors.indexOf(id) >= 0) return { ok: false, msg: '已拥有' };
    var d = null;
    for (var i = 0; i < G.DECORS.length; i++) if (G.DECORS[i].id === id) d = G.DECORS[i];
    if (!d) return { ok: false, msg: '不存在' };
    if (S.coin < d.price) return { ok: false, msg: '金币不足' };
    S.coin -= d.price; S.decors.push(id);
    save(); emit('coin'); emit('shop');
    return { ok: true };
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
    load: load, save: save, scheduleSave: scheduleSave, reset: reset,
    importSave: importSave,
    get: get, on: on, emit: emit,
    curBait: curBait, curRod: curRod, curLine: curLine,
    bait: bait, rod: rod, line: line, baitCount: baitCount,
    addCoin: addCoin, spend: spend,
    bookEntry: bookEntry, isCaught: isCaught, recordCatch: recordCatch,
    netCount: netCount, tankCount: tankCount, netFull: netFull, tankFull: tankFull,
    toNet: toNet, netPrice: netPrice, netValue: netValue,
    sellNetAt: sellNetAt, sellAllNet: sellAllNet, releaseNetAt: releaseNetAt,
    moveToTank: moveToTank, takeFromTank: takeFromTank, sellTankAt: sellTankAt,
    netExpandCost: netExpandCost, tankExpandCost: tankExpandCost,
    expandNet: expandNet, expandTank: expandTank,
    fieldProgress: fieldProgress, fieldState: fieldState, checkUnlocks: checkUnlocks,
    setField: setField, tick: tick, consumeBait: consumeBait,
    buyBait: buyBait, buyRod: buyRod, buyLine: buyLine, buyDecor: buyDecor,
    selectBait: selectBait, selectRod: selectRod, selectLine: selectLine,
    setIdle: setIdle, globalProgress: globalProgress, colorProgress: colorProgress,
    fieldColorProgress: fieldColorProgress,
    needCount: needCount,
  };
})();
