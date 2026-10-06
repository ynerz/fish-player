/* =========================================================
   items.js  —  鱼饵 / 鱼竿 / 鱼线 / 装饰
   =========================================================
   鱼饵：消耗品，可提升上鱼速度（speed 越小越快）与稀有鱼权重（rareMul）。
         蚯蚓永久免费且无限，保证游戏永远不会卡住（对应「无限制」）。
   鱼竿：永久购买，提升稀有鱼权重（对应付费点①的数值接口）。
   鱼线：永久购买，提升张力上限（越粗越不容易断线）。
   装饰：纯外观，会真实绘制到场景里。
   ========================================================= */
window.G = window.G || {};

G.BAITS = [
  { id:'worm',    name:'蚯蚓',      price:0,    pack:0,    speed:1.00, rareMul:1.00, legendMul:1.00,
    color:'#b8763f', free:true,
    desc:'永远挖不完的基础饵。中庸，但不会让你空军。' },
  { id:'corn',    name:'玉米粒',    price:20,   pack:20,   speed:0.90, rareMul:1.00, legendMul:1.00,
    color:'#f0c85a',
    desc:'挂上就不容易掉的素饵，小鱼来得更快。' },
  { id:'blood',   name:'红虫',      price:60,   pack:20,   speed:0.84, rareMul:1.12, legendMul:1.00,
    color:'#d0453f',
    desc:'冷水鱼的最爱，稀有鱼出现率小幅提升。' },
  { id:'stone',   name:'溪石虫',    price:140,  pack:20,   speed:0.78, rareMul:1.26, legendMul:1.05,
    color:'#8a7f5c',
    desc:'翻开溪石才找得到。溪流与湖泊通杀。' },
  { id:'shrimp',  name:'活虾',      price:270,  pack:15,   speed:0.72, rareMul:1.42, legendMul:1.10,
    color:'#e08a72',
    desc:'大鱼的硬通货。挂上它，小鱼基本不敢咬。' },
  { id:'spoon',   name:'亮片拟饵',  price:600,  pack:15,   speed:0.68, rareMul:1.58, legendMul:1.18,
    color:'#cfd8e0',
    desc:'金属反光，专骗掠食性大鱼。' },
  { id:'secret',  name:'秘制腥饵',  price:1100, pack:10,   speed:0.60, rareMul:1.85, legendMul:1.40,
    color:'#7b4a8a',
    desc:'配方不外传。稀有鱼概率大幅提升，价格也很痛。' },
];

G.RODS = [
  { id:'bamboo',  name:'竹制手竿',    price:0,      rareMul:1.00, reel:1.00, icon:'🎋',
    desc:'爷爷留下的。能用，也就仅此而已。' },
  { id:'glass',   name:'玻璃钢竿',    price:900,    rareMul:1.08, reel:1.05, icon:'🎣',
    desc:'轻便耐用，新手升级的第一选择。' },
  { id:'carbon',  name:'碳素矶竿',    price:5200,   rareMul:1.18, reel:1.10, icon:'🎣',
    desc:'轻、挺、敏感。稀有鱼咬口更容易被留住。' },
  { id:'boat',    name:'深海船竿',    price:32000,  rareMul:1.30, reel:1.16, icon:'🛥',
    desc:'短粗硬，专为深水巨物准备。' },
  { id:'stellar', name:'传说·星陨竿', price:210000, rareMul:1.45, reel:1.24, icon:'✨',
    desc:'竿身嵌着一片星屑。握上它，海沟也会给你面子。' },
];

G.LINES = [
  { id:'n2',  name:'2 号尼龙线',  price:0,      tensionMax:100, icon:'🧵',
    desc:'容易断，但便宜。' },
  { id:'c4',  name:'4 号碳氟线',  price:700,    tensionMax:112, icon:'🧵',
    desc:'切水快、耐磨，张力上限提升。' },
  { id:'pe6', name:'6 号 PE 编织线', price:3600, tensionMax:124, icon:'🧵',
    desc:'几乎没延展，手感直接。' },
  { id:'pe8', name:'8 号加强编织线', price:20000, tensionMax:138, icon:'🧵',
    desc:'为百米深水准备的暴力线组。' },
  { id:'ti10',name:'10 号钛丝线',  price:140000, tensionMax:156, icon:'🧵',
    desc:'传说中连船锚都拉得回来的线。' },
];

G.DECORS = [
  { id:'hat',     name:'渔夫帽',    price:300,    icon:'👒',
    desc:'防晒。佩戴在钓手头上。', draw:'hat' },
  { id:'cooler',  name:'保温箱',    price:1600,   icon:'🧊',
    desc:'放在码头边的蓝色箱子。', draw:'cooler' },
  { id:'cat',     name:'钓场猫',    price:7200,   icon:'🐈',
    desc:'会一直蹲在你旁边。偶尔看一眼水面。', draw:'cat' },
  { id:'light',   name:'串灯',      price:18000,  icon:'🏮',
    desc:'沿码头挂一排暖光小灯，夜里尤其好看。', draw:'light' },
  { id:'boatdeco',name:'小木船',    price:56000,  icon:'🛶',
    desc:'停在你钓鱼的位置旁边，随浪轻轻晃。', draw:'boat' },
];
