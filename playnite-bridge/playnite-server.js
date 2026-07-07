/**
 * playnite-server.js
 *
 * Local Express server that reads Playnite's SQLite database and exposes it
 * via HTTP for PlayPad's frontend (or any other local app).
 *
 * Usage:
 *   1. npm install
 *   2. node playnite-server.js
 *   3. PlayPad sync will connect to http://localhost:3456
 *
 * Environment variables:
 *   PLAYNITE_BRIDGE_PORT  - Port to listen on (default: 3456)
 *   PLAYNITE_DB_PATH      - Custom path to library.db (default: %AppData%\Playnite\library.db)
 *   BRIDGE_API_KEY        - OBLIGATOIRE : clé API pour sécuriser l'accès (sinon 403)
 *
 * Future extensibility (add new sources):
 *   Each source adapter exports { readGames(config) } → Array<Game>
 *   Register it in the router below with a new endpoint, e.g.:
 *     app.get('/api/steam', async (req, res) => {
 *       const games = await require('./steam-web-reader').readGames(...);
 *       res.json({ games });
 *     });
 */

const express = require('express');
const cors = require('cors');
const { readPlayniteGames, filterByPlatform, groupByPlatform, getDefaultDbPath } = require('./playnite-reader');

const PORT = parseInt(process.env.PLAYNITE_BRIDGE_PORT, 10) || 3456;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

if (!BRIDGE_API_KEY || BRIDGE_API_KEY.length < 8) {
  console.error('BRIDGE_API_KEY est obligatoire (min 8 caractères). Définis-la dans les variables d\'environnement.');
  process.exit(1);
}

const app = express();
app.use(cors());

// Middleware d'authentification par API key
function requireBridgeAuth(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : req.query.apiKey;
  if (!token || token !== BRIDGE_API_KEY) {
    return res.status(403).json({ error: 'Accès refusé. Fournis un header Authorization: Bearer <BRIDGE_API_KEY> ou ?apiKey=<clé>' });
  }
  next();
}

// Middleware: wrap the reader call with error handling
function withPlayniteDb(fn) {
  return (req, res) => {
    try {
      const dbPath = process.env.PLAYNITE_DB_PATH;
      const games = readPlayniteGames(dbPath);
      fn(req, res, games);
    } catch (err) {
      res.status(500).json({
        error: err.message,
        hint: 'Make sure Playnite is installed and has been launched at least once. ' +
              'Set PLAYNITE_DB_PATH env var if your library.db is at a custom location.',
      });
    }
  };
}

// GET /games — Return the full list of games from Playnite
app.get('/games', requireBridgeAuth, withPlayniteDb((req, res, games) => {
  res.json({
    games,
    total: games.length,
    generated: new Date().toISOString(),
    source: 'playnite',
  });
}));

// GET /games/:platform — Filter by platform alias (steam, epic, xbox, etc.)
app.get('/games/:platform', requireBridgeAuth, withPlayniteDb((req, res, games) => {
  const platform = req.params.platform.toLowerCase();
  const filtered = filterByPlatform(games, platform);
  res.json({
    platform,
    games: filtered,
    total: filtered.length,
  });
}));

// GET /platforms — List all available platforms and game counts
app.get('/platforms', requireBridgeAuth, withPlayniteDb((req, res, games) => {
  const groups = groupByPlatform(games);
  const platforms = Object.entries(groups).map(([id, list]) => ({
    id,
    label: list[0].platformLabel || id,
    count: list.length,
  }));
  res.json({ platforms });
}));

// GET /health — Simple health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: getDefaultDbPath() });
});

app.listen(PORT, () => {
  console.log(`[Playnite Bridge] Server running on http://localhost:${PORT}`);
  console.log(`[Playnite Bridge] Database: ${process.env.PLAYNITE_DB_PATH || getDefaultDbPath()}`);
  console.log(`[Playnite Bridge] Endpoints:`);
  console.log(`  GET http://localhost:${PORT}/health`);
  console.log(`  GET http://localhost:${PORT}/games`);
  console.log(`  GET http://localhost:${PORT}/games/:platform`);
  console.log(`  GET http://localhost:${PORT}/platforms`);
});
