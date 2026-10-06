/* 临时脚本：导出装备 / 装饰 / 节奏表，供文档同步使用（用完即删） */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/data/goals.js', 'src/core/util.js', 'src/core/platform.js', 'src/core/loot.js',
 'src/core/fight.js', 'src/core/state.js', 'src/core/goals.js', 'src/core/weather.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G, C = G.CONFIG;

const p = s => console.log(s);
p('### BAITS ' + G.BAITS.length);
G.BAITS.forEach(b => p(`| ${b.name} | ${b.free ? '免费无限' : (b.price + ' / ' + b.pack + ' 个')} | ${b.free ? 0 : (b.price / b.pack).toFixed(1)} | ×${b.speed} | ×${b.rareMul} | ×${b.legendMul} |`));
function U_(n) { return n == null ? '-' : n; }
p('\n### RODS ' + G.RODS.length);
G.RODS.forEach(b => p(`| ${b.name} | ${b.price ? b.price.toLocaleString('en-US') : '免费'} | ×${b.rareMul} | ×${b.reel} |`));
p('\n### LINES ' + G.LINES.length);
G.LINES.forEach(b => p(`| ${b.name} | ${b.price ? b.price.toLocaleString('en-US') : '免费'} | ${b.tensionMax} |`));
p('\n### DECORS ' + G.DECORS.length);
G.DECORS.forEach(b => p(`| ${b.name} | ${{ coin: '金币', eco: '生态值', medal: '纪念币' }[b.cur || 'coin']} | ${b.price.toLocaleString('en-US')} |`));
p('\n### FIELDS');
G.FIELDS.forEach(f => p(`${f.id} ${f.rank} ${f.name} 鱼种 ${G.FISH_BY_FIELD[f.id].length} estOwn ${f.estOwnHours} unlockAt ${f.unlockAt} biteMul ${f.biteMul} hidden=${!!f.hidden}`));
p('\n### ACHIEVEMENTS ' + G.ACHIEVEMENTS.length);
p('titles ' + JSON.stringify((G.TITLE_LIST||[]).length) + ' / ' + Object.keys(G.TITLES||{}).length);
p('quests ' + (G.QUEST_TPL || []).length);
p('tutorial steps ' + C.tutorial.steps.length);
p('\n### VERSION ' + C.version);
