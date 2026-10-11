/* =========================================================
   docs/balance-figures.js  —  《说明书》与《GDD》共用的「数值结论」
   =========================================================
   🔴 **本文件由 `node tools/balance.js --emit` 生成，不要手改。**
      手改会在下次 --emit 时被覆盖；`node tools/balance.js --check` 会当场报红。
   · 为什么要有这个文件：`fight` 那一节是**仿真结论**（4 档 × 2 档玩家 × 4000 场对局），
     玩家向说明书在页内**算不出来** —— 只能由生成器产出、页面引用。
     此前它是一张页内手抄常量表，改 `config.js` 的 `fight.*` 不会动它，**一句都不报错**。
   · `pace` 那一节是**解析期望**（页面自己也能算，见 `G.Loot.expectPrice`），
     写在这里是为了让门禁能把「页面显示的」与「工具算出来的」逐格对拍。
   · 复现： `node tools/balance.js --emit`   （种子固定 20260101，两次跑逐字节相同）
   ========================================================= */
window.G = window.G || {};
G.BALANCE_FIGURES = {
  seed: 20260101,
  rounds: 4000,                 // ① 每档每种玩法的对局数
  gen: 'node tools/balance.js --emit',
  fight: [
    { rar: 0, name: "普通", skillWin: 100, skillSec: 7.3, normWin: 100, normSec: 7.2, snap: 0 },
    { rar: 1, name: "稀有", skillWin: 99.5, skillSec: 22, normWin: 93.8, normSec: 19.9, snap: 6.2 },
    { rar: 2, name: "史诗", skillWin: 90.3, skillSec: 30.6, normWin: 90.5, normSec: 30.4, snap: 8.1 },
    { rar: 3, name: "传说", skillWin: 77.4, skillSec: 39, normWin: 75.2, normSec: 35.2, snap: 24.8 },
  ],
  pace: [
    { rank: "D", name: "村口小池塘", wait: 37, fight: 10.5, cycle: 47.5, perHour: 76, price: 92.6, income: 7016 },
    { rank: "C", name: "溪流浅滩", wait: 37.1, fight: 11.3, cycle: 48.4, perHour: 74, price: 148.4, income: 11039 },
    { rank: "B", name: "湖心半岛", wait: 51.9, fight: 12.4, cycle: 64.2, perHour: 56, price: 270.3, income: 15155 },
    { rank: "A", name: "深海断崖", wait: 81, fight: 15.6, cycle: 96.5, perHour: 37, price: 696.6, income: 25978 },
    { rank: "S", name: "幽蓝海沟", wait: 99.3, fight: 15.6, cycle: 114.9, perHour: 31, price: 1065.3, income: 33373 },
    { rank: "SS", name: "星陨之渊", wait: 97.8, fight: 13, cycle: 110.8, perHour: 32, price: 1553.1, income: 50466 },
    { rank: "SSS", name: "时之尽头", wait: 105.9, fight: 11.6, cycle: 117.5, perHour: 31, price: 1917.4, income: 58725 },
  ],
};
