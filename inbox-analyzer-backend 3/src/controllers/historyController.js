const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await db.query(
      `SELECT id, mode, campaign_label, subject, sender_email, sender_name,
              primary_score, promotions_score, spam_score, template_quality,
              sender_quality, combined_score, created_at
       FROM analyses
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ analyses: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
};

exports.detail = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const result = await db.query(
      `SELECT id, mode, campaign_label, subject, html_template, sender_email, sender_name,
              primary_score, promotions_score, spam_score, template_quality,
              sender_quality, combined_score, result_json, created_at
       FROM analyses
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await db.query('DELETE FROM analyses WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
};
