const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUTPUT_PATH = path.join(__dirname, 'data', 'jv-catalog.json');
const PROGRESS_PATH = path.join(__dirname, 'data', 'jv-progress.json');
const MAX_RETRIES = 3;
const BROWSER_REFRESH_INTERVAL = 100;
const MIN_DELAY_MS = 400;
const MAX_DELAY_MS = 1200;
const BASE_URL = 'https://www.jeuxvideo.com';

const PLATFORMS = [
  { id: 'machine-10', name: 'PC', sort: 1 },
  { id: 'machine-22', name: 'PS5', sort: 2 },
  { id: 'machine-2', name: 'PS4', sort: 3 },
  { id: 'machine-1', name: 'Xbox Series', sort: 4 },
  { id: 'machine-23', name: 'Xbox One', sort: 5 },
  { id: 'machine-8', name: 'Switch', sort: 6 },
  { id: 'machine-5', name: 'Retro', sort: 7 },
  { id: 'machine-9', name: 'Mobile', sort: 8 },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

const JV_PLATFORM_MAP = {
  'pc': 'pc', 'playstation 5': 'ps5', 'ps5': 'ps5', 'playstation 4': 'ps4', 'ps4': 'ps4',
  'xbox series': 'xbox', 'xbox series x': 'xbox', 'xbox series s': 'xbox', 'xbox one': 'xbox',
  'nintendo switch': 'nintendo', 'switch 2': 'nintendo', 'switch': 'nintendo',
  'ios': 'ios', 'android': 'android', 'mac': 'pc', 'linux': 'pc',
  'playstation 3': 'ps3', 'ps3': 'ps3', 'xbox 360': 'xbox360',
  'playstation 2': 'ps2', 'ps2': 'ps2',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay() { return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS; }

function mapJVPlatform(text) {
  if (!text) return 'pc';
  const lower = text.toLowerCase().trim();
  for (const [key, val] of Object.entries(JV_PLATFORM_MAP)) {
    if (lower.includes(key)) return val;
  }
  return 'pc';
}

function parseJVPage(html) {
  const $ = cheerio.load(html);
  const games = [];

  $('li.cardList__item').each((_, li) => {
    const $card = $(li).find('div.cardGameList');
    if (!$card.length) return;

    const $titleLink = $card.find('a.cardGameList__gameTitleLink');
    const title = $titleLink.text().trim();
    const href = $titleLink.attr('href') || '';
    const idMatch = href.match(/jeu-(\d+)/);
    if (!idMatch || !title) return;

    const platformText = $card.find('.cardGameList__gamePlatforms').text().trim().replace(/\s+/g, ' ');
    const cover = $card.find('img.cardGameList__image').attr('data-src')
      || $card.find('img.cardGameList__image').attr('src') || '';
    const description = $card.find('.cardGameList__gameDescription').text().trim();
    const releaseText = $card.find('.cardGameList__releaseDate').text().replace('Sortie:', '').trim();
    let year = 0;
    const yearMatch = releaseText.match(/(\d{4})/);
    if (yearMatch) year = parseInt(yearMatch[1]);
    const editorialScore = $card.find('.cardGameList__hubItemRating--editorial').text().trim();
    const userScore = $card.find('.cardGameList__hubItemRating--opinions').text().trim();

    let fullCover = cover;
    if (cover && !cover.startsWith('http')) {
      fullCover = cover.startsWith('//') ? `https:${cover}` : `${BASE_URL}${cover}`;
    }

    games.push({
      game_id: `jv-${idMatch[1]}`,
      title,
      platform: mapJVPlatform(platformText.split(' ')[0] || 'pc'),
      cover: fullCover,
      genre: '',
      year,
      description,
      developer: '',
      publisher: '',
      editorial_score: editorialScore,
      user_score: userScore,
      platforms_raw: platformText,
      jv_url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
    });
  });

  let totalPages = 0;
  const totalText = $('.cardListHeader__count').text().replace(/\s/g, '');
  const totalMatch = totalText.match(/(\d+)/);
  if (totalMatch) totalPages = Math.ceil(parseInt(totalMatch[1]) / 25);

  return { games, totalPages };
}

async function createBrowser() {
  return puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function fetchPageHTML(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const html = await page.content();
  if (html.length < 500) throw new Error(`Page trop petite: ${html.length} bytes`);
  return html;
}

(async () => {
  console.log('=== Scraping JV.com par plateforme (pagination ?p=N) ===');
  console.log('Sortie:', OUTPUT_PATH);

  let allGames = [];

  // Resume from progress
  let resumePlatform = 0;
  let resumePage = 1;
  try {
    const saved = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    if (saved.platformIndex != null && saved.page > 1) {
      resumePlatform = saved.platformIndex;
      resumePage = saved.page;
      allGames = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
      console.log(`Reprise plateforme #${resumePlatform} page ${resumePage} (${allGames.length} jeux d�j� scrap�s)`);
    }
  } catch {}

  const startTime = Date.now();
  let browser;

  try {
    for (let pi = resumePlatform; pi < PLATFORMS.length; pi++) {
      const platform = PLATFORMS[pi];
      let startPage = (pi === resumePlatform) ? resumePage : 1;
      let platformTotalPages = 0;

      console.log(`\n=== Plateforme: ${platform.name} (${platform.id}) ===`);

      browser = await createBrowser();
      const page = await browser.newPage();
      const ua = USER_AGENTS[pi % USER_AGENTS.length];
      await page.setUserAgent(ua);

      // Get first page to count total
      if (startPage === 1) {
        const url = `${BASE_URL}/tous-les-jeux/${platform.id}/?p=1`;
        console.log(`  Comptage via ${url}`);
        const html = await fetchPageHTML(page, url);
        const parsed = parseJVPage(html);
        platformTotalPages = parsed.totalPages;
        console.log(`  Total: ${platformTotalPages} pages`);

        if (parsed.games.length > 0) {
          for (const g of parsed.games) allGames.push(g);
          fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  Page 1/${platformTotalPages}: ${parsed.games.length} jeux (${allGames.length} total, ${Math.floor(elapsed/60)}m${elapsed%60}s)`);
        }
        startPage = 2;
      } else {
        // Count total from first page
        const html = await fetchPageHTML(page, `${BASE_URL}/tous-les-jeux/${platform.id}/?p=1`);
        const parsed = parseJVPage(html);
        platformTotalPages = parsed.totalPages;
        console.log(`  Total: ${platformTotalPages} pages (resume)`);
      }

      await page.close();

      // Scrape remaining pages
      for (let pg = startPage; pg <= platformTotalPages; pg++) {
        let success = false;

        if (pg % BROWSER_REFRESH_INTERVAL === 0) {
          console.log(`  [Nouveau navigateur page ${pg}]`);
          try { await browser.close(); } catch {}
          browser = await createBrowser();
        }

        const p = await browser.newPage();
        const ua2 = USER_AGENTS[(pi + pg) % USER_AGENTS.length];
        await p.setUserAgent(ua2);

        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            if (retry > 0) {
              console.log(`    Retry ${retry}/${MAX_RETRIES}...`);
              await sleep(3000 * retry);
            }

            const url = `${BASE_URL}/tous-les-jeux/${platform.id}/?p=${pg}`;
            const html = await fetchPageHTML(p, url);
            const parsed = parseJVPage(html);

            if (parsed.games.length === 0) {
              console.log(`    Page ${pg}: 0 jeux (fin probable)`);
              success = true;
              break;
            }

            for (const g of parsed.games) allGames.push(g);

            if (pg % 25 === 0 || pg === platformTotalPages) {
              fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              console.log(`  [PROGRES] ${platform.name} page ${pg}/${platformTotalPages}: ${allGames.length} jeux (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
            }

            fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ platformIndex: pi, page: pg + 1 }, null, 2));
            success = true;
            break;
          } catch (e) {
            console.error(`    Erreur page ${pg} tentative ${retry+1}: ${e.message}`);
          }
        }

        await p.close();
        if (!success) {
          console.error(`  [ABANDON] ${platform.name} page ${pg}`);
        }
        await sleep(randomDelay());
      }

      try { await browser.close(); } catch {}
    }
  } catch (e) {
    console.error('Erreur fatale:', e.message);
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }

  // Deduplicate
  console.log(`\n=== D�doublonnage (${allGames.length} entr�es) ===`);
  const unique = new Map();
  for (const g of allGames) {
    if (!unique.has(g.game_id)) unique.set(g.game_id, g);
  }
  allGames = Array.from(unique.values());
  console.log(`Jeux uniques: ${allGames.length}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
  try { fs.unlinkSync(PROGRESS_PATH); } catch {}

  const sizeMB = Math.round(fs.statSync(OUTPUT_PATH).size / 1024 / 1024 * 10) / 10;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== TERMINE: ${allGames.length} jeux (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
  process.exit(0);
})();
