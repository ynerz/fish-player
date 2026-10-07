# 鱼类特征标准化输出规范（v1，2026-10-08）

> 用途：把「一条鱼」变成 `tools/fish-traits.json` 里的一条记录。
> 这份规范可以直接拿去问任何 AI（含开多个对话并行），要求**只输出 JSON，不要解释**。

## 一、输出格式（严格遵守）

一次给 **10 条鱼**，输出一个 JSON 对象，键是鱼 id：

```json
{
  "A12": {
    "name": "黄姑鱼",
    "latin": "Nibea albiflora",
    "form": "an elongated laterally compressed body, a slightly arched back, a medium-sized head, a short blunt snout, a large oblique mouth, the upper jaw slightly longer than the lower, ctenoid scales, a complete lateral line",
    "fins": "a long dorsal fin with a deep notch, a wedge-shaped tail fin",
    "markings": "wavy diagonal stripes running down the flanks",
    "colour": "背灰橙色，腹部银白色",
    "source": "grounded",
    "unknown": false
  }
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | 照抄给定的鱼名，不许改 |
| `latin` | ⭕ | 拉丁学名。**不确定就空串**，不许猜 |
| `form` | ✅ | **体型句**：身体形状 / 比例 / 头 / 吻 / 口 / 眼 / 须 / 鳞 / 侧线 / 尾柄。英文小写起头，逗号分隔的短语串，无句号 |
| `fins` | ⭕ | **各鳍**：背鳍 / 臀鳍 / 尾鳍 / 胸鳍 / 腹鳍的形态。没有确切信息就空串 |
| `markings` | ⭕ | **花纹形状**：条纹 / 斑点 / 纵走线 / 横带。**⛔ 绝对不许出现颜色词** |
| `colour` | ⭕ | 现实配色，**用中文原句**。只存档，不参与出图 |
| `source` | ✅ | `"grounded"` = 依据给定的原文；`"model"` = 仅凭模型知识 |
| `unknown` | ✅ | `true` = 不认识这个物种 / 没把握。此时 `form` 必须为空串 |

## 二、四条硬规则

1. **`markings` 里不许有颜色词**（grey / silver / golden / yellow / black / white / red /
   brown / blue / dark / pale …）。
   颜色归 `colour` 字段（而且 `colour` **只存档，不喂出图提示词**）。
   理由：游戏里 5 档配色是**夸张体系**，照搬现实配色会把配色体系搞坏。
   - ✅ `a spot behind the eye` ｜ ❌ `a dark spot behind the eye`

2. **`form` 里不许出现「精细」词**：`elaborate` / `ornate` / `decorative` / `intricate` /
   `detailed texture`。一出现，出图模型立刻画成精细插画（本项目实测过整批报废）。

3. **不许编**。不认识这个物种 → `"unknown": true` 且 `form` 留空。
   **留空永远优于编造**：`gen-art.py` 对空字段的处理是「不写这句」，
   编排的后果是这条鱼的图从头错到尾，而且看不出来。

4. **`form` 用「描述性名词短语」，不用完整句子**。
   ✅ `a laterally compressed body, a small head, an inferior mouth`
   ❌ `The fish has a body that is compressed laterally.`

## 三、语汇参考（保持全表用词一致）

**身体**：`an elongated / slender / stout / oval / diamond-shaped / tongue-shaped /
laterally compressed / deep / cylindrical / spindle-shaped body`、`a rounded belly`、
`a slightly arched back`、`a keeled belly`、`no ventral keel`

**头 / 吻 / 口**：`a large / medium-sized / small / blunt rounded / conical head`、
`a short blunt snout`、`a long pointed snout`、`a terminal / inferior / superior / large
oblique / small mouth`、`the upper (lower) jaw slightly longer than the other`、
`no barbels`、`barbels at the corners of the mouth`、`large / medium-sized / small eyes`

**鳞 / 侧线 / 尾柄**：`ctenoid / cycloid scales`、`small / large scales`、
`naked skin with no scales`、`a complete lateral line`、`a gently curved lateral line`、
`a short / long / narrow compressed caudal peduncle`

**鳍**：`a long dorsal fin`、`a dorsal fin with a deep notch`、`no dorsal spines`、
`a dorsal fin with a stout spine`、`a deeply forked / slightly forked / rounded /
pointed / wedge-shaped / slightly concave tail fin`、`long / short pectoral fins`、
`no pectoral fins`、`the dorsal and anal fins joined continuously to the tail fin`、
`fin rays all unbranched`

**花纹**：`vertical bands crossing the flanks`、`longitudinal lines along the flanks`、
`wavy diagonal stripes`、`spots scattered along the flanks`、
`a blotch at the base of the tail`、`a spot on the gill cover`、`a spot behind the eye`、
`a single spot at the tip of the snout`

## 四、批次输入格式

`tools/ai-traits/in-NN.json`：

```json
{
  "batch": 1,
  "items": [
    {"id": "A12", "name": "黄姑鱼", "maxKg": 3.5, "bodyRatio": 0.42,
     "ref": "……百科原文的中文形态描述（可能为空串）……"}
  ]
}
```

- `ref` **非空** → 以原文为唯一依据，`source` = `"grounded"`。
- `ref` 为空 → 用你自己的生物分类学知识，`source` = `"model"`；没把握就 `unknown`。

---

# 附：虚构生物的设计规范（`source: "fictional"`）

> 适用：`SS`（星辰场 80 条）+ `SSS`（时空场 100 条）+ 游戏造名（湖心巨鲤、百斤鳡王 等）。
> 用户口径（2026-10-08）：「把虚构的生物也按标准格式描述一下，因为虚构的生物一般较为稀有，
> **所以要有高级感一点**。」

## 一、字段规则（与正表完全相同，只有 `source` 不同）

- `source` 一律写 **`"fictional"`**（既不是 grounded 也不是 model —— 它**不是**任何现实物种，
  不许伪装成动物学知识）。
- `latin` **必须留空串**（虚构生物没有学名，编一个就是造假）。
- `unknown` 写 `false`（我们**是**在描述它，只是描述的是设计而非事实）。
- `colour` 写中文的概念配色（如「深靛底、星屑银点」），**只存档不喂提示词**。
- 其余规则（`markings` 不许颜色词、`form` 小写短语、无句号、≤300 字符…）**一字不改**。

## 二🔴 最重要的约束：**「高级感」不许靠"精细词"**

本项目实测：`form` 里一旦出现 `elaborate` / `ornate` / `decorative` / `intricate` /
`detailed texture`，出图模型**立刻画成精细插画**，低多边形画风当场报废（v10 首批 10 张全废在这条）。

**所以「高级感」只能来自造型语言，不能来自形容词强度。** 五条可用手法：

| 手法 | 做法 | 反例（不要） |
|---|---|---|
| **结构化** | 对称 / 等距排列 / 层叠 / 秩序感 | 胡乱堆满装饰 |
| **结构部件** | 脊冠、翼状鳍、发光器列、多层伞裙、悬浮环、棱面切角 | 「华丽的鳍」这种空话 |
| **克制** | 少而准的 2~3 处点缀 | 密密麻麻的碎点 |
| **材质暗示**（非颜色词） | `translucent` / `crystalline` / `faceted` / `iridescent` / `glass-like` / `resinous` / `matte` | `glittery everywhere` |
| **形态张力** | 极细的延长、极致对称、被「凝固」的动势 | 「更华丽一点」 |

✅ 好例子：`an elongated diamond-sectioned body with crisp bevelled edges, a single row of
evenly spaced luminous pores along the flank, a long trailing dorsal crest`
❌ 坏例子：`an extremely ornate and highly detailed decorative body`（会画成写实插画）

## 三、语义场 → 造型映射（按名字里的字取）

| 名字里的字 | 语义场 | 造型落点 |
|---|---|---|
| 星 / 陨 / 尘 / 光 / 冷 / 暗 / 磷 | **星辰场** | 发光器、棱面切角、陨石质感、稀疏亮点、虚空留白、被星尘包裹 |
| 时 / 溯 / 须臾 / 刹那 / 瞬息 / 一刻 / 遗迹 / 琥珀 / 残响 / 静默 / 沙漏 / 零度 / 初雪 | **时空场** | 凝固的动势、层叠年轮、被侵蚀的边缘、树脂/琥珀包裹、静止的波纹 |

## 四、必须与 `shape` 模板兼容

提示词会在你的 `form` 前面自动接一句**体型模板**（`gen-art.py:SHAPES`）：

| shape | 模板已经说了什么 | 你能补什么 |
|---|---|---|
| `fish` | 流线型圆身 | 身体比例 / 头 / 口 / 鳞 / 侧线 |
| `shark` | 鱼雷身 + 尖吻 + 三角背鳍 | 比例 / 齿 / 鳃裂 |
| `ray` | 扁平菱形 + 翼状胸鳍 | 尾部 / 头部突起 / 翼缘形态 |
| `squid` | 长外套膜 + 三角侧鳍 + 触手 | 触手排列 / 鳍形 |
| `jelly` | 圆伞盖 + 长触手 | **伞缘结构** / 触手分组 |
| `eel` | 细长带状 + 连续背鳍 | 头部 / 身体断面 |
| `oarfish` | 极长身体 + 全背脊冠 | 脊冠形态 / 头饰 |
| `dragon` | 蛇形长身 + 棘背脊 + 触须 | 脊棘排列 / 须 / 头角 |
| `whale` | 庞大圆身 + 水平尾叶 + 小背鳍 | 头型 / 喉褶 / 尾叶 |

⛔ **不许写出与模板冲突的句子**（给 `squid` 写 `a laterally compressed body` 就是自相矛盾）。
