const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const db = require('./db');
const SupabaseSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.set('trust proxy', 1);
const sessionStore = new SupabaseSessionStore();
app.use(session({
  secret: process.env.SESSION_SECRET || 'playpad-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production' || !!process.env.PUBLIC_URL,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

app.use(express.static(path.join(__dirname, '..')));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, displayName, password, email } = req.body;
    console.log('[Register] Request:', { username, displayName, email });
    if (!username || !displayName || !password || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
    }
    const existingUser = await db.getUserByUsername(username);
    if (existingUser) {
      console.log('[Register] Username taken:', username);
      return res.status(409).json({ error: 'Cet identifiant est déjà pris' });
    }
    const existingEmail = await db.getUserByEmail(email);
    if (existingEmail) {
      console.log('[Register] Email already used:', email);
      return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = await db.createUser(username, displayName, hashed, email);
    const user = await db.getUserById(userId);
    req.session.userId = userId;
    console.log('[Register] Success:', username, 'id:', userId);
    res.json({ user });
  } catch (err) {
    console.error('[Register] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'Aucun compte trouvé avec cet email' });
    const token = await db.createResetToken(user.id, 'password');
    const resetLink = (process.env.PUBLIC_URL || 'http://localhost:3000') + '/reset-password?token=' + token;
    console.log('[ForgotPassword] Token for', email, ':', resetLink);
    res.json({ ok: true, resetLink, message: 'Lien de réinitialisation généré (vérifie la console serveur)' });
  } catch (err) {
    console.error('[ForgotPassword] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/forgot-username', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'Aucun compte trouvé avec cet email' });
    console.log('[ForgotUsername] Username for', email, ':', user.username);
    res.json({ ok: true, username: user.username, message: 'Identifiant trouvé !' });
  } catch (err) {
    console.error('[ForgotUsername] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
    const rt = await db.getResetToken(token);
    if (!rt) return res.status(400).json({ error: 'Token invalide ou expiré' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await db.supabaseAdmin.from('users').update({ password: hashed }).eq('id', rt.user_id);
    if (error) throw new Error(error.message);
    await db.markResetTokenUsed(token);
    console.log('[ResetPassword] Success for user_id:', rt.user_id);
    res.json({ ok: true, message: 'Mot de passe réinitialisé avec succès' });
  } catch (err) {
    console.error('[ResetPassword] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('[Login] Request for username:', username);
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    const user = await db.getUserByUsername(username);
    if (!user) {
      console.log('[Login] User not found:', username);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    console.log('[Login] User found, comparing password');
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      console.log('[Login] Wrong password for:', username);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    req.session.userId = user.id;
    console.log('[Login] Success:', username, 'id:', user.id);
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email, created_at: user.created_at } });
  } catch (err) {
    console.error('[Login] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user });
  } catch (err) {
    console.error('[Me] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games', requireAuth, async (req, res) => {
  try {
    const games = await db.getGames(req.session.userId);
    res.json({ games });
  } catch (err) {
    console.error('[Games] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/sync', requireAuth, async (req, res) => {
  const { games } = req.body;
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: 'Format invalide' });
  }
  try {
    for (const game of games) {
      console.log('[Sync] Upserting game:', game.game_id, game.title);
      await db.upsertGame(req.session.userId, game);
      await db.ensureCatalogGame(await enrichGameFromSteam(game));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Sync] Error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/status', requireAuth, async (req, res) => {
  try {
    const { gameId, status } = req.body;
    await db.updateGameStatus(req.session.userId, gameId, status);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/review', requireAuth, async (req, res) => {
  try {
    const { gameId, rating, reviewText, reviewPublic, gameTitle, gameCover } = req.body;
    const isPublic = reviewPublic !== false;
    await db.updateGameRating(req.session.userId, gameId, rating || 0, reviewText || '', isPublic);
    if (isPublic) {
      await db.savePublicReview(req.session.userId, gameId, rating || 0, reviewText || '', gameTitle, gameCover);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Review] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reviews/feed', requireAuth, async (req, res) => {
  try {
    const reviews = await db.getAllPublicReviews();
    res.json({ reviews });
  } catch (err) {
    console.error('[ReviewsFeed] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/reviews', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.query;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    const reviews = await db.getGameReviews(gameId);
    res.json({ reviews });
  } catch (err) {
    console.error('[GameReviews] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wishlist', requireAuth, async (req, res) => {
  try {
    const ids = await db.getWishlist(req.session.userId);
    res.json({ wishlist: ids });
  } catch (err) {
    console.error('[Wishlist] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wishlist/toggle', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    const added = await db.toggleWishlist(req.session.userId, gameId);
    res.json({ added });
  } catch (err) {
    console.error('[WishlistToggle] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/topthree', requireAuth, async (req, res) => {
  try {
    const top = await db.getTopThree(req.session.userId);
    res.json({ topThree: top });
  } catch (err) {
    console.error('[TopThree] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/topthree', requireAuth, async (req, res) => {
  try {
    const { gameId, position } = req.body;
    await db.setTopThree(req.session.userId, gameId, position);
    res.json({ ok: true });
  } catch (err) {
    console.error('[TopThreeSet] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    await db.deleteUserAccount(req.session.userId);
    req.session.destroy();
    res.json({ ok: true });
  } catch (err) {
    console.error('[AccountDelete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/ratings', async (req, res) => {
  try {
    const ratings = await db.getGameAvgRatings();
    res.json({ ratings });
  } catch (err) {
    console.error('[Ratings] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const catalog = await db.getCatalog();
    res.json({ catalog });
  } catch (err) {
    console.error('[Catalog] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/games/:gameId', requireAuth, async (req, res) => {
  try {
    await db.deleteGame(req.session.userId, req.params.gameId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GameDelete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/games/platform/:platform', requireAuth, async (req, res) => {
  try {
    await db.deletePlatformGames(req.session.userId, req.params.platform);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PlatformDelete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset', requireAuth, async (req, res) => {
  try {
    await db.resetAllData();
    console.log('[Admin] Reset all games + catalog by user', req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] Reset error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/heartbeat', requireAuth, async (req, res) => {
  try {
    await db.updateLastSeen(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Heartbeat] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ PLATFORM AUTH ============
// IMPORTANT : Sur Render, définir PUBLIC_URL = https://ton-app.render.com
// Steam redirige vers cette URL, pas vers localhost.
const BASE_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Steam OpenID — login officiel sans mot de passe
app.get('/api/auth/steam', requireAuth, (req, res) => {
  const callbackUrl = `${BASE_URL}/api/auth/steam/callback`;
  const params = querystring.stringify({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': callbackUrl,
    'openid.realm': BASE_URL,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect(`https://steamcommunity.com/openid/login?${params}`);
});

// Callback Steam OpenID — validation + récupération jeux
app.get('/api/auth/steam/callback', async (req, res) => {
  const redirectError = (msg) => res.redirect(`${BASE_URL}/?steam=error&msg=${encodeURIComponent(msg)}`);

  // Utiliser la session persistante (stockée dans Supabase via session-store.js)
  if (!req.session?.userId) {
    console.error('[SteamOpenID] Session non trouvée — userId:', req.session?.userId, 'cookies:', req.headers.cookie);
    redirectError('Session expirée, reconnecte-toi');
    return;
  }
  const userId = req.session.userId;

  // Étape 1 : valider la réponse OpenID via check_authentication
  try {
    const validationParams = querystring.stringify({ ...req.query, 'openid.mode': 'check_authentication' });
    const body = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'steamcommunity.com',
        path: '/openid/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(validationParams),
        },
      };
      const httpReq = https.request(opts, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      httpReq.on('error', reject);
      httpReq.write(validationParams);
      httpReq.end();
    });

    if (!body.includes('is_valid:true')) {
      console.error('[SteamOpenID] Validation échouée:', body);
      redirectError('Validation OpenID échouée');
      return;
    }
  } catch (err) {
    console.error('[SteamOpenID] Erreur validation:', err.message);
    redirectError('Erreur de validation: ' + err.message);
    return;
  }

  // Étape 2 : extraire le Steam ID
  const claimedId = req.query['openid.claimed_id'];
  const steamId = claimedId?.match(/\/(\d+)$/)?.[1];
  if (!steamId) { redirectError('Steam ID non trouvé'); return; }

  // Étape 3 : sauvegarder et importer les jeux
  try {
    await db.setSteamId(userId, steamId);
    const apiKey = process.env.STEAM_API_KEY;
    let count = 0;
    if (apiKey) {
      const games = await fetchSteamGames(apiKey, steamId);
      for (const game of games) {
        await db.upsertGame(userId, game);
        await db.ensureCatalogGame(await enrichGameFromSteam(game));
      }
      count = games.length;
    } else {
      console.warn('[SteamOpenID] STEAM_API_KEY non configurée — aucun jeu importé. Ajoute-la dans les env vars Render.');
    }
    res.redirect(`${BASE_URL}/?steam=ok&count=${count}`);
  } catch (err) {
    console.error('[SteamOpenID] Erreur import:', err.message);
    redirectError(err.message);
  }
});

// Récupère les jeux Steam (+ achievements)
async function fetchSteamGames(apiKey, steamId) {
  // GetOwnedGames
  const ownedData = await steamApiGet(apiKey, 'IPlayerService', 'GetOwnedGames', { steamid: steamId, include_appinfo: true });
  if (!ownedData?.response?.games) {
    console.error('[SteamAPI] GetOwnedGames réponse inattendue:', JSON.stringify(ownedData).slice(0, 500));
  }
  const list = ownedData?.response?.games || [];
  console.log('[SteamAPI] GetOwnedGames OK —', list.length, 'jeux pour steamId', steamId);

  // Pour chaque jeu, tente de récupérer les achievements
  const gameResults = [];
  for (const g of list) {
    const game = {
      game_id: 'steam-' + g.appid,
      title: g.name || 'Unknown',
      platform: 'steam',
      playtime: Math.round((g.playtime_forever || 0) / 60),
      cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
      genre: '',
      year: 0,
      status: g.playtime_forever > 0 ? 'playing' : 'not_started',
      user_rating: 0,
      review_text: '',
      review_public: true,
      has_review: 0,
    };

    // Tente achievements (limité aux jeux où l'utilisateur en a)
    try {
      const achData = await steamApiGet(apiKey, 'ISteamUserStats', 'GetPlayerAchievements', { steamid: steamId, appid: g.appid, l: 'french' });
      const achievements = achData?.playerstats?.achievements || [];
      if (achievements.length > 0) {
        game.achievements_unlocked = achievements.filter(a => a.achieved === 1).length;
        game.achievements_total = achievements.length;
      }
    } catch { /* ignore — pas d'achievements pour ce jeu */ }

    gameResults.push(game);
  }
  return gameResults;
}

// Route pour re-sync Steam (utilise le steam_id déjà enregistré)
app.post('/api/platform/steam/resync', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    const steamId = user?.steam_id;
    if (!steamId) return res.status(400).json({ error: 'Aucun compte Steam connecté' });
    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'STEAM_API_KEY non configurée sur le serveur' });
    console.log('[SteamResync] steamId:', steamId, 'API key defined:', !!apiKey);
    const games = await fetchSteamGames(apiKey, steamId);
    if (games.length === 0) {
      return res.status(400).json({ error: 'Aucun jeu trouvé — ton profil Steam doit être en Public (Paramètres > Confidentialité > Détails du jeu: Public).' });
    }
    for (const game of games) {
      await db.upsertGame(req.session.userId, game);
      await db.ensureCatalogGame(await enrichGameFromSteam(game));
    }
    res.json({ ok: true, count: games.length });
  } catch (err) {
    console.error('[SteamResync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper appel Steam Store API (gratuit, sans clé API)
function steamStoreGet(appid) {
  return new Promise((resolve, reject) => {
    https.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=french`, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { const j = JSON.parse(d); resolve(j[appid]); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Helper appel API Steam
function steamApiGet(apiKey, iface, method, params) {
  const qs = querystring.stringify({ key: apiKey, format: 'json', ...params });
  const url = `https://api.steampowered.com/${iface}/${method}/v1/?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Enrichit un jeu avec les infos Steam Store — genre, année, cover si absente
async function enrichGameFromSteam(game) {
  if (!game.game_id || !game.game_id.startsWith('steam-')) return game;
  const appid = game.game_id.replace('steam-', '');
  try {
    const details = await steamStoreGet(appid);
    if (details && details.success && details.data) {
      const d = details.data;
      return {
        ...game,
        cover: game.cover || d.header_image || '',
        genre: (d.genres && d.genres.map(g => g.description).join(', ')) || game.genre || '',
        year: (d.release_date && d.release_date.date ? parseInt(d.release_date.date.match(/\d{4}/)?.[0]) || 0 : 0) || game.year,
      };
    }
  } catch (e) { /* Steam Store non disponible, garder les données d'origine */ }
  return game;
}

// Route manuelle alternative (si OpenID ne marche pas)
app.post('/api/platform/steam/connect', requireAuth, async (req, res) => {
  let { steamId } = req.body;
  if (!steamId) return res.status(400).json({ error: 'steamId requis' });
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'STEAM_API_KEY non configurée sur le serveur' });
  try {
    await db.setSteamId(req.session.userId, steamId);
    const games = await fetchSteamGames(apiKey, steamId);
    for (const game of games) {
      await db.upsertGame(req.session.userId, game);
      await db.ensureCatalogGame(await enrichGameFromSteam(game));
    }
    res.json({ ok: true, count: games.length });
  } catch (err) {
    console.error('[SteamConnect] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Xbox — connexion manuelle via Gamertag
app.post('/api/platform/xbox/connect', requireAuth, async (req, res) => {
  let { gamertag } = req.body;
  if (!gamertag) return res.status(400).json({ error: 'Gamertag requis' });
  try {
    await db.setXboxGamertag(req.session.userId, gamertag);
    const xblKey = process.env.XBL_API_KEY;
    console.log('[XboxConnect] XBL_API_KEY defined:', !!xblKey, 'gamertag:', gamertag);
    let count = 0;
    if (xblKey) {
      const games = await fetchXboxGames(xblKey, gamertag);
      console.log('[XboxConnect] games fetched:', games.length);
      for (const game of games) {
        await db.upsertGame(req.session.userId, game);
        await db.ensureCatalogGame(await enrichGameFromSteam(game));
      }
      count = games.length;
    }
    console.log('[XboxConnect] OK, count:', count);
    res.json({ ok: true, count });
  } catch (err) {
    console.error('[XboxConnect] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Récupère les jeux Xbox via xbl.io (clé gratuite sur https://xbl.io)
async function fetchXboxGames(apiKey, gamertag) {
  // Étape 1 : vérifier que la clé API est valide
  let apiKeyValid = false;
  for (const acctUrl of ['https://xbl.io/api/v2/account', 'https://api.xbl.io/api/v2/account']) {
    try {
      const accountData = await xboxApiGet(apiKey, acctUrl);
      console.log('[XboxAPI] Account check', acctUrl.slice(0, 30), ':', JSON.stringify(accountData).slice(0, 200));
      if (accountData?.xuid || accountData?.gamertag || accountData?.profileUsers) {
        apiKeyValid = true;
        break;
      }
      if (accountData?.code === 'ERROR') {
        console.error('[XboxAPI] Account error on', acctUrl.slice(0, 30), ':', accountData?.message);
      }
    } catch (e) { console.error('[XboxAPI] Account check failed:', e.message); }
  }
  if (!apiKeyValid) {
    console.error('[XboxAPI] Aucune réponse valide - XBL_API_KEY invalide ou expirée (va sur https://xbl.io)');
    return [];
  }

  // Étape 2 : résoudre le Gamertag en XUID via plusieurs méthodes
  let xuid = null;
  const gt = encodeURIComponent(gamertag);

  // Méthode A : xbl.io player/gamertag endpoint (doc officielle, mars 2026)
  // La doc montre https://api.xbl.io/api/v2/player/gamertag/:gt
  // Réponse: { "xuid": "2533274843156789", "gamertag": "Major Nelson", ... }
  const searchUrls = [
    `https://api.xbl.io/api/v2/player/gamertag/${gt}`,
    `https://xbl.io/v2/player/gamertag/${gt}`,
    `https://xbl.io/api/v2/search/${gt}`,
    `https://xbl.io/api/v2/friends/search/${gt}`,
    `https://xbl.io/api/v2/player/search?gt=${gt}`,
    `https://xbl.io/api/v2/player/search?q=${gt}`,
  ];
  for (const url of searchUrls) {
    try {
      const data = await xboxApiGet(apiKey, url);
      // Nouveau format: xuid à la racine (player/gamertag endpoint)
      if (data?.xuid) { xuid = data.xuid; console.log('[XboxAPI] XUID via root:', url, 'xuid:', xuid); break; }
      // Ancien format: profileUsers array (account/search endpoint)
      const user = data?.profileUsers?.[0] || data?.profileUser || data;
      if (user?.xuid || user?.id) { xuid = user.xuid || user.id; console.log('[XboxAPI] XUID via profile:', url); break; }
    } catch (e) { /* ignore */ }
  }

  // Méthode B : Microsoft Xbox Live API publique (profile) - sans auth, peut ne pas marcher
  if (!xuid) {
    try {
      const msUrl = `https://profile.xboxlive.com/users/gt(${gt})/profile/settings`;
      const msData = await new Promise((resolve, reject) => {
        const opts = { headers: { 'x-xbl-contract-version': '2', 'Accept': 'application/json' } };
        https.get(msUrl, opts, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => {
            console.log('[XboxAPI] Microsoft profile status:', resp.statusCode, 'body:', d.slice(0, 300));
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        }).on('error', (err) => {
          console.log('[XboxAPI] Microsoft request error:', err.message);
          resolve(null);
        });
      });
    } catch (e) { console.log('[XboxAPI] Microsoft API fallback échoué:', e.message); }
  }

  // Méthode C : Xbox Unity API (publique, sans clé)
  if (!xuid) {
    try {
      const unityUrl = `https://xboxapi.unity.com/v1/player/${gt}`;
      const data = await new Promise((resolve, reject) => {
        https.get(unityUrl, { headers: { 'Accept': 'application/json' } }, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => {
            console.log('[XboxAPI] Unity status:', resp.statusCode);
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        }).on('error', (err) => { resolve(null); });
      });
      if (data?.xuid) xuid = data.xuid;
    } catch (e) { /* ignore */ }
  }

  if (!xuid) {
    console.error('[XboxAPI] XUID introuvable pour', gamertag);
    return [];
  }

  console.log('[XboxAPI] XUID found:', xuid);
  const gamesUrls = [
    `https://xbl.io/api/v2/player/titleHistory/${xuid}`,
    `https://api.xbl.io/api/v2/player/titleHistory/${xuid}`,
  ];
  let gamesData = null;
  for (const url of gamesUrls) {
    try {
      gamesData = await xboxApiGet(apiKey, url);
      if (gamesData && gamesData?.code !== 'ERROR') break;
    } catch (e) { /* ignore */ }
  }
  console.log('[XboxAPI] Games response:', JSON.stringify(gamesData).slice(0, 800));
  if (gamesData?.code === 'ERROR') {
    console.error('[XboxAPI] Games API error:', JSON.stringify(gamesData).slice(0, 500));
    return [];
  }
  const titles = gamesData?.titles || gamesData?.data?.titles || gamesData?.games || gamesData?.data || [];
  if (!Array.isArray(titles) || !titles.length) {
    console.log('[XboxAPI] No titles array, keys:', Object.keys(gamesData || {}));
    return [];
  }

  return titles.map(t => ({
    game_id: 'xbox-' + (t.titleId || t.id || ''),
    title: t.name || t.title || 'Unknown',
    platform: 'xbox',
    playtime: Math.round((t.playtime || 0) / 60),
    cover: t.displayImage || t.images?.find(i => i.type === 'screenshot')?.url || '',
    genre: t.genre || t.categories?.[0] || '',
    year: t.releaseDate ? new Date(t.releaseDate).getFullYear() : 0,
    status: t.progression?.completionPercentage === 100 ? 'completed' : (t.playtime > 0 ? 'playing' : 'not_started'),
    user_rating: 0, review_text: '', review_public: true, has_review: 0,
  }));
}

// Helper appel API xbl.io
function xboxApiGet(apiKey, url) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      headers: {
        'x-authorization': apiKey,
        'User-Agent': 'PlayPad/1.0',
        'Accept': 'application/json',
      },
    };
    https.get(url, opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        console.log('[xboxApiGet]', url.split('?')[0].slice(-40), 'status:', resp.statusCode, 'body length:', d.length);
        if (resp.statusCode !== 200) {
          console.error('[xboxApiGet] HTTP error:', resp.statusCode, d.slice(0, 500));
          resolve(JSON.parse(d));
          return;
        }
        try { resolve(JSON.parse(d)); }
        catch (e) { console.error('[xboxApiGet] JSON parse error:', e.message, 'body:', d.slice(0, 500)); reject(e); }
      });
    }).on('error', (err) => {
      console.error('[xboxApiGet] HTTP error:', err.message);
      reject(err);
    });
  });
}

app.get('/api/users/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    const users = await db.searchUsers(q || '', req.session.userId);
    res.json({ users });
  } catch (err) {
    console.error('[UserSearch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.sendFriendRequest(req.session.userId, friendId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendRequest] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.acceptFriendRequest(req.session.userId, friendId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendAccept] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.removeFriend(req.session.userId, friendId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendRemove] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const friends = await db.getFriends(req.session.userId);
    res.json({ friends });
  } catch (err) {
    console.error('[Friends] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const requests = await db.getPendingRequests(req.session.userId);
    res.json({ requests });
  } catch (err) {
    console.error('[FriendRequests] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends/:id/games', requireAuth, async (req, res) => {
  try {
    const games = await db.getFriendGames(req.params.id);
    res.json({ games: games || [] });
  } catch (err) {
    console.error('[FriendGames] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends/status/:id', requireAuth, async (req, res) => {
  try {
    const status = await db.getFriendStatus(req.session.userId, req.params.id);
    res.json({ status: status || 'none' });
  } catch (err) {
    console.error('[FriendStatus] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/account/avatar', requireAuth, async (req, res) => {
  try {
    const { avatarUrl } = req.body;
    await db.updateAvatar(req.session.userId, avatarUrl || '');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Avatar] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/account/email', requireAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const existing = await db.getUserByEmail(email);
    if (existing && existing.id !== Number(req.session.userId)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte' });
    }
    const { error } = await db.supabaseAdmin.from('users').update({ email }).eq('id', req.session.userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true, email });
  } catch (err) {
    console.error('[Email] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Profil public d'un utilisateur
app.get('/api/users/:id/profile', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    const games = await db.getFriendGames(req.params.id);
    const topThree = await db.getTopThree(req.params.id);
    const reviews = await db.getUserPublicReviews(req.params.id);
    res.json({ user, games: games || [], topThree, reviews });
  } catch (err) {
    console.error('[UserProfile] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suggestions', requireAuth, async (req, res) => {
  try {
    const { toUserId, gameId, gameTitle, gameCover, message } = req.body;
    await db.sendGameSuggestion(req.session.userId, toUserId, gameId, gameTitle, gameCover, message);
    // Also send as chat message
    await db.sendMessage(req.session.userId, toUserId, '🎮 Je te propose "' + gameTitle + '"' + (message ? ' : ' + message : ''));
    res.json({ ok: true });
  } catch (err) {
    console.error('[Suggestion] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suggestions', requireAuth, async (req, res) => {
  try {
    const suggestions = await db.getGameSuggestions(req.session.userId);
    res.json({ suggestions });
  } catch (err) {
    console.error('[Suggestions] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/suggestions/:id', requireAuth, async (req, res) => {
  try {
    await db.removeGameSuggestion(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[SuggestionDelete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Messages — chat entre amis
app.post('/api/messages/send', requireAuth, async (req, res) => {
  try {
    const { receiverId, message } = req.body;
    if (!receiverId || !message) return res.status(400).json({ error: 'Destinataire et message requis' });
    const msg = await db.sendMessage(req.session.userId, receiverId, message);
    res.json({ message: msg });
  } catch (err) {
    console.error('[MessageSend] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:friendId', requireAuth, async (req, res) => {
  try {
    const messages = await db.getMessages(req.session.userId, req.params.friendId);
    await db.markMessagesRead(req.session.userId, req.params.friendId);
    res.json({ messages });
  } catch (err) {
    console.error('[Messages] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/conversations', requireAuth, async (req, res) => {
  try {
    const conversations = await db.getConversations(req.session.userId);
    res.json({ conversations });
  } catch (err) {
    console.error('[Conversations] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/unread', requireAuth, async (req, res) => {
  try {
    const { data, error } = await db.supabaseAdmin
      .from('messages')
      .select('*, sender:sender_id(id, display_name, avatar_url)')
      .eq('receiver_id', req.session.userId)
      .eq('read', false)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ unread: data || [] });
  } catch (err) {
    console.error('[UnreadMessages] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Store details — données enrichies Steam Store
const storeCache = {};
app.get('/api/games/:gameId/store-details', async (req, res) => {
  try {
    const gameId = req.params.gameId;
    const appid = gameId.replace('steam-', '');
    if (!/^\d+$/.test(appid)) return res.json({ details: null, error: 'Pas un jeu Steam' });
    if (storeCache[appid]) return res.json({ details: storeCache[appid] });
    const details = await steamStoreGet(appid);
    if (details && details.success && details.data) {
      const d = details.data;
      storeCache[appid] = {
        name: d.name,
        description: d.short_description || d.detailed_description?.replace(/<[^>]*>/g, '') || '',
        price: d.price_overview ? (d.price_overview.final / 100).toFixed(2) + ' €' : null,
        metacritic: d.metacritic?.score || null,
        recommendations: d.recommendations?.total || null,
        developers: d.developers ? d.developers.join(', ') : '',
        publishers: d.publishers ? d.publishers.join(', ') : '',
        platforms: Object.entries(d.platforms || {}).filter(([, v]) => v).map(([k]) => k).join(', '),
        header_image: d.header_image,
        website: d.website,
        release_date: d.release_date?.date || '',
      };
      res.json({ details: storeCache[appid] });
    } else {
      res.json({ details: null, error: 'Non trouvé sur le Steam Store' });
    }
  } catch (err) {
    console.error('[StoreDetails] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stats personnelles
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const games = await db.getGames(req.session.userId);
    const total = games.length;
    const playtime = games.reduce((s, g) => s + (g.playtime || 0), 0);
    const completed = games.filter(g => g.status === 'completed').length;
    const platforms = {};
    const genres = {};
    const years = {};
    for (const g of games) {
      if (g.platform) platforms[g.platform] = (platforms[g.platform] || 0) + 1;
      if (g.genre) genres[g.genre] = (genres[g.genre] || 0) + 1;
      if (g.year) years[g.year] = (years[g.year] || 0) + 1;
    }
    res.json({ stats: { total, playtime, completed, platforms, genres, years } });
  } catch (err) {
    console.error('[Stats] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — vérifier les variables d'environnement
app.get('/api/debug/env', (req, res) => {
  res.json({
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    STEAM_API_KEY: !!process.env.STEAM_API_KEY,
    XBL_API_KEY: !!process.env.XBL_API_KEY,
    PUBLIC_URL: process.env.PUBLIC_URL || null,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
  });
});

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
  console.log('[Server] SUPABASE_URL:', process.env.SUPABASE_URL ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'defined' : 'MISSING');
  console.log('[Server] PUBLIC_URL:', process.env.PUBLIC_URL || '⚠️ NON DÉFINI — Steam OpenID va échouer ! Définir PUBLIC_URL dans les env vars Render');
  console.log('[Server] STEAM_API_KEY:', process.env.STEAM_API_KEY ? 'defined' : 'NON DÉFINI — Steam import ne marchera pas');
  console.log('[Server] XBL_API_KEY:', process.env.XBL_API_KEY ? 'defined' : 'NON DÉFINI — Xbox import ne marchera pas');
  if (!process.env.PUBLIC_URL) {
    console.warn('⚠️  PUBLIC_URL manquant. Steam OpenID redirigera vers localhost au lieu de l\'URL publique.');
    console.warn('    Ajoute PUBLIC_URL=https://ton-app.render.com dans les env vars Render.');
  }
});
