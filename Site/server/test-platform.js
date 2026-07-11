const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function test() {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Test platform page 1
  console.log('=== Test 1: PC page 1 ===');
  await page.goto('https://www.jeuxvideo.com/tous-les-jeux/machine-10/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let html = await page.content();
  let $ = cheerio.load(html);
  let games = $('li.cardList__item');
  console.log(`Games found: ${games.length}`);
  console.log(`First game: ${$(games[0]).find('.cardGameList__gameTitleLink').text().trim()}`);

  // Test platform page 2
  console.log('\n=== Test 2: PC page 2 ===');
  await page.goto('https://www.jeuxvideo.com/tous-les-jeux/machine-10/?p=2', { waitUntil: 'domcontentloaded', timeout: 30000 });
  html = await page.content();
  $ = cheerio.load(html);
  games = $('li.cardList__item');
  console.log(`Games found: ${games.length}`);
  console.log(`First game: ${$(games[0]).find('.cardGameList__gameTitleLink').text().trim()}`);

  // Test platform page 5
  console.log('\n=== Test 3: PC page 5 ===');
  await page.goto('https://www.jeuxvideo.com/tous-les-jeux/machine-10/?p=5', { waitUntil: 'domcontentloaded', timeout: 30000 });
  html = await page.content();
  $ = cheerio.load(html);
  games = $('li.cardList__item');
  console.log(`Games found: ${games.length}`);
  console.log(`First game: ${$(games[0]).find('.cardGameList__gameTitleLink').text().trim()}`);

  await browser.close();
  console.log('\n=== DONE ===');
}

test().catch(console.error);
