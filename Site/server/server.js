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
    const { username, displayName, password } = req.body;
    console.log('[Register] Request:', { username, displayName });
    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
    }
    const existing = await db.getUserByUsername(username);
    if (existing) {
      console.log('[Register] Username taken:', username);
      return res.status(409).json({ error: 'Cet identifiant est déjà pris' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = await db.createUser(username, displayName, hashed);
    const user = await db.getUserById(userId);
    req.session.userId = userId;
    console.log('[Register] Success:', username, 'id:', userId);
    res.json({ user });
  } catch (err) {
    console.error('[Register] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
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
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, created_at: user.created_at } });
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
      await db.ensureCatalogGame(game);
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

app.delete('/api/games/platform/:platform', requireAuth, async (req, res) => {
  try {
    await db.deletePlatformGames(req.session.userId, req.params.platform);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PlatformDelete] Error:', err.message);
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
        await db.ensureCatalogGame(game);
      }
      count = games.length;
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
  const list = ownedData?.response?.games || [];

  // Pour chaque jeu, tente de récupérer les achievements
  const gameResults = [];
  for (const g of list) {
    const game = {
      game_id: 'steam-' + g.appid,
      title: g.name || 'Unknown',
      platform: 'steam',
      playtime: Math.round((g.playtime_forever || 0) / 60),
      cover: g.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : (g.img_logo_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_logo_url}.jpg`
          : ''),
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
      await db.ensureCatalogGame(game);
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
    // Tente d'importer via xbl.io si la clé est configurée
    const xblKey = process.env.XBL_API_KEY;
    let count = 0;
    if (xblKey) {
      const games = await fetchXboxGames(xblKey, gamertag);
      for (const game of games) {
        await db.upsertGame(req.session.userId, game);
        await db.ensureCatalogGame(game);
      }
      count = games.length;
    }
    res.json({ ok: true, count });
  } catch (err) {
    console.error('[XboxConnect] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Récupère les jeux Xbox via xbl.io
async function fetchXboxGames(apiKey, gamertag) {
  const url = `https://xbl.io/api/v2/account/999/gameclubs?gt=${encodeURIComponent(gamertag)}`;
  // API alternative pour les jeux : https://xbl.io/api/v2/player/{xuid}/games
  // Pour l'instant on retourne un tableau vide — sera implémenté quand une clé API Xbox sera configurée
  return [];
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

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
  console.log('[Server] SUPABASE_URL:', process.env.SUPABASE_URL ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'defined' : 'MISSING');
  console.log('[Server] PUBLIC_URL:', process.env.PUBLIC_URL || '⚠️ NON DÉFINI — Steam OpenID va échouer ! Définir PUBLIC_URL dans les env vars Render');
  if (!process.env.PUBLIC_URL) {
    console.warn('⚠️  PUBLIC_URL manquant. Steam OpenID redirigera vers localhost au lieu de l\'URL publique.');
    console.warn('    Ajoute PUBLIC_URL=https://ton-app.render.com dans les env vars Render.');
  }
});
