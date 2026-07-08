const bcrypt = require('bcryptjs');
const db = require('./db');

const DEMO_USERS = [
  { username: 'alex92', display_name: 'Alex',   email: 'alex@demo.local', password: 'Alex1234',   avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alex' },
  { username: 'sarah_g', display_name: 'Sarah',  email: 'sarah@demo.local', password: 'Sarah1234',  avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=sarah' },
  { username: 'max_rpg', display_name: 'Maxime', email: 'max@demo.local', password: 'Max1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=maxime' },
  { username: 'lea_gg', display_name: 'Léa',    email: 'lea@demo.local', password: 'Lea1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=lea' },
  { username: 'tom_pvp', display_name: 'Tom',    email: 'tom@demo.local', password: 'Tom1234',    avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=tom' },
];

const GAMES_CATALOG = [
  { game_id: 'steam-730', title: 'Counter-Strike 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg', genre: 'FPS', year: 2012, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-570', title: 'Dota 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/library_600x900.jpg', genre: 'MOBA', year: 2013, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-1245620', title: 'Elden Ring', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg', genre: 'Action RPG', year: 2022, developer: 'FromSoftware', publisher: 'Bandai Namco' },
  { game_id: 'steam-292030', title: 'The Witcher 3: Wild Hunt', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/library_600x900.jpg', genre: 'RPG', year: 2015, developer: 'CD Projekt Red', publisher: 'CD Projekt' },
  { game_id: 'steam-1091500', title: 'Cyberpunk 2077', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/library_600x900.jpg', genre: 'RPG', year: 2020, developer: 'CD Projekt Red', publisher: 'CD Projekt' },
  { game_id: 'steam-367520', title: 'Hollow Knight', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/367520/library_600x900.jpg', genre: 'Metroidvania', year: 2017, developer: 'Team Cherry', publisher: 'Team Cherry' },
  { game_id: 'steam-1174180', title: 'Red Dead Redemption 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/library_600x900.jpg', genre: 'Open World', year: 2019, developer: 'Rockstar Games', publisher: 'Rockstar Games' },
  { game_id: 'steam-1086940', title: "Baldur's Gate 3", platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/library_600x900.jpg', genre: 'RPG', year: 2023, developer: 'Larian Studios', publisher: 'Larian Studios' },
  { game_id: 'steam-814380', title: 'Sekiro: Shadows Die Twice', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/814380/library_600x900.jpg', genre: 'Action-Aventure', year: 2019, developer: 'FromSoftware', publisher: 'Activision' },
  { game_id: 'steam-374320', title: 'Dark Souls III', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/374320/library_600x900.jpg', genre: 'Action RPG', year: 2016, developer: 'FromSoftware', publisher: 'Bandai Namco' },
  { game_id: 'steam-271590', title: 'Grand Theft Auto V', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/271590/library_600x900.jpg', genre: 'Open World', year: 2015, developer: 'Rockstar North', publisher: 'Rockstar Games' },
  { game_id: 'steam-782330', title: 'DOOM Eternal', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/782330/library_600x900.jpg', genre: 'FPS', year: 2020, developer: 'id Software', publisher: 'Bethesda' },
  { game_id: 'steam-1426210', title: 'It Takes Two', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1426210/library_600x900.jpg', genre: 'Aventure', year: 2021, developer: 'Hazelight', publisher: 'Electronic Arts' },
  { game_id: 'steam-2215430', title: 'Ghost of Tsushima', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2215430/library_600x900.jpg', genre: 'Action-Aventure', year: 2024, developer: 'Sucker Punch', publisher: 'Sony' },
  { game_id: 'steam-990080', title: 'Hogwarts Legacy', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/990080/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Avalanche Software', publisher: 'Warner Bros.' },
  { game_id: 'steam-1627720', title: 'Lies of P', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1627720/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Neowiz', publisher: 'Neowiz' },
  { game_id: 'steam-1551360', title: 'Forza Horizon 5', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/library_600x900.jpg', genre: 'Course', year: 2021, developer: 'Playground Games', publisher: 'Xbox Game Studios' },
  { game_id: 'steam-2050650', title: 'Resident Evil 4', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2050650/library_600x900.jpg', genre: 'Survival Horror', year: 2023, developer: 'Capcom', publisher: 'Capcom' },
  { game_id: 'steam-1364780', title: 'Street Fighter 6', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1364780/library_600x900.jpg', genre: 'Combat', year: 2023, developer: 'Capcom', publisher: 'Capcom' },
  { game_id: 'steam-1794680', title: 'Vampire Survivors', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1794680/library_600x900.jpg', genre: 'Rogue-lite', year: 2022, developer: 'poncle', publisher: 'poncle' },
  { game_id: 'steam-2344520', title: 'Diablo IV', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2344520/library_600x900.jpg', genre: 'Action RPG', year: 2023, developer: 'Blizzard Entertainment', publisher: 'Blizzard Entertainment' },
  { game_id: 'steam-1328670', title: 'Mass Effect Legendary Edition', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1328670/library_600x900.jpg', genre: 'RPG', year: 2021, developer: 'BioWare', publisher: 'Electronic Arts' },
  { game_id: 'steam-2322010', title: 'God of War Ragnarök', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2322010/library_600x900.jpg', genre: 'Action-Aventure', year: 2024, developer: 'Santa Monica Studio', publisher: 'Sony' },
  { game_id: 'steam-440', title: 'Team Fortress 2', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/440/library_600x900.jpg', genre: 'FPS', year: 2007, developer: 'Valve', publisher: 'Valve' },
  { game_id: 'steam-105600', title: 'Terraria', platform: 'steam', cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/library_600x900.jpg', genre: 'Sandbox', year: 2011, developer: 'Re-Logic', publisher: 'Re-Logic' },
];

const STATUSES = ['not_started', 'playing', 'completed', 'dropped', 'paused'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const REVIEW_TEXTS = [
  "Chef-d'œuvre absolu, une expérience inoubliable.",
  "Très bon jeu, des heures de plaisir.",
  "Pas mal mais quelques bugs gâchent l'expérience.",
  "Jeu correct sans plus, je m'attendais à mieux.",
  "Incroyable ! Le meilleur jeu auquel j'ai joué cette année.",
  "Graphismes magnifiques, histoire captivante.",
  " addictif ! J'y joue tous les jours.",
  "Un peu déçu vu le prix, mais ça reste un bon jeu.",
  "Je le recommande à tous les fans du genre.",
  "Gameplay excellent, bande-son parfaite.",
];

const SUGGESTION_MESSAGES = [
  "Tu devrais essayer, je pense que ça te plairait !",
  "On pourrait y jouer ensemble si tu veux.",
  "J'ai adoré ce jeu, je suis sûr que tu aimeras aussi !",
  "Testé et approuvé !",
  "Il est dans mon top 3 cette année.",
];

async function seedDemoData() {
  console.log('[Seed] Vérification des données de démonstration...');
  const userCount = await db.getUserCount().catch(() => 0);
  if (userCount >= 3) { console.log('[Seed] Données utilisateurs déjà présentes, skip'); return; }

  console.log('[Seed] Création des utilisateurs de démonstration...');
  const userIds = [];
  for (const u of DEMO_USERS) {
    const hashed = await bcrypt.hash(u.password, 12);
    const existing = await db.getUserByUsername(u.username);
    if (existing) { userIds.push(existing.id); continue; }
    const id = await db.createUser(u.username, u.display_name, hashed, u.email);
    if (u.avatar_url) await db.supabaseAdmin.from('users').update({ avatar_url: u.avatar_url }).eq('id', id);
    // Booster point initial
    await db.supabaseAdmin.from('booster_points').upsert({ user_id: id, points: 3, claimed_first_login: true }, { onConflict: 'user_id' });
    userIds.push(id);
    console.log('[Seed] Utilisateur créé:', u.username, 'id:', id);
  }

  console.log('[Seed] Ajout des jeux aux bibliothèques...');
  for (const userId of userIds) {
    const shuffled = shuffle(GAMES_CATALOG);
    const userGames = shuffled.slice(0, 8 + Math.floor(Math.random() * 8));
    for (const g of userGames) {
      const status = pick(STATUSES);
      const playtime = status === 'completed' ? 20 + Math.floor(Math.random() * 280) : Math.floor(Math.random() * 60);
      const rating = status === 'not_started' ? 0 : 1 + Math.floor(Math.random() * 5);
      const hasReview = rating >= 4 && Math.random() > 0.5;
      const reviewText = hasReview ? pick(REVIEW_TEXTS) : '';
      await db.supabaseAdmin.from('games').upsert({
        user_id: userId, game_id: g.game_id, title: g.title, platform: g.platform,
        cover: g.cover, genre: g.genre, year: g.year, status, playtime,
        user_rating: rating, review_text: reviewText, review_public: hasReview, has_review: hasReview,
      }, { onConflict: 'user_id, game_id' });
      // Ensure in catalog
      await db.supabaseAdmin.from('catalog').upsert(g, { onConflict: 'game_id', ignoreDuplicates: true });
    }
    // Wishlist
    const wishGames = shuffle(GAMES_CATALOG).slice(0, 3);
    for (const g of wishGames) {
      await db.supabaseAdmin.from('wishlist').upsert({ user_id: userId, game_id: g.game_id }, { onConflict: 'user_id, game_id' });
    }
    // Top 3
    const topGames = userGames.filter(g => g.year >= 2020).slice(0, 3);
    for (let i = 0; i < topGames.length; i++) {
      await db.supabaseAdmin.from('top_three').upsert({ user_id: userId, game_id: topGames[i].game_id, position: i + 1 }, { onConflict: 'user_id, position' });
    }
    console.log('[Seed]', userGames.length, 'jeux + wishlist + top 3 pour userId', userId);
  }

  console.log('[Seed] Ajout des reviews communautaires...');
  for (const g of shuffle(GAMES_CATALOG).slice(0, 12)) {
    for (const userId of shuffle(userIds).slice(0, 1 + Math.floor(Math.random() * 3))) {
      await db.supabaseAdmin.from('community_reviews').upsert({
        user_id: userId, game_id: g.game_id, rating: 3 + Math.floor(Math.random() * 3),
        review_text: pick(REVIEW_TEXTS),
      }, { onConflict: 'user_id, game_id' });
    }
  }

  console.log('[Seed] Ajout des relations d\'amitié...');
  const friendPairs = [[0,1],[0,2],[1,3],[2,4],[3,4],[1,2]];
  for (const [i, j] of friendPairs) {
    await db.supabaseAdmin.from('friends').upsert({ user_id: userIds[i], friend_id: userIds[j], status: 'accepted' }, { onConflict: 'user_id, friend_id' });
    await db.supabaseAdmin.from('friends').upsert({ user_id: userIds[j], friend_id: userIds[i], status: 'accepted' }, { onConflict: 'user_id, friend_id' });
  }

  console.log('[Seed] Ajout des suggestions de jeux...');
  for (const [i, j] of friendPairs.slice(0, 4)) {
    const g = pick(GAMES_CATALOG);
    await db.supabaseAdmin.from('game_suggestions').insert({
      from_user_id: userIds[i], to_user_id: userIds[j],
      game_id: g.game_id, game_title: g.title, game_cover: g.cover,
      message: pick(SUGGESTION_MESSAGES),
    });
  }

  console.log('[Seed] Ajout des boosts communautaires...');
  const boostedGames = shuffle(GAMES_CATALOG).slice(0, 8);
  for (let idx = 0; idx < boostedGames.length; idx++) {
    const g = boostedGames[idx];
    const boostCount = 5 + Math.floor(Math.random() * 10);
    for (let b = 0; b < boostCount; b++) {
      const u = pick(userIds);
      await db.supabaseAdmin.from('game_boosts').insert({ user_id: u, game_id: g.game_id }).catch(() => {});
    }
    await db.supabaseAdmin.from('catalog').update({ description: 'Jeu en vedette' }).eq('game_id', g.game_id).catch(() => {});
  }

  console.log('[Seed] ✅ Données de démonstration prêtes !');
  console.log('[Seed] 💡 Comptes démo : alex92 / Alex1234 | sarah_g / Sarah1234 | max_rpg / Max1234 | lea_gg / Lea1234 | tom_pvp / Tom1234');
}

module.exports = { seedDemoData };