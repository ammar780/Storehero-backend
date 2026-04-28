const db = require('../config/db');

const MAX_BULK_SCHEDULE = 100;

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

function parseScheduledAt(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Schedule ONE send for later. */
exports.scheduleOne = async (req, res, next) => {
  try {
    const {
      groupId, campaignLabel, subject, html,
      fromEmail, fromName, replyTo, scheduledAt,
    } = req.body;

    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject is required' });
    }
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: 'HTML template is required' });
    }
    if (html.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'HTML too large (max 4MB)' });
    }

    const when = parseScheduledAt(scheduledAt);
    if (!when) return res.status(400).json({ error: 'Invalid scheduledAt. Use ISO 8601 (e.g. 2026-05-01T14:00:00Z).' });
    if (when.getTime() < Date.now() - 30 * 1000) {
      return res.status(400).json({ error: 'Scheduled time must be in the future.' });
    }

    // Resolve defaults from settings
    const sRes = await db.query(
      `SELECT emailit_api_key, emailit_from_email, emailit_from_name, emailit_reply_to
       FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    const settings = sRes.rows[0] || {};
    if (!settings.emailit_api_key) {
      return res.status(400).json({ error: 'EmailIt API key is not configured. Save it in Settings first.' });
    }
    const finalFromEmail = (fromEmail || settings.emailit_from_email || '').trim();
    if (!finalFromEmail || !isValidEmail(finalFromEmail)) {
      return res.status(400).json({ error: 'A valid From email is required.' });
    }
    const finalFromName = (fromName !== undefined ? fromName : settings.emailit_from_name) || null;
    const finalReplyTo  = (replyTo !== undefined ? replyTo : settings.emailit_reply_to) || null;

    // Validate group
    const gid = parseInt(groupId, 10);
    if (Number.isNaN(gid)) return res.status(400).json({ error: 'Valid groupId is required' });
    const gCheck = await db.query(
      `SELECT id, name FROM test_groups WHERE id = $1 AND user_id = $2`,
      [gid, req.user.id]
    );
    if (gCheck.rowCount === 0) return res.status(404).json({ error: 'Group not found' });

    const ins = await db.query(
      `INSERT INTO scheduled_sends
         (user_id, group_id, campaign_label, subject, html_template,
          from_email, from_name, reply_to, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled')
       RETURNING id, scheduled_at`,
      [
        req.user.id, gid,
        campaignLabel ? String(campaignLabel).slice(0, 200) : null,
        String(subject).slice(0, 500),
        html,
        finalFromEmail,
        finalFromName ? String(finalFromName).slice(0, 255) : null,
        finalReplyTo ? String(finalReplyTo).slice(0, 255) : null,
        when.toISOString(),
      ]
    );

    res.status(201).json({
      ok: true,
      id: ins.rows[0].id,
      scheduledAt: ins.rows[0].scheduled_at,
    });
  } catch (err) { next(err); }
};

/**
 * Bulk schedule: array of items, each like the single-schedule payload.
 * Returns created[], failed[] with per-item status.
 */
exports.scheduleBulk = async (req, res, next) => {
  try {
    const { items, defaults } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] array is required' });
    }
    if (items.length > MAX_BULK_SCHEDULE) {
      return res.status(400).json({ error: `Too many items (max ${MAX_BULK_SCHEDULE})` });
    }

    const sRes = await db.query(
      `SELECT emailit_api_key, emailit_from_email, emailit_from_name, emailit_reply_to
       FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    const settings = sRes.rows[0] || {};
    if (!settings.emailit_api_key) {
      return res.status(400).json({ error: 'EmailIt API key is not configured.' });
    }

    // Validate all groups upfront
    const groupsCache = {};
    const getGroup = async (gid) => {
      if (groupsCache[gid] !== undefined) return groupsCache[gid];
      const r = await db.query(
        `SELECT id, name FROM test_groups WHERE id = $1 AND user_id = $2`,
        [gid, req.user.id]
      );
      groupsCache[gid] = r.rows[0] || null;
      return groupsCache[gid];
    };

    const d = defaults || {};
    const defaultFromEmail = d.fromEmail || settings.emailit_from_email;
    const defaultFromName  = d.fromName !== undefined ? d.fromName : settings.emailit_from_name;
    const defaultReplyTo   = d.replyTo !== undefined ? d.replyTo : settings.emailit_reply_to;
    const defaultGroupId   = d.groupId ? parseInt(d.groupId, 10) : null;

    const created = [];
    const failed = [];

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i] || {};
      try {
        const subject = String(it.subject || '').trim();
        const html = String(it.html || '');
        const when = parseScheduledAt(it.scheduledAt);
        const gid = it.groupId ? parseInt(it.groupId, 10) : defaultGroupId;

        if (!subject)        { failed.push({ index: i, error: 'subject required' }); continue; }
        if (!html)           { failed.push({ index: i, error: 'html required' }); continue; }
        if (html.length > 4 * 1024 * 1024) { failed.push({ index: i, error: 'html too large' }); continue; }
        if (!when)           { failed.push({ index: i, error: 'invalid scheduledAt' }); continue; }
        if (when.getTime() < Date.now() - 30 * 1000) { failed.push({ index: i, error: 'scheduledAt in the past' }); continue; }
        if (!gid || Number.isNaN(gid)) { failed.push({ index: i, error: 'groupId required' }); continue; }

        const group = await getGroup(gid);
        if (!group) { failed.push({ index: i, error: 'group not found' }); continue; }

        const fromEmail = (it.fromEmail || defaultFromEmail || '').trim();
        if (!fromEmail || !isValidEmail(fromEmail)) { failed.push({ index: i, error: 'invalid fromEmail' }); continue; }
        const fromName = it.fromName !== undefined ? it.fromName : defaultFromName;
        const replyTo  = it.replyTo  !== undefined ? it.replyTo  : defaultReplyTo;

        const ins = await db.query(
          `INSERT INTO scheduled_sends
             (user_id, group_id, campaign_label, subject, html_template,
              from_email, from_name, reply_to, scheduled_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled')
           RETURNING id, scheduled_at`,
          [
            req.user.id, gid,
            it.campaignLabel ? String(it.campaignLabel).slice(0, 200) : null,
            subject.slice(0, 500),
            html,
            fromEmail,
            fromName ? String(fromName).slice(0, 255) : null,
            replyTo ? String(replyTo).slice(0, 255) : null,
            when.toISOString(),
          ]
        );
        created.push({ index: i, id: ins.rows[0].id, scheduledAt: ins.rows[0].scheduled_at, subject });
      } catch (err) {
        failed.push({ index: i, error: err.message || 'Unknown error' });
      }
    }

    res.status(201).json({
      ok: true,
      createdCount: created.length,
      failedCount: failed.length,
      created,
      failed,
    });
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const args = [req.user.id];
    let where = 'ss.user_id = $1';
    if (status) { args.push(status); where += ` AND ss.status = $2`; }
    const r = await db.query(
      `SELECT ss.id, ss.group_id, ss.campaign_label, ss.subject,
              ss.from_email, ss.from_name, ss.reply_to,
              ss.scheduled_at, ss.status, ss.send_job_id, ss.error_message,
              ss.fired_at, ss.created_at,
              tg.name AS group_name,
              (SELECT COUNT(*)::int FROM group_emails ge WHERE ge.group_id = ss.group_id) AS group_email_count
       FROM scheduled_sends ss
       LEFT JOIN test_groups tg ON tg.id = ss.group_id
       WHERE ${where}
       ORDER BY ss.scheduled_at ASC`,
      args
    );
    res.json({ scheduled: r.rows });
  } catch (err) { next(err); }
};

exports.detail = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await db.query(
      `SELECT ss.*, tg.name AS group_name,
              (SELECT COUNT(*)::int FROM group_emails ge WHERE ge.group_id = ss.group_id) AS group_email_count
       FROM scheduled_sends ss
       LEFT JOIN test_groups tg ON tg.id = ss.group_id
       WHERE ss.id = $1 AND ss.user_id = $2`,
      [id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ scheduled: r.rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const check = await db.query(
      `SELECT status FROM scheduled_sends WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (check.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].status !== 'scheduled') {
      return res.status(400).json({ error: `Cannot edit a ${check.rows[0].status} scheduled send` });
    }

    const updates = [];
    const values = [];
    let i = 1;
    const { subject, html, fromEmail, fromName, replyTo, campaignLabel, scheduledAt, groupId } = req.body;

    if (subject !== undefined)       { updates.push(`subject = $${i++}`);        values.push(String(subject).slice(0, 500)); }
    if (html !== undefined)          { updates.push(`html_template = $${i++}`);  values.push(html); }
    if (fromEmail !== undefined)     { updates.push(`from_email = $${i++}`);     values.push(String(fromEmail).trim()); }
    if (fromName !== undefined)      { updates.push(`from_name = $${i++}`);      values.push(fromName ? String(fromName).slice(0, 255) : null); }
    if (replyTo !== undefined)       { updates.push(`reply_to = $${i++}`);       values.push(replyTo ? String(replyTo).slice(0, 255) : null); }
    if (campaignLabel !== undefined) { updates.push(`campaign_label = $${i++}`); values.push(campaignLabel ? String(campaignLabel).slice(0, 200) : null); }
    if (scheduledAt !== undefined) {
      const when = parseScheduledAt(scheduledAt);
      if (!when) return res.status(400).json({ error: 'Invalid scheduledAt' });
      if (when.getTime() < Date.now() - 30 * 1000) return res.status(400).json({ error: 'scheduledAt must be in the future' });
      updates.push(`scheduled_at = $${i++}`);
      values.push(when.toISOString());
    }
    if (groupId !== undefined) {
      const gid = parseInt(groupId, 10);
      if (Number.isNaN(gid)) return res.status(400).json({ error: 'Invalid groupId' });
      const gc = await db.query(`SELECT id FROM test_groups WHERE id = $1 AND user_id = $2`, [gid, req.user.id]);
      if (gc.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
      updates.push(`group_id = $${i++}`);
      values.push(gid);
    }

    if (updates.length === 0) return res.json({ ok: true, message: 'No changes' });

    values.push(id, req.user.id);
    await db.query(
      `UPDATE scheduled_sends SET ${updates.join(', ')}
       WHERE id = $${i++} AND user_id = $${i}`,
      values
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.cancel = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await db.query(
      `UPDATE scheduled_sends SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status = 'scheduled'
       RETURNING id`,
      [id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(400).json({ error: 'Cannot cancel (not scheduled or not found)' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await db.query(
      `DELETE FROM scheduled_sends WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};
