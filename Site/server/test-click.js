const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Users\\ARTHUR.PETRA\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    headless: false,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  await page.goto('https://www.jeuxvideo.com/tous-les-jeux/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Find any embedded game data
  const data = await page.evaluate(() => {
    // Look for JSON in script tags
    const scripts = Array.from(document.querySelectorAll('script'));
    const jsonBlocks = [];
    for (const s of scripts) {
      if (s.type === 'application/ld+json' || s.type === 'application/json') {
        jsonBlocks.push({ type: s.type, content: s.textContent.substring(0, 200) });
      }
      // Look for window assignments
      if (s.textContent.includes('window.') || s.textContent.includes('jvc.') || s.textContent.includes('games') || s.textContent.includes('items')) {
        jsonBlocks.push({ type: 'inline', content: s.textContent.substring(0, 300) });
      }
    }

    // Look for data attributes
    const containers = document.querySelectorAll('[data-games], [data-items], [data-list]');
    const dataAttrs = Array.from(containers).slice(0, 5).map(c => c.outerHTML.substring(0, 200));

    // Check window.jvc structure
    const jvcKeys = typeof window.jvc !== 'undefined' ? Object.keys(window.jvc).join(', ') : 'undefined';

    return { jsonBlocks: jsonBlocks.slice(0, 15), dataAttrs, jvcKeys };
  });

  console.log('Script blocks with data:');
  data.jsonBlocks.forEach((b, i) => {
    console.log(`[${i}] ${b.type}: ${b.content.substring(0, 200)}`);
  });
  console.log('\nData attrs:', data.dataAttrs);
  console.log('jvc keys:', data.jvcKeys);

  await browser.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
