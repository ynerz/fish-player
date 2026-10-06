/* =========================================================
   goals.js  —  每日任务 / 周常挑战 / 成就 / 称号（B5 + v0.5.6）
   =========================================================
   ⚠️ 奖励口径（设计约束，不要破坏）：
     每日任务、周常挑战与成就**只给「称号」和纯外观**，绝不给金币、鱼饵、
     装备或任何影响收益/掉率的数值 —— 否则经济曲线会被长线系统带跑。
     纪念币（medals）只是一个「收集计数」，没有消费出口，买不到任何
     影响玩法的东西。
   ---------------------------------------------------------
   · 每日任务：按**本地日期 + 当前进度阶段**做种子，确定性生成 3 条，
     不连服务器、不需要后端。当天生成后写进存档，跨天自动重掷。
   · 周常挑战（v0.5.6）：同一套引擎，种子换成 **ISO 周键**（`2026-W41`），
     每周 2 条、目标值大一号；这是长线留存里原来缺的「中层」。
   · 成就：**纯派生**（由存档现有数据直接算出来），不占存档字段，
     所以以后改成就条件不需要写存档迁移。
   ---------------------------------------------------------
   模板字段说明：
     id        唯一 id
     metric    取数口径，实现见 src/core/goals.js 的 METRICS
     dir       'up' = 越多越好（默认）；'down' = 越少越好
     pool      候选目标值（按进度阶段取下标）
     poolFn    动态候选（用了它就不用 pool），签名 (S) -> [数值]
     ctx       需要随机挑一个上下文：'field' | 'bait' | 'wx' | 'tm'
     minStage  至少解锁几个钓场才会被抽到（1 = 一开始就能抽）
     avail     额外可用性判断，签名 (S) -> boolean
     text      文案，签名 (need, key, S) -> string
     fmt       进度数值格式化，默认取整
   ⚠️ 同一张模板表里不要出现两条相同 metric 的模板（进度基准按 metric 记）。
   ========================================================= */
window.G = window.G || {};

/* ---------------- 每日任务模板池 ---------------- */
G.QUEST_TPL = [
  {
    id: 'catch', metric: 'catch', pool: [8, 12, 15, 20, 25], minStage: 1,
    text: function (n) { return '钓到 ' + n + ' 条鱼'; },
  },
  {
    id: 'cast', metric: 'cast', pool: [15, 25, 35, 45], minStage: 1,
    text: function (n) { return '抛竿 ' + n + ' 次'; },
  },
  {
    id: 'rare', metric: 'rareUp', pool: [2, 3, 5, 8], minStage: 1,
    text: function (n) { return '钓到 ' + n + ' 条「稀有」及以上的鱼'; },
  },
  {
    id: 'epic', metric: 'epicUp', pool: [1, 1, 2, 3], minStage: 1,
    text: function (n) { return '钓到 ' + n + ' 条「史诗」及以上的鱼'; },
  },
  {
    id: 'keep', metric: 'netKept', pool: [3, 5, 8, 12], minStage: 1,
    text: function (n) { return '把 ' + n + ' 条鱼收进鱼护'; },
  },
  {
    id: 'field', metric: 'field', ctx: 'field', pool: [5, 8, 12, 18], minStage: 1,
    text: function (n, key) {
      var f = G.FIELD_MAP[key];
      return '在「' + (f ? f.name : key) + '」钓到 ' + n + ' 条鱼';
    },
  },
  {
    id: 'bait', metric: 'bait', ctx: 'bait', pool: [3, 5, 8, 12], minStage: 1,
    text: function (n, key) {
      var b = null;
      for (var i = 0; i < G.BAITS.length; i++) if (G.BAITS[i].id === key) b = G.BAITS[i];
      return '用「' + (b ? b.name : key) + '」钓到 ' + n + ' 条鱼';
    },
  },
  {
    id: 'wx', metric: 'wx', ctx: 'wx', pool: [2, 3, 5, 8], minStage: 1,
    text: function (n, key) {
      var t = null;
      G.CONFIG.weather.types.forEach(function (x) { if (x.key === key) t = x; });
      return '在「' + (t ? t.name : key) + '」天钓到 ' + n + ' 条鱼';
    },
  },
  {
    id: 'tm', metric: 'tm', ctx: 'tm', pool: [2, 3, 5, 8], minStage: 1,
    text: function (n, key) {
      var t = null;
      G.CONFIG.weather.times.forEach(function (x) { if (x.key === key) t = x; });
      return '在「' + (t ? t.name : key) + '」时段钓到 ' + n + ' 条鱼';
    },
  },
  {
    id: 'value', metric: 'value', dir: 'up', pool: [800, 2000, 6000, 20000], minStage: 1,
    fmt: function (v) { return G.U.coin(v) + ' 金'; },
    text: function (n) { return '累计卖出 ' + G.U.coin(n) + ' 金币的鱼'; },
  },
  {
    id: 'big', metric: 'maxKg', poolFn: function (S) {
      var mx = 0;
      G.FIELDS.forEach(function (f) {
        if (!S.unlocked[f.id]) return;
        (G.FISH_BY_FIELD[f.id] || []).forEach(function (x) { if (x.maxKg > mx) mx = x.maxKg; });
      });
      var opts = [1, 2, 3, 5, 8, 15].filter(function (k) { return k <= mx * 0.9; });
      return opts.length ? opts : [1];
    }, minStage: 1,
    fmt: function (v) { return v.toFixed(1) + ' kg'; },
    text: function (n) { return '钓到 1 条 ' + n + ' kg 以上的鱼'; },
  },
];

/* ---------------- 周常挑战模板池（v0.5.6） ----------------
   和每日任务共用同一套引擎（metric / ctx / pool / text），只是目标值大一号、
   按「ISO 周」刷新一次。它补的是长线留存的**中层**：每日管当天、成就管全程，
   中间那段（一周）原来什么都没有。
   ⚠️ 奖励口径不变：只给纪念币与称号，绝不给金币 / 鱼饵 / 装备 / 掉率
      （每条几枚由 config.goals.weeklyMedals 决定，不要写死在这里）。
   ⚠️ **同一张表里不许两条模板用同一个 metric**：进度基准 base 是按 metric
      记的（见核心层 genBoard），撞车会让其中一条的基准被覆盖、进度永远算不对。
      tools/verify.js 第 ⑯ 节会静态断言这件事。 */
G.WEEKLY_TPL = [
  {
    id: 'wcatch', metric: 'catch', pool: [60, 90, 140, 200], minStage: 1,
    text: function (n) { return '本周钓到 ' + n + ' 条鱼'; },
  },
  {
    id: 'wcast', metric: 'cast', pool: [120, 180, 260, 350], minStage: 1,
    text: function (n) { return '本周抛竿 ' + n + ' 次'; },
  },
  {
    id: 'wvalue', metric: 'value', pool: [20000, 45000, 90000, 160000], minStage: 1,
    fmt: function (v) { return G.U.coin(v) + ' 金'; },
    text: function (n) { return '本周累计卖出 ' + G.U.coin(n) + ' 金币的鱼'; },
  },
  {
    id: 'wrare', metric: 'rareUp', pool: [12, 20, 30, 45], minStage: 1,
    text: function (n) { return '本周钓到 ' + n + ' 条「稀有」及以上的鱼'; },
  },
  {
    id: 'wepic', metric: 'epicUp', pool: [4, 7, 11, 16], minStage: 1,
    text: function (n) { return '本周钓到 ' + n + ' 条「史诗」及以上的鱼'; },
  },
  {
    id: 'wkeep', metric: 'netKept', pool: [20, 35, 55, 80], minStage: 1,
    text: function (n) { return '本周把 ' + n + ' 条鱼收进鱼护'; },
  },
  {
    id: 'wfield', metric: 'field', ctx: 'field', pool: [40, 60, 90, 130], minStage: 1,
    text: function (n, key) {
      var f = G.FIELD_MAP[key];
      return '本周在「' + (f ? f.name : key) + '」钓到 ' + n + ' 条鱼';
    },
  },
  {
    id: 'wbig', metric: 'maxKg', minStage: 1,
    /* 和每日的 big 同一套口径，只是门槛整体抬一档（周常比日常重） */
    poolFn: function (S) {
      var mx = 0;
      G.FIELDS.forEach(function (f) {
        if (!S.unlocked[f.id]) return;
        (G.FISH_BY_FIELD[f.id] || []).forEach(function (x) { if (x.maxKg > mx) mx = x.maxKg; });
      });
      var opts = [2, 3, 5, 8, 12, 20].filter(function (k) { return k <= mx * 0.9; });
      return opts.length ? opts : [1];
    },
    fmt: function (v) { return v.toFixed(1) + ' kg'; },
    text: function (n) { return '本周钓到 1 条 ' + n + ' kg 以上的鱼'; },
  },
];

/* ---------------- 成就表 ----------------
   cat: book 图鉴类 / record 纪录类 / skill 操作类
   有 title 字段的成就，达成后会**同时解锁一个称号**。 */
G.ACH_CATS = [
  { key: 'book',   name: '图鉴类' },
  { key: 'record', name: '纪录类' },
  { key: 'skill',  name: '操作类' },
];

G.ACHIEVEMENTS = [
  /* ---- 图鉴类 ---- */
  { id: 'b1',   cat: 'book', name: '初次见面', desc: '收集 1 种鱼',            metric: 'bookCount', need: 1 },
  { id: 'b20',  cat: 'book', name: '小有收获', desc: '收集 20 种鱼',           metric: 'bookCount', need: 20 },
  { id: 'b60',  cat: 'book', name: '半池鱼影', desc: '收集 60 种鱼',           metric: 'bookCount', need: 60 },
  { id: 'b120', cat: 'book', name: '博闻强识', desc: '收集 120 种鱼',          metric: 'bookCount', need: 120 },
  { id: 'b240', cat: 'book', name: '图鉴大家', desc: '收集 240 种鱼',          metric: 'bookCount', need: 240, title: '图鉴大家' },
  { id: 'b362', cat: 'book', name: '万鱼之书', desc: '收集全部 362 种鱼',       metric: 'bookCount', need: 362, title: '万鱼之书' },
  { id: 'c30',  cat: 'book', name: '色之启蒙', desc: '收集 30 种「品种 × 颜色」', metric: 'colorCount', need: 30 },
  { id: 'c200', cat: 'book', name: '五彩斑斓', desc: '收集 200 种配色',         metric: 'colorCount', need: 200 },
  { id: 'c600', cat: 'book', name: '虹彩猎人', desc: '收集 600 种配色',         metric: 'colorCount', need: 600, title: '虹彩猎人' },
  { id: 'c1810', cat: 'book', name: '调色盘',  desc: '集齐全部 1810 种配色',     metric: 'colorCount', need: 1810, title: '调色盘' },
  { id: 'f7',   cat: 'book', name: '七海旅人', desc: '解锁全部 7 个钓场',        metric: 'fieldsOpen', need: 7, title: '七海旅人' },

  /* ---- 纪录类 ---- */
  { id: 'k1',   cat: 'record', name: '一斤在手',   desc: '单条鱼达到 1 kg',   metric: 'maxKgAll', need: 1 },
  { id: 'k5',   cat: 'record', name: '五斤巨物',   desc: '单条鱼达到 5 kg',   metric: 'maxKgAll', need: 5 },
  { id: 'k15',  cat: 'record', name: '十五斤传说', desc: '单条鱼达到 15 kg',  metric: 'maxKgAll', need: 15, title: '巨物猎人' },
  { id: 'k40',  cat: 'record', name: '四十斤神话', desc: '单条鱼达到 40 kg',  metric: 'maxKgAll', need: 40, title: '海皇' },
  { id: 'v5',   cat: 'record', name: '小有积蓄', desc: '累计卖鱼收入 5 万',    metric: 'totalValue', need: 50000,   fmt: 'coin' },
  { id: 'v50',  cat: 'record', name: '富甲一方', desc: '累计卖鱼收入 50 万',   metric: 'totalValue', need: 500000,  fmt: 'coin' },
  { id: 'v500', cat: 'record', name: '渔场主',   desc: '累计卖鱼收入 500 万',  metric: 'totalValue', need: 5000000, fmt: 'coin', title: '渔场主' },
  { id: 't1',   cat: 'record', name: '初上手',   desc: '累计游玩 1 小时',   metric: 'playHours', need: 1 },
  { id: 't20',  cat: 'record', name: '老钓手',   desc: '累计游玩 20 小时',  metric: 'playHours', need: 20 },
  { id: 't100', cat: 'record', name: '与鱼为伴', desc: '累计游玩 100 小时', metric: 'playHours', need: 100, title: '与鱼为伴' },
  { id: 'n30',  cat: 'record', name: '满载而归', desc: '鱼护里同时装到过 30 条鱼', metric: 'netMax',  need: 30 },
  { id: 'tk12', cat: 'record', name: '水族馆长', desc: '水族箱里同时装到过 12 条鱼', metric: 'tankMax', need: 12, title: '水族馆长' },

  /* ---- 操作类 ---- */
  { id: 's10',  cat: 'skill', name: '手感来了',   desc: '连续成功 10 竿（中途不断线/不脱钩）', metric: 'maxStreak', need: 10 },
  { id: 's50',  cat: 'skill', name: '稳如磐石',   desc: '连续成功 50 竿',   metric: 'maxStreak', need: 50,  title: '稳如磐石' },
  { id: 's150', cat: 'skill', name: '一竿不落',   desc: '连续成功 150 竿',  metric: 'maxStreak', need: 150, title: '一竿不落' },
  { id: 'i100', cat: 'skill', name: '托管初体验', desc: '挂机钓获 100 条鱼',   metric: 'idleCatches', need: 100 },
  { id: 'i2000',cat: 'skill', name: '全自动渔夫', desc: '挂机钓获 2000 条鱼',  metric: 'idleCatches', need: 2000, title: '全自动渔夫' },
  { id: 'baits',cat: 'skill', name: '万物皆饵',   desc: '用全部 13 种鱼饵都成功上过鱼', metric: 'baitUsed', need: 13, title: '万物皆饵' },
  { id: 'wxall',cat: 'skill', name: '风雨无阻',   desc: '在 4 种天气下都上过鱼',  metric: 'wxUsed', need: 4 },
  { id: 'tmall',cat: 'skill', name: '昼夜不歇',   desc: '在 4 个时段都上过鱼',    metric: 'tmUsed', need: 4 },
];

/* ---------------- 纪念币里程碑称号 ----------------
   纪念币唯一来源 = 完成每日任务，一天最多 3 枚。
   它没有任何消费出口，只是一个「坚持登录」的纪念章。 */
G.MEDAL_TITLES = [
  { id: 'm10',  name: '拾贝人',   need: 10,  desc: '累计获得 10 枚纪念币' },
  { id: 'm40',  name: '赶海人',   need: 40,  desc: '累计获得 40 枚纪念币' },
  { id: 'm120', name: '纪念收藏家', need: 120, desc: '累计获得 120 枚纪念币' },
];

/* 每日任务每天几条 / 周常挑战每周几条。
   写死在这里是为了让 core/goals.js 不用再定义常量；
   **奖励数值**（每条几枚纪念币）在 config.goals 里，不要放这儿。 */
G.QUEST_PER_DAY = 3;
G.WEEKLY_PER_WEEK = 2;
