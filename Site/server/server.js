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

app.use(session({
  secret: 'playpad-secret-key-change-in-production',
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
    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
    }
    const existing = db.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Cet identifiant est déjà pris' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const userId = db.createUser(username, displayName, hashed);
    const user = db.getUserById(userId);
    req.session.userId = userId;
    res.json({ user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    req.session.userId = user.id;
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, created_at: user.created_at } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ user });
});

app.get('/api/games', requireAuth, (req, res) => {
  const games = db.getGames(req.session.userId);
  res.json({ games });
});

app.post('/api/games/sync', requireAuth, (req, res) => {
  const { games } = req.body;
  if (!Array.isArray(games)) {
    return res.status(400).json({ error: 'Format invalide' });
  }
  const tx = db.getDb().transaction(() => {
    for (const game of games) {
      db.upsertGame(req.session.userId, game);
    }
  });
  tx();
  res.json({ ok: true });
});

app.post('/api/games/status', requireAuth, (req, res) => {
  const { gameId, status } = req.body;
  db.updateGameStatus(req.session.userId, gameId, status);
  res.json({ ok: true });
});

app.post('/api/games/review', requireAuth, (req, res) => {
  const { gameId, rating, reviewText, reviewPublic } = req.body;
  db.updateGameRating(req.session.userId, gameId, rating || 0, reviewText || '', reviewPublic !== false);
  res.json({ ok: true });
});

app.get('/api/wishlist', requireAuth, (req, res) => {
  const ids = db.getWishlist(req.session.userId);
  res.json({ wishlist: ids });
});

app.post('/api/wishlist/toggle', requireAuth, (req, res) => {
  const { gameId } = req.body;
  const added = db.toggleWishlist(req.session.userId, gameId);
  res.json({ added });
});

app.get('/api/topthree', requireAuth, (req, res) => {
  const top = db.getTopThree(req.session.userId);
  res.json({ topThree: top });
});

app.post('/api/topthree', requireAuth, (req, res) => {
  const { gameId, position } = req.body;
  db.setTopThree(req.session.userId, gameId, position);
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, (req, res) => {
  db.deleteUserAccount(req.session.userId);
  req.session.destroy();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`PlayPad server running on http://localhost:${PORT}`);
});
