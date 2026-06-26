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
