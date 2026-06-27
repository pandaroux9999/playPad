const session = require('express-session');
const { supabaseAdmin } = require('./db');

// Fallback mémoire si la table sessions n'existe pas encore
const memoryStore = new Map();

class SupabaseSessionStore extends session.Store {
  get(sid, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    supabaseAdmin.from('sessions').select('session_data').eq('sid', sid).maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          const mem = memoryStore.get(sid);
          return cb(null, mem || null);
        }
        if (!data) return cb(null, null);
        try { cb(null, JSON.parse(data.session_data)); }
        catch (e) { cb(e); }
      })
      .catch(() => {
        const mem = memoryStore.get(sid);
        cb(null, mem || null);
      });
  }

  set(sid, session, callback) {
    memoryStore.set(sid, session);
    const cb = typeof callback === 'function' ? callback : () => {};
    const sessionData = { sid, session_data: JSON.stringify(session), expires: session.cookie?.expires || null };
    supabaseAdmin.from('sessions').upsert(sessionData, { onConflict: 'sid' })
      .then(({ error }) => {
        if (error) console.error('[SessionStore] Upsert error:', error.message);
        cb(null);
      })
      .catch((err) => {
        console.error('[SessionStore] Upsert error:', err.message);
        cb(null);
      });
  }

  destroy(sid, callback) {
    memoryStore.delete(sid);
    const cb = typeof callback === 'function' ? callback : () => {};
    supabaseAdmin.from('sessions').delete().eq('sid', sid)
      .then(({ error }) => cb(error || null))
      .catch(() => cb(null));
  }

  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }
}

module.exports = SupabaseSessionStore;