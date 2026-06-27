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
