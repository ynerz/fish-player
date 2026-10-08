# 鱼体描述「视觉化改写」规范（2026-10-08）

> **目的**：把 `tools/fish-traits.json` 里的 `form` / `fins` 从**鱼类学术语**改写成
> **扩散模型能画出来的视觉语言**。出图管线（`tools/gen-art.py`）直接吃这两个字段。
>
> **触发**：用户报障「都像普通鱼，实际是更细长的鱼」。已查明两个病根：
> ① `laterally compressed`（侧扁）在侧视图里恰是**显得更厚**，模型读成「被压扁的身体」；
> ② `form_profile()` 提前 return 让 362 条鱼全部没用上 `body_ratio` 比例盘（已修）。
> 本文处理①这类**术语问题**，是剩下的 211 条（58%）。

---

## 0. 铁律（违反任一条即整条报废）

1. **只许删与改写，不许新增。**
   改写后出现的每一个「特征词」，都必须在原文里出现过。**不允许**凭常识补充原文没有的
   特征（不许加「有须」「有斑」「背鳍分两段」这类原文没写的）。
2. **只保留「侧视图可见」的信息。**
   卡片是**侧视**。所以：正面/俯视才看得见的特征（体宽、侧扁程度、横切面形状）→ **删**；
   侧视能表达的（轮廓与比例、头型、吻型、口位、眼位与大小、鳍的形状与位置、须、棘、
   发光、条纹、斑点、色带）→ 保留。
3. **不写数字。** 鳍条数、鳞片数、脊椎数、鳃耙数一律删掉（对出图零信息量）。
4. **不写鱼类学术语。** 见下面的黑名单。
5. **不写「精细词」**：elaborate / ornate / decorative / intricate / detailed。
   一出现模型立刻画成精细插画，整批报废过。
6. **格式**：小写起头、`a`/`an` 打头的名词短语、逗号分隔、**不写句号**、不写主语
   （主语由 `gen-art.py` 统一拼：`silhouette of a <物种名>, <form>, <fins>, …`）。

---

## 1. 黑名单（出现即不合格，大小写不敏感）

### 1.1 直接删掉、不要替换
| 类别 | 词 / 模式 |
|---|---|
| 鳞片 | `scales` · `scale` · `ctenoid` · `cycloid` · `scale rows` |
| 侧线 | `lateral line` |
| 鳍条 | `fin rays` · `rays` · `ray` · `unbranched` · `branched rays` |
| 脊椎 / 鳃耙 | `vertebrae` · `vertebral` · `gill rakers` · `rakers` · `gill slits` |
| 数字 | 任何阿拉伯数字（含 `1-2`、`108-120`、`11+25`） |
| 生僻解剖术语 | `interorbital` · `nuchal` · `isthmus` · `caudal peduncle` · `pectoral fin bases` · `adipose` · `dentition` · `pharyngeal` |

### 1.2 要「改写」而不是删（这些是真形态特征，但写法误导模型）
| 原写法 | 问题 | 改成 |
|---|---|---|
| `laterally compressed` | 侧扁 = 左右压扁；侧视图里反而显得**更厚**，模型读成「被压扁」 | 删掉即可 —— 「体深」已由 `proportion_line()` 的**显式比例句**负责，别再重复 |
| `fusiform` | 鱼类学术语 | `spindle-shaped` |
| `deep-bodied` | 本身没错，但如果与比例句冲突就删（比例句是权威） | 保留或删 |
| `a keeled belly from between the pectoral fin bases to the anus` | 太长、术语化 | `a sharp keel along the belly` |
| `a superior mouth with a nearly vertical gape` | 术语化 | `an upward-pointing mouth` |
| `an inferior mouth` | 术语化 | `a downward-pointing mouth` |
| `terminal mouth` | 术语化 | `a mouth at the front of the head` |

---

## 2. 长度

`form` ≤ **300** 字符、`fins` ≤ **200** 字符。超了就继续删 —— 优先删黑名单里的东西；
黑名单删完还超，再删「对区分物种贡献最小」的（通常是鳍的细节位置）。

## 3. 输出格式

```json
{
  "items": [
    { "id": "D02", "name": "白条", "form": "<改写后>", "fins": "<改写后，可为空串>" }
  ]
}
```

- **id 必须原样透传**，不许增删条目、不许改顺序。
- `fins` 原文为空 → 输出空串。
- 只输出 JSON，不要 markdown 围栏、不要解释。

## 4. 示例

**原文（D02 白条）**
- `form`: `an elongated laterally compressed body, a slightly arched back, a small pointed head, an upward-directed mouth, a lateral line running along the middle of the flank, cycloid scales`
- `fins`: `a forked tail fin, short pectoral fins`

**改写后**
- `form`: `an elongated body, a slightly arched back, a small pointed head, an upward-pointing mouth`
- `fins`: `a forked tail fin, short pectoral fins`

**原文（A24 章鱼）**
- `form`: `a rounded bulbous mantle, a large head with prominent eyes, eight arms each with two rows of suckers, no internal shell`

**改写后**
- `form`: `a rounded bulbous mantle, a large head with prominent eyes, eight arms covered in suckers`

> ⚠️ 注意最后一条：`no internal shell` 是**内部结构**，侧视看不见 → 删；
> `each with two rows of` 是结构细节且带数字味 → 简化成 `covered in`。
> 但**没有**新增任何原文没有的特征。
