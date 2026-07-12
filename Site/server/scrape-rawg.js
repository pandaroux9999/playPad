const https = require('https');
const fs = require('fs');
const path = require('path');
// Charge .env si présent (pour exécution locale)
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

const RAWG_KEY = process.env.RAWG_API_KEY;
if (!RAWG_KEY) { console.error('ERREUR: RAWG_API_KEY non définie dans .env'); process.exit(1); }

const OUTPUT = path.join(__dirname, 'data', 'rawg-catalog.json');
const PROGRESS = path.join(__dirname, 'data', 'rawg-progress.json');
const DELAY_MS = 250;
const MAX_RETRIES = 3;

const PLATFORMS = [
  { rawg: 4,  name: 'PC' },
  { rawg: 187, name: 'PS5' },
  { rawg: 18, name: 'PS4' },
  { rawg: 186, name: 'Xbox Series' },
  { rawg: 1,  name: 'Xbox One' },
  { rawg: 7,  name: 'Nintendo Switch' },
];

const RAWGS_TO_PLAY = { 4: 'pc', 187: 'ps5', 18: 'ps4', 186: 'xbox', 1: 'xbox', 7: 'nintendo' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('=== Scraping RAWG ===');
  console.log(`Clé API: ${RAWG_KEY.slice(0, 6)}...`);
  console.log(`Sortie: ${OUTPUT}\n`);

  let allGames = [];
  let resumePlatform = 0;
  let resumePage = 1;
  try {
    const saved = JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
    if (saved.platformIdx != null && saved.page > 1) {
      resumePlatform = saved.platformIdx;
      resumePage = saved.page;
      allGames = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
      console.log(`Reprise: plateforme #${resumePlatform} page ${resumePage} (${allGames.length} jeux déjà scrapés)\n`);
    }
  } catch {}

  const startTime = Date.now();
  let totalGames = 0;
  let totalPages = 0;

  for (let pi = resumePlatform; pi < PLATFORMS.length; pi++) {
    const plat = PLATFORMS[pi];
    let page = (pi === resumePlatform) ? resumePage : 1;
    let hasNext = true;
    let platformGames = 0;
    let platformPages = 0;

    console.log(`── ${plat.name} ──`);

    while (hasNext) {
      const url = `https://api.rawg.io/api/games?key=${RAWG_KEY}&platforms=${plat.rawg}&page=${page}&page_size=40`;
      let data = null;

      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          if (retry > 0) await sleep(2000 * retry);
          data = await fetchJSON(url);
          break;
        } catch (e) {
          if (retry < MAX_RETRIES) console.log(`  [RETRY ${retry+1}] page ${page}: ${e.message}`);
          else console.error(`  [ABANDON] page ${page}: ${e.message}`);
        }
      }

      if (!data || !data.results) { hasNext = false; break; }

      const games = data.results.map(g => ({
        game_id: `rawg-${g.id}`,
        title: g.name,
        platform: RAWGS_TO_PLAY[plat.rawg] || 'pc',
        cover: g.background_image || '',
        genre: (g.genres || []).map(x => x.name).join(', '),
        year: g.released ? parseInt(g.released.split('-')[0]) : 0,
        description: g.description_raw || '',
        developer: '',
        publisher: '',
        rating: g.rating || 0,
        age_rating: g.esrb_rating ? (g.esrb_rating.name === 'Mature' ? 16 : g.esrb_rating.name === 'Teen' ? 12 : g.esrb_rating.name === 'Everyone' ? 3 : 0) : 0,
        platforms_raw: (g.platforms || []).map(p => p.platform.name).join(', '),
        release_date: g.released || '',
        metacritic: g.metacritic || 0,
      }));

      for (const game of games) {
        allGames.push(game);
        totalGames++;
        console.log(`  [${plat.name}] ${game.title}`);
      }

      await sleep(DELAY_MS);

      platformPages++;
      totalPages++;
      console.log(`  → Page ${page} terminée (${games.length} jeux, ${allGames.length} total)`);

      if (page % 10 === 0) {
        fs.writeFileSync(OUTPUT, JSON.stringify(allGames, null, 2));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`  [SAUVEGARDE] ${allGames.length} jeux (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
      }

      fs.writeFileSync(PROGRESS, JSON.stringify({ platformIdx: pi, page: page + 1 }, null, 2));

      hasNext = data.next !== null;
      page++;
    }

    console.log(`  ── ${plat.name} terminé: ${platformPages} pages, ${allGames.length - platformGames} jeux\n`);
  }

  // Final save
  fs.writeFileSync(OUTPUT, JSON.stringify(allGames, null, 2));
  try { fs.unlinkSync(PROGRESS); } catch {}

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const sizeMB = Math.round(fs.statSync(OUTPUT).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${allGames.length} jeux uniques (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
  console.log(`Fichier: ${OUTPUT}`);
})();
