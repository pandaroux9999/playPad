const https = require('https');

const SUPABASE_URL = 'nqjultxxseogwzaobvlp';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('❌ Exporte SUPABASE_SERVICE_ROLE_KEY dans l\'environnement');
  console.error('   export SUPABASE_SERVICE_ROLE_KEY=ta_cle_service_role');
  process.exit(1);
}

function fetchSupabase(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: SUPABASE_URL + '.supabase.co',
      path: '/rest/v1/' + path,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Accept': 'application/json'
      }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function countQuery(table, column) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: SUPABASE_URL + '.supabase.co',
      path: `/rest/v1/${table}?select=${column}&head=true`,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Accept': 'application/json',
        'Prefer': 'count=exact'
      }
    };
    https.get(opts, res => {
      let data = '';
      const count = parseInt(res.headers['content-range']?.split('/')[1] || '0', 10);
      res.on('data', c => data += c);
      res.on('end', () => resolve(isNaN(count) ? 0 : count));
    }).on('error', () => resolve(0));
  });
}

(async () => {
  const sep = '='.repeat(55);
  console.log(`\n${sep}`);
  console.log('   STATISTIQUES PLAYPAD');
  console.log(`   ${new Date().toLocaleString('fr-FR')}`);
  console.log(`${sep}\n`);

  // 1. Compteurs
  const tables = [
    ['users', 'Utilisateurs inscrits'],
    ['games', 'Jeux dans les bibliothèques'],
    ['catalog', 'Jeux au catalogue'],
    ['community_reviews', 'Critiques'],
    ['wishlist', 'Souhaits'],
    ['boosts', 'Boosts (legacy)'],
    ['game_boosts', 'Boosts (nouveau)'],
    ['messages', 'Messages privés'],
    ['friends', 'Amitiés'],
    ['sessions', 'Sessions'],
    ['contact_messages', 'Messages contact'],
    ['news_cache', 'Articles news'],
  ];

  const results = await Promise.all(
    tables.map(([t, label]) =>
      countQuery(t, t === 'catalog' ? 'game_id' : 'id')
        .then(c => ({ label, count: c }))
    )
  );

  const maxLabel = Math.max(...results.map(r => r.label.length));
  const maxVal = Math.max(...results.map(r => r.count), 1);

  for (const r of results) {
    const bar = '█'.repeat(Math.round((r.count / maxVal) * 30));
    console.log(`  ${r.label.padEnd(maxLabel)}  ${String(r.count).padStart(7)}  ${bar}`);
  }

  // 2. Derniers inscrits
  console.log(`\n${sep}`);
  console.log('\n  DERNIERS INSCRITS\n');
  try {
    const users = await fetchSupabase('users?select=username,display_name,email,created_at,last_seen&order=created_at.desc&limit=10');
    for (const u of users) {
      const d = new Date(u.created_at).toLocaleDateString('fr-FR');
      const v = u.last_seen ? new Date(u.last_seen).toLocaleDateString('fr-FR') : 'jamais';
      console.log(`  ${(u.username || '?').padEnd(18)} inscrit: ${d}  vu: ${v}  email: ${u.email || '-'}`);
    }
  } catch (e) { console.log('  ❌ ' + e.message); }

  // 3. Top jeux boostés
  console.log(`\n${sep}`);
  console.log('\n  TOP 10 JEUX BOOSTÉS\n');
  try {
    const boosts = await fetchSupabase('game_boosts?select=game_id,week_start&limit=5000');
    const counts = {};
    for (const b of boosts) counts[b.game_id] = (counts[b.game_id] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [gid, cnt] of top) {
      let title = gid;
      try {
        const g = await fetchSupabase(`catalog?select=title&game_id=eq.${encodeURIComponent(gid)}&limit=1`);
        if (g.length > 0) title = g[0].title;
      } catch (e) {}
      console.log(`  ${String(cnt).padStart(3)}  ${title.substring(0, 55)}`);
    }
  } catch (e) { console.log('  ❌ ' + e.message); }

  // 4. Répartition plateformes
  console.log(`\n${sep}`);
  console.log('\n  RÉPARTITION PLATEFORMES (catalog)\n');
  try {
    const games = await fetchSupabase('catalog?select=platform&limit=5000');
    const plat = {};
    for (const g of games) {
      const p = g.platform || 'unknown';
      plat[p] = (plat[p] || 0) + 1;
    }
    const sorted = Object.entries(plat).sort((a, b) => b[1] - a[1]);
    const maxP = Math.max(...sorted.map(([,c]) => c), 1);
    for (const [p, c] of sorted) {
      const bar = '█'.repeat(Math.round((c / maxP) * 25));
      console.log(`  ${p.padEnd(12)} ${String(c).padStart(6)}  ${bar}`);
    }
  } catch (e) { console.log('  ❌ ' + e.message); }

  console.log(`\n${sep}`);
  console.log(`   Node: ${process.version}`);
  console.log(`${sep}\n`);
})();
