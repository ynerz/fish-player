/* =========================================================
   fields.js  —  钓场数据表（7 个）
   =========================================================
   解锁规则：
     · 普通钓场：本钓场图鉴收集 ≥ 80% 即可解锁下一个
     · 隐藏钓场 SS / SSS：需要前面所有钓场 100% 收满
   时长字段（unlockHours）仅作「设计参考」与展示，
   当前版本不作为硬性门槛 —— 想改成硬门槛，把
   CFG.minHoursAsGate 打开即可（见下方 GATE 常量）。
   ========================================================= */
window.G = window.G || {};

/* 各钓场的「咬口倍率」biteMul：
   越深的水域，鱼找饵的时间越长。只作用于「普通 / 稀有」两档 ——
   史诗 / 传说本来就接近 10 分钟上限，再乘就超出策划设定的单竿时长上限了。
   这条倍率让后期钓场在「不靠稀有种」的前提下自然变慢。 */

/* 是否把「设计时长」也作为硬性解锁门槛。
   用户口径：只需要收藏即可 → false。 */
G.UNLOCK_HOURS_AS_GATE = false;

G.FIELDS = [
  {
    id: 'D',
    biteMul: 1.0,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 0.0,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 2.0,      // 本钓场 100% 收满需多少小时
    rank: 'D',
    name: '村口小池塘',
    sub: '新手钓场',
    desc: '老槐树下的野塘，水不深、鱼不大，却有钓不完的小杂鱼。所有故事的起点。',
    unlockHours: 0,
    refHoursText: '开局即开放',
    collectionPct: 0,
    requires: null,
    requireFull: false,
    /* 稀有度权重（普通 / 稀有 / 史诗 / 传说），合计 100 */
    rarity: [84.333, 9.911, 4.211, 1.544],
    /* 每个稀有度内部的鱼种权重在 fish.js 里定义 */
    theme: {
      sky: ['#a8dcff', '#e6f6ff'],
      sun: { x: 0.80, y: 0.18, r: 34, color: '#fff3c4', glow: 'rgba(255,235,150,.55)' },
      moon: false,
      clouds: { n: 4, color: '#ffffff', alpha: 0.85, speed: 9 },
      hills: [
        { color: '#a9c98e', height: 0.30, alpha: 1.0 },
        { color: '#8fbb79', height: 0.22, alpha: 1.0 },
        { color: '#74a866', height: 0.15, alpha: 1.0 },
      ],
      water: ['#63c0d8', '#2d86ab'],
      deep: ['#2d86ab', '#0e4f70'],
      dock: '#c9b088',
      dockDark: '#a68e68',
      ambient: 'leaf',
      ambientColor: '#9ccb6a',
      vignette: 'rgba(20,60,90,.12)',
    },
  },

  {
    id: 'C',
    biteMul: 1.0,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 2.0,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 4.0,      // 本钓场 100% 收满需多少小时
    rank: 'C',
    name: '溪流浅滩',
    sub: '溪流钓场',
    desc: '山脚乱石间的清溪，水清见底、水流湍急。冷水鱼在这儿藏身，翻石找虫就是最好的饵。',
    unlockHours: 1,
    refHoursText: '约 1 小时',
    collectionPct: 0.8,
    requires: 'D',
    requireFull: false,
    rarity: [77.245, 17.511, 4.823, 0.42],
    theme: {
      sky: ['#cfeaff', '#fdf6e4'],
      sun: { x: 0.20, y: 0.14, r: 40, color: '#fff8d8', glow: 'rgba(255,240,190,.65)' },
      moon: false,
      clouds: { n: 3, color: '#ffffff', alpha: 0.7, speed: 12 },
      hills: [
        { color: '#8ea9b8', height: 0.42, alpha: 1.0 },
        { color: '#7d9aa8', height: 0.32, alpha: 1.0 },
        { color: '#6e8b98', height: 0.20, alpha: 1.0 },
      ],
      water: ['#8fdcd2', '#3f9d9a'],
      deep: ['#3f9d9a', '#175f66'],
      dock: '#b9a487',
      dockDark: '#93816a',
      ambient: 'mist',
      ambientColor: 'rgba(255,255,255,.5)',
      vignette: 'rgba(20,70,80,.14)',
      rocks: true,
    },
  },

  {
    id: 'B',
    biteMul: 1.2,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 6.0,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 15.9,      // 本钓场 100% 收满需多少小时
    rank: 'B',
    name: '湖心半岛',
    sub: '湖泊钓场',
    desc: '大湖中央伸出去的一片沙洲，水面开阔、风大浪缓。到了黄昏，成群的翘嘴会追着小鱼冲上来。',
    unlockHours: 3,
    refHoursText: '约 3 小时',
    collectionPct: 0.8,
    requires: 'C',
    requireFull: false,
    rarity: [74.746, 14.88, 9.708, 0.666],
    theme: {
      sky: ['#7fb2e0', '#ffd9a8'],
      sun: { x: 0.68, y: 0.34, r: 52, color: '#ffd27a', glow: 'rgba(255,180,90,.55)' },
      moon: false,
      clouds: { n: 5, color: '#ffe3c4', alpha: 0.9, speed: 7 },
      hills: [
        { color: '#7d8fb0', height: 0.34, alpha: 0.9 },
        { color: '#63779a', height: 0.24, alpha: 0.95 },
        { color: '#4d6183', height: 0.16, alpha: 1.0 },
      ],
      water: ['#e0a878', '#5d7fa8'],
      deep: ['#5d7fa8', '#26405c'],
      dock: '#d8c19a',
      dockDark: '#ab9471',
      ambient: 'none',
      ambientColor: '#fff',
      vignette: 'rgba(60,30,20,.16)',
    },
  },

  {
    id: 'A',
    biteMul: 1.6,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 21.8,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 44.7,      // 本钓场 100% 收满需多少小时
    rank: 'A',
    name: '深海断崖',
    sub: '近海钓场',
    desc: '离岸十几海里，海底骤然下沉成断崖。洋流撞上崖壁，把整片大鱼都困在了这道坎上。',
    unlockHours: 30,
    refHoursText: '约 30 小时',
    collectionPct: 0.8,
    requires: 'B',
    requireFull: false,
    rarity: [55.43, 30.873, 13.157, 0.54],
    theme: {
      sky: ['#4fa8e8', '#bfe8ff'],
      sun: { x: 0.5, y: 0.10, r: 40, color: '#ffffff', glow: 'rgba(255,255,255,.7)' },
      moon: false,
      clouds: { n: 2, color: '#ffffff', alpha: 0.6, speed: 18 },
      hills: [
        { color: '#3f6f9c', height: 0.24, alpha: 0.85 },
        { color: '#2f5a82', height: 0.16, alpha: 0.95 },
      ],
      water: ['#2f9fd8', '#0f4e86'],
      deep: ['#0f4e86', '#05243f'],
      dock: '#c8cfd6',
      dockDark: '#9aa4ad',
      ambient: 'spray',
      ambientColor: 'rgba(255,255,255,.75)',
      vignette: 'rgba(0,30,70,.18)',
      waves: 1.35,
    },
  },

  {
    id: 'S',
    biteMul: 2.2,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 66.5,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 99.5,      // 本钓场 100% 收满需多少小时
    rank: 'S',
    name: '幽蓝海沟',
    sub: '深海钓场',
    desc: '海沟边缘，阳光再也照不到的地方。铅坠要放两百米，拉上来的东西常常不像鱼。',
    unlockHours: 100,
    refHoursText: '约 100 小时',
    collectionPct: 0.8,
    requires: 'A',
    requireFull: false,
    rarity: [54.988, 31.318, 13.142, 0.551],
    theme: {
      sky: ['#2a3f5c', '#4a6b85'],
      sun: null,
      moon: true,
      clouds: { n: 6, color: '#5a7893', alpha: 0.8, speed: 14 },
      hills: [
        { color: '#2a3d55', height: 0.30, alpha: 0.9 },
        { color: '#1d2d40', height: 0.20, alpha: 1.0 },
      ],
      water: ['#1e3f63', '#0a2036'],
      deep: ['#061828', '#010810'],
      dock: '#7f8c99',
      dockDark: '#5c6771',
      ambient: 'rain',
      ambientColor: 'rgba(180,215,240,.55)',
      vignette: 'rgba(0,10,25,.30)',
      waves: 1.6,
      gloom: true,
    },
  },

  {
    id: 'SS',
    biteMul: 3.0,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 166.0,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 132.3,      // 本钓场 100% 收满需多少小时
    rank: 'SS',
    name: '星陨之渊',
    sub: '隐藏钓场',
    desc: '传说千年前有星辰坠入此处，海水自此泛着幽光。这里的鱼，鳞片上写着别人的名字。',
    unlockHours: 300,
    refHoursText: '约 300 小时',
    collectionPct: 1.0,
    requires: ['D', 'C', 'B', 'A', 'S'],
    requireFull: true,
    hidden: true,
    rarity: [69.844, 20.6, 9.047, 0.51],
    theme: {
      sky: ['#080d24', '#1b2450'],
      sun: null,
      moon: true,
      moonSize: 60,
      stars: true,
      clouds: { n: 3, color: '#2a3466', alpha: 0.55, speed: 5 },
      hills: [
        { color: '#141c3c', height: 0.30, alpha: 0.95 },
        { color: '#0b1128', height: 0.20, alpha: 1.0 },
      ],
      water: ['#1a2a6b', '#060b22'],
      deep: ['#050a20', '#000208'],
      dock: '#5b5f7a',
      dockDark: '#3d4055',
      ambient: 'star',
      ambientColor: 'rgba(160,200,255,.9)',
      vignette: 'rgba(0,0,20,.36)',
      waves: 1.2,
      gloom: true,
      shimmer: true,
    },
  },

  {
    id: 'SSS',
    biteMul: 3.5,   // 深水鱼咬口更慢（只作用于普通/稀有档）
    estUnlockHours: 298.3,   // 解锁本钓场需累计多少小时（实测期望值）
    estOwnHours: 529.3,      // 本钓场 100% 收满需多少小时
    rank: 'SSS',
    name: '时之尽头',
    sub: '終極隐藏钓场',
    desc: '水面之上是极光，水面之下是昨天。你在这里钓上来的每一条鱼，都比这条河更年长。',
    unlockHours: 1000,
    refHoursText: '约 1000 小时',
    collectionPct: 1.0,
    requires: ['D', 'C', 'B', 'A', 'S', 'SS'],
    requireFull: true,
    hidden: true,
    rarity: [72, 26.657, 1.109, 0.234],
    theme: {
      sky: ['#120a2e', '#2e1a4d'],
      sun: null,
      moon: true,
      moonSize: 44,
      stars: true,
      aurora: true,
      clouds: { n: 3, color: '#3b2a63', alpha: 0.5, speed: 4 },
      hills: [
        { color: '#231848', height: 0.32, alpha: 0.9 },
        { color: '#150e2e', height: 0.22, alpha: 1.0 },
      ],
      water: ['#3a2a7a', '#0a0620'],
      deep: ['#0a0620', '#000000'],
      dock: '#6b5f86',
      dockDark: '#463d5c',
      ambient: 'aurora',
      ambientColor: 'rgba(180,255,230,.9)',
      vignette: 'rgba(10,0,30,.34)',
      waves: 1.05,
      gloom: true,
      shimmer: true,
    },
  },
];

/* 便捷索引 */
G.FIELD_MAP = {};
G.FIELDS.forEach((f, i) => { f.index = i; G.FIELD_MAP[f.id] = f; });
