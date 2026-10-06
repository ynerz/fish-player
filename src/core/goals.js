/* =========================================================
   goals.js  —  每日任务 / 成就 / 称号（B5 长线目标系统）
   =========================================================
   设计口径
   · 每日任务：**本地日期 + 当前进度阶段**做种子，确定性生成 3 条，
     不需要服务器、不需要联网。当天生成结果写进存档，跨天自动重掷。
     （单机游戏允许玩家改系统时间刷任务，这不算问题。
       所以「不做服务器校验」是刻意的，不是漏做。）
   · 成就：**纯派生**。不给存档加任何成就字段，全部由现有数据算出来，
     所以以后改条件/加成就都不需要写存档迁移。
   · 奖励：只给「称号」与纪念币（纪念币没有消费出口）。
     绝不给金币 / 鱼饵 / 装备 / 掉率加成 —— 见 data/goals.js 顶部说明。
   ---------------------------------------------------------
   ⚠️ 每日任务的进度 = 当前累计值 − 当天开始时的基准值（见 daily.base）。
      新增任务类型时，必须同时在这里的 METRICS 里加一条取数口径，
      否则 quests() 会算成 NaN。
   ========================================================= */
window.G = window.G || {};

G.Goals = (function () {
  var U = G.U, CFG = G.CONFIG;
  var St = null;
  var dayTick = 0;

  /* ---------------- 日期种子 ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayKey() {
    /* 用系统本地日期（单机游戏，不需要服务端时间） */
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  /* 确定性伪随机：同一天、同一进度阶段 → 同样的三条任务 */
  function mkRand(seed) {
    var s = seed || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* ---------------- 取数口径 ----------------
     签名 (S, key, daily) -> number
     key 只在需要区分上下文的模板里用（钓场 / 鱼饵 / 天气 / 时段） */
  function sumRarFrom(S, from) {
    var a = (S.stats && S.stats.byRar) || [];
    var t = 0;
    for (var i = from; i < 4; i++) t += (a[i] || 0);
    return t;
  }
  function mapCount(obj) {
    var n = 0, k;
    for (k in obj) if (obj[k] > 0) n++;
    return n;
  }
  var METRICS = {
    /* —— 每日任务用 —— */
    catch:    function (S) { return S.stats.catches; },
    cast:     function (S) { return S.stats.casts; },
    rareUp:   function (S) { return sumRarFrom(S, 1); },
    epicUp:   function (S) { return sumRarFrom(S, 2); },
    netKept:  function (S) { return S.stats.netKept || 0; },
    value:    function (S) { return S.stats.totalValue; },
    field:    function (S, k) { return ((S.stats.byField || {})[k]) || 0; },
    bait:     function (S, k) { return ((S.stats.byBait || {})[k]) || 0; },
    wx:       function (S, k) { return ((S.stats.byWx || {})[k]) || 0; },
    tm:       function (S, k) { return ((S.stats.byTm || {})[k]) || 0; },
    maxKg:    function (S, k, daily) { return (daily && daily.meta) ? (daily.meta.maxKg || 0) : 0; },

    /* —— 成就用 —— */
    bookCount:   function (S) { return Object.keys(S.book || {}).length; },
    colorCount:  function () { return St.colorProgress().got; },
    fieldsOpen:  function (S) { return fieldsOpen(S); },
    maxKgAll:    function (S) { return S.stats.maxKg || 0; },
    totalValue:  function (S) { return S.stats.totalValue || 0; },
    playHours:   function (S) { return (S.playTime || 0) / 3600; },
    /* 成就要用「历史最大占用」而不是当前条数：
       鱼护卖空之后当前条数会掉回去，成就进度条会来回震荡，
       而且判定只在「上岸 / 失败」触发，峰值可能永远抓不到。 */
    netMax:      function (S) { return S.stats.netMax || 0; },
    tankMax:     function (S) { return S.stats.tankMax || 0; },
    maxStreak:   function (S) { return S.stats.maxStreak || 0; },
    idleCatches: function (S) { return S.stats.idleCatches || 0; },
    baitUsed:    function (S) { return mapCount(S.stats.byBait || {}); },
    wxUsed:      function (S) { return mapCount(S.stats.byWx || {}); },
    tmUsed:      function (S) { return mapCount(S.stats.byTm || {}); },
  };

  function fieldsOpen(S) {
    var n = 0;
    G.FIELDS.forEach(function (f) { if (S.unlocked[f.id]) n++; });
    return n;
  }
  function tplById(id) {
    for (var i = 0; i < G.QUEST_TPL.length; i++) if (G.QUEST_TPL[i].id === id) return G.QUEST_TPL[i];
    return null;
  }

  /* ---------------- 每日任务生成 ---------------- */
  function unlockedFieldIds(S) {
    var out = [];
    G.FIELDS.forEach(function (f) { if (S.unlocked[f.id]) out.push(f.id); });
    return out.length ? out : [G.FIELDS[0].id];
  }
  function usableBaitIds(S) {
    var out = [];
    G.BAITS.forEach(function (b) {
      if (b.free || (S.baits[b.id] || 0) > 0) out.push(b.id);
    });
    return out.length ? out : ['worm'];
  }

  function isTplAvailable(t, S, stage) {
    if ((t.minStage || 1) > stage) return false;
    if (t.ctx === 'field' && !unlockedFieldIds(S).length) return false;
    if (t.ctx === 'bait' && !usableBaitIds(S).length) return false;
    if (t.avail && !t.avail(S)) return false;
    return true;
  }

  /* 目标值按「已解锁钓场数」分阶段取值，避免新手被塞一条不可能完成的任务 */
  function pickNeed(t, rnd, S, stage) {
    var pool = t.poolFn ? t.poolFn(S) : t.pool;
    if (!pool || !pool.length) return 1;
    var step = Math.floor((stage - 1) / 2);
    var idx = U.clamp(step + Math.floor(rnd() * 2), 0, pool.length - 1);
    return pool[idx];
  }

  function makeQuest(t, rnd, S, stage) {
    var q = { tpl: t.id, need: pickNeed(t, rnd, S, stage), key: '', seen: false };
    if (t.ctx === 'field') {
      var fs = unlockedFieldIds(S); q.key = fs[Math.floor(rnd() * fs.length)];
    } else if (t.ctx === 'bait') {
      var bs = usableBaitIds(S);   q.key = bs[Math.floor(rnd() * bs.length)];
    } else if (t.ctx === 'wx') {
      var ws = CFG.weather.types;  q.key = ws[Math.floor(rnd() * ws.length)].key;
    } else if (t.ctx === 'tm') {
      var ts = CFG.weather.times;  q.key = ts[Math.floor(rnd() * ts.length)].key;
    }
    return q;
  }

  function genDaily(dayKey) {
    var S = St.get();
    var stage = fieldsOpen(S);
    var rnd = mkRand(hash32(dayKey + '|' + stage));
    var pool = G.QUEST_TPL.filter(function (t) { return isTplAvailable(t, S, stage); });
    if (!pool.length) pool = [G.QUEST_TPL[0]];

    var picked = [], used = {}, guard = 0;
    var want = Math.min(G.QUEST_PER_DAY, pool.length);
    while (picked.length < want && guard++ < 300) {
      var t = pool[Math.floor(rnd() * pool.length)];
      if (!t || used[t.id]) continue;
      used[t.id] = 1;
      picked.push(makeQuest(t, rnd, S, stage));
    }

    var d = {
      day: dayKey,
      q: picked,
      base: {},
      meta: { maxKg: 0 },
      claimed: picked.map(function () { return false; }),
    };
    /* 基准值必须在 meta 就位之后再取（maxKg 依赖 meta） */
    picked.forEach(function (q) {
      var t = tplById(q.tpl);
      if (t) d.base[t.metric] = METRICS[t.metric](S, q.key, d);
    });
    return d;
  }

  /* ---------------- 跨天刷新 ---------------- */
  function ensureDay(quiet) {
    var S = St.get();
    if (!S) return false;
    var key = todayKey();
    if (S.daily && S.daily.day === key && Array.isArray(S.daily.q)) return false;
    S.daily = genDaily(key);
    St.scheduleSave();
    emit('goals');
    if (!quiet && G.Hud && G.Hud.toast) {
      G.Hud.toast({ text: '🌅 新的一天，每日任务已刷新', kind: 'good' });
    }
    return true;
  }

  function emit(evt) { if (St && St.emit) St.emit(evt); }

  /* ---------------- 每日任务：读数 ---------------- */
  function questState(d, i) {
    var q = d.q[i] || { tpl: '', need: 1, key: '' };
    var t = tplById(q.tpl) || { text: function () { return '（已下架的任务）'; }, metric: 'catch', fmt: null };
    var cur = METRICS[t.metric] ? (METRICS[t.metric](St.get(), q.key, d) - (d.base[t.metric] || 0)) : 0;
    if (!isFinite(cur)) cur = 0;
    cur = Math.max(0, cur);
    var done = cur >= q.need;
    return {
      i: i, t: t, need: q.need, key: q.key,
      cur: cur, done: done, claimed: !!(d.claimed && d.claimed[i]),
      pct: q.need > 0 ? U.clamp(cur / q.need, 0, 1) : 1,
      text: t.text(q.need, q.key, St.get()),
    };
  }

  function quests() {
    var S = St.get();
    if (!S) return [];
    ensureDay(true);
    var out = [];
    for (var i = 0; i < S.daily.q.length; i++) out.push(questState(S.daily, i));
    return out;
  }

  function fmtVal(t, v) {
    if (t && typeof t.fmt === 'function') return t.fmt(v);
    return U.num(Math.floor(v * 10) / 10);
  }

  /* ---------------- 领取 ---------------- */
  function claim(i) {
    var S = St.get();
    ensureDay(true);
    var d = S.daily;
    if (i < 0 || i >= d.q.length) return { ok: false, msg: '没有这条任务' };
    var st = questState(d, i);
    if (st.claimed) return { ok: false, msg: '已经领过了' };
    if (!st.done) return { ok: false, msg: '还没完成' };
    d.claimed[i] = true;
    d.q[i].seen = true;
    S.medals = Math.max(0, Math.round((S.medals || 0) + 1));
    St.save();
    emit('goals');
    checkMedalTitles(S);
    return { ok: true, text: st.text, medals: S.medals };
  }

  function claimAll() {
    var got = 0;
    ensureDay(true);
    var n = St.get().daily.q.length;
    for (var i = 0; i < n; i++) if (claim(i).ok) got++;
    return got;
  }

  function medalClaimable() {
    var n = 0;
    quests().forEach(function (q) { if (q.done && !q.claimed) n++; });
    return n;
  }

  /* ---------------- 成就（纯派生） ---------------- */
  function achGot(a) {
    var f = METRICS[a.metric];
    var v = f ? f(St.get(), a.key || '', St.get().daily) : 0;
    return isFinite(v) ? v : 0;
  }
  function achDone(a) { return achGot(a) >= a.need; }

  function achievements() {
    return G.ACHIEVEMENTS.map(function (a) {
      var got = achGot(a);
      return {
        id: a.id, cat: a.cat, name: a.name, desc: a.desc, title: a.title || null,
        need: a.need, got: got, done: got >= a.need,
        pct: a.need > 0 ? U.clamp(got / a.need, 0, 1) : 1,
        fmt: a.fmt || null,
      };
    });
  }
  function achProgress() {
    var done = 0;
    G.ACHIEVEMENTS.forEach(function (a) { if (achDone(a)) done++; });
    return { got: done, total: G.ACHIEVEMENTS.length };
  }

  /* ---------------- 称号 ---------------- */
  function titles() {
    var out = [{ id: '', name: '无称号', from: '默认' }];
    G.ACHIEVEMENTS.forEach(function (a) {
      if (a.title && achDone(a)) out.push({ id: 'ach:' + a.id, name: a.title, from: '成就「' + a.name + '」' });
    });
    var m = medals();
    G.MEDAL_TITLES.forEach(function (t) {
      if (m >= t.need) out.push({ id: 'medal:' + t.id, name: t.name, from: t.desc });
    });
    return out;
  }
  function titleById(id) {
    var list = titles();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function equipped() {
    var t = titleById(St.get().titleSel || '');
    return t || titleById('');
  }
  function equip(id) {
    var S = St.get();
    if (id && !titleById(id)) return false;
    S.titleSel = id || '';
    St.save();
    emit('goals');
    return true;
  }
  function medals() { return Math.max(0, Math.round(St.get().medals || 0)); }

  /* 纪念币刚跨过里程碑 → 提示解锁新称号 */
  var _medalSeen = null;
  function checkMedalTitles(S) {
    var m = S.medals || 0;
    G.MEDAL_TITLES.forEach(function (t) {
      if (m >= t.need && !(S.medalSeen && S.medalSeen[t.id])) {
        if (!S.medalSeen) S.medalSeen = {};
        S.medalSeen[t.id] = true;
        if (G.Hud && G.Hud.toast) G.Hud.toast({ text: '🏅 解锁称号「' + t.name + '」', kind: 'good' });
      }
    });
  }

  /* ---------------- 进度检查（每次上岸/失败后调一次） ---------------- */
  function check(info) {
    var S = St.get();
    if (!S) return;
    ensureDay(true);

    /* 当天最大重量（给「钓到 N kg 以上」这条任务用） */
    if (info && info.kg > (S.daily.meta.maxKg || 0)) S.daily.meta.maxKg = info.kg;

    var news = [];

    /* 每日任务：从「未完成」变成「完成」时提示一次去领取 */
    S.daily.q.forEach(function (q, i) {
      var st = questState(S.daily, i);
      if (st.done && !st.claimed && !q.seen) {
        q.seen = true;
        news.push({ text: '✅ 每日任务完成：' + st.text + '（去「目标」领取）', kind: 'good' });
      }
    });

    /* 成就：纯派生 → 只跟「已播报过的 id」比一下 */
    if (!Array.isArray(S.achSeen)) S.achSeen = [];
    G.ACHIEVEMENTS.forEach(function (a) {
      if (S.achSeen.indexOf(a.id) >= 0) return;
      if (!achDone(a)) return;
      S.achSeen.push(a.id);
      news.push({ text: '🏆 成就达成：' + a.name + (a.title ? '　解锁称号「' + a.title + '」' : ''), kind: 'good' });
    });

    if (news.length) {
      St.scheduleSave();
      if (G.Hud && G.Hud.toast) news.forEach(function (n) { G.Hud.toast(n); });
      emit('goals');
    }
  }

  /* ---------------- 主循环钩子 ---------------- */
  function tick(dt) {
    dayTick += dt;
    if (dayTick < 3) return;
    dayTick = 0;
    if (ensureDay(false)) {
      if (G.Panels && G.Panels.current() === 'goals') G.Panels.refresh();
    }
  }

  function init() {
    St = G.State;
    /* 老存档第一次接入本系统：把「已经满足的成就」静默登记，
       否则一进游戏会被几十条成就提示刷屏 */
    var S = St.get();
    if (!S.achInit) {
      var seen = [];
      G.ACHIEVEMENTS.forEach(function (a) { if (achDone(a)) seen.push(a.id); });
      S.achSeen = seen;
      S.achInit = true;
      St.save(true);
    } else if (!Array.isArray(S.achSeen)) {
      S.achSeen = [];
    }
    var rolled = ensureDay(true);
    checkMedalTitles(S);
    void rolled;
    emit('goals');
  }

  return {
    init: init, tick: tick, today: todayKey, day: function () { return St.get().daily; },
    quests: quests, claim: claim, claimAll: claimAll, medalClaimable: medalClaimable,
    fmtVal: fmtVal, metrics: METRICS,
    achievements: achievements, achProgress: achProgress, achDone: achDone,
    titles: titles, equipped: equipped, equip: equip, medals: medals,
    check: check, ensureDay: ensureDay,
  };
})();
