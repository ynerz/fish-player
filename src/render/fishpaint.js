/* ============================================================================
 * fishpaint.js —— 颜色变异 → 材质参数
 *
 * 规格：docs/3D渲染方案.md §5　｜　口径：docs/开发者文档.md §1.4
 * 职责边界：纯函数（颜色换算 + 查表），**不碰 DOM / Canvas**，可在 Node 里单测。
 *
 * 为什么要有这一层：每条鱼在 fish.js 里自带一对颜色（body / accent），
 * 颜色变异（原色 / 亮色 / 白化 / 黄金 / 闪光）**不是「再画一张图」**，
 * 而是把这一对颜色按规则换算成材质参数（背色 / 腹色 / 边缘光 / 镜面 / 金属 / 虹彩）。
 *
 * ⚠️ 三条硬口径（写进单测，不是口头约定）：
 *   1. **原色 = 该鱼自己的配色对**，不是统一灰 —— 原色是最常见的渔获，必须各有各的样子
 *   2. **亮色只许「同色系提亮提饱和」，禁止换色相** —— 售价只 ×1.15，视觉跃迁必须与之相称；
 *      曾经画成整条霓虹彩虹，结果玩家觉得「亮色比黄金还扎眼，而它最便宜」
 *   3. 白化 = 去色 / 黄金 = 换材质 / 闪光 = 加光效 —— **三种不同手段**，
 *      退化成「同一个颜色深一点浅一点」就等于颜色变异系统白做了
 * ========================================================================== */
window.G = window.G || {};
G.FishPaint = (function () {
  'use strict';

  /* 颜色档的展示顺序 = config.colorMorphs 的顺序（原色 → 亮色 → 白化 → 黄金 → 闪光） */
  var MORPH_KEYS = ['normal', 'bright', 'albino', 'golden', 'shiny'];

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** '#rrggbb' → [r,g,b]（0~1）。认不出就退回中灰，不抛异常 */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return [0.5, 0.5, 0.5];
    var h = hex.replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [0.5, 0.5, 0.5];
    return [
      parseInt(h.substr(0, 2), 16) / 255,
      parseInt(h.substr(2, 2), 16) / 255,
      parseInt(h.substr(4, 2), 16) / 255
    ];
  }

  function rgbToHsl(c) {
    var r = c[0], g = c[1], b = c[2];
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0, s = 0, l = (mx + mn) / 2;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, l];
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1; s = clamp01(s); l = clamp01(l);
    if (s < 1e-6) return [l, l, l];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
  }

  /** 亮度（感知加权）：用来判断哪个色更「深」，决定背 / 腹 */
  function luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /**
   * 核心：一对颜色 + 颜色档 → mesh3d 需要的材质参数
   * @param {string} bodyHex   鱼自带的主色（'#rrggbb'）
   * @param {string} accentHex 鱼自带的辅色（'#rrggbb'）
   * @param {string} morphKey  MORPH_KEYS 之一
   * @returns {{back:number[],belly:number[],rim:number[],rimK:number,spec:number,metallic:number,spin:number,sparkle:number}}
   */
  function palette(bodyHex, accentHex, morphKey) {
    var A = hexToRgb(bodyHex), B = hexToRgb(accentHex);
    // 哪个更深哪个更浅不靠参数顺序 —— 数据里两种顺序都可能出现
    var dark = luma(A) <= luma(B) ? A : B;
    var light = luma(A) <= luma(B) ? B : A;
    var hd = rgbToHsl(dark), hl = rgbToHsl(light);

    if (morphKey === 'bright') {
      /* 手段 = **换色相**（彩虹）。
         ⚠️ 2026-10-07 用户口径：「之前的亮色就用现在的彩虹色吧」——
            这条**推翻了**旧口径「亮色只许同色系提亮提饱和、禁止换色相」。
            旧口径的理由是「彩虹比黄金还扎眼，而它最便宜」。
            **解法是把黄金也提上去**（见下面 golden 分支：取 v9 的提亮版），
            两个必须**一起改**，价格梯度才立得住；只改亮色会重现老问题。
         ⚠️ `bands` 是**沿身体长度方向**的色带（不是背腹两色）——
            `mesh3d.js` 按面的位置取色，`paint-card.py` 用它建多色标 LUT。
         ⚠️ 起点用**该鱼自己的色相** `hd[0]`：每条鱼的彩虹起点不同，
            同科属的鱼也能区分开（用户口径「同种要有小特征区分」）。
         ⚠️ `rimK` 必须**低于黄金档的 1.45** —— 这是价格梯度的视觉契约。 */
      var bands = [];
      for (var bi = 0; bi < 5; bi++) {
        // 饱和度 0.58 而不是 0.72：高饱和的彩虹会**压过黄金**，
        // 重现旧口径警告的问题（「亮色比黄金还扎眼，而它最便宜」）。
        // v8 参考图里的彩虹本身就是**协调**的，不是霓虹。
        bands.push(hslToRgb(hd[0] + bi * 0.25, 0.58, 0.56));
      }
      return {
        back: bands[2], belly: bands[3],
        bands: bands,
        rim: hslToRgb(hd[0] + 0.5, 0.5, 0.86),
        rimK: 0.95, spec: 0.22, metallic: 0, spin: 0, sparkle: 0
      };
    }
    if (morphKey === 'albino') {
      /* 手段 = **去色**（色素缺失）。
         ⚠️ 口径来自 v8 样张（用户 2026-10-07 指定「v8 的白化风格也是很好的，可以用上」）：
            白身 + **淡粉鳍** + 粉边缘光 —— 色素流失后残留的血管感，真实白化动物就是这个样子。
         ⚠️ 2026-10-07 追加用户口径：「**颜色要稍微区分一点点**」——
            主体保留**该鱼自己色相的极淡痕迹**（饱和度 0.12、亮度 0.82，看起来仍是白身，
            但同一批白化鱼放在一起能分出是哪一条），鳍与边缘光继续用标准粉。
            旧版是固定粉白（`hslToRgb(0.97, ...)`），所有白化鱼完全一样。
         ⚠️ 卡面层（`paint-card.py` 的渐变映射）只吃 back / belly：
            灰度的暗部（鳍、暗面）→ back，亮部（身体）→ belly。 */
      return {
        // back = 该鱼色相的极淡版 **与标准粉的混合**：
        // 纯用本色相 → 鳍就白了（丢掉 v8「淡粉鳍」这个特征）；
        // 纯用粉 → 又回到「所有白化鱼一模一样」。混 70% 粉 —— 实测 45% 时
        // 出图看着仍是「全白」，粉调不够，与标准图差得明显。
        back: mix(hslToRgb(hd[0], 0.12, 0.82), [1.00, 0.72, 0.78], 0.70),
        belly: hslToRgb(hl[0], 0.05, 0.96),
        rim: [1.00, 0.86, 0.90],
        rimK: 0.85, spec: 0.12, metallic: 0, spin: 0, sparkle: 0
      };
    }
    if (morphKey === 'golden') {
      /* 手段 = **换材质**（哑光 → 金属）。
         低次幂镜面 = 整块高光，跟闪光的细高光区分开。
         ⚠️ 背 / 腹的明度差要够大，否则整条鱼糊成一块金饼 —— 金属反而比哑光更需要层次。
         ⚠️ **亮度取 v9 不取 v8**（用户口径：「v8 下除了黄金色亮度不如 v9，其他都可以」）。
            而且亮色改成彩虹之后，黄金**必须比它更强**，否则重现旧问题
            「亮色比黄金还扎眼，而它最便宜」—— 这是价格梯度的视觉契约
            （test.js 有断言盯着：`pG.rimK > pB.rimK`）。
         ⚠️ 2026-10-07 追加用户口径：「**颜色要稍微区分一点点**」——
            金色里掺入**该鱼色相的极轻偏移**（只影响 12%，仍是明摆着的金色），
            这样同一批黄金鱼放在一起，色温上能分出是哪一条。
            旧版是固定金（`[0.62, 0.40, 0.06]`），所有黄金鱼完全一样。 */
      var goldHue = 0.11 + (hd[0] - 0.11) * 0.12;   // 0.11≈金；只取本色的 12%
      return {
        back: hslToRgb(goldHue, 0.90, 0.34),
        belly: hslToRgb(goldHue + 0.02, 0.72, 0.82),
        rim: [1.00, 0.97, 0.80],
        rimK: 1.45, spec: 0.60, metallic: 1, spin: 0, sparkle: 0
      };
    }
    if (morphKey === 'shiny') {
      // 手段 = **加光效**（虹彩 + 移动高光 + 星点）。保留鱼本色的色相，但拉到高明度
      return {
        back: hslToRgb(hd[0], clamp01(hd[1] * 0.85), 0.62),
        belly: [0.92, 0.97, 1.00],
        rim: [1, 1, 1],
        rimK: 1.55, spec: 0.90, metallic: 0, spin: 1, sparkle: 1
      };
    }
    // 原色 = 该鱼自己的配色对（深色当背、浅色当腹），不套任何统一色。
    // 背 / 腹的**明度差要拉开**：差值太小整条鱼就糊成一片，棱面全看不见
    return {
      back: hslToRgb(hd[0], clamp01(hd[1] * 1.05 + 0.05), clamp01(hd[2] * 0.74)),
      belly: hslToRgb(hl[0], clamp01(hl[1] * 0.60), clamp01(hl[2] * 0.94 + 0.16)),
      rim: hslToRgb(hd[0], 0.16, 0.95),
      rimK: 1.05, spec: 0.14, metallic: 0, spin: 0, sparkle: 0
    };
  }

  /** 直接从 fish.js 的一条鱼取色（字段是 body / accent） */
  function fromFish(fish, morphKey) {
    if (!fish) return palette('#8fa2b0', '#5f7280', morphKey);
    return palette(fish.body || fish.c1, fish.accent || fish.c2, morphKey);
  }

  /** 该档是不是「会闪」——调用方据此决定要不要叠星点 */
  function isSparkly(morphKey) { return morphKey === 'shiny'; }
  /** 该档该不该开动画：口径 = 只有传说档与闪光色开 */
  function shouldAnimate(rar, morphKey, detailForRar) {
    if (morphKey === 'shiny') return true;
    return (detailForRar ? detailForRar(rar) : (rar >= 3 ? 2 : 0)) >= 2;
  }

  return {
    MORPH_KEYS: MORPH_KEYS,
    hexToRgb: hexToRgb,
    palette: palette,
    fromFish: fromFish,
    isSparkly: isSparkly,
    shouldAnimate: shouldAnimate,
    mix: mix
  };
})();
