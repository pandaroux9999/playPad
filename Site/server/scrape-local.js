const path = require('path');
const fs = require('fs');
const { launchBrowser, fetchPageHTML, parseJVPage } = require('./jeuxvideo-scraper');

const LISTING_URL = 'https://www.jeuxvideo.com/tous-les-jeux/';
const DELAY_MS = 80;
const MAX_RETRIES = 5;
const OUTPUT_PATH = path.join(__dirname, 'data', 'jv-catalog.json');
const PROGRESS_PATH = path.join(__dirname, 'data', 'jv-progress.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveProgress(page, total, games) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ page, total, gamesSoFar: games }, null, 2));
}

async function getPage(browser) {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  return p;
}

(async () => {
  console.log('=== Scraping JeuxVideo.com ===');
  console.log('Mode: sauvegarde locale uniquement');
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
        console.log(`Reprise page ${startPage}/${totalPages} (${allGames.length} jeux déjà récupérés)`);
      }
    } catch {}

    browser = await launchBrowser();
    let page = await getPage(browser);

    if (startPage === 1) {
      console.log('Récupération page 1...');
      const html = await fetchPageHTML(page, `${LISTING_URL}?page=1`);
      const parsed = parseJVPage(html);
      totalPages = parsed.totalPages || 1807;
      allGames = parsed.games;
      console.log(`Page 1/?: 25 jeux, total: ${totalPages} pages`);
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
      saveProgress(2, totalPages, allGames.length);
      startPage = 2;
    }

    const startTime = Date.now();
    for (let pg = startPage; pg <= totalPages; pg++) {
      // Recreate page every 300 navigations to avoid frame detachment
      if (pg % 300 === 0) {
        try { await page.close(); } catch {}
        page = await getPage(browser);
        console.log(`  [Nouvelle page navigateur créée après ${pg} navigations]`);
      }

      let success = false;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          if (retry > 0) {
            if (retry === 2) {
              // Frame detached: recreate the page
              try { await page.close(); } catch {}
              page = await getPage(browser);
              console.log(`  [Page recréée pour retry ${retry}]`);
            }
            await sleep(3000 * retry);
          }
          const html = await fetchPageHTML(page, `${LISTING_URL}?page=${pg}`);
          const parsed = parseJVPage(html);
          if (parsed.games.length === 0) { totalPages = pg - 1; break; }

          allGames = allGames.concat(parsed.games);

          // Affiche chaque jeu importé
          for (const g of parsed.games) {
            console.log(`jeu ${g.title} importé`);
          }

          if (pg % 100 === 0 || pg === startPage || pg === totalPages) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
            console.log(`[PROGRÈS] Page ${pg}/${totalPages}: +25 = ${allGames.length} jeux (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
          }
          saveProgress(pg + 1, totalPages, allGames.length);
          success = true;
          break;
        } catch (e) {
          console.error(`[ERREUR] Page ${pg} (tentative ${retry + 1}/${MAX_RETRIES + 1}): ${e.message}`);
        }
      }
      if (!success) {
        console.error(`[ABANDON] Page ${pg} après ${MAX_RETRIES + 1} tentatives`);
      }
      await sleep(DELAY_MS);
    }
  } catch (e) {
    console.error('Erreur fatale:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Sauvegarde finale
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allGames, null, 2));
  try { fs.unlinkSync(PROGRESS_PATH); } catch {}

  const sizeMB = Math.round(fs.statSync(OUTPUT_PATH).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${allGames.length} jeux sauvegardés (${sizeMB}MB) ===`);
  process.exit(0);
})();
