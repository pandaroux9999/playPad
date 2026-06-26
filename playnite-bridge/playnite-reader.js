/**
 * playnite-reader.js
 *
 * Reads Playnite's SQLite database (library.db) and returns a structured
 * list of games. Can be used as:
 *   - A module (require or import)
 *   - A CLI tool (node playnite-reader.js [path/to/library.db])
 *
 * Playnite stores its database at:
 *   %AppData%\Playnite\library.db
 *   → C:\Users\<USER>\AppData\Roaming\Playnite\library.db
 *
 * Extensibility: This module is the single point of contact with Playnite.
 * To add other sources (Steam Web API, Xbox API, etc.), create sister
 * modules (e.g. steam-web-reader.js) with the same interface:
 *   async function readGames(config) → Array<Game>
 */

const path = require('path');
const os = require('os');

/**
 * Resolves the default Playnite library.db path on Windows.
 * @returns {string}
 */
function getDefaultDbPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Playnite', 'library.db');
}

/**
 * Platform name normalisation map: Playnite's platform string → PlayPad's id.
 * Add new mappings here when integrating additional libraries.
 */
const PLATFORM_ALIASES = {
  'Steam':           'steam',
  'Epic Games':      'epic',
  'Epic':            'epic',
  'GOG':             'gog',
  'GOG Galaxy':      'gog',
  'Ubisoft Connect': 'ubisoft',
  'Uplay':           'ubisoft',
  'EA Desktop':      'ea',
  'Origin':          'ea',
  'Xbox':            'xbox',
  'Microsoft Store': 'xbox',
  'Xbox Game Pass':  'xbox',
  'PSN':             'ps5',
  'PlayStation':     'ps5',
  'Nintendo':        'nintendo',
  'Battle.net':      'battlenet',
  'Amazon Games':    'amazon',
  'itch.io':         'itch',
};

/**
 * Read all games from Playnite's library.db.
 *
 * @param {string} [dbPath] - Full path to library.db. Defaults to %AppData%\Playnite\library.db.
 * @returns {Array<Object>} List of game objects:
 *   { id, name, platform, platformId, gameId, pluginId, playtime, lastActivity, added }
 *
 * @throws {Error} If the database cannot be opened or the table is missing.
 */
function readPlayniteGames(dbPath) {
  const resolvedPath = dbPath || getDefaultDbPath();
  // Dynamically require better-sqlite3 so this module can also be used as a CLI
  // without installing deps when only the JSON export is needed.
  const Database = require('better-sqlite3');
  const fs = require('fs');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Playnite database not found at: ${resolvedPath}\n` +
      `Make sure Playnite is installed and has been launched at least once.\n` +
      `You can specify a custom path by passing it as an argument or via PLAYNITE_DB_PATH env variable.`
    );
  }

  let db;
  try {
    db = new Database(resolvedPath, { readonly: true });
  } catch (err) {
    throw new Error(`Cannot open Playnite database: ${err.message}`);
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        Id,
        Name,
        Platform,
        GameId,
        PluginId,
        Playtime,
        LastActivity,
        Added,
        IsInstalled
      FROM Games
      ORDER BY Name ASC
    `).all();
  } catch (err) {
    db.close();
    throw new Error(`Cannot read Games table: ${err.message}`);
  }
  db.close();

  return rows.map(r => ({
    id:             r.Id,
    name:           r.Name || 'Unknown',
    platform:       PLATFORM_ALIASES[r.Platform] || (r.Platform || 'unknown').toLowerCase().replace(/\s+/g, ''),
    platformLabel:  r.Platform || 'Unknown',
    gameId:         r.GameId || '',
    pluginId:       r.PluginId || '',
    playtime:       r.Playtime || 0,
    lastActivity:   r.LastActivity || null,
    added:          r.Added || null,
    isInstalled:    !!r.IsInstalled,
  }));
}

/**
 * Filter games by platform alias.
 * @param {Array} games
 * @param {string} platform - e.g. 'steam', 'epic', 'xbox'
 * @returns {Array}
 */
function filterByPlatform(games, platform) {
  return games.filter(g => g.platform === platform.toLowerCase());
}

/**
 * Group games by platform.
 * @param {Array} games
 * @returns {Object} { steam: [...], epic: [...], ... }
 */
function groupByPlatform(games) {
  const groups = {};
  for (const g of games) {
    if (!groups[g.platform]) groups[g.platform] = [];
    groups[g.platform].push(g);
  }
  return groups;
}

// ── CLI usage ──────────────────────────────────────────────────────────────
// Run with: node playnite-reader.js [path/to/library.db]
//   Export to file:    node playnite-reader.js
//   Push to PlayPad:   node playnite-reader.js --push https://playpad-pfh7.onrender.com
//
// For --push, provide credentials via env vars:
//   $env:PLAYPAD_USER="monlogin"; $env:PLAYPAD_PASS="monpass"; node playnite-reader.js --push https://playpad-pfh7.onrender.com
//
if (require.main === module) {
  const args = process.argv.slice(2);
  const pushIndex = args.indexOf('--push');
  const pushUrl = pushIndex !== -1 ? args[pushIndex + 1] : null;
  const dbPath = (pushIndex > 0 ? args[0] : args[0] && args[0] !== '--push' ? args[0] : null) || process.env.PLAYNITE_DB_PATH;

  try {
    const games = readPlayniteGames(dbPath);
    const mapped = games.map(g => ({
      game_id: (g.platform || 'unknown') + '-' + (g.gameId || g.id),
      title: g.name,
      platform: g.platform,
      playtime: Math.round(g.playtime / 60),
      status: g.playtime > 0 ? 'playing' : 'not_started',
      cover: '',
      genre: '',
      year: 0,
      user_rating: 0,
      review_text: '',
      review_public: true,
      has_review: 0,
    }));

    if (pushUrl) {
      // Push directly to PlayPad's API on Render
      const https = require(pushUrl.startsWith('https') ? 'https' : 'http');
      const username = process.env.PLAYPAD_USER;
      const password = process.env.PLAYPAD_PASS;
      if (!username || !password) {
        console.error('Set PLAYPAD_USER and PLAYPAD_PASS env vars to authenticate.');
        process.exit(1);
      }
      const loginData = JSON.stringify({ username, password });
      const u = new URL(pushUrl);
      const reqLogin = https.request(`${u.protocol}//${u.host}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error('Login failed:', body);
            process.exit(1);
          }
          const gameData = JSON.stringify({ games: mapped });
          const cookie = res.headers['set-cookie']?.[0]?.split(';')[0] || '';
          const reqSync = https.request(`${u.protocol}//${u.host}/api/games/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(gameData), 'Cookie': cookie },
          }, (res2) => {
            let body2 = '';
            res2.on('data', c => body2 += c);
            res2.on('end', () => {
              if (res2.statusCode === 200) {
                console.log(`✅ ${mapped.length} jeux envoyés à ${pushUrl}`);
              } else {
                console.error('Sync failed:', body2);
                process.exit(1);
              }
            });
          });
          reqSync.write(gameData);
          reqSync.end();
        });
      });
      reqLogin.write(loginData);
      reqLogin.end();
    } else {
      const out = JSON.stringify({ games: mapped, total: mapped.length, generated: new Date().toISOString() }, null, 2);
      const outPath = path.join(__dirname, 'playnite-export.json');
      require('fs').writeFileSync(outPath, out, 'utf-8');
      console.log(`Exported ${mapped.length} games to ${outPath}`);
      console.log('Tip: run with --push <url> to send directly to PlayPad.');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { readPlayniteGames, filterByPlatform, groupByPlatform, getDefaultDbPath };
