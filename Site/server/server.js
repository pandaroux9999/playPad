const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const SupabaseSessionStore = require('./session-store');
const {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  exchangeRefreshTokenForAuthTokens,
  getPurchasedGames,
  getUserPlayedGames,
} = require('psn-api');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

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
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "https:", "data:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "https://accounts.google.com", "https://steamcommunity.com"],
      manifestSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
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

// Rate limiting : catalogue et recherche (évite le crawling intensif)
const catalogLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: 'Trop de requêtes catalogue' } });
const searchLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: 'Trop de recherches' } });
const contactLimiter = rateLimit({ windowMs: 60000, max: 3, message: { error: 'Trop de messages de contact' } });
const messageLimiter = rateLimit({ windowMs: 60000, max: 20, message: { error: 'Trop de messages' } });
const generalLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: 'Trop de requêtes' } });

const corsOrigin = process.env.PUBLIC_URL || 'http://localhost:3000';
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));

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

// CSRF protection : vérifie X-Requested-With + Origin/Referer
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'Requête cross-site refusée' });
    }
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const allowedOrigin = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    if (origin && !origin.startsWith(allowedOrigin)) {
      return res.status(403).json({ error: 'Origine refusée' });
    }
    if (!origin && referer && !referer.startsWith(allowedOrigin)) {
      return res.status(403).json({ error: 'Referer refusé' });
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// Validation de la complexité du mot de passe
function validatePassword(password) {
  // Exported for testing
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

// Sanitization anti-XSS : échappe les caractères HTML
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>&"']/g, function(c) {
    return {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;'}[c];
  });
}

// Validation d'URL
function isValidUrl(str) {
  if (typeof str !== 'string' || !str) return false;
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// Vérifie la signature d'un id_token Google via l'endpoint tokeninfo de Google
async function verifyGoogleIdToken(idToken) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
  const data = await res.json();
  if (data.error) throw new Error('Token Google invalide');
  if (data.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('Client ID mismatch');
  if (!data.email) throw new Error('Email manquant dans le token');
  return data;
}

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, displayName, password, email } = req.body;
    console.log('[Register] Request:', { username, displayName, email: email ? email[0] + '***' : undefined });
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
      console.log('[Register] Email already used:', email[0] + '***');
      return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte' });
    }
    const hashed = await bcrypt.hash(password, 12);
    const userId = await db.createUser(username, displayName, hashed, email);
    const user = await db.getUserById(userId);
    req.session.userId = userId;
    await db.claimFirstLoginPoints(userId);
    console.log('[Register] Success:', username, 'id:', userId, '+ 1 booster point');
    res.json({ user });
  } catch (err) {
    console.error('[Register] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const user = await db.getUserByEmail(email);
    if (user) {
      const token = await db.createResetToken(user.id, 'password');
      console.log('[ForgotPassword] Token créé pour', email[0] + '***');
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
      console.log('[ForgotUsername] Demande pour', email[0] + '***');
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
    const hashed = await bcrypt.hash(newPassword, 12);
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
      await bcrypt.compare(password, '$2b$12$' + 'x'.repeat(53));
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
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) { console.error('[Logout] Error:', err.message); return res.status(500).json({ error: 'Erreur lors de la déconnexion' }); }
    res.json({ ok: true });
  });
});

// ─── Google OAuth ───────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google OAuth non configuré' });
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;
  req.session.save(() => {
    const redirectUri = `${PUBLIC_URL}/api/auth/google/callback`;
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email&access_type=offline&state=${state}`;
    res.redirect(url);
  });
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Code manquant');
    if (!state || state !== req.session.googleOAuthState) {
      return res.status(403).send('État CSRF invalide');
    }
    delete req.session.googleOAuthState;
    const redirectUri = `${PUBLIC_URL}/api/auth/google/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) return res.status(400).send('Token invalide');
    // Vérification complète de la signature via l'API Google
    const payload = await verifyGoogleIdToken(tokenData.id_token);
    const googleEmail = payload.email;
    const googleName = payload.name || googleEmail.split('@')[0];
    let user = await db.getUserByEmail(googleEmail);
    if (!user) {
      const username = 'google_' + payload.sub.slice(0, 8);
      const hashed = await bcrypt.hash(payload.sub + process.env.SESSION_SECRET, 10);
      const userId = await db.createUser(username, googleName, hashed, googleEmail);
      if (payload.picture && isValidUrl(payload.picture)) {
        await db.updateAvatar(userId, payload.picture);
      }
      user = await db.getUserById(userId);
    }
    req.session.userId = user.id;
    res.redirect(`${PUBLIC_URL}/?google_login=1`);
  } catch (err) {
    console.error('[GoogleAuth] Error:', err.message);
    res.status(500).send('Erreur authentification Google');
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user });
  } catch (err) {
    console.error('[Me] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/games', requireAuth, async (req, res) => {
  try {
    const games = await db.getGames(req.session.userId);
    res.json({ games });
  } catch (err) {
    console.error('[Games] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/games/status', requireAuth, async (req, res) => {
  try {
    const { gameId, status } = req.body;
    await db.updateGameStatus(req.session.userId, gameId, status);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Status] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/games/review', requireAuth, async (req, res) => {
  try {
    const { gameId, rating, reviewText, reviewPublic, gameTitle, gameCover } = req.body;
    const sanitizedReview = stripHtml(reviewText || '');
    const sanitizedTitle = stripHtml(gameTitle || '');
    const sanitizedCover = gameCover && isValidUrl(gameCover) ? gameCover : '';
    const isPublic = reviewPublic !== false;
    console.log('[Review] Incoming review:', { userId: req.session.userId, gameId, rating, reviewTextLength: sanitizedReview.length, isPublic, gameTitle: sanitizedTitle });
    await db.updateGameRating(req.session.userId, gameId, rating || 0, sanitizedReview, isPublic);
    console.log('[Review] updateGameRating OK');
    if (isPublic) {
      await db.savePublicReview(req.session.userId, gameId, rating || 0, sanitizedReview, sanitizedTitle, sanitizedCover);
      console.log('[Review] savePublicReview OK');
      const me = await db.getUserById(req.session.userId).catch(() => {});
      if (isPublic && me) {
        notifyOtherReviewers(req.session.userId, gameId, me.display_name, sTitle).catch(() => {});
      }
    }
    res.json({ ok: true });
    console.log('[Review] Response sent successfully');
  } catch (err) {
    console.error('[Review] Error:', err.message);
    console.error('[Review] Stack:', err.stack);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/reviews/feed', requireAuth, async (req, res) => {
  try {
    const reviews = await db.getAllPublicReviews();
    const ids = reviews.map(r => r.id);
    let votes = {}, userVotes = {};
    try {
      const results = await Promise.all([
        ids.length ? db.getReviewVotes(ids) : {},
        db.getUserReviewVotes(req.session.userId),
      ]);
      votes = results[0];
      userVotes = results[1];
    } catch (e) {
      // review_votes table may not exist yet
    }
    const enriched = reviews.map(r => ({
      ...r,
      thumbs_up: votes[r.id]?.up || 0,
      thumbs_down: votes[r.id]?.down || 0,
      my_vote: userVotes[r.id] || 0,
    }));
    res.json({ reviews: enriched });
  } catch (err) {
    console.error('[ReviewsFeed] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/reviews/:id/vote', requireAuth, async (req, res) => {
  try {
    const reviewId = parseInt(req.params.id);
    const { vote } = req.body;
    if (![1, -1, 0].includes(vote)) return res.status(400).json({ error: 'Vote invalide' });
    if (vote === 0) {
      try { await db.supabaseAdmin.from('review_votes').delete().eq('user_id', req.session.userId).eq('review_id', reviewId); } catch (e) {}
    } else {
      await db.voteReview(req.session.userId, reviewId, vote);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[ReviewVote] Error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/reviews/:id/reply', requireAuth, async (req, res) => {
  try {
    const parentId = parseInt(req.params.id);
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Texte requis' });
    const reply = await db.saveReviewReply(req.session.userId, parentId, stripHtml(text.trim()));
    if (!reply) return res.status(400).json({ error: 'Fonctionnalité temporairement indisponible' });
    res.json({ reply });
  } catch (err) {
    console.error('[ReviewReply] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/reviews/:id/replies', requireAuth, async (req, res) => {
  try {
    const parentId = parseInt(req.params.id);
    const replies = await db.getReviewReplies(parentId);
    res.json({ replies });
  } catch (err) {
    console.error('[ReviewReplies] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/games/reviews', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.query;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    const reviews = await db.getGameReviews(gameId);
    const ids = reviews.map(r => r.id);
    let votes = {}, userVotes = {};
    try {
      const results = await Promise.all([
        ids.length ? db.getReviewVotes(ids) : {},
        db.getUserReviewVotes(req.session.userId),
      ]);
      votes = results[0];
      userVotes = results[1];
    } catch (e) {}
    const enriched = reviews.map(r => ({
      ...r,
      thumbs_up: votes[r.id]?.up || 0,
      thumbs_down: votes[r.id]?.down || 0,
      my_vote: userVotes[r.id] || 0,
    }));
    res.json({ reviews: enriched });
  } catch (err) {
    console.error('[GameReviews] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/wishlist', requireAuth, async (req, res) => {
  try {
    const ids = await db.getWishlist(req.session.userId);
    res.json({ wishlist: ids });
  } catch (err) {
    console.error('[Wishlist] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/wishlist/toggle', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    const added = await db.toggleWishlist(req.session.userId, gameId);
    res.json({ added });
  } catch (err) {
    console.error('[WishlistToggle] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/topthree', requireAuth, async (req, res) => {
  try {
    const top = await db.getTopThree(req.session.userId);
    res.json({ topThree: top });
  } catch (err) {
    console.error('[TopThree] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/topthree', requireAuth, async (req, res) => {
  try {
    const { gameId, position } = req.body;
    await db.setTopThree(req.session.userId, gameId, position);
    res.json({ ok: true });
  } catch (err) {
    console.error('[TopThreeSet] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    await db.deleteUserAccount(req.session.userId);
    req.session.destroy();
    res.json({ ok: true });
  } catch (err) {
    console.error('[AccountDelete] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/games/ratings', async (req, res) => {
  try {
    const ratings = await db.getGameAvgRatings();
    res.json({ ratings });
  } catch (err) {
    console.error('[Ratings] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/catalog', catalogLimiter, async (req, res) => {
  try {
    const { search, letter } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 60, 500);
    if (search || (letter && letter !== 'all')) {
      const result = await db.searchCatalog({ search, letter, page, limit });
      return res.json({ catalog: result.data, total: result.total, page, limit });
    }
    const catalog = await db.getCatalog();
    const offset = (page - 1) * limit;
    const total = catalog.length;
    res.json({ catalog: catalog.slice(offset, offset + limit), total, page, limit });
  } catch (err) {
    console.error('[Catalog] Error:', err.message, 'query:', JSON.stringify({ search: req.query.search, letter: req.query.letter, page: req.query.page }));
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/catalog/new-releases', async (req, res) => {
  try {
    const now = Date.now();
    if (now - lastNewReleasesFetch > NEW_RELEASES_TTL || newReleasesCache.length === 0) {
      newReleasesCache = await fetchNewReleases();
      lastNewReleasesFetch = now;
    }
    res.json({ releases: newReleasesCache });
  } catch (err) {
    console.error('[NewReleases] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.delete('/api/games', requireAuth, async (req, res) => {
  try {
    await db.deleteAllUserGames(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GameDeleteAll] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.delete('/api/games/:gameId', requireAuth, async (req, res) => {
  try {
    await db.deleteGame(req.session.userId, req.params.gameId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GameDelete] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.delete('/api/games/platform/:platform', requireAuth, async (req, res) => {
  try {
    await db.deletePlatformGames(req.session.userId, req.params.platform);
    res.json({ ok: true });
  } catch (err) {
    console.error('[PlatformDelete] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/heartbeat', requireAuth, async (req, res) => {
  try {
    await db.updateLastSeen(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Heartbeat] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
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

// ─── PSN (PlayStation Network) — helpers ──

// Obtient un access token PSN valide (refresh automatique)
async function getPsnAuth(userId) {
  const tokens = await db.getPsnTokens(userId);

  // Access token encore valide ?
  if (tokens.psn_access_token && tokens.psn_token_expires_at) {
    const expiresAt = new Date(tokens.psn_token_expires_at);
    if (expiresAt > new Date(Date.now() + 60000)) {
      return { accessToken: tokens.psn_access_token };
    }
  }

  // Sinon, refresh le token
  if (tokens.psn_refresh_token) {
    try {
      const refreshed = await exchangeRefreshTokenForAuthTokens(tokens.psn_refresh_token);
      const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
      await db.setPsnTokens(userId, refreshed.accessToken, refreshed.refreshToken, expiresAt);
      return { accessToken: refreshed.accessToken };
    } catch (e) {
      console.error('[PSN] Refresh token failed:', e.message);
    }
  }

  // Sinon, échanger le NPSSO
  if (tokens.psn_npsso) {
    const accessCode = await exchangeNpssoForAccessCode(tokens.psn_npsso);
    const auth = await exchangeAccessCodeForAuthTokens(accessCode);
    const expiresAt = new Date(Date.now() + (auth.expires_in || 3600) * 1000);
    await db.setPsnTokens(userId, auth.accessToken, auth.refreshToken, expiresAt);
    return { accessToken: auth.accessToken };
  }

  return null;
}

// Récupère les jeux PSN (achetés + joués avec playtime)
async function fetchPsnGames(userId) {
  const auth = await getPsnAuth(userId);
  if (!auth) throw new Error('Non authentifié PSN');

  const games = [];

  // 1. Jeux achetés (PS4 + PS5)
  try {
    const purchased = await getPurchasedGames(auth, {
      platform: ['ps4', 'ps5'],
      size: 200,
      sortBy: 'ACTIVE_DATE',
      sortDirection: 'desc',
    });
    const purchasedGames = purchased?.data?.purchasedTitlesRetrieve?.games || [];
    for (const g of purchasedGames) {
      const platform = g.platform === 'PS5' ? 'ps5' : 'ps4';
      games.push({
        game_id: 'psn-' + (g.titleId || g.contentId || ''),
        title: g.name || 'Unknown',
        platform,
        playtime: 0,
        cover: g.image_url || g.imageUrl || '',
        genre: '', year: 0,
        status: 'not_started',
        user_rating: 0, review_text: '', review_public: true, has_review: 0,
      });
    }
    console.log('[PSN] getPurchasedGames OK —', purchasedGames.length, 'jeux achetés');
  } catch (e) {
    console.error('[PSN] getPurchasedGames error:', e.message);
  }

  // 2. Jeux joués (avec playtime)
  try {
    const played = await getUserPlayedGames(auth, 'me', {
      categories: 'ps4_game,ps5_native_game',
      limit: 200,
    });
    const playedGames = played?.titles || [];
    for (const g of playedGames) {
      const platform = g.category === 'ps5_native_game' ? 'ps5' : 'ps4';
      // Parser playDuration "PT228H56M33S" → minutes
      let playtime = 0;
      if (g.playDuration) {
        const match = g.playDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (match) {
          playtime = (parseInt(match[1] || 0) * 60) + parseInt(match[2] || 0);
        }
      }
      const gameId = 'psn-' + (g.titleId || '');
      const cover = g.concept?.media?.images?.[0]?.url || g.imageUrl || '';
      // Mettre à jour si déjà présent (ajouter playtime)
      const existing = games.find(x => x.game_id === gameId);
      if (existing) {
        existing.playtime = playtime;
        existing.status = playtime > 0 ? 'playing' : 'not_started';
        if (cover && !existing.cover) existing.cover = cover;
      } else {
        games.push({
          game_id: gameId,
          title: g.name || 'Unknown',
          platform,
          playtime,
          cover,
          genre: '', year: 0,
          status: playtime > 0 ? 'playing' : 'not_started',
          user_rating: 0, review_text: '', review_public: true, has_review: 0,
        });
      }
    }
    console.log('[PSN] getUserPlayedGames OK —', playedGames.length, 'jeux joués');
  } catch (e) {
    console.error('[PSN] getUserPlayedGames error:', e.message);
  }

  return games;
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
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
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

let lastEpicImport = 0;
const EPIC_IMPORT_COOLDOWN = 60000; // 1 min entre chaque import

// Epic Games — connexion + import des jeux du store Epic via RAWG
app.post('/api/platform/epic/connect', requireAuth, async (req, res) => {
  let { epicUsername } = req.body;
  if (!epicUsername) return res.status(400).json({ error: 'Nom d\'utilisateur Epic requis' });
  try {
    await db.setEpicUsername(req.session.userId, epicUsername);
    const rawgKey = process.env.RAWG_API_KEY;
    let count = 0, warning = '';
    const now = Date.now();
    if (rawgKey && now - lastEpicImport > EPIC_IMPORT_COOLDOWN) {
      lastEpicImport = now;
      // Importe les jeux populaires du store Epic Games via RAWG
      for (let page = 1; page <= 3; page++) {
        try {
          const url = `https://api.rawg.io/api/games?key=${rawgKey}&stores=11&page=${page}&page_size=40&ordering=-added`;
          const data = await rawgApiGet(url);
          if (!data || !data.results) break;
          for (const item of data.results) {
            if (!item.name) continue;
            await db.ensureCatalogGame({
              game_id: `epic-${item.id}`,
              title: item.name,
              platform: 'epic',
              cover: item.background_image || '',
              genre: (item.genres || []).map(g => g.name).join(', '),
              year: item.released ? (parseInt(item.released.split('-')[0]) || 0) : 0,
              developer: '',
              publisher: '',
            });
            count++;
          }
          if (!data.next) break;
        } catch (e) {
          console.error('[EpicConnect] RAWG error page', page, ':', e.message);
          break;
        }
      }
      if (count === 0) warning = 'Aucun jeu Epic trouvé via RAWG';
    } else if (!rawgKey) {
      warning = 'RAWG_API_KEY non configurée — seul le pseudo a été sauvegardé';
    } else {
      warning = 'Import déjà effectué récemment — attends 1 min';
    }
    console.log('[EpicConnect] OK, count:', count, 'warning:', warning);
    res.json({ ok: true, count, username: epicUsername, warning });
  } catch (err) {
    console.error('[EpicConnect] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── PlayStation Network (PSN) — connexion + import des jeux ──

app.post('/api/platform/psn/connect', requireAuth, async (req, res) => {
  const { npsso } = req.body;
  if (!npsso || npsso.length < 60) {
    return res.status(400).json({ error: 'NPSSO invalide (64 caractères requis). Va sur ca.account.sony.com/api/v1/ssocookie pour le récupérer.' });
  }
  try {
    const accessCode = await exchangeNpssoForAccessCode(npsso);
    const auth = await exchangeAccessCodeForAuthTokens(accessCode);
    const expiresAt = new Date(Date.now() + (auth.expires_in || 3600) * 1000);

    await db.setPsnNpsso(req.session.userId, npsso);
    await db.setPsnTokens(req.session.userId, auth.accessToken, auth.refreshToken, expiresAt);

    const games = await fetchPsnGames(req.session.userId);
    for (const game of games) {
      await db.upsertGame(req.session.userId, game);
      await db.ensureCatalogGame(game);
    }

    console.log('[PSNConnect] OK —', games.length, 'jeux importés');
    res.json({ ok: true, count: games.length });
  } catch (err) {
    console.error('[PSNConnect] Error:', err.message);
    res.status(500).json({ error: 'Échec de connexion PSN — vérifie ton NPSSO' });
  }
});

app.post('/api/platform/psn/resync', requireAuth, async (req, res) => {
  try {
    const tokens = await db.getPsnTokens(req.session.userId);
    if (!tokens.psn_npsso) {
      return res.status(400).json({ error: 'Aucun compte PSN connecté' });
    }
    const games = await fetchPsnGames(req.session.userId);
    if (games.length === 0) {
      return res.status(400).json({ error: 'Aucun jeu trouvé — vérifie les paramètres de confidentialité PSN (profil public requis).' });
    }
    for (const game of games) {
      await db.upsertGame(req.session.userId, game);
      await db.ensureCatalogGame(game);
    }
    console.log('[PSNResync] OK —', games.length, 'jeux resynchronisés');
    res.json({ ok: true, count: games.length });
  } catch (err) {
    console.error('[PSNResync] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/platform/psn/disconnect', requireAuth, async (req, res) => {
  try {
    await db.clearPsnTokens(req.session.userId);
    await db.deletePlatformGames(req.session.userId, 'ps4');
    await db.deletePlatformGames(req.session.userId, 'ps5');
    res.json({ ok: true });
  } catch (err) {
    console.error('[PSNDisconnect] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/platform/psn/status', requireAuth, async (req, res) => {
  try {
    const tokens = await db.getPsnTokens(req.session.userId);
    res.json({
      connected: !!tokens.psn_npsso,
      tokenValid: tokens.psn_token_expires_at ? new Date(tokens.psn_token_expires_at) > new Date() : false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne' });
  }
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

app.post('/api/catalog/populate', requireAuth, async (req, res) => {
  const now = Date.now();
  if (now - lastCatalogPopulate < CATALOG_COOLDOWN) {
    return res.json({ ok: true, count: 0, cooldown: true });
  }
  lastCatalogPopulate = now;
  res.json({ ok: true, pending: true, message: "L'import prend plusieurs minutes, il tourne en arrière-plan" });
  (async () => {
    try {
      const rawgKey = process.env.RAWG_API_KEY;
      const igdbId = process.env.TWITCH_CLIENT_ID;
      const igdbSecret = process.env.TWITCH_CLIENT_SECRET;
      const existingCount = await db.getCatalogCount();
      let steamTotal = 0, igdbTotal = 0;
      if (existingCount < 500 && rawgKey) {
        await populateCatalogFromRAWG(rawgKey);
      }
      console.log('[Catalog] Démarrage import Steam...');
      steamTotal = await populateSteamFromAppList();
      if (igdbId && igdbSecret) {
        console.log('[Catalog] Démarrage import IGDB...');
        igdbTotal = await populateCatalogFromIGDB(igdbId, igdbSecret);
      }
      if (steamTotal > 0 || igdbTotal > 0) {
        db.mergeCatalogDuplicatesByTitle().then(n => { if (n > 0) console.log(`[Catalog] ${n} doublons fusionnés`); }).catch(e => console.error('[Catalog] Merge error:', e.message));
        refreshCatalogDescriptions().catch(() => {});
      }
      db.invalidateCatalogCache();
      console.log(`[Catalog] Import terminé: ${steamTotal} Steam, ${igdbTotal} IGDB`);
    } catch (err) {
      console.error('[CatalogPopulate] Error:', err.message);
    }
  })();
});

let lastDescriptionRefresh = 0;
const DESCRIPTION_REFRESH_COOLDOWN = 300000; // 5 min

// ─── Scan progress tracking (RAWG resume) ─────────────────
const SCAN_PROGRESS_PATH = path.join(__dirname, 'data', 'scan_progress.json');
function getScanProgress(key) {
  try {
    const raw = require('fs').readFileSync(SCAN_PROGRESS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data[key] || null;
  } catch { return null; }
}
function setScanProgress(key, value) {
  try {
    let data = {};
    try { data = JSON.parse(require('fs').readFileSync(SCAN_PROGRESS_PATH, 'utf-8')); } catch {}
    data[key] = value;
    require('fs').writeFileSync(SCAN_PROGRESS_PATH, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[ScanProgress] Write error:', e.message); }
}
function clearScanProgress(key) {
  if (!key) {
    try { require('fs').writeFileSync(SCAN_PROGRESS_PATH, '{}'); } catch {}
    return;
  }
  try {
    const data = JSON.parse(require('fs').readFileSync(SCAN_PROGRESS_PATH, 'utf-8'));
    delete data[key];
    require('fs').writeFileSync(SCAN_PROGRESS_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

// ─── Nouveautés (new releases) ────────────────────────────
let newReleasesCache = [];
let lastNewReleasesFetch = 0;
const NEW_RELEASES_TTL = 900000; // 15 min

// Helper : appel Steam Store featured categories (gratuit, sans clé API)
function steamStoreFeatured() {
  return new Promise((resolve, reject) => {
    https.get('https://store.steampowered.com/api/featuredcategories?l=french', { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchNewReleases() {
  const tStart = Date.now();
  const rawgKey = process.env.RAWG_API_KEY;
  let allGames = [];
  const seenIds = new Set();

  // ── Source 1 : RAWG (jeux récents toutes plateformes) ──
  if (rawgKey) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startDate = threeMonthsAgo.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];
    const tRawg = Date.now();
    const progressKey = 'rawg_newreleases_page';
    let startPage = getScanProgress(progressKey) || 1;
    if (startPage < 1) startPage = 1;
    console.log(`[NewReleases] RAWG : jeux sortis entre ${startDate} et ${endDate} (reprise page ${startPage})`);
    for (let page = startPage; page <= 10; page++) {
      const url = `https://api.rawg.io/api/games?key=${rawgKey}&dates=${startDate},${endDate}&ordering=-released&page=${page}&page_size=40`;
      try {
        const tPage = Date.now();
        const data = await rawgApiGet(url);
        if (!data || !data.results) { clearScanProgress(progressKey); break; }
        for (const item of data.results) {
          if (!item.name || seenIds.has(item.id)) continue;
          seenIds.add(item.id);
          const stores = item.stores || [];
          const steamStore = stores.find(s => s.store?.id === 1);
          const steamId = steamStore?.url?.match(/\/app\/(\d+)/)?.[1];
          const game = {
            game_id: steamId ? `steam-${steamId}` : `rawg-${item.id}`,
            title: item.name,
            platform: steamId ? 'steam' : 'pc',
            cover: item.background_image || '',
            genre: (item.genres || []).map(g => g.name).join(', '),
            year: item.released ? parseInt(item.released.split('-')[0]) : 0,
            release_date: item.released || '',
            description: item.description_raw || '',
            developer: '',
            publisher: '',
          };
          if (steamId) game.cover = `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamId}/library_600x900.jpg`;
          await db.ensureCatalogGame(game).catch(() => {});
          allGames.push(game);
        }
        if (!data.next) { clearScanProgress(progressKey); break; }
        setScanProgress(progressKey, page + 1);
        console.log(`[NewReleases] RAWG page ${page} : ${data.results.length} jeux, ${Date.now() - tPage}ms`);
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`[NewReleases] RAWG page ${page} :`, e.message);
        break;
      }
    }
    clearScanProgress(progressKey);
    console.log(`[NewReleases] RAWG terminé : ${allGames.length} jeux en ${Date.now() - tRawg}ms`);
  }

  // ── Source 2 : Steam Store (nouveautés officielles Steam) ──
  const tSteam = Date.now();
  try {
    const featured = await steamStoreFeatured();
    const steamItems = featured?.new_releases?.items || [];
    console.log(`[NewReleases] Steam Store : ${steamItems.length} nouveautés en ${Date.now() - tSteam}ms`);
    for (const item of steamItems) {
      if (!item.name || seenIds.has('steam-' + item.id)) continue;
      seenIds.add('steam-' + item.id);
      const game = {
        game_id: `steam-${item.id}`,
        title: item.name,
        platform: 'steam',
        cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.id}/library_600x900.jpg`,
        genre: (item.genres || []).map(g => g.description || g.name || '').join(', '),
        year: item.release_date ? parseInt(item.release_date.date?.match(/\d{4}/)?.[0]) : 0,
        release_date: item.release_date?.date || '',
        description: item.short_description || '',
        developer: (item.developers || []).join(', '),
        publisher: (item.publishers || []).join(', '),
      };
      await db.ensureCatalogGame(game).catch(() => {});
      allGames.push(game);
    }
  } catch (e) {
    console.error('[NewReleases] Steam Store :', e.message);
  }

  // ── Source 3 : détails Steam pour les jeux sans description ──
  const tDesc = Date.now();
  const noDesc = allGames.filter(g => !g.description && g.game_id.startsWith('steam-'));
  for (const game of noDesc.slice(0, 20)) {
    try {
      const appid = game.game_id.replace('steam-', '');
      const d = await steamStoreGet(appid);
      if (d?.data) {
        game.description = d.data.short_description || d.data.about_the_game || '';
        game.developer = (d.data.developers || []).join(', ');
        game.publisher = (d.data.publishers || []).join(', ');
        if (!game.genre && d.data.genres) game.genre = d.data.genres.map(g => g.description).join(', ');
        await db.ensureCatalogGame(game).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (noDesc.length > 0) console.log(`[NewReleases] Descriptions : ${Math.min(noDesc.length, 20)} jeux enrichis en ${Date.now() - tDesc}ms`);

  const totalMs = Date.now() - tStart;
  console.log(`[NewReleases] Terminé : ${allGames.length} jeux récents (RAWG + Steam Store) en ${totalMs}ms`);
  return allGames;
}

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
  for (let y = 1990; y <= 2026; y += 2) {
    const end = Math.min(y + 1, 2026);
    yearRanges.push({ label: String(y), start: `${y}-01-01`, end: `${end}-12-31`, pages: 50 });
  }
  // catch-all for games missing dates
  yearRanges.push({ label: 'nodate', start: '1970-01-01', end: '2026-12-31', pages: 100 });

  const progressKey = 'rawg_catalog_progress';
  const saved = getScanProgress(progressKey);
  const resume = saved && saved.pi !== undefined ? saved : null;
  let started = resume === null;

  for (let pi = 0; pi < targets.length; pi++) {
    const plat = targets[pi];
    for (let ri = 0; ri < yearRanges.length; ri++) {
      const range = yearRanges[ri];
      // Skip until we reach the saved position
      if (!started) {
        if (pi < resume.pi || (pi === resume.pi && ri < resume.ri)) continue;
        started = true;
      }
      let page = resume && resume.pi === pi && resume.ri === ri ? resume.page : 1;
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
          setScanProgress(progressKey, { pi, ri, page });
          await new Promise(r => setTimeout(r, 250));
        } catch (e) {
          console.error(`[RAWG] Error ${plat.prefix} ${range.label} page ${page}:`, e.message);
          break;
        }
      }
    }
  }
  clearScanProgress(progressKey);
  console.log(`[Catalog] ${total} ajoutés, ${skipped} ignorés (déjà présents)`);
  return total;
}

async function populateOnlineGames(apiKey) {
  if (!apiKey) return 0;
  console.log('[OnlineGames] Récupération des jeux en ligne/multi...');
  let total = 0;
  const seen = new Set();
  try {
    const existing = await db.getCatalog();
    for (const g of existing) seen.add(g.game_id);
  } catch (e) {}
  const queries = [
    { url: `https://api.rawg.io/api/games?key=${apiKey}&tags=multiplayer&ordering=-rating&page_size=40`, pages: 20 },
    { url: `https://api.rawg.io/api/games?key=${apiKey}&tags=mmo&ordering=-added&page_size=40`, pages: 20 },
    { url: `https://api.rawg.io/api/games?key=${apiKey}&tags=battle-royale&ordering=-added&page_size=40`, pages: 10 },
    { url: `https://api.rawg.io/api/games?key=${apiKey}&tags=free-to-play&ordering=-rating&page_size=40`, pages: 20 },
    { url: `https://api.rawg.io/api/games?key=${apiKey}&stores=1&ordering=-metacritic&page_size=40`, pages: 30 },
    { url: `https://api.rawg.io/api/games?key=${apiKey}&ordering=-added&page_size=40`, pages: 20 },
  ];
  const progressKey = 'rawg_onlinegames_progress';
  const savedPg = getScanProgress(progressKey);
  const resumePg = savedPg && savedPg.qi !== undefined ? savedPg : null;
  let startedPg = resumePg === null;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    if (!startedPg) {
      if (qi < resumePg.qi) continue;
      startedPg = true;
    }
    let page = resumePg && resumePg.qi === qi ? resumePg.page : 1;
    while (page <= q.pages) {
      try {
        const url = q.url + `&page=${page}`;
        const data = await rawgApiGet(url);
        if (!data || !data.results) break;
        for (const item of data.results) {
          if (!item.name) continue;
          const gid = `online-${item.id}`;
          if (seen.has(gid)) continue;
          seen.add(gid);
          await db.ensureCatalogGame({
            game_id: gid, title: item.name, platform: 'pc',
            cover: item.background_image || '',
            genre: (item.genres || []).map(g => g.name).join(', '),
            year: item.released ? (parseInt(item.released.split('-')[0]) || 0) : 0,
          });
          total++;
        }
        if (!data.next) break;
        page++;
        setScanProgress(progressKey, { qi, page });
        await new Promise(r => setTimeout(r, 200));
      } catch (e) { break; }
    }
  }
  clearScanProgress(progressKey);
  console.log(`[OnlineGames] ${total} jeux en ligne ajoutés`);
  return total;
}

async function populateSteamFromAppList() {
  // SteamSpy est gratuit, pas de clé API nécessaire
  let totalAdded = 0;
  try {
    console.log('[SteamAppList] Importation de tous les jeux Steam...');
    const nonGameKeywords = ['soundtrack', 'dlc pack', 'wallpaper', 'sdk', 'artbook', 'season pass', 'expansion pack', 'playtest'];
    const fetchSteamSpy = (url) => new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
        let b = '';
        resp.on('data', c => b += c);
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject(new Error('HTTP ' + resp.statusCode));
          try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
    const spyToEntries = (d, limit) => Object.entries(d || {}).slice(0, limit || 99999).filter(([, v]) => v && v.name).map(([k, v]) => ({
      appid: parseInt(k), name: v.name, developer: v.developer || '', publisher: v.publisher || '',
      genre: v.tags ? Object.keys(v.tags).slice(0, 5).join(', ') : '',
    }));
    const upsertBatch = async (batch) => {
      if (batch.length === 0) return 0;
      await db.batchUpsertCatalog(batch);
      return batch.length;
    };
    const buildEntries = (entries) => {
      const result = [];
      for (const app of entries) {
        const gameId = `steam-${app.appid}`;
        const name = (app.name || '').trim();
        if (!name || name.length < 2) continue;
        if (nonGameKeywords.some(kw => name.toLowerCase().includes(kw))) continue;
        result.push({
          game_id: gameId, title: name, platform: 'steam',
          cover: `https://cdn.cloudflare.steamstatic.com/steam/apps/${app.appid}/library_600x900.jpg`,
          genre: app.genre || '', year: 0, developer: app.developer || '', publisher: app.publisher || ''
        });
      }
      return result;
    };
    // 1) request=all (~1000 jeux) — upsert immédiat
    const seenIds = new Set();
    try {
      const d = await fetchSteamSpy('https://steamspy.com/api.php?request=all');
      const entries = buildEntries(spyToEntries(d)).filter(e => { if (seenIds.has(e.game_id)) return false; seenIds.add(e.game_id); return true; });
      const added = await upsertBatch(entries);
      totalAdded += added;
      console.log('[SteamAppList] request=all:', entries.length, 'jeux,', added, 'nouveaux');
    } catch (e) { console.log('[SteamAppList] request=all échoué:', e.message); }
    // 2) Par genre — upsert immédiat après chaque genre
    const genres = ['Action', 'Adventure', 'Casual', 'Indie', 'Massively%20Multiplayer', 'Racing', 'RPG', 'Simulation', 'Sports', 'Strategy', 'Free%20to%20Play', 'Early%20Access', 'Animation%20%26%20Modeling', 'Audio%20Production', 'Design%20%26%20Illustration', 'Education', 'Game%20Development', 'Photo%20Editing', 'Software%20Training', 'Utilities', 'Video%20Production', 'Web%20Publishing'];
    for (const genre of genres) {
      try {
      const d = await fetchSteamSpy('https://steamspy.com/api.php?request=genre&genre=' + genre);
      const entries = buildEntries(spyToEntries(d)).filter(e => { if (seenIds.has(e.game_id)) return false; seenIds.add(e.game_id); return true; });
        const added = await upsertBatch(entries);
        totalAdded += added;
        console.log('[SteamAppList] Genre', decodeURIComponent(genre), ':', entries.length, 'jeux,', added, 'nouveaux (total', totalAdded, 'nouveaux)');
        if (genre !== genres[genres.length - 1]) await new Promise(r => setTimeout(r, 1000));
      } catch (e) { console.log('[SteamAppList] Genre', genre, 'échoué:', e.message); }
    }
    // 3) Top listes supplémentaires
    for (const req of ['top100forever', 'top100in2weeks', 'top100owned']) {
      try {
        const d = await fetchSteamSpy('https://steamspy.com/api.php?request=' + req);
        const entries = buildEntries(spyToEntries(d)).filter(e => { if (seenIds.has(e.game_id)) return false; seenIds.add(e.game_id); return true; });
        const added = await upsertBatch(entries);
        totalAdded += added;
        console.log('[SteamAppList]', req, ':', entries.length, 'jeux,', added, 'nouveaux');
        await new Promise(r => setTimeout(r, 500));
      } catch (e) { console.log('[SteamAppList]', req, 'échoué:', e.message); }
    }
    console.log(`[SteamAppList] ${totalAdded} jeux Steam ajoutés`);
  } catch (e) { console.error('[SteamAppList] Error:', e.message); }
  return totalAdded;
}

// ─── Cover Fallback ─────────────────────────────────────────
async function fixMissingCovers() {
  try {
    const { data: noCover } = await db.supabaseAdmin
      .from('catalog')
      .select('game_id, title, platform')
      .or('cover.is.null,cover.eq.');
    if (!noCover || noCover.length === 0) return 0;
    let fixed = 0;
    for (const g of noCover.slice(0, 200)) {
      try {
        if (g.game_id.startsWith('steam-')) {
          const appid = g.game_id.replace('steam-', '');
          const cover = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;
          await db.supabaseAdmin.from('catalog').update({ cover }).eq('game_id', g.game_id);
          fixed++;
        } else {
          // Cherche l'appid Steam via SteamSpy search
          const searchRes = await new Promise((resolve, reject) => {
            const req = https.get(`https://steamspy.com/api.php?request=appdetails&appid=0&q=${encodeURIComponent(g.title)}`, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
              let b = ''; resp.on('data', c => b += c); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
            });
            req.on('error', reject); req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
          });
          if (searchRes && searchRes.name && searchRes.name.toLowerCase() === g.title.toLowerCase()) {
            const appid = searchRes.appid;
            if (appid) {
              const cover = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;
              await db.supabaseAdmin.from('catalog').update({ cover }).eq('game_id', g.game_id);
              fixed++;
            }
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e) { /* skip */ }
    }
    if (fixed > 0) console.log(`[Covers] ${fixed} couvertures corrigées`);
    return fixed;
  } catch (e) { console.error('[Covers] Error:', e.message); return 0; }
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
    }
  } catch (e) {
    console.error('[Catalog] Erreur peuplement initial:', e.message);
  }
  // Steam App List : importé UNIQUEMENT via l'API /api/catalog/populate (pas au démarrage)
  // Jeux cultes : toujours insérés (indépendant du seed)
  try {
    const { GAMES_CATALOG } = require('./seed');
    const curatedIds = new Set(GAMES_CATALOG.map(g => g.game_id));
    const existing = await db.getCatalog();
    const existingIds = new Set(existing.map(g => g.game_id));
    const missing = GAMES_CATALOG.filter(g => !existingIds.has(g.game_id));
    if (missing.length > 0) { await db.batchUpsertCatalog(missing); }
    console.log(`[Catalog] ${missing.length} jeux cultes ajoutés (${GAMES_CATALOG.length - missing.length} déjà présents)`);
  } catch (e) { console.error('[Catalog] Erreur jeux cultes:', e.message); }
  // Correction des couvertures manquantes
  try { await fixMissingCovers(); } catch (e) { console.error('[Covers] Error:', e.message); }
  // Données de démonstration après le catalogue
  try {
    const { seedDemoData } = require('./seed');
    await seedDemoData();
  } catch (e) {
    console.error('[Seed] Erreur:', e.message);
  }
  // Démarre le rafraîchissement périodique des actualités
  startNewsRefresh();
  // Premier chargement des nouveautés + refresh toutes les heures
  fetchNewReleases().then(r => { newReleasesCache = r; lastNewReleasesFetch = Date.now(); console.log(`[NewReleases] ${r.length} jeux chargés au démarrage`); }).catch(e => console.error('[NewReleases] Erreur démarrage:', e.message));
  setInterval(() => {
    fetchNewReleases().then(r => { newReleasesCache = r; lastNewReleasesFetch = Date.now(); }).catch(e => console.error('[NewReleases] Erreur refresh:', e.message));
  }, NEW_RELEASES_TTL);
  console.log('[Startup] Prêt');
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

// ─── IGDB (Twitch) API ─────────────────────────────────────────
// Plateformes IGDB : https://api.igdb.com/v4/platforms
// Obtenir client_id + client_secret : https://dev.twitch.tv/console
async function igdbGetToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
    const req = https.request('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.access_token); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function igdbApiGet(url, clientId, token, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
        'User-Agent': 'PlayPad/1.0',
      },
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('IGDB timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const IGDB_PLATFORMS = [
  { id: 6,   prefix: 'pc',       name: 'PC' },
  { id: 49,  prefix: 'xbox',     name: 'Xbox One' },
  { id: 169, prefix: 'xbox',     name: 'Xbox Series' },
  { id: 12,  prefix: 'xbox',     name: 'Xbox 360' },
  { id: 48,  prefix: 'ps4',      name: 'PS4' },
  { id: 167, prefix: 'ps5',      name: 'PS5' },
  { id: 9,   prefix: 'ps4',      name: 'PS3' },
  { id: 130, prefix: 'nintendo', name: 'Switch' },
];

async function populateCatalogFromIGDB(clientId, clientSecret) {
  console.log('[IGDB] Obtention du token...');
  let token;
  try { token = await igdbGetToken(clientId, clientSecret); }
  catch (e) { console.error('[IGDB] Échec obtention token:', e.message); return 0; }
  console.log('[IGDB] Token obtenu, peuplement du catalogue...');
  let total = 0;
  for (const plat of IGDB_PLATFORMS) {
    let offset = 0;
    const limit = 200;
    let page = 0;
    const maxPages = 10;
    let batch = [];
    while (page < maxPages) {
      try {
        const body = `fields name,first_release_date,genres.name,cover.url,total_rating_count; where platforms = (${plat.id}) & total_rating_count > 0; sort total_rating_count desc; limit ${limit}; offset ${offset};`;
        const data = await igdbApiGet('https://api.igdb.com/v4/games', clientId, token, body);
        if (!data || !Array.isArray(data) || data.length === 0) break;
        for (const g of data) {
          if (!g.name) continue;
          batch.push({
            game_id: `igdb-${g.id}`,
            title: g.name,
            platform: plat.prefix,
      cover: g.cover?.url ? (g.cover.url.startsWith('//') ? 'https:' : '') + g.cover.url.replace('t_thumb', 't_cover_big') : '',
            genre: (g.genres || []).map(gen => gen.name).join(', '),
            year: g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : 0,
          });
        }
        offset += limit;
        page++;
      } catch (e) {
        console.error(`[IGDB] Erreur ${plat.name} page ${page}:`, e.message);
        break;
      }
    }
    if (batch.length > 0) {
      await db.batchUpsertCatalog(batch);
      total += batch.length;
    }
    console.log(`[IGDB] ${plat.name}: ${batch.length} jeux`);
  }
  console.log(`[IGDB] ✅ ${total} jeux ajoutés`);
  return total;
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

app.get('/api/users/search', requireAuth, searchLimiter, async (req, res) => {
  try {
    const { q } = req.query;
    const users = await db.searchUsers(q || '', req.session.userId);
    res.json({ users });
  } catch (err) {
    console.error('[UserSearch] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.sendFriendRequest(req.session.userId, friendId);
    const me = await db.getUserById(req.session.userId);
    db.createNotification(friendId, 'friend', 'Demande d\'ami',
      `${me?.display_name || 'Quelqu\'un'} veut devenir ton ami`,
      { fromUserId: req.session.userId, fromName: me?.display_name });
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendRequest] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.acceptFriendRequest(req.session.userId, friendId);
    const me = await db.getUserById(req.session.userId);
    db.createNotification(friendId, 'friend', 'Demande d\'ami acceptée',
      `${me?.display_name || 'Quelqu\'un'} a accepté ta demande d'ami`,
      { fromUserId: req.session.userId, fromName: me?.display_name });
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendAccept] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  try {
    const { friendId } = req.body;
    await db.removeFriend(req.session.userId, friendId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[FriendRemove] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const friends = await db.getFriends(req.session.userId);
    res.json({ friends });
  } catch (err) {
    console.error('[Friends] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const requests = await db.getPendingRequests(req.session.userId);
    res.json({ requests });
  } catch (err) {
    console.error('[FriendRequests] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/friends/:id/games', requireAuth, async (req, res) => {
  try {
    const games = await db.getFriendGames(req.session.userId, req.params.id);
    res.json({ games: games || [] });
  } catch (err) {
    console.error('[FriendGames] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/friends/status/:id', requireAuth, async (req, res) => {
  try {
    const status = await db.getFriendStatus(req.session.userId, req.params.id);
    res.json({ status: status || 'none' });
  } catch (err) {
    console.error('[FriendStatus] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/account/avatar', requireAuth, async (req, res) => {
  try {
    const { avatarUrl } = req.body;
    const sanitizedUrl = avatarUrl && isValidUrl(avatarUrl) ? avatarUrl : '';
    await db.updateAvatar(req.session.userId, sanitizedUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Avatar] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/account/email', requireAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Format d\'email invalide' });
    const existing = await db.getUserByEmail(email);
    if (existing && existing.id !== Number(req.session.userId)) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé par un autre compte' });
    }
    const { error } = await db.supabaseAdmin.from('users').update({ email }).eq('id', req.session.userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true, email });
  } catch (err) {
    console.error('[Email] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Profil public d'un utilisateur
app.get('/api/users/:id/profile', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const isSelf = Number(req.params.id) === Number(req.session.userId);
    if (!isSelf) {
      delete user.email; delete user.steam_id; delete user.xbox_gamertag;
    }
    const games = isSelf
      ? await db.getGames(req.session.userId)
      : await db.getFriendGames(req.session.userId, req.params.id);
    const topThree = await db.getTopThree(req.params.id);
    const reviews = await db.getUserPublicReviews(req.params.id);
    res.json({ user, games: games || [], topThree, reviews });
  } catch (err) {
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/suggestions', requireAuth, async (req, res) => {
  try {
    const { toUserId, gameId, gameTitle, gameCover, message } = req.body;
    const sTitle = stripHtml(gameTitle || '');
    const sMsg = stripHtml(message || '');
    const sCover = gameCover && isValidUrl(gameCover) ? gameCover : '';
    await db.sendGameSuggestion(req.session.userId, toUserId, gameId, sTitle, sCover, sMsg);
    await db.sendMessage(req.session.userId, toUserId, 'Je te propose "' + sTitle + '"' + (sMsg ? ' : ' + sMsg : ''));
    const me = await db.getUserById(req.session.userId);
    db.createNotification(toUserId, 'friend', 'Suggestion de jeu',
      `${me?.display_name || 'Quelqu\'un'} te propose "${sTitle}"`,
      { fromUserId: req.session.userId, fromName: me?.display_name, gameId, gameTitle: sTitle });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Suggestion] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/suggestions', requireAuth, async (req, res) => {
  try {
    const suggestions = await db.getGameSuggestions(req.session.userId);
    res.json({ suggestions });
  } catch (err) {
    console.error('[Suggestions] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.delete('/api/suggestions/:id', requireAuth, async (req, res) => {
  try {
    await db.removeGameSuggestion(req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Non autorisé') return res.status(403).json({ error: err.message });
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Messages — chat entre amis
app.post('/api/messages/send', requireAuth, messageLimiter, async (req, res) => {
  try {
    const { receiverId, message } = req.body;
    if (!receiverId || !message) return res.status(400).json({ error: 'Destinataire et message requis' });
    const msg = await db.sendMessage(req.session.userId, receiverId, stripHtml(message));
    res.json({ message: msg });
  } catch (err) {
    console.error('[MessageSend] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/messages/conversations', requireAuth, async (req, res) => {
  try {
    const conversations = await db.getConversations(req.session.userId);
    res.json({ conversations });
  } catch (err) {
    console.error('[Conversations] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/messages/:friendId', requireAuth, async (req, res) => {
  try {
    const messages = await db.getMessages(req.session.userId, req.params.friendId);
    await db.markMessagesRead(req.session.userId, req.params.friendId);
    res.json({ messages });
  } catch (err) {
    console.error('[Messages] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Détails enrichis d'un jeu (Steam Store API) — sans clé API, gratuit
app.get('/api/game-details/:gameId', requireAuth, generalLimiter, async (req, res) => {
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

app.get('/api/game-prices/:gameId', generalLimiter, async (req, res) => {
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
    if (data.points === 0 && !data.claimed_first_login) {
      await db.claimFirstLoginPoints(req.session.userId);
      data.points = 1;
      data.claimed_first_login = true;
    }
    res.json({ points: data.points });
  } catch (err) {
    console.error('[BoosterPoints] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/booster/boost', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    const result = await db.boosterBoostGame(req.session.userId, gameId);
    console.log('[BoosterBoost] User', req.session.userId, 'used booster on', gameId, 'remaining:', result.remaining);
    res.json({ ok: true, remaining: result.remaining });
  } catch (err) {
    console.error('[BoosterBoost] Error:', err.message);
    res.status(400).json({ error: 'Action impossible' });
  }
});

app.get('/api/booster/top', async (req, res) => {
  try {
    const top = await db.getTopBoostedGames();
    res.json({ top });
  } catch (err) {
    console.error('[BoosterTop] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/booster/status/:gameId', requireAuth, async (req, res) => {
  try {
    const boosted = await db.getUserBoostStatus(req.session.userId, req.params.gameId);
    res.json({ boosted });
  } catch (err) {
    console.error('[BoosterStatus] Error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
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
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/boost', requireAuth, async (req, res) => {
  try {
    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'gameId requis' });
    const result = await db.communityBoostGame(req.session.userId, gameId);
    console.log('[Boost] User', req.session.userId, 'boosted', gameId, 'remaining:', result.remaining);
    res.json({ ok: true, remaining: result.remaining });
  } catch (err) {
    console.error('[Boost] Error:', err.message);
    res.status(400).json({ error: 'Action impossible' });
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
    res.status(500).json({ error: 'Erreur interne' });
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

// ─── NEWS : Actualités temps réel ──────────────────────────
// Sources : IGDB (releases), RSS feeds (drama/actu), Pandascore/Liquipedia (esport)
const NEWS_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6h
let newsRefreshTimer = null;

// Helper HTTP GET (texte)
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PlayPad/1.0' } }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── RSS Parser simple (sans dépendance) ──────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      let val = m ? m[1].trim() : '';
      val = val.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
      val = val.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return val;
    };
    const title = get('title');
    const desc = get('description').replace(/<[^>]*>/g, '').trim();
    const link = get('link');
    const pubDate = get('pubDate');
    if (title) items.push({ title, desc: desc.slice(0, 300), link, pubDate });
  }
  return items;
}

// ─── 1. FETCH : Sorties jeux via IGDB ─────────────────────
async function fetchIGDBReleases(clientId, clientSecret) {
  try {
    const token = await igdbGetToken(clientId, clientSecret);
    const now = Math.floor(Date.now() / 1000);
    const sixMonths = now + 180 * 24 * 3600;
    const body = `fields name,first_release_date,cover.url,genres.name,summary,platforms.name; where first_release_date >= ${now} & first_release_date <= ${sixMonths} & cover.url != null; sort first_release_date asc; limit 20;`;
    const data = await igdbApiGet('https://api.igdb.com/v4/games', clientId, token, body);
    if (!Array.isArray(data)) return [];
    return data.map(g => ({
      type: 'release',
      date: g.first_release_date ? new Date(g.first_release_date * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '2026',
      title: g.name || 'Titre inconnu',
      desc: (g.summary || '').slice(0, 120) || `Nouveau jeu ${g.platforms?.[0]?.name || ''}`.trim(),
      cover: g.cover?.url ? 'https:' + g.cover.url.replace('t_thumb', 't_cover_big') : '',
      officialUrl: '',
      sourceUrl: `https://www.igdb.com/games/${(g.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      sourceName: 'IGDB',
      details: g.summary || 'Aucune description disponible.',
      platforms: (g.platforms || []).map(p => p.name).join(', '),
    }));
  } catch (e) {
    console.error('[News] IGDB error:', e.message);
    return [];
  }
}

// ─── 2. FETCH : Drama/Actu via RSS ────────────────────────
const DRAMA_RSS_FEEDS = [
  { url: 'https://www.jeuxvideo.com/rss/rss.xml', name: 'JeuxVideo.com' },
  { url: 'https://www.gamekult.com/feed/actualites.xml', name: 'Gamekult' },
];

async function fetchDramaFromRSS() {
  const items = [];
  for (const feed of DRAMA_RSS_FEEDS) {
    try {
      const xml = await httpGet(feed.url);
      const parsed = parseRSS(xml);
      for (const p of parsed.slice(0, 5)) {
        const lower = (p.title + ' ' + p.desc).toLowerCase();
        const tag = lower.includes('licencie') || lower.includes('greve') || lower.includes('controvers') || lower.includes('polemique') || lower.includes('drama')
          ? 'Drama' : 'Actu';
        items.push({
          type: 'drama',
          title: p.title,
          desc: p.desc.slice(0, 150),
          tag,
          officialUrl: p.link,
          sourceUrl: p.link,
          sourceName: feed.name,
          details: p.desc.slice(0, 500),
          pubDate: p.pubDate,
        });
      }
    } catch (e) {
      console.error(`[News] RSS error ${feed.name}:`, e.message);
    }
  }
  items.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return items.slice(0, 15);
}

// ─── 3. FETCH : E-Sport via RSS ────────────────────────────
const ESPORT_RSS_FEEDS = [
  { url: 'https://www.hltv.org/rss/news', name: 'HLTV', game: 'Counter-Strike 2' },
];

async function fetchEsportFromRSS() {
  const items = [];
  for (const feed of ESPORT_RSS_FEEDS) {
    try {
      const xml = await httpGet(feed.url);
      const parsed = parseRSS(xml);
      for (const p of parsed.slice(0, 8)) {
        const lower = (p.title + ' ' + p.desc).toLowerCase();
        let event = p.title;
        let date = '';
        const dateMatch = p.title.match(/(\d{4})/);
        if (dateMatch) date = dateMatch[1];
        items.push({
          type: 'esport',
          event,
          game: feed.game,
          date,
          desc: p.desc.slice(0, 120) || `Actualité ${feed.game}`,
          officialUrl: p.link,
          sourceUrl: p.link,
          sourceName: feed.name,
          details: p.desc.slice(0, 500),
          pubDate: p.pubDate,
        });
      }
    } catch (e) {
      console.error(`[News] Esport RSS error ${feed.name}:`, e.message);
    }
  }
  items.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return items.slice(0, 12);
}

// ─── 3b. FETCH : E-Sport via PandaScore API ────────────────
const PANDASCORE_GAMES = [
  { slug: 'csgo', name: 'Counter-Strike 2' },
  { slug: 'lol', name: 'League of Legends' },
  { slug: 'dota2', name: 'Dota 2' },
  { slug: 'valorant', name: 'Valorant' },
  { slug: 'overwatch', name: 'Overwatch 2' },
  { slug: 'rocket-league', name: 'Rocket League' },
  { slug: 'call-of-duty', name: 'Call of Duty' },
  { slug: 'rainbow-six', name: 'Rainbow Six Siege' },
];

async function fetchEsportFromPandaScore() {
  const key = process.env.PANDASCORE_API_KEY;
  if (!key) return [];
  const items = [];
  const seen = new Set();
  for (const g of PANDASCORE_GAMES) {
    try {
      // Récupère matches running + upcoming pour plus de contenu
      const statuses = ['running', 'upcoming'];
      for (const status of statuses) {
        const url = `https://api.pandascore.co/${g.slug}/matches?filter[status]=${status}&sort=-begin_at&per_page=5&token=${key}`;
        const body = await httpGet(url);
        const matches = JSON.parse(body);
        for (const m of matches) {
          const title = (m.opponents || []).map(o => o.opponent.name).join(' vs ') || m.name || 'Match à venir';
          if (seen.has(title)) continue;
          seen.add(title);
          const teams = (m.opponents || []).map(o => ({
            id: o.opponent.id,
            name: o.opponent.name,
            logo: o.opponent.image_url || '',
            players: [],
          }));
          items.push({
            type: 'esport',
            event: title,
            game: g.name,
            gameSlug: g.slug,
            date: m.begin_at ? m.begin_at.split('T')[0] : '',
            desc: `${m.league?.name || ''} — ${m.serie?.name || ''} — ${m.tournament?.name || ''}`,
            officialUrl: `https://www.pandascore.co/${g.slug}/matches/${m.id}`,
            sourceUrl: '',
            sourceName: 'PandaScore',
            details: `${m.league?.name || ''} — ${m.serie?.name || ''}\n${m.tournament?.name || ''}\nStatut: ${m.status || 'unknown'}`,
            pubDate: m.begin_at || new Date().toISOString(),
            matchId: m.id,
            tournament: m.tournament?.name || '',
            league: m.league?.name || '',
            teams,
            teamIds: (m.opponents || []).map(o => o.opponent.id),
            status: m.status || 'upcoming',
            scores: (m.results || []).map(r => r.score),
            gameDescription: '',
          });
        }
      }
    } catch (e) {
      console.error(`[News] PandaScore error ${g.slug}:`, e.message);
    }
  }
  return items;
}

// Récupère les détails d'un match (équipes + joueurs via API séparée)
async function fetchEsportMatchRoster(matchId, game) {
  const key = process.env.PANDASCORE_API_KEY;
  if (!key) return null;
  try {
    const url = `https://api.pandascore.co/${game}/matches/${matchId}?token=${key}`;
    const body = await httpGet(url);
    const m = JSON.parse(body);
    if (!m) return null;
    const teams = await Promise.all((m.opponents || []).map(async (o) => {
      const players = await fetchTeamPlayers(game, o.opponent.id);
      return {
        id: o.opponent.id,
        name: o.opponent.name,
        logo: o.opponent.image_url || '',
        players: players || [],
      };
    }));
    return {
      teams,
      status: m.status,
      scores: (m.results || []).map(r => r.score),
      league: m.league?.name || '',
      tournament: m.tournament?.name || '',
    };
  } catch (e) {
    console.error('[News] PandaScore roster error:', e.message);
    return null;
  }
}

// Récupère les joueurs d'une équipe via PandaScore
async function fetchTeamPlayers(game, teamId) {
  const key = process.env.PANDASCORE_API_KEY;
  if (!key) return [];
  try {
    const url = `https://api.pandascore.co/${game}/players?filter[team_id]=${teamId}&per_page=10&token=${key}`;
    const body = await httpGet(url);
    const players = JSON.parse(body);
    if (!Array.isArray(players)) return [];
    return players.map(p => ({
      id: p.id,
      name: p.name,
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      imageUrl: p.image_url || '',
      role: p.role || '',
      nationality: p.nationality || '',
      slug: p.slug || '',
    }));
  } catch (e) {
    console.error(`[News] PandaScore players error team ${teamId}:`, e.message);
    return [];
  }
}

// ─── 4. REFRESH complet ────────────────────────────────────
async function refreshAllNews(force) {
  console.log('[News] Rafraîchissement des actualités...');
  const results = { releases: 0, esport: 0, drama: 0 };

  // Vérifie l'âge du cache — si < 6h, on skip sauf force=true
  if (!force) {
    const cacheAge = await db.getNewsCacheAge().catch(() => null);
    if (cacheAge) {
      const hoursOld = (Date.now() - cacheAge.getTime()) / 3600000;
      if (hoursOld < 6) {
        console.log(`[News] Cache encore frais (${hoursOld.toFixed(1)}h), skip refresh`);
        return results;
      }
    }
  }

  const igdbId = process.env.TWITCH_CLIENT_ID;
  const igdbSecret = process.env.TWITCH_CLIENT_SECRET;

  if (igdbId && igdbSecret) {
    const releases = await fetchIGDBReleases(igdbId, igdbSecret);
    if (releases.length > 0) {
      await db.addNewsItems('releases', releases);
      results.releases = releases.length;
    }
  }

  const drama = await fetchDramaFromRSS();
  if (drama.length > 0) {
    await db.addNewsItems('drama', drama);
    results.drama = drama.length;
  }

  // Esport via PandaScore (matches en direct/à venir)
  const esportPs = await fetchEsportFromPandaScore();
  let esport = [...esportPs];
  // Si PandaScore n'a rien renvoyé, on utilise les données statiques (avec logos et équipes)
  if (esport.length === 0) {
    try {
      const fallback = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'data', 'news.json'), 'utf-8'));
      if (fallback.esport && fallback.esport.length > 0) {
        esport = fallback.esport;
        console.log('[News] Fallback e-sport statique utilisé (' + esport.length + ' événements)');
      }
    } catch (e) {
      console.error('[News] Fallback e-sport error:', e.message);
    }
  }
  // On complète avec les articles RSS HLTV (sans remplacer les données structurées)
  const esportRss = await fetchEsportFromRSS();
  if (esportRss.length > 0) {
    const rssTitles = new Set(esport.map(e => e.event || e.title));
    for (const rss of esportRss) {
      if (!rssTitles.has(rss.event || rss.title)) {
        esport.push(rss);
      }
    }
  }
  if (esport.length > 0) {
    await db.addNewsItems('esport', esport);
    results.esport = esport.length;
    notifyFavoriteUsers('esport', esport).catch(e => console.error('[Notify] Error:', e.message));
  }

  await db.pruneNewsCache(50).catch(e => console.error('[News] Prune error:', e.message));
  console.log(`[News] ✅ Rafraîchi : ${results.releases} releases, ${results.drama} drama, ${results.esport} esport`);
  return results;
}

function startNewsRefresh() {
  if (newsRefreshTimer) clearInterval(newsRefreshTimer);
  // Premier refresh immédiat (force=true pour ignorer le cache et récupérer les données PandaScore)
  refreshAllNews(true).catch(e => console.error('[News] Erreur premier refresh:', e.message));
  // Puis toutes les 30 min
  newsRefreshTimer = setInterval(() => {
    refreshAllNews().catch(e => console.error('[News] Erreur refresh périodique:', e.message));
  }, NEWS_REFRESH_INTERVAL);
}

// ─── Routes News ───────────────────────────────────────────
const newsLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: 'Trop de requêtes actualités' } });

function loadNewsFallback() {
  try {
    const raw = require('fs').readFileSync(path.join(__dirname, 'data', 'news.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { releases: [], esport: [], drama: [] };
  }
}

// Récupère les détails d'un match e-sport (roster, scores)
app.get('/api/esport/match/:game/:matchId', async (req, res) => {
  try {
    const roster = await fetchEsportMatchRoster(req.params.matchId, req.params.game);
    res.json({ match: roster });
  } catch (err) {
    res.json({ match: null });
  }
});

app.get('/api/esport/team/:game/:teamId', async (req, res) => {
  try {
    const players = await fetchTeamPlayers(req.params.game, parseInt(req.params.teamId));
    res.json({ players: players || [] });
  } catch (err) {
    res.json({ players: [] });
  }
});

app.get('/api/news', newsLimiter, async (req, res) => {
  try {
    const data = await db.getNewsFromCache();
    const hasData = (data.releases?.length || 0) + (data.esport?.length || 0) + (data.drama?.length || 0) > 0;
    if (hasData) {
      // Si l'e-sport est vide ou ne contient que des articles RSS (pas de vraies équipes), on utilise le fallback
      if (!data.esport || data.esport.length === 0 || !data.esport.some(e => e.teams || e.gameSlug)) {
        const fallback = loadNewsFallback();
        if (fallback.esport && fallback.esport.length > 0) {
          data.esport = fallback.esport;
        }
      }
      res.json(data);
    } else {
      // Fallback vers le fichier JSON si le cache DB est vide
      res.json(loadNewsFallback());
    }
  } catch (err) {
    console.error('[News] DB error, fallback JSON:', err.message);
    res.json(loadNewsFallback());
  }
});

app.post('/api/admin/refresh-news', requireAuth, async (req, res) => {
  try {
    const results = await refreshAllNews();
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('[Admin] Refresh news error:', err.message);
    res.status(500).json({ error: 'Erreur lors du rafraîchissement' });
  }
});

// ─── E-SPORT FAVORITES ──────────────────────────────────────
app.post('/api/esport/favorite/toggle', requireAuth, async (req, res) => {
  try {
    const { event } = req.body;
    if (!event) return res.status(400).json({ error: 'Event data required' });
    const result = await db.toggleEsportFavorite(req.session.userId, event);
    res.json(result);
  } catch (err) {
    console.error('[EsportFavorite]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/esport/favorites', requireAuth, async (req, res) => {
  try {
    const favorites = await db.getEsportFavorites(req.session.userId);
    res.json({ favorites });
  } catch (err) {
    console.error('[EsportFavorites]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.get('/api/esport/favorites/check', requireAuth, async (req, res) => {
  try {
    const { title, game } = req.query;
    const favorited = await db.isEsportFavorite(req.session.userId, title, game);
    res.json({ favorited });
  } catch (err) {
    console.error('[EsportCheck]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── NOTIFICATION PREFERENCES ───────────────────────────────
app.get('/api/account/notifications', requireAuth, async (req, res) => {
  try {
    const prefs = await db.getNotificationPrefs(req.session.userId);
    res.json(prefs);
  } catch (err) {
    console.error('[NotifPrefs]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

app.post('/api/account/notifications', requireAuth, async (req, res) => {
  try {
    const { emailNotifications } = req.body;
    await db.setNotificationPrefs(req.session.userId, { emailNotifications });
    res.json({ ok: true });
  } catch (err) {
    console.error('[NotifPrefs]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── PLAYER SEARCH ──────────────────────────────────────────
app.get('/api/players/search', requireAuth, async (req, res) => {
  try {
    const { game } = req.query;
    if (!game) return res.json({ players: [] });
    const players = await db.searchPlayersByGame(game, req.session.userId);
    res.json({ players });
  } catch (err) {
    console.error('[PlayerSearch]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── STREAMER SEARCH (Twitch) ───────────────────────────────
app.get('/api/streamers/search', requireAuth, async (req, res) => {
  try {
    const { game } = req.query;
    if (!game) return res.json({ streamers: [] });
    const twitchId = process.env.TWITCH_CLIENT_ID;
    const twitchSecret = process.env.TWITCH_CLIENT_SECRET;
    const streamers = await db.searchStreamers(game, twitchId, twitchSecret);
    res.json({ streamers });
  } catch (err) {
    console.error('[StreamerSearch]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── CONTACT FORM ───────────────────────────────────────────
app.post('/api/contact', requireAuth, contactLimiter, async (req, res) => {
  try {
    const { message, email } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });
    const sanitizedMsg = stripHtml(message);
    const sanitizedEmail = email ? stripHtml(email) : '';
    const transporter = createMailTransporter();
    if (transporter) {
      await transporter.sendMail({
        from: `"PlayPad Contact" <${process.env.SMTP_USER}>`,
        to: process.env.SMTP_USER,
        subject: `[PlayPad] Message de ${sanitizedEmail || 'utilisateur #' + req.session.userId}`,
        html: `<p><b>De :</b> ${sanitizedEmail || 'inconnu'}</p><p><b>Message :</b></p><p>${sanitizedMsg}</p>`,
      });
    }
    // Stocker en DB même si l'email échoue
    const { error } = await db.supabaseAdmin
      .from('contact_messages')
      .insert({ user_id: req.session.userId, email: email || '', message });
    if (error) console.error('[Contact] DB error:', error.message);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Contact]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── DISCOVERY NOTIFICATIONS ────────────────────────────────
app.get('/api/discoveries', requireAuth, async (req, res) => {
  try {
    const discoveries = await db.getUserDiscoveries(req.session.userId);
    res.json({ discoveries });
  } catch (err) {
    console.error('[Discoveries] Error:', err.message);
    res.json({ discoveries: [] });
  }
});

app.post('/api/discoveries/dismiss', requireAuth, async (req, res) => {
  try {
    const { section } = req.body;
    if (!section) return res.status(400).json({ error: 'Section requise' });
    await db.acknowledgeDiscovery(req.session.userId, section);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Discoveries] Dismiss error:', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── NOTIFICATIONS ────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const notifications = await db.getNotifications(req.session.userId);
    res.json({ notifications });
  } catch (err) {
    console.error('[Notifications] Get error:', err.message);
    res.json({ notifications: [] });
  }
});

app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await db.getUnreadNotificationCount(req.session.userId);
    res.json({ count });
  } catch (err) {
    console.error('[Notifications] Count error:', err.message);
    res.json({ count: 0 });
  }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await db.markNotificationRead(req.session.userId, parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[Notifications] Read error:', err.message);
    res.json({ ok: true });
  }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await db.markAllNotificationsRead(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Notifications] ReadAll error:', err.message);
    res.json({ ok: true });
  }
});

// ─── AI CHATBOT (Ollama) ─────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Message requis' });

    const systemPrompt = `Tu es l'assistant de PlayPad, une application de gestion de bibliothèque de jeux vidéo.

Voici les onglets disponibles dans l'application :
- library : Bibliothèque personnelle de jeux (statut, recherche, filtre par plateforme)
- community : Communauté (feed d'activité des amis, suggestions)
- reviews : Critiques (feed des reviews publiques avec vote)
- catalogue : Catalogue partagé de tous les jeux (recherche, pagination, boost)
- profile : Profil utilisateur (stats, top 3, paramètres, logout)

Fonctionnalités :
- Ajouter/supprimer des jeux, changer statut (playing, completed, backlog, dropped)
- Noter (1-5) et écrire des reviews (publiques/privées)
- Wishlist (liste de souhaits)
- Top 3 (3 jeux favoris épinglés)
- Boost (3 points/semaine pour mettre un jeu en avant)
- Amis (demandes, acceptation, bibliothèque partagée)
- Messagerie privée
- Import Steam, Xbox, Epic, Playnite
- eSport (favoris, notifications email)
- News (actualités jeu vidéo)

Sites externes : Steam Store (https://store.steampowered.com), RAWG (https://rawg.io), IGDB (https://www.igdb.com), IsThereAnyDeal (https://isthereanydeal.com), Humble Bundle (https://www.humblebundle.com)

Réponds de façon concise et utile en français. Quand c'est pertinent, termine ta réponse par un tableau JSON d'actions suggérées au format : [{"label":"Texte du bouton","type":"view","value":"library"},{"label":"Ouvrir Steam","type":"url","value":"https://..."}]`;

    const msgs = [{ role: "system", content: systemPrompt }];
    if (Array.isArray(history)) msgs.push(...history.slice(-20));
    msgs.push({ role: "user", content: message });

    const body = JSON.stringify({ model: 'llama3.1:8b', messages: msgs, stream: false });
    const http = require('http');
    const opts = {
      hostname: 'localhost', port: 11434, path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const ollamaReq = http.request(opts, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.message?.content || '';
          const actionsMatch = text.match(/\[[\s\S]*?\]\s*$/);
          let actions = [];
          let cleanText = text;
          if (actionsMatch) {
            try { actions = JSON.parse(actionsMatch[0]); } catch (e) {}
            cleanText = text.slice(0, actionsMatch.index).trim();
          }
          res.json({ text: cleanText, actions });
        } catch (e) {
          res.json({ text: data.slice(0, 500), actions: [] });
        }
      });
    });
    ollamaReq.on('error', () => {
      res.status(503).json({ error: 'Ollama indisponible', text: "L'assistant est hors ligne. Vérifie qu'Ollama est lancé." });
    });
    ollamaReq.write(body);
    ollamaReq.end();
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ─── EMAIL NOTIFICATION SYSTEM ──────────────────────────────
const nodemailer = require('nodemailer');

function createMailTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) return null;
  return nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(smtpPort || '587'),
    secure: smtpPort === '465',
    auth: { user: smtpUser, pass: smtpPass },
  });
}

async function sendEsportNotificationEmail(user, event, action) {
  const transporter = createMailTransporter();
  if (!transporter || !user.email) return;
  try {
    const subject = action === 'favorite'
      ? `Nouvel événement e-sport : ${event.event || event.title}`
      : `Rappel : ${event.event || event.title}`;
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#1a1a2e;color:#e0e0f0;border-radius:16px;">
        <h2 style="color:#fbbf24;">🏆 PlayPad - E-Sport</h2>
        <h3>${subject}</h3>
        <p>${event.desc || ''}</p>
        <p style="color:#8888aa;">${event.date || ''} — ${event.game || ''}</p>
        <hr style="border-color:#333;" />
        <p style="font-size:12px;color:#666;">Tu reçois cet email car tu as activé les notifications e-sport dans ton profil PlayPad.</p>
      </div>`;
    await transporter.sendMail({
      from: `"PlayPad" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject,
      html,
    });
    console.log(`[Email] Notification e-sport envoyée à ${user.email}`);
  } catch (e) {
    console.error('[Email] Send error:', e.message);
  }
}

// On refresh, notifier les utilisateurs qui ont des favoris correspondant au jeu
async function notifyFavoriteUsers(newsCategory, items) {
  if (newsCategory !== 'esport' || !items || items.length === 0) return;
  // Récupère tous les utilisateurs qui ont des favoris e-sport
  const { data: allFavs } = await db.supabaseAdmin
    .from('esport_favorites')
    .select('user_id, event_game, event_title');
  if (!allFavs || allFavs.length === 0) return;
  // Build a map: userId -> Set of game names they follow
  const favMap = {};
  const favUserIds = new Set();
  for (const f of allFavs) {
    if (!favMap[f.user_id]) favMap[f.user_id] = new Set();
    if (f.event_game) favMap[f.user_id].add(f.event_game.toLowerCase());
    if (f.event_title) favMap[f.user_id].add(f.event_title.toLowerCase());
    favUserIds.add(f.user_id);
  }
  // Récupère les infos des utilisateurs concernés (email + préférences)
  const { data: users } = await db.supabaseAdmin
    .from('users')
    .select('id, email, email_notifications')
    .in('id', [...favUserIds]);
  const userMap = {};
  for (const u of users || []) userMap[u.id] = u;
  // Pour chaque nouvel événement e-sport
  for (const item of items) {
    const game = (item.game || '').toLowerCase();
    const title = (item.event || item.title || '').toLowerCase();
    if (!game && !title) continue;
    for (const userId of Object.keys(favMap)) {
      const terms = favMap[userId];
      if (terms.has(game) || terms.has(title)) {
        const notifyTitle = item.event || item.title || item.game || 'Nouvel événement e-sport';
        const notifyBody = item.desc || '';
        // Notification in-app (toujours)
        db.createNotification(parseInt(userId), 'esport', notifyTitle, notifyBody,
          { game: item.game, event: item.event, sourceUrl: item.officialUrl });
        // Email si l'utilisateur a activé les notifications email
        const u = userMap[userId];
        if (u && u.email && u.email_notifications) {
          sendEsportNotificationEmail({ id: userId, email: u.email }, item, 'favorite').catch(() => {});
        }
      }
    }
  }
}

// Notifie les autres utilisateurs qui ont reviewé le même jeu
async function notifyOtherReviewers(currentUserId, gameId, currentUserName, gameTitle) {
  const { data: reviewers } = await db.supabaseAdmin
    .from('community_reviews')
    .select('user_id')
    .eq('game_id', gameId)
    .neq('user_id', currentUserId);
  if (!reviewers || reviewers.length === 0) return;
  const uniqueIds = [...new Set(reviewers.map(r => r.user_id))];
  for (const uid of uniqueIds) {
    db.createNotification(uid, 'review', 'Nouvelle critique',
      `${currentUserName} a ajouté une critique sur "${gameTitle}"`,
      { fromUserId: currentUserId, fromName: currentUserName, gameId, gameTitle });
  }
}

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
  console.log('[Server] SUPABASE_URL:', process.env.SUPABASE_URL ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'defined' : 'MISSING');
  console.log('[Server] PUBLIC_URL:', process.env.PUBLIC_URL || '⚠️ NON DÉFINI — Steam OpenID va échouer ! Définir PUBLIC_URL dans les env vars Render');
  console.log('[Server] STEAM_API_KEY:', process.env.STEAM_API_KEY ? 'defined' : 'NON DÉFINI — Steam import ne marchera pas');
  console.log('[Server] XBL_API_KEY:', process.env.XBL_API_KEY ? 'defined' : 'NON DÉFINI — Xbox import ne marchera pas');
  console.log('[Server] RAWG_API_KEY:', process.env.RAWG_API_KEY ? 'defined' : 'NON DÉFINI — catalogue RAWG indisponible');
  console.log('[Server] TWITCH_CLIENT_ID:', process.env.TWITCH_CLIENT_ID ? 'defined' : 'NON DÉFINI — catalogue IGDB indisponible');
  console.log('[Server] PANDASCORE_API_KEY:', process.env.PANDASCORE_API_KEY ? 'defined' : 'NON DÉFINI — données e-sport limitées au RSS HLTV');
  console.log('[Server] GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'defined' : 'NON DÉFINI — connexion Google indisponible');
  console.log('[Server] Epic Games : connexion par nom d\'utilisateur (sans API)');
  console.log('[Server] PlayStation : connexion par NPSSO (pas de clé API requise)');
  if (!process.env.PUBLIC_URL) {
    console.warn('⚠️  PUBLIC_URL manquant. Steam OpenID redirigera vers localhost au lieu de l\'URL publique.');
    console.warn('    Ajoute PUBLIC_URL=https://ton-app.render.com dans les env vars Render.');
  }
});
