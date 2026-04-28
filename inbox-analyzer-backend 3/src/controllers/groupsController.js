const db = require('../config/db');

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

exports.list = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT tg.id, tg.name, tg.description, tg.created_at, tg.updated_at,
              COUNT(ge.id)::int AS email_count
       FROM test_groups tg
       LEFT JOIN group_emails ge ON ge.group_id = tg.id
       WHERE tg.user_id = $1
       GROUP BY tg.id
       ORDER BY tg.created_at DESC`,
      [req.user.id]
    );
    res.json({ groups: r.rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const r = await db.query(
      `INSERT INTO test_groups (user_id, name, description)
       VALUES ($1, $2, $3) RETURNING id, name, description, created_at, updated_at`,
      [req.user.id, String(name).trim().slice(0, 255), description ? String(description).slice(0, 1000) : null]
    );
    res.status(201).json({ group: { ...r.rows[0], email_count: 0 } });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const { name, description } = req.body;
    const updates = ['updated_at = NOW()'];
    const values = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(String(name).trim().slice(0, 255)); }
    if (description !== undefined) { updates.push(`description = $${i++}`); values.push(description ? String(description).slice(0, 1000) : null); }
    values.push(id, req.user.id);
    const r = await db.query(
      `UPDATE test_groups SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ group: r.rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await db.query(`DELETE FROM test_groups WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.detail = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const gRes = await db.query(
      `SELECT id, name, description, created_at, updated_at
       FROM test_groups WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (gRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    const eRes = await db.query(
      `SELECT id, email, first_name, last_name, notes, created_at
       FROM group_emails WHERE group_id = $1 ORDER BY email ASC`,
      [id]
    );
    res.json({ group: gRes.rows[0], emails: eRes.rows });
  } catch (err) { next(err); }
};

/**
 * Bulk add emails. Accepts one of:
 *  - emails: [{ email, first_name?, last_name?, notes? }]
 *  - text: one per line, or "email,first,last" CSV format
 */
exports.addEmails = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const ownCheck = await db.query(
      `SELECT id FROM test_groups WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (ownCheck.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    let records = [];
    if (Array.isArray(req.body.emails)) {
      records = req.body.emails.map(e => ({
        email: String(e.email || '').trim().toLowerCase(),
        first_name: e.first_name ? String(e.first_name).trim().slice(0, 100) : null,
        last_name: e.last_name ? String(e.last_name).trim().slice(0, 100) : null,
        notes: e.notes ? String(e.notes).slice(0, 500) : null,
      }));
    } else if (typeof req.body.text === 'string') {
      const lines = req.body.text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        // support CSV: email, first, last, notes
        const parts = line.split(/[,;\t]/).map(p => p.trim());
        const email = parts[0].toLowerCase();
        records.push({
          email,
          first_name: parts[1] || null,
          last_name: parts[2] || null,
          notes: parts[3] ? parts.slice(3).join(', ') : null,
        });
      }
    } else {
      return res.status(400).json({ error: 'Provide either "emails" array or "text" string' });
    }

    // Validate + dedupe
    const valid = [];
    const invalid = [];
    const seen = new Set();
    let dupesInBatch = 0;
    for (const r of records) {
      if (!isValidEmail(r.email)) { invalid.push(r.email || '(empty)'); continue; }
      if (seen.has(r.email)) { dupesInBatch += 1; continue; }
      seen.add(r.email);
      valid.push(r);
    }

    if (valid.length === 0 && dupesInBatch === 0) {
      return res.status(400).json({ error: 'No valid emails found', invalid });
    }

    // Bulk insert with ON CONFLICT ignoring duplicates
    let inserted = 0;
    let dupesInDb = 0;
    for (const r of valid) {
      try {
        const ins = await db.query(
          `INSERT INTO group_emails (group_id, email, first_name, last_name, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (group_id, email) DO NOTHING
           RETURNING id`,
          [id, r.email, r.first_name, r.last_name, r.notes]
        );
        if (ins.rowCount > 0) inserted += 1;
        else dupesInDb += 1;
      } catch { /* skip */ }
    }

    await db.query(`UPDATE test_groups SET updated_at = NOW() WHERE id = $1`, [id]);

    res.json({
      ok: true,
      inserted,
      skipped_duplicates: dupesInBatch + dupesInDb,
      invalid_count: invalid.length,
      invalid_samples: invalid.slice(0, 10),
    });
  } catch (err) { next(err); }
};

exports.removeEmail = async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const emailId = parseInt(req.params.emailId, 10);
    if (Number.isNaN(groupId) || Number.isNaN(emailId)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const ownCheck = await db.query(
      `SELECT id FROM test_groups WHERE id = $1 AND user_id = $2`,
      [groupId, req.user.id]
    );
    if (ownCheck.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    await db.query(
      `DELETE FROM group_emails WHERE id = $1 AND group_id = $2`,
      [emailId, groupId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.clearEmails = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const ownCheck = await db.query(
      `SELECT id FROM test_groups WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (ownCheck.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    await db.query(`DELETE FROM group_emails WHERE group_id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
};
