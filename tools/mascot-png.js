// PNG-Fassungen von Hexi (512 × 512, durchsichtiger Hintergrund) aus den SVGs in static/images/mascot.
// Aufruf (Playwright und Chromium nötig): node tools/mascot-png.js static/images/mascot
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const dir = process.argv[2] || 'static/images/mascot';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  for (const file of fs.readdirSync(dir).filter((f) => /^hexi-.*\.svg$/.test(f))) {
    const svg = fs.readFileSync(path.join(dir, file), 'utf8').replace("width='400' height='400'", "width='512' height='512'");
    await page.setContent('<style>html,body{margin:0;background:transparent}</style>' + svg);
    await page.screenshot({ path: path.join(dir, file.replace(/\.svg$/, '.png')), omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } });
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
