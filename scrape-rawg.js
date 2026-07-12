const https = require('https');
const fs = require('fs');
const path = require('path');

// Usage: node scrape-rawg.js [RAWG_API_KEY]
// Ou définir RAWG_API_KEY dans les variables d'environnement
const KEY = process.argv[2] || process.env.RAWG_API_KEY;
if (!KEY) {
  console.error('ERREUR: RAWG_API_KEY manquante.');
  console.error('Usage: node scrape-rawg.js VOTRE_CLE_API');
  console.error('Ou:    set RAWG_API_KEY=VOTRE_CLE_API && node scrape-rawg.js');
  console.error('');
  console.error('Obtenir une clé gratuite: https://rawg.io/apidocs');
  process.exit(1);
}

const OUTPUT = path.join(__dirname, 'Site', 'server', 'data', 'rawg-catalog.json');
const PROGRESS = path.join(__dirname, 'Site', 'server', 'data', 'rawg-progress.json');

const PLATFORMS = [
  { id: 4,  name: 'PC' },
  { id: 187, name: 'PS5' },
  { id: 18, name: 'PS4' },
  { id: 186, name: 'Xbox Series' },
  { id: 1,  name: 'Xbox One' },
  { id: 7,  name: 'Nintendo Switch' },
];

const PLATFORM_MAP = { 4:'pc', 187:'ps5', 18:'ps4', 186:'xbox', 1:'xbox', 7:'nintendo' };

// Années de 1990 à 2026 (par palliers pour rester dans les 40 résultats par page)
const YEAR_RANGES = [];
for (let y = 1990; y <= 2026; y++) YEAR_RANGES.push(y);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Parse: '+e.message)); }
      });
    }).on('error', reject);
  });
}

function mapAgeRating(esrb) {
  if (!esrb) return 0;
  const n = esrb.name || '';
  if (n.includes('Mature') || n.includes('18')) return 18;
  if (n.includes('Teen') || n.includes('16')) return 16;
  if (n.includes('12') || n.includes('10')) return 12;
  if (n.includes('Everyone') || n.includes('3') || n.includes('6')) return 3;
  return 0;
}

(async () => {
  console.log('=== SCRAPER RAWG ===');
  console.log('API Key:', KEY.slice(0, 6) + '...');
  console.log('Sortie:', OUTPUT, '\n');

  let allGames = [];
  let resumePlatform = 0;
  let resumeYear = 0;
  let resumePage = 1;
  try {
    const s = JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
    if (s.platformIdx != null && (s.yearIdx > 0 || s.page > 1)) {
      resumePlatform = s.platformIdx || 0;
      resumeYear = s.yearIdx || 0;
      resumePage = s.page || 1;
      allGames = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
      console.log(`[RESUME] plateforme #${resumePlatform}, année #${resumeYear}, page ${resumePage} (${allGames.length} jeux déjà scrapés)\n`);
    }
  } catch {}

  const startTime = Date.now();
  let totalScraped = 0;

  for (let pi = resumePlatform; pi < PLATFORMS.length; pi++) {
    const plat = PLATFORMS[pi];
    const platName = plat.name;
    const platId = plat.id;

    let yi = (pi === resumePlatform) ? resumeYear : 0;
    for (; yi < YEAR_RANGES.length; yi++) {
      const year = YEAR_RANGES[yi];
      let page = (pi === resumePlatform && yi === resumeYear) ? resumePage : 1;
      let hasNext = true;

      while (hasNext) {
        const url = `https://api.rawg.io/api/games?key=${KEY}&platforms=${platId}&dates=${year}-01-01,${year}-12-31&ordering=-rating&page=${page}&page_size=40`;
        let data = null;
        for (let r = 0; r <= 3; r++) {
          try {
            if (r > 0) await sleep(2000 * r);
            data = await fetchJSON(url);
            break;
          } catch (e) {
            if (r < 3) console.log(`  [RETRY ${r+1}] ${platName} ${year} page ${page}: ${e.message}`);
            else console.error(`  [ABANDON] ${platName} ${year} page ${page}`);
          }
        }
        if (!data || !data.results) break;

        const games = data.results.map(g => ({
          game_id: `rawg-${g.id}`,
          title: g.name,
          platform: PLATFORM_MAP[platId] || 'pc',
          cover: g.background_image || '',
          genre: (g.genres || []).map(x => x.name).join(', '),
          year: g.released ? parseInt(g.released.split('-')[0]) : year,
          description: g.description_raw || '',
          developer: '',
          publisher: '',
          editorial_score: '',
          user_score: g.rating ? (g.rating * 2).toFixed(1) + '/20' : '',
          platforms_raw: (g.platforms || []).map(p => p.platform.name).join(', '),
          age_rating: mapAgeRating(g.esrb_rating),
          release_date: g.released || '',
          metacritic: g.metacritic || 0,
        }));

        let newCount = 0;
        for (const game of games) {
          allGames.push(game);
          newCount++;
          totalScraped++;
        }
        console.log(`[${platName}] ${year} page ${page}: ${newCount} jeux`);

        await sleep(300);

        // Save progress every 10 pages
        if (page % 10 === 0) {
          fs.writeFileSync(PROGRESS, JSON.stringify({ platformIdx: pi, yearIdx: yi, page: page + 1 }));
          const uniq = new Map();
          for (const g of allGames) { if (!uniq.has(g.game_id)) uniq.set(g.game_id, g); }
          const arr = Array.from(uniq.values());
          fs.writeFileSync(OUTPUT, JSON.stringify(arr, null, 2));
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  [SAUVEGARDE] ${arr.length} jeux uniques (${Math.floor(elapsed/60)}m${elapsed%60}s)`);
        }

        hasNext = data.next !== null;
        page++;
      }

      console.log(`  → ${platName} ${year} terminé`);
    }
    console.log(`  ── ${platName} FINI ──\n`);
  }

  // Final save
  console.log('\n=== DEDUPLICATION ===');
  const uniq = new Map();
  for (const g of allGames) { if (!uniq.has(g.game_id)) uniq.set(g.game_id, g); }
  const final = Array.from(uniq.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(final, null, 2));
  try { fs.unlinkSync(PROGRESS); } catch {}

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const sizeMB = Math.round(fs.statSync(OUTPUT).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${final.length} jeux uniques (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
  console.log('Fichier:', OUTPUT);
  process.exit(0);
})();
