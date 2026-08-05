/**
 * plugins-hub.js — self-contained "Custom Plugins" engine for TVS Finance Minister.
 *
 * INSTALL (2 lines): drop this file next to src/index.js, then in index.js — AFTER
 * `app`, `pool`, and your auth middleware (`auth`) are defined — add:
 *
 *     const pluginsHub = require('./plugins-hub');
 *     pluginsHub.mount(app, pool, auth);
 *
 * It creates its own table (custom_plugins) and adds routes under /api/plugins.
 * It does NOT touch anything else in your backend. Uses axios (already a dependency).
 */
const axios = require('axios');
const TABLE = 'custom_plugins';

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id           SERIAL PRIMARY KEY,
    slug         TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    icon         TEXT DEFAULT '🔌',
    url          TEXT NOT NULL,
    api_key      TEXT,
    is_connected BOOLEAN DEFAULT false,
    last_error   TEXT,
    last_tested  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )`);
}

async function callPlugin(url, key, path) {
  try {
    const r = await axios.get(clean(url) + path, {
      headers: key ? { 'x-hub-key': key } : {},
      timeout: 12000,
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.code === 'ECONNABORTED' ? 'Timed out' : (e.message || 'Request failed') };
  }
}

function mount(app, pool, auth) {
  const ready = ensureTable(pool).catch((e) => console.error('[plugins-hub] table error:', e.message));
  const guard = typeof auth === 'function' ? auth : (req, res, next) => next();
  const get = async (slug) => (await pool.query(`SELECT * FROM ${TABLE} WHERE slug=$1`, [slug])).rows[0];

  // List all connected plugins (never returns the raw key)
  app.get('/api/plugins', guard, async (req, res) => {
    try {
      await ready;
      const rows = (await pool.query(
        `SELECT slug,name,icon,url,(api_key IS NOT NULL AND api_key<>'') AS has_key,is_connected,last_error,last_tested
         FROM ${TABLE} ORDER BY name`
      )).rows;
      res.json({ plugins: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add / update a plugin (keyed by slug)
  app.post('/api/plugins', guard, async (req, res) => {
    try {
      await ready;
      let { slug, name, icon, url, api_key } = req.body || {};
      name = (name || '').trim();
      slug = slugify(slug || name);
      url = clean(url);
      if (!slug || !name || !url) return res.status(400).json({ error: 'name and url are required' });
      const existing = await get(slug);
      const keyToSave = (api_key && String(api_key).trim()) ? String(api_key).trim() : (existing ? existing.api_key : null);
      await pool.query(
        `INSERT INTO ${TABLE}(slug,name,icon,url,api_key) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(slug) DO UPDATE SET name=$2, icon=$3, url=$4, api_key=COALESCE($5, ${TABLE}.api_key)`,
        [slug, name, icon || '🔌', url, keyToSave]
      );
      res.json({ ok: true, slug });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/plugins/:slug', guard, async (req, res) => {
    try { await ready; await pool.query(`DELETE FROM ${TABLE} WHERE slug=$1`, [req.params.slug]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Live connection test (health, falling back to stats)
  app.post('/api/plugins/:slug/test', guard, async (req, res) => {
    try {
      await ready;
      const p = await get(req.params.slug);
      if (!p) return res.status(404).json({ error: 'Unknown plugin' });
      let r = await callPlugin(p.url, p.api_key, '/api/hub/health');
      if (!r.ok) r = await callPlugin(p.url, p.api_key, '/api/hub/stats');
      const connected = r.ok;
      await pool.query(`UPDATE ${TABLE} SET is_connected=$1,last_error=$2,last_tested=NOW() WHERE slug=$3`,
        [connected, connected ? null : (r.error || 'No response'), p.slug]);
      res.json({ connected, error: connected ? null : (r.error || 'No response') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Proxy a single plugin's stats (server-to-server, so no browser CORS issues)
  app.get('/api/plugins/:slug/stats', guard, async (req, res) => {
    try {
      await ready;
      const p = await get(req.params.slug);
      if (!p) return res.status(404).json({ error: 'Unknown plugin' });
      const range = req.query.range || '30d';
      const r = await callPlugin(p.url, p.api_key, '/api/hub/stats?range=' + encodeURIComponent(range));
      if (!r.ok) return res.status(502).json({ error: r.error || 'Plugin did not respond', connected: false });
      res.json({ ...r.data, connected: true, name: p.name, icon: p.icon, slug: p.slug });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/plugins/:slug/audit', guard, async (req, res) => {
    try {
      await ready;
      const p = await get(req.params.slug);
      if (!p) return res.status(404).json({ error: 'Unknown plugin' });
      const r = await callPlugin(p.url, p.api_key, '/api/hub/audit');
      if (!r.ok) return res.status(502).json({ error: r.error || 'No response' });
      res.json(r.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Everything at once — powers the collective "All Plugins" page
  app.get('/api/plugins/overview', guard, async (req, res) => {
    try {
      await ready;
      const range = req.query.range || '30d';
      const plugins = (await pool.query(`SELECT * FROM ${TABLE} ORDER BY name`)).rows;
      const out = await Promise.all(plugins.map(async (p) => {
        const r = await callPlugin(p.url, p.api_key, '/api/hub/stats?range=' + encodeURIComponent(range));
        if (!r.ok) return { slug: p.slug, name: p.name, icon: p.icon, connected: false, error: r.error || 'No response' };
        const d = r.data || {};
        return { slug: p.slug, name: p.name, icon: p.icon, connected: true,
          kpis: d.kpis || [], series: d.series || [], breakdowns: d.breakdowns || [], metrics: d.metrics || {} };
      }));
      res.json({ range, plugins: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('[plugins-hub] mounted at /api/plugins');
}

module.exports = { mount };
