/* =========================================================
   config.js  —  全局数值配置
   =========================================================
   这里是整个游戏唯一需要调数值的地方。
   所有硬编码的平衡参数都集中在此，方便后续微调。
   ========================================================= */
window.G = window.G || {};

G.CONFIG = {

  version   : '0.1.0',
  saveKey   : 'fishplayer.save.v1',
  saveKeyBak: 'fishplayer.save.v1.bak',

  /* ---------------------------------------------------------
     稀有度定义
     ---------------------------------------------------------
     timeMin / timeMax : 该稀有度从抛竿到「咬钩」的秒数区间
                         对应策划案「10s ~ 10 分钟上鱼」
     valueMul   : 售价系数（在鱼种基础价之上再乘）
     ※ 体型大小差异已写在各鱼种的 minKg/maxKg 里，不再叠加倍率
     fight      : 张力拉扯参数，见 fight.js
     --------------------------------------------------------- */
  rarity: [
    {
      key: 'common', name: '普通', short: '普',
      color: '#8b98a5', color2: '#c3ced8',
      timeMin: 8,   timeMax: 22,
      valueMul: 1.00,
      fight: {
        reelPower: 24,      // 收线时进度增长 / s
        slackPull: 5.5,     // 松手时进度回落 / s
        tensionRise: 27,    // 收线时张力增长 / s
        tensionFall: 34,    // 松手时张力下降 / s
        dashGapMin: 4.0, dashGapMax: 8.0,
        dashDur: 0.90,      // 逃窜持续时间
        dashPower: 42,      // 逃窜时额外张力 / s
      },
    },
    {
      key: 'rare', name: '稀有', short: '稀',
      color: '#2b8fe0', color2: '#8fd0ff',
      timeMin: 38,  timeMax: 100,
      valueMul: 1.00,
      fight: {
        reelPower: 21, slackPull: 7.0,
        tensionRise: 30, tensionFall: 30,
        dashGapMin: 3.0, dashGapMax: 6.0,
        dashDur: 1.00, dashPower: 52,
      },
    },
    {
      key: 'epic', name: '史诗', short: '史',
      color: '#8b5cf6', color2: '#cbb6ff',
      timeMin: 150, timeMax: 320,
      valueMul: 1.00,
      fight: {
        reelPower: 18, slackPull: 6.5,
        tensionRise: 31, tensionFall: 29,
        dashGapMin: 2.8, dashGapMax: 5.2,
        dashDur: 1.05, dashPower: 42,
      },
    },
    {
      key: 'legend', name: '传说', short: '传',
      color: '#e8901a', color2: '#ffd977',
      timeMin: 380, timeMax: 600,
      valueMul: 1.00,
      fight: {
        reelPower: 18, slackPull: 6.0,
        tensionRise: 32, tensionFall: 28,
        dashGapMin: 2.6, dashGapMax: 5.0,
        dashDur: 1.00, dashPower: 52,
      },
    },
  ],

  /* ---------------------------------------------------------
     张力拉扯全局规则
     --------------------------------------------------------- */
  fight: {
    baseTensionMax : 100,   // 基础张力上限（鱼线可提升，见 items.js）
    slackGrace     : 1.6,   // 张力 < slackSoft 持续超过这个秒数 → 脱钩
    slackSoft      : 6,     // 判定为「松线」的张力阈值
    dashWarnLead   : 0.55,  // 逃窜前多久给预警（秒）
    progLossOnFail : 0,     // 失败时的额外惩罚（0 = 仅鱼跑掉）
  },

  /* ---------------------------------------------------------
     颜色变异（鱼的第三维状态：品种 / 颜色 / 重量）
     ---------------------------------------------------------
     每次钓上来的鱼会随机一个「颜色」，
     颜色只影响收藏外观与少量售价。
     --------------------------------------------------------- */
  colorMorphs: [
    { key:'normal',  name:'原色',   tint:null,      prob:0.760, valueMul:1.00 },
    { key:'bright',  name:'亮色',   tint:'#ffe08a', prob:0.150, valueMul:1.15 },
    { key:'dark',    name:'暗色',   tint:'#4a5a6b', prob:0.060, valueMul:1.15 },
    { key:'albino',  name:'白化',   tint:'#ffffff', prob:0.022, valueMul:1.60 },
    { key:'shiny',   name:'闪光',   tint:'#9be7ff', prob:0.007, valueMul:2.30 },
    { key:'golden',  name:'黄金',   tint:'#ffc93c', prob:0.001, valueMul:4.00 },
  ],

  /* ---------------------------------------------------------
     重量随机分布
     ---------------------------------------------------------
     用偏向小值的分布，小鱼常见、大鱼罕见（收藏乐趣来源）
     --------------------------------------------------------- */
  weight: {
    // 权重曲线指数：越大 → 越偏向区间下限
    skew: 2.1,
    // 额外「巨物」概率（在区间上限之上再冲出标准重量 x 倍）
    giantProb: 0.030,
    giantMul : 1.55,
  },

  /* ---------------------------------------------------------
     经济
     --------------------------------------------------------- */
  economy: {
    startCoin  : 120,           // 初始金币
    sellMul    : 1.00,          // 售价总系数（调难度用）
    firstCatchBonus: 3.0,       // 首次钓到某鱼种，售价 x 倍（图鉴奖励）
  },

  /* ---------------------------------------------------------
     挂机
     ---------------------------------------------------------
     ⚠️ 备注：策划里「挂机」是月卡付费点，当前版本先免费开放，
        用 monetization.idleSub = false 控制。上线前改为 true。
     --------------------------------------------------------- */
  idle: {
    // 挂机时稀有（稀有/史诗/传说）权重 x 0.95，对应策划「稀有鱼概率下降 5%」
    rareWeightMul : 0.95,
    // 自动收线 AI 的水平（决定挂机能稳定上多少鱼）
    auto: { react: 0.18, warn: 0.55, hi: 0.79, lo: 0.56 },
    // 离线最多补算多久（秒）—— 防止长时间挂后台爆收益
    maxCatchUp    : 8 * 3600,
    // 挂机播报合并：累计多少条后弹一次汇总提示
    batchToast    : 5,
  },

  /* ---------------------------------------------------------
     商业化接口（当前版本全部关闭）
     ---------------------------------------------------------
     先留字段，后续接小程序 / Steam 时直接打开对应项。
     --------------------------------------------------------- */
  monetization: {
    enabled        : false,   // 总开关：单机阶段不接任何支付
    rodRareBoost   : 0.20,    // ① 鱼竿使稀有鱼概率 +20%
    idleRareCut    : 0.05,    // ② 月卡挂机：稀有鱼概率 -5%
    shareRodBoost  : 0.10,    // ③ 分享得鱼竿：稀有鱼概率 +10%
    videoCode      : true,    // ④ 做视频发布领兑换码 → 挂机自动上鱼
    adIdleTicket   : true,    // ⑤ 看广告得小时挂机券
    idleIsSubscribed: false,  // 挂机是否为月卡功能（当前免费）
  },

  /* ---------------------------------------------------------
     其它
     --------------------------------------------------------- */
  misc: {
    // 咬钩窗口：浮漂下沉后玩家必须在这个时间内点收杆
    biteWindow: { common:1.6, rare:1.5, epic:1.4, legend:1.2 },
    // 自动保存间隔（秒）
    autoSaveInterval: 10,
    // 长按收线的张力「过载」缓冲：张力到达上限后还能撑多久算断线
    snapGrace: 0.45,
  },
};
