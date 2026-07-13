const path = require('path');
const fs = require('fs');
// Load env vars from root .env
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}
const db = require('./db');

(async () => {
  console.log('=== Import RAWG JSON files ===');
  const dataDir = path.join(__dirname, 'data');
  const files = ['rawg-catalog1.json', 'rawg-catalog2.json'];

  for (const file of files) {
    const fpath = path.join(dataDir, file);
    if (!fs.existsSync(fpath)) {
      console.log(`${file} non trouvé, ignoré`);
      continue;
    }
    const stats = fs.statSync(fpath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`Chargement de ${file} (${sizeMB}MB)...`);
    const games = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
    console.log(`${file}: ${games.length} jeux parsés`);
    await db.batchUpsertCatalog(games);
  }

  console.log('=== Import terminé ===');
  process.exit(0);
})().catch(e => {
  console.error('Erreur:', e.message);
  process.exit(1);
});
