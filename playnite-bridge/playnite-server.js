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
const app = express();
app.use(cors());

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
app.get('/games', withPlayniteDb((req, res, games) => {
  res.json({
    games,
    total: games.length,
    generated: new Date().toISOString(),
    source: 'playnite',
  });
}));

// GET /games/:platform — Filter by platform alias (steam, epic, xbox, etc.)
app.get('/games/:platform', withPlayniteDb((req, res, games) => {
  const platform = req.params.platform.toLowerCase();
  const filtered = filterByPlatform(games, platform);
  res.json({
    platform,
    games: filtered,
    total: filtered.length,
  });
}));

// GET /platforms — List all available platforms and game counts
app.get('/platforms', withPlayniteDb((req, res, games) => {
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
