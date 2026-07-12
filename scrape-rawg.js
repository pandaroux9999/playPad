const https = require('https');
const fs = require('fs');
const path = require('path');

const KEY = process.argv[2] || process.env.RAWG_API_KEY;
if (!KEY) {
  console.error('ERREUR: RAWG_API_KEY manquante.');
  console.error('Usage: node scrape-rawg.js VOTRE_CLE_API');
  console.error('Obtenir une clé gratuite: https://rawg.io/apidocs');
  process.exit(1);
}

const OUTPUT = path.join(__dirname, 'Site', 'server', 'data', 'rawg-catalog.json');
const PROGRESS = path.join(__dirname, 'Site', 'server', 'data', 'rawg-progress.json');

const PLATFORMS = [
  { id: 4,   name: 'PC' },
  { id: 187, name: 'PS5' },
  { id: 18,  name: 'PS4' },
  { id: 16,  name: 'PS3' },
  { id: 186, name: 'Xbox Series' },
  { id: 1,   name: 'Xbox One' },
  { id: 11,  name: 'Xbox 360' },
  { id: 7,   name: 'Nintendo Switch' },
  { id: 8,   name: 'Nintendo 3DS' },
  { id: 10,  name: 'Wii U' },
  { id: 3,   name: 'iOS' },
  { id: 21,  name: 'Android' },
  { id: 5,   name: 'macOS' },
  { id: 6,   name: 'Linux' },
];

const PLATFORM_MAP = {
  4:'pc', 187:'ps5', 18:'ps4', 16:'ps3',
  186:'xbox', 1:'xbox', 11:'xbox360',
  7:'nintendo', 8:'nintendo', 10:'nintendo',
  3:'ios', 21:'android', 5:'pc', 6:'pc',
};

const YEAR_RANGES = [];
for (let y = 1990; y <= 2026; y++) YEAR_RANGES.push(y);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + Date.now();
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[ERREUR ÉCRITURE] ${filePath}: ${e.message}`);
  }
}

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

// Merge games with the same title: combine platforms, keep best cover/description
function mergeByTitle(games) {
  const map = new Map();
  for (const g of games) {
    const key = g.title.toLowerCase().trim();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...g, platform: g.platform });
    } else {
      // Combine platforms (deduplicate)
      const platforms = [existing.platform, g.platform].filter(Boolean);
      existing.platform = [...new Set(platforms.flatMap(p => p.split(',').map(x => x.trim())))].join(',');
      // Keep non-empty cover
      if (!existing.cover && g.cover) existing.cover = g.cover;
      // Keep longer description
      if ((g.description || '').length > (existing.description || '').length) existing.description = g.description;
      // Keep best user score
      const es = parseFloat(g.user_score);
      const ee = parseFloat(existing.user_score);
      if (es && (!ee || es > ee)) existing.user_score = g.user_score;
      // Merge platforms_raw
      const rawSet = new Set();
      for (const r of [existing.platforms_raw, g.platforms_raw].filter(Boolean)) {
        r.split(',').map(x => x.trim()).filter(Boolean).forEach(x => rawSet.add(x));
      }
      existing.platforms_raw = [...rawSet].join(', ');
      // Keep higher age rating
      if (g.age_rating > (existing.age_rating || 0)) existing.age_rating = g.age_rating;
    }
  }
  return Array.from(map.values());
}

(async () => {
  console.log('=== SCRAPER RAWG ===');
  console.log('API Key:', KEY.slice(0, 6) + '...');
  console.log('Plateformes:', PLATFORMS.map(p => p.name).join(', '));
  console.log('Sortie:', OUTPUT, '\n');

  let allGames = [];
  let resumePlatform = 0;
  let resumeYear = 0;
  let resumePage = 1;
  try {
    const s = JSON.parse(fs.readFileSync(PROGRESS, 'utf-8'));
    if (s.platformIdx != null && s.yearIdx != null && (s.yearIdx > 0 || s.page > 1)) {
      resumePlatform = s.platformIdx || 0;
      resumeYear = s.yearIdx || 0;
      resumePage = s.page || 1;
      allGames = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
      console.log(`[RESUME] plateforme #${resumePlatform}, année #${resumeYear}, page ${resumePage} (${allGames.length} jeux déjà scrapés)\n`);
    } else if (s.platformIdx != null && s.yearIdx == null) {
      console.log('[INFO] Ancien format de progression ignoré — redémarrage de zéro');
      try { fs.unlinkSync(PROGRESS); } catch {}
    }
  } catch {}

  const startTime = Date.now();

  for (let pi = resumePlatform; pi < PLATFORMS.length; pi++) {
    const plat = PLATFORMS[pi];
    const platName = plat.name;
    const platId = plat.id;

    let yi = (pi === resumePlatform) ? resumeYear : 0;
    for (; yi < YEAR_RANGES.length; yi++) {
      const year = YEAR_RANGES[yi];
      let page = (pi === resumePlatform && yi === resumeYear) ? resumePage : 1;
      let hasNext = true;
      let yearGames = 0;

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

        for (const g of data.results) {
          allGames.push({
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
          });
          yearGames++;
        }
        console.log(`[${platName}] ${year} page ${page}: ${data.results.length} jeux`);

        await sleep(300);

        // Sauvegarde du progrès
        safeWrite(PROGRESS, JSON.stringify({ platformIdx: pi, yearIdx: yi, page: page + 1 }));

        hasNext = data.next !== null;
        page++;
      }
      console.log(`  → ${platName} ${year}: ${yearGames} ajoutés`);
    }
    console.log(`  ── ${platName} FINI ──\n`);
  }

  console.log('\n=== FUSION PAR TITRE ===');
  const final = mergeByTitle(allGames);
  safeWrite(OUTPUT, JSON.stringify(final, null, 2));
  try { fs.unlinkSync(PROGRESS); } catch {}

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const sizeMB = Math.round(fs.statSync(OUTPUT).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${final.length} jeux (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
  console.log('Fichier:', OUTPUT);
  process.exit(0);
})();
