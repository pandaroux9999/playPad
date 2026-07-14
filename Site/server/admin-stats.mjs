import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nqjultxxseogwzaobvlp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ Définis SUPABASE_SERVICE_ROLE_KEY dans les variables d\'environnement');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const sep = '─'.repeat(50);

console.log(`\n${sep}`);
console.log('  STATISTIQUES PLAYPAD');
console.log(`${sep}\n`);

// 1. Stats générales
const tables = [
  { name: 'users',        label: 'Utilisateurs inscrits',   select: 'id',       count: 'exact' },
  { name: 'games',        label: 'Jeux dans les biblio.',   select: 'id',       count: 'exact' },
  { name: 'catalog',      label: 'Jeux au catalogue',       select: 'game_id',  count: 'exact' },
  { name: 'community_reviews', label: 'Critiques',          select: 'id',       count: 'exact' },
  { name: 'wishlist',     label: 'Souhaits',                 select: 'id',       count: 'exact' },
  { name: 'boosts',       label: 'Boosts (legacy)',          select: 'id',       count: 'exact' },
  { name: 'game_boosts',  label: 'Boosts (nouveau)',         select: 'id',       count: 'exact' },
  { name: 'messages',     label: 'Messages',                 select: 'id',       count: 'exact' },
  { name: 'friends',      label: 'Amitiés',                  select: 'id',       count: 'exact' },
  { name: 'sessions',     label: 'Sessions actives',         select: 'id',       count: 'exact' },
  { name: 'contact_messages', label: 'Messages contact',     select: 'id',       count: 'exact' },
  { name: 'news_cache',   label: 'Articles news',            select: 'id',       count: 'exact' },
];

const totals = {};
const results = await Promise.all(
  tables.map(t =>
    supabase.from(t.name).select(t.select, { count: t.count, head: true })
      .then(r => ({ name: t.name, label: t.label, count: r.count || 0 }))
      .catch(() => ({ name: t.name, label: t.label, count: '❌' }))
  )
);

const maxLabel = Math.max(...results.map(r => r.label.length));
const maxVal = Math.max(...results.filter(r => typeof r.count === 'number').map(r => r.count));

for (const r of results) {
  const bar = typeof r.count === 'number' && maxVal > 0
    ? '█'.repeat(Math.round((r.count / maxVal) * 30))
    : '';
  const val = typeof r.count === 'number'
    ? r.count.toLocaleString().padStart(7)
    : '  ' + r.count;
  console.log(`  ${r.label.padEnd(maxLabel)}  ${val}  ${bar}`);
}

console.log(`\n${sep}\n`);

// 2. Détails utilisateurs (10 plus actifs)
const { data: activeUsers } = await supabase
  .from('users')
  .select('id, username, display_name, email, created_at, last_seen, boost_points')
  .order('created_at', { ascending: false })
  .limit(10);

if (activeUsers) {
  console.log('  DERNIERS INSCRITS (10 derniers)\n');
  for (const u of activeUsers) {
    const date = new Date(u.created_at).toLocaleDateString('fr-FR');
    const last = u.last_seen ? new Date(u.last_seen).toLocaleDateString('fr-FR') : 'jamais';
    console.log(`  ${u.username.padEnd(15)}  inscrit: ${date}  vu: ${last}  boosts: ${u.boost_points || 0}`);
  }
}

console.log(`\n${sep}\n`);

// 3. Top 10 jeux boostés
const { data: topBoosted } = await supabase
  .from('game_boosts')
  .select('game_id, week_start');
const boostCounts = {};
if (topBoosted) {
  for (const b of topBoosted) {
    boostCounts[b.game_id] = (boostCounts[b.game_id] || 0) + 1;
  }
  const sorted = Object.entries(boostCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('  TOP 10 JEUX BOOSTÉS\n');
  for (const [gameId, count] of sorted) {
    const { data: game } = await supabase.from('catalog').select('title').eq('game_id', gameId).maybeSingle();
    console.log(`  ${count.toString().padStart(3)}  ${(game?.title || gameId).substring(0, 50)}`);
  }
}

console.log(`\n${sep}\n`);

// 4. Base de données : taille estimée
console.log('  INFOS TECHNIQUES');
console.log(`  Node.js:     ${process.version}`);
console.log(`  Date:        ${new Date().toLocaleString('fr-FR')}`);

console.log(`\n${sep}\n`);
