const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'playpad.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
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
      review_public INTEGER DEFAULT 1,
      has_review INTEGER DEFAULT 0,
      UNIQUE(user_id, game_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wishlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS top_three (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position IN (1,2,3)),
      UNIQUE(user_id, position),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function createUser(username, displayName, hashedPassword) {
  const stmt = getDb().prepare(
    'INSERT INTO users (username, display_name, password) VALUES (?, ?, ?)'
  );
  const result = stmt.run(username, displayName, hashedPassword);
  return result.lastInsertRowid;
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return getDb().prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(id);
}

function getGames(userId) {
  return getDb().prepare('SELECT * FROM games WHERE user_id = ?').all(userId);
}

function upsertGame(userId, game) {
  const stmt = getDb().prepare(`
    INSERT INTO games (user_id, game_id, title, platform, genre, cover, status, playtime, year, user_rating, review_text, review_public, has_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET
      title = excluded.title,
      platform = excluded.platform,
      genre = excluded.genre,
      cover = excluded.cover,
      status = excluded.status,
      playtime = excluded.playtime,
      year = excluded.year,
      user_rating = excluded.user_rating,
      review_text = excluded.review_text,
      review_public = excluded.review_public,
      has_review = excluded.has_review
  `);
  stmt.run(
    userId, game.game_id, game.title, game.platform, game.genre, game.cover,
    game.status, game.playtime, game.year, game.user_rating || 0,
    game.review_text || '', game.review_public ? 1 : 0,
    game.has_review ? 1 : 0
  );
}

function updateGameStatus(userId, gameId, status) {
  getDb().prepare('UPDATE games SET status = ? WHERE user_id = ? AND game_id = ?').run(status, userId, gameId);
}

function updateGameRating(userId, gameId, rating, reviewText, reviewPublic) {
  const hasReview = reviewText && reviewText.trim().length > 0 ? 1 : 0;
  getDb().prepare(
    'UPDATE games SET user_rating = ?, review_text = ?, review_public = ?, has_review = ? WHERE user_id = ? AND game_id = ?'
  ).run(rating, reviewText, reviewPublic ? 1 : 0, hasReview, userId, gameId);
}

function getWishlist(userId) {
  return getDb().prepare('SELECT game_id FROM wishlist WHERE user_id = ?').all(userId).map(r => r.game_id);
}

function toggleWishlist(userId, gameId) {
  const existing = getDb().prepare('SELECT id FROM wishlist WHERE user_id = ? AND game_id = ?').get(userId, gameId);
  if (existing) {
    getDb().prepare('DELETE FROM wishlist WHERE id = ?').run(existing.id);
    return false;
  } else {
    getDb().prepare('INSERT INTO wishlist (user_id, game_id) VALUES (?, ?)').run(userId, gameId);
    return true;
  }
}

function getTopThree(userId) {
  return getDb().prepare(
    'SELECT g.*, t.position FROM top_three t JOIN games g ON g.game_id = t.game_id AND g.user_id = t.user_id WHERE t.user_id = ? ORDER BY t.position'
  ).all(userId);
}

function setTopThree(userId, gameId, position) {
  const existing = getDb().prepare('SELECT id FROM top_three WHERE user_id = ? AND game_id = ?').get(userId, gameId);
  if (existing) {
    getDb().prepare('DELETE FROM top_three WHERE id = ?').run(existing.id);
  }
  if (position !== null) {
    getDb().prepare('DELETE FROM top_three WHERE user_id = ? AND position = ?').run(userId, position);
    getDb().prepare('INSERT OR REPLACE INTO top_three (user_id, game_id, position) VALUES (?, ?, ?)').run(userId, gameId, position);
  }
}

function deleteUserAccount(userId) {
  getDb().prepare('DELETE FROM top_three WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM wishlist WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM games WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

module.exports = {
  getDb,
  createUser,
  getUserByUsername,
  getUserById,
  getGames,
  upsertGame,
  updateGameStatus,
  updateGameRating,
  getWishlist,
  toggleWishlist,
  getTopThree,
  setTopThree,
  deleteUserAccount,
};
