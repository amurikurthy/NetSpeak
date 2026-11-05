// Regenerates the PNG icons in web/icons from the SVG sources next to them, with Chromium's renderer (sharp edges, real
// anti-aliasing). Run: node tools/icons.js   (needs Playwright; no build step otherwise)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'web', 'icons');
const jobs = [
  ['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512],              // "any" icons: rounded tile
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],                              // Android may crop to a circle or squircle
  ['icon-square.svg', 'apple-touch-icon.png', 180], ['icon-square.svg', 'apple-touch-icon-167.png', 167],   // iOS rounds the corners itself
  ['favicon.svg', 'favicon-16.png', 16], ['favicon.svg', 'favicon-32.png', 32], ['favicon.svg', 'favicon-48.png', 48],
];
(async () => {
  const b = await chromium.launch();
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(dir, src), 'utf8');
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
    await p.waitForTimeout(100);
    await p.screenshot({ path: path.join(dir, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await p.close();
  }
  await b.close();
  console.log('wrote', jobs.map((j) => j[1]).join(', '));
})();
