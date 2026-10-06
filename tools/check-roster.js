/* 打印各钓场鱼种/档位分布 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
const H = { G: {} };
Object.defineProperty(global, 'G', { get() { return H.G; }, set(v) { H.G = v; }, configurable: true });
['src/data/config.js', 'src/data/fields.js', 'src/data/fish.js', 'src/data/items.js',
 'src/core/util.js', 'src/core/loot.js', 'src/core/fight.js']
  .forEach(r => (new Function(fs.readFileSync(path.join(ROOT, r), 'utf8'))).call(global));
const G = global.G;
let tot = 0;
console.log('钓场  鱼种  档位(普/稀/史/传)');
G.FIELDS.forEach(f => {
  const l = G.FISH_BY_FIELD[f.id];
  const t = [0, 0, 0, 0];
  l.forEach(x => t[x.rar]++);
  tot += l.length;
  console.log(`${f.id.padEnd(5)} ${String(l.length).padStart(3)}   ${t.join(' / ')}`);
});
console.log('合计 ' + tot + ' 种');
