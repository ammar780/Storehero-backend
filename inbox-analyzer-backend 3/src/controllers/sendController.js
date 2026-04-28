const db = require('../config/db');
const { startJob } = require('../services/sender');

const MAX_RECIPIENTS = 1000; // safety cap

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

exports.start = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const {
      groupId,
      recipients, // optional ad-hoc array: [{email, first_name?, last_name?}]
      subject,
      html,
      fromEmail,
      fromName,
      replyTo,
      campaignLabel,
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

    // Resolve settings defaults
    const settingsRes = await client.query(
      `SELECT emailit_api_key, emailit_from_email, emailit_from_name, emailit_reply_to
       FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    const settings = settingsRes.rows[0] || {};
    if (!settings.emailit_api_key) {
      return res.status(400).json({ error: 'EmailIt API key is not configured. Save it in Settings first.' });
    }

    const finalFromEmail = (fromEmail || settings.emailit_from_email || '').trim();
    if (!finalFromEmail || !isValidEmail(finalFromEmail)) {
      return res.status(400).json({ error: 'A valid From email is required (set default in Settings or pass fromEmail)' });
    }
    const finalFromName = (fromName !== undefined ? fromName : settings.emailit_from_name) || null;
    const finalReplyTo  = (replyTo  !== undefined ? replyTo  : settings.emailit_reply_to)  || null;

    // Resolve recipients — from group OR inline list
    let recs = [];
    let resolvedGroupId = null;

    if (groupId) {
      const gid = parseInt(groupId, 10);
      if (Number.isNaN(gid)) return res.status(400).json({ error: 'Invalid groupId' });
      const ownCheck = await client.query(
        `SELECT id FROM test_groups WHERE id = $1 AND user_id = $2`,
        [gid, req.user.id]
      );
      if (ownCheck.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
      resolvedGroupId = gid;
      const r = await client.query(
        `SELECT email, first_name, last_name FROM group_emails WHERE group_id = $1`,
        [gid]
      );
      recs = r.rows;
    } else if (Array.isArray(recipients) && recipients.length > 0) {
      recs = recipients
        .map(r => ({
          email: String(r.email || '').trim().toLowerCase(),
          first_name: r.first_name ? String(r.first_name).trim().slice(0, 100) : null,
          last_name: r.last_name ? String(r.last_name).trim().slice(0, 100) : null,
        }))
        .filter(r => isValidEmail(r.email));
    } else {
      return res.status(400).json({ error: 'Provide either groupId or recipients[]' });
    }

    if (recs.length === 0) return res.status(400).json({ error: 'No valid recipients' });
    if (recs.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS} per send)` });
    }

    // Create job + recipients atomically
    await client.query('BEGIN');
    const jobRes = await client.query(
      `INSERT INTO send_jobs
         (user_id, group_id, campaign_label, subject, html_template,
          from_email, from_name, reply_to, status, total_recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
       RETURNING *`,
      [
        req.user.id, resolvedGroupId,
        campaignLabel ? String(campaignLabel).slice(0, 200) : null,
        String(subject).slice(0, 500),
        html,
        finalFromEmail,
        finalFromName ? String(finalFromName).slice(0, 255) : null,
        finalReplyTo ? String(finalReplyTo).slice(0, 255) : null,
        recs.length,
      ]
    );
    const job = jobRes.rows[0];

    // Batch-insert recipients
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const r of recs) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(job.id, r.email, r.first_name, r.last_name);
    }
    await client.query(
      `INSERT INTO send_recipients (job_id, email, first_name, last_name)
       VALUES ${placeholders.join(', ')}`,
      values
    );
    await client.query('COMMIT');

    // Kick off background send
    startJob(job.id);

    res.status(201).json({
      ok: true,
      jobId: job.id,
      totalRecipients: recs.length,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    next(err);
  } finally {
    client.release();
  }
};

exports.listJobs = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const r = await db.query(
      `SELECT sj.id, sj.group_id, sj.campaign_label, sj.subject, sj.from_email, sj.from_name,
              sj.status, sj.total_recipients, sj.sent_count, sj.failed_count,
              sj.error_message, sj.started_at, sj.completed_at, sj.created_at,
              tg.name AS group_name
       FROM send_jobs sj
       LEFT JOIN test_groups tg ON tg.id = sj.group_id
       WHERE sj.user_id = $1
       ORDER BY sj.created_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ jobs: r.rows });
  } catch (err) { next(err); }
};

exports.jobDetail = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const jRes = await db.query(
      `SELECT sj.*, tg.name AS group_name
       FROM send_jobs sj
       LEFT JOIN test_groups tg ON tg.id = sj.group_id
       WHERE sj.id = $1 AND sj.user_id = $2`,
      [id, req.user.id]
    );
    if (jRes.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const job = jRes.rows[0];

    // Only send HTML if explicitly asked — keep progress responses small
    if (!req.query.includeHtml) {
      delete job.html_template;
    }

    // Summary stats for recipients
    const rRes = await db.query(
      `SELECT status, COUNT(*)::int AS count
       FROM send_recipients WHERE job_id = $1 GROUP BY status`,
      [id]
    );
    const stats = { pending: 0, sent: 0, failed: 0 };
    for (const row of rRes.rows) stats[row.status] = row.count;

    res.json({ job, stats });
  } catch (err) { next(err); }
};

exports.jobRecipients = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    const status = req.query.status || null;

    const own = await db.query(
      `SELECT id FROM send_jobs WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (own.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    const args = [id];
    let where = 'job_id = $1';
    if (status) { args.push(status); where += ` AND status = $2`; }
    args.push(limit);

    const r = await db.query(
      `SELECT id, email, first_name, last_name, status, emailit_id,
              error_message, sent_at
       FROM send_recipients
       WHERE ${where}
       ORDER BY id ASC
       LIMIT $${args.length}`,
      args
    );
    res.json({ recipients: r.rows });
  } catch (err) { next(err); }
};

exports.cancelJob = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await db.query(
      `UPDATE send_jobs
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'running')
       RETURNING id`,
      [id, req.user.id]
    );
    if (r.rowCount === 0) return res.status(400).json({ error: 'Cannot cancel (not found or already finished)' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
