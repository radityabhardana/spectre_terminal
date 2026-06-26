const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err));
  page.on('requestfailed', request => console.log('REQ FAIL:', request.url(), request.failure().errorText));

  await page.goto('http://127.0.0.1:8787');
  
  await new Promise(r => setTimeout(r, 5000));
  
  console.log("Checking UI state...");
  const text = await page.evaluate(() => {
    const el = document.getElementById('snifferToggleText');
    return el ? el.innerText : 'null';
  });
  console.log("Tracker Text:", text);
  
  await browser.close();
})();
