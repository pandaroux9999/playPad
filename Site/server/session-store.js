const session = require('express-session');
const { supabaseAdmin } = require('./db');

// Fallback mémoire si la table sessions n'existe pas encore
const memoryStore = new Map();

class SupabaseSessionStore extends session.Store {
  get(sid, callback) {
    supabaseAdmin.from('sessions').select('session_data').eq('sid', sid).maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          // La table n'existe pas → fallback mémoire
          const mem = memoryStore.get(sid);
          return callback(null, mem || null);
        }
        if (!data) return callback(null, null);
        try { callback(null, JSON.parse(data.session_data)); }
        catch (e) { callback(e); }
      })
      .catch(() => {
        const mem = memoryStore.get(sid);
        callback(null, mem || null);
      });
  }

  set(sid, session, callback) {
    // Toujours sauvegarder en mémoire (fallback)
    memoryStore.set(sid, session);

    const sessionData = { sid, session_data: JSON.stringify(session), expires: session.cookie?.expires || null };
    supabaseAdmin.from('sessions').upsert(sessionData, { onConflict: 'sid' })
      .then(({ error }) => {
        if (error) console.error('[SessionStore] Upsert error:', error.message);
        callback(null);
      })
      .catch((err) => {
        console.error('[SessionStore] Upsert error:', err.message);
        callback(null);
      });
  }

  destroy(sid, callback) {
    memoryStore.delete(sid);
    supabaseAdmin.from('sessions').delete().eq('sid', sid)
      .then(({ error }) => callback(error || null))
      .catch(() => callback(null));
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }
}

module.exports = SupabaseSessionStore;