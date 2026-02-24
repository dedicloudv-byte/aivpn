const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const workerContent = require('fs').readFileSync('index.js', 'utf8');
  const htmlMatch = workerContent.match(/return new Response\(generateDashboard\(request\), \{/);

  // Since I can't easily run the worker in the verify script, I will mock the generateDashboard call
  // I'll extract the HTML from index.js
  const startMarker = "function generateDashboard(request) {";
  const endMarker = "`;\n}";
  const startIndex = workerContent.indexOf(startMarker);
  const startContent = workerContent.indexOf("`", startIndex) + 1;
  const endIndex = workerContent.lastIndexOf(endMarker);
  let html = workerContent.substring(startContent, endIndex);

  // Replace variables
  html = html.replace(/${host}/g, 'aivpn.test');

  await page.setContent(html);

  // Click Generator
  await page.click('#nav-gen');

  // Fill host
  await page.fill('#gen-host', 'sg1.v2ray.com');

  // Wait for QR code
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'v2_4_generator.png', fullPage: true });
  await browser.close();
})();
