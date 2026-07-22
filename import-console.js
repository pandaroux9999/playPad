const db = require('./db.js');
const fs = require('fs');
const games = JSON.parse(fs.readFileSync('./data/rawg-console.json', 'utf-8'));
console.log('Jeux:', games.length);
db.batchUpsertCatalog(games).then(() => {
  console.log('Import terminé');
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
