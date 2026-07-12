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

async function getUserCount() {
  const { count, error } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count || 0;
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
    .select('*')
    .eq('id', id)
    .single();
  try { checkResult({ data, error }); } catch (e) {
    // fallback: certains champs peuvent manquer (colonne non ajoutée)
    const { data: d2, error: e2 } = await supabaseAdmin.from('users').select('id, username, display_name, email, avatar_url, epic_username, created_at').eq('id', id).single();
    if (e2) throw new Error(e2.message);
    data = d2;
  }
  if (data) delete data.password;
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
    .eq('user_id', userId)
    .limit(100000);
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
    .upsert({ user_id: userId, game_id: gameId, status }, { onConflict: 'user_id, game_id' });
  if (error) throw new Error(error.message);
}

async function updateGameRating(userId, gameId, rating, reviewText, reviewPublic) {
  const hasReview = reviewText && reviewText.trim().length > 0;
  const { error } = await supabaseAdmin
    .from('games')
    .upsert({
      user_id: userId,
      game_id: gameId,
      user_rating: rating,
      review_text: reviewText,
      review_public: reviewPublic,
      has_review: hasReview,
    }, { onConflict: 'user_id, game_id' });
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
  console.log('[savePublicReview] Params:', { userId, gameId, rating, reviewTextLength: reviewText?.length, gameTitle });
  const buildPayload = (withExtra) => ({
    user_id: userId,
    game_id: gameId,
    rating,
    review_text: reviewText,
    ...(withExtra ? { game_title: gameTitle || '', game_cover: gameCover || '' } : {}),
  });
  // Try upsert first (requires UNIQUE(user_id, game_id) constraint)
  let { data, error } = await supabaseAdmin
    .from('community_reviews')
    .upsert(buildPayload(true), { onConflict: 'user_id, game_id' });
  if (error && error.message && error.message.includes('game_cover')) {
    console.log('[savePublicReview] game_cover column missing, retrying without it');
    ({ data, error } = await supabaseAdmin
      .from('community_reviews')
      .upsert(buildPayload(false), { onConflict: 'user_id, game_id' }));
  }
  if (error) {
    console.log('[savePublicReview] Upsert failed, trying insert/update fallback:', error.message);
    // Fallback: delete existing then insert (for tables without the UNIQUE constraint)
    await supabaseAdmin.from('community_reviews').delete().eq('user_id', userId).eq('game_id', gameId);
    let { error: e2 } = await supabaseAdmin
      .from('community_reviews')
      .insert(buildPayload(true));
    if (e2 && e2.message && e2.message.includes('game_cover')) {
      console.log('[savePublicReview] Fallback without extra columns');
      ({ error: e2 } = await supabaseAdmin
        .from('community_reviews')
        .insert(buildPayload(false)));
    }
    if (e2) {
      console.error('[savePublicReview] Fallback also failed:', e2);
      throw new Error(e2.message);
    }
    console.log('[savePublicReview] Fallback insert succeeded');
    return;
  }
  console.log('[savePublicReview] Upsert succeeded, data:', data);
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
  console.log('[getAllPublicReviews] Querying community_reviews...');
  const { data, error } = await supabaseAdmin
    .from('community_reviews')
    .select(`*, users(display_name, username, avatar_url)`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('[getAllPublicReviews] Supabase error:', error);
    throw new Error(error.message);
  }
  console.log('[getAllPublicReviews] Result count:', data?.length, 'rows:', JSON.stringify(data?.map(r => ({ id: r.id, user_id: r.user_id, game_id: r.game_id, rating: r.rating, review_text_length: r.review_text?.length }))));
  return (data || []).map(r => ({ ...r, reply_count: 0 }));
}

async function saveReviewReply(userId, reviewId, text) {
  try {
    const { data, error } = await supabaseAdmin
      .from('review_replies')
      .insert({ user_id: userId, review_id: reviewId, text })
      .select('*, users(display_name, username, avatar_url)')
      .single();
    if (error) { if (isMissingTable(error)) return null; throw new Error(error.message); }
    return data;
  } catch (e) { if (isMissingTable(e)) return null; throw e; }
}

async function getReviewReplies(reviewId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('review_replies')
      .select('*, users(display_name, username, avatar_url)')
      .eq('review_id', reviewId)
    .order('created_at', { ascending: true });
    if (error) { if (isMissingTable(error)) return []; throw new Error(error.message); }
    return data || [];
  } catch (e) { if (isMissingTable(e)) return []; throw e; }
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

async function getFriendGames(userId, friendId) {
  const { data: rel } = await supabaseAdmin
    .from('friends')
    .select('status')
    .eq('user_id', userId)
    .eq('friend_id', friendId)
    .maybeSingle();
  if (!rel || rel.status !== 'accepted') return [];
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_id, title, platform, cover, genre, year, playtime, status, developer, publisher')
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

async function removeGameSuggestion(id, userId) {
  const { data: sug } = await supabaseAdmin
    .from('game_suggestions')
    .select('from_user_id, to_user_id')
    .eq('id', id)
    .maybeSingle();
  if (!sug) throw new Error('Suggestion introuvable');
  if (sug.from_user_id !== userId && sug.to_user_id !== userId) {
    throw new Error('Non autorisé');
  }
  const { error } = await supabaseAdmin
    .from('game_suggestions')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function ensureCatalogGame(game) {
  const { game_id, title, platform, cover, genre, year, developer, publisher, description, editorial_score, user_score, platforms_raw, jv_url, age_rating } = game;
  if (!game_id || !title) return;
  const payload = { game_id, title, platform: platform || '', cover: cover || '', genre: genre || '', year: year || 0, developer: developer || '', publisher: publisher || '', editorial_score: editorial_score || '', user_score: user_score || '', platforms_raw: platforms_raw || '', jv_url: jv_url || '', age_rating: age_rating || 0 };
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
      invalidateCatalogCache();
      return;
    }
    throw new Error(error.message);
  }
  invalidateCatalogCache();
}

async function batchUpsertCatalog(games) {
  if (!games || games.length === 0) return;
  games = games.filter(g => g.game_id?.startsWith('jv-'));
  if (games.length === 0) return;
  const now = new Date().toISOString();
  const payloads = games.map(g => ({
    game_id: g.game_id, title: g.title, platform: g.platform || '',
    cover: g.cover || '', genre: g.genre || '', year: g.year || 0,
    developer: g.developer || '', publisher: g.publisher || '',
    description: g.description || '',
    editorial_score: g.editorial_score || '',
    user_score: g.user_score || '',
    platforms_raw: g.platforms_raw || '',
    jv_url: g.jv_url || '',
    age_rating: g.age_rating || 0,
    updated_at: now,
  }));
  const { error } = await supabaseAdmin.from('catalog').upsert(payloads, { onConflict: 'game_id', ignoreDuplicates: true });
  if (error) {
    // Retry sans les colonnes avancées (si elles n'existent pas encore)
    const basic = games.map(g => ({
      game_id: g.game_id, title: g.title, platform: g.platform || '',
      cover: g.cover || '', genre: g.genre || '', year: g.year || 0,
      developer: g.developer || '', publisher: g.publisher || '',
      description: g.description || '',
    }));
    const { error: e2 } = await supabaseAdmin.from('catalog').upsert(basic, { onConflict: 'game_id', ignoreDuplicates: true });
    if (e2) console.error('[batchUpsertCatalog] Fallback error:', e2.message);
    else {
      // Mise à jour en 2 passes : d'abord les basics, puis les colonnes avancées
      const extra = games.map(g => ({
        game_id: g.game_id,
        editorial_score: g.editorial_score || '',
        user_score: g.user_score || '',
        platforms_raw: g.platforms_raw || '',
        jv_url: g.jv_url || '',
        age_rating: g.age_rating || 0,
        updated_at: now,
      }));
      const { error: e3 } = await supabaseAdmin.from('catalog').upsert(extra, { onConflict: 'game_id' });
      if (e3) { /* colonnes pas encore créées, pas grave */ }
    }
  }
  invalidateCatalogCache();
}

async function batchUpsertUserGames(userId, games) {
  if (!games || games.length === 0) return;
  const payloads = games.map(g => ({
    user_id: userId, game_id: g.game_id, title: g.title,
    platform: g.platform || '', genre: g.genre || '',
    cover: g.cover || '', status: g.status || 'not_started',
    playtime: g.playtime || 0, year: g.year || 0,
    user_rating: g.user_rating || 0, review_text: g.review_text || '',
    review_public: g.review_public !== false,
    has_review: g.has_review ? true : false,
    developer: g.developer || '', publisher: g.publisher || '',
  }));
  const { error } = await supabaseAdmin.from('games').upsert(payloads, { onConflict: 'user_id, game_id' });
  if (error && error.message?.includes('developer')) {
    const basic = payloads.map(p => ({ user_id: p.user_id, game_id: p.game_id, title: p.title, platform: p.platform, genre: p.genre, cover: p.cover, status: p.status, playtime: p.playtime, year: p.year, user_rating: p.user_rating, review_text: p.review_text, review_public: p.review_public, has_review: p.has_review }));
    const { error: e2 } = await supabaseAdmin.from('games').upsert(basic, { onConflict: 'user_id, game_id' });
    if (e2) console.error('[batchUpsertUserGames] Error:', e2.message);
  }
}

async function batchUpsertCatalogSteam(games) {
  if (!games || games.length === 0) return;
  const payloads = games.map(g => ({
    game_id: g.game_id, title: g.title, platform: g.platform || '',
    cover: g.cover || '', genre: g.genre || '', year: g.year || 0,
    developer: g.developer || '', publisher: g.publisher || '',
    description: g.description || '',
  }));
  const { error } = await supabaseAdmin.from('catalog').upsert(payloads, { onConflict: 'game_id', ignoreDuplicates: true });
  if (error) console.error('[batchUpsertCatalogSteam] Error:', error.message);
  invalidateCatalogCache();
}

async function clearCatalog() {
  const { data: all, error: fetchError } = await supabaseAdmin.from('catalog').select('game_id').limit(100000);
  if (fetchError) throw new Error(fetchError.message);
  if (!all || all.length === 0) return;
  const ids = all.map(r => r.game_id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error } = await supabaseAdmin.from('catalog').delete().in('game_id', batch);
    if (error) throw new Error(error.message);
  }
  invalidateCatalogCache();
}

async function deleteCatalogGame(gameId) {
  const { error } = await supabaseAdmin.from('catalog').delete().eq('game_id', gameId);
  if (error) throw new Error(error.message);
  invalidateCatalogCache();
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

async function mergeCatalogDuplicatesByTitle() {
  const { data, error } = await supabaseAdmin.from('catalog').select('*');
  if (error) throw new Error(error.message);
  if (!data || data.length < 2) return 0;
  const groups = new Map();
  for (const g of data) {
    const key = g.title.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const tables = ['games','wishlist','top_three','community_reviews','game_suggestions','boosts','game_boosts'];
  let totalDeleted = 0;
  for (const [, entries] of groups) {
    if (entries.length < 2) continue;
    entries.sort((a, b) =>
      ((b.description ? 2 : 0) + (b.developer ? 1 : 0) + (b.publisher ? 1 : 0) + (b.cover ? 1 : 0)) -
      ((a.description ? 2 : 0) + (a.developer ? 1 : 0) + (a.publisher ? 1 : 0) + (a.cover ? 1 : 0))
    );
    const keep = entries[0];
    for (const dup of entries.slice(1)) {
      for (const table of tables) {
        const { data: refs } = await supabaseAdmin.from(table).select('*').eq('game_id', dup.game_id);
        if (!refs) continue;
        for (const ref of refs) {
          let uniqueFields = {};
          if (['games','wishlist','community_reviews','boosts'].includes(table)) uniqueFields = { user_id: ref.user_id, game_id: keep.game_id };
          else if (table === 'top_three') uniqueFields = { user_id: ref.user_id, position: ref.position };
          else if (table === 'game_boosts') uniqueFields = { user_id: ref.user_id, week_start: ref.week_start };
          const { data: existing } = Object.keys(uniqueFields).length > 0
            ? await supabaseAdmin.from(table).select('id').match(uniqueFields).maybeSingle()
            : { data: null };
          if (existing) await supabaseAdmin.from(table).delete().eq('id', ref.id);
          else await supabaseAdmin.from(table).update({ game_id: keep.game_id }).eq('id', ref.id);
        }
      }
      const upd = {};
      if (!keep.cover && dup.cover) upd.cover = dup.cover;
      if (!keep.description && dup.description) upd.description = dup.description;
      if (!keep.developer && dup.developer) upd.developer = dup.developer;
      if (!keep.publisher && dup.publisher) upd.publisher = dup.publisher;
      if (!keep.genre && dup.genre) upd.genre = dup.genre;
      if (!keep.year && dup.year) upd.year = dup.year;
      if (Object.keys(upd).length > 0) await supabaseAdmin.from('catalog').update(upd).eq('game_id', keep.game_id);
      const { error: delErr } = await supabaseAdmin.from('catalog').delete().eq('game_id', dup.game_id);
      if (!delErr) totalDeleted++;
    }
  }
  return totalDeleted;
}

let catalogCache = null;

async function getCatalog() {
  if (catalogCache) return catalogCache;
  const { data, error } = await supabaseAdmin
    .from('catalog')
    .select('*')
    .limit(100000);
  if (error) throw new Error(error.message);
  if (!data) return [];
  const letterRe = /^[a-zA-ZÀ-ÖØ-öø-ÿŒœ]/;
  data.sort((a, b) => {
    const aTitle = a.title || '';
    const bTitle = b.title || '';
    const aLetter = letterRe.test(aTitle);
    const bLetter = letterRe.test(bTitle);
    if (aLetter && !bLetter) return -1;
    if (!aLetter && bLetter) return 1;
    const al = aTitle.toLowerCase();
    const bl = bTitle.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });
  catalogCache = data;
  return data;
}

async function queryCatalog({ search, letter, platform, genre, yearMin, yearMax, editorialMin, editorialMax, userScoreMin, userScoreMax, ageRating, page = 1, limit = 60 }) {
  // Construction de la requête Supabase avec filtres
  let query = supabaseAdmin.from('catalog').select('*', { count: 'exact' });
  if (search && search.trim()) {
    const s = search.trim().toLowerCase();
    // On filtre en mémoire pour la recherche (fonctionne sur tout le cache)
    const all = await getCatalog();
    let filtered = all.filter(g => (g.title || '').toLowerCase().includes(s));
    if (letter && letter !== 'all') {
      if (letter === '#') { const lr = /^[a-zA-ZÀ-ÖØ-öø-ÿŒœ]/; filtered = filtered.filter(g => !lr.test(g.title || '')); }
      else { const l = letter.toLowerCase(); filtered = filtered.filter(g => (g.title || '').toLowerCase().startsWith(l)); }
    }
    const total = filtered.length;
    const offset = (page - 1) * limit;
    return { data: filtered.slice(offset, offset + limit), total, page, limit };
  }
  // Lettre / tri
  if (letter && letter !== 'all') {
    if (letter === '#') {
      const all = await getCatalog();
      const lr = /^[a-zA-ZÀ-ÖØ-öø-ÿŒœ]/;
      let filtered = all.filter(g => !lr.test(g.title || ''));
      filtered = applyExtraFilters(filtered, { platform, genre, yearMin, yearMax, editorialMin, editorialMax, userScoreMin, userScoreMax, ageRating });
      const total = filtered.length;
      const offset = (page - 1) * limit;
      return { data: filtered.slice(offset, offset + limit), total, page, limit };
    }
    query = query.ilike('title', letter.toLowerCase() + '%');
  }
  // Filtres simples (via Supabase)
  if (platform && platform !== 'all') query = query.or(`platform.ilike.%${platform}%,platforms_raw.ilike.%${platform}%`);
  if (genre && genre !== 'all') query = query.eq('genre', genre);
  if (yearMin) query = query.gte('year', parseInt(yearMin));
  if (yearMax) query = query.lte('year', parseInt(yearMax));
  if (ageRating) { const a = parseInt(ageRating); query = query.gte('age_rating', a); }
  // Scores (editorial, user) — on les filtre en mémoire car format string "X/20"
  const hasScoreFilter = editorialMin || editorialMax || userScoreMin || userScoreMax;
  // Pagination + tri
  const offset = (page - 1) * limit;
  if (!hasScoreFilter) {
    const total = await getCatalogCount();
    query = query.order('title').range(offset, offset + limit - 1);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total, page, limit };
  }
  // Avec filtres de score → chargement + filtre en mémoire
  const all = await getCatalog();
  let filtered = applyExtraFilters(all, { platform, genre, yearMin, yearMax, editorialMin, editorialMax, userScoreMin, userScoreMax, ageRating });
  if (letter && letter !== 'all') {
    if (letter === '#') { const lr = /^[a-zA-ZÀ-ÖØ-öø-ÿŒœ]/; filtered = filtered.filter(g => !lr.test(g.title || '')); }
    else { const l = letter.toLowerCase(); filtered = filtered.filter(g => (g.title || '').toLowerCase().startsWith(l)); }
  }
  const total = filtered.length;
  return { data: filtered.slice(offset, offset + limit), total, page, limit };
}

function applyExtraFilters(games, { platform, genre, yearMin, yearMax, editorialMin, editorialMax, userScoreMin, userScoreMax, ageRating }) {
  let filtered = games;
  if (platform && platform !== 'all') filtered = filtered.filter(g => g.platform === platform || (g.platforms_raw || '').toLowerCase().includes(platform.toLowerCase()));
  if (genre && genre !== 'all') filtered = filtered.filter(g => (g.genre || '').toLowerCase() === genre.toLowerCase());
  if (yearMin) filtered = filtered.filter(g => g.year >= parseInt(yearMin));
  if (yearMax) filtered = filtered.filter(g => g.year <= parseInt(yearMax));
  if (ageRating) { const a = parseInt(ageRating); filtered = filtered.filter(g => g.age_rating >= a); }
  if (editorialMin) filtered = filtered.filter(g => parseFloat(g.editorial_score) >= parseFloat(editorialMin));
  if (editorialMax) filtered = filtered.filter(g => parseFloat(g.editorial_score) <= parseFloat(editorialMax));
  if (userScoreMin) filtered = filtered.filter(g => parseFloat(g.user_score) >= parseFloat(userScoreMin));
  if (userScoreMax) filtered = filtered.filter(g => parseFloat(g.user_score) <= parseFloat(userScoreMax));
  return filtered;
}

async function searchCatalog({ search, letter, page = 1, limit = 500 }) {
  const all = await getCatalog();
  let filtered = all;
  if (search && search.trim()) {
    const s = search.trim().toLowerCase();
    filtered = all.filter(g => (g.title || '').toLowerCase().includes(s));
  } else if (letter && letter !== 'all' && letter !== '#') {
    const l = letter.toLowerCase();
    filtered = all.filter(g => (g.title || '').toLowerCase().startsWith(l));
  }
  const total = filtered.length;
  const offset = (page - 1) * limit;
  const data = filtered.slice(offset, offset + limit);
  return { data, total, page, limit };
}

function invalidateCatalogCache() {
  catalogCache = null;
}

async function getCatalogCount() {
  const { count, error } = await supabaseAdmin
    .from('catalog')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count || 0;
}

async function getRecentReleases() {
  const { data, error } = await supabaseAdmin
    .from('catalog')
    .select('*')
    .gte('year', 2024)
    .order('year', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data || [];
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

async function setEpicUsername(userId, epicUsername) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ epic_username: epicUsername })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function setPsnNpsso(userId, npsso) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ psn_npsso: npsso })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function setPsnTokens(userId, accessToken, refreshToken, expiresAt) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      psn_access_token: accessToken,
      psn_refresh_token: refreshToken,
      psn_token_expires_at: expiresAt,
    })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function getPsnTokens(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('psn_npsso, psn_access_token, psn_refresh_token, psn_token_expires_at')
    .eq('id', userId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function clearPsnTokens(userId) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      psn_npsso: '',
      psn_access_token: '',
      psn_refresh_token: '',
      psn_token_expires_at: null,
    })
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
  // Si l'utilisateur a déjà des points (ex: ajoutés manuellement), on les conserve
  const points = existing.points > 0 ? existing.points : 1;
  const { data, error } = await supabaseAdmin
    .from('booster_points')
    .upsert({ user_id: userId, points, claimed_first_login: true }, { onConflict: 'user_id' })
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
    .select('game_id')
    .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString());
  if (error) throw new Error(error.message);
  return aggregateBoostCounts(data || [], limit);
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

// Boost communautaire (3 points/semaine, table boosts)
async function communityBoostGame(userId, gameId) {
  // Vérifie les points restants de la semaine
  let bp = await getBoostPoints(userId);
  const now = new Date();
  const year = now.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil((((now - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  if (bp.last_boost_week < week) {
    bp = { boost_points: 3, last_boost_week: week };
    await supabaseAdmin.from('users').update({ boost_points: 3, last_boost_week: week }).eq('id', userId);
  }
  if (bp.boost_points < 1) throw new Error('Tu n\'as plus de boost cette semaine');

  const { data: existing } = await supabaseAdmin
    .from('boosts')
    .select('id')
    .eq('user_id', userId)
    .eq('game_id', gameId)
    .maybeSingle();
  if (existing) throw new Error('Tu as déjà boosté ce jeu');

  const { error } = await supabaseAdmin
    .from('boosts')
    .insert({ user_id: userId, game_id: gameId });
  if (error) throw new Error(error.message);

  await supabaseAdmin.from('users').update({ boost_points: bp.boost_points - 1 }).eq('id', userId);
  return { remaining: bp.boost_points - 1 };
}

// Booster individuel (1 point/semaine, table game_boosts)
async function boosterBoostGame(userId, gameId) {
  const weekStart = getWeekStart();
  let pointsData = await getBoosterPoints(userId);

  // Reset hebdo : si 0 point mais aucun boost cette semaine, redonne 1 point
  if (pointsData.points < 1) {
    const { data: weekBoosts } = await supabaseAdmin
      .from('game_boosts')
      .select('id')
      .eq('user_id', userId)
      .eq('week_start', weekStart);
    if (!weekBoosts || weekBoosts.length === 0) {
      await supabaseAdmin
        .from('booster_points')
        .update({ points: 1 })
        .eq('user_id', userId);
      pointsData.points = 1;
    } else {
      throw new Error('Pas assez de points booster');
    }
  }

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

  return { remaining: pointsData.points - 1 };
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

  const enriched = await Promise.all(sorted.map(async ([gameId, count]) => {
    const { data: cat } = await supabaseAdmin
      .from('catalog')
      .select('*')
      .eq('game_id', gameId)
      .maybeSingle();
    return { game_id: gameId, count, game: cat || null };
  }));
  return enriched;
}

async function voteReview(userId, reviewId, vote) {
  try {
    const { error } = await supabaseAdmin
      .from('review_votes')
      .upsert({ user_id: userId, review_id: reviewId, vote },
        { onConflict: 'user_id,review_id' });
    if (error) {
      if (isMissingTable(error)) return;
      throw new Error(error.message);
    }
  } catch (e) {
    if (isMissingTable(e)) return;
    throw e;
  }
}

function isMissingTable(e) {
  const msg = (e?.message || e?.error || '') + ' ' + (e?.details || '');
  return e?.code === '42P01' || msg.includes('relation') || msg.includes('does not exist')
    || msg.includes('schema cache') || msg.includes('not found') || msg.includes('Could not find');
}

async function getReviewVotes(reviewIds) {
  try {
    let query = supabaseAdmin.from('review_votes').select('review_id, vote');
    if (reviewIds && reviewIds.length > 0) query = query.in('review_id', reviewIds);
    const { data, error } = await query;
    if (error) { if (isMissingTable(error)) return {}; throw new Error(error.message); }
    const result = {};
    for (const row of data || []) {
      if (!result[row.review_id]) result[row.review_id] = { up: 0, down: 0 };
      if (row.vote === 1) result[row.review_id].up++;
      else result[row.review_id].down++;
    }
    return result;
  } catch (e) {
    if (isMissingTable(e)) return {};
    throw e;
  }
}

async function getUserReviewVotes(userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('review_votes')
      .select('review_id, vote')
      .eq('user_id', userId);
    if (error) { if (isMissingTable(error)) return {}; throw new Error(error.message); }
    const result = {};
    for (const row of data || []) result[row.review_id] = row.vote;
    return result;
  } catch (e) {
    if (isMissingTable(e)) return {};
    throw e;
  }
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

// ─── E-SPORT FAVORITES ─────────────────────────────────────
async function toggleEsportFavorite(userId, event) {
  try {
    const title = event.event || event.title || '';
    const game = event.game || '';
    if (!title) throw new Error('Event title required');
    const { data: existing } = await supabaseAdmin
      .from('esport_favorites')
      .select('id')
      .eq('user_id', userId)
      .eq('event_title', title)
      .eq('event_game', game)
      .maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin
        .from('esport_favorites')
        .delete()
        .eq('id', existing.id);
      if (error) { if (isMissingTable(error)) return { favorited: false }; throw new Error(error.message); }
      return { favorited: false };
    } else {
      const { error } = await supabaseAdmin
        .from('esport_favorites')
        .insert({ user_id: userId, event_title: title, event_game: game, event_desc: event.desc || '', event_date: event.date || '' });
      if (error) { if (isMissingTable(error)) return { favorited: false }; throw new Error(error.message); }
      return { favorited: true };
    }
  } catch (e) {
    if (isMissingTable(e)) return { favorited: false };
    throw e;
  }
}

async function getEsportFavorites(userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('esport_favorites')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) { if (isMissingTable(error)) return []; throw new Error(error.message); }
    return data || [];
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

async function isEsportFavorite(userId, eventTitle, game) {
  try {
    const { data } = await supabaseAdmin
      .from('esport_favorites')
      .select('id')
      .eq('user_id', userId)
      .eq('event_title', eventTitle)
      .eq('event_game', game || '')
      .maybeSingle();
    return !!data;
  } catch (e) {
    if (isMissingTable(e)) return false;
    throw e;
  }
}

// ─── NOTIFICATION PREFERENCES ──────────────────────────────
async function getNotificationPrefs(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('email, email_notifications')
    .eq('id', userId)
    .single();
  if (error) throw new Error(error.message);
  return { email: data?.email || '', emailNotifications: data?.email_notifications || false };
}

async function setNotificationPrefs(userId, prefs) {
  const updates = {};
  if (prefs.emailNotifications !== undefined) updates.email_notifications = prefs.emailNotifications;
  if (Object.keys(updates).length === 0) return;
  const { error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

// ─── PLAYER SEARCH ─────────────────────────────────────────
async function searchPlayersByGame(gameTitle, currentUserId) {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('user_id, users!inner(id, username, display_name, avatar_url)')
    .neq('user_id', currentUserId)
    .ilike('title', `%${gameTitle}%`)
    .limit(20);
  if (error) throw new Error(error.message);
  const seen = new Set();
  const players = [];
  for (const row of data || []) {
    const u = row.users;
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    players.push({ id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url || '' });
  }
  return players;
}

// ─── STREAMER SEARCH (Twitch) ──────────────────────────────
async function searchStreamers(game, twitchClientId, twitchClientSecret) {
  if (!twitchClientId || !twitchClientSecret) return [];
  try {
    // Get Twitch access token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: twitchClientId, client_secret: twitchClientSecret, grant_type: 'client_credentials' }),
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return [];
    // Search channels by game name
    const searchRes = await fetch(`https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(game)}&first=10`, {
      headers: { 'Client-ID': twitchClientId, 'Authorization': `Bearer ${accessToken}` },
    });
    const searchData = await searchRes.json();
    return (searchData.data || []).map(ch => ({
      id: ch.id,
      displayName: ch.display_name,
      broadcasterLanguage: ch.broadcaster_language,
      thumbnailUrl: ch.thumbnail_url,
      isLive: ch.is_live,
      gameName: ch.game_name,
      title: ch.title,
      login: ch.broadcaster_login,
    }));
  } catch (e) {
    console.error('[StreamerSearch] Error:', e.message);
    return [];
  }
}

// ─── NEWS ─────────────────────────────────────────────────
async function addNewsItems(category, items) {
  if (!items || items.length === 0) return;
  // Récupère les titres existants pour éviter les doublons
  const { data: existing } = await supabaseAdmin
    .from('news_cache')
    .select('item_data')
    .eq('category', category);
  const existingTitles = new Set((existing || []).map(r => r.item_data?.title || r.item_data?.event || ''));
  const newItems = items.filter(item => {
    const key = item.title || item.event || '';
    return key && !existingTitles.has(key);
  });
  if (newItems.length === 0) return;
  // Insère les nouveaux items
  const rows = newItems.map((item, i) => ({
    category,
    item_data: item,
    sort_key: i,
  }));
  const { error: insErr } = await supabaseAdmin
    .from('news_cache')
    .insert(rows);
  if (insErr) throw new Error(insErr.message);
}

function cleanItemData(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
  }
  if (Array.isArray(obj)) return obj.map(cleanItemData);
  if (obj && typeof obj === 'object') {
    const cleaned = {};
    for (const k of Object.keys(obj)) cleaned[k] = cleanItemData(obj[k]);
    return cleaned;
  }
  return obj;
}

async function getNewsFromCache() {
  const { data, error } = await supabaseAdmin
    .from('news_cache')
    .select('*')
    .order('category')
    .order('sort_key', { ascending: false });
  if (error) throw new Error(error.message);
  const result = { releases: [], esport: [], drama: [], articles: [] };
  for (const row of data || []) {
    if (result[row.category]) {
      result[row.category].push({ ...cleanItemData(row.item_data), _created_at: row.created_at });
    }
  }
  return result;
}

async function pruneNewsCache(maxPerCategory) {
  for (const cat of ['releases', 'esport', 'drama', 'articles']) {
    const { data } = await supabaseAdmin
      .from('news_cache')
      .select('id')
      .eq('category', cat)
      .order('sort_key', { ascending: false });
    if (data && data.length > maxPerCategory) {
      const toDelete = data.slice(maxPerCategory).map(r => r.id);
      await supabaseAdmin.from('news_cache').delete().in('id', toDelete);
    }
  }
}

async function getNewsCacheAge() {
  const { data, error } = await supabaseAdmin
    .from('news_cache')
    .select('created_at')
    .limit(1)
    .order('created_at', { ascending: false });
  if (error) return null;
  return data?.length > 0 ? new Date(data[0].created_at) : null;
}

async function clearNewsCache() {
  const { error } = await supabaseAdmin
    .from('news_cache')
    .delete()
    .neq('id', 0);
  if (error) throw new Error(error.message);
}

// ─── DISCOVERY NOTIFICATIONS ─────────────────────────────
async function getUserDiscoveries(userId) {
  try {
    // Fetch all dismissed sections for this user
    const { data: dismissed } = await supabaseAdmin
      .from('user_discoveries')
      .select('section')
      .eq('user_id', userId);
    const dismissedSet = new Set((dismissed || []).map(d => d.section));

    // Fetch user data to determine explored sections
    const [games, reviews, friends, topThree, booster] = await Promise.all([
      supabaseAdmin.from('games').select('id').eq('user_id', userId).limit(1),
      supabaseAdmin.from('community_reviews').select('id').eq('user_id', userId).limit(1),
      supabaseAdmin.from('friends').select('id').eq('user_id', userId).eq('status', 'accepted').limit(1),
      supabaseAdmin.from('top_three').select('id').eq('user_id', userId).limit(1),
      supabaseAdmin.from('booster_points').select('points, claimed_first_login').eq('user_id', userId).maybeSingle(),
    ]);

    const hasGames = (games.data || []).length > 0;
    const hasReviews = (reviews.data || []).length > 0;
    const hasFriends = (friends.data || []).length > 0;
    const hasTopThree = (topThree.data || []).length > 0;
    const hasUsedBooster = booster.data && (booster.data.points > 0 || booster.data.claimed_first_login);

    const sections = [
      { id: 'reviews', label: 'Critiques', desc: 'Partage ton avis et découvre les critiques de la communauté ⭐', icon: '💬', explored: hasReviews },
      { id: 'community', label: 'Communauté', desc: 'Ajoute des amis, discute et suis leur bibliothèque 👥', icon: '👥', explored: hasFriends },
      { id: 'top3', label: 'Top 3', desc: 'Épingle tes 3 jeux préférés sur ton profil 🏅', icon: '🏅', explored: hasTopThree },
      { id: 'boost', label: 'Booster', desc: 'Utilise tes points booster pour mettre un jeu en avant ⚡', icon: '⚡', explored: hasUsedBooster },
    ];

    return sections.filter(s => !s.explored && !dismissedSet.has(s.id));
  } catch (e) {
    console.error('[Discoveries] Error:', e.message);
    return [];
  }
}

async function acknowledgeDiscovery(userId, section) {
  try {
    await supabaseAdmin.from('user_discoveries').insert({ user_id: userId, section });
  } catch (e) {
    if (e?.code !== '23505') throw e;
  }
}

// ─── NOTIFICATIONS ─────────────────────────────────────────
async function createNotification(userId, type, title, body, data) {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .insert({ user_id: userId, type, title, body: body || '', data: data || {} });
    if (error) console.error('[Notifications] Create error:', error.message);
  } catch (e) {
    if (!isMissingTable(e)) console.error('[Notifications] Error:', e.message);
  }
}

async function getNotifications(userId, limit = 50, offset = 0) {
  try {
    let query = supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    const { data, error } = await query;
    if (error) { if (isMissingTable(error)) return []; throw new Error(error.message); }
    return data || [];
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

async function getUnreadNotificationCount(userId) {
  try {
    const { count, error } = await supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) { if (isMissingTable(error)) return 0; throw new Error(error.message); }
    return count || 0;
  } catch (e) {
    if (isMissingTable(e)) return 0;
    throw e;
  }
}

async function markNotificationRead(userId, notificationId) {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .eq('user_id', userId);
    if (error) { if (isMissingTable(error)) return; throw new Error(error.message); }
  } catch (e) {
    if (isMissingTable(e)) return;
    throw e;
  }
}

async function markAllNotificationsRead(userId) {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) { if (isMissingTable(error)) return; throw new Error(error.message); }
  } catch (e) {
    if (isMissingTable(e)) return;
    throw e;
  }
}

module.exports = {
  supabaseAdmin,
  createUser,
  getUserCount,
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
  batchUpsertCatalog,
  batchUpsertUserGames,
  batchUpsertCatalogSteam,
  clearCatalog,
  deleteCatalogGame,
  dedupeCatalog,
  mergeCatalogDuplicatesByTitle,
  getCatalog,
  getCatalogCount,
  searchCatalog,
  queryCatalog,
  getRecentReleases,
  invalidateCatalogCache,
  updateGamePlatform,
  deletePlatformGames,
  updateLastSeen,
  setSteamId,
  setXboxGamertag,
  setEpicUsername,
  setPsnNpsso,
  setPsnTokens,
  getPsnTokens,
  clearPsnTokens,
  sendMessage,
  getMessages,
  markMessagesRead,
  getConversations,
  getBoostPoints,
  resetWeeklyBoostPoints,
  communityBoostGame,
  getTopBoosted,
  getGameBoostCount,
  getBoosterPoints,
  claimFirstLoginPoints,
  boosterBoostGame,
  getTopBoostedGames,
  getUserBoostStatus,
  voteReview,
  getReviewVotes,
  getUserReviewVotes,
  saveReviewReply,
  getReviewReplies,
  addNewsItems,
  getNewsFromCache,
  getNewsCacheAge,
  clearNewsCache,
  pruneNewsCache,
  toggleEsportFavorite,
  getEsportFavorites,
  isEsportFavorite,
  getNotificationPrefs,
  setNotificationPrefs,
  searchPlayersByGame,
  searchStreamers,
  getUserDiscoveries,
  acknowledgeDiscovery,
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
};

// ─── AUTO-SCHEMA (création des tables manquantes au démarrage) ──
async function ensureMissingTables() {
  try {
    const fs = require('fs');
    const sql = fs.readFileSync(__dirname + '/supabase-schema.sql', 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--'));
    for (const stmt of statements) {
      await supabaseAdmin.rpc('exec_sql', { query: stmt + ';' }).catch(() => {});
    }
    console.log('[DB] Tables OK');
  } catch (e) {
    // silent - nécessite exec_sql dans Supabase
  }
}
ensureMissingTables();
