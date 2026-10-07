# 3D 渲染层迁移到 three.js —— 方案与风险（2026-10-08）

> **决策**：用户拍板「改为使用 three.js，不要嫌弃麻烦」。
> 本文不再论证该不该换，只写**怎么换、换了会跟谁打架、怎么回退**。

---

## 一、先说结论：能同时保住 `file://` 和「零构建」

引入方式有三种，我**实测**过：

| 方案 | 体积 | `<script src>` 可用 | `file://` 双击 | 构建步骤 | 版本 |
|---|---|---|---|---|---|
| **r160 UMD 单文件** ✅ **选它** | **669 KB** | ✅（全局 `THREE`） | ✅ 保住 | 不需要 | r160（2023） |
| r186 ESM + importmap | **2.03 MB**（`three.module.js` 662K + `three.core.js` 1.46M） | ❌ 模块不受支持 | ❌ 破 | 不需要 | r186（最新） |
| esbuild 打包 ESM | 视裁剪而定 | ✅ | ✅ | **需要**（本机 `npx` 拉不到，实测退出码 1） | r186 |

**为什么钉在 r160**：three.js 的 UMD 构建（`build/three.js` / `build/three.min.js`）
**自 r161 起被移除**（r150 起标弃用）。实测 `0.160.0` 仍返回 HTTP 200 且是真 UMD
（`typeof exports && "undefined" != typeof module ? … : … .THREE=`），`0.159.0` 同理。

🔴 **因此有一条硬规矩：不许把 three.js 升到 r161 及以上** —— 一升级就没有 UMD 单文件，
`<script src>` 与 `file://` 同时失效，等于把整个迁移方案推翻重做。

> 代价说清楚：r160 是 2023 年的版本。本项目只需要「低多边形 + 平涂 + 方向光」，
> 用不到 WebGPU / TSL / 新版材质，**这个代价是可接受的**。

---

## 二、已经验证过的部分（不是纸面推演）

`tools/three-preview.html` —— **用项目真实的鱼网格**（调 `G.FishMesh.build()`，不是另造一份）
在 three.js 里渲染，参数与 `mesh3d.js` 的 `LIGHT` 对齐（ambient 0.10 / key / rim）。

**实跑结果**（playwright 采集 console + 截图 `docs/images/three-preview.png`）：

```
THREE.REVISION = 160
已建 9 条鱼（fish/shark/ray/squid/jelly/eel/oarfish/whale/dragon），三角面合计 3005
PERF fps=180.0  frame=5.56ms  meshes=9  tris=3005
console: 0 errors
```

**关键实现点（照抄这两条，否则会出错）**：

1. **必须「非索引化」几何体 + `flatShading: true`**：一个三角面的三个顶点各带自己的颜色。
   用索引几何体会让相邻面共享顶点、颜色被插值糊掉，**低多边形的棱当场消失**。
2. `G.FishPaint.fromFish()` 返回的字段是 **`back` / `belly`**（不是 `body`/`accent`）——
   它内部走 `palette(fish.body, fish.accent, morphKey)`，出来的是一组渲染用色。
   取错字段会**静默拿到 undefined → 整批鱼变灰**（第一次跑就栽在这）。

**注意：180 fps 是垂直同步的上限，不代表余量。** 两边都顶到刷新率，
说明**性能不是这次迁移的理由**——理由是用户要统一的 3D 管线与后续能力（glTF / 骨骼动画）。

---

## 三、🔴 真正的难点：图鉴 / 鱼护 / 水族箱是「大量小图」

这是整件事里最容易翻车的地方，必须先说：

- 项目**故意**把图鉴/鱼护/水族箱做成大量小画布，并用 **`IntersectionObserver` 懒绘制**
  （不是 `setTimeout` 分批），图鉴还明确**不做虚拟滚动**。
- **WebGL 上下文有数量上限**（浏览器通常 8~16 个）。**每张小图各开一个 WebGL canvas 会直接爆掉**，
  而且爆了通常只表现为「后面的图不画」，不报错。

**所以正确架构只有一个**：

```
一个共享的离屏 WebGLRenderer
        ↓ 渲染到 RenderTarget
        ↓ drawImage 贴进各张 2D canvas（图鉴缩略图 / 鱼护 / 水族箱）
主画面（场景）→ 直接用一个 WebGL canvas
```

好处：与现有懒绘制机制**天然兼容**（贴图是同步的，不占用 context）。
代价：多一次离屏采样，缩略图尺寸下可忽略。

---

## 四、分阶段迁移（每阶段门禁必须全绿，一阶段一提交）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | `vendor/three.min.js`（r160 UMD）+ `tools/three-preview.html` 对照页跑通 | ✅ **本轮完成** |
| **P2** | 新增 `src/render/threegl.js`：共享离屏 renderer + `drawMeshTo(ctx, mesh, st)`；**不动既有路径**；挂进 `index.html`；补 `test.js`/`verify.js` 断言并反向验证 | 待做 |
| **P3** | `scene.js` 主画面切过去（它本来就是一块大画布，投入产出比最高） | 待做 |
| **P4** | 图鉴 / 鱼护 / 水族箱逐个切（走共享 renderer 的贴图路径） | 待做 |
| **P5** | `mesh3d.js` 退役 —— ⚠️ **要同步改三处口径**（`开发者文档.md` §1、`GDD.md` §9、`README.md`）+ 两处「自检 N 节」 | 待做 |

**P5 之前 `mesh3d.js` 一律保留**作为回退路径。

---

## 五、风险与「和谁打架」（系统交互矩阵）

| 相关系统 | 冲突 | 处置 |
|---|---|---|
| 硬约束①「零第三方依赖」 | **直接破** | 用户已拍板放开。`vendor/` 入库、版本钉死 r160、本文记档；后续会话不得再把它当违规改回去 |
| 硬约束②「零构建步骤」 | **用 UMD 保住** | 见第一节的硬规矩：不许升到 r161+ |
| `file://` 双击能跑 | 用 UMD 保住 | 同上 |
| 主包 ≤4MB | +669 KB（约占 17%） | 可接受。若逼近上限，优先砍的不是 three.js 而是别的素材 |
| `facet-count.py` 面片密度靶子（≈3.6 色块/千px） | three.js 的抗锯齿与光照插值会改变边缘质感 | **P3/P4 之后必须重跑对拍并记数**；靶子偏了就调 GEOM，不是调靶子 |
| 图鉴懒绘制 / 不做虚拟滚动 | WebGL context 上限 | 共享离屏 renderer + `drawImage`（见第三节） |
| `verify.js` ⑪（`src/` 模块必须挂进 `index.html`） | 新增模块会触发 | P2 起每次新增模块都要挂；这是**故意的**，别绕 |
| `test.js` 死代码/导出断言 | 新模块的导出若没消费者会被判死 | 先接好调用点再提交 |
| 存档 / 玩法 / 数值 | **无影响** | 渲染是叶子，不碰 `St` / `loot` / `config` |
| 生图长跑（`gen-art.py` 互斥锁） | 迁移期的 WebGL 测试会抢 GPU | 生图长跑期间**不做**性能对拍，只做功能验证 |

---

## 六、回退

- P2~P4 每一步都**新增模块或加开关**，不改既有渲染路径 → 出问题把开关关掉即可。
- P5 之前 `mesh3d.js` 一直在；`git checkout -- src/render/` 可整体退回。
- ⚠️ **不许用 `git checkout -- .`**（会连带回退生图台账与素材清单）。
