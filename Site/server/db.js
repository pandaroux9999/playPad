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
    .select('id, username, display_name, avatar_url, created_at')
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
  await supabaseAdmin.from('game_suggestions').delete().or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
  await supabaseAdmin.from('community_reviews').delete().eq('user_id', userId);
  await supabaseAdmin.from('top_three').delete().eq('user_id', userId);
  await supabaseAdmin.from('wishlist').delete().eq('user_id', userId);
  await supabaseAdmin.from('games').delete().eq('user_id', userId);
  await supabaseAdmin.from('friends').delete().or(`user_id.eq.${userId},friend_id.eq.${userId}`);
  await supabaseAdmin.from('users').delete().eq('id', userId);
}

async function savePublicReview(userId, gameId, rating, reviewText, gameTitle, gameCover) {
  const { error } = await supabaseAdmin
    .from('community_reviews')
    .upsert({
      user_id: userId,
      game_id: gameId,
      game_title: gameTitle || '',
      game_cover: gameCover || '',
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

async function getAllPublicReviews() {
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*, users(display_name, username)`)
    .order('created_at', { ascending: false })
    .limit(50);
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

async function searchUsers(query, currentUserId) {
  let builder = supabaseAdmin
    .from('users')
    .select('id, username, display_name, avatar_url, last_seen')
    .neq('id', currentUserId)
    .limit(50);
  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    builder = builder.or(`username.ilike.${q},display_name.ilike.${q}`);
  }
  const { data, error } = await builder;
  if (error) throw new Error(error.message);
  return data || [];
}

async function sendFriendRequest(userId, friendId) {
  const { error } = await supabaseAdmin
    .from('friends')
    .insert({ user_id: userId, friend_id: friendId, status: 'pending' });
  if (error) throw new Error(error.message);
}

async function acceptFriendRequest(userId, friendId) {
  const { error: e1 } = await supabaseAdmin
    .from('friends')
    .update({ status: 'accepted' })
    .eq('user_id', friendId)
    .eq('friend_id', userId)
    .eq('status', 'pending');
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await supabaseAdmin
    .from('friends')
    .insert({ user_id: userId, friend_id: friendId, status: 'accepted' });
  if (e2) throw new Error(e2.message);
}

async function removeFriend(userId, friendId) {
  await supabaseAdmin.from('friends').delete().eq('user_id', userId).eq('friend_id', friendId);
  await supabaseAdmin.from('friends').delete().eq('user_id', friendId).eq('friend_id', userId);
}

async function getFriends(userId) {
  const { data, error } = await supabaseAdmin
    .from('friends')
    .select(`friend_id, users!friends_friend_id_fkey(id, username, display_name, avatar_url, last_seen)`)
    .eq('user_id', userId)
    .eq('status', 'accepted');
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({ id: r.users.id, username: r.users.username, display_name: r.users.display_name, avatar_url: r.users.avatar_url, last_seen: r.users.last_seen }));
}

async function getPendingRequests(userId) {
  const { data, error } = await supabaseAdmin
    .from('friends')
    .select(`user_id, users!friends_user_id_fkey(id, username, display_name, avatar_url, last_seen)`)
    .eq('friend_id', userId)
    .eq('status', 'pending');
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({ id: r.users.id, username: r.users.username, display_name: r.users.display_name, avatar_url: r.users.avatar_url, last_seen: r.users.last_seen }));
}

async function getFriendGames(friendId) {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('user_id', friendId);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getFriendStatus(userId, friendId) {
  const { data, error } = await supabaseAdmin
    .from('friends')
    .select('status')
    .eq('user_id', userId)
    .eq('friend_id', friendId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.status || null;
}

async function updateAvatar(userId, avatarUrl) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ avatar_url: avatarUrl })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function sendGameSuggestion(fromUserId, toUserId, gameId, gameTitle, gameCover, message) {
  const { error } = await supabaseAdmin
    .from('game_suggestions')
    .insert({
      from_user_id: fromUserId,
      to_user_id: toUserId,
      game_id: gameId,
      game_title: gameTitle || '',
      game_cover: gameCover || '',
      message: message || '',
    });
  if (error) throw new Error(error.message);
}

async function getGameSuggestions(userId) {
  const { data, error } = await supabaseAdmin
    .from('game_suggestions')
    .select(`*, users!game_suggestions_from_user_id_fkey(id, username, display_name, avatar_url)`)
    .eq('to_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function removeGameSuggestion(id) {
  const { error } = await supabaseAdmin
    .from('game_suggestions')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function ensureCatalogGame(game) {
  const { game_id, title, platform, cover, genre, year } = game;
  if (!game_id || !title) return;
  const { error } = await supabaseAdmin
    .from('catalog')
    .upsert({ game_id, title, platform: platform || '', cover: cover || '', genre: genre || '', year: year || 0 },
      { onConflict: 'game_id', ignoreDuplicates: false });
  if (error && error.code !== '23505') throw new Error(error.message);
}

async function getCatalog() {
  const { data, error } = await supabaseAdmin
    .from('catalog')
    .select('*')
    .order('title');
  if (error) throw new Error(error.message);
  return data || [];
}

async function deletePlatformGames(userId, platform) {
  const { error } = await supabaseAdmin
    .from('games')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform);
  if (error) throw new Error(error.message);
}

async function updateLastSeen(userId) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw new Error(error.message);
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
  getAllPublicReviews,
  getGameAvgRatings,
  getWishlist,
  toggleWishlist,
  getTopThree,
  setTopThree,
  deleteUserAccount,
  searchUsers,
  sendFriendRequest,
  acceptFriendRequest,
  removeFriend,
  getFriends,
  getPendingRequests,
  getFriendGames,
  getFriendStatus,
  updateAvatar,
  sendGameSuggestion,
  getGameSuggestions,
  removeGameSuggestion,
  ensureCatalogGame,
  getCatalog,
  deletePlatformGames,
  updateLastSeen,
};
