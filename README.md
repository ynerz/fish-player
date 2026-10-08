# 🎣 钓鱼人生 · Fish Player

一款纯前端的单机钓鱼游戏：**抛竿 → 等咬钩 → 张力拉扯 → 收进图鉴**。
7 个钓场、362 种鱼、4 级稀有度、5 档颜色变异、鱼护与水族箱，
全程程序化绘制与合成音效，**零依赖、零构建**（改完刷新即可；
`tools/build.js` 只是可选的发布打包，见「打包成单文件」）。

> 文档分档：
> - [`docs/说明书.html`](docs/说明书.html) —— **玩家向**：玩法 / 图鉴 / 节奏 / 装备 / FAQ
> - [`docs/GDD.md`](docs/GDD.md) —— **策划向**：数值、掉率表、实测平衡数据
> - [`docs/开发者文档.md`](docs/开发者文档.md) —— **开发者向**：技术约束 / 模块职责 / 工具链 / 技术债
> - [`docs/改进待办.md`](docs/改进待办.md) —— 代码审查与改进清单（**只追加**，含全部未完成项）
> - [`docs/每小时优化轮次规范.md`](docs/每小时优化轮次规范.md) —— **每轮优化怎么走**（流程 / 工作量下限 / 交接规则）
> - [`docs/优化队列.md`](docs/优化队列.md) —— **下一轮做什么**（派单表 + 轮次台账）

---

## 快速开始

**最简单**：双击 `index.html` 就能玩（刻意不用 ES Module，`file://` 直接可跑）。

**单文件版**（把 `index.html` 引用的脚本与样式表内联成一个 HTML，方便分发）：

```bash
node tools/build.js --release    # → dist/fish-player.release.html，双击即玩
```

**推荐**（避免个别浏览器对 `file://` 的限制）：

```bash
cd "D:/fish player"
python -m http.server 8765 --bind 127.0.0.1
# 然后浏览器打开 http://127.0.0.1:8765/
```

> ⚠️ 用完记得关掉这个 server，它会挂在后台任务列表里。

## 操作

| 操作 | 说明 |
|---|---|
| **抛竿** | 点右下角按钮 / 点画面 / 按 `空格` |
| **提前收杆** | 等待期间点按钮，放弃这一竿（咬钩前 8 秒浮漂会轻微异动） |
| **提竿** | 咬钩时浮漂下沉，1.2~1.6 秒内点按钮 |
| **收线** | 拉扯时**按住**按钮 / 鼠标左键 / `空格` |
| **放线** | 松手。张力太高会断线（要付鱼线修理费），一直松着会脱钩 |
| **躲逃窜** | 出现"要逃窜了"提示时立刻松手 |
| **留鱼** | 结算卡可以选「卖出」或「收进鱼护」，之后能放生或移进水族箱 |

## 目录结构

```
index.html              唯一入口（所有脚本按顺序加载，兼容 file://）
assets/css/style.css    全部样式
src/data/               纯数据层：数值配置 / 钓场 / 鱼种 / 道具
src/core/               逻辑层：抽卡 · 存档 · 拉扯玩法 · 钓鱼状态机 · 音效
src/render/             Canvas 渲染：鱼类绘制器 · 场景
src/ui/                 HUD 与各类弹层
src/main.js             启动与主循环
tools/                  数值仿真、调参、自检、单测与打包（不参与游戏运行）
dist/                   单文件构建产物（不入库，由 tools/build.js 生成）
docs/                   四份文档 + 配图
```

## 解锁节奏（实测期望值）

| 钓场 | 鱼种 | 解锁条件 | 预计累计时长 | 每小时金币 |
|---|---|---|---|---|
| D 村口小池塘 | 16 | 开局即开放 | — | 2,343 |
| C 溪流浅滩 | 24 | D 图鉴 80% | ~2 h | 2,908 |
| B 湖心半岛 | 34 | C 图鉴 80% | ~6 h | 3,825 |
| A 深海断崖 | 46 | B 图鉴 80% | ~22 h | 6,586 |
| S 幽蓝海沟 | 62 | A 图鉴 80% | ~67 h | 8,457 |
| SS 星陨之渊 | 80 | D~S 全部 100% | ~166 h | 10,611 |
| SSS 时之尽头 | 100 | D~SS 全部 100% | **~298 h** | 14,134 |

全部 7 个钓场 100% 收满 ≈ **828 小时**；把颜色也收齐（1810 组合）≈ **2 年**。

> **解锁只看「品种」**，颜色和重量不参与任何解锁判定。
> 收益曲线保证**每进一个新场每小时金币至少 +24%**，不会出现「越玩越亏」。

## 调数值

**所有平衡参数集中在 `src/data/config.js`**，改完刷新页面即可。
鱼种表由脚本生成（**不要手改** `src/data/fish.js`）。

```bash
# 改鱼种 / 鱼价（含每场价格乘数 FIELD_PRICE_MUL，经济曲线的总旋钮）
python tools/gen-fish.py

# 改完节奏目标后反推整套掉率并写回 fields.js / fish.js
node tools/solve-drop.js

# 复核：胜率 / 节奏 / 每小时收益 / 图鉴耗时 / 颜色耗时
node tools/balance.js

# 数据自检：概率合计、颜色序、单调性、收集耗时对账、经济曲线不倒退
node tools/verify.js

# 单元测试：Loot / Fight / State / 鱼护 / 存档迁移 / NaN 兜底
node tools/test.js

# 其它
node tools/tune.js               # 扫 dashPower 找合适的拉扯难度
node tools/check-roster.js       # 看各钓场鱼种与档位分布
node tools/gen-collect-time.js   # 重新生成 docs/收集耗时表.html

# 打包成单个 HTML 文件（可选，只在发布前用；开发期改完刷新即可）
node tools/build.js              # → dist/fish-player.html
node tools/build.js --release    # → dist/fish-player.release.html（剔除调试面板）
node tools/build.js --check      # 只跑产物断言，不写文件
```

**改完数值的标准流程**（顺序不能换）：

```
gen-fish.py → solve-drop.js → balance.js → verify.js → gen-collect-time.js
```

## 美术风格

`src/render/fishart.js` 里有 **6 套画风**（flat / bold / water / real / neon / pixel），
同一套几何可横向对比。**已选定 `flat`（扁平卡通）为默认**，其余 5 套是开发期对比用的备选，
开发期用 `G.FishArt.setStyle('bold')` 切换。

⚠️ 这**不是给玩家的功能** —— 收口时把没选中的从 `STYLES` 里删掉即可。
交互页 `tools/style-preview.html`（原 `docs/style-preview/` 的对比图已清空，需要时用它重新生成）。

## 音效与音乐

全部**程序化合成，没有音频素材文件**（`src/core/audio.js`）：

- **音效**：抛竿 / 水花 / 咬钩 / 收线咔哒 / 断线 / 脱钩 / 上鱼 / 传说鱼专属 fanfare /
  稀有颜色的一闪 / 领奖 / 图鉴新记录 / 金币 / 解锁……共 22 个方法。
  拉扯阶段按「**收进多少进度**」打点咔哒声 —— 收得动就响得密，不看张力条也听得出这条拉不拉得动。
- **背景音乐**：每个钓场一段自己的和声进行（大调 / 小调 / 主音各不相同），
  低音 + 和弦垫 + 稀疏铃音三层，走 lookahead 调度。参数在 `src/data/fields.js` 的 `theme.bgm`。
  还会**随时段 / 天气换参数**：夜里转小调、雨雾天放慢（`config.weather` 的 `times[].bgm` /
  `types[].bgm`，由 `G.Weather.bgmSpec()` 合成有效参数）—— 只换参数，不重启，也不打断正在放的这段。
- **三条子总线**（`busSfx` / `busAmb` / `busBgm`）：音效、环境水声、音乐分开，
  设置面板里是三个独立开关，外加一行「**音乐音量**」滑块（只调音乐，不动音效与水声）。
- ⏸ 一次性音效支持**采样优先 + 合成回退**（把文件放进 `assets/audio/<方法名>.mp3` 即自动接管），
  目前目录为空 ⇒ 全部走合成。详见 `docs/开发者文档.md` §17.13。

## 存档

保存在浏览器 `localStorage`（键 `fishplayer.save.v1`，另有 `.bak` 备份）。
设置面板可一键导出到剪贴板；导入则是把导出的 JSON 粘进对话框（不读剪贴板；导入前会做字段校验与版本迁移）。
清浏览器缓存会丢档。

存档结构版本号在 `src/core/state.js` 的 `SAVE_V`；改存档字段时要 +1 并在 `migrate()` 里加分支。

## 调试

URL 加 `?dev` 或 `#dev` 会出现底部开发者工具栏，或控制台直接调：

```js
G.Cheat.unlockAll()       // 解锁全部钓场
G.Cheat.fillBook()        // 每个鱼种各 1 条
G.Cheat.fillColors()      // 填满 362 × 5 个颜色组合
G.Cheat.addCoin(1e6)      // 加金币
G.Cheat.setPlayTime(1000) // 游玩时长设成 1000 小时
G.Cheat.clearSave()       // 清档并刷新
```

## 平台路线

- **当前**：纯 Web 单机版
- **下一步**：微信小程序（需替换存储 / 音频 / Canvas / 输入适配层）
- **再下一步**：Steam（Tauri / Electron 打包 + Steamworks 成就与云存档）

美术与音效均为程序化生成，没有外部素材文件，包体极小，便于多端移植。
