const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://www.jeuxvideo.com';
const LISTING_URL = `${BASE_URL}/tous-les-jeux/`;
const GAMES_PER_PAGE = 25;
const DELAY_MS = 800;
const MAX_RETRIES = 3;
const PROGRESS_PATH = path.join(__dirname, 'data', 'scan_progress.json');
const PROGRESS_KEY = 'jv_scrape_progress';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const JV_PLATFORM_MAP = {
  'pc': 'pc',
  'playstation 5': 'ps5',
  'ps5': 'ps5',
  'playstation 4': 'ps4',
  'ps4': 'ps4',
  'xbox series': 'xbox',
  'xbox series x': 'xbox',
  'xbox series s': 'xbox',
  'xbox one': 'xbox',
  'nintendo switch': 'nintendo',
  'switch 2': 'nintendo',
  'switch': 'nintendo',
  'ios': 'ios',
  'android': 'android',
  'mac': 'pc',
  'linux': 'pc',
  'playstation 3': 'ps3',
  'ps3': 'ps3',
  'xbox 360': 'xbox360',
  'nintendo 3ds': 'nintendo',
  'nintendo ds': 'nintendo',
  'playstation 2': 'ps2',
  'ps2': 'ps2',
  'wii': 'nintendo',
  'wii u': 'nintendo',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf-8');
    return JSON.parse(raw)[PROGRESS_KEY] || null;
  } catch { return null; }
}

function setProgress(data) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8')); } catch {}
    all[PROGRESS_KEY] = data;
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(all, null, 2));
  } catch (e) { console.error('[JVScraper] Progress write error:', e.message); }
}

function clearProgress() {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8')); } catch {}
    delete all[PROGRESS_KEY];
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(all, null, 2));
  } catch {}
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
  if (totalMatch) totalPages = Math.ceil(parseInt(totalMatch[1]) / GAMES_PER_PAGE);

  return { games, totalPages };
}

function mapJVPlatform(text) {
  if (!text) return 'pc';
  const lower = text.toLowerCase().trim();
  for (const [key, val] of Object.entries(JV_PLATFORM_MAP)) {
    if (lower.includes(key)) return val;
  }
  return 'pc';
}

function buildBatchEntry(game) {
  return {
    game_id: game.game_id,
    title: game.title,
    platform: game.platform,
    cover: game.cover || '',
    genre: game.genre || '',
    year: game.year || 0,
    developer: game.developer || '',
    publisher: game.publisher || '',
  };
}

async function launchBrowser() {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch {
    puppeteer = require('puppeteer');
  }
  return puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function fetchPageHTML(puppeteerPage, url) {
  await puppeteerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return puppeteerPage.content();
}

async function scrapeAllJVGames(db, { onProgress, startPage, maxPages } = {}) {
  const saved = getProgress();
  let currentPage = (startPage != null) ? startPage : (saved ? saved.page : 1);
  let totalPages = (saved && saved.totalPages) ? saved.totalPages : 0;
  let totalImported = (saved && saved.totalImported) ? saved.totalImported : 0;

  console.log(`[JVScraper] Démarrage page ${currentPage}...`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    const firstPage = currentPage === 1;
    if (firstPage || !totalPages) {
      console.log('[JVScraper] Récupération page 1 pour compter total...');
      const html = await fetchPageHTML(page, `${LISTING_URL}?page=1`);
      const parsed = parseJVPage(html);
      totalPages = parsed.totalPages || 1807;

      if (firstPage && parsed.games.length > 0) {
        const batch = parsed.games.map(buildBatchEntry);
        await db.batchUpsertCatalog(batch);
        totalImported += batch.length;
        console.log(`[JVScraper] Page 1: ${batch.length} jeux importés (${totalPages} pages au total)`);
      }
      currentPage = 2;
      setProgress({ page: currentPage, totalPages, totalImported });
      if (onProgress) onProgress(currentPage, totalPages, totalImported);
    }

    const endPage = maxPages ? Math.min(maxPages, totalPages) : totalPages;

    for (let pg = currentPage; pg <= endPage; pg++) {
      let success = false;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          if (retry > 0) {
            console.log(`[JVScraper] Retry ${retry}/${MAX_RETRIES} page ${pg}...`);
            await sleep(3000 * retry);
          }
          const html = await fetchPageHTML(page, `${LISTING_URL}?page=${pg}`);
          const parsed = parseJVPage(html);

          if (parsed.games.length === 0) {
            console.log(`[JVScraper] Page ${pg}: 0 jeux, fin probable`);
            clearProgress();
            console.log(`[JVScraper] Terminé: ${totalImported} jeux importés`);
            await browser.close();
            return { totalImported, totalPages };
          }

          const batch = parsed.games.map(buildBatchEntry);
          await db.batchUpsertCatalog(batch);
          totalImported += batch.length;

          setProgress({ page: pg + 1, totalPages: parsed.totalPages || totalPages, totalImported });

          if (pg % 50 === 0 || pg === endPage) {
            console.log(`[JVScraper] Page ${pg}/${endPage}: ${batch.length} jeux, total: ${totalImported}`);
          }

          if (onProgress) onProgress(pg, endPage, totalImported);
          success = true;
          break;
        } catch (e) {
          console.error(`[JVScraper] Erreur page ${pg}: ${e.message}`);
          if (retry === MAX_RETRIES) {
            console.error(`[JVScraper] Abandon page ${pg} après ${MAX_RETRIES} retries`);
          }
        }
      }
      if (!success && currentPage < endPage) {
        await sleep(5000);
      }
      await sleep(DELAY_MS);
    }
  } catch (e) {
    console.error('[JVScraper] Erreur fatale:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  clearProgress();
  console.log(`[JVScraper] Terminé: ${totalImported} jeux importés`);
  return { totalImported, totalPages };
}

async function getTotalJVGames() {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    const html = await fetchPageHTML(page, `${LISTING_URL}?page=1`);
    const $ = cheerio.load(html);
    const totalText = $('.cardListHeader__count').text().replace(/\s/g, '');
    const totalMatch = totalText.match(/(\d+)/);
    if (totalMatch) return parseInt(totalMatch[1]);
  } catch {}
  finally { if (browser) await browser.close().catch(() => {}); }
  return 0;
}

module.exports = { scrapeAllJVGames, getTotalJVGames, parseJVPage, mapJVPlatform, launchBrowser, fetchPageHTML };
