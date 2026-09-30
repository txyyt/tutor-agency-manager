// 一次性代码整理：给NodeNext ESM的相对导入补 .js 扩展名
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src/server', 'src/shared', 'scripts', 'tests'];
const exts = new Set(['.ts', '.tsx']);
let changed = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (exts.has(path.extname(entry.name))) process(full);
  }
}

function process(file) {
  const src = fs.readFileSync(file, 'utf-8');
  const re = /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g;
  let touched = false;
  const out = src.replace(re, (m, p1, p2, p3) => {
    if (/\.(js|json|css|node|mjs|cjs)$/.test(p2)) return m;
    touched = true;
    changed++;
    return `${p1}${p2}.js${p3}`;
  });
  if (touched) fs.writeFileSync(file, out, 'utf-8');
}

for (const r of roots) walk(r);
console.log(`updated imports: ${changed}`);
