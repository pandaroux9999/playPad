const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUTPUT = path.join(__dirname, 'Site', 'server', 'data', 'jv-catalog.json');
const PROGRESS = path.join(__dirname, 'Site', 'server', 'data', 'scan_progress.json');
const BASE = 'https://www.jeuxvideo.com';
const PER_PAGE = 25;
const MAX_PAGES = 0; // mettre 0 pour tout scraper

const PLATFORM_MAP = {
  pc:'pc', 'playstation 5':'ps5', ps5:'ps5', 'playstation 4':'ps4', ps4:'ps4',
  'xbox series':'xbox','xbox series x':'xbox','xbox series s':'xbox','xbox one':'xbox',
  'nintendo switch':'nintendo', switch:'nintendo',
  ios:'ios', android:'android', mac:'pc', linux:'pc',
  'playstation 3':'ps3', ps3:'ps3', 'xbox 360':'xbox360',
  'playstation 2':'ps2', ps2:'ps2',
};

function mapPlatform(t) {
  if (!t) return 'pc';
  const s = t.toLowerCase().trim();
  for (const [k,v] of Object.entries(PLATFORM_MAP))
    if (s.includes(k)) return v;
  return 'pc';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function newPage(browser) {
  const p = await browser.newPage();
  await p.setUserAgent(UA);
  return p;
}

async function getPageCount(browser) {
  const p = await newPage(browser);
  await p.goto(BASE + '/tous-les-jeux/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const html = await p.content();
  await p.close();
  const $ = cheerio.load(html);
  const m = $('.cardListHeader__count').text().replace(/\s/g,'').match(/(\d+)/);
  if (!m) throw new Error('Impossible de trouver le nombre total de jeux');
  const total = parseInt(m[1]);
  const pages = Math.ceil(total / PER_PAGE);
  console.log(`[INFO] ${total} jeux, ${pages} pages (${PER_PAGE} par page)`);
  return pages;
}

async function scrapePage(browser, pageNum) {
  const p = await newPage(browser);
  const url = BASE + '/tous-les-jeux/?p=' + pageNum;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const html = await p.content();
  await p.close();
  if (html.length < 500) throw new Error('Page trop petite: ' + html.length + ' bytes');
  const $ = cheerio.load(html);
  const games = [];
  $('li.cardList__item').each((_, li) => {
    const $c = $(li).find('div.cardGameList');
    if (!$c.length) return;
    const $a = $c.find('a.cardGameList__gameTitleLink');
    const title = $a.text().trim();
    const href = $a.attr('href') || '';
    const m = href.match(/jeu-(\d+)/);
    if (!m || !title) return;
    const platText = $c.find('.cardGameList__gamePlatforms').text().trim().replace(/\s+/g,' ');
    const cover = $c.find('img.cardGameList__image').attr('data-src') || $c.find('img.cardGameList__image').attr('src') || '';
    const desc = $c.find('.cardGameList__gameDescription').text().trim();
    const rel = $c.find('.cardGameList__releaseDate').text().replace('Sortie:','').trim();
    const y = rel.match(/(\d{4})/) ? parseInt(rel.match(/(\d{4})/)[1]) : 0;
    const edScore = $c.find('.cardGameList__hubItemRating--editorial').text().trim();
    const usScore = $c.find('.cardGameList__hubItemRating--opinions').text().trim();
    let cv = cover;
    if (cover && !cover.startsWith('http')) cv = cover.startsWith('//') ? 'https:'+cover : BASE+cover;
    games.push({
      game_id: 'jv-'+m[1], title,
      platform: mapPlatform(platText.split(' ')[0] || 'pc'),
      cover: cv, genre: '', year: y, description: desc,
      developer: '', publisher: '',
      editorial_score: edScore, user_score: usScore,
      platforms_raw: platText,
      jv_url: href.startsWith('http') ? href : BASE+href,
    });
  });
  return games;
}

(async () => {
  console.log('=== SCRAPER JV — Tous les jeux ===');
  console.log('Sortie:', OUTPUT);
  const startTime = Date.now();

  // Resume from progress
  let resumePage = 1;
  let allGames = [];
  try {
    const saved = JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
    if (saved?.page > 1) {
      resumePage = saved.page;
      allGames = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
      console.log(`[RESUME] reprise page ${resumePage} (${allGames.length} jeux déjà scrapés)`);
    }
  } catch {}

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox'],
  });

  try {
    const totalPages = await getPageCount(browser);
    console.log('[DEBUT] scrapage...\n');

    const endPage = MAX_PAGES > 0 ? Math.min(totalPages, resumePage + MAX_PAGES - 1) : totalPages;
    for (let pg = resumePage; pg <= endPage; pg++) {
      let games = [];
      let ok = false;
      for (let retry = 0; retry <= 3; retry++) {
        try {
          if (retry > 0) { console.log(`  [RETRY ${retry}] page ${pg}...`); await sleep(3000 * retry); }
          games = await scrapePage(browser, pg);
          ok = true;
          break;
        } catch (e) { console.error(`  [ERREUR] page ${pg} tentative ${retry+1}: ${e.message}`); }
      }
      if (!ok) { console.error(`  [ABANDON] page ${pg}`); continue; }
      if (games.length === 0) { console.log(`  Page ${pg}: 0 jeux (fin)`); break; }

      for (const g of games) allGames.push(g);
      console.log(`  Page ${pg}/${totalPages}: ${games.length} jeux`);
      console.log(`    → Total: ${allGames.length} jeux`);

      // Save every 5 pages
      if (pg % 5 === 0 || pg === totalPages) {
        fs.writeFileSync(PROGRESS, JSON.stringify({ page: pg + 1 }));
        const uniq = new Map();
        for (const g of allGames) { if (!uniq.has(g.game_id)) uniq.set(g.game_id, g); }
        fs.writeFileSync(OUTPUT, JSON.stringify(Array.from(uniq.values()), null, 2));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`  [SAUVEGARDE] Page ${pg} — ${uniq.size} jeux uniques (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
      }

      await sleep(200 + Math.random() * 600);
    }
  } finally {
    await browser.close();
  }

  // Final save with dedup
  console.log('\n=== DEDUPLICATION ===');
  const uniq = new Map();
  for (const g of allGames) { if (!uniq.has(g.game_id)) uniq.set(g.game_id, g); }
  allGames = Array.from(uniq.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(allGames, null, 2));
  try { fs.unlinkSync(PROGRESS); } catch {}
  const sizeMB = Math.round(fs.statSync(OUTPUT).size / 1024 / 1024 * 10) / 10;
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== TERMINÉ: ${allGames.length} jeux (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
  process.exit(0);
})();
