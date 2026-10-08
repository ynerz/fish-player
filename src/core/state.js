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
      settings: { sound: true, volume: 0.55, ambient: true, music: true, musicVol: 1.0, idle: false },
      lastSeen: Date.now(),
    };
  }

  /* ---------------- 存读档 ---------------- */
  /* 读档出问题时的提示语：由 main.js 在 boot 之后（Hud 就绪时）播一条 toast。
     原来迁移抛异常会一路冒到 boot() → **白屏**：存档其实还在 localStorage 里，
     页面却已经打不开了，玩家既看不到原因，也没有任何自救入口。 */
  var loadNote = '';
  function loadNoteText() { return loadNote; }

  function load() {
    var PS = G.Platform.storage;
    loadNote = '';
    var sawAny = false;
    /* 主存档 → 备份存档，逐个试。
       ⚠️ 「JSON 解析失败」和「迁移抛异常」都要退到下一级，别直接白屏 / 清档。 */
    var keys = [CFG.saveKey, CFG.saveKeyBak];
    for (var i = 0; i < keys.length; i++) {
      var raw = null;
      try { raw = PS.get(keys[i]); } catch (e) { raw = null; }
      if (!raw) continue;
      sawAny = true;
      var data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        if (G.Track) G.Track.error('存档不是对象（' + (i === 0 ? '主存档' : '备份存档') + '）', null, { stage: 'load' });
        continue;
      }
      try {
        S = migrate(data);
        /* 退了备份档 = 主存档坏了。**这是一条真正该告警的事**：
           玩家只会看到「进度回到上次」，看不出「存档坏过一次」，
           而上线后这正是判断「有没有普遍性的写坏 / 版本迁移问题」的唯一线索。
           用 warn 而不是 error：游戏照常能玩，进度也没丢。 */
        if (i > 0) {
          loadNote = '主存档读不出来，已从备份恢复到上次的进度';
          if (G.Track) G.Track.warn('主存档读不出来，已退到备份档', { stage: 'load' });
        }
        return S;
      } catch (e) {
        /* 迁移本身抛异常：记进 G.Track（G.Track.init() 在 St.load() 之前跑，这里一定拿得到），
           然后退一级用备份。以前这里没有 try，异常直接冒到 boot() → 白屏。 */
        if (G.Track) G.Track.error('存档迁移失败（' + (i === 0 ? '主存档' : '备份存档') + '）', e, { stage: 'migrate' });
      }
    }
    /* 全废了：先把原始文本挪到 rescue 键（否则下一个自动存档就把证据盖掉了），
       再开新档并告诉玩家一声 —— 静默清零比白屏更让人抓狂。 */
    if (sawAny) {
      try {
        var r0 = PS.get(CFG.saveKey), r1 = PS.get(CFG.saveKeyBak);
        PS.set(CFG.saveKeyRescue, [r0, r1].filter(function (x) { return !!x; }).join('\n---bak---\n'));
      } catch (e) { /* 存不进去也不能在这里再抛一次 */ }
      loadNote = '存档读取失败，已重置为新档（原始内容已留存在 ' + CFG.saveKeyRescue + '）';
    }
    S = blank();
    return S;
  }

  function migrate(d) {
    var b = blank();
    var from = safeNum(d.v, 1);

    /* ---- 容器字段的类型纠正（必须最先做）----
       下面一路都把这些字段当对象 / 数组用，却从没确认过它们**真的是**对象 / 数组。
       脏档（手改过的导入 JSON、老版本写坏的字段、被别的程序改过的 localStorage）
       会让它们变成数字或字符串，而后果大多不是「崩了就能看见」：
         · `stats: 5`    → d.stats.byRar 是 undefined，`.map` 抛 TypeError；
                           走 importSave 时只报一句「读不到 map」，走 load() 时
                           直接抛在 boot 里 → **白屏**。
         · `settings: 5` → 迁移看着「成功」，但 setIdle() 写的是 S.settings.idle，
                           在数字上赋值是**静默无效** → 挂机开关永远打不开。
         · `baits: 5`    → 买鱼饵扣了金币、`S.baits[id] = n` 静默不生效 → 饵没到账。
         · `rods: 5`     → `S.rods.indexOf` 不是函数，换竿 / 买竿直接 TypeError。
       先统一纠正类型，内容再由下面的逐字段兜底处理。 */
    ['stats', 'settings', 'baits', 'unlocked', 'book', 'medalSeen'].forEach(function (k) {
      if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) d[k] = {};
    });
    ['net', 'tank', 'rods', 'lines', 'decors', 'achSeen'].forEach(function (k) {
      if (!Array.isArray(d[k])) d[k] = [];
    });

    /* 历史遗留字段：`locked` 从第一天起就没人读过（「隐藏钓场被发现」这个功能没做），
       却每档都写进去 —— 留着只会让人读代码时误以为它已经实现了。
       老档里残留的那份也一并清掉（不再是 blank() 的一部分）。 */
    delete d.locked;
    /* 同理：`createdAt` 也是零消费字段 —— 每份存档都写「建档时间」，全项目没有一处读它
       （verify 32-h 上线时逮到的第一条真鱼）。删掉它不再写，老档里残留的那份一并清掉。
       ⚠️ 删字段**不需要**升 SAVE_V：浅合并只会补默认值，这里显式 delete 就够。 */
    delete d.createdAt;

    // 浅合并，保证新增字段有默认值
    Object.keys(b).forEach(function (k) { if (d[k] === undefined) d[k] = b[k]; });
    Object.keys(b.settings).forEach(function (k) { if (!d.settings || d.settings[k] === undefined) d.settings[k] = b.settings[k]; });
    Object.keys(b.stats).forEach(function (k) { if (!d.stats || d.stats[k] === undefined) d.stats[k] = b.stats[k]; });
    G.BAITS.forEach(function (x) { if (d.baits[x.id] === undefined) d.baits[x.id] = x.free ? -1 : 0; });
    if (!Array.isArray(d.net)) d.net = [];
    if (!Array.isArray(d.tank)) d.tank = [];
    /* 拥有列表只留真实存在的道具 id（`{rods:[123]}` 之类的脏数据会让选竿面板
       把每一把竿都显示成「已拥有」）；起手竿 / 线丢了就补回来，
       否则「换竿 / 换线」永远失败而玩家看不出为什么。 */
    ['rods', 'lines', 'decors'].forEach(function (k) {
      var list = k === 'rods' ? G.RODS : (k === 'lines' ? G.LINES : G.DECORS);
      d[k] = d[k].filter(function (id) { return list.some(function (x) { return x.id === id; }); });
    });
    if (d.rods.indexOf(G.RODS[0].id) < 0) d.rods.push(G.RODS[0].id);
    if (d.lines.indexOf(G.LINES[0].id) < 0) d.lines.push(G.LINES[0].id);
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
    /* 图鉴条目逐条纠正。条目结构 = { n, maxKg, colors, first }：
       缺 colors 的条目会让 recordCatch 在整条上鱼路径上抛异常（导入脏档实测复现过），
       类型不对 / 不认识的鱼种 id 直接丢掉 —— 宁可少一条记录，也别让游戏炸。 */
    var cleanBook = {};
    Object.keys(d.book || {}).forEach(function (id) {
      var e = (d.book || {})[id];
      if (!G.FISH_ID[id] || !e || typeof e !== 'object' || Array.isArray(e)) return;
      var colors = {}, sum = 0;
      if (e.colors && typeof e.colors === 'object' && !Array.isArray(e.colors)) {
        Object.keys(e.colors).forEach(function (k) {
          var n = Math.round(safeNum(e.colors[k], 0));
          if (n > 0) { colors[k] = n; sum += n; }
        });
      }
      cleanBook[id] = {
        /* n 是「钓到过几条」，颜色计数是它的拆分，缺一边时用另一边补，别出现「收集了但 0 条」 */
        n: Math.max(0, Math.round(safeNum(e.n, 0)), sum),
        maxKg: Math.max(0, safeNum(e.maxKg, 0)),
        colors: colors,
        first: isFinite(Number(e.first)) ? Number(e.first) : Date.now(),
      };
    });
    d.book = cleanBook;
    // 清掉失效的鱼种 id（比如以后删过鱼）
    d.net = (d.net || []).filter(function (e) {
      return e && G.FISH_ID[e.f] && isFinite(Number(e.kg)) && Number(e.kg) > 0;
    }).slice(0, d.netCap);
    d.tank = (d.tank || []).filter(function (e) {
      return e && G.FISH_ID[e.f] && isFinite(Number(e.kg)) && Number(e.kg) > 0;
    }).slice(0, d.tankCap);

    return d;
  }

  /* 「这看起来是不是本游戏的存档」。
     只看 coin / playTime 太弱 —— 一段 {coin:1, playTime:0} 的无关 JSON 也会被收下，
     而导入是**整档覆盖**，等于把玩家的存档清空。
     所以再要求至少出现一个本游戏特有的字段（光有金币和时长不够）。 */
  var OWN_KEYS = ['unlocked', 'book', 'baits', 'net', 'tank', 'rods', 'lines',
                  'decors', 'medals', 'eco', 'stats', 'achSeen', 'daily', 'weekly'];
  function looksLikeOurSave(d) {
    if (typeof d.coin !== 'number' && typeof d.playTime !== 'number') return false;
    for (var i = 0; i < OWN_KEYS.length; i++) {
      if (d[OWN_KEYS[i]] !== undefined) return true;
    }
    return false;
  }

  /* 存档导入：先校验再落地，避免一段烂 JSON 直接毁档 */
  function importSave(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { return { ok: false, msg: '不是合法的 JSON' }; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, msg: '存档格式不对' };
    if (!looksLikeOurSave(d)) {
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

  /* 卖鱼进账统一走这里。
     ⚠️ 不能直接用 `S.coin += p`：`netPrice()` 走 `Loot.price()`，而
        `Math.max(1, Math.round(NaN))` 还是 NaN（`Math.max` 遇 NaN 返回 NaN），
        所以脏存档 / 脏鱼护（kg 是 NaN）能算出一个 NaN 价，
        `S.coin += NaN` 会让金币**永久变 NaN**，存档再写出去就是 null。
     这里的安全兜底与 addCoin() 完全一致；顺带累计 stats.totalValue
     （口径 = 累计卖鱼收入，成就要用它）。 */
  function credit(p) {
    p = safeNum(p, 0);
    S.coin = Math.max(0, safeNum(S.coin, 0) + p);
    S.stats.totalValue = Math.max(0, safeNum(S.stats.totalValue, 0) + p);
    return p;
  }

  /* 对外的「卖鱼入账」出口：金币与「累计卖鱼收入」必须一起涨，然后通知 UI。
     挂机自动卖出（fishing.js）与结算卡的「卖出」（main.js）都要走这里 ——
     它们原来各自 `addCoin(p)` 之后再手写一行 `stats.totalValue += p`：
     漏写一处，成就「累计卖鱼收入」的口径就悄悄偏了；写错时也没有 NaN 兜底。 */
  function sellFish(p) {
    p = credit(p);
    scheduleSave();
    emit('coin', S.coin);
    return p;
  }

  function sellNetAt(i) {
    if (i < 0 || i >= S.net.length) return 0;
    var p = credit(netPrice(S.net[i]));
    S.net.splice(i, 1);
    save(); emit('coin'); emit('net');
    return p;
  }
  function sellAllNet() {
    if (!S.net.length) return 0;
    var p = credit(netValue());
    S.net.length = 0;
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
    /* ⚠️ 用**独立的**生态值颜色系数，不要拿售价倍率 valueMul 去乘 ——
       倍率是 100 量级的经济杠杆，会把这里的差距放大到 30 倍（已踩过，见 config.eco）。 */
    var cmMul = (cm && CFG.eco.colorMul[cm.key]) || CFG.eco.colorMul.normal;
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
    var p = credit(netPrice(S.tank[i]));
    S.tank.splice(i, 1);
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
    /* 脏条目兜底。这条路径**每钓一条鱼都会走**，必须自己扛住：
       存档导入 / 被手改过的档里可能只有 { n: 1 }（缺 colors），
       实测「导入这种档 → 钓到那条鱼」会在 e.colors[colorKey] 上抛 TypeError，
       整条上鱼流程（结算卡、任务、成就）全断。类型不对的条目直接当没见过。 */
    if (e && (typeof e !== 'object' || Array.isArray(e))) e = null;
    var isNew = !e;
    if (!e) {
      e = S.book[fish.id] = { n: 0, maxKg: 0, colors: {}, first: Date.now() };
    }
    e.n = Math.max(0, Math.round(safeNum(e.n, 0)));
    e.maxKg = Math.max(0, safeNum(e.maxKg, 0));
    if (!e.colors || typeof e.colors !== 'object' || Array.isArray(e.colors)) e.colors = {};
    if (!isFinite(e.first)) e.first = Date.now();
    e.n++;
    e.colors[colorKey] = Math.max(0, Math.round(safeNum(e.colors[colorKey], 0))) + 1;
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
    /* 用掉最后一枚 → 自动回退到免费饵。
       ⚠️ `emit('bait')` 只在函数末尾发一次：以前这个分支里也发了一次，
       于是「用掉最后一枚」这一竿会连发两次 bait 事件（订阅方只是同步底栏、
       不会出错，但属于白白多跑一遍）。要提示就用 toast，别复用 bait。 */
    var ranOut = S.baits[b.id] <= 0;
    if (ranOut) {
      S.baits[b.id] = 0;
      S.baitSel = 'worm';
    }
    scheduleSave();
    emit('bait');
    if (ranOut) emit('toast', { text: '鱼饵用完了，已切回蚯蚓', kind: 'warn' });
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
    loadNote: loadNoteText,
    importSave: importSave,
    get: get, on: on, emit: emit,
    curBait: curBait, curRod: curRod, curLine: curLine,
    bait: bait, rod: rod, line: line, baitCount: baitCount,
    addCoin: addCoin, spend: spend, sellFish: sellFish,
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
