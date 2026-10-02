// 从同一矢量标志生成透明PNG和多尺寸ICO，避免桌面/开屏/侧栏标志不一致。
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const sizes = [16, 32, 48, 64, 128, 256];
const images = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const svg = fs.readFileSync('desktop/brand.svg', 'utf8');
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    images.push(await page.screenshot({ omitBackground: true }));
  }
} finally { await browser.close(); }
const index = Buffer.alloc(6 + sizes.length * 16);
index.writeUInt16LE(1, 2); index.writeUInt16LE(sizes.length, 4);
let offset = index.length;
sizes.forEach((size, i) => { const entry = 6 + i * 16; index[entry] = size % 256; index[entry + 1] = size % 256; index.writeUInt16LE(1, entry + 4); index.writeUInt16LE(32, entry + 6); index.writeUInt32LE(images[i].length, entry + 8); index.writeUInt32LE(offset, entry + 12); offset += images[i].length; });
fs.writeFileSync('desktop/icon.png', images.at(-1));
fs.writeFileSync('desktop/icon.ico', Buffer.concat([index, ...images]));
