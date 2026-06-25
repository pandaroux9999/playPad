const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'playpad-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
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
  const user = await db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ user });
});

app.get('/api/games', requireAuth, async (req, res) => {
  const games = await db.getGames(req.session.userId);
  res.json({ games });
});

app.post('/api/games/sync', requireAuth, async (req, res) => {
  const { games } = req.body;
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: 'Format invalide' });
  }
  for (const game of games) {
    await db.upsertGame(req.session.userId, game);
  }
  res.json({ ok: true });
});

app.post('/api/games/status', requireAuth, async (req, res) => {
  const { gameId, status } = req.body;
  await db.updateGameStatus(req.session.userId, gameId, status);
  res.json({ ok: true });
});

app.post('/api/games/review', requireAuth, async (req, res) => {
  const { gameId, rating, reviewText, reviewPublic } = req.body;
  await db.updateGameRating(req.session.userId, gameId, rating || 0, reviewText || '', reviewPublic !== false);
  res.json({ ok: true });
});

app.get('/api/wishlist', requireAuth, async (req, res) => {
  const ids = await db.getWishlist(req.session.userId);
  res.json({ wishlist: ids });
});

app.post('/api/wishlist/toggle', requireAuth, async (req, res) => {
  const { gameId } = req.body;
  const added = await db.toggleWishlist(req.session.userId, gameId);
  res.json({ added });
});

app.get('/api/topthree', requireAuth, async (req, res) => {
  const top = await db.getTopThree(req.session.userId);
  res.json({ topThree: top });
});

app.post('/api/topthree', requireAuth, async (req, res) => {
  const { gameId, position } = req.body;
  await db.setTopThree(req.session.userId, gameId, position);
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, async (req, res) => {
  await db.deleteUserAccount(req.session.userId);
  req.session.destroy();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
  console.log('[Server] SUPABASE_URL:', process.env.SUPABASE_URL ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'defined' : 'MISSING');
  console.log('[Server] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'defined' : 'MISSING');
});
