const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const SupabaseSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Validation du secret de session au démarrage
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('SESSION_SECRET est obligatoire et doit faire au moins 16 caractères. Définis-le dans .env ou les variables d\'environnement.');
  process.exit(1);
}

// Sécurité : headers HTTP (CSP, HSTS, X-Frame-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.tailwindcss.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://cdn.cloudflare.steamstatic.com", "https://steamcdn-a.akamaihd.net", "https://media.rawg.io"],
      connectSrc: ["'self'", "http://localhost:3456"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
}));

// Sécurité : rate limiting global (200 req / 15 min par IP)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie dans 15 minutes.' },
});
app.use(globalLimiter);

// Sécurité : rate limiting strict sur l'auth (10 tentatives / 15 min)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans 15 minutes.' },
});

const corsOrigin = process.env.PUBLIC_URL || 'http://localhost:3000';
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

app.set('trust proxy', 1);
const sessionStore = new SupabaseSessionStore();
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
  },
}));

app.use(express.static(path.join(__dirname, '..')));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// Validation de la complexité du mot de passe
function validatePassword(password) {
  if (password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
  if (!/[A-Z]/.test(password)) return 'Le mot de passe doit contenir au moins une majuscule';
  if (!/[a-z]/.test(password)) return 'Le mot de passe doit contenir au moins une minuscule';
  if (!/[0-9]/.test(password)) return 'Le mot de passe doit contenir au moins un chiffre';
  return null;
}

// Validation du format d'email
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, displayName, password, email } = req.body;
    console.log('[Register] Request:', { username, displayName, email });
    if (!username || !displayName || !password || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Format d\'email invalide' });
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
    await db.claimFirstLoginPoints(userId);
    console.log('[Register] Success:', username, 'id:', userId, '+ 1 booster point');
    res.json({ user });
  } catch (err) {
    console.error('[Register] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const user = await db.getUserByEmail(email);
    if (user) {
      const token = await db.createResetToken(user.id, 'password');
      console.log('[ForgotPassword] Token créé pour', email);
      // En production, envoie le lien par email ici
    }
    // Toujours retourner le même message (pas de fuite d'info)
    res.json({ ok: true, message: 'Si un compte existe avec cet email, un lien de réinitialisation a été généré (vérifie la console serveur en développement).' });
  } catch (err) {
    console.error('[ForgotPassword] Error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
  }
});

app.post('/api/auth/forgot-username', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const user = await db.getUserByEmail(email);
    if (user) {
      console.log('[ForgotUsername] Demande pour', email);
      // En production, envoie l'identifiant par email ici
    }
    // Toujours retourner le même message
    res.json({ ok: true, message: 'Si un compte existe avec cet email, les instructions ont été envoyées (vérifie la console serveur en développement).' });
  } catch (err) {
    console.error('[ForgotUsername] Error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la récupération' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });
    const rt = await db.getResetToken(token);
    if (!rt) return res.status(400).json({ error: 'Token invalide ou expiré' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const { error } = await db.supabaseAdmin.from('users').update({ password: hashed }).eq('id', rt.user_id);
    if (error) throw new Error(error.message);
    await db.markResetTokenUsed(token);
    console.log('[ResetPassword] Mot de passe réinitialisé avec succès');
    res.json({ ok: true, message: 'Mot de passe réinitialisé avec succès' });
  } catch (err) {
    console.error('[ResetPassword] Error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('[Login] Request for username:', username);
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    const user = await db.getUserByUsername(username);
    if (!user) {
      console.log('[Login] User not found:', username);
      await bcrypt.compare(password, '$2a$10$' + 'x'.repeat(53));
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    console.log('[Login] User found, comparing password');
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      console.log('[Login] Wrong password for:', username);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    req.session.userId = user.id;
    refreshCatalogDescriptions().catch(() => {});
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
  if (games.length > 5000) {
    return res.status(400).json({ error: 'Trop de jeux à la fois (max 5000)' });
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

app.delete('/api/games', requireAuth, async (req, res) => {
  try {
    await db.deleteAllUserGames(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GameDeleteAll] Error:', err.message);
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
    const user = await db.getUserById(req.session.userId);
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminIds.length === 0 || !adminIds.includes(String(req.session.userId))) {
      return res.status(403).json({ error: 'Accès réservé aux administrateurs. Définis ADMIN_IDS dans les variables d\'environnement.' });
    }
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
        developer: (d.developers && d.developers[0]) || game.developer || '',
        publisher: (d.publishers && d.publishers[0]) || game.publisher || '',
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
    let count = 0, warning = '', diagnostic = '';
    if (xblKey) {
      const result = await fetchXboxGames(xblKey, gamertag);
      diagnostic = result.diagnostic;
      console.log('[XboxConnect] diagnostic:', diagnostic);
      for (const game of result.games) {
        await db.upsertGame(req.session.userId, game);
        await db.ensureCatalogGame(await enrichGameFromSteam(game));
      }
      count = result.games.length;
      if (count === 0) warning = 'Aucun jeu trouvé. Diagnostic: ' + diagnostic;
    } else {
      warning = 'XBL_API_KEY non configurée sur le serveur — va sur https://xbl.io pour obtenir une clé gratuite';
    }
    console.log('[XboxConnect] OK, count:', count, 'warning:', warning);
    res.json({ ok: true, count, warning, diagnostic });
  } catch (err) {
    console.error('[XboxConnect] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic Xbox (vérifie la config sans importer de jeux)
app.get('/api/platform/xbox/diagnostic', requireAuth, async (req, res) => {
  const xblKey = process.env.XBL_API_KEY;
  const gamertag = req.query.gamertag || '';
  const diag = ['XBL_API_KEY: ' + (xblKey ? 'définie' : 'NON DÉFINIE')];
  if (xblKey && gamertag) {
    const result = await fetchXboxGames(xblKey, gamertag);
    diag.push('Diagnostic: ' + result.diagnostic);
  }
  res.json({ diagnostic: diag.join(' | ') });
});

// Catalogue — importe les jeux populaires depuis RAWG API dans le catalogue global
// (utilise RAWG platform IDs: 4=PC, 7=Nintendo Switch, 187=PS5, 186=Xbox Series, 1=Xbox One, 18=PS4)
const CATALOG_PLATFORMS = [
  { id: 4,  prefix: 'steam' },
  { id: 7,  prefix: 'nintendo' },
  { id: 187, prefix: 'ps5' },
  { id: 18, prefix: 'ps4' },
  { id: 186, prefix: 'xbox' },
  { id: 1,  prefix: 'xbox' },
];
const CATALOG_PAGES = 50; // 50 pages × 40 jeux = 2000 jeux par plateforme
let lastCatalogPopulate = 0;
const CATALOG_COOLDOWN = 60000; // 1 min entre chaque peuplement

app.post('/api/catalog/populate', async (req, res) => {
  try {
    const now = Date.now();
    if (now - lastCatalogPopulate < CATALOG_COOLDOWN) {
      return res.json({ ok: true, count: 0, cooldown: true });
    }
    lastCatalogPopulate = now;
    const rawgKey = process.env.RAWG_API_KEY;
    const existingCount = await db.getCatalogCount();
    let total = 0;
    let steamTotal = 0;
    // Skip RAWG if catalog already has enough entries (Steam app list covers it)
    if (existingCount < 500 && rawgKey) {
      total = await populateCatalogFromRAWG(rawgKey);
    }
    steamTotal = await populateSteamFromAppList();
    db.mergeCatalogDuplicatesByTitle().then(n => { if (n > 0) console.log(`[Catalog] ${n} doublons fusionnés`); }).catch(e => console.error('[Catalog] Merge error:', e.message));
    // Refresh descriptions in background
    refreshCatalogDescriptions().catch(() => {});
    res.json({ ok: true, count: total, steamCount: steamTotal });
  } catch (err) {
    console.error('[CatalogPopulate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

let lastDescriptionRefresh = 0;
const DESCRIPTION_REFRESH_COOLDOWN = 300000; // 5 min

async function refreshCatalogDescriptions() {
  const now = Date.now();
  if (now - lastDescriptionRefresh < DESCRIPTION_REFRESH_COOLDOWN) return;
  lastDescriptionRefresh = now;
  try {
    const catalog = await db.getCatalog();
    const toUpdate = catalog.filter(g => !g.description && g.game_id.startsWith('steam-'));
    console.log(`[Catalog] Refresh descriptions: ${toUpdate.length} jeux Steam sans description`);
    for (const game of toUpdate.slice(0, 20)) { // max 20 par refresh pour éviter rate limit
      try {
        const appid = game.game_id.replace('steam-', '');
        if (!/^\d+$/.test(appid)) continue;
        const d = await steamStoreGet(appid);
        if (d?.data) {
          const description = d.data.short_description || d.data.about_the_game || '';
          if (description) {
            await db.ensureCatalogGame({ game_id: game.game_id, title: game.title, description }).catch(() => {});
          }
        }
      } catch (e) { /* skip */ }
    }
    console.log(`[Catalog] Descriptions rafraîchies`);
  } catch (e) {
    console.error('[Catalog] Refresh descriptions error:', e.message);
  }
}

async function populateCatalogFromRAWG(apiKey, platformFilter) {
  const targets = platformFilter
    ? CATALOG_PLATFORMS.filter(p => p.id === platformFilter || p.prefix === platformFilter)
    : CATALOG_PLATFORMS;
  await db.dedupeCatalog().catch(() => {});
  let total = 0;
  let skipped = 0;
  const seen = new Set();
  try {
    const existing = await db.getCatalog();
    for (const g of existing) {
      const m = g.game_id.match(/(\d+)$/);
      if (m) seen.add(m[1]);
    }
  } catch (e) {}

  const yearRanges = [];
  for (let y = 1980; y <= 2026; y += 2) {
    const end = Math.min(y + 1, 2026);
    yearRanges.push({ label: String(y), start: `${y}-01-01`, end: `${end}-12-31`, pages: 10 });
  }
  // catch-all for games missing dates
  yearRanges.push({ label: 'nodate', start: '1970-01-01', end: '2026-12-31', pages: 15 });

  for (const plat of targets) {
    for (const range of yearRanges) {
      let page = 1;
      while (page <= range.pages) {
        const url = `https://api.rawg.io/api/games?key=${apiKey}&platforms=${plat.id}&dates=${range.start},${range.end}&page=${page}&page_size=40&ordering=-added`;
        try {
          const data = await rawgApiGet(url);
          if (!data || !data.results) break;
          for (const item of data.results) {
            if (!item.name || seen.has(item.id)) { if (item.name) skipped++; continue; }
            seen.add(item.id);
            await db.ensureCatalogGame({
              game_id: `${plat.prefix}-${item.id}`,
              title: item.name,
              platform: plat.prefix,
              cover: item.background_image || '',
              genre: (item.genres || []).map(g => g.name).join(', '),
              year: item.released ? (parseInt(item.released.split('-')[0]) || 0) : 0,
              developer: '',
              publisher: '',
            });
            total++;
          }
          if (!data.next) break;
          page++;
        } catch (e) {
          console.error(`[RAWG] Error ${plat.prefix} ${range.label} page ${page}:`, e.message);
          break;
        }
      }
    }
  }
  console.log(`[Catalog] ${total} ajoutés, ${skipped} ignorés (déjà présents)`);
  return total;
}

async function populateSteamFromAppList() {
  const steamKey = process.env.STEAM_API_KEY;
  if (!steamKey) { console.log('[SteamAppList] STEAM_API_KEY non configurée, skip'); return 0; }
  let total = 0;
  try {
    console.log('[SteamAppList] Importation de tous les jeux Steam via GetAppList...');
    const urls = [
      'https://api.steampowered.com/ISteamApps/GetAppList/v1/?key=' + encodeURIComponent(steamKey),
      'https://api.steampowered.com/ISteamApps/GetAppList/v0001/?key=' + encodeURIComponent(steamKey),
    ];
    let data = null;
    for (const url of urls) {
      try {
        data = await new Promise((resolve, reject) => {
          https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
            let d = '';
            resp.on('data', c => d += c);
            resp.on('end', () => {
              if (resp.statusCode !== 200) return reject(new Error('HTTP ' + resp.statusCode));
              try { resolve(JSON.parse(d)); }
              catch (e) { reject(e); }
            });
          }).on('error', reject);
        });
        if (data?.applist?.apps) break;
      } catch (e) { console.log('[SteamAppList] Tentative échouée:', url.slice(0, 60) + '...', e.message); }
    }
    if (!data?.applist?.apps) { console.log('[SteamAppList] Toutes les tentatives ont échoué'); return 0; }
    const existing = await db.getCatalog();
    const existingIds = new Set(existing.filter(g => g.game_id.startsWith('steam-')).map(g => g.game_id));
    const nonGameKeywords = ['soundtrack', 'dlc pack', 'wallpaper', 'sdk', 'artbook', 'season pass', 'expansion pack', 'playtest'];
    const batch = [];
    const totalApps = data.applist.apps.length;
    for (const app of data.applist.apps) {
      const gameId = `steam-${app.appid}`;
      if (existingIds.has(gameId)) continue;
      const name = (app.name || '').trim();
      if (!name || name.length < 2) continue;
      if (nonGameKeywords.some(kw => name.toLowerCase().includes(kw))) continue;
      batch.push({
        game_id: gameId, title: name, platform: 'steam',
        cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${app.appid}/library_600x900.jpg`,
        genre: '', year: 0, developer: '', publisher: ''
      });
      existingIds.add(gameId);
      if (batch.length >= 500) {
        await db.batchUpsertCatalog(batch);
        total += batch.length;
        console.log(`[SteamAppList] ${total} / ~${Math.round(totalApps * 0.15)} jeux ajoutés...`);
        batch.length = 0;
      }
    }
    if (batch.length > 0) {
      await db.batchUpsertCatalog(batch);
      total += batch.length;
    }
    console.log(`[SteamAppList] ${total} jeux Steam ajoutés`);
  } catch (e) { console.error('[SteamAppList] Error:', e.message); }
  return total;
}

// Peuple le catalogue au démarrage si vide
(async () => {
  try {
    const rawgKey = process.env.RAWG_API_KEY;
    if (rawgKey) {
      const existing = await db.getCatalogCount();
      if (existing < 100) {
        console.log('[Catalog] Peuplement initial du catalogue via RAWG...');
        const count = await populateCatalogFromRAWG(rawgKey);
        await db.mergeCatalogDuplicatesByTitle().catch(() => {});
        console.log(`[Catalog] ${count} jeux RAWG ajoutés`);
      } else {
        console.log(`[Catalog] Catalogue déjà peuplé (${existing} jeux), skip RAWG`);
      }
      // Steam App List toujours importé (ajoute les jeux Steam manquants)
      const steamCount = await populateSteamFromAppList();
      if (steamCount > 0) console.log(`[Catalog] ${steamCount} jeux Steam ajoutés`);
    }
  } catch (e) {
    console.error('[Catalog] Erreur peuplement initial:', e.message);
  }
})();

function rawgApiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Récupère les jeux Xbox via xbl.io (clé gratuite sur https://xbl.io)
// Retourne { games: [], diagnostic: '...' }
async function fetchXboxGames(apiKey, gamertag) {
  let diagnostic = [];
  let xuid = null;

  // Étape 1 : obtenir le XUID via la clé API xbl.io
  const accountData = await xboxApiGet(apiKey, 'https://xbl.io/api/v2/account');
  const acctContent = accountData?.content || {};
  diagnostic.push(`Account: code=${accountData?.code}, contentKeys=${Object.keys(acctContent).join(',')}`);
  if (accountData?.code === 'ERROR' || accountData?.code === 'HTTP_ERROR') {
    diagnostic.push('XBL_API_KEY invalide ou expirée');
    return { games: [], diagnostic: diagnostic.join(' | ') };
  }
  if (accountData?.code === 429) {
    diagnostic.push('Rate limit atteint — attends 1h puis réessaie');
    return { games: [], diagnostic: diagnostic.join(' | ') };
  }

  // Étape 2 : chercher le joueur par gamertag (doit marcher pour TOUS les utilisateurs)
  const gtClean = gamertag.replace(/#/g, '%23');
  const searchUrls = [
    `https://xbl.io/api/v2/player/search?gt=${encodeURIComponent(gamertag)}`,
    `https://xbl.io/api/v2/friends/search?gt=${encodeURIComponent(gamertag)}`,
    `https://xbl.io/api/v2/player/search?q=${encodeURIComponent(gamertag)}`,
  ];
  for (const url of searchUrls) {
    try {
      const data = await xboxApiGet(apiKey, url);
      if (data?.code === 'ERROR' || data?.code === 'HTTP_ERROR') { diagnostic.push(`Search ${url.slice(-30)}: ERROR`); continue; }
      const c = data?.content || {};
      diagnostic.push(`Search ${url.slice(-30)}: contentKeys=${Object.keys(c).join(',')}, sample=${JSON.stringify(c).slice(0,200)}`);
      // Chercher dans profileUsers ou tout tableau dans content
      const users = c?.profileUsers || c?.profiles || c?.people || c?.users || (Array.isArray(c) ? c : (c[c?.type || ''] || null));
      if (Array.isArray(users)) {
        for (const u of users) {
          if (u?.xuid || u?.id) { xuid = u.xuid || u.id; diagnostic.push(`XUID found: ${xuid} (${u.gamertag || ''})`); break; }
        }
      }
      // Chercher aussi directement dans content
      if (!xuid && c?.xuid) { xuid = c.xuid; diagnostic.push(`XUID in content: ${xuid}`); }
      if (xuid) break;
    } catch (e) { diagnostic.push(`Search ${url.slice(-30)}: FAILED`); }
  }

  // Fallback API Microsoft (sans clé)
  if (!xuid) {
    try {
      const msUrl = `https://profile.xboxlive.com/users/gt(${encodeURIComponent(gamertag)})/profile/settings`;
      const msData = await new Promise((resolve) => {
        const opts = { headers: { 'x-xbl-contract-version': '2', 'Accept': 'application/json' } };
        https.get(msUrl, opts, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => {
            diagnostic.push(`MS profile: ${resp.statusCode}`);
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        }).on('error', (err) => { diagnostic.push(`MS profile error: ${err.message}`); resolve(null); });
      });
      if (msData?.profileUsers?.[0]?.id) { xuid = msData.profileUsers[0].id; diagnostic.push(`XUID via Microsoft: ${xuid}`); }
    } catch (e) { /* ignore */ }
  }

  if (!xuid) {
    diagnostic.push('XUID introuvable. Vérifie ton Gamertag (casse, #, espaces). La fonction recherche de xbl.io nécessite un abonnement Premium sur https://xbl.io (gratuit ≈ 20req/min, mais limited).');
    return { games: [], diagnostic: diagnostic.join(' | ') };
  }

  // Étape 3 : récupérer les jeux
  const gamesUrls = [
    `https://xbl.io/api/v2/player/titleHistory/${xuid}`,
    `https://api.xbl.io/api/v2/player/titleHistory/${xuid}`,
  ];
  let gamesData = null;
  for (const url of gamesUrls) {
    try {
      gamesData = await xboxApiGet(apiKey, url);
      if (gamesData?.code === 'ERROR' || gamesData?.code === 'HTTP_ERROR') { diagnostic.push(`Titles ${url.slice(-30)}: ERROR`); continue; }
      diagnostic.push(`Titles ${url.slice(-30)}: OK`);
      if (gamesData && gamesData?.code !== 'ERROR') break;
    } catch (e) {
      diagnostic.push(`Titles ${url.slice(-30)}: FAILED - ${e.message}`);
    }
  }
  if (gamesData?.code === 'ERROR') {
    diagnostic.push('Games API error: ' + JSON.stringify(gamesData).slice(0, 300));
    return { games: [], diagnostic: diagnostic.join(' | ') };
  }
  const titlesData = gamesData?.content || gamesData;
  const titles = titlesData?.titles || titlesData?.data?.titles || titlesData?.games || titlesData?.data || [];
  diagnostic.push(`Titles array length=${Array.isArray(titles)?titles.length:'N/A'}, sample=${JSON.stringify(Array.isArray(titles)?titles[0]:titles).slice(0,200)}`);
  if (!Array.isArray(titles) || !titles.length) {
    diagnostic.push('Aucun titre trouvé (profil Xbox privé ?)');
    return { games: [], diagnostic: diagnostic.join(' | ') };
  }

  const games = titles.map(t => ({
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
  diagnostic.push(`Sync OK: ${games.length} jeux`);
  return { games, diagnostic: diagnostic.join(' | ') };
}

// Helper appel API xbl.io
function xboxApiGet(apiKey, url) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      headers: {
        'X-Authorization': apiKey,
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
          try { resolve(JSON.parse(d)); } catch { resolve({ code: 'HTTP_ERROR', status: resp.statusCode, body: d.slice(0, 300) }); }
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

app.get('/api/messages/unread', requireAuth, async (req, res) => {
  try {
    const { data, error } = await db.supabaseAdmin
      .from('messages')
      .select('*, sender:sender_id(id, display_name, avatar_url)')
      .eq('receiver_id', req.session.userId)
      .eq('read', false)
      .order('created_at', { ascending: false });
    if (error) {
      if (error.message && error.message.includes('relation "messages" does not exist')) {
        return res.json({ unread: [] });
      }
      throw new Error(error.message);
    }
    res.json({ unread: data || [] });
  } catch (err) {
    console.error('[UnreadMessages] Error:', err.message);
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

// Détails enrichis d'un jeu (Steam Store API) — sans clé API, gratuit
app.get('/api/game-details/:gameId', requireAuth, async (req, res) => {
  try {
    const gameId = req.params.gameId;
    // Try to get cached description from catalog
    const { data: catEntry } = await db.supabaseAdmin
      .from('catalog')
      .select('description')
      .eq('game_id', gameId)
      .maybeSingle();
    if (catEntry?.description) {
      return res.json({
        details: {
          description: catEntry.description,
          developers: [],
          publishers: [],
          platforms: [], price: null, metacritic: null, recommendations: 0,
          release_date: '', header_image: '', website: '',
        }
      });
    }
    let appid = gameId.replace('steam-', '');
    const { cover } = req.query;
    if (cover) {
      const m = cover.match(/steam\/apps\/(\d+)/);
      if (m) appid = m[1];
    }
    if (!appid || !/^\d+$/.test(appid)) return res.json({ details: null });
    const steamDetails = await steamStoreGet(appid);
    if (!steamDetails || !steamDetails.success || !steamDetails.data) return res.json({ details: null });
    const d = steamDetails.data;
    const description = d.short_description || d.about_the_game || '';
    // Save to catalog for future requests
    if (description) {
      const { data: existing } = await db.supabaseAdmin.from('catalog').select('title').eq('game_id', gameId).maybeSingle();
      if (existing?.title) {
        await db.ensureCatalogGame({ game_id: gameId, title: existing.title, description }).catch(() => {});
      }
    }
    res.json({
      details: {
        description,
        developers: d.developers || [],
        publishers: d.publishers || [],
        platforms: Object.entries(d.platforms || {}).filter(([, v]) => v).map(([k]) => k),
        price: d.price_overview ? (d.price_overview.final / 100).toFixed(2) + '€' : 'Gratuit',
        metacritic: d.metacritic || null,
        recommendations: d.recommendations?.total || 0,
        release_date: d.release_date?.date || '',
        header_image: d.header_image || '',
        website: d.website || '',
      }
    });
  } catch (err) {
    console.error('[GameDetails] Error:', err.message);
    res.json({ details: null });
  }
});

// ============ GAME PRICES (RAWG Stores + CheapShark) ============

const STORE_INFO = {
  1:  { name: 'Steam', domain: 'store.steampowered.com', platform: 'steam' },
  2:  { name: 'GOG', domain: 'gog.com', platform: 'pc' },
  3:  { name: 'PlayStation Store', domain: 'store.playstation.com', platform: 'ps5' },
  4:  { name: 'App Store', domain: 'apps.apple.com', platform: 'pc' },
  5:  { name: 'Nintendo eShop', domain: 'nintendo.com', platform: 'nintendo' },
  6:  { name: 'Google Play', domain: 'play.google.com', platform: 'pc' },
  7:  { name: 'Xbox Store', domain: 'xbox.com', platform: 'xbox' },
  8:  { name: 'Microsoft Store', domain: 'apps.microsoft.com', platform: 'pc' },
  9:  { name: 'Apple Arcade', domain: 'apple.com/apple-arcade', platform: 'pc' },
  10: { name: 'Itch.io', domain: 'itch.io', platform: 'pc' },
  11: { name: 'Epic Games', domain: 'store.epicgames.com', platform: 'pc' },
};

const CHEAPSHARK_STORES = {
  11: { name: 'Humble Store', domain: 'humblebundle.com', platform: 'pc' },
  13: { name: 'WinGameStore', domain: 'wingamestore.com', platform: 'pc' },
  28: { name: 'Plug In Digital', domain: 'plugindigital.com', platform: 'pc' },
  33: { name: 'GreenManGaming', domain: 'greenmangaming.com', platform: 'pc' },
  34: { name: 'GameBillet', domain: 'gamebillet.com', platform: 'pc' },
  35: { name: 'Voidu', domain: 'voidu.com', platform: 'pc' },
  36: { name: 'Fanatical', domain: 'fanatical.com', platform: 'pc' },
};

app.get('/api/game-prices/:gameId', async (req, res) => {
  try {
    const { gameId } = req.params;
    const rawgKey = process.env.RAWG_API_KEY;
    let offers = [];

    // 1. RAWG Stores (si le gameId contient un ID RAWG numérique)
    const rawgId = gameId.match(/(\d+)$/)?.[1];
    if (rawgId && rawgKey) {
      try {
        const data = await rawgApiGet(`https://api.rawg.io/api/games/${rawgId}/stores?key=${rawgKey}`);
        if (data?.results) {
          for (const s of data.results) {
            const info = STORE_INFO[s.store_id];
            if (!info) continue;
            offers.push({
              store: info,
              url: s.url,
              price: null,
              normalPrice: null,
              currency: null,
              isOnSale: false,
            });
          }
        }
      } catch (e) { console.error('[GamePrices] RAWG stores error:', e.message); }
    }

    // 2. CheapShark (pour les jeux Steam)
    const steamMatch = gameId.match(/^steam-(\d+)$/);
    if (steamMatch) {
      try {
        const data = await cheapsharkGet(`https://www.cheapshark.com/api/1.0/games?steamAppID=${steamMatch[1]}`);
        if (data?.length > 0) {
          const game = data[0];
          if (game.cheapest && game.cheapestDealID) {
            // Deal détaillé
            const deal = await cheapsharkGet(`https://www.cheapshark.com/api/1.0/deals?id=${game.cheapestDealID}`);
            if (deal?.gameInfo) {
              const info = CHEAPSHARK_STORES[parseInt(deal.gameInfo.storeID)] || { name: 'Boutique en ligne', domain: '', platform: 'pc' };
              offers.push({
                store: info,
                url: `https://www.cheapshark.com/redirect?dealID=${game.cheapestDealID}`,
                price: parseFloat(deal.gameInfo.salePrice),
                normalPrice: parseFloat(deal.gameInfo.retailPrice),
                currency: 'EUR',
                isOnSale: deal.gameInfo.salePrice < deal.gameInfo.retailPrice,
              });
            }
          }
          // Toutes les offres disponibles
          if (game.deals) {
            for (const d of game.deals) {
              const info = CHEAPSHARK_STORES[parseInt(d.storeID)] || { name: `Store #${d.storeID}`, domain: '', platform: 'pc' };
              if (offers.some(o => o.store.name === info.name)) continue;
              offers.push({
                store: info,
                url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
                price: parseFloat(d.price),
                normalPrice: parseFloat(d.retailPrice),
                currency: 'EUR',
                isOnSale: parseFloat(d.price) < parseFloat(d.retailPrice),
              });
            }
          }
        }
      } catch (e) { console.error('[GamePrices] CheapShark error:', e.message); }
    }

    // 3. Fallback : store officiel selon la plateforme
    if (offers.length === 0) {
      const platform = gameId.split('-')[0];
      const fallbacks = {
        steam: { name: 'Steam', domain: 'store.steampowered.com', platform: 'steam' },
        nintendo: { name: 'Nintendo eShop', domain: 'nintendo.com', platform: 'nintendo' },
        xbox: { name: 'Xbox Store', domain: 'xbox.com', platform: 'xbox' },
        ps5: { name: 'PlayStation Store', domain: 'store.playstation.com', platform: 'ps5' },
        ps4: { name: 'PlayStation Store', domain: 'store.playstation.com', platform: 'ps4' },
      };
      if (fallbacks[platform]) {
        offers.push({
          store: fallbacks[platform],
          url: fallbacks[platform].domain ? `https://${fallbacks[platform].domain}` : null,
          price: null, normalPrice: null, currency: null, isOnSale: false,
        });
      }
    }

    res.json({ gameId, offers });
  } catch (err) {
    console.error('[GamePrices] Error:', err.message);
    res.json({ gameId: req.params.gameId, offers: [] });
  }
});

function cheapsharkGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============ BOOSTER SYSTEM ============

app.get('/api/booster/points', requireAuth, async (req, res) => {
  try {
    const data = await db.getBoosterPoints(req.session.userId);
    if (!data.claimed_first_login) {
      await db.claimFirstLoginPoints(req.session.userId);
      data.points = 1;
      data.claimed_first_login = true;
    }
    res.json({ points: data.points });
  } catch (err) {
    console.error('[BoosterPoints] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/booster/boost', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    await db.boostGame(req.session.userId, gameId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[BoosterBoost] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/booster/top', async (req, res) => {
  try {
    const top = await db.getTopBoostedGames();
    res.json({ top });
  } catch (err) {
    console.error('[BoosterTop] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/booster/status/:gameId', requireAuth, async (req, res) => {
  try {
    const boosted = await db.getUserBoostStatus(req.session.userId, req.params.gameId);
    res.json({ boosted });
  } catch (err) {
    console.error('[BoosterStatus] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — vérifier les variables d'environnement (admin only)
app.get('/api/debug/env', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminIds.length === 0 || !adminIds.includes(String(req.session.userId))) {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs. Définis ADMIN_IDS dans les variables d\'environnement.' });
  }
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

// ============ BOOST COMMUNAUTAIRE ============

app.get('/api/boost/points', requireAuth, async (req, res) => {
  try {
    let bp = await db.getBoostPoints(req.session.userId);
    const now = new Date();
    const year = now.getFullYear();
    const jan1 = new Date(year, 0, 1);
    const week = Math.ceil((((now - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    if (bp.last_boost_week < week) {
      const points = await db.resetWeeklyBoostPoints(req.session.userId);
      return res.json({ points, reset: true });
    }
    res.json({ points: bp.boost_points, reset: false });
  } catch (err) {
    console.error('[BoostPoints] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boost', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    const result = await db.boostGame(req.session.userId, gameId);
    console.log('[Boost] User', req.session.userId, 'boosted', gameId);
    res.json({ ok: true, remaining: result.remaining });
  } catch (err) {
    console.error('[Boost] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/boost/top', async (req, res) => {
  try {
    const top = await db.getTopBoosted(10);
    const enriched = await Promise.all(top.map(async (b) => {
      const { data } = await db.supabaseAdmin.from('catalog').select('*').eq('game_id', b.game_id).maybeSingle();
      return { ...b, game: data || null };
    }));
    res.json({ top: enriched.filter(b => b.game) });
  } catch (err) {
    console.error('[BoostTop] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/boost/count/:gameId', async (req, res) => {
  try {
    const count = await db.getGameBoostCount(req.params.gameId);
    res.json({ gameId: req.params.gameId, count });
  } catch (err) {
    console.error('[BoostCount] Error:', err.message);
    res.json({ gameId: req.params.gameId, count: 0 });
  }
});

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
  console.log('[Server] SUPABASE_URL:', process.env.SUPABASE_URL ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'defined' : 'MISSING');
  console.log('[Server] PUBLIC_URL:', process.env.PUBLIC_URL || '⚠️ NON DÉFINI — Steam OpenID va échouer ! Définir PUBLIC_URL dans les env vars Render');
  console.log('[Server] STEAM_API_KEY:', process.env.STEAM_API_KEY ? 'defined' : 'NON DÉFINI — Steam import ne marchera pas');
  console.log('[Server] XBL_API_KEY:', process.env.XBL_API_KEY ? 'defined' : 'NON DÉFINI — Xbox import ne marchera pas');
  console.log('[Server] RAWG_API_KEY:', process.env.RAWG_API_KEY ? 'defined' : 'NON DÉFINI — catalogue RAWG indisponible');
  if (!process.env.PUBLIC_URL) {
    console.warn('⚠️  PUBLIC_URL manquant. Steam OpenID redirigera vers localhost au lieu de l\'URL publique.');
    console.warn('    Ajoute PUBLIC_URL=https://ton-app.render.com dans les env vars Render.');
  }
});
