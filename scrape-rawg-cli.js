const https = require('https');
const fs = require('fs');
const path = require('path');

const KEY = process.argv[2] || process.env.RAWG_API_KEY;
if (!KEY) {
  console.error('Usage: node scrape-rawg-cli.js [API_KEY]');
  console.error('Ou définir RAWG_API_KEY dans .env');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'Site', 'server', 'data');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PLATFORMS = [
  { id: 187, prefix: 'ps5',   name: 'PS5' },
  { id: 18,  prefix: 'ps4',   name: 'PS4' },
  { id: 186, prefix: 'xbox',  name: 'Xbox Series' },
  { id: 1,   prefix: 'xbox',  name: 'Xbox One' },
  { id: 7,   prefix: 'nintendo', name: 'Nintendo' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function saveProgress(data) {
  fs.writeFileSync(path.join(OUT_DIR, 'scrape-progress.json'), JSON.stringify(data));
}

function saveDataFile(games, label) {
  const filePath = path.join(OUT_DIR, label);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(games));
  fs.renameSync(tmp, filePath);
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'scrape-progress.json'), 'utf-8')); } catch { return null; }
}

(async () => {
  console.log('=== Scrape RAWG Console ===');
  console.log('API Key:', KEY.slice(0, 6) + '...');

  let allGames = [];
  let startPi = 0, startPage = 1;
  const prog = loadProgress();
  if (prog && prog.pi != null) {
    startPi = prog.pi;
    startPage = prog.page || 1;
    try {
      if (prog.savedPage && prog.savedPage < startPage) {
        // Resume from last saved file page, re-scrape the lost pages
        startPage = prog.savedPage;
        console.log(`  [RESUME] savedPage=${prog.savedPage} < progressPage=${prog.page}, reprise page ${startPage}`);
      }
      allGames = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'rawg-console-all.json'), 'utf-8'));
      console.log(`Reprise: plateforme #${startPi} page ${startPage} (${allGames.length} jeux déjà scrapés)`);
    } catch {}
  }

  const startTime = Date.now();
  let total = allGames.length;

  for (let pi = startPi; pi < PLATFORMS.length; pi++) {
    const plat = PLATFORMS[pi];
    const seen = new Set(allGames.map(g => g.game_id));
    let page = (pi === startPi) ? startPage : 1;
    let hasMore = true;
    let platTotal = 0;
    let errCount = 0;

    console.log(`\n── ${plat.name} (id=${plat.id}) ──`);

    while (hasMore) {
      const url = `https://api.rawg.io/api/games?key=${KEY}&platforms=${plat.id}&page=${page}&page_size=40&ordering=-added`;
      let data = null;

      for (let retry = 0; retry <= 3; retry++) {
        try {
          if (retry > 0) await sleep(2000 * retry);
          data = await fetchJSON(url);
          break;
        } catch (e) {
          if (retry < 3) console.log(`  [R] page ${page}: ${e.message}`);
          else console.error(`  [X] page ${page}: abandon`);
        }
      }

      if (!data || !data.results) { hasMore = false; break; }

      let added = 0;
      for (const g of data.results) {
        if (!g.name) continue;
        const gameId = `${plat.prefix}-${g.id}`;
        if (seen.has(gameId)) continue;
        seen.add(gameId);
        allGames.push({
          game_id: gameId,
          title: g.name,
          platform: plat.prefix,
          cover: g.background_image || '',
          genre: (g.genres || []).map(x => x.name).join(', '),
          year: g.released ? (parseInt(g.released.split('-')[0]) || 0) : 0,
          developer: '',
          publisher: '',
          description: '',
          editorial_score: '',
          user_score: '',
          platforms_raw: (g.platforms || []).map(p => p.platform.name).join(', '),
          age_rating: 0,
        });
        added++;
      }

      total += added;
      platTotal += added;
      console.log(`  [${plat.name}] page ${page}: +${added} (${total} total)`);

      if (page % 20 === 0) {
        try {
          saveDataFile(allGames, 'rawg-console-all.json');
          console.log(`  [SAVE] ${allGames.length} jeux`);
          saveProgress({ pi, savedPage: page, page: page + 1 });
        } catch (e) {
          console.log(`  [SAVE WARN] ${e.message}`);
          try { saveDataFile(allGames, 'rawg-console-all.bak'); } catch {}
          saveProgress({ pi, page: page + 1 });
        }
      } else {
        saveProgress({ pi, page: page + 1 });
      }

      await sleep(300);
      hasMore = data.next !== null;
      page++;
    }

    console.log(`  → ${plat.name}: ${platTotal} jeux ajoutés`);
  }

  // Final save
  try {
    saveDataFile(allGames, 'rawg-console-all.json');
  } catch (e) {
    console.log(`[SAVE FINAL WARN] ${e.message}`);
    saveDataFile(allGames, 'rawg-console-all.bak');
  }
  try { fs.unlinkSync(path.join(OUT_DIR, 'scrape-progress.json')); } catch {}

  // Split into 2 files if large
  const MAX_PER_FILE = 100000;
  if (allGames.length > MAX_PER_FILE) {
    const mid = Math.ceil(allGames.length / 2);
    saveDataFile(allGames.slice(0, mid), 'rawg-console1.json');
    saveDataFile(allGames.slice(mid), 'rawg-console2.json');
    console.log(`\nFichiers: rawg-console1.json (${mid}), rawg-console2.json (${allGames.length - mid})`);
  } else {
    saveDataFile(allGames, 'rawg-console.json');
    console.log(`\nFichier: rawg-console.json (${allGames.length})`);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const sizeMB = Math.round(fs.statSync(path.join(OUT_DIR, 'rawg-console-all.json')).size / 1024 / 1024 * 10) / 10;
  console.log(`\n=== TERMINÉ: ${allGames.length} jeux (${sizeMB}MB) en ${Math.floor(elapsed/60)}m${elapsed%60}s ===`);
})();
