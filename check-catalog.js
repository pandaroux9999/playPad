const {createClient} = require('@supabase/supabase-js');
const ws = require('ws');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {realtime: {transport: ws}});
(async () => {
  let t = 0, z = 0, i = 0;
  while (true) {
    const {data} = await sb.from('catalog').select('year').range(i, i + 999);
    if (!data || data.length === 0) break;
    for (const g of data) { if (g.year > 0) t++; else z++; }
    if (data.length < 1000) break;
    i += 1000;
  }
  console.log('year>0:', t, 'year=0:', z);
  process.exit(0);
})();
