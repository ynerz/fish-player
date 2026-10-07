# -*- coding: utf-8 -*-
"""
tools/gen-fish.py  —  生成 src/data/fish.js

鱼种总量对齐市场基准（主流钓鱼手游 200~500 种）：本作 362 种。
每个钓场的鱼种数、档位分布、外形模板、体重区间、基础价都在下面这张表里。
档内权重 w 由 tools/solve-drop.js 反推写入，这里只放占位值 1。

用法： python tools/gen-fish.py
"""
import io, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'fish.js')

# =============================================================
# 每场鱼价乘数 —— 唯一控制「经济曲线」的旋钮
# =============================================================
# 每小时金币 ≈ (3600 ÷ 单竿耗时) × 平均鱼价。
# 单竿耗时由 rarity + biteMul 决定（那属于「节奏表」，已按用户口径定死），
# 所以想让曲线单调上升，只能动鱼价。
#
# 目标：**每进入一个新钓场，每小时收益至少 +30%**，不允许出现倒退。
# 这些乘数是用下表的初始定价换算出「目标收入 ÷ 当前收入」得到的；
# 改完必须重跑：
#   python tools/gen-fish.py && node tools/solve-drop.js
#   && node tools/balance.js && node tools/verify.js
# -------------------------------------------------------------
# 天气 / 时段偏好
# -------------------------------------------------------------
# 规则：稀有度越高，越可能「挑条件」——传说鱼往往只在特定天气或时段活跃。
# ⚠️ 这只是**权重 ×2.2**，不是硬门禁：晴天白天一样钓得到，
#    否则图鉴会变成「等天气」，那是设计事故。
WX_CYCLE = ['rain', 'fog', 'cloudy', 'clear']
TM_CYCLE = ['night', 'dawn', 'dusk', 'day']

def pref_of(i, rar):
    wx = None
    tm = None
    if rar >= 1 and i % 4 == 0:
        wx = WX_CYCLE[(i // 4) % len(WX_CYCLE)]
    if rar >= 2 and i % 3 == 0:
        tm = TM_CYCLE[(i // 3) % len(TM_CYCLE)]
    if rar >= 3 and i % 2 == 0:
        wx = wx or WX_CYCLE[(i // 2) % len(WX_CYCLE)]
    return wx, tm

FIELD_PRICE_MUL = {
    'D':   1.00,   # 2150 金/时  基准
    'C':   1.40,   # 2150 → 2930（原本 2090 反而低于 D，倒挂）
    'B':   1.00,   # 3775（已是 C 的 1.29 倍）
    'A':   1.00,   # 6431（已是 B 的 1.70 倍）
    'S':   1.12,   # 7569 → 8480（原本只比 A 高 18%）
    'SS':  1.02,   # 10845 → 11060
    'SSS': 1.20,   # 12159 → 14590（原本只比 SS 高 12%）
}

# =============================================================
# 配色：每个钓场一套基础色，鱼种按序号在色带上取色，保证同场有区分度
# =============================================================
PALETTES = {
 'D': [('#a8bcc9','#7f95a4'),('#cfd9e0','#9fb0bd'),('#b8a67e','#8f7f5c'),('#8a7355','#5f4d38'),
       ('#9fb0a8','#6e8079'),('#c4cdb0','#93a17c'),('#b9a3a0','#8a7472'),('#c9b79a','#9a8a6e'),
       ('#d99a5b','#b4763c'),('#c9a349','#8a6b23'),('#8f9c8a','#5e6b52'),('#a98d7a','#7b6253'),
       ('#f2c14e','#d99a1f'),('#5c7a68','#33473d')],
 'C': [('#cfd6c8','#9aa491'),('#b7cbd8','#7d97a8'),('#9fc6dd','#6a94b0'),('#a89a80','#6f6454'),
       ('#b9c3a8','#8b9578'),('#c9c0a0','#9a9070'),('#d3c9b8','#a79c88'),('#a5b8a0','#768a70'),
       ('#8fa2b0','#5f7280'),('#c2b184','#8a7c55'),('#c78f9e','#8a5f75'),('#9aa8b8','#6b7888'),
       ('#b0a890','#7f7860'),('#8f9c7d','#5e6b52'),('#dfe3e0','#a9b3ae'),('#e0a58c','#a86e58'),
       ('#c8b8a8','#96887a'),('#a8c8d0','#6f9098'),('#c0c8b8','#8e988a'),('#d8c8b0','#a89880'),
       ('#b8c0a0','#88906e'),('#f0d489','#c9a13d')],
 'B': [('#c8d2d6','#93a1a8'),('#9aa7ae','#6b7880'),('#97a878','#5f7048'),('#b9bcae','#878b7f'),
       ('#8fa2a0','#5c6e6d'),('#c4c0a8','#948f7a'),('#a8b2a0','#78816e'),('#b0b8c0','#828a94'),
       ('#c8bfa0','#98906f'),('#9cb0a8','#6d8078'),('#b8a890','#8a7a60'),('#a0b0b8','#748a94'),
       ('#c8b8b0','#988c84'),('#98a890','#6c7c66'),('#d0c8b8','#9c9484'),('#d99a5b','#a86f33'),
       ('#a3ac86','#66703f'),('#d5dde2','#9caab4'),('#6b6f5e','#3c4034'),('#c0c8b0','#8e967c'),
       ('#b8c0c8','#88909c'),('#8fa0a8','#5f7078'),('#c8c0b8','#968e86'),('#a8a8b0','#787880'),
       ('#d0c0a0','#9c8c6c'),('#7d7a6b','#4a483d'),('#c9b183','#8d7748'),('#9aa8b0','#6a787f'),
       ('#e0d8c8','#a8a090'),('#b0a890','#807860'),('#c8b0a0','#907860'),('#e8b45c','#b87a20')],
 'A': [('#b9cbd6','#8497a4'),('#9fb6c2','#6c8695'),('#6c7480','#414a55'),('#c4b481','#8d7c4c'),
       ('#a7b3b8','#75828a'),('#8d8471','#5b5443'),('#c8ccd0','#939aa0'),('#b0bcc4','#7c8a94'),
       ('#d0d8dc','#9aa4ac'),('#a8b8c0','#748490'),('#c9c0a8','#958c74'),('#98a4ac','#687580'),
       ('#d8d0c0','#a49c8c'),('#b8c4c8','#84909a'),('#8c98a0','#5c6870'),('#d0c0b0','#9c8c7c'),
       ('#a0b0a8','#708078'),('#c0b8a8','#8c8474'),('#9cb0c0','#6c8090'),('#c8d0d8','#94a0aa'),
       ('#d98f96','#a55c66'),('#b3bec4','#7f8b93'),('#6fc0c4','#3b8a94'),('#a97c86','#7a4f5c'),
       ('#8fa0b0','#5f7080'),('#c0a888','#8c7458'),('#a0b8c0','#708890'),('#d0b8a8','#9c8474'),
       ('#7f9bb8','#45627f'),('#6f8fb5','#2f4d70'),('#8a7f66','#4f4636'),('#b0c0c8','#8090a0'),
       ('#c8c0b0','#98907c'),('#a8b0a0','#788070'),('#98a8b0','#687880'),('#c0ccd4','#8c98a0'),
       ('#b8a890','#88785c'),('#a0a8b8','#707888'),('#d0d0c8','#9c9c94'),('#8c9098','#5c6068'),
       ('#c8b8c0','#988890'),('#b0a0a8','#807078'),('#6e6550','#332d22'),('#3f5f8f','#8fb8e0')],
 'S': [('#a8b0ad','#6e7876'),('#5c6b7d','#2e3742'),('#8b8398','#585070'),('#c3ced6','#8b98a3'),
       ('#7b8592','#4a5560'),('#c98a7a','#8a5148'),('#6f9a8f','#c8f2e0'),('#5a6a7a','#2e3a48'),
       ('#8a96a4','#5a6672'),('#7a8896','#4a5662'),('#6b7a88','#3b4a58'),('#98a4b0','#687480'),
       ('#5f6f7d','#2f3f4d'),('#a0a8b4','#707884'),('#8494a0','#546470'),('#6a7886','#3a4856'),
       ('#7a6b5c','#463c32'),('#9a8a9a','#6a5a6a'),('#5d7a88','#2d4a58'),('#8798a6','#576876'),
       ('#7f8a96','#4f5a66'),('#6d7c8a','#3d4c5a'),('#95a0ac','#65707c'),('#5b6b79','#2b3b49'),
       ('#7a6b5c','#463c32'),('#8f7a8a','#5f4a5a'),('#c8d0d8','#98a0a8'),('#7d2f3f','#4a1220'),
       ('#8d8674','#554f40'),('#66707a','#36404a'),('#8f7f6a','#5f4f3a'),('#6a5a7a','#3a2a4a'),
       ('#b0b8c0','#808890'),('#7a6a7a','#4a3a4a'),('#5d6b7a','#2d3b4a'),('#96889a','#66586a'),
       ('#8a7a6a','#5a4a3a'),('#6f7f8f','#3f4f5f'),('#a0a8b0','#707880'),('#5a6a72','#2a3a42'),
       ('#7d8a96','#4d5a66'),('#8a94a0','#5a6470'),('#c0705f','#7c3f33'),('#cfd8dd','#9aa6ad'),
       ('#7f7a86','#4a4550'),('#6b7280','#3b414b'),('#8f9aa8','#5a6472'),('#5f6a76','#2f3a46'),
       ('#8a8070','#5a5040'),('#6d6a7a','#3d3a4a'),('#7a7a8a','#4a4a5a'),('#9aa0a8','#6a7078'),
       ('#6a5a8f','#2f2650'),('#2f3a55','#7f8fc0')],
 'SS': [('#3f5a9c','#7ea2ff'),('#5b6172','#2f3444'),('#4a4f8a','#8f96e0'),('#4d5a86','#8b9be0'),
        ('#3d4260','#6f7fc0'),('#5c8fd6','#bde4ff'),('#8f8fa8','#d6d6f0'),('#6a7aa8','#a8b8f0'),
        ('#7a86b8','#c0c8f8'),('#5f6a9a','#9faef0'),('#4a5a8f','#8fa8ff'),('#6b5f9a','#b0a0f0'),
        ('#5568a0','#98b0ff'),('#7f8bb8','#c8d0ff'),('#5a6890','#93a8e8'),('#4f5f8a','#88a0e0'),
        ('#6a80b0','#a8c0ff'),('#8a90c0','#d0d8ff'),('#5c6aa8','#9fb0ff'),('#7080a8','#b0c0f8'),
        ('#3b3a6b','#7d7cc4'),('#454a63','#7e86a8'),('#4a3f8f','#a08fff'),('#2f2f5f','#8f8fff'),
        ('#3a4a8f','#a8c0ff'),('#4a4a6a','#9090c0'),('#3f4f7f','#8fa8e8'),('#5a5a8a','#a8a8e0'),
        ('#5560b0','#a8b4ff'),('#6a3fb0','#c9a8ff'),('#9fb4ff','#e0e8ff'),('#383d5c','#6d7699'),
        ('#4a4f7d','#98a0d6'),('#3c4a7a','#7f93d6'),('#4a5a7a','#8fa0d0'),('#3a4a6a','#7f90c0'),
        ('#2f3f6f','#7f90e0'),('#4a3a7a','#a090e0'),('#3f5f9e','#8fc0ff'),('#3f4a6f','#8f9fd0'),
        ('#554a8a','#b0a0ff'),('#3a3a6a','#8a8ac0'),('#4a5a90','#90a8f0'),('#2f4a7f','#80a0e0'),
        ('#5a4a9a','#b8a8ff'),('#3f3f7f','#8f8fdf'),('#4a6a9a','#90b8f0'),('#3a5a8a','#80a8e8'),
        ('#7a3fd6','#e0c9ff'),('#b8c4ff','#ffffff'),('#c8d6ff','#ffffff'),('#1f1f4f','#b0a0ff'),
        ('#2f2f5f','#9f9fff'),('#3f3f6f','#afafff'),('#4a4a8a','#bfbfff'),('#2a2a5a','#8f8fdf'),
        ('#5a5a9a','#c0c0ff'),('#3a3a7a','#9a9adf'),('#4f4f8f','#afaff0'),('#2f3f5f','#8f9fcf'),
        ('#3f4f6f','#9fafdf'),('#4a5a7f','#a0b0e0'),('#35406a','#8f9fd0'),('#5a6a9a','#b0c0f0')],
 'SSS': [('#b8a882','#e8dcb0'),('#c98f8f','#8f5555'),('#cfe4ec','#9dc2d2'),('#a8a2b8','#6f6885'),
         ('#b0c9a8','#7a9a72'),('#cdc3d6','#948aa8'),('#d6cdb8','#f5eeda'),('#c8b8a0','#f0e0c8'),
         ('#a8c0c8','#e0f0f8'),('#d0c8b0','#a89f80'),('#c0b0a0','#908070'),('#b8c0a8','#8f9880'),
         ('#c8c0d0','#98909f'),('#d8ccb8','#a89c88'),('#b0b8c0','#808890'),('#c4c0b0','#94907f'),
         ('#9f8fb8','#c9b8ff'),('#c0a8b8','#907888'),('#a8b8c0','#788890'),('#d0c0a8','#a09078'),
         ('#8f7fb8','#c9b8ff'),('#d6c49a','#a08f5f'),('#7f8fd6','#cfe0ff'),('#8f9aa8','#5a6472'),
         ('#a86f8f','#e0b8d6'),('#3f2f6b','#a88fe0'),('#9a8fb8','#c8b8e8'),('#b8a8c8','#8f7f9f'),
         ('#6a3f9f','#c9a0ff'),('#3f3a5c','#8f88b8'),('#5a5a9f','#b8b8ff'),('#4f6b7d','#a8c9d6'),
         ('#7f6fd6','#d6c9ff'),('#2a3a6a','#8fb0e8'),('#6f7f98','#c0d0e8'),('#8a7f6a','#5a4f3a'),
         ('#a89478','#7f6b50'),('#c0b090','#8f8060'),('#9a9080','#6f6555'),('#b8b0a0','#8f8878'),
         ('#3f2f6f','#d6c0ff'),('#2f4f7f','#9fc9ff'),('#d6a83f','#fff0b8'),('#1f2430','#7f8fa8'),
         ('#5a4a8a','#b8a8e8'),('#4a3f6f','#9f8fdf'),('#6a5a9a','#bfa8ff'),('#3a3a6a','#8a8ac0'),
         ('#7a6aa8','#c8b8ff'),('#4f4f8f','#a0a0e0'),('#5f5f9f','#b0b0f0'),('#2f2f5f','#8f8fcf'),
         ('#6a6a8a','#a8a8c8'),('#8a7a9a','#c0b0d0'),('#5a6a7a','#9aacbc'),('#7a8a6a','#b0c0a0'),
         ('#9a8a7a','#c8b8a8'),('#6a7a8a','#a8b8c8'),('#8a6a7a','#c0a0b0'),('#7a6a8a','#b0a0c0'),
         ('#5a8a7a','#a0c8b8'),('#8a8a6a','#c0c0a0'),('#6a6a9a','#a8a8d8'),('#9a9a7a','#c8c8a8'),
         ('#7a5a6a','#b898a8'),('#5a7a8a','#98b8c8'),('#8a7a6a','#c0b0a0'),('#6a8a8a','#a8c8c8')],
}

# =============================================================
# 鱼种表
#   (名称, 稀有度, 外形, 最小kg, 最大kg, 基础价, opts)
#   稀有度 0普 1稀 2史 3传
#   外形 fish / eel / ray / squid / jelly / oarfish / shark / whale / dragon
#   一行的 opts 里不要写 w，权重由 solve-drop.js 算
# =============================================================
FIELD_FISH = {}

FIELD_FISH['D'] = [
 ('麦穗鱼',0,'fish',0.02,0.08,3,'body:0.26'),
 ('白条',0,'fish',0.05,0.15,4,'body:0.22, tail:"fork"'),
 ('鲫鱼',0,'fish',0.10,0.55,7,'body:0.44'),
 ('泥鳅',0,'eel',0.02,0.09,5,''),
 ('鳑鲏',0,'fish',0.01,0.05,4,'body:0.52'),
 ('食蚊鱼',0,'fish',0.01,0.04,3,'body:0.30'),
 ('塘鳢',0,'fish',0.03,0.15,6,'body:0.36, spots:true'),
 ('小龙虾',0,'squid',0.02,0.12,8,''),
 ('黄颡鱼',1,'fish',0.12,0.60,22,'body:0.32, barbels:true, spiny:true'),
 ('小鲤鱼',1,'fish',0.30,1.20,24,'body:0.40, barbels:true'),
 ('黄鳝',1,'eel',0.10,0.70,29,''),
 ('青虾虎',1,'fish',0.02,0.10,20,'body:0.30, spots:true'),
 ('金鲫',2,'fish',0.40,1.40,108,'body:0.46, glow:true'),
 ('老塘草鱼',2,'fish',3.0,11.0,161,'body:0.34'),
 ('圆尾斗鱼',0,'fish',0.02,0.10,6,'body:0.42, stripes:true'),
 ('塘主的大青鱼',3,'fish',8.0,26.0,532,'body:0.36'),
]
# D 只放 15 种（14 普稀史 + 1 传说做彩蛋）→ 见文档说明

FIELD_FISH['C'] = [
 ('溪哥',0,'fish',0.02,0.07,5,'body:0.26'),
 ('马口鱼',0,'fish',0.04,0.12,8,'body:0.28, tail:"fork", stripes:true'),
 ('宽鳍鱲',0,'fish',0.03,0.10,9,'body:0.30, tail:"fork"'),
 ('拉氏鱥',0,'fish',0.02,0.09,7,'body:0.28'),
 ('中华鳑鲏',0,'fish',0.01,0.05,6,'body:0.50'),
 ('小鳈',0,'fish',0.02,0.08,6,'body:0.28, stripes:true'),
 ('黑鳍鳈',0,'fish',0.03,0.12,8,'body:0.30, stripes:true'),
 ('棒花鱼',0,'fish',0.02,0.10,7,'body:0.32, spots:true'),
 ('似鮈',0,'fish',0.03,0.14,8,'body:0.28, barbels:true'),
 ('间下鱵',0,'fish',0.02,0.08,9,'body:0.20, tail:"fork"'),
 ('光唇鱼',0,'fish',0.05,0.25,11,'body:0.32, stripes:true'),
 ('缨口鳅',0,'eel',0.02,0.08,8,''),
 ('花䱻',1,'fish',0.15,0.60,38,'body:0.28, spots:true'),
 ('虹鳟',1,'fish',0.40,1.60,56,'body:0.30, stripes:true, spots:true'),
 ('褐鳟',1,'fish',0.30,1.40,52,'body:0.30, spots:true'),
 ('溪石斑',1,'fish',0.12,0.45,62,'body:0.34, spots:true'),
 ('唇䱻',1,'fish',0.20,0.90,48,'body:0.28'),
 ('吻鰕虎',1,'fish',0.01,0.04,36,'body:0.30'),
 ('白甲鱼',2,'fish',1.20,3.60,195,'body:0.32'),
 ('山女鳟',2,'fish',0.60,2.20,230,'body:0.30, stripes:true, spots:true'),
 ('台湾铲颌鱼',2,'fish',0.40,1.60,215,'body:0.30, barbels:true'),
 ('中华刺鳅',0,'eel',0.03,0.16,9,''),
 ('福建小鳔鮈',0,'fish',0.02,0.09,7,'body:0.30'),
 ('溪灵·金线鲃',3,'fish',0.30,1.10,820,'body:0.30, glow:true, barbels:true'),
]

FIELD_FISH['B'] = [
 ('鲢鱼',0,'fish',1.00,4.50,16,'body:0.40'),
 ('鳙鱼',0,'fish',1.20,5.00,18,'body:0.42'),
 ('草鱼',0,'fish',1.50,7.00,22,'body:0.34'),
 ('鲮鱼',0,'fish',0.30,1.60,13,'body:0.34'),
 ('罗非鱼',0,'fish',0.20,1.20,12,'body:0.44, spiny:true'),
 ('鳊鱼',0,'fish',0.30,1.80,15,'body:0.52'),
 ('鲂鱼',0,'fish',0.35,2.00,16,'body:0.50'),
 ('银鲴',0,'fish',0.10,0.60,12,'body:0.36'),
 ('黄尾鲴',0,'fish',0.15,0.80,14,'body:0.36'),
 ('赤眼鳟',0,'fish',0.40,2.50,20,'body:0.32, tail:"fork"'),
 ('大眼华鳊',0,'fish',0.20,1.00,15,'body:0.48'),
 ('似鳊',0,'fish',0.25,1.20,14,'body:0.48'),
 ('中华细鲫',0,'fish',0.05,0.25,10,'body:0.28'),
 ('麦鲮',0,'fish',0.50,2.80,18,'body:0.34'),
 ('鲈鲤',0,'fish',0.60,3.20,24,'body:0.36, spiny:true'),
 ('鲤鱼',1,'fish',1.50,7.50,68,'body:0.40, barbels:true'),
 ('鲈鱼',1,'fish',0.60,2.80,82,'body:0.36, spiny:true, spots:true'),
 ('翘嘴鲌',1,'fish',0.80,3.60,88,'body:0.24, glow:true'),
 ('蒙古鲌',1,'fish',0.50,2.40,74,'body:0.26'),
 ('黑鱼',1,'fish',1.00,5.50,96,'body:0.30, spots:true, teeth:true'),
 ('鳡鱼',1,'fish',2.00,9.00,110,'body:0.26, teeth:true'),
 ('鲶鱼',1,'fish',1.00,6.00,78,'body:0.30, barbels:true'),
 ('青鱼',1,'fish',3.00,14.0,102,'body:0.34'),
 ('刺鲃',1,'fish',0.80,4.00,86,'body:0.36, barbels:true'),
 ('大口鲶',2,'fish',4.00,18.0,320,'body:0.30, barbels:true'),
 ('鳜鱼',2,'fish',1.00,4.50,380,'body:0.42, spiny:true, stripes:true'),
 ('大眼鳜',2,'fish',0.60,2.60,340,'body:0.44, spiny:true, spots:true'),
 ('长吻鮠',2,'fish',1.50,6.50,290,'body:0.28, barbels:true'),
 ('中华倒刺鲃',2,'fish',1.20,5.50,310,'body:0.36, barbels:true'),
 ('胭脂鱼',2,'fish',2.00,10.0,420,'body:0.44, glow:true'),
 ('银鮈',0,'fish',0.05,0.30,13,'body:0.32'),
 ('短颌鲚',0,'fish',0.05,0.35,14,'body:0.22, tail:"fork"'),
 ('湖心巨鲤',3,'fish',12.0,38.0,1450,'body:0.42, barbels:true, glow:true'),
 ('百斤鳡王',3,'fish',20.0,52.0,1680,'body:0.26, teeth:true, glow:true'),
]

FIELD_FISH['A'] = [
 ('沙丁鱼',0,'fish',0.03,0.12,12,'body:0.26'),
 ('竹荚鱼',0,'fish',0.10,0.45,16,'body:0.28'),
 ('黑鲷',0,'fish',0.40,2.20,28,'body:0.46, spiny:true'),
 ('黄鳍鲷',0,'fish',0.40,2.40,32,'body:0.46, spiny:true'),
 ('鲻鱼',0,'fish',0.50,2.80,24,'body:0.30'),
 ('石斑鱼',0,'fish',1.00,6.00,42,'body:0.42, spots:true'),
 ('银鲳',0,'fish',0.30,1.50,30,'body:0.62'),
 ('刺鲳',0,'fish',0.25,1.20,26,'body:0.60'),
 ('鳀鱼',0,'fish',0.02,0.09,11,'body:0.24'),
 ('小黄鱼',0,'fish',0.10,0.50,22,'body:0.32'),
 ('梅童鱼',0,'fish',0.05,0.25,18,'body:0.34'),
 ('黄姑鱼',0,'fish',0.30,1.60,26,'body:0.34'),
 ('白姑鱼',0,'fish',0.25,1.40,24,'body:0.34'),
 ('海鳗',0,'eel',0.50,3.00,34,''),
 ('星鳗',0,'eel',0.20,1.20,30,'spots:true'),
 ('鲽鱼',0,'fish',0.20,1.10,25,'body:0.60, spots:true'),
 ('舌鳎',0,'fish',0.15,0.80,23,'body:0.55'),
 ('六线鱼',0,'fish',0.20,1.00,27,'body:0.40, spots:true'),
 ('黑鲪',0,'fish',0.25,1.30,29,'body:0.38, spiny:true'),
 ('赤点石斑',0,'fish',0.60,3.50,38,'body:0.42, spots:true'),
 ('真鲷',1,'fish',1.00,5.00,118,'body:0.48, spiny:true'),
 ('海鲈',1,'fish',1.50,8.00,132,'body:0.34, spiny:true'),
 ('鲯鳅',1,'fish',2.00,11.0,156,'body:0.28, glow:true'),
 ('章鱼',1,'squid',0.80,6.00,145,''),
 ('马鲛',1,'fish',1.20,7.00,140,'body:0.28, teeth:true'),
 ('蓝点马鲛',1,'fish',1.50,9.00,158,'body:0.28, spots:true, teeth:true'),
 ('大黄鱼',1,'fish',0.50,3.00,165,'body:0.34, glow:true'),
 ('鮸鱼',1,'fish',2.00,10.0,150,'body:0.34'),
 ('牙鲆',1,'fish',1.00,6.00,135,'body:0.58, spots:true'),
 ('许氏平鲉',1,'fish',0.50,2.50,128,'body:0.42, spiny:true'),
 ('鬼鲉',1,'fish',0.60,3.20,168,'body:0.46, spiny:true, spots:true'),
 ('鲬鱼',1,'fish',0.40,2.00,122,'body:0.30, spiny:true'),
 ('鱿鱼',1,'squid',0.20,1.50,138,'glow:true'),
 ('金枪鱼',2,'fish',15.0,90.0,620,'body:0.38, glow:true'),
 ('旗鱼',2,'fish',25.0,140.0,760,'body:0.26'),
 ('剑鱼',2,'fish',30.0,180.0,820,'body:0.24, teeth:true'),
 ('龙趸石斑',2,'fish',40.0,180.0,880,'body:0.44, spots:true'),
 ('宝石石斑',2,'fish',20.0,90.0,720,'body:0.44, spots:true, glow:true'),
 ('河鲀',2,'fish',0.50,3.00,560,'body:0.78, spiny:true'),
 ('翻车鱼',2,'fish',60.0,300.0,940,'body:0.86'),
 ('角箱鲀',2,'fish',0.30,2.00,520,'body:0.70, spiny:true'),
 ('斑鰶',0,'fish',0.10,0.50,20,'body:0.34, spots:true'),
 ('日本鳀',0,'fish',0.02,0.10,12,'body:0.24'),
 ('断崖之王·巨型石斑',3,'fish',120.0,420.0,3200,'body:0.46, spots:true'),
 ('黑潮之王·蓝鳍金枪',3,'fish',180.0,620.0,4200,'body:0.40, glow:true'),
 ('白浪之神·大青针',3,'fish',90.0,260.0,3600,'body:0.24, glow:true, teeth:true'),
]

FIELD_FISH['S'] = [
 ('深海鳕',0,'fish',0.50,3.50,30,'body:0.34'),
 ('灯笼鱼',0,'fish',0.02,0.12,34,'body:0.36, glow:true'),
 ('鼬鳚',0,'fish',0.10,0.70,28,'body:0.26'),
 ('银斧鱼',0,'fish',0.02,0.10,38,'body:0.62, glow:true'),
 ('帆蜥鱼',0,'fish',0.30,1.80,44,'body:0.24, teeth:true'),
 ('深海鲷',0,'fish',0.80,4.00,40,'body:0.46, spiny:true'),
 ('管眼鱼',0,'fish',0.05,0.40,36,'body:0.60, glow:true'),
 ('幽灵鳍鱼',0,'fish',0.30,1.40,42,'body:0.30, glow:true'),
 ('黑叉齿鱼',0,'fish',0.10,0.60,40,'body:0.30, teeth:true'),
 ('尖牙鱼',0,'fish',0.05,0.30,45,'body:0.34, teeth:true'),
 ('后肛鱼',0,'fish',0.06,0.35,38,'body:0.36, glow:true'),
 ('深海狗母鱼',0,'fish',0.08,0.50,34,'body:0.28'),
 ('囊鳃鳗',0,'eel',0.05,0.40,36,'glow:true'),
 ('深海鳐',0,'ray',0.80,5.00,44,''),
 ('深海鲽',0,'fish',0.30,1.80,36,'body:0.58, spots:true'),
 ('灯塔水母',0,'jelly',0.01,0.10,40,'glow:true'),
 ('深海水母',0,'jelly',0.05,0.60,42,'glow:true'),
 ('栉水母',0,'jelly',0.02,0.20,46,'glow:true'),
 ('海猪',0,'jelly',0.10,0.90,32,''),
 ('海蛇尾',0,'eel',0.02,0.15,30,''),
 ('巨型等足虫',0,'squid',0.05,0.60,38,''),
 ('管虫',0,'eel',0.02,0.20,34,''),
 ('深海虾虎',0,'fish',0.03,0.20,32,'body:0.30, spots:true'),
 ('无光鳕',0,'fish',0.40,2.80,36,'body:0.32'),
 ('鮟鱇鱼',1,'fish',1.00,9.00,195,'body:0.52, teeth:true, lure:true'),
 ('角鮟鱇',1,'fish',0.60,6.00,210,'body:0.52, teeth:true, lure:true'),
 ('树须鱼',1,'fish',0.30,3.00,215,'body:0.50, teeth:true, lure:true'),
 ('深海章鱼',1,'squid',2.00,16.0,235,''),
 ('吸血乌贼',1,'squid',0.50,3.00,265,'glow:true'),
 ('幽灵蛸',1,'squid',0.60,4.00,248,'glow:true'),
 ('皱鳃鲨',1,'shark',3.00,12.0,320,'body:0.24'),
 ('雪茄达摩鲨',1,'shark',0.20,1.50,290,'body:0.28, teeth:true'),
 ('六鳃鲨',1,'shark',5.00,20.0,310,'body:0.26'),
 ('深海龙鱼',1,'fish',0.10,1.20,270,'body:0.30, teeth:true, glow:true'),
 ('深海银鲛',1,'fish',1.00,5.00,255,'body:0.34, glow:true'),
 ('单棘魨',1,'fish',0.30,2.00,240,'body:0.70, spiny:true'),
 ('蓝环章鱼',1,'squid',0.05,0.60,300,'glow:true, spots:true'),
 ('巨口鳗',1,'eel',1.00,7.00,280,'teeth:true'),
 ('黑柔骨鱼',1,'fish',0.20,1.60,260,'body:0.34, teeth:true'),
 ('深海水母王',1,'jelly',1.00,9.00,295,'glow:true'),
 ('皇带鱼',2,'oarfish',8.00,45.0,520,'glow:true'),
 ('巨口鲨',2,'shark',80.0,350.0,860,'body:0.30'),
 ('格陵兰鲨',2,'shark',100.0,500.0,940,'body:0.30'),
 ('大王酸浆鱿',2,'squid',150.0,500.0,1180,'glow:true'),
 ('小头睡鲨',2,'shark',120.0,600.0,980,'body:0.30'),
 ('太平洋睡鲨',2,'shark',90.0,450.0,920,'body:0.30, spots:true'),
 ('尖吻鲭鲨',2,'shark',60.0,300.0,890,'body:0.26, teeth:true'),
 ('深海巨型鳐',2,'ray',80.0,400.0,940,'glow:true'),
 ('北极霞水母',2,'jelly',20.0,120.0,1020,'glow:true'),
 ('深海鳚',0,'fish',0.05,0.40,32,'body:0.28'),
 ('黑口鱼',0,'fish',0.08,0.55,34,'body:0.34, teeth:true'),
 ('巨尾鱼',0,'fish',0.10,0.80,36,'body:0.30, glow:true'),
 ('褶胸鱼',0,'fish',0.03,0.25,33,'body:0.36, glow:true'),
 ('孔灯鱼',0,'fish',0.02,0.18,35,'body:0.34, glow:true'),
 ('大鳍后肛鱼',0,'fish',0.06,0.42,37,'body:0.38, glow:true'),
 ('狼牙鲷',1,'fish',0.80,5.00,246,'body:0.46, spiny:true, teeth:true'),
 ('角高体金眼鲷',1,'fish',0.40,2.60,228,'body:0.52, spiny:true'),
 ('海沟幽灵·大王乌贼',3,'squid',20000,70000,4200,'glow:true'),
 ('海沟幽魂·无光鲸',3,'whale',90000,360000,5200,'glow:true'),
 ('海沟之主·深渊巨鲨',3,'shark',30000,120000,4800,'body:0.30, glow:true, teeth:true'),
 ('幽蓝海心·鬼灯笼',3,'fish',500,4000,4400,'body:0.52, teeth:true, lure:true, glow:true'),
 ('海沟终焉·原始巨口鲨',3,'shark',50000,200000,5600,'body:0.34, glow:true, teeth:true'),
]

FIELD_FISH['SS'] = [
 ('星磷鱼',0,'fish',1000,7000,120,'body:0.30, glow:true'),
 ('陨铁鲷',0,'fish',8000,40000,139,'body:0.46, spiny:true'),
 ('真空鳐',0,'ray',15000,90000,166,'glow:true'),
 ('深海星鳗',0,'eel',6000,30000,150,'glow:true'),
 ('冷光鮟鱇',0,'fish',20000,140000,190,'body:0.52, teeth:true, lure:true, glow:true'),
 ('幽蓝水母',0,'jelly',5000,40000,178,'glow:true'),
 ('陨尘鲳',0,'fish',4000,25000,163,'body:0.58, glow:true'),
 ('暗星鲷',0,'fish',12000,60000,178,'body:0.48, spiny:true, glow:true'),
 ('星尘鳀',0,'fish',500,3000,135,'body:0.24, glow:true'),
 ('陨砾鲹',0,'fish',3000,18000,148,'body:0.30, glow:true'),
 ('星纹鲷',0,'fish',9000,45000,157,'body:0.46, stripes:true, glow:true'),
 ('陨星鲈',0,'fish',10000,50000,167,'body:0.36, spiny:true, glow:true'),
 ('微光鳕',0,'fish',7000,40000,142,'body:0.34, glow:true'),
 ('星屑鰕虎',0,'fish',1000,6000,127,'body:0.30, spots:true, glow:true'),
 ('陨砂鳉',0,'fish',400,2000,124,'body:0.28, glow:true'),
 ('幽星鲽',0,'fish',6000,35000,152,'body:0.58, spots:true, glow:true'),
 ('星尘水母',0,'jelly',3000,20000,170,'glow:true'),
 ('陨石鳃',0,'fish',5000,30000,155,'body:0.36, glow:true'),
 ('夜辉鳗',0,'eel',4000,24000,160,'glow:true'),
 ('碎星魟',0,'ray',10000,60000,173,'glow:true'),
 ('寂静鲳',0,'fish',5000,32000,150,'body:0.60, glow:true'),
 ('霜鳞鲑',0,'fish',8000,60000,166,'body:0.32, spots:true, glow:true'),
 ('幻影鲽',0,'fish',4000,26000,157,'body:0.56, glow:true'),
 ('星屑海马',0,'fish',200,1500,130,'body:0.62, glow:true'),
 ('陨光鮟鱇',0,'fish',9000,60000,181,'body:0.50, lure:true, glow:true'),
 ('幽蓝鳞鲀',0,'fish',3000,18000,145,'body:0.72, spiny:true, glow:true'),
 ('星砂鲽',0,'fish',3500,22000,152,'body:0.58, spots:true, glow:true'),
 ('陨纹金枪',0,'fish',30000,200000,214,'body:0.38, stripes:true, glow:true'),
 ('夜穹旗鱼',0,'fish',50000,300000,224,'body:0.26, glow:true'),
 ('星耀鲹',0,'fish',6000,40000,163,'body:0.30, glow:true'),
 ('虚空鳗',1,'eel',150000,900000,572,'glow:true, teeth:true'),
 ('陨光海蛇',1,'eel',1.2e+06,6e+06,495,'glow:true, teeth:true'),
 ('星云鳐',1,'ray',500000,3e+06,533,'glow:true'),
 ('渊影鲛',1,'shark',2e+06,1.1e+07,596,'body:0.26, glow:true'),
 ('深星章鱼',1,'squid',400000,2.5e+06,521,'glow:true'),
 ('陨落灯笼',1,'fish',100000,700000,559,'body:0.52, lure:true, teeth:true, glow:true'),
 ('星蚀鲷',1,'fish',200000,1.1e+06,505,'body:0.48, spiny:true, spots:true, glow:true'),
 ('虚时鲳',1,'fish',150000,900000,480,'body:0.60, glow:true'),
 ('碎陨皇带',1,'oarfish',600000,3.6e+06,595,'glow:true'),
 ('星纱水母',1,'jelly',200000,1.2e+06,498,'glow:true'),
 ('幽暗龙鱼',1,'dragon',200000,1.4e+06,617,'glow:true, teeth:true'),
 ('陨核鲽',1,'fish',120000,800000,485,'body:0.58, spots:true, glow:true'),
 ('虚光鮟鱇',1,'fish',300000,1.8e+06,581,'body:0.54, lure:true, teeth:true, glow:true'),
 ('暗物质魟',1,'ray',800000,4.5e+06,650,'glow:true'),
 ('星陨鳐',1,'ray',600000,3.4e+06,548,'glow:true'),
 ('虚空鲛',1,'shark',1.5e+06,8e+06,632,'body:0.28, glow:true, teeth:true'),
 ('陨星鲟',1,'fish',1e+06,6e+06,607,'body:0.38, spiny:true, glow:true'),
 ('星屑章鱼',1,'squid',200000,1.4e+06,493,'glow:true, spots:true'),
 ('星陨旗鱼',2,'fish',6e+07,2.6e+08,1245,'body:0.26, glow:true'),
 ('星核龙鱼',2,'dragon',8e+06,4e+07,1588,'glow:true'),
 ('裂空皇带鱼',2,'oarfish',6e+07,3.2e+08,1499,'glow:true'),
 ('渊眼巨鲨',2,'shark',3e+08,1.4e+09,1803,'body:0.32, glow:true'),
 ('陨落鲸',2,'whale',8e+08,4e+09,2096,'glow:true'),
 ('原初海蛇',2,'eel',4e+07,2e+08,1499,'glow:true, teeth:true'),
 ('星陨巨鱿',2,'squid',2e+08,9e+08,1753,'glow:true'),
 ('虚空水母王',2,'jelly',5e+07,2.6e+08,1422,'glow:true'),
 ('陨铁巨口鲨',2,'shark',4e+08,1.8e+09,1880,'body:0.32, glow:true, teeth:true'),
 ('星蚀鳐王',2,'ray',1.5e+08,7e+08,1651,'glow:true'),
 ('陨光海龙',2,'dragon',2e+07,1.1e+08,1715,'glow:true, teeth:true'),
 ('陨铁鲹',0,'fish',2500,16000,137,'body:0.30, glow:true'),
 ('星脉鳉',0,'fish',300,1800,126,'body:0.28, glow:true'),
 ('虚空鲽',0,'fish',4500,28000,155,'body:0.58, glow:true'),
 ('幽蓝鳀',0,'fish',400,2600,132,'body:0.24, glow:true'),
 ('星屑鲱',0,'fish',600,3400,130,'body:0.26, glow:true'),
 ('陨砂鲈',0,'fish',11000,55000,170,'body:0.36, spiny:true, glow:true'),
 ('微弱鲳',0,'fish',5500,34000,152,'body:0.60, glow:true'),
 ('暗礁鲷',0,'fish',9500,48000,160,'body:0.46, spiny:true, glow:true'),
 ('星陨鳗',1,'eel',200000,1.2e+06,541,'glow:true'),
 ('陨落魟',1,'ray',700000,3.8e+06,587,'glow:true'),
 ('虚空鲳',1,'fish',180000,1e+06,513,'body:0.60, glow:true'),
 ('星蚀鰕虎',1,'fish',20000,130000,478,'body:0.30, spots:true, glow:true'),
 ('陨铁巨鲛',2,'shark',2.5e+08,1.1e+09,1930,'body:0.30, glow:true, teeth:true'),
 ('星核皇带',2,'oarfish',8e+07,4.2e+08,1626,'glow:true'),
 ('幽蓝巨魟',2,'ray',1.8e+08,8.5e+08,1727,'glow:true'),
 ('星陨终焉·万象鲸',3,'whale',3e+12,1.2e+13,12446,'glow:true'),
 ('星陨之主·天鳞',3,'dragon',3e+10,1.6e+11,7112,'glow:true'),
 ('渊底月神·银鳐',3,'ray',8e+10,4e+11,7874,'glow:true'),
 ('星陨王座·裂空皇带',3,'oarfish',2e+11,9e+11,8636,'glow:true'),
 ('深渊终章·噬星者',3,'dragon',5e+11,2.6e+12,11684,'glow:true, teeth:true'),
 ('永夜之主·虚空鲸',3,'whale',2e+12,9e+12,11176,'glow:true'),
]

FIELD_FISH['SSS'] = [
 ('时砂小鱼',0,'fish',5e+06,3e+07,273,'body:0.28'),
 ('溯流鲑',0,'fish',8e+07,5e+08,306,'body:0.32'),
 ('零度蝶鱼',0,'fish',2e+07,1.2e+08,318,'body:0.62'),
 ('昨日鲈',0,'fish',1e+08,5.5e+08,332,'body:0.36, spiny:true'),
 ('遗迹鳉',0,'fish',2e+06,1.2e+07,247,'body:0.26'),
 ('虚时鲳',0,'fish',6e+07,3.5e+08,348,'body:0.58'),
 ('刹那鲴',0,'fish',8e+06,4.5e+07,302,'body:0.30'),
 ('须臾鲹',0,'fish',1.5e+07,9e+07,332,'body:0.36, tail:"fork"'),
 ('瞬息鳉',0,'fish',4e+06,2.2e+07,283,'body:0.28'),
 ('一刻鲹',0,'fish',1e+07,7e+07,312,'body:0.34'),
 ('时光鲽',0,'fish',3e+07,2e+08,325,'body:0.58, spots:true'),
 ('琥珀鲷',0,'fish',8e+07,4.5e+08,341,'body:0.46, spiny:true'),
 ('遗迹石斑',0,'fish',1.2e+08,7e+08,354,'body:0.44, spots:true'),
 ('残响鲻',0,'fish',4e+07,2.6e+08,307,'body:0.32'),
 ('静默鳕',0,'fish',9e+07,5.5e+08,322,'body:0.34'),
 ('尘时鲹',0,'fish',2.5e+07,1.6e+08,317,'body:0.30'),
 ('初雪鳟',0,'fish',6e+07,4e+08,333,'body:0.30, spots:true'),
 ('沙漏鲽',0,'fish',3.5e+07,2.4e+08,328,'body:0.56'),
 ('回音鲈',0,'fish',1.5e+08,8e+08,346,'body:0.36, spiny:true'),
 ('旧日鲳',0,'fish',7e+07,4.2e+08,335,'body:0.60'),
 ('年轮鲷',0,'fish',1e+08,6e+08,351,'body:0.48, spiny:true, stripes:true'),
 ('未时鰕虎',0,'fish',1e+07,7e+07,289,'body:0.30, spots:true'),
 ('星轨鳗',0,'eel',3e+07,2.2e+08,320,'glow:true'),
 ('虚空鲽',0,'fish',5e+07,3.2e+08,330,'body:0.58'),
 ('昨日鲹',0,'fish',3e+07,2e+08,309,'body:0.32, tail:"fork"'),
 ('远景鲳',0,'fish',8e+07,4.8e+08,338,'body:0.58'),
 ('回响鲻',0,'fish',4.5e+07,2.8e+08,315,'body:0.32'),
 ('初光鲻',0,'fish',3.5e+07,2.2e+08,304,'body:0.32'),
 ('遗迹鳐',0,'ray',1.5e+08,9e+08,335,''),
 ('尘光水母',0,'jelly',3e+07,2.4e+08,307,'glow:true'),
 ('遗光鲹',0,'fish',2e+07,1.4e+08,315,'body:0.32, tail:/fork/'),
 ('空时鳕',0,'fish',6e+07,3.6e+08,312,'body:0.34'),
 ('逆时鳗',1,'eel',5e+09,3e+10,429,'glow:true'),
 ('千年纪鱼',1,'fish',3e+10,1.4e+11,546,'body:0.40, glow:true'),
 ('虚空旗鱼',1,'fish',5e+11,2.4e+12,624,'body:0.26, glow:true'),
 ('纪元鲟',1,'fish',2e+11,1.2e+12,676,'body:0.38, spiny:true'),
 ('黄昏鳐',1,'ray',5e+10,4e+11,728,'glow:true'),
 ('暗物质水母',1,'jelly',1e+10,8e+10,793,'glow:true'),
 ('回响鲷',1,'fish',1.5e+10,7e+10,702,'body:0.46, spiny:true, glow:true'),
 ('时空褶皱·空棘鱼',1,'fish',3e+11,1.4e+12,754,'body:0.42, spiny:true, glow:true'),
 ('逆流龙鱼',1,'dragon',5e+10,3e+11,806,'glow:true, teeth:true'),
 ('残时皇带',1,'oarfish',2e+11,1.1e+12,767,'glow:true'),
 ('虚时鮟鱇',1,'fish',8e+10,5e+11,780,'body:0.54, lure:true, teeth:true, glow:true'),
 ('千面章鱼',1,'squid',6e+10,4e+11,741,'glow:true'),
 ('逆空鲛',1,'shark',3e+11,1.8e+12,832,'body:0.28, glow:true'),
 ('溯光鲹',1,'fish',1e+11,6e+11,689,'body:0.30, glow:true'),
 ('旧日水母',1,'jelly',3e+10,2e+11,722,'glow:true'),
 ('影时鲽',1,'fish',4e+10,2.6e+11,708,'body:0.58, glow:true'),
 ('回环鳕',1,'fish',6e+10,3.6e+11,734,'body:0.34, glow:true'),
 ('沉默巨口鳗',1,'eel',1.5e+11,9e+11,760,'teeth:true, glow:true'),
 ('星轨魟',1,'ray',1.2e+11,7e+11,774,'glow:true'),
 ('时刻鲳',1,'fish',5e+10,3.2e+11,715,'body:0.60, glow:true'),
 ('时间龙鱼',2,'dragon',1e+13,6e+13,2184,'glow:true, teeth:true'),
 ('终焉鲨',2,'shark',4e+14,1.8e+15,2366,'body:0.30, glow:true'),
 ('永恒鲸',2,'whale',1.2e+15,6e+15,2730,'glow:true'),
 ('原初蛇颈龙',2,'whale',6e+14,3e+15,2925,'glow:true'),
 ('星尘巨魟',2,'ray',1.5e+14,7e+14,2574,'glow:true'),
 ('时光褶皱·虚空鲸',2,'whale',2e+15,8e+15,11180,'glow:true'),
 ('纪元褶皱·深渊鲸',2,'whale',1.5e+15,7e+15,7540,'glow:true'),
 ('逆熵巨鱿',2,'squid',3e+14,1.5e+15,2665,'glow:true'),
 ('残响龙鱼',2,'dragon',4e+13,2.4e+14,2470,'glow:true, teeth:true'),
 ('空之翼鳐',2,'ray',2e+14,1e+15,2444,'glow:true'),
 ('时光巨口鲨',2,'shark',6e+14,2.6e+15,2795,'body:0.32, glow:true, teeth:true'),
 ('时痕鲽',0,'fish',2.5e+07,1.6e+08,320,'body:0.58, spots:true'),
 ('逆光鳕',0,'fish',7e+07,4.4e+08,317,'body:0.34'),
 ('纪年鲹',0,'fish',1.8e+07,1.1e+08,307,'body:0.32, tail:"fork"'),
 ('溯时鲻',0,'fish',4e+07,2.4e+08,309,'body:0.32'),
 ('残页鲷',0,'fish',9e+07,5.2e+08,343,'body:0.46, spiny:true, stripes:true'),
 ('空页鲈',0,'fish',1.3e+08,7e+08,348,'body:0.36, spiny:true'),
 ('遗忘鲳',0,'fish',6.5e+07,3.8e+08,333,'body:0.60'),
 ('前尘鳉',0,'fish',3e+06,1.7e+07,255,'body:0.26'),
 ('后时鰕虎',0,'fish',9e+06,6e+07,291,'body:0.30, spots:true'),
 ('拾光鲹',0,'fish',2.8e+07,1.8e+08,315,'body:0.30'),
 ('逆旅鲽',0,'fish',3.2e+07,2.1e+08,325,'body:0.56, spots:true'),
 ('流年鲻',0,'fish',3.8e+07,2.3e+08,312,'body:0.32'),
 ('空洞鳕',0,'fish',8.5e+07,5e+08,320,'body:0.34'),
 ('寂时鲹',0,'fish',2.2e+07,1.5e+08,317,'body:0.32, tail:"fork"'),
 ('时间鲟',1,'fish',2.8e+11,1.5e+12,722,'body:0.38, spiny:true, glow:true'),
 ('溯流皇带',1,'oarfish',3e+11,1.5e+12,744,'glow:true'),
 ('逆熵鳐',1,'ray',1.8e+11,9.5e+11,764,'glow:true'),
 ('空时鲛',1,'shark',4.5e+11,2.4e+12,798,'body:0.28, glow:true'),
 ('千年魟',1,'ray',2.5e+11,1.3e+12,751,'glow:true'),
 ('时纱水母',1,'jelly',6e+10,3.4e+11,736,'glow:true'),
 ('虚年章鱼',1,'squid',1.2e+11,6.4e+11,775,'glow:true'),
 ('逆旅鮟鱇',1,'fish',1.4e+11,8e+11,783,'body:0.54, lure:true, teeth:true, glow:true'),
 ('纪元巨鲨',2,'shark',5e+14,2.2e+15,2756,'body:0.32, glow:true, teeth:true'),
 ('时光巨龙',2,'dragon',6e+13,3.2e+14,3094,'glow:true, teeth:true'),
 ('千年巨鲸',2,'whale',2.5e+15,1e+16,3224,'glow:true'),
 ('逆流皇带',2,'oarfish',3e+14,1.4e+15,2938,'glow:true'),
 ('时之褶皱·空鲸',2,'whale',1.8e+15,7.5e+15,3016,'glow:true'),
 ('纪元龙鱼',2,'dragon',8e+13,4.2e+14,3172,'glow:true, teeth:true'),
 ('时之终点·无相鲲',3,'whale',5e+17,2e+18,27300,'glow:true'),
 ('初源之影·混沌',3,'dragon',3e+16,1.4e+17,31200,'glow:true, teeth:true'),
 ('终焉纪元·忘川',3,'shark',2e+17,9e+17,26000,'body:0.30, glow:true, teeth:true'),
 ('时之尽头·无相巨鲲',3,'whale',3e+17,1.2e+18,15600,'glow:true'),
 ('创世之鳞',3,'dragon',6e+15,3e+16,18200,'glow:true'),
 ('终末渔者之影',3,'fish',1e+16,5e+16,23400,'body:0.36, glow:true'),
 ('纪元终焉·空之鲸',3,'whale',4e+17,1.6e+18,20800,'glow:true'),
 ('最初之鳞·混沌',3,'dragon',2e+16,1e+17,28600,'glow:true, teeth:true'),
 ('终焉之影·忘川',3,'shark',1e+17,5e+17,24700,'body:0.30, glow:true, teeth:true'),
]

FIELD_NAMES = {
 'D':'村口小池塘','C':'溪流浅滩','B':'湖心半岛','A':'深海断崖',
 'S':'幽蓝海沟','SS':'星陨之渊','SSS':'时之尽头',
}

def js_str(s):
    return "'" + s + "'"

def build():
    lines = []
    lines.append("/* =========================================================")
    lines.append("   fish.js  —  鱼种数据表（共 %d 种）" % sum(len(v) for v in FIELD_FISH.values()))
    lines.append("   =========================================================")
    lines.append("   ⚠️ 本文件由 tools/gen-fish.py 自动生成，不要手改；")
    lines.append("      改鱼名 / 体重 / 价格请改 gen-fish.py，然后重新生成。")
    lines.append("      档内权重 w 由 tools/solve-drop.js 反推写入。")
    lines.append("")
    lines.append("   每条鱼 = 品种 × 颜色变异 × 重量 三个状态维度中的「品种」部分。")
    lines.append("   字段： id / name / rar(0普1稀2史3传) / shape / body / accent")
    lines.append("          minKg / maxKg / price / w(档内权重)")
    lines.append("   ========================================================= */")
    lines.append("window.G = window.G || {};")
    lines.append("")
    lines.append("(function () {")
    lines.append("  var list = [];")
    lines.append("")
    lines.append("  function F(id, name, rar, shape, body, accent, minW, maxW, price, opts) {")
    lines.append("    opts = opts || {};")
    lines.append("    list.push({")
    lines.append("      id: id, name: name, rar: rar,")
    lines.append("      shape: shape, body: body, accent: accent,")
    lines.append("      minKg: minW, maxKg: maxW, price: price,")
    lines.append("      w: opts.w == null ? 1 : opts.w,")
    lines.append("      tail:  opts.tail  || 'fan',")
    lines.append("      body_ratio: opts.body == null ? 0.34 : opts.body,")
    lines.append("      spiny: !!opts.spiny, barbels: !!opts.barbels,")
    lines.append("      glow: !!opts.glow, teeth: !!opts.teeth,")
    lines.append("      lure: !!opts.lure, stripes: !!opts.stripes, spots: !!opts.spots,")
    # 天气 / 时段偏好：命中的话在档内权重会 ×2.2（见 config.weather）
    lines.append("      wx: opts.wx || null, tm: opts.tm || null,")
    lines.append("      field: id.slice(0, id.search(/\\d/)).replace(/[^A-Za-z]/g, ''),")
    lines.append("    });")
    lines.append("  }")
    lines.append("")

    total = 0
    for fid in ['D','C','B','A','S','SS','SSS']:
        rows = FIELD_FISH[fid]
        pal = PALETTES[fid]
        counts = [0,0,0,0]
        for r in rows: counts[r[1]] += 1
        lines.append("  /* ===== %s · %s（%d 种：普%d 稀%d 史%d 传%d）===== */" % (
            fid, FIELD_NAMES[fid], len(rows), counts[0], counts[1], counts[2], counts[3]))
        for i, (name, rar, shape, mn, mx, price, opts) in enumerate(rows):
            body, accent = pal[i % len(pal)]
            fidx = "%s%02d" % (fid, i + 1)
            wx, tm = pref_of(i, rar)
            bits = ["w:1"]
            if opts:
                bits.append(opts)
            if wx:
                bits.append("wx:'%s'" % wx)
            if tm:
                bits.append("tm:'%s'" % tm)
            o = ", ".join(bits)
            lines.append("  F('%s', '%s', %d, '%s', '%s', '%s', %s, %s, %d, { %s });" % (
                fidx, name, rar, shape, body, accent,
                ("%.2f" % mn) if mn < 1 else ("%.1f" % mn),
                ("%.2f" % mx) if mx < 1 else ("%.1f" % mx),
                max(1, round(price * FIELD_PRICE_MUL[fid])), o))
        lines.append("")
        total += len(rows)

    lines.append("  /* ---------- 索引 ---------- */")
    lines.append("  G.FISH = list;")
    lines.append("  G.FISH_ID = {};")
    lines.append("  G.FISH_BY_FIELD = {};")
    lines.append("  list.forEach(function (f) {")
    lines.append("    G.FISH_ID[f.id] = f;")
    lines.append("    if (!G.FISH_BY_FIELD[f.field]) G.FISH_BY_FIELD[f.field] = [];")
    lines.append("    G.FISH_BY_FIELD[f.field].push(f);")
    lines.append("  });")
    lines.append("")
    lines.append("  G.FISH_BY_FIELD_RARITY = {};")
    lines.append("  Object.keys(G.FISH_BY_FIELD).forEach(function (fid) {")
    lines.append("    var buckets = [[], [], [], []];")
    lines.append("    G.FISH_BY_FIELD[fid].forEach(function (f) { buckets[f.rar].push(f); });")
    lines.append("    G.FISH_BY_FIELD_RARITY[fid] = buckets;")
    lines.append("  });")
    lines.append("")
    lines.append("  G.ALL_FISH_IDS = list.map(function (f) { return f.id; });")
    lines.append("  G.TOTAL_FISH = list.length;   // %d" % total)
    lines.append("})();")
    lines.append("")
    return "\n".join(lines)

if __name__ == '__main__':
    txt = build()
    io.open(OUT, 'w', encoding='utf-8').write(txt)
    print("生成 %s" % os.path.abspath(OUT))
    for fid in ['D','C','B','A','S','SS','SSS']:
        rows = FIELD_FISH[fid]
        c = [0,0,0,0]
        for r in rows: c[r[1]] += 1
        print("  %-4s %3d 种  档位 %s" % (fid, len(rows), "/".join(map(str, c))))
    print("  合计 %d 种" % sum(len(v) for v in FIELD_FISH.values()))
