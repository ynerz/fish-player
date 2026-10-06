/* =========================================================
   fish.js  —  鱼种数据表（共 362 种）
   =========================================================
   ⚠️ 本文件由 tools/gen-fish.py 自动生成，不要手改；
      改鱼名 / 体重 / 价格请改 gen-fish.py，然后重新生成。
      档内权重 w 由 tools/solve-drop.js 反推写入。

   每条鱼 = 品种 × 颜色变异 × 重量 三个状态维度中的「品种」部分。
   字段： id / name / rar(0普1稀2史3传) / shape / body / accent
          minKg / maxKg / price / w(档内权重)
   ========================================================= */
window.G = window.G || {};

(function () {
  var list = [];

  function F(id, name, rar, shape, body, accent, minW, maxW, price, opts) {
    opts = opts || {};
    list.push({
      id: id, name: name, rar: rar,
      shape: shape, body: body, accent: accent,
      minKg: minW, maxKg: maxW, price: price,
      w: opts.w == null ? 1 : opts.w,
      tail:  opts.tail  || 'fan',
      body_ratio: opts.body == null ? 0.34 : opts.body,
      spiny: !!opts.spiny, barbels: !!opts.barbels,
      glow: !!opts.glow, teeth: !!opts.teeth,
      lure: !!opts.lure, stripes: !!opts.stripes, spots: !!opts.spots,
      wx: opts.wx || null, tm: opts.tm || null,
      field: id.slice(0, id.search(/\d/)).replace(/[^A-Za-z]/g, ''),
    });
  }

  /* ===== D · 村口小池塘（16 种：普9 稀4 史2 传1）===== */
  F('D01', '麦穗鱼', 0, 'fish', '#a8bcc9', '#7f95a4', 0.02, 0.08, 3, { w:100, body:0.26 });
  F('D02', '白条', 0, 'fish', '#cfd9e0', '#9fb0bd', 0.05, 0.15, 4, { w:95, body:0.22, tail:"fork" });
  F('D03', '鲫鱼', 0, 'fish', '#b8a67e', '#8f7f5c', 0.10, 0.55, 7, { w:90, body:0.44 });
  F('D04', '泥鳅', 0, 'eel', '#8a7355', '#5f4d38', 0.02, 0.09, 5, { w:85 });
  F('D05', '鳑鲏', 0, 'fish', '#9fb0a8', '#6e8079', 0.01, 0.05, 3, { w:80, body:0.52 });
  F('D06', '食蚊鱼', 0, 'fish', '#c4cdb0', '#93a17c', 0.01, 0.04, 3, { w:76, body:0.30 });
  F('D07', '塘鳢', 0, 'fish', '#b9a3a0', '#8a7472', 0.03, 0.15, 6, { w:72, body:0.36, spots:true });
  F('D08', '小龙虾', 0, 'squid', '#c9b79a', '#9a8a6e', 0.02, 0.12, 7, { w:68 });
  F('D09', '黄颡鱼', 1, 'fish', '#d99a5b', '#b4763c', 0.12, 0.60, 30, { w:100, body:0.32, barbels:true, spiny:true, wx:'cloudy' });
  F('D10', '小鲤鱼', 1, 'fish', '#c9a349', '#8a6b23', 0.30, 1.2, 32, { w:78, body:0.40, barbels:true });
  F('D11', '黄鳝', 1, 'eel', '#8f9c8a', '#5e6b52', 0.10, 0.70, 42, { w:61 });
  F('D12', '青虾虎', 1, 'fish', '#a98d7a', '#7b6253', 0.02, 0.10, 26, { w:48, body:0.30, spots:true });
  F('D13', '金鲫', 2, 'fish', '#f2c14e', '#d99a1f', 0.40, 1.4, 169, { w:100, body:0.46, glow:true, wx:'clear', tm:'night' });
  F('D14', '老塘草鱼', 2, 'fish', '#5c7a68', '#33473d', 3.0, 11.0, 257, { w:33, body:0.34 });
  F('D15', '圆尾斗鱼', 0, 'fish', '#a8bcc9', '#7f95a4', 0.02, 0.10, 6, { w:65, body:0.42, stripes:true });
  F('D16', '塘主的大青鱼', 3, 'fish', '#cfd9e0', '#9fb0bd', 8.0, 26.0, 852, { w:100, body:0.36, tm:'dawn' });

  /* ===== C · 溪流浅滩（24 种：普14 稀6 史3 传1）===== */
  F('C01', '溪哥', 0, 'fish', '#cfd6c8', '#9aa491', 0.02, 0.07, 5, { w:100, body:0.26 });
  F('C02', '马口鱼', 0, 'fish', '#b7cbd8', '#7d97a8', 0.04, 0.12, 8, { w:97, body:0.28, tail:"fork", stripes:true });
  F('C03', '宽鳍鱲', 0, 'fish', '#9fc6dd', '#6a94b0', 0.03, 0.10, 10, { w:93, body:0.30, tail:"fork" });
  F('C04', '拉氏鱥', 0, 'fish', '#a89a80', '#6f6454', 0.02, 0.09, 8, { w:90, body:0.28 });
  F('C05', '中华鳑鲏', 0, 'fish', '#b9c3a8', '#8b9578', 0.01, 0.05, 6, { w:87, body:0.50 });
  F('C06', '小鳈', 0, 'fish', '#c9c0a0', '#9a9070', 0.02, 0.08, 6, { w:84, body:0.28, stripes:true });
  F('C07', '黑鳍鳈', 0, 'fish', '#d3c9b8', '#a79c88', 0.03, 0.12, 8, { w:82, body:0.30, stripes:true });
  F('C08', '棒花鱼', 0, 'fish', '#a5b8a0', '#768a70', 0.02, 0.10, 8, { w:79, body:0.32, spots:true });
  F('C09', '似鮈', 0, 'fish', '#8fa2b0', '#5f7280', 0.03, 0.14, 8, { w:76, body:0.28, barbels:true });
  F('C10', '间下鱵', 0, 'fish', '#c2b184', '#8a7c55', 0.02, 0.08, 10, { w:74, body:0.20, tail:"fork" });
  F('C11', '光唇鱼', 0, 'fish', '#c78f9e', '#8a5f75', 0.05, 0.25, 11, { w:71, body:0.32, stripes:true });
  F('C12', '缨口鳅', 0, 'eel', '#9aa8b8', '#6b7888', 0.02, 0.08, 8, { w:69 });
  F('C13', '花䱻', 1, 'fish', '#b0a890', '#7f7860', 0.15, 0.60, 44, { w:100, body:0.28, spots:true, wx:'clear' });
  F('C14', '虹鳟', 1, 'fish', '#8f9c7d', '#5e6b52', 0.40, 1.6, 64, { w:86, body:0.30, stripes:true, spots:true });
  F('C15', '褐鳟', 1, 'fish', '#dfe3e0', '#a9b3ae', 0.30, 1.4, 60, { w:74, body:0.30, spots:true });
  F('C16', '溪石斑', 1, 'fish', '#e0a58c', '#a86e58', 0.12, 0.45, 72, { w:64, body:0.34, spots:true });
  F('C17', '唇䱻', 1, 'fish', '#c8b8a8', '#96887a', 0.20, 0.90, 55, { w:55, body:0.28, wx:'rain' });
  F('C18', '吻鰕虎', 1, 'fish', '#a8c8d0', '#6f9098', 0.01, 0.04, 41, { w:48, body:0.30 });
  F('C19', '白甲鱼', 2, 'fish', '#c0c8b8', '#8e988a', 1.2, 3.6, 301, { w:100, body:0.32, tm:'dusk' });
  F('C20', '山女鳟', 2, 'fish', '#d8c8b0', '#a89880', 0.60, 2.2, 355, { w:58, body:0.30, stripes:true, spots:true });
  F('C21', '台湾铲颌鱼', 2, 'fish', '#b8c0a0', '#88906e', 0.40, 1.6, 332, { w:33, body:0.30, barbels:true, wx:'fog' });
  F('C22', '中华刺鳅', 0, 'eel', '#f0d489', '#c9a13d', 0.03, 0.16, 10, { w:67 });
  F('C23', '福建小鳔鮈', 0, 'fish', '#cfd6c8', '#9aa491', 0.02, 0.09, 8, { w:65, body:0.30 });
  F('C24', '溪灵·金线鲃', 3, 'fish', '#b7cbd8', '#7d97a8', 0.30, 1.1, 1533, { w:100, body:0.30, glow:true, barbels:true });

  /* ===== B · 湖心半岛（34 种：普17 稀9 史6 传2）===== */
  F('B01', '鲢鱼', 0, 'fish', '#c8d2d6', '#93a1a8', 1.0, 4.5, 11, { w:100, body:0.40 });
  F('B02', '鳙鱼', 0, 'fish', '#9aa7ae', '#6b7880', 1.2, 5.0, 12, { w:97, body:0.42 });
  F('B03', '草鱼', 0, 'fish', '#97a878', '#5f7048', 1.5, 7.0, 15, { w:95, body:0.34 });
  F('B04', '鲮鱼', 0, 'fish', '#b9bcae', '#878b7f', 0.30, 1.6, 9, { w:92, body:0.34 });
  F('B05', '罗非鱼', 0, 'fish', '#8fa2a0', '#5c6e6d', 0.20, 1.2, 8, { w:90, body:0.44, spiny:true });
  F('B06', '鳊鱼', 0, 'fish', '#c4c0a8', '#948f7a', 0.30, 1.8, 10, { w:87, body:0.52 });
  F('B07', '鲂鱼', 0, 'fish', '#a8b2a0', '#78816e', 0.35, 2.0, 11, { w:85, body:0.50 });
  F('B08', '银鲴', 0, 'fish', '#b0b8c0', '#828a94', 0.10, 0.60, 8, { w:83, body:0.36 });
  F('B09', '黄尾鲴', 0, 'fish', '#c8bfa0', '#98906f', 0.15, 0.80, 9, { w:80, body:0.36 });
  F('B10', '赤眼鳟', 0, 'fish', '#9cb0a8', '#6d8078', 0.40, 2.5, 13, { w:78, body:0.32, tail:"fork" });
  F('B11', '大眼华鳊', 0, 'fish', '#b8a890', '#8a7a60', 0.20, 1.0, 10, { w:76, body:0.48 });
  F('B12', '似鳊', 0, 'fish', '#a0b0b8', '#748a94', 0.25, 1.2, 9, { w:74, body:0.48 });
  F('B13', '中华细鲫', 0, 'fish', '#c8b8b0', '#988c84', 0.05, 0.25, 7, { w:72, body:0.28 });
  F('B14', '麦鲮', 0, 'fish', '#98a890', '#6c7c66', 0.50, 2.8, 12, { w:70, body:0.34 });
  F('B15', '鲈鲤', 0, 'fish', '#d0c8b8', '#9c9484', 0.60, 3.2, 16, { w:68, body:0.36, spiny:true });
  F('B16', '鲤鱼', 1, 'fish', '#d99a5b', '#a86f33', 1.5, 7.5, 58, { w:100, body:0.40, barbels:true });
  F('B17', '鲈鱼', 1, 'fish', '#a3ac86', '#66703f', 0.60, 2.8, 70, { w:91, body:0.36, spiny:true, spots:true, wx:'rain' });
  F('B18', '翘嘴鲌', 1, 'fish', '#d5dde2', '#9caab4', 0.80, 3.6, 75, { w:83, body:0.24, glow:true });
  F('B19', '蒙古鲌', 1, 'fish', '#6b6f5e', '#3c4034', 0.50, 2.4, 63, { w:76, body:0.26 });
  F('B20', '黑鱼', 1, 'fish', '#c0c8b0', '#8e967c', 1.0, 5.5, 82, { w:69, body:0.30, spots:true, teeth:true });
  F('B21', '鳡鱼', 1, 'fish', '#b8c0c8', '#88909c', 2.0, 9.0, 93, { w:63, body:0.26, teeth:true, wx:'fog' });
  F('B22', '鲶鱼', 1, 'fish', '#8fa0a8', '#5f7078', 1.0, 6.0, 66, { w:57, body:0.30, barbels:true });
  F('B23', '青鱼', 1, 'fish', '#c8c0b8', '#968e86', 3.0, 14.0, 87, { w:52, body:0.34 });
  F('B24', '刺鲃', 1, 'fish', '#a8a8b0', '#787880', 0.80, 4.0, 73, { w:48, body:0.36, barbels:true });
  F('B25', '大口鲶', 2, 'fish', '#d0c0a0', '#9c8c6c', 4.0, 18.0, 355, { w:100, body:0.30, barbels:true, wx:'cloudy', tm:'night' });
  F('B26', '鳜鱼', 2, 'fish', '#7d7a6b', '#4a483d', 1.0, 4.5, 421, { w:80, body:0.42, spiny:true, stripes:true });
  F('B27', '大眼鳜', 2, 'fish', '#c9b183', '#8d7748', 0.60, 2.6, 376, { w:64, body:0.44, spiny:true, spots:true });
  F('B28', '长吻鮠', 2, 'fish', '#9aa8b0', '#6a787f', 1.5, 6.5, 321, { w:52, body:0.28, barbels:true, tm:'dawn' });
  F('B29', '中华倒刺鲃', 2, 'fish', '#e0d8c8', '#a8a090', 1.2, 5.5, 344, { w:42, body:0.36, barbels:true, wx:'clear' });
  F('B30', '胭脂鱼', 2, 'fish', '#b0a890', '#807860', 2.0, 10.0, 466, { w:33, body:0.44, glow:true });
  F('B31', '银鮈', 0, 'fish', '#c8b0a0', '#907860', 0.05, 0.30, 9, { w:66, body:0.32 });
  F('B32', '短颌鲚', 0, 'fish', '#e8b45c', '#b87a20', 0.05, 0.35, 9, { w:65, body:0.22, tail:"fork" });
  F('B33', '湖心巨鲤', 3, 'fish', '#c8d2d6', '#93a1a8', 12.0, 38.0, 1641, { w:100, body:0.42, barbels:true, glow:true, wx:'rain' });
  F('B34', '百斤鳡王', 3, 'fish', '#9aa7ae', '#6b7880', 20.0, 52.0, 1902, { w:22, body:0.26, teeth:true, glow:true, tm:'day' });

  /* ===== A · 深海断崖（46 种：普22 稀13 史8 传3）===== */
  F('A01', '沙丁鱼', 0, 'fish', '#b9cbd6', '#8497a4', 0.03, 0.12, 11, { w:100, body:0.26 });
  F('A02', '竹荚鱼', 0, 'fish', '#9fb6c2', '#6c8695', 0.10, 0.45, 15, { w:98, body:0.28 });
  F('A03', '黑鲷', 0, 'fish', '#6c7480', '#414a55', 0.40, 2.2, 27, { w:96, body:0.46, spiny:true });
  F('A04', '黄鳍鲷', 0, 'fish', '#c4b481', '#8d7c4c', 0.40, 2.4, 31, { w:94, body:0.46, spiny:true });
  F('A05', '鲻鱼', 0, 'fish', '#a7b3b8', '#75828a', 0.50, 2.8, 23, { w:92, body:0.30 });
  F('A06', '石斑鱼', 0, 'fish', '#8d8471', '#5b5443', 1.0, 6.0, 40, { w:90, body:0.42, spots:true });
  F('A07', '银鲳', 0, 'fish', '#c8ccd0', '#939aa0', 0.30, 1.5, 29, { w:88, body:0.62 });
  F('A08', '刺鲳', 0, 'fish', '#b0bcc4', '#7c8a94', 0.25, 1.2, 25, { w:86, body:0.60 });
  F('A09', '鳀鱼', 0, 'fish', '#d0d8dc', '#9aa4ac', 0.02, 0.09, 11, { w:85, body:0.24 });
  F('A10', '小黄鱼', 0, 'fish', '#a8b8c0', '#748490', 0.10, 0.50, 21, { w:83, body:0.32 });
  F('A11', '梅童鱼', 0, 'fish', '#c9c0a8', '#958c74', 0.05, 0.25, 17, { w:81, body:0.34 });
  F('A12', '黄姑鱼', 0, 'fish', '#98a4ac', '#687580', 0.30, 1.6, 25, { w:79, body:0.34 });
  F('A13', '白姑鱼', 0, 'fish', '#d8d0c0', '#a49c8c', 0.25, 1.4, 23, { w:78, body:0.34 });
  F('A14', '海鳗', 0, 'eel', '#b8c4c8', '#84909a', 0.50, 3.0, 32, { w:76 });
  F('A15', '星鳗', 0, 'eel', '#8c98a0', '#5c6870', 0.20, 1.2, 29, { w:75, spots:true });
  F('A16', '鲽鱼', 0, 'fish', '#d0c0b0', '#9c8c7c', 0.20, 1.1, 24, { w:73, body:0.60, spots:true });
  F('A17', '舌鳎', 0, 'fish', '#a0b0a8', '#708078', 0.15, 0.80, 22, { w:72, body:0.55 });
  F('A18', '六线鱼', 0, 'fish', '#c0b8a8', '#8c8474', 0.20, 1.0, 26, { w:70, body:0.40, spots:true });
  F('A19', '黑鲪', 0, 'fish', '#9cb0c0', '#6c8090', 0.25, 1.3, 28, { w:69, body:0.38, spiny:true });
  F('A20', '赤点石斑', 0, 'fish', '#c8d0d8', '#94a0aa', 0.60, 3.5, 36, { w:67, body:0.42, spots:true });
  F('A21', '真鲷', 1, 'fish', '#d98f96', '#a55c66', 1.0, 5.0, 140, { w:100, body:0.48, spiny:true, wx:'fog' });
  F('A22', '海鲈', 1, 'fish', '#b3bec4', '#7f8b93', 1.5, 8.0, 156, { w:94, body:0.34, spiny:true });
  F('A23', '鲯鳅', 1, 'fish', '#6fc0c4', '#3b8a94', 2.0, 11.0, 185, { w:88, body:0.28, glow:true });
  F('A24', '章鱼', 1, 'squid', '#a97c86', '#7a4f5c', 0.80, 6.0, 172, { w:83 });
  F('A25', '马鲛', 1, 'fish', '#8fa0b0', '#5f7080', 1.2, 7.0, 166, { w:78, body:0.28, teeth:true, wx:'cloudy' });
  F('A26', '蓝点马鲛', 1, 'fish', '#c0a888', '#8c7458', 1.5, 9.0, 187, { w:73, body:0.28, spots:true, teeth:true });
  F('A27', '大黄鱼', 1, 'fish', '#a0b8c0', '#708890', 0.50, 3.0, 196, { w:69, body:0.34, glow:true });
  F('A28', '鮸鱼', 1, 'fish', '#d0b8a8', '#9c8474', 2.0, 10.0, 178, { w:65, body:0.34 });
  F('A29', '牙鲆', 1, 'fish', '#7f9bb8', '#45627f', 1.0, 6.0, 160, { w:61, body:0.58, spots:true, wx:'clear' });
  F('A30', '许氏平鲉', 1, 'fish', '#6f8fb5', '#2f4d70', 0.50, 2.5, 152, { w:57, body:0.42, spiny:true });
  F('A31', '鬼鲉', 1, 'fish', '#8a7f66', '#4f4636', 0.60, 3.2, 199, { w:54, body:0.46, spiny:true, spots:true });
  F('A32', '鲬鱼', 1, 'fish', '#b0c0c8', '#8090a0', 0.40, 2.0, 145, { w:51, body:0.30, spiny:true });
  F('A33', '鱿鱼', 1, 'squid', '#c8c0b0', '#98907c', 0.20, 1.5, 164, { w:48, glow:true, wx:'rain' });
  F('A34', '金枪鱼', 2, 'fish', '#a8b0a0', '#788070', 15.0, 90.0, 595, { w:100, body:0.38, glow:true, tm:'day' });
  F('A35', '旗鱼', 2, 'fish', '#98a8b0', '#687880', 25.0, 140.0, 729, { w:85, body:0.26 });
  F('A36', '剑鱼', 2, 'fish', '#c0ccd4', '#8c98a0', 30.0, 180.0, 787, { w:73, body:0.24, teeth:true });
  F('A37', '龙趸石斑', 2, 'fish', '#b8a890', '#88785c', 40.0, 180.0, 845, { w:62, body:0.44, spots:true, wx:'fog', tm:'night' });
  F('A38', '宝石石斑', 2, 'fish', '#a0a8b8', '#707888', 20.0, 90.0, 691, { w:53, body:0.44, spots:true, glow:true });
  F('A39', '河鲀', 2, 'fish', '#d0d0c8', '#9c9c94', 0.50, 3.0, 538, { w:46, body:0.78, spiny:true });
  F('A40', '翻车鱼', 2, 'fish', '#8c9098', '#5c6068', 60.0, 300.0, 902, { w:39, body:0.86, tm:'dawn' });
  F('A41', '角箱鲀', 2, 'fish', '#c8b8c0', '#988890', 0.30, 2.0, 500, { w:33, body:0.70, spiny:true, wx:'cloudy' });
  F('A42', '斑鰶', 0, 'fish', '#b0a0a8', '#807078', 0.10, 0.50, 19, { w:66, body:0.34, spots:true });
  F('A43', '日本鳀', 0, 'fish', '#6e6550', '#332d22', 0.02, 0.10, 11, { w:65, body:0.24 });
  F('A44', '断崖之王·巨型石斑', 3, 'fish', '#3f5f8f', '#8fb8e0', 120.0, 420.0, 2747, { w:100, body:0.46, spots:true });
  F('A45', '黑潮之王·蓝鳍金枪', 3, 'fish', '#b9cbd6', '#8497a4', 180.0, 620.0, 3607, { w:47, body:0.40, glow:true, wx:'clear' });
  F('A46', '白浪之神·大青针', 3, 'fish', '#9fb6c2', '#6c8695', 90.0, 260.0, 3091, { w:22, body:0.24, glow:true, teeth:true, tm:'day' });

  /* ===== S · 幽蓝海沟（62 种：普30 稀18 史9 传5）===== */
  F('S01', '深海鳕', 0, 'fish', '#a8b0ad', '#6e7876', 0.50, 3.5, 35, { w:100, body:0.34 });
  F('S02', '灯笼鱼', 0, 'fish', '#5c6b7d', '#2e3742', 0.02, 0.12, 40, { w:99, body:0.36, glow:true });
  F('S03', '鼬鳚', 0, 'fish', '#8b8398', '#585070', 0.10, 0.70, 32, { w:97, body:0.26 });
  F('S04', '银斧鱼', 0, 'fish', '#c3ced6', '#8b98a3', 0.02, 0.10, 44, { w:96, body:0.62, glow:true });
  F('S05', '帆蜥鱼', 0, 'fish', '#7b8592', '#4a5560', 0.30, 1.8, 50, { w:94, body:0.24, teeth:true });
  F('S06', '深海鲷', 0, 'fish', '#c98a7a', '#8a5148', 0.80, 4.0, 46, { w:93, body:0.46, spiny:true });
  F('S07', '管眼鱼', 0, 'fish', '#6f9a8f', '#c8f2e0', 0.05, 0.40, 42, { w:91, body:0.60, glow:true });
  F('S08', '幽灵鳍鱼', 0, 'fish', '#5a6a7a', '#2e3a48', 0.30, 1.4, 48, { w:90, body:0.30, glow:true });
  F('S09', '黑叉齿鱼', 0, 'fish', '#8a96a4', '#5a6672', 0.10, 0.60, 46, { w:89, body:0.30, teeth:true });
  F('S10', '尖牙鱼', 0, 'fish', '#7a8896', '#4a5662', 0.05, 0.30, 51, { w:87, body:0.34, teeth:true });
  F('S11', '后肛鱼', 0, 'fish', '#6b7a88', '#3b4a58', 0.06, 0.35, 44, { w:86, body:0.36, glow:true });
  F('S12', '深海狗母鱼', 0, 'fish', '#98a4b0', '#687480', 0.08, 0.50, 40, { w:85, body:0.28 });
  F('S13', '囊鳃鳗', 0, 'eel', '#5f6f7d', '#2f3f4d', 0.05, 0.40, 42, { w:83, glow:true });
  F('S14', '深海鳐', 0, 'ray', '#a0a8b4', '#707884', 0.80, 5.0, 50, { w:82 });
  F('S15', '深海鲽', 0, 'fish', '#8494a0', '#546470', 0.30, 1.8, 42, { w:81, body:0.58, spots:true });
  F('S16', '灯塔水母', 0, 'jelly', '#6a7886', '#3a4856', 0.01, 0.10, 46, { w:80, glow:true });
  F('S17', '深海水母', 0, 'jelly', '#7a6b5c', '#463c32', 0.05, 0.60, 48, { w:79, glow:true });
  F('S18', '栉水母', 0, 'jelly', '#9a8a9a', '#6a5a6a', 0.02, 0.20, 53, { w:77, glow:true });
  F('S19', '海猪', 0, 'jelly', '#5d7a88', '#2d4a58', 0.10, 0.90, 38, { w:76 });
  F('S20', '海蛇尾', 0, 'eel', '#8798a6', '#576876', 0.02, 0.15, 35, { w:75 });
  F('S21', '巨型等足虫', 0, 'squid', '#7f8a96', '#4f5a66', 0.05, 0.60, 44, { w:74 });
  F('S22', '管虫', 0, 'eel', '#6d7c8a', '#3d4c5a', 0.02, 0.20, 40, { w:73 });
  F('S23', '深海虾虎', 0, 'fish', '#95a0ac', '#65707c', 0.03, 0.20, 38, { w:72, body:0.30, spots:true });
  F('S24', '无光鳕', 0, 'fish', '#5b6b79', '#2b3b49', 0.40, 2.8, 42, { w:71, body:0.32 });
  F('S25', '鮟鱇鱼', 1, 'fish', '#7a6b5c', '#463c32', 1.0, 9.0, 237, { w:100, body:0.52, teeth:true, lure:true, wx:'cloudy' });
  F('S26', '角鮟鱇', 1, 'fish', '#8f7a8a', '#5f4a5a', 0.60, 6.0, 256, { w:96, body:0.52, teeth:true, lure:true });
  F('S27', '树须鱼', 1, 'fish', '#c8d0d8', '#98a0a8', 0.30, 3.0, 262, { w:92, body:0.50, teeth:true, lure:true });
  F('S28', '深海章鱼', 1, 'squid', '#7d2f3f', '#4a1220', 2.0, 16.0, 286, { w:88 });
  F('S29', '吸血乌贼', 1, 'squid', '#8d8674', '#554f40', 0.50, 3.0, 323, { w:84, glow:true, wx:'clear' });
  F('S30', '幽灵蛸', 1, 'squid', '#66707a', '#36404a', 0.60, 4.0, 302, { w:80, glow:true });
  F('S31', '皱鳃鲨', 1, 'shark', '#8f7f6a', '#5f4f3a', 3.0, 12.0, 390, { w:77, body:0.24 });
  F('S32', '雪茄达摩鲨', 1, 'shark', '#6a5a7a', '#3a2a4a', 0.20, 1.5, 354, { w:74, body:0.28, teeth:true });
  F('S33', '六鳃鲨', 1, 'shark', '#b0b8c0', '#808890', 5.0, 20.0, 378, { w:71, body:0.26, wx:'rain' });
  F('S34', '深海龙鱼', 1, 'fish', '#7a6a7a', '#4a3a4a', 0.10, 1.2, 329, { w:68, body:0.30, teeth:true, glow:true });
  F('S35', '深海银鲛', 1, 'fish', '#5d6b7a', '#2d3b4a', 1.0, 5.0, 311, { w:65, body:0.34, glow:true });
  F('S36', '单棘魨', 1, 'fish', '#96889a', '#66586a', 0.30, 2.0, 293, { w:62, body:0.70, spiny:true });
  F('S37', '蓝环章鱼', 1, 'squid', '#8a7a6a', '#5a4a3a', 0.05, 0.60, 366, { w:59, glow:true, spots:true, wx:'fog' });
  F('S38', '巨口鳗', 1, 'eel', '#6f7f8f', '#3f4f5f', 1.0, 7.0, 342, { w:57, teeth:true });
  F('S39', '黑柔骨鱼', 1, 'fish', '#a0a8b0', '#707880', 0.20, 1.6, 317, { w:54, body:0.34, teeth:true });
  F('S40', '深海水母王', 1, 'jelly', '#5a6a72', '#2a3a42', 1.0, 9.0, 359, { w:52, glow:true });
  F('S41', '皇带鱼', 2, 'oarfish', '#7d8a96', '#4d5a66', 8.0, 45.0, 571, { w:100, glow:true, wx:'cloudy' });
  F('S42', '巨口鲨', 2, 'shark', '#8a94a0', '#5a6470', 80.0, 350.0, 945, { w:87, body:0.30 });
  F('S43', '格陵兰鲨', 2, 'shark', '#c0705f', '#7c3f33', 100.0, 500.0, 1033, { w:76, body:0.30, tm:'dusk' });
  F('S44', '大王酸浆鱿', 2, 'squid', '#cfd8dd', '#9aa6ad', 150.0, 500.0, 1297, { w:66, glow:true });
  F('S45', '小头睡鲨', 2, 'shark', '#7f7a86', '#4a4550', 120.0, 600.0, 1077, { w:58, body:0.30, wx:'clear' });
  F('S46', '太平洋睡鲨', 2, 'shark', '#6b7280', '#3b414b', 90.0, 450.0, 1011, { w:50, body:0.30, spots:true, tm:'day' });
  F('S47', '尖吻鲭鲨', 2, 'shark', '#8f9aa8', '#5a6472', 60.0, 300.0, 978, { w:44, body:0.26, teeth:true });
  F('S48', '深海巨型鳐', 2, 'ray', '#5f6a76', '#2f3a46', 80.0, 400.0, 1033, { w:38, glow:true });
  F('S49', '北极霞水母', 2, 'jelly', '#8a8070', '#5a5040', 20.0, 120.0, 1120, { w:33, glow:true, wx:'rain', tm:'night' });
  F('S50', '深海鳚', 0, 'fish', '#6d6a7a', '#3d3a4a', 0.05, 0.40, 38, { w:70, body:0.28 });
  F('S51', '黑口鱼', 0, 'fish', '#7a7a8a', '#4a4a5a', 0.08, 0.55, 40, { w:69, body:0.34, teeth:true });
  F('S52', '巨尾鱼', 0, 'fish', '#9aa0a8', '#6a7078', 0.10, 0.80, 42, { w:68, body:0.30, glow:true });
  F('S53', '褶胸鱼', 0, 'fish', '#6a5a8f', '#2f2650', 0.03, 0.25, 39, { w:66, body:0.36, glow:true });
  F('S54', '孔灯鱼', 0, 'fish', '#2f3a55', '#7f8fc0', 0.02, 0.18, 41, { w:65, body:0.34, glow:true });
  F('S55', '大鳍后肛鱼', 0, 'fish', '#a8b0ad', '#6e7876', 0.06, 0.42, 43, { w:65, body:0.38, glow:true });
  F('S56', '狼牙鲷', 1, 'fish', '#5c6b7d', '#2e3742', 0.80, 5.0, 300, { w:50, body:0.46, spiny:true, teeth:true });
  F('S57', '角高体金眼鲷', 1, 'fish', '#8b8398', '#585070', 0.40, 2.6, 277, { w:48, body:0.52, spiny:true, wx:'cloudy' });
  F('S58', '海沟幽灵·大王乌贼', 3, 'squid', '#c3ced6', '#8b98a3', 200.0, 700.0, 3922, { w:100, glow:true, tm:'day' });
  F('S59', '海沟幽魂·无光鲸', 3, 'whale', '#7b8592', '#4a5560', 900.0, 3600.0, 4857, { w:68, glow:true, wx:'fog' });
  F('S60', '海沟之主·深渊巨鲨', 3, 'shark', '#c98a7a', '#8a5148', 300.0, 1200.0, 4483, { w:47, body:0.30, glow:true, teeth:true });
  F('S61', '幽蓝海心·鬼灯笼', 3, 'fish', '#6f9a8f', '#c8f2e0', 5.0, 40.0, 4110, { w:32, body:0.52, teeth:true, lure:true, glow:true, wx:'clear', tm:'night' });
  F('S62', '海沟终焉·原始巨口鲨', 3, 'shark', '#5a6a7a', '#2e3a48', 500.0, 2000.0, 5231, { w:22, body:0.34, glow:true, teeth:true });

  /* ===== SS · 星陨之渊（80 种：普38 稀22 史14 传6）===== */
  F('SS01', '星磷鱼', 0, 'fish', '#3f5a9c', '#7ea2ff', 0.10, 0.70, 62, { w:100, body:0.30, glow:true });
  F('SS02', '陨铁鲷', 0, 'fish', '#5b6172', '#2f3444', 0.80, 4.0, 71, { w:99, body:0.46, spiny:true });
  F('SS03', '真空鳐', 0, 'ray', '#4a4f8a', '#8f96e0', 1.5, 9.0, 84, { w:98, glow:true });
  F('SS04', '深海星鳗', 0, 'eel', '#4d5a86', '#8b9be0', 0.60, 3.0, 76, { w:97, glow:true });
  F('SS05', '冷光鮟鱇', 0, 'fish', '#3d4260', '#6f7fc0', 2.0, 14.0, 97, { w:95, body:0.52, teeth:true, lure:true, glow:true });
  F('SS06', '幽蓝水母', 0, 'jelly', '#5c8fd6', '#bde4ff', 0.50, 4.0, 91, { w:94, glow:true });
  F('SS07', '陨尘鲳', 0, 'fish', '#8f8fa8', '#d6d6f0', 0.40, 2.5, 83, { w:93, body:0.58, glow:true });
  F('SS08', '暗星鲷', 0, 'fish', '#6a7aa8', '#a8b8f0', 1.2, 6.0, 91, { w:92, body:0.48, spiny:true, glow:true });
  F('SS09', '星尘鳀', 0, 'fish', '#7a86b8', '#c0c8f8', 0.05, 0.30, 69, { w:91, body:0.24, glow:true });
  F('SS10', '陨砾鲹', 0, 'fish', '#5f6a9a', '#9faef0', 0.30, 1.8, 75, { w:90, body:0.30, glow:true });
  F('SS11', '星纹鲷', 0, 'fish', '#4a5a8f', '#8fa8ff', 0.90, 4.5, 80, { w:89, body:0.46, stripes:true, glow:true });
  F('SS12', '陨星鲈', 0, 'fish', '#6b5f9a', '#b0a0f0', 1.0, 5.0, 86, { w:88, body:0.36, spiny:true, glow:true });
  F('SS13', '微光鳕', 0, 'fish', '#5568a0', '#98b0ff', 0.70, 4.0, 72, { w:87, body:0.34, glow:true });
  F('SS14', '星屑鰕虎', 0, 'fish', '#7f8bb8', '#c8d0ff', 0.10, 0.60, 65, { w:86, body:0.30, spots:true, glow:true });
  F('SS15', '陨砂鳉', 0, 'fish', '#5a6890', '#93a8e8', 0.04, 0.20, 63, { w:85, body:0.28, glow:true });
  F('SS16', '幽星鲽', 0, 'fish', '#4f5f8a', '#88a0e0', 0.60, 3.5, 77, { w:84, body:0.58, spots:true, glow:true });
  F('SS17', '星尘水母', 0, 'jelly', '#6a80b0', '#a8c0ff', 0.30, 2.0, 87, { w:83, glow:true });
  F('SS18', '陨石鳃', 0, 'fish', '#8a90c0', '#d0d8ff', 0.50, 3.0, 79, { w:82, body:0.36, glow:true });
  F('SS19', '夜辉鳗', 0, 'eel', '#5c6aa8', '#9fb0ff', 0.40, 2.4, 82, { w:81, glow:true });
  F('SS20', '碎星魟', 0, 'ray', '#7080a8', '#b0c0f8', 1.0, 6.0, 88, { w:80, glow:true });
  F('SS21', '寂静鲳', 0, 'fish', '#3b3a6b', '#7d7cc4', 0.50, 3.2, 76, { w:79, body:0.60, glow:true });
  F('SS22', '霜鳞鲑', 0, 'fish', '#454a63', '#7e86a8', 0.80, 6.0, 84, { w:78, body:0.32, spots:true, glow:true });
  F('SS23', '幻影鲽', 0, 'fish', '#4a3f8f', '#a08fff', 0.40, 2.6, 80, { w:77, body:0.56, glow:true });
  F('SS24', '星屑海马', 0, 'fish', '#2f2f5f', '#8f8fff', 0.02, 0.15, 66, { w:76, body:0.62, glow:true });
  F('SS25', '陨光鮟鱇', 0, 'fish', '#3a4a8f', '#a8c0ff', 0.90, 6.0, 92, { w:75, body:0.50, lure:true, glow:true });
  F('SS26', '幽蓝鳞鲀', 0, 'fish', '#4a4a6a', '#9090c0', 0.30, 1.8, 74, { w:74, body:0.72, spiny:true, glow:true });
  F('SS27', '星砂鲽', 0, 'fish', '#3f4f7f', '#8fa8e8', 0.35, 2.2, 77, { w:73, body:0.58, spots:true, glow:true });
  F('SS28', '陨纹金枪', 0, 'fish', '#5a5a8a', '#a8a8e0', 3.0, 20.0, 109, { w:73, body:0.38, stripes:true, glow:true });
  F('SS29', '夜穹旗鱼', 0, 'fish', '#5560b0', '#a8b4ff', 5.0, 30.0, 114, { w:72, body:0.26, glow:true });
  F('SS30', '星耀鲹', 0, 'fish', '#6a3fb0', '#c9a8ff', 0.60, 4.0, 83, { w:71, body:0.30, glow:true });
  F('SS31', '虚空鳗', 1, 'eel', '#9fb4ff', '#e0e8ff', 1.5, 9.0, 611, { w:100, glow:true, teeth:true });
  F('SS32', '陨光海蛇', 1, 'eel', '#383d5c', '#6d7699', 12.0, 60.0, 530, { w:97, glow:true, teeth:true });
  F('SS33', '星云鳐', 1, 'ray', '#4a4f7d', '#98a0d6', 5.0, 30.0, 570, { w:93, glow:true, wx:'rain' });
  F('SS34', '渊影鲛', 1, 'shark', '#3c4a7a', '#7f93d6', 20.0, 110.0, 638, { w:90, body:0.26, glow:true });
  F('SS35', '深星章鱼', 1, 'squid', '#4a5a7a', '#8fa0d0', 4.0, 25.0, 557, { w:87, glow:true });
  F('SS36', '陨落灯笼', 1, 'fish', '#3a4a6a', '#7f90c0', 1.0, 7.0, 598, { w:84, body:0.52, lure:true, teeth:true, glow:true });
  F('SS37', '星蚀鲷', 1, 'fish', '#2f3f6f', '#7f90e0', 2.0, 11.0, 541, { w:81, body:0.48, spiny:true, spots:true, glow:true, wx:'fog' });
  F('SS38', '虚时鲳', 1, 'fish', '#4a3a7a', '#a090e0', 1.5, 9.0, 514, { w:78, body:0.60, glow:true });
  F('SS39', '碎陨皇带', 1, 'oarfish', '#3f5f9e', '#8fc0ff', 6.0, 36.0, 635, { w:75, glow:true });
  F('SS40', '星纱水母', 1, 'jelly', '#3f4a6f', '#8f9fd0', 2.0, 12.0, 533, { w:73, glow:true });
  F('SS41', '幽暗龙鱼', 1, 'dragon', '#554a8a', '#b0a0ff', 2.0, 14.0, 661, { w:70, glow:true, teeth:true, wx:'cloudy' });
  F('SS42', '陨核鲽', 1, 'fish', '#3a3a6a', '#8a8ac0', 1.2, 8.0, 519, { w:68, body:0.58, spots:true, glow:true });
  F('SS43', '虚光鮟鱇', 1, 'fish', '#4a5a90', '#90a8f0', 3.0, 18.0, 622, { w:65, body:0.54, lure:true, teeth:true, glow:true });
  F('SS44', '暗物质魟', 1, 'ray', '#2f4a7f', '#80a0e0', 8.0, 45.0, 695, { w:63, glow:true });
  F('SS45', '星陨鳐', 1, 'ray', '#5a4a9a', '#b8a8ff', 6.0, 34.0, 587, { w:61, glow:true, wx:'clear' });
  F('SS46', '虚空鲛', 1, 'shark', '#3f3f7f', '#8f8fdf', 15.0, 80.0, 677, { w:59, body:0.28, glow:true, teeth:true });
  F('SS47', '陨星鲟', 1, 'fish', '#4a6a9a', '#90b8f0', 10.0, 60.0, 650, { w:57, body:0.38, spiny:true, glow:true });
  F('SS48', '星屑章鱼', 1, 'squid', '#3a5a8a', '#80a8e8', 2.0, 14.0, 527, { w:55, glow:true, spots:true });
  F('SS49', '星陨旗鱼', 2, 'fish', '#7a3fd6', '#e0c9ff', 60.0, 260.0, 1070, { w:100, body:0.26, glow:true, wx:'rain', tm:'night' });
  F('SS50', '星核龙鱼', 2, 'dragon', '#b8c4ff', '#ffffff', 8.0, 40.0, 1365, { w:92, glow:true });
  F('SS51', '裂空皇带鱼', 2, 'oarfish', '#c8d6ff', '#ffffff', 60.0, 320.0, 1289, { w:84, glow:true });
  F('SS52', '渊眼巨鲨', 2, 'shark', '#1f1f4f', '#b0a0ff', 300.0, 1400.0, 1550, { w:78, body:0.32, glow:true, tm:'dawn' });
  F('SS53', '陨落鲸', 2, 'whale', '#2f2f5f', '#9f9fff', 800.0, 4000.0, 1801, { w:71, glow:true, wx:'fog' });
  F('SS54', '原初海蛇', 2, 'eel', '#3f3f6f', '#afafff', 40.0, 200.0, 1289, { w:66, glow:true, teeth:true });
  F('SS55', '星陨巨鱿', 2, 'squid', '#4a4a8a', '#bfbfff', 200.0, 900.0, 1508, { w:60, glow:true, tm:'dusk' });
  F('SS56', '虚空水母王', 2, 'jelly', '#2a2a5a', '#8f8fdf', 50.0, 260.0, 1223, { w:55, glow:true });
  F('SS57', '陨铁巨口鲨', 2, 'shark', '#5a5a9a', '#c0c0ff', 400.0, 1800.0, 1616, { w:51, body:0.32, glow:true, teeth:true, wx:'cloudy' });
  F('SS58', '星蚀鳐王', 2, 'ray', '#3a3a7a', '#9a9adf', 150.0, 700.0, 1419, { w:47, glow:true, tm:'day' });
  F('SS59', '陨光海龙', 2, 'dragon', '#4f4f8f', '#afaff0', 20.0, 110.0, 1474, { w:43, glow:true, teeth:true });
  F('SS60', '陨铁鲹', 0, 'fish', '#2f3f5f', '#8f9fcf', 0.25, 1.6, 70, { w:70, body:0.30, glow:true });
  F('SS61', '星脉鳉', 0, 'fish', '#3f4f6f', '#9fafdf', 0.03, 0.18, 64, { w:69, body:0.28, glow:true });
  F('SS62', '虚空鲽', 0, 'fish', '#4a5a7f', '#a0b0e0', 0.45, 2.8, 79, { w:68, body:0.58, glow:true });
  F('SS63', '幽蓝鳀', 0, 'fish', '#35406a', '#8f9fd0', 0.04, 0.26, 67, { w:68, body:0.24, glow:true });
  F('SS64', '星屑鲱', 0, 'fish', '#5a6a9a', '#b0c0f0', 0.06, 0.34, 66, { w:67, body:0.26, glow:true });
  F('SS65', '陨砂鲈', 0, 'fish', '#3f5a9c', '#7ea2ff', 1.1, 5.5, 87, { w:66, body:0.36, spiny:true, glow:true });
  F('SS66', '微弱鲳', 0, 'fish', '#5b6172', '#2f3444', 0.55, 3.4, 77, { w:65, body:0.60, glow:true });
  F('SS67', '暗礁鲷', 0, 'fish', '#4a4f8a', '#8f96e0', 0.95, 4.8, 82, { w:65, body:0.46, spiny:true, glow:true });
  F('SS68', '星陨鳗', 1, 'eel', '#4d5a86', '#8b9be0', 2.0, 12.0, 579, { w:53, glow:true });
  F('SS69', '陨落魟', 1, 'ray', '#3d4260', '#6f7fc0', 7.0, 38.0, 627, { w:51, glow:true, wx:'fog' });
  F('SS70', '虚空鲳', 1, 'fish', '#5c8fd6', '#bde4ff', 1.8, 10.0, 549, { w:49, body:0.60, glow:true });
  F('SS71', '星蚀鰕虎', 1, 'fish', '#8f8fa8', '#d6d6f0', 0.20, 1.3, 511, { w:48, body:0.30, spots:true, glow:true });
  F('SS72', '陨铁巨鲛', 2, 'shark', '#6a7aa8', '#a8b8f0', 250.0, 1100.0, 1659, { w:39, body:0.30, glow:true, teeth:true });
  F('SS73', '星核皇带', 2, 'oarfish', '#7a86b8', '#c0c8f8', 80.0, 420.0, 1398, { w:36, glow:true, wx:'cloudy', tm:'night' });
  F('SS74', '幽蓝巨魟', 2, 'ray', '#5f6a9a', '#9faef0', 180.0, 850.0, 1484, { w:33, glow:true });
  F('SS75', '星陨终焉·万象鲸', 3, 'whale', '#4a5a8f', '#8fa8ff', 3000.0, 12000.0, 8053, { w:100, glow:true, wx:'fog' });
  F('SS76', '星陨之主·天鳞', 3, 'dragon', '#6b5f9a', '#b0a0f0', 30.0, 160.0, 4602, { w:74, glow:true, tm:'dawn' });
  F('SS77', '渊底月神·银鳐', 3, 'ray', '#5568a0', '#98b0ff', 80.0, 400.0, 5095, { w:54, glow:true, wx:'clear' });
  F('SS78', '星陨王座·裂空皇带', 3, 'oarfish', '#7f8bb8', '#c8d0ff', 200.0, 900.0, 5589, { w:40, glow:true });
  F('SS79', '深渊终章·噬星者', 3, 'dragon', '#5a6890', '#93a8e8', 500.0, 2600.0, 7560, { w:29, glow:true, teeth:true, wx:'clear', tm:'dusk' });
  F('SS80', '永夜之主·虚空鲸', 3, 'whale', '#4f5f8a', '#88a0e0', 2000.0, 9000.0, 7232, { w:22, glow:true });

  /* ===== SSS · 时之尽头（100 种：普46 稀28 史17 传9）===== */
  F('SSS01', '时砂小鱼', 0, 'fish', '#b8a882', '#e8dcb0', 0.05, 0.30, 134, { w:100, body:0.28 });
  F('SSS02', '溯流鲑', 0, 'fish', '#c98f8f', '#8f5555', 0.80, 5.0, 151, { w:99, body:0.32 });
  F('SSS03', '零度蝶鱼', 0, 'fish', '#cfe4ec', '#9dc2d2', 0.20, 1.2, 157, { w:98, body:0.62 });
  F('SSS04', '昨日鲈', 0, 'fish', '#a8a2b8', '#6f6885', 1.0, 5.5, 163, { w:97, body:0.36, spiny:true });
  F('SSS05', '遗迹鳉', 0, 'fish', '#b0c9a8', '#7a9a72', 0.02, 0.12, 121, { w:96, body:0.26 });
  F('SSS06', '虚时鲳', 0, 'fish', '#cdc3d6', '#948aa8', 0.60, 3.5, 172, { w:95, body:0.58 });
  F('SSS07', '刹那鲴', 0, 'fish', '#d6cdb8', '#f5eeda', 0.08, 0.45, 148, { w:94, body:0.30 });
  F('SSS08', '须臾鲹', 0, 'fish', '#c8b8a0', '#f0e0c8', 0.15, 0.90, 163, { w:93, body:0.36, tail:"fork" });
  F('SSS09', '瞬息鳉', 0, 'fish', '#a8c0c8', '#e0f0f8', 0.04, 0.22, 140, { w:93, body:0.28 });
  F('SSS10', '一刻鲹', 0, 'fish', '#d0c8b0', '#a89f80', 0.10, 0.70, 154, { w:92, body:0.34 });
  F('SSS11', '时光鲽', 0, 'fish', '#c0b0a0', '#908070', 0.30, 2.0, 160, { w:91, body:0.58, spots:true });
  F('SSS12', '琥珀鲷', 0, 'fish', '#b8c0a8', '#8f9880', 0.80, 4.5, 168, { w:90, body:0.46, spiny:true });
  F('SSS13', '遗迹石斑', 0, 'fish', '#c8c0d0', '#98909f', 1.2, 7.0, 174, { w:89, body:0.44, spots:true });
  F('SSS14', '残响鲻', 0, 'fish', '#d8ccb8', '#a89c88', 0.40, 2.6, 151, { w:88, body:0.32 });
  F('SSS15', '静默鳕', 0, 'fish', '#b0b8c0', '#808890', 0.90, 5.5, 159, { w:87, body:0.34 });
  F('SSS16', '尘时鲹', 0, 'fish', '#c4c0b0', '#94907f', 0.25, 1.6, 156, { w:86, body:0.30 });
  F('SSS17', '初雪鳟', 0, 'fish', '#9f8fb8', '#c9b8ff', 0.60, 4.0, 164, { w:86, body:0.30, spots:true });
  F('SSS18', '沙漏鲽', 0, 'fish', '#c0a8b8', '#907888', 0.35, 2.4, 161, { w:85, body:0.56 });
  F('SSS19', '回音鲈', 0, 'fish', '#a8b8c0', '#788890', 1.5, 8.0, 170, { w:84, body:0.36, spiny:true });
  F('SSS20', '旧日鲳', 0, 'fish', '#d0c0a8', '#a09078', 0.70, 4.2, 166, { w:83, body:0.60 });
  F('SSS21', '年轮鲷', 0, 'fish', '#8f7fb8', '#c9b8ff', 1.0, 6.0, 173, { w:82, body:0.48, spiny:true, stripes:true });
  F('SSS22', '未时鰕虎', 0, 'fish', '#d6c49a', '#a08f5f', 0.10, 0.70, 142, { w:82, body:0.30, spots:true });
  F('SSS23', '星轨鳗', 0, 'eel', '#7f8fd6', '#cfe0ff', 0.30, 2.2, 157, { w:81, glow:true });
  F('SSS24', '虚空鲽', 0, 'fish', '#8f9aa8', '#5a6472', 0.50, 3.2, 163, { w:80, body:0.58 });
  F('SSS25', '昨日鲹', 0, 'fish', '#a86f8f', '#e0b8d6', 0.30, 2.0, 153, { w:79, body:0.32, tail:"fork" });
  F('SSS26', '远景鲳', 0, 'fish', '#3f2f6b', '#a88fe0', 0.80, 4.8, 167, { w:78, body:0.58 });
  F('SSS27', '回响鲻', 0, 'fish', '#9a8fb8', '#c8b8e8', 0.45, 2.8, 155, { w:78, body:0.32 });
  F('SSS28', '初光鲻', 0, 'fish', '#b8a8c8', '#8f7f9f', 0.35, 2.2, 150, { w:77, body:0.32 });
  F('SSS29', '遗迹鳐', 0, 'ray', '#6a3f9f', '#c9a0ff', 1.5, 9.0, 166, { w:76 });
  F('SSS30', '尘光水母', 0, 'jelly', '#3f3a5c', '#8f88b8', 0.30, 2.4, 151, { w:75, glow:true });
  F('SSS31', '遗光鲹', 0, 'fish', '#5a5a9f', '#b8b8ff', 0.20, 1.4, 155, { w:75, body:0.32, tail:/fork/ });
  F('SSS32', '空时鳕', 0, 'fish', '#4f6b7d', '#a8c9d6', 0.60, 3.6, 154, { w:74, body:0.34 });
  F('SSS33', '逆时鳗', 1, 'eel', '#7f6fd6', '#d6c9ff', 0.50, 3.0, 701, { w:100, glow:true, wx:'rain' });
  F('SSS34', '千年纪鱼', 1, 'fish', '#2a3a6a', '#8fb0e8', 3.0, 14.0, 892, { w:97, body:0.40, glow:true });
  F('SSS35', '虚空旗鱼', 1, 'fish', '#6f7f98', '#c0d0e8', 50.0, 240.0, 1018, { w:95, body:0.26, glow:true });
  F('SSS36', '纪元鲟', 1, 'fish', '#8a7f6a', '#5a4f3a', 20.0, 120.0, 1104, { w:92, body:0.38, spiny:true });
  F('SSS37', '黄昏鳐', 1, 'ray', '#a89478', '#7f6b50', 5.0, 40.0, 1189, { w:90, glow:true, wx:'fog' });
  F('SSS38', '暗物质水母', 1, 'jelly', '#c0b090', '#8f8060', 1.0, 8.0, 1295, { w:87, glow:true });
  F('SSS39', '回响鲷', 1, 'fish', '#9a9080', '#6f6555', 1.5, 7.0, 1146, { w:85, body:0.46, spiny:true, glow:true });
  F('SSS40', '时空褶皱·空棘鱼', 1, 'fish', '#b8b0a0', '#8f8878', 30.0, 140.0, 1231, { w:83, body:0.42, spiny:true, glow:true });
  F('SSS41', '逆流龙鱼', 1, 'dragon', '#3f2f6f', '#d6c0ff', 5.0, 30.0, 1316, { w:80, glow:true, teeth:true, wx:'cloudy' });
  F('SSS42', '残时皇带', 1, 'oarfish', '#2f4f7f', '#9fc9ff', 20.0, 110.0, 1252, { w:78, glow:true });
  F('SSS43', '虚时鮟鱇', 1, 'fish', '#d6a83f', '#fff0b8', 8.0, 50.0, 1274, { w:76, body:0.54, lure:true, teeth:true, glow:true });
  F('SSS44', '千面章鱼', 1, 'squid', '#1f2430', '#7f8fa8', 6.0, 40.0, 1210, { w:74, glow:true });
  F('SSS45', '逆空鲛', 1, 'shark', '#5a4a8a', '#b8a8e8', 30.0, 180.0, 1357, { w:72, body:0.28, glow:true, wx:'clear' });
  F('SSS46', '溯光鲹', 1, 'fish', '#4a3f6f', '#9f8fdf', 10.0, 60.0, 1125, { w:70, body:0.30, glow:true });
  F('SSS47', '旧日水母', 1, 'jelly', '#6a5a9a', '#bfa8ff', 3.0, 20.0, 1178, { w:68, glow:true });
  F('SSS48', '影时鲽', 1, 'fish', '#3a3a6a', '#8a8ac0', 4.0, 26.0, 1157, { w:66, body:0.58, glow:true });
  F('SSS49', '回环鳕', 1, 'fish', '#7a6aa8', '#c8b8ff', 6.0, 36.0, 1199, { w:64, body:0.34, glow:true, wx:'rain' });
  F('SSS50', '沉默巨口鳗', 1, 'eel', '#4f4f8f', '#a0a0e0', 15.0, 90.0, 1242, { w:63, teeth:true, glow:true });
  F('SSS51', '星轨魟', 1, 'ray', '#5f5f9f', '#b0b0f0', 12.0, 70.0, 1263, { w:61, glow:true });
  F('SSS52', '时刻鲳', 1, 'fish', '#2f2f5f', '#8f8fcf', 5.0, 32.0, 1168, { w:59, body:0.60, glow:true });
  F('SSS53', '时间龙鱼', 2, 'dragon', '#6a6a8a', '#a8a8c8', 10.0, 60.0, 1458, { w:100, glow:true, teeth:true, wx:'fog' });
  F('SSS54', '终焉鲨', 2, 'shark', '#8a7a9a', '#c0b0d0', 400.0, 1800.0, 1579, { w:93, body:0.30, glow:true });
  F('SSS55', '永恒鲸', 2, 'whale', '#5a6a7a', '#9aacbc', 1200.0, 6000.0, 1823, { w:87, glow:true, tm:'dusk' });
  F('SSS56', '原初蛇颈龙', 2, 'whale', '#7a8a6a', '#b0c0a0', 600.0, 3000.0, 1954, { w:81, glow:true });
  F('SSS57', '星尘巨魟', 2, 'ray', '#9a8a7a', '#c8b8a8', 150.0, 700.0, 1719, { w:76, glow:true, wx:'cloudy' });
  F('SSS58', '时光褶皱·虚空鲸', 2, 'whale', '#6a7a8a', '#a8b8c8', 2000.0, 8000.0, 7466, { w:71, glow:true, tm:'day' });
  F('SSS59', '纪元褶皱·深渊鲸', 2, 'whale', '#8a6a7a', '#c0a0b0', 1500.0, 7000.0, 5036, { w:66, glow:true });
  F('SSS60', '逆熵巨鱿', 2, 'squid', '#7a6a8a', '#b0a0c0', 300.0, 1500.0, 1780, { w:62, glow:true });
  F('SSS61', '残响龙鱼', 2, 'dragon', '#5a8a7a', '#a0c8b8', 40.0, 240.0, 1650, { w:58, glow:true, teeth:true, wx:'clear', tm:'night' });
  F('SSS62', '空之翼鳐', 2, 'ray', '#8a8a6a', '#c0c0a0', 200.0, 1000.0, 1632, { w:54, glow:true });
  F('SSS63', '时光巨口鲨', 2, 'shark', '#6a6a9a', '#a8a8d8', 600.0, 2600.0, 1867, { w:50, body:0.32, glow:true, teeth:true });
  F('SSS64', '时痕鲽', 0, 'fish', '#9a9a7a', '#c8c8a8', 0.25, 1.6, 157, { w:73, body:0.58, spots:true });
  F('SSS65', '逆光鳕', 0, 'fish', '#7a5a6a', '#b898a8', 0.70, 4.4, 156, { w:73, body:0.34 });
  F('SSS66', '纪年鲹', 0, 'fish', '#5a7a8a', '#98b8c8', 0.18, 1.1, 151, { w:72, body:0.32, tail:"fork" });
  F('SSS67', '溯时鲻', 0, 'fish', '#8a7a6a', '#c0b0a0', 0.40, 2.4, 153, { w:71, body:0.32 });
  F('SSS68', '残页鲷', 0, 'fish', '#6a8a8a', '#a8c8c8', 0.90, 5.2, 169, { w:70, body:0.46, spiny:true, stripes:true });
  F('SSS69', '空页鲈', 0, 'fish', '#b8a882', '#e8dcb0', 1.3, 7.0, 172, { w:70, body:0.36, spiny:true });
  F('SSS70', '遗忘鲳', 0, 'fish', '#c98f8f', '#8f5555', 0.65, 3.8, 164, { w:69, body:0.60 });
  F('SSS71', '前尘鳉', 0, 'fish', '#cfe4ec', '#9dc2d2', 0.03, 0.17, 125, { w:68, body:0.26 });
  F('SSS72', '后时鰕虎', 0, 'fish', '#a8a2b8', '#6f6885', 0.09, 0.60, 144, { w:68, body:0.30, spots:true });
  F('SSS73', '拾光鲹', 0, 'fish', '#b0c9a8', '#7a9a72', 0.28, 1.8, 155, { w:67, body:0.30 });
  F('SSS74', '逆旅鲽', 0, 'fish', '#cdc3d6', '#948aa8', 0.32, 2.1, 160, { w:66, body:0.56, spots:true });
  F('SSS75', '流年鲻', 0, 'fish', '#d6cdb8', '#f5eeda', 0.38, 2.3, 154, { w:66, body:0.32 });
  F('SSS76', '空洞鳕', 0, 'fish', '#c8b8a0', '#f0e0c8', 0.85, 5.0, 157, { w:65, body:0.34 });
  F('SSS77', '寂时鲹', 0, 'fish', '#a8c0c8', '#e0f0f8', 0.22, 1.5, 156, { w:65, body:0.32, tail:"fork" });
  F('SSS78', '时间鲟', 1, 'fish', '#d0c8b0', '#a89f80', 28.0, 150.0, 1178, { w:58, body:0.38, spiny:true, glow:true });
  F('SSS79', '溯流皇带', 1, 'oarfish', '#c0b0a0', '#908070', 30.0, 150.0, 1214, { w:56, glow:true });
  F('SSS80', '逆熵鳐', 1, 'ray', '#b8c0a8', '#8f9880', 18.0, 95.0, 1249, { w:55, glow:true });
  F('SSS81', '空时鲛', 1, 'shark', '#c8c0d0', '#98909f', 45.0, 240.0, 1304, { w:53, body:0.28, glow:true, wx:'rain' });
  F('SSS82', '千年魟', 1, 'ray', '#d8ccb8', '#a89c88', 25.0, 130.0, 1228, { w:52, glow:true });
  F('SSS83', '时纱水母', 1, 'jelly', '#b0b8c0', '#808890', 6.0, 34.0, 1201, { w:50, glow:true });
  F('SSS84', '虚年章鱼', 1, 'squid', '#c4c0b0', '#94907f', 12.0, 64.0, 1265, { w:49, glow:true });
  F('SSS85', '逆旅鮟鱇', 1, 'fish', '#9f8fb8', '#c9b8ff', 14.0, 80.0, 1277, { w:48, body:0.54, lure:true, teeth:true, glow:true, wx:'fog' });
  F('SSS86', '纪元巨鲨', 2, 'shark', '#c0a8b8', '#907888', 500.0, 2200.0, 1840, { w:47, body:0.32, glow:true, teeth:true });
  F('SSS87', '时光巨龙', 2, 'dragon', '#a8b8c0', '#788890', 60.0, 320.0, 2066, { w:44, glow:true, teeth:true });
  F('SSS88', '千年巨鲸', 2, 'whale', '#d0c0a8', '#a09078', 2500.0, 10000.0, 2153, { w:41, glow:true, tm:'dawn' });
  F('SSS89', '逆流皇带', 2, 'oarfish', '#8f7fb8', '#c9b8ff', 300.0, 1400.0, 1963, { w:38, glow:true, wx:'cloudy' });
  F('SSS90', '时之褶皱·空鲸', 2, 'whale', '#d6c49a', '#a08f5f', 1800.0, 7500.0, 2014, { w:36, glow:true });
  F('SSS91', '纪元龙鱼', 2, 'dragon', '#7f8fd6', '#cfe0ff', 80.0, 420.0, 2119, { w:33, glow:true, teeth:true, tm:'dusk' });
  F('SSS92', '时之终点·无相鲲', 3, 'whale', '#8f9aa8', '#5a6472', 5000.0, 20000.0, 12158, { w:100, glow:true });
  F('SSS93', '初源之影·混沌', 3, 'dragon', '#a86f8f', '#e0b8d6', 300.0, 1400.0, 13895, { w:83, glow:true, teeth:true, wx:'clear' });
  F('SSS94', '终焉纪元·忘川', 3, 'shark', '#3f2f6b', '#a88fe0', 2000.0, 9000.0, 11580, { w:68, body:0.30, glow:true, teeth:true, tm:'day' });
  F('SSS95', '时之尽头·无相巨鲲', 3, 'whale', '#9a8fb8', '#c8b8e8', 3000.0, 12000.0, 6949, { w:56, glow:true, wx:'clear' });
  F('SSS96', '创世之鳞', 3, 'dragon', '#b8a8c8', '#8f7f9f', 60.0, 300.0, 8106, { w:47, glow:true });
  F('SSS97', '终末渔者之影', 3, 'fish', '#6a3f9f', '#c9a0ff', 100.0, 500.0, 10421, { w:39, body:0.36, glow:true, wx:'rain', tm:'night' });
  F('SSS98', '纪元终焉·空之鲸', 3, 'whale', '#3f3a5c', '#8f88b8', 4000.0, 16000.0, 9264, { w:32, glow:true });
  F('SSS99', '最初之鳞·混沌', 3, 'dragon', '#5a5a9f', '#b8b8ff', 200.0, 1000.0, 12738, { w:26, glow:true, teeth:true, wx:'fog' });
  F('SSS100', '终焉之影·忘川', 3, 'shark', '#4f6b7d', '#a8c9d6', 1000.0, 5000.0, 11001, { w:22, body:0.30, glow:true, teeth:true, tm:'dawn' });

  /* ---------- 索引 ---------- */
  G.FISH = list;
  G.FISH_ID = {};
  G.FISH_BY_FIELD = {};
  list.forEach(function (f) {
    G.FISH_ID[f.id] = f;
    if (!G.FISH_BY_FIELD[f.field]) G.FISH_BY_FIELD[f.field] = [];
    G.FISH_BY_FIELD[f.field].push(f);
  });

  G.FISH_BY_FIELD_RARITY = {};
  Object.keys(G.FISH_BY_FIELD).forEach(function (fid) {
    var buckets = [[], [], [], []];
    G.FISH_BY_FIELD[fid].forEach(function (f) { buckets[f.rar].push(f); });
    G.FISH_BY_FIELD_RARITY[fid] = buckets;
  });

  G.ALL_FISH_IDS = list.map(function (f) { return f.id; });
  G.TOTAL_FISH = list.length;   // 362
})();
