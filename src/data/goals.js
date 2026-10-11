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

/* ---------------- 成就的四段解锁曲线（E2 · 2026-10-11 用户口径） ----------------
   用户原话：「成就数量可以根据稀有度自己设置，100 多个都没问题……
   **一定要好好设计这个解锁曲线**，这个是玩家后期玩下去的重要动力」。
   ---------------------------------------------------------
   口径：总量 ≥ 100，四段占比 ≈ **30% / 30% / 35% / 5%**（按「完成所需投入」排，
   不是按三个类目平摊）；`need` 在同一 `metric`（带 `key` 的按 metric+key 分组）
   内**严格递增、不许重复**；每条都**必须能达成**（need ≤ 该 metric 的物理上界）。
   ⚠️ 这里只放**档位文案**；每条成就自己的摊派写在 `G.ACHIEVEMENTS[].tier`，
      面板据此画四段进度，`verify §54 ①` 逐条对拍占比与「tier 随 need 单调」。
   ========================================================= */
G.ACH_TIERS = [
  { tier: 1, name: '起步', desc: '刚开始玩就能顺手拿到' },
  { tier: 2, name: '进阶', desc: '正常玩上一阵子自然会完成' },
  { tier: 3, name: '精通', desc: '要专门去刷，投入明显上台阶' },
  { tier: 4, name: '极限', desc: '收满 / 数十年如一日的长线目标' },
];

/* ---------------- 彩蛋（30 条 · 隐藏 · 概率获得） ----------------
   越往后越难 —— 前 30% 概率较高、30~60% 适中、60~95% 降低但努力可得、95~100% 极其困难。
   ---------------------------------------------------------
   字段：
     id     唯一 id（'e01'…'e30'，按投入从易到难排）
     tier   档位 1..4（文案见 G.EGG_TIERS），**条数必须是 9 / 9 / 10 / 2**
     oneIn  「符合条件的一竿」的中奖概率倒数（N ⇒ 期望 N 竿撞上一次），**同档内严格递增**
     name   撞见之后才显示的名字
     hint   没撞见时显示的**氛围提示** —— 🔴 与 name 不许有 2 个连续相同汉字
            （等于把答案写在题面上；`verify §54` 逐条对拍）
     cond   有资格掷点的条件（**不改变单竿概率**，只是把「有资格的竿」挑出来）：
            field = 钓场 id · wx = 天气 key · tm = 时段 key · rar = 稀有度下标（0~3）
            空对象 = 任何一竿都有资格
   🔴 「凑条件真的能加速」是刻意的：罕见彩蛋都挂着条件，玩家拼命凑条件就有事可做。
   ========================================================= */
G.EGG_TIERS = [
  { tier: 1, name: '偶遇', desc: '随手就能碰上几条' },
  { tier: 2, name: '少见', desc: '玩上一阵子自然会遇到' },
  { tier: 3, name: '罕有', desc: '得专门去凑条件' },
  { tier: 4, name: '传说', desc: '后期极限目标' },
];

G.EASTER_EGGS = [
  /* ---- ① 偶遇（9 条 · 1/120 ~ 1/300） ---- */
  { id: 'e01', tier: 1, oneIn: 140, name: '水面的月亮', hint: '夜里的光，好像分成了两半。', cond: { tm: 'night' } },
  { id: 'e02', tier: 1, oneIn: 160, name: '蜻蜓落竿', hint: '有只小家伙把你的家伙当成了树枝。', cond: { wx: 'clear', tm: 'day' } },
  { id: 'e03', tier: 1, oneIn: 180, name: '一片旧渔网', hint: '水底挂着什么看不清的东西。', cond: {} },
  { id: 'e04', tier: 1, oneIn: 200, name: '谁的水壶', hint: '岸边的草丛里好像落了东西。', cond: {} },
  { id: 'e05', tier: 1, oneIn: 220, name: '雨点节奏', hint: '敲在浮标上的声音，有个调子。', cond: { wx: 'rain' } },
  { id: 'e06', tier: 1, oneIn: 240, name: '雾里的脚步声', hint: '看不清的另一边，有什么在走。', cond: { wx: 'fog' } },
  { id: 'e07', tier: 1, oneIn: 260, name: '竿梢的露水', hint: '天刚亮，你的线尖挂着什么。', cond: { tm: 'dawn' } },
  { id: 'e08', tier: 1, oneIn: 280, name: '一条会看你的鱼', hint: '把它放回去之后，它没有立刻走。', cond: { rar: 1 } },
  { id: 'e09', tier: 1, oneIn: 300, name: '夕阳正好', hint: '这个点的光，怎么拍都好看。', cond: { tm: 'dusk' } },

  /* ---- ② 少见（9 条 · 1/400 ~ 1/900） ---- */
  { id: 'e10', tier: 2, oneIn: 420, name: '水底的石子路', hint: '浅滩下面好像铺着一条道。', cond: { field: 'C' } },
  { id: 'e11', tier: 2, oneIn: 470, name: '老陈的旧照片', hint: '村口的木箱里压着一张东西。', cond: { field: 'D' } },
  { id: 'e12', tier: 2, oneIn: 520, name: '井水的凉', hint: '有一股温度顺着线传上来。', cond: { field: 'D', tm: 'day' } },
  { id: 'e13', tier: 2, oneIn: 580, name: '海雾里的灯', hint: '很远的地方，有一点光。', cond: { field: 'A', wx: 'fog' } },
  { id: 'e14', tier: 2, oneIn: 640, name: '珊瑚的年轮', hint: '那一丛东西上有一圈一圈的痕。', cond: { field: 'S' } },
  { id: 'e15', tier: 2, oneIn: 700, name: '沉船的铜铃', hint: '水底传来一声很轻的响。', cond: { field: 'S', wx: 'rain' } },
  { id: 'e16', tier: 2, oneIn: 760, name: '星陨的碎片', hint: '有一小块东西掉进了这片水里。', cond: { field: 'SS', tm: 'night' } },
  { id: 'e17', tier: 2, oneIn: 820, name: '冰下的鱼影', hint: '水面之下，一大片黑在慢慢移动。', cond: { field: 'SS', tm: 'dawn' } },
  { id: 'e18', tier: 2, oneIn: 900, name: '时之尽头的回声', hint: '这里安静得能听见自己的心跳。', cond: { field: 'SSS' } },

  /* ---- ③ 罕有（10 条 · 1/1200 ~ 1/4000） ---- */
  { id: 'e19', tier: 3, oneIn: 1200, name: '双生的影子', hint: '水里有两个轮廓，可你只放了一条线。', cond: { field: 'A', tm: 'night', wx: 'clear' } },
  { id: 'e20', tier: 3, oneIn: 1400, name: '会发光的浮漂', hint: '这一竿那点亮点得不太正常。', cond: { field: 'S', rar: 2 } },
  { id: 'e21', tier: 3, oneIn: 1650, name: '无人的小船', hint: '湖心停着一样东西，上面没有谁。', cond: { field: 'B', wx: 'fog' } },
  { id: 'e22', tier: 3, oneIn: 1900, name: '逆流的鱼', hint: '它明明是往下去的方向。', cond: { field: 'C', rar: 1 } },
  { id: 'e23', tier: 3, oneIn: 2200, name: '星陨之渊的歌', hint: '水里有一种很低的、连着的声音。', cond: { field: 'SS', wx: 'cloudy' } },
  { id: 'e24', tier: 3, oneIn: 2500, name: '巨物的影子', hint: '那条东西，比你的船还长。', cond: { rar: 3 } },
  { id: 'e25', tier: 3, oneIn: 2800, name: '雨夜的同行者', hint: '这么晚、这么大的雨，还有谁在？', cond: { field: 'SSS', wx: 'rain', tm: 'night' } },
  { id: 'e26', tier: 3, oneIn: 3100, name: '鱼群的转向', hint: '整片水里，它们同时转了身。', cond: { field: 'S', tm: 'dusk' } },
  { id: 'e27', tier: 3, oneIn: 3500, name: '被钓过的鱼', hint: '它的嘴角有一个很旧的痕迹。', cond: { rar: 2 } },
  { id: 'e28', tier: 3, oneIn: 4000, name: '水面的字', hint: '雾散之前，上面浮出过几个符号。', cond: { field: 'SSS', wx: 'fog', tm: 'dawn' } },

  /* ---- ④ 传说（2 条 · 1/6000 / 1/12000） ---- */
  { id: 'e29', tier: 4, oneIn: 6000, name: '时之尽头的那一尾', hint: '传说里，这条水上有一条谁都只见过一次的鱼。', cond: { field: 'SSS', rar: 3 } },
  { id: 'e30', tier: 4, oneIn: 12000, name: '钓鱼人生的第一竿', hint: '你忽然想不起来，自己是为什么开始钓的。', cond: { rar: 0, tm: 'dawn' } },
];

/* ---------------- 成就（纯派生） ----------------
   由存档现有数据直接算出来，**不占存档字段** ⇒ 以后改条件 / 加成就都不需要写存档迁移。
   共 **117 条**（2026-10-11 E2 扩容：31 → 117），四段摊派 **36 / 35 / 40 / 6**
   ＝ 30.8% / 29.9% / 34.2% / 5.1%，对齐用户的 30% / 30% / 35% / 5%（见 `G.ACH_TIERS`）。
   字段：
     tier   四段档位 1..4（文案见 `G.ACH_TIERS`），**同一 metric 内随 need 单调不降**
     key    只有 `field` / `wx` 这两条**带 key 的取数口径**才写（值域见下）；别的 metric 写了不生效
   ⚠️ 奖励口径：只给称号与纪念币（见文件头）。
   ⚠️ `need` 必须**在 metric（带 key 的按 metric+key 分组）内严格递增、不留重复**；
      且每条都**必须能达成**（need ≤ 该 metric 的物理上界：图鉴 362 / 配色 1810 /
      钓场 7 / 鱼饵 13 / 天气 4 / 时段 4 / 鱼护峰值 150 / 水族箱峰值 24）—— `verify §54 ①` 盯住。
   ⚠️ `field` 的 key 取 `G.FIELDS` 的 id、`wx` 的 key 取 `CFG.weather.types` 的 key，
      **且 `desc` 里必须出现该 key 对应的显示名**（key 与玩家看到的那句话不许说两件事）。
   ========================================================= */
G.ACHIEVEMENTS = [
  /* ---- 图鉴类 · 图鉴收集 ---- */
  { id: 'b1',     cat: 'book',    name: '初次见面',  desc: '收集 1 种鱼',                     metric: 'bookCount',   need: 1,    tier: 1 },
  { id: 'b5',     cat: 'book',    name: '零星几种',  desc: '收集 5 种鱼',                     metric: 'bookCount',   need: 5,    tier: 1 },
  { id: 'b10',    cat: 'book',    name: '渐入佳境',  desc: '收集 10 种鱼',                    metric: 'bookCount',   need: 10,   tier: 1 },
  { id: 'b20',    cat: 'book',    name: '小有收获',  desc: '收集 20 种鱼',                    metric: 'bookCount',   need: 20,   tier: 1 },
  { id: 'b35',    cat: 'book',    name: '池边熟人',  desc: '收集 35 种鱼',                    metric: 'bookCount',   need: 35,   tier: 2 },
  { id: 'b60',    cat: 'book',    name: '半池鱼影',  desc: '收集 60 种鱼',                    metric: 'bookCount',   need: 60,   tier: 2 },
  { id: 'b90',    cat: 'book',    name: '名录渐长',  desc: '收集 90 种鱼',                    metric: 'bookCount',   need: 90,   tier: 2 },
  { id: 'b120',   cat: 'book',    name: '博闻强识',  desc: '收集 120 种鱼',                   metric: 'bookCount',   need: 120,  tier: 3 },
  { id: 'b170',   cat: 'book',    name: '半个图鉴',  desc: '收集 170 种鱼',                   metric: 'bookCount',   need: 170,  tier: 3 },
  { id: 'b240',   cat: 'book',    name: '图鉴大家',  desc: '收集 240 种鱼',                   metric: 'bookCount',   need: 240,  tier: 3,   title: '图鉴大家' },
  { id: 'b300',   cat: 'book',    name: '几近收齐',  desc: '收集 300 种鱼',                   metric: 'bookCount',   need: 300,  tier: 3 },
  { id: 'b362',   cat: 'book',    name: '万鱼之书',  desc: '收集全部 362 种鱼',               metric: 'bookCount',   need: 362,  tier: 4,   title: '万鱼之书' },

  /* ---- 图鉴类 · 品种 × 颜色 ---- */
  { id: 'c5',     cat: 'book',    name: '第一次变色', desc: '收集 5 种「品种 × 颜色」',        metric: 'colorCount',  need: 5,    tier: 1 },
  { id: 'c15',    cat: 'book',    name: '颜色入门',  desc: '收集 15 种配色',                  metric: 'colorCount',  need: 15,   tier: 1 },
  { id: 'c30',    cat: 'book',    name: '色之启蒙',  desc: '收集 30 种「品种 × 颜色」',       metric: 'colorCount',  need: 30,   tier: 1 },
  { id: 'c60',    cat: 'book',    name: '渐有色彩',  desc: '收集 60 种配色',                  metric: 'colorCount',  need: 60,   tier: 2 },
  { id: 'c120',   cat: 'book',    name: '一柜好色',  desc: '收集 120 种配色',                 metric: 'colorCount',  need: 120,  tier: 2 },
  { id: 'c200',   cat: 'book',    name: '五彩斑斓',  desc: '收集 200 种配色',                 metric: 'colorCount',  need: 200,  tier: 3 },
  { id: 'c320',   cat: 'book',    name: '色谱渐宽',  desc: '收集 320 种配色',                 metric: 'colorCount',  need: 320,  tier: 3 },
  { id: 'c600',   cat: 'book',    name: '虹彩猎人',  desc: '收集 600 种配色',                 metric: 'colorCount',  need: 600,  tier: 3,   title: '虹彩猎人' },
  { id: 'c1000',  cat: 'book',    name: '千色入册',  desc: '收集 1000 种配色',                metric: 'colorCount',  need: 1000, tier: 3 },
  { id: 'c1810',  cat: 'book',    name: '调色盘',    desc: '集齐全部 1810 种配色',            metric: 'colorCount',  need: 1810, tier: 4,   title: '调色盘' },

  /* ---- 图鉴类 · 钓场解锁 ---- */
  { id: 'f2',     cat: 'book',    name: '两处水边',  desc: '解锁 2 个钓场',                   metric: 'fieldsOpen',  need: 2,    tier: 1 },
  { id: 'f5',     cat: 'book',    name: '行遍五湖',  desc: '解锁 5 个钓场',                   metric: 'fieldsOpen',  need: 5,    tier: 2 },
  { id: 'f7',     cat: 'book',    name: '七海旅人',  desc: '解锁全部 7 个钓场',               metric: 'fieldsOpen',  need: 7,    tier: 3,   title: '七海旅人' },

  /* ---- 图鉴类 · 单钓场渔获（keyed）---- */
  { id: 'fd100',  cat: 'book',    name: '池塘常客',  desc: '在「村口小池塘」钓到 100 条鱼',   metric: 'field',       key: 'D',  need: 100,  tier: 2 },
  { id: 'fc100',  cat: 'book',    name: '浅滩常客',  desc: '在「溪流浅滩」钓到 100 条鱼',     metric: 'field',       key: 'C',  need: 100,  tier: 2 },
  { id: 'fb100',  cat: 'book',    name: '半岛常客',  desc: '在「湖心半岛」钓到 100 条鱼',     metric: 'field',       key: 'B',  need: 100,  tier: 2 },
  { id: 'fa100',  cat: 'book',    name: '断崖常客',  desc: '在「深海断崖」钓到 100 条鱼',     metric: 'field',       key: 'A',  need: 100,  tier: 2 },
  { id: 'fs60',   cat: 'book',    name: '海沟常客',  desc: '在「幽蓝海沟」钓到 60 条鱼',      metric: 'field',       key: 'S',  need: 60,   tier: 3 },
  { id: 'fss30',  cat: 'book',    name: '深渊常客',  desc: '在「星陨之渊」钓到 30 条鱼',      metric: 'field',       key: 'SS', need: 30,   tier: 3 },
  { id: 'fsss20', cat: 'book',    name: '尽头常客',  desc: '在「时之尽头」钓到 20 条鱼',      metric: 'field',       key: 'SSS', need: 20,   tier: 3 },

  /* ---- 纪录类 · 单条最大重量 ---- */
  { id: 'k0',     cat: 'record',  name: '小有分量',  desc: '单条鱼达到 0.5 kg',               metric: 'maxKgAll',    need: 0.5,  tier: 1 },
  { id: 'k1',     cat: 'record',  name: '一斤在手',  desc: '单条鱼达到 1 kg',                 metric: 'maxKgAll',    need: 1,    tier: 1 },
  { id: 'k2',     cat: 'record',  name: '两斤出头',  desc: '单条鱼达到 2 kg',                 metric: 'maxKgAll',    need: 2,    tier: 2 },
  { id: 'k5',     cat: 'record',  name: '五斤巨物',  desc: '单条鱼达到 5 kg',                 metric: 'maxKgAll',    need: 5,    tier: 2 },
  { id: 'k8',     cat: 'record',  name: '八斤上桌',  desc: '单条鱼达到 8 kg',                 metric: 'maxKgAll',    need: 8,    tier: 3 },
  { id: 'k15',    cat: 'record',  name: '十五斤传说', desc: '单条鱼达到 15 kg',                metric: 'maxKgAll',    need: 15,   tier: 3,   title: '巨物猎人' },
  { id: 'k25',    cat: 'record',  name: '二十五斤',  desc: '单条鱼达到 25 kg',                metric: 'maxKgAll',    need: 25,   tier: 3 },
  { id: 'k40',    cat: 'record',  name: '四十斤神话', desc: '单条鱼达到 40 kg',                metric: 'maxKgAll',    need: 40,   tier: 3,   title: '海皇' },
  { id: 'k100',   cat: 'record',  name: '百斤巨兽',  desc: '单条鱼达到 100 kg',               metric: 'maxKgAll',    need: 100,  tier: 4 },

  /* ---- 纪录类 · 累计卖鱼收入 ---- */
  { id: 'v1',     cat: 'record',  name: '第一桶金',  desc: '累计卖鱼收入 5 千',               metric: 'totalValue',  need: 5000, tier: 1 },
  { id: 'v5',     cat: 'record',  name: '小有积蓄',  desc: '累计卖鱼收入 5 万',               metric: 'totalValue',  need: 50000, tier: 1 },
  { id: 'v20',    cat: 'record',  name: '有房有船',  desc: '累计卖鱼收入 20 万',              metric: 'totalValue',  need: 200000, tier: 2 },
  { id: 'v50',    cat: 'record',  name: '富甲一方',  desc: '累计卖鱼收入 50 万',              metric: 'totalValue',  need: 500000, tier: 2 },
  { id: 'v150',   cat: 'record',  name: '一方巨富',  desc: '累计卖鱼收入 150 万',             metric: 'totalValue',  need: 1500000, tier: 3 },
  { id: 'v500',   cat: 'record',  name: '渔场主',    desc: '累计卖鱼收入 500 万',             metric: 'totalValue',  need: 5000000, tier: 3,   title: '渔场主' },
  { id: 'v2000',  cat: 'record',  name: '富可敌国',  desc: '累计卖鱼收入 2000 万',            metric: 'totalValue',  need: 20000000, tier: 4 },

  /* ---- 纪录类 · 累计游玩时长 ---- */
  { id: 't0',     cat: 'record',  name: '开竿',      desc: '累计游玩 0.5 小时',               metric: 'playHours',   need: 0.5,  tier: 1 },
  { id: 't1',     cat: 'record',  name: '初上手',    desc: '累计游玩 1 小时',                 metric: 'playHours',   need: 1,    tier: 1 },
  { id: 't5',     cat: 'record',  name: '午后小坐',  desc: '累计游玩 5 小时',                 metric: 'playHours',   need: 5,    tier: 2 },
  { id: 't20',    cat: 'record',  name: '老钓手',    desc: '累计游玩 20 小时',                metric: 'playHours',   need: 20,   tier: 2 },
  { id: 't50',    cat: 'record',  name: '常在水边',  desc: '累计游玩 50 小时',                metric: 'playHours',   need: 50,   tier: 3 },
  { id: 't100',   cat: 'record',  name: '与鱼为伴',  desc: '累计游玩 100 小时',               metric: 'playHours',   need: 100,  tier: 3,   title: '与鱼为伴' },
  { id: 't200',   cat: 'record',  name: '半个人生',  desc: '累计游玩 200 小时',               metric: 'playHours',   need: 200,  tier: 4 },

  /* ---- 纪录类 · 鱼护峰值 ---- */
  { id: 'n5',     cat: 'record',  name: '已有存鱼',  desc: '鱼护里同时装到过 5 条鱼',         metric: 'netMax',      need: 5,    tier: 1 },
  { id: 'n12',    cat: 'record',  name: '半护渔获',  desc: '鱼护里同时装到过 12 条鱼',        metric: 'netMax',      need: 12,   tier: 1 },
  { id: 'n30',    cat: 'record',  name: '满载而归',  desc: '鱼护里同时装到过 30 条鱼',        metric: 'netMax',      need: 30,   tier: 2 },
  { id: 'n60',    cat: 'record',  name: '鱼护扩容',  desc: '鱼护里同时装到过 60 条鱼',        metric: 'netMax',      need: 60,   tier: 3 },
  { id: 'n100',   cat: 'record',  name: '百鱼在护',  desc: '鱼护里同时装到过 100 条鱼',       metric: 'netMax',      need: 100,  tier: 3 },
  { id: 'n150',   cat: 'record',  name: '鱼护满载',  desc: '鱼护里同时装到过 150 条鱼',       metric: 'netMax',      need: 150,  tier: 3 },

  /* ---- 纪录类 · 水族箱峰值 ---- */
  { id: 'tk3',    cat: 'record',  name: '三尾入缸',  desc: '水族箱里同时装到过 3 条鱼',       metric: 'tankMax',     need: 3,    tier: 1 },
  { id: 'tk6',    cat: 'record',  name: '初次成景',  desc: '水族箱里同时装到过 6 条鱼',       metric: 'tankMax',     need: 6,    tier: 1 },
  { id: 'tk12',   cat: 'record',  name: '水族馆长',  desc: '水族箱里同时装到过 12 条鱼',      metric: 'tankMax',     need: 12,   tier: 2,   title: '水族馆长' },
  { id: 'tk24',   cat: 'record',  name: '满缸生辉',  desc: '水族箱里同时装到过 24 条鱼',      metric: 'tankMax',     need: 24,   tier: 3 },

  /* ---- 操作类 · 连续成功竿数 ---- */
  { id: 's5',     cat: 'skill',   name: '手感不错',  desc: '连续成功 5 竿（中途不断线/不脱钩）', metric: 'maxStreak',   need: 5,    tier: 1 },
  { id: 's10',    cat: 'skill',   name: '手感来了',  desc: '连续成功 10 竿（中途不断线/不脱钩）', metric: 'maxStreak',   need: 10,   tier: 1 },
  { id: 's25',    cat: 'skill',   name: '手稳心定',  desc: '连续成功 25 竿',                  metric: 'maxStreak',   need: 25,   tier: 2 },
  { id: 's50',    cat: 'skill',   name: '稳如磐石',  desc: '连续成功 50 竿',                  metric: 'maxStreak',   need: 50,   tier: 2,   title: '稳如磐石' },
  { id: 's80',    cat: 'skill',   name: '八十连捷',  desc: '连续成功 80 竿',                  metric: 'maxStreak',   need: 80,   tier: 3 },
  { id: 's150',   cat: 'skill',   name: '一竿不落',  desc: '连续成功 150 竿',                 metric: 'maxStreak',   need: 150,  tier: 3,   title: '一竿不落' },
  { id: 's300',   cat: 'skill',   name: '三百竿不断', desc: '连续成功 300 竿',                 metric: 'maxStreak',   need: 300,  tier: 4 },

  /* ---- 操作类 · 挂机钓获 ---- */
  { id: 'i20',    cat: 'skill',   name: '试着托管',  desc: '挂机钓获 20 条鱼',                metric: 'idleCatches', need: 20,   tier: 1 },
  { id: 'i100',   cat: 'skill',   name: '托管初体验', desc: '挂机钓获 100 条鱼',               metric: 'idleCatches', need: 100,  tier: 1 },
  { id: 'i400',   cat: 'skill',   name: '半自动钓手', desc: '挂机钓获 400 条鱼',               metric: 'idleCatches', need: 400,  tier: 2 },
  { id: 'i800',   cat: 'skill',   name: '夜里的钓竿', desc: '挂机钓获 800 条鱼',               metric: 'idleCatches', need: 800,  tier: 3 },
  { id: 'i2000',  cat: 'skill',   name: '全自动渔夫', desc: '挂机钓获 2000 条鱼',              metric: 'idleCatches', need: 2000, tier: 3,   title: '全自动渔夫' },

  /* ---- 操作类 · 累计钓获 ---- */
  { id: 'ca3',    cat: 'skill',   name: '开张',      desc: '累计钓到 3 条鱼',                 metric: 'catch',       need: 3,    tier: 1 },
  { id: 'ca10',   cat: 'skill',   name: '十全十美',  desc: '累计钓到 10 条鱼',                metric: 'catch',       need: 10,   tier: 1 },
  { id: 'ca50',   cat: 'skill',   name: '小有所获',  desc: '累计钓到 50 条鱼',                metric: 'catch',       need: 50,   tier: 1 },
  { id: 'ca200',  cat: 'skill',   name: '两百竿有余', desc: '累计钓到 200 条鱼',               metric: 'catch',       need: 200,  tier: 2 },
  { id: 'ca600',  cat: 'skill',   name: '常钓不辍',  desc: '累计钓到 600 条鱼',               metric: 'catch',       need: 600,  tier: 2 },
  { id: 'ca1500', cat: 'skill',   name: '千五百尾',  desc: '累计钓到 1500 条鱼',              metric: 'catch',       need: 1500, tier: 3 },
  { id: 'ca4000', cat: 'skill',   name: '经验老到',  desc: '累计钓到 4000 条鱼',              metric: 'catch',       need: 4000, tier: 3 },

  /* ---- 操作类 · 累计抛竿 ---- */
  { id: 'ct30',   cat: 'skill',   name: '手熟了',    desc: '累计抛竿 30 次',                  metric: 'cast',        need: 30,   tier: 1 },
  { id: 'ct150',  cat: 'skill',   name: '百竿之后',  desc: '累计抛竿 150 次',                 metric: 'cast',        need: 150,  tier: 1 },
  { id: 'ct500',  cat: 'skill',   name: '手腕生风',  desc: '累计抛竿 500 次',                 metric: 'cast',        need: 500,  tier: 2 },
  { id: 'ct1500', cat: 'skill',   name: '千竿不倦',  desc: '累计抛竿 1500 次',                metric: 'cast',        need: 1500, tier: 3 },
  { id: 'ct4000', cat: 'skill',   name: '竿不离手',  desc: '累计抛竿 4000 次',                metric: 'cast',        need: 4000, tier: 3 },

  /* ---- 操作类 · 稀有及以上 ---- */
  { id: 'r8',     cat: 'skill',   name: '初遇稀有',  desc: '钓到 8 条「稀有」及以上的鱼',     metric: 'rareUp',      need: 8,    tier: 1 },
  { id: 'r30',    cat: 'skill',   name: '稀有常客',  desc: '钓到 30 条「稀有」及以上的鱼',    metric: 'rareUp',      need: 30,   tier: 1 },
  { id: 'r100',   cat: 'skill',   name: '逐奇者',    desc: '钓到 100 条「稀有」及以上的鱼',   metric: 'rareUp',      need: 100,  tier: 2 },
  { id: 'r300',   cat: 'skill',   name: '猎奇成癖',  desc: '钓到 300 条「稀有」及以上的鱼',   metric: 'rareUp',      need: 300,  tier: 3 },
  { id: 'r800',   cat: 'skill',   name: '稀有为常',  desc: '钓到 800 条「稀有」及以上的鱼',   metric: 'rareUp',      need: 800,  tier: 3 },
  { id: 'r2000',  cat: 'skill',   name: '难觅亦得',  desc: '钓到 2000 条「稀有」及以上的鱼',  metric: 'rareUp',      need: 2000, tier: 3 },

  /* ---- 操作类 · 史诗及以上 ---- */
  { id: 'e3',     cat: 'skill',   name: '史诗初现',  desc: '钓到 3 条「史诗」及以上的鱼',     metric: 'epicUp',      need: 3,    tier: 1 },
  { id: 'e12',    cat: 'skill',   name: '史诗常客',  desc: '钓到 12 条「史诗」及以上的鱼',    metric: 'epicUp',      need: 12,   tier: 2 },
  { id: 'e40',    cat: 'skill',   name: '史诗猎手',  desc: '钓到 40 条「史诗」及以上的鱼',    metric: 'epicUp',      need: 40,   tier: 2 },
  { id: 'e120',   cat: 'skill',   name: '史诗满仓',  desc: '钓到 120 条「史诗」及以上的鱼',   metric: 'epicUp',      need: 120,  tier: 3 },

  /* ---- 操作类 · 累计收进鱼护 ---- */
  { id: 'kp10',   cat: 'skill',   name: '收进鱼护',  desc: '累计把 10 条鱼收进鱼护',          metric: 'netKept',     need: 10,   tier: 1 },
  { id: 'kp50',   cat: 'skill',   name: '护里有鱼',  desc: '累计把 50 条鱼收进鱼护',          metric: 'netKept',     need: 50,   tier: 1 },
  { id: 'kp200',  cat: 'skill',   name: '护中常满',  desc: '累计把 200 条鱼收进鱼护',         metric: 'netKept',     need: 200,  tier: 2 },
  { id: 'kp600',  cat: 'skill',   name: '囤积有度',  desc: '累计把 600 条鱼收进鱼护',         metric: 'netKept',     need: 600,  tier: 3 },

  /* ---- 操作类 · 鱼饵覆盖 ---- */
  { id: 'bait3',  cat: 'skill',   name: '三饵入门',  desc: '用 3 种鱼饵都成功上过鱼',         metric: 'baitUsed',    need: 3,    tier: 1 },
  { id: 'bait6',  cat: 'skill',   name: '备饵齐全',  desc: '用 6 种鱼饵都成功上过鱼',         metric: 'baitUsed',    need: 6,    tier: 2 },
  { id: 'bait10', cat: 'skill',   name: '饵箱见底',  desc: '用 10 种鱼饵都成功上过鱼',        metric: 'baitUsed',    need: 10,   tier: 3 },
  { id: 'baits',  cat: 'skill',   name: '万物皆饵',  desc: '用全部 13 种鱼饵都成功上过鱼',    metric: 'baitUsed',    need: 13,   tier: 3,   title: '万物皆饵' },

  /* ---- 操作类 · 天气 / 时段覆盖 ---- */
  { id: 'wx2',    cat: 'skill',   name: '两种天色',  desc: '在 2 种天气下都上过鱼',           metric: 'wxUsed',      need: 2,    tier: 1 },
  { id: 'wx3',    cat: 'skill',   name: '三种天色',  desc: '在 3 种天气下都上过鱼',           metric: 'wxUsed',      need: 3,    tier: 2 },
  { id: 'wxall',  cat: 'skill',   name: '风雨无阻',  desc: '在 4 种天气下都上过鱼',           metric: 'wxUsed',      need: 4,    tier: 2 },
  { id: 'tm2',    cat: 'skill',   name: '两个时段',  desc: '在 2 个时段都上过鱼',             metric: 'tmUsed',      need: 2,    tier: 1 },
  { id: 'tm3',    cat: 'skill',   name: '三个时段',  desc: '在 3 个时段都上过鱼',             metric: 'tmUsed',      need: 3,    tier: 2 },
  { id: 'tmall',  cat: 'skill',   name: '昼夜不歇',  desc: '在 4 个时段都上过鱼',             metric: 'tmUsed',      need: 4,    tier: 2 },

  /* ---- 操作类 · 单一天气渔获（keyed）---- */
  { id: 'wclear', cat: 'skill',   name: '晴钓百竿',  desc: '在「晴」天钓到 80 条鱼',          metric: 'wx',          key: 'clear', need: 80,   tier: 1 },
  { id: 'wcloud', cat: 'skill',   name: '阴天有获',  desc: '在「阴」天钓到 80 条鱼',          metric: 'wx',          key: 'cloudy', need: 80,   tier: 2 },
  { id: 'wrain',  cat: 'skill',   name: '雨战有成',  desc: '在「雨」天钓到 60 条鱼',          metric: 'wx',          key: 'rain', need: 60,   tier: 2 },
  { id: 'wfog',   cat: 'skill',   name: '雾中垂钓',  desc: '在「雾」天钓到 60 条鱼',          metric: 'wx',          key: 'fog', need: 60,   tier: 3 },
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
