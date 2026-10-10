/* =========================================================
   diary.js  —  本机「钓鱼日记」（N11 ④，伪社交的一环）

   用户口径（2026-10-10）：「**本机「钓鱼日记」**（今天钓了什么 / 碰上过谁，
   纯展示、**不做分享墙**）」。整个功能的定位是**伪社交**的一部分：
   · **只写本机存档**（`S.diary`）—— 不联网、不导出、不给别人看，
     所以它不构成「玩家内容展示」，也就不碰版号那条线；
   · **只记事实**（与 `core/story.js` 同一条口径）：日记里不出现在派生不出来的东西。

   🔴 三条设计口径（每条都对应一种「不报错但玩家会看出问题」）：

   ① **日期键只有一处实现** —— 走 `G.U.dayKey()`（每日任务的跨天重掷也用它）。
      日记自己拼一遍日期的话，两边会在跨天那一刻分家：任务换了天、日记还接着
      昨天写（或者反过来），**不报错**，只是那一栏的数字看着不对。
      `verify` 的 [50-c] 全项目扫「拼日期的代码」（`getFullYear()` 之类）只许有一处。

   ② **打点入口各只有一个**：
      · 渔获 → `state.js: recordCatch()` 里那一处（**唯一**的记账入口：手动提竿、
        挂机、离线补算、开发者面板刷鱼全走它）⇒ 不会漏记，也不会记两遍；
      · 邻居「开口」→ `core/story.js` 的三处（事件 `mark()` / 主动搭话 `talk()` /
        旁观对话 `markBanter()`）。
      🔴 判据是「**他今天开过口**」，不是「他今天站在这片水里」——
         站位是按钓场定死的（每片水每天都一样），记进日记等于每天重复同一句话、
         没有任何信息量；「开口」才是真的碰上过。
      ⚠️ 事件 / 搭话 / 旁观三处都要记：漏了旁观那处，玩家旁观两人聊天之后再翻日记
         会发现「今天没碰上谁」—— 而画面上明明刚见过他们。

   ③ **每天一条摘要**（不是逐条流水）：条数 / 总重 / 挂机上的 / 今天最大的那一条 /
      新认识的鱼种数 / 去过的钓场 / 开口过的邻居。逐条流水会让存档随游玩时长无限长大，
      而「日记」这个形态本来就是摘要。

   ⚠️ **本模块不落盘**：`recordCatch()` / `mark()` / `talk()` / `markBanter()`
      都紧接着自己调 `save`，日记只是改同一个 `S` 上的一部分 ——
      自己再存一次纯属重复写盘（自动存档每 30 秒还会兜一次底）。
   ========================================================= */
window.G = window.G || {};

G.Diary = (function () {
  var CFG = G.CONFIG;

  /* 上限**只从 config 现算**（数值不进逻辑；面板文案也用这一个来源）。
     取不到就退回一个保底值 —— 但那是配置写坏了的情况，`verify` [50-c] 会直接报红。 */
  function maxDays() {
    var n = CFG && CFG.diary && CFG.diary.maxDays;
    return (typeof n === 'number' && isFinite(n) && n > 0) ? Math.floor(n) : 14;
  }

  /* 存档里那个容器。**唯一一处建结构 / 纠类型** ——
     脏档（导入的 JSON、被别的程序改过的 localStorage）可能是 `diary: 5`、
     `list: "x"`、某一天是字符串，全都在这儿收拾掉：后面几处一律假设拿到的数组能用。 */
  function store() {
    var s = G.State.get();
    if (!s.diary || typeof s.diary !== 'object' || Array.isArray(s.diary)) s.diary = {};
    if (!Array.isArray(s.diary.list)) s.diary.list = [];
    return s.diary;
  }

  /* 数值兜底：**能解析就解析**，解析不出来（NaN / 空 / 负数）当 0。
     与 `state.js: safeNum()` 同一个态度 —— 只是这里额外把负数也当脏值
     （日记里没有哪个量可以是负的）。不兜的话 `"3" + 1 === "31"`、
     `NaN += 1 === NaN`，两者都**不报错**，只是面板上的数看着离谱。 */
  function num0(v) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : 0;
  }

  /* 今天那一条（没有就新建并插到最前）。跨天 = `list[0].d` 不等于今天。
     截断也在这里做：只留 `maxDays()` 天，新的在前、**从最老那天开始扔**。 */
  function rowToday() {
    var st = store();
    var key = G.U.dayKey();
    var r = st.list[0];
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.d !== key) {
      r = { d: key, n: 0, kg: 0, idle: 0, nf: 0, flds: {}, npcs: [] };
      st.list.unshift(r);
      /* ⚠️ 截断**只在新建那天做**：每天最多触发一次，不必每条鱼都跑一遍 `pop()`。
         同时它让「同一天里反复读写」不改变数组长度 ⇒ 面板的日期顺序稳定。 */
      while (st.list.length > maxDays()) st.list.pop();
    }
    /* 逐字段纠类型（老档 / 脏档）。⚠️ 每次都写回：幂等，且保证下面几处的 `+1`
       一定作用在数字上。 */
    r.n = Math.round(num0(r.n));
    r.kg = num0(r.kg);
    r.idle = Math.round(num0(r.idle));
    r.nf = Math.round(num0(r.nf));
    if (!r.flds || typeof r.flds !== 'object' || Array.isArray(r.flds)) r.flds = {};
    if (!Array.isArray(r.npcs)) r.npcs = [];
    return r;
  }

  /* 钓到一条（`state.js: recordCatch()` 唯一的调用点）。
     `isNew` 由调用方给（它刚算完，是本项目里「是不是图鉴新增」的唯一判据）——
     在这儿重新查一次图鉴就是两份真相。
     `ctx.idle` 同样由调用方给（`fishing.js` 造 ctx 时问的 `isIdleMode()`，离线的整批标 true）——
     🔴 **不在这儿回头问 `G.Fishing.isIdleMode()`**：那会把两个模块的加载顺序绑死
        （`tools/test.js` 在 fishing 还没 init 时就要调 `recordCatch` 验记账，
        实测当场 TypeError），而判据本身仍然只有一处。 */
  function onCatch(fish, kg, colorKey, isNew, ctx) {
    if (!fish || typeof fish.id !== 'string' || !fish.id) return null;
    var w = num0(kg);
    var r = rowToday();
    r.n++;
    r.kg += w;
    if (ctx && ctx.idle) r.idle++;
    if (typeof fish.field === 'string' && fish.field) r.flds[fish.field] = Math.round(num0(r.flds[fish.field])) + 1;
    /* 今天最大的一尾：同重量保留先到的那一条（`>` 而不是 `>=`），
       否则同一天里反复抛同一条鱼会让「最大的那条」跳来跳去。 */
    if (w > 0 && (!r.best || w > num0(r.best.kg))) {
      r.best = { f: fish.id, kg: w, c: (typeof colorKey === 'string' && colorKey) ? colorKey : 'normal' };
    }
    if (isNew) r.nf++;
    return r;
  }

  /* 邻居开口了（事件 / 主动搭话 / 旁观对话三处都调）。
     🔴 **同一天同一位只记一次** —— 老陈一天里说三句话，日记里也是「碰上了老陈」，
        不是「老陈 ×3」（那是 `story.talk` 那种计数该干的事）。 */
  function onNpc(id) {
    if (typeof id !== 'string' || !id) return null;
    var r = rowToday();
    if (r.npcs.indexOf(id) < 0) r.npcs.push(id);
    return r;
  }

  /* 面板读的那份（新的在前）。脏档一律当空列表 —— 面板据此画空态。 */
  function days() {
    var s = G.State.get();
    var d = s && s.diary;
    if (!d || !Array.isArray(d.list)) return [];
    return d.list;
  }

  return {
    maxDays: maxDays,
    onCatch: onCatch,
    onNpc: onNpc,
    days: days,
  };
})();
