const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

async function createUser(username, displayName, hashedPassword, email) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ username, display_name: displayName, password: hashedPassword, email: email || '' })
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

async function getUserByEmail(email) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function createResetToken(userId, type) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 3600000); // 1 hour
  const { error } = await supabaseAdmin
    .from('reset_tokens')
    .insert({ user_id: userId, token, type, expires_at: expiresAt.toISOString() });
  if (error) throw new Error(error.message);
  return token;
}

async function getResetToken(token) {
  const { data, error } = await supabaseAdmin
    .from('reset_tokens')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function markResetTokenUsed(token) {
  const { error } = await supabaseAdmin
    .from('reset_tokens')
    .update({ used: true })
    .eq('token', token);
  if (error) throw new Error(error.message);
}

async function getUserById(id) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, username, display_name, avatar_url, email, created_at, steam_id, xbox_gamertag, last_seen')
    .eq('id', id)
    .single();
  checkResult({ data, error });
  return data;
}

async function getAllUserGames(userId) {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('user_id', userId);
  checkResult({ data, error });
  return data || [];
}

async function getGames(userId) {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('*')
    .eq('user_id', userId);
  checkResult({ data, error });
  // Fusionner les jeux avec le même titre (cross-platform)
  const merged = {};
  for (const g of data) {
    const key = g.title.toLowerCase().trim();
    if (!merged[key]) { merged[key] = { ...g, platforms: [g.platform || ''] }; continue; }
    const m = merged[key];
    if (!m.platforms.includes(g.platform)) m.platforms.push(g.platform);
    m.playtime = (m.playtime || 0) + (g.playtime || 0);
    const statusRank = { completed: 4, playing: 3, paused: 2, dropped: 1, not_started: 0 };
    if (statusRank[g.status] > statusRank[m.status]) m.status = g.status;
    if (!m.cover && g.cover) m.cover = g.cover;
    if (g.genre && !m.genre) m.genre = g.genre;
    if (g.year && !m.year) m.year = g.year;
    if (g.developer && !m.developer) m.developer = g.developer;
  }
  return Object.values(merged);
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
      developer: game.developer || '',
      publisher: game.publisher || '',
    }, { onConflict: 'user_id, game_id' });
  if (error) {
    // If columns don't exist yet, retry without developer/publisher
    if (error.message && error.message.includes('developer')) {
      const { error: e2 } = await supabaseAdmin
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
      if (e2) throw new Error(e2.message);
      return;
    }
    throw new Error(error.message);
  }
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
  let gameIds = [gameId];
  const { data: catEntry } = await supabaseAdmin.from('catalog').select('title').eq('game_id', gameId).maybeSingle();
  if (catEntry?.title) {
    const { data: related } = await supabaseAdmin.from('catalog').select('game_id').ilike('title', catEntry.title);
    if (related?.length > 1) gameIds = [...new Set(related.map(r => r.game_id))];
  }
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*, users(display_name, username)`)
    .in('game_id', gameIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getAllPublicReviews() {
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*, users(display_name, username, avatar_url)`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getUserPublicReviews(userId) {
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*`)
    .eq('user_id', userId)
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
  const { game_id, title, platform, cover, genre, year, developer, publisher, description } = game;
  if (!game_id || !title) return;
  const payload = { game_id, title, platform: platform || '', cover: cover || '', genre: genre || '', year: year || 0, developer: developer || '', publisher: publisher || '' };
  if (description) payload.description = description;
  const { error } = await supabaseAdmin
    .from('catalog')
    .upsert(payload, { onConflict: 'game_id', ignoreDuplicates: false });
  if (error && error.code !== '23505') {
    if (error.message && (error.message.includes('developer') || error.message.includes('description'))) {
      const fallback = { game_id, title, platform: platform || '', cover: cover || '', genre: genre || '', year: year || 0 };
      if (description && !error.message.includes('description')) fallback.description = description;
      const { error: e2 } = await supabaseAdmin
        .from('catalog')
        .upsert(fallback, { onConflict: 'game_id', ignoreDuplicates: false });
      if (e2 && e2.code !== '23505') throw new Error(e2.message);
      return;
    }
    throw new Error(error.message);
  }
}

async function dedupeCatalog() {
  const { data, error } = await supabaseAdmin
    .from('catalog')
    .select('game_id, title')
    .order('game_id');
  if (error) throw new Error(error.message);
  if (!data || data.length < 2) return 0;
  const seen = new Map();
  const toDelete = [];
  for (const row of data) {
    const match = row.game_id.match(/(\d+)$/);
    const key = match ? match[1] : row.game_id;
    if (seen.has(key)) toDelete.push(row.game_id);
    else seen.set(key, true);
  }
  if (toDelete.length === 0) return 0;
  const { error: delErr } = await supabaseAdmin
    .from('catalog')
    .delete()
    .in('game_id', toDelete);
  if (delErr) throw new Error(delErr.message);
  return toDelete.length;
}

async function getCatalog() {
  const { data, error } = await supabaseAdmin
    .from('catalog')
    .select('*')
    .order('title');
  if (error) throw new Error(error.message);
  return data || [];
}

async function getCatalogCount() {
  const { count, error } = await supabaseAdmin
    .from('catalog')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count || 0;
}

async function deleteAllUserGames(userId) {
  const { error } = await supabaseAdmin
    .from('games')
    .delete()
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

async function deleteGame(userId, gameId) {
  const { error } = await supabaseAdmin
    .from('games')
    .delete()
    .eq('user_id', userId)
    .eq('game_id', gameId);
  if (error) throw new Error(error.message);
}

async function updateGamePlatform(userId, gameId, platform) {
  const { error } = await supabaseAdmin
    .from('games')
    .update({ platform })
    .eq('user_id', userId)
    .eq('game_id', gameId);
  if (error) throw new Error(error.message);
}

async function deletePlatformGames(userId, platform) {
  const { error } = await supabaseAdmin
    .from('games')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform);
  if (error) throw new Error(error.message);
}

async function resetAllData() {
  const { error: e1 } = await supabaseAdmin.from('games').delete().gte('user_id', 0);
  const { error: e2 } = await supabaseAdmin.from('catalog').delete().gte('game_id', '');
  if (e1 || e2) throw new Error((e1?.message || '') + (e2?.message || ''));
}

async function updateLastSeen(userId) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function setSteamId(userId, steamId) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ steam_id: steamId })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function setXboxGamertag(userId, gamertag) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ xbox_gamertag: gamertag })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function sendMessage(senderId, receiverId, message) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({ sender_id: senderId, receiver_id: receiverId, message })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getMessages(userId, friendId) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  return data || [];
}

async function markMessagesRead(userId, senderId) {
  const { error } = await supabaseAdmin
    .from('messages')
    .update({ read: true })
    .eq('sender_id', senderId)
    .eq('receiver_id', userId)
    .eq('read', false);
  if (error) throw new Error(error.message);
}

async function getConversations(userId) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select(`*, sender:sender_id(id, display_name, avatar_url), receiver:receiver_id(id, display_name, avatar_url)`)
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const conv = {};
  for (const m of data || []) {
    const otherId = m.sender_id === userId ? m.receiver_id : m.sender_id;
    const other = m.sender_id === userId ? m.receiver : m.sender;
    if (!conv[otherId] || new Date(m.created_at) > new Date(conv[otherId].lastMessage.created_at)) {
      conv[otherId] = { otherId, other, lastMessage: m, unread: !m.read && m.receiver_id === userId ? 1 : 0 };
    } else if (!m.read && m.receiver_id === userId) {
      conv[otherId].unread++;
    }
  }
  return Object.values(conv).sort((a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at));
}

// === BOOST SYSTÈME ===

async function getBoostPoints(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('boost_points, last_boost_week')
    .eq('id', userId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ============ BOOSTER SYSTEM ============

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  return monday.toISOString().split('T')[0];
}

async function getBoosterPoints(userId) {
  const { data, error } = await supabaseAdmin
    .from('booster_points')
    .select('points, claimed_first_login')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || { points: 0, claimed_first_login: false };
}

async function claimFirstLoginPoints(userId) {
  const existing = await getBoosterPoints(userId);
  if (existing.claimed_first_login) return existing;
  const { data, error } = await supabaseAdmin
    .from('booster_points')
    .upsert({ user_id: userId, points: 1, claimed_first_login: true }, { onConflict: 'user_id' })
    .select('points, claimed_first_login')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function resetWeeklyBoostPoints(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil((((now - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ boost_points: 3, last_boost_week: week })
    .eq('id', userId)
    .select('boost_points')
    .single();
  if (error) throw new Error(error.message);
  return data.boost_points;
}

async function getTopBoosted(limit = 10) {
  const { data, error } = await supabaseAdmin
    .from('boosts')
    .select('game_id, count:game_id', { count: 'plain' })
    .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .limit(0);
  if (error) {
    const { data: all, error: e2 } = await supabaseAdmin
      .from('boosts')
      .select('game_id');
    if (e2) throw new Error(e2.message);
    return aggregateBoostCounts(all, limit);
  }
  return aggregateBoostCounts(data, limit);
}

function aggregateBoostCounts(rows, limit) {
  const counts = {};
  for (const r of rows || []) {
    counts[r.game_id] = (counts[r.game_id] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([game_id, count]) => ({ game_id, count }));
}

async function getGameBoostCount(gameId) {
  const { count, error } = await supabaseAdmin
    .from('boosts')
    .select('*', { count: 'exact', head: true })
    .eq('game_id', gameId);
  if (error) return 0;
  return count || 0;
}

async function boostGame(userId, gameId) {
  const weekStart = getWeekStart();
  const pointsData = await getBoosterPoints(userId);
  if (pointsData.points < 1) throw new Error('Pas assez de points booster');

  const { data: existing } = await supabaseAdmin
    .from('game_boosts')
    .select('id')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .eq('week_start', weekStart)
    .maybeSingle();

  if (existing) throw new Error('Tu as déjà boosté ce jeu cette semaine');

  const { error: boostError } = await supabaseAdmin
    .from('game_boosts')
    .insert({ user_id: userId, game_id: gameId, week_start: weekStart });
  if (boostError) throw new Error(boostError.message);

  await supabaseAdmin
    .from('booster_points')
    .update({ points: pointsData.points - 1 })
    .eq('user_id', userId);

  return true;
}

async function getTopBoostedGames() {
  const weekStart = getWeekStart();
  const { data, error } = await supabaseAdmin
    .from('game_boosts')
    .select('game_id, week_start')
    .eq('week_start', weekStart);
  if (error) throw new Error(error.message);

  const counts = {};
  for (const row of data || []) {
    counts[row.game_id] = (counts[row.game_id] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  const result = [];
  for (const [gameId, boostCount] of sorted) {
    const { data: cat } = await supabaseAdmin
      .from('catalog')
      .select('*')
      .eq('game_id', gameId)
      .maybeSingle();
    if (cat) {
      result.push({ ...cat, boost_count: boostCount });
    }
  }
  return result;
}

async function getUserBoostStatus(userId, gameId) {
  const weekStart = getWeekStart();
  const { data, error } = await supabaseAdmin
    .from('game_boosts')
    .select('id')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

module.exports = {
  supabaseAdmin,
  createUser,
  getUserByUsername,
  getUserByEmail,
  createResetToken,
  getResetToken,
  markResetTokenUsed,
  getUserById,
  getGames,
  upsertGame,
  updateGameStatus,
  updateGameRating,
  savePublicReview,
  getGameReviews,
  getAllPublicReviews,
  getUserPublicReviews,
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
  getAllUserGames,
  deleteAllUserGames,
  deleteGame,
  resetAllData,
  ensureCatalogGame,
  dedupeCatalog,
  getCatalog,
  getCatalogCount,
  updateGamePlatform,
  deletePlatformGames,
  updateLastSeen,
  setSteamId,
  setXboxGamertag,
  sendMessage,
  getMessages,
  markMessagesRead,
  getConversations,
  getBoostPoints,
  resetWeeklyBoostPoints,
  boostGame,
  getTopBoosted,
  getGameBoostCount,
  getBoosterPoints,
  claimFirstLoginPoints,
  getTopBoostedGames,
  getUserBoostStatus,
};
