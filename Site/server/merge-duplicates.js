// Usage : SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node server/merge-duplicates.js
const { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Met les vars d\'env SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log('=== Fusion des doublons du catalogue ===\n');

  const { data: catalog, error } = await supabase.from('catalog').select('*');
  if (error) { console.error('Erreur catalog:', error.message); process.exit(1); }
  console.log(`Catalogue : ${catalog.length} entrées\n`);

  // Grouper par titre normalisé
  const groups = new Map();
  for (const g of catalog) {
    const key = g.title.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }

  const tables = [
    'games', 'wishlist', 'top_three', 'community_reviews',
    'game_suggestions', 'boosts', 'game_boosts'
  ];
  let merged = 0, deleted = 0;

  for (const [title, entries] of groups) {
    if (entries.length < 2) continue;

    // Garder l'entrée la plus riche
    entries.sort((a, b) =>
      ((b.description ? 2 : 0) + (b.developer ? 1 : 0) + (b.publisher ? 1 : 0) + (b.cover ? 1 : 0)) -
      ((a.description ? 2 : 0) + (a.developer ? 1 : 0) + (a.publisher ? 1 : 0) + (a.cover ? 1 : 0))
    );
    const keep = entries[0];
    const dups = entries.slice(1);

    for (const dup of dups) {
      // Rediriger les références des autres tables
      for (const table of tables) {
        const { data: refs } = await supabase.from(table).select('*').eq('game_id', dup.game_id);
        if (!refs || refs.length === 0) continue;

        for (const ref of refs) {
          if (table === 'games' || table === 'wishlist' || table === 'community_reviews' || table === 'boosts' || table === 'game_boosts') {
            // Vérifier si une entrée avec le keep.game_id existe déjà pour ce user
            let checkQuery = supabase.from(table).select('id').eq('game_id', keep.game_id).eq('user_id', ref.user_id);
            if (table === 'game_boosts') checkQuery = checkQuery.eq('week_start', ref.week_start);
            const { data: existing } = await checkQuery.maybeSingle();
            if (existing) {
              await supabase.from(table).delete().eq('id', ref.id);
            } else {
              await supabase.from(table).update({ game_id: keep.game_id }).eq('id', ref.id);
            }
          } else if (table === 'top_three') {
            const { data: existing } = await supabase.from(table).select('id').eq('game_id', keep.game_id).eq('user_id', ref.user_id).eq('position', ref.position).maybeSingle();
            if (existing) await supabase.from(table).delete().eq('id', ref.id);
            else await supabase.from(table).update({ game_id: keep.game_id }).eq('id', ref.id);
          } else if (table === 'game_suggestions') {
            await supabase.from(table).update({ game_id: keep.game_id }).eq('id', ref.id);
          }
        }
      }

      // Fusionner les métadonnées
      const upd = {};
      if (!keep.cover && dup.cover) upd.cover = dup.cover;
      if (!keep.description && dup.description) upd.description = dup.description;
      if (!keep.developer && dup.developer) upd.developer = dup.developer;
      if (!keep.publisher && dup.publisher) upd.publisher = dup.publisher;
      if (!keep.genre && dup.genre) upd.genre = dup.genre;
      if (!keep.year && dup.year) upd.year = dup.year;
      if (Object.keys(upd).length > 0) await supabase.from('catalog').update(upd).eq('game_id', keep.game_id);

      // Supprimer le doublon
      await supabase.from('catalog').delete().eq('game_id', dup.game_id);
      deleted++;
    }
    merged++;
    console.log(`  "${title}" → ${keep.game_id} (${dups.length} supprimée${dups.length > 1 ? 's' : ''})`);
  }

  console.log(`\n=== Terminé : ${merged} groupe${merged > 1 ? 's' : ''} fusionné${merged > 1 ? 's' : ''}, ${deleted} entrée${deleted > 1 ? 's' : ''} supprimée${deleted > 1 ? 's' : ''} ===`);
}

run().catch(console.error);