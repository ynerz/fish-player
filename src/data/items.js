/* =========================================================
   items.js  —  鱼饵 / 鱼竿 / 鱼线 / 装饰
   =========================================================
   鱼饵：消耗品，可提升上鱼速度（speed 越小越快）与稀有鱼权重（rareMul）。
         蚯蚓永久免费且无限，保证游戏永远不会卡住（对应「无限制」）。
   鱼竿：永久购买，提升稀有鱼权重（对应付费点①的数值接口）。
   鱼线：永久购买，提升张力上限（越粗越不容易断线）。
   装饰：纯外观，会真实绘制到场景里。

   ---------------------------------------------------------
   v0.5.0 扩充：鱼竿 5→8 档、鱼线 5→8 档、鱼饵 7→13 档
   ---------------------------------------------------------
   定价规则（改价时请遵守，tools/verify.js 会检查曲线不倒退）：

   **鱼竿**：把「要刷多久才买得起」排成一条平滑曲线，
   1h → 2.5h → 8h → 25h → 35h → 40h → 50h（用的是该场的每小时收益）。

     鱼竿          价格      在哪个场买   该场收入/时   需要刷
     玻璃钢竿      3.1k      D             3,134       1.0h
     碳素矶竿      8.9k      C             3,563       2.5h
     溪流并继竿   39.0k      B             4,880       8.0h
     深海船竿    163.0k      A             6,535      25.0h
     铁板竿      295.0k      S             8,440      35.0h
     传说·星陨竿 524.0k      SS           13,106      40.0h
     时之竿·终焉 953.0k      SSS          19,066      50.0h

   ⚠️ 鱼竿的主要价值是**加快图鉴收集**（稀有权重 ×1.06~×1.50，
   在 SSS 场能把史诗+传说鱼的出现率提高约 32%），金币收益只是附带（约 +6~11%）。
   所以不要指望它「回本」，它卖的是收集速度与终局追求。

   **鱼线**：约为同档鱼竿的 60%，只有「张力上限」一个作用。
   **鱼饵**：按「每竿饵料成本」排成一条平滑阶梯（0 → 120 金/竿）——
     越贵的效果越强（咬口更快 + 稀有权重更高）。
     蚯蚓永远是 0，保证任何阶段都不会因为「买不起饵」而卡住。
     实测饵料开销占该场每小时收益的 0% ~ 20%，越高档的饵净收益越高。
   ========================================================= */
window.G = window.G || {};

G.BAITS = [
  /* ---- 免费保底 ---- */
  { id:'worm',      name:'蚯蚓',        price:0,    pack:0,    speed:1.00, rareMul:1.00, legendMul:1.00,
    color:'#b8763f', free:true,
    desc:'永远挖不完的基础饵。中庸，但不会让你空军。' },

  /* ---- D 场区间（每竿 0.5 ~ 1 金） ---- */
  { id:'dough',     name:'面团',        price:10,   pack:20,   speed:0.96, rareMul:1.00, legendMul:1.00,
    color:'#e8dcc0',
    desc:'揉一把面粉就有。招小鱼，成本几乎可以忽略。' },
  { id:'corn',      name:'玉米粒',      price:20,   pack:20,   speed:0.92, rareMul:1.00, legendMul:1.00,
    color:'#f0c85a',
    desc:'挂上就不容易掉的素饵，小鱼来得更快。' },

  /* ---- C 场区间（每竿 2 ~ 7 金） ---- */
  { id:'bread',     name:'面包虫',      price:40,   pack:20,   speed:0.88, rareMul:1.06, legendMul:1.00,
    color:'#e0c68a',
    desc:'鲤科通吃。便宜、好用，溪流浅滩的默认选择。' },
  { id:'blood',     name:'红虫',        price:60,   pack:20,   speed:0.84, rareMul:1.12, legendMul:1.00,
    color:'#d0453f',
    desc:'冷水鱼的最爱，稀有鱼出现率小幅提升。' },
  { id:'grass',     name:'蚱蜢',        price:90,   pack:20,   speed:0.81, rareMul:1.19, legendMul:1.02,
    color:'#8fae5a',
    desc:'草丛里抓的活饵，中上层鱼特别认。' },
  { id:'stone',     name:'溪石虫',      price:140,  pack:20,   speed:0.78, rareMul:1.26, legendMul:1.05,
    color:'#8a7f5c',
    desc:'翻开溪石才找得到。溪流与湖泊通杀。' },

  /* ---- A 场区间（每竿 18 ~ 40 金） ---- */
  { id:'shrimp',    name:'活虾',        price:270,  pack:15,   speed:0.72, rareMul:1.34, legendMul:1.10,
    color:'#e08a72',
    desc:'大鱼的硬通货。挂上它，小鱼基本不敢咬。' },
  { id:'squid',     name:'鱿鱼条',      price:400,  pack:15,   speed:0.70, rareMul:1.42, legendMul:1.14,
    color:'#e8d5d0',
    desc:'海钓经典。腥味重、耐泡，深水区表现稳定。' },
  { id:'spoon',     name:'亮片拟饵',    price:600,  pack:15,   speed:0.68, rareMul:1.50, legendMul:1.18,
    color:'#cfd8e0',
    desc:'金属反光，专骗掠食性大鱼。' },

  /* ---- S / SS / SSS 区间（每竿 70 ~ 120 金） ---- */
  { id:'smallfish', name:'小鱼活饵',    price:700,  pack:10,   speed:0.64, rareMul:1.60, legendMul:1.24,
    color:'#9fc7d8',
    desc:'挂一条活的小鱼去钓更大的鱼。海沟里的常规操作。' },
  { id:'glow',      name:'深海发光饵',  price:600,  pack:10,   speed:0.62, rareMul:1.68, legendMul:1.28,
    color:'#7fd8e8',
    desc:'会自己发光的化学饵。在星陨之渊那种没有光的地方，它能替你说话。' },
  { id:'amber',     name:'龙涎香',      price:1200, pack:10,   speed:0.56, rareMul:1.85, legendMul:1.42,
    color:'#c9a86a',
    desc:'配方不外传。稀有鱼概率大幅提升，价格也很痛。' },
];

G.RODS = [
  { id:'bamboo',   name:'竹制手竿',      price:0,       rareMul:1.00, reel:1.00, icon:'🎋',
    desc:'爷爷留下的。能用，也就仅此而已。' },
  { id:'glass',    name:'玻璃钢竿',      price:3100 ,    rareMul:1.06, reel:1.05, icon:'🎣',
    desc:'轻便耐用，新手升级的第一选择。' },
  { id:'carbon',   name:'碳素矶竿',      price:8900 ,    rareMul:1.13, reel:1.09, icon:'🎣',
    desc:'轻、挺、敏感。稀有鱼咬口更容易被留住。' },
  { id:'stream',   name:'溪流并继竿',    price:39000 ,   rareMul:1.20, reel:1.13, icon:'🎏',
    desc:'三节并继，手感极细。湖心半岛的静水最配它。' },
  { id:'boat',     name:'深海船竿',      price:163000 ,  rareMul:1.28, reel:1.17, icon:'🛥',
    desc:'短粗硬，专为深水巨物准备。' },
  { id:'jig',      name:'铁板竿',        price:295000 ,  rareMul:1.35, reel:1.20, icon:'⚙',
    desc:'能抽几百克铁板的硬竿，海沟里的招牌武器。' },
  { id:'stellar',  name:'传说·星陨竿',   price:524000 ,  rareMul:1.42, reel:1.23, icon:'✨',
    desc:'竿身嵌着一片星屑。握上它，陨石坑也会给你面子。' },
  { id:'eternal',  name:'时之竿·终焉',   price:953000 , rareMul:1.50, reel:1.26, icon:'🕰',
    desc:'在时之尽头钓上来的鱼竿。它比你更早到达这里。' },
];

G.LINES = [
  { id:'n2',   name:'2 号尼龙线',      price:0,       tensionMax:100, icon:'🧵',
    desc:'容易断，但便宜。' },
  { id:'c4',   name:'4 号碳氟线',      price:1900 ,    tensionMax:112, icon:'🧵',
    desc:'切水快、耐磨，张力上限提升。' },
  { id:'pe6',  name:'6 号 PE 编织线',  price:5300 ,    tensionMax:124, icon:'🧵',
    desc:'几乎没延展，手感直接。' },
  { id:'n8',   name:'8 号加强编织线',  price:23000 ,   tensionMax:138, icon:'🧵',
    desc:'为百米深水准备的暴力线组。' },
  { id:'fc12', name:'12 号碳氟前导线', price:98000 ,  tensionMax:152, icon:'🧵',
    desc:'耐磨到几乎可以当锯子用。' },
  { id:'pe16', name:'16 号大力马',     price:177000 ,  tensionMax:168, icon:'🧵',
    desc:'拉力值标得比竿还高，唯一的缺点是贵。' },
  { id:'ti20', name:'20 号钛丝线',     price:314000 ,  tensionMax:186, icon:'🧵',
    desc:'传说中连船锚都拉得回来的线。' },
  { id:'keel', name:'24 号龙骨线',     price:570000 , tensionMax:210, icon:'⛓',
    desc:'据说原料来自某条沉船的骨架。断线这个词与它无关。' },
];

G.DECORS = [
  { id:'hat',     name:'渔夫帽',    price:600,     icon:'👒',
    desc:'防晒。佩戴在钓手头上。', draw:'hat' },
  { id:'cooler',  name:'保温箱',    price:4000,    icon:'🧊',
    desc:'放在码头边的蓝色箱子。', draw:'cooler' },
  { id:'cat',     name:'钓场猫',    price:20000,   icon:'🐈',
    desc:'会一直蹲在你旁边。偶尔看一眼水面。', draw:'cat' },
  { id:'light',   name:'串灯',      price:80000,   icon:'🏮',
    desc:'沿码头挂一排暖光小灯，夜里尤其好看。', draw:'light' },
  { id:'boatdeco',name:'小木船',    price:600000,  icon:'🛶',
    desc:'停在你钓鱼的位置旁边，随浪轻轻晃。', draw:'boat' },
];
