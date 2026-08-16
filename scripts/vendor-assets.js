'use strict';

/**
 * vendor-assets.js —— 把免构建前端所需运行时固化到 public/vendor/
 * 由 package.json 的 postinstall 自动执行；npm install 后即使 node_modules
 * 目录结构变动，页面也只依赖 public/vendor 下的静态文件。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [
  ['node_modules/react/umd/react.development.js', 'public/vendor/react/react.development.js'],
  ['node_modules/react-dom/umd/react-dom.development.js', 'public/vendor/react-dom/react-dom.development.js'],
  ['node_modules/@babel/standalone/babel.min.js', 'public/vendor/babel/babel.min.js'],
];

let ok = true;
for (const [src, dest] of targets) {
  const s = path.join(root, src);
  const d = path.join(root, dest);
  try {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    console.log('  vendor:', src, '->', dest);
  } catch (e) {
    ok = false;
    console.error('  复制失败', src, ':', e.message);
  }
}

if (!ok) {
  console.error('部分前端资源复制失败，请先执行 npm install');
  process.exit(1);
}
console.log('前端运行时资源就绪（public/vendor）');