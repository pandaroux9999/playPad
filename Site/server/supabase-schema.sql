-- Exécute ce script dans l'éditeur SQL de Supabase (Dashboard > SQL Editor)
-- pour créer les tables nécessaires à PlayPad.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  title TEXT NOT NULL,
  platform TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  status TEXT DEFAULT 'not_started',
  playtime INTEGER DEFAULT 0,
  year INTEGER DEFAULT 0,
  user_rating INTEGER DEFAULT 0,
  review_text TEXT DEFAULT '',
  review_public BOOLEAN DEFAULT TRUE,
  has_review BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS wishlist (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS top_three (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  position INTEGER CHECK(position IN (1,2,3)),
  UNIQUE(user_id, position)
);

CREATE TABLE IF NOT EXISTS community_reviews (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  game_title TEXT DEFAULT '',
  game_cover TEXT DEFAULT '',
  rating INTEGER DEFAULT 0,
  review_text TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS friends (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS game_suggestions (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  game_title TEXT DEFAULT '',
  game_cover TEXT DEFAULT '',
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS xbox_gamertag TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS epic_username TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS boost_points INTEGER DEFAULT 3;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_boost_week INTEGER DEFAULT 0;

ALTER TABLE games ADD COLUMN IF NOT EXISTS developer TEXT DEFAULT '';
ALTER TABLE games ADD COLUMN IF NOT EXISTS publisher TEXT DEFAULT '';
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS developer TEXT DEFAULT '';
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS publisher TEXT DEFAULT '';
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS age_rating INTEGER DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS age_rating INTEGER DEFAULT 0;

-- Table des boosts communautaires
CREATE TABLE IF NOT EXISTS boosts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('password', 'username')),
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table catalogue partagé (tous les jeux connus, dédupliqués par game_id)
CREATE TABLE IF NOT EXISTS catalog (
  id SERIAL PRIMARY KEY,
  game_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  platform TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  year INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table sessions persistantes (survit aux redémarrages Render)
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  session_data JSONB NOT NULL,
  expires TIMESTAMPTZ
);

-- Points boosters pour les utilisateurs (1 point offert à la première connexion)
CREATE TABLE IF NOT EXISTS booster_points (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INTEGER DEFAULT 0,
  claimed_first_login BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id)
);

-- Boost de jeux par les utilisateurs (un boost = 1 point par jeu par semaine)
CREATE TABLE IF NOT EXISTS game_boosts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, game_id, week_start)
);

-- Cache des actualités (jeux, esport, drama) — rafraîchi automatiquement
CREATE TABLE IF NOT EXISTS news_cache (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('releases', 'esport', 'drama')),
  item_data JSONB NOT NULL,
  archived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sort_key INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_news_cache_category ON news_cache(category);

-- Réponses aux critiques communautaires
CREATE TABLE IF NOT EXISTS review_replies (
  id SERIAL PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES community_reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Favoris e-sport (pour notifications)
CREATE TABLE IF NOT EXISTS esport_favorites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL,
  event_game TEXT DEFAULT '',
  event_desc TEXT DEFAULT '',
  event_date TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, event_title, event_game)
);

-- Préférences de notification des utilisateurs
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN DEFAULT FALSE;

-- Messages de contact (formulaire "Nous contacter")
CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT DEFAULT '',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Votes sur les critiques communautaires (pouce bleu/rouge)
CREATE TABLE IF NOT EXISTS review_votes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id INTEGER NOT NULL REFERENCES community_reviews(id) ON DELETE CASCADE,
  vote INTEGER NOT NULL CHECK(vote IN (1, -1)),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, review_id)
);
