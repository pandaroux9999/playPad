const path = require('path');
const fs = require('fs');
const { launchBrowser, fetchPageHTML, parseJVPage } = require('./jeuxvideo-scraper');

const LISTING_URL = 'https://www.jeuxvideo.com/tous-les-jeux/';
const MAX_RETRIES = 3;
const OUTPUT_PATH = path.join(__dirname, 'data', 'jv-catalog.json');
const PROGRESS_PATH = path.join(__dirname, 'data', 'jv-progress.json');
const BROWSER_REFRESH_INTERVAL = 200;

let userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

let viewports = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay() { return Math.floor(Math.random() * 600) + 200; }

function saveProgress(page, total, games) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ page, total, gamesSoFar: games }, null, 2));
}

async function getPage(browser, pageIndex) {
  const p = await browser.newPage();
  const ua = userAgents[pageIndex % userAgents.length];
  const vp = viewports[pageIndex % viewports.length];
  await p.setUserAgent(ua);
  await p.setViewport(vp);
  return p;
}

async function createBrowser() {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  return browser;
}

(async () => {
  console.log('=== Scraping JeuxVideo.com (mode anti-détection) ===');
  console.log('Sortie:', OUTPUT_PATH);

  let allGames = [];
  let totalPages = 0;
  let browser;

  try {
    let startPage = 1;
    try {
      const saved = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
      if (saved.page > 1 && saved.gamesSoFar > 0) {
        startPage = saved.page;
        totalPages = saved.total || 1807;
        allGames = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
        console.log(`Reprise page ${startPage}/${totalPages} (${allGames.length} jeux)`);
      }
    } catch {}

    browser = await createBrowser();
    let page = await getPage(browser, 0);

    if (startPage === 1) {
      const html = await fetchPageHTML(page, `${LISTING_URL}?page=1`);
      const parsed = parseJVPage(html);
      totalPages = parsed.totalPages || 1807;
      allGames = parsed.games;
      console.log(`Page 1/${totalPages}: 25 jeux`);
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
      saveProgress(2, totalPages, allGames.length);
      startPage = 2;
    }

    const startTime = Date.now();

    for (let pg = startPage; pg <= totalPages; pg++) {
      let success = false;

      // Refresh browser every 200 pages
      if (pg % BROWSER_REFRESH_INTERVAL === 0) {
        console.log(`  [Nouveau navigateur page ${pg}]`);
        try { await browser.close(); } catch {}
        browser = await createBrowser();
        page = await getPage(browser, pg);
        await sleep(2000);
      }

      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          if (retry > 0) {
            if (retry === 2) {
              try { await page.close(); } catch {}
              page = await getPage(browser, pg + retry);
            }
            if (retry === 3) {
              console.log(`  [Nouveau navigateur pour retry page ${pg}]`);
              try { await browser.close(); } catch {}
              browser = await createBrowser();
              page = await getPage(browser, pg);
              await sleep(3000);
            }
            await sleep(3000 * retry);
          }
          const html = await fetchPageHTML(page, `${LISTING_URL}?page=${pg}&_=${Date.now()}`);
          const parsed = parseJVPage(html);

          if (parsed.games.length === 0) {
            console.log(`  [Alerte] Page ${pg}: 0 jeux, on continue quand même`);
            success = true;
            break;
          }

          // Vérifier qu'on a bien des jeux différents de la page précédente
          allGames = allGames.concat(parsed.games);

          for (const g of parsed.games) {
            console.log(`jeu ${g.title} importé`);
          }

          if (pg % 50 === 0 || pg === startPage) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
            console.log(`[PROGRÈS] Page ${pg}/${totalPages}: ${allGames.length} jeux (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
          }
          saveProgress(pg + 1, totalPages, allGames.length);
          success = true;
          break;
        } catch (e) {
          console.error(`[ERREUR] Page ${pg} tentative ${retry + 1}: ${e.message}`);
        }
      }
      if (!success) {
        console.error(`[ABANDON] Page ${pg}`);
      }
      await sleep(randomDelay());
    }
  } catch (e) {
    console.error('Erreur fatale:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Dédoublonnage final
  const unique = new Map();
  for (const g of allGames) unique.set(g.game_id, g);
  allGames = Array.from(unique.values());

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
  try { fs.unlinkSync(PROGRESS_PATH); } catch {}

  const sizeMB = Math.round(fs.statSync(OUTPUT_PATH).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${allGames.length} jeux (${sizeMB}MB) ===`);
  process.exit(0);
})();
