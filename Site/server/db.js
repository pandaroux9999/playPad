const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  console.error('Missing Supabase environment variables. Required: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (!supabaseUrl.startsWith('https://') || !supabaseUrl.endsWith('.supabase.co')) {
  console.error('SUPABASE_URL must start with https:// and end with .supabase.co');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

function checkResult({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

async function createUser(username, displayName, hashedPassword) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ username, display_name: displayName, password: hashedPassword })
    .select('id')
    .single();
  checkResult({ data, error });
  return data.id;
}

async function getUserByUsername(username) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, display_name, created_at')
    .eq('id', id)
    .single();
  checkResult({ data, error });
  return data;
}

async function getGames(userId) {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('user_id', userId);
  checkResult({ data, error });
  return data;
}

async function upsertGame(userId, game) {
  const { error } = await supabaseAdmin
    .from('games')
    .upsert({
      user_id: userId,
      game_id: game.game_id,
      title: game.title,
      platform: game.platform || '',
      genre: game.genre || '',
      cover: game.cover || '',
      status: game.status || 'not_started',
      playtime: game.playtime || 0,
      year: game.year || 0,
      user_rating: game.user_rating || 0,
      review_text: game.review_text || '',
      review_public: game.review_public !== false,
      has_review: game.has_review ? true : false,
    }, { onConflict: 'user_id, game_id' });
  if (error) throw new Error(error.message);
}

async function updateGameStatus(userId, gameId, status) {
  const { error } = await supabaseAdmin
    .from('games')
    .update({ status })
    .eq('user_id', userId)
    .eq('game_id', gameId);
  if (error) throw new Error(error.message);
}

async function updateGameRating(userId, gameId, rating, reviewText, reviewPublic) {
  const hasReview = reviewText && reviewText.trim().length > 0;
  const { error } = await supabaseAdmin
    .from('games')
    .update({
      user_rating: rating,
      review_text: reviewText,
      review_public: reviewPublic,
      has_review: hasReview,
    })
    .eq('user_id', userId)
    .eq('game_id', gameId);
  if (error) throw new Error(error.message);
}

async function getWishlist(userId) {
  const { data, error } = await supabaseAdmin
    .from('wishlist')
    .select('game_id')
    .eq('user_id', userId);
  checkResult({ data, error });
  return data.map(r => r.game_id);
}

async function toggleWishlist(userId, gameId) {
  const { data: existing } = await supabaseAdmin
    .from('wishlist')
    .select('id')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from('wishlist')
      .delete()
      .eq('id', existing.id);
    if (error) throw new Error(error.message);
    return false;
  } else {
    const { error } = await supabaseAdmin
      .from('wishlist')
      .insert({ user_id: userId, game_id: gameId });
    if (error) throw new Error(error.message);
    return true;
  }
}

async function getTopThree(userId) {
  const { data: positions, error } = await supabaseAdmin
    .from('top_three')
    .select('game_id, position')
    .eq('user_id', userId)
    .order('position');
  if (error) throw new Error(error.message);
  if (!positions || positions.length === 0) return [];
  const gameIds = positions.map(p => p.game_id);
  const { data: games, error: gameError } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('user_id', userId)
    .in('game_id', gameIds);
  checkResult({ data: games, error: gameError });
  return positions.map(p => ({ ...games.find(g => g.game_id === p.game_id), position: p.position }));
}

async function setTopThree(userId, gameId, position) {
  const { data: existing } = await supabaseAdmin
    .from('top_three')
    .select('id')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin.from('top_three').delete().eq('id', existing.id);
  }

  if (position !== null) {
    await supabaseAdmin.from('top_three').delete().eq('user_id', userId).eq('position', position);
    const { error } = await supabaseAdmin
      .from('top_three')
      .insert({ user_id: userId, game_id: gameId, position });
    if (error) throw new Error(error.message);
  }
}

async function deleteUserAccount(userId) {
  await supabaseAdmin.from('community_reviews').delete().eq('user_id', userId);
  await supabaseAdmin.from('top_three').delete().eq('user_id', userId);
  await supabaseAdmin.from('wishlist').delete().eq('user_id', userId);
  await supabaseAdmin.from('games').delete().eq('user_id', userId);
  await supabaseAdmin.from('users').delete().eq('id', userId);
}

async function savePublicReview(userId, gameId, rating, reviewText) {
  const { error } = await supabaseAdmin
    .from('community_reviews')
    .upsert({
      user_id: userId,
      game_id: gameId,
      rating,
      review_text: reviewText,
    }, { onConflict: 'user_id, game_id' });
  if (error) throw new Error(error.message);
}

async function getGameReviews(gameId) {
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*, users(display_name, username)`)
    .eq('game_id', gameId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getGameAvgRatings() {
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select('game_id, rating')
    .not('rating', 'is', null);
  if (error) throw new Error(error.message);
  const map = {};
  const counts = {};
  for (const r of data || []) {
    map[r.game_id] = (map[r.game_id] || 0) + r.rating;
    counts[r.game_id] = (counts[r.game_id] || 0) + 1;
  }
  const result = {};
  for (const id of Object.keys(map)) {
    result[id] = Math.round(map[id] / counts[id]);
  }
  return result;
}

module.exports = {
  createUser,
  getUserByUsername,
  getUserById,
  getGames,
  upsertGame,
  updateGameStatus,
  updateGameRating,
  savePublicReview,
  getGameReviews,
  getGameAvgRatings,
  getWishlist,
  toggleWishlist,
  getTopThree,
  setTopThree,
  deleteUserAccount,
};
