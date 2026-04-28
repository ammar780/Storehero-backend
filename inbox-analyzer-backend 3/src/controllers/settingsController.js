const db = require('../config/db');
const { testApiKey, formatFrom } = require('../services/emailit');

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

exports.get = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT emailit_api_key, emailit_from_email, emailit_from_name,
              emailit_reply_to, send_rate_per_minute, updated_at
       FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.json({
      hasApiKey: !!row.emailit_api_key,
      apiKeyMasked: maskKey(row.emailit_api_key),
      fromEmail: row.emailit_from_email || null,
      fromName: row.emailit_from_name || null,
      replyTo: row.emailit_reply_to || null,
      sendRatePerMinute: row.send_rate_per_minute || 30,
      updatedAt: row.updated_at || null,
    });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { apiKey, fromEmail, fromName, replyTo, sendRatePerMinute } = req.body;

    // Ensure the settings row exists (idempotent upsert)
    await db.query(
      `INSERT INTO user_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id]
    );

    const updates = [];
    const values = [];
    let i = 1;

    // Only update API key if provided and not the masked placeholder
    if (apiKey !== undefined && apiKey !== null && apiKey !== '' && !apiKey.includes('••••')) {
      updates.push(`emailit_api_key = $${i++}`);
      values.push(String(apiKey).trim().slice(0, 500));
    }
    if (fromEmail !== undefined) {
      updates.push(`emailit_from_email = $${i++}`);
      values.push(fromEmail ? String(fromEmail).trim().slice(0, 255) : null);
    }
    if (fromName !== undefined) {
      updates.push(`emailit_from_name = $${i++}`);
      values.push(fromName ? String(fromName).trim().slice(0, 255) : null);
    }
    if (replyTo !== undefined) {
      updates.push(`emailit_reply_to = $${i++}`);
      values.push(replyTo ? String(replyTo).trim().slice(0, 255) : null);
    }
    if (sendRatePerMinute !== undefined) {
      const n = parseInt(sendRatePerMinute, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= 120) {
        updates.push(`send_rate_per_minute = $${i++}`);
        values.push(n);
      }
    }
    updates.push(`updated_at = NOW()`);

    if (updates.length === 1) {
      return res.json({ ok: true, message: 'No changes' });
    }

    values.push(req.user.id);
    await db.query(
      `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = $${i}`,
      values
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.deleteApiKey = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE user_settings SET emailit_api_key = NULL, updated_at = NOW() WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.test = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT emailit_api_key, emailit_from_email, emailit_from_name
       FROM user_settings WHERE user_id = $1`,
      [req.user.id]
    );
    const row = r.rows[0];
    if (!row || !row.emailit_api_key) {
      return res.status(400).json({ ok: false, error: 'No API key configured. Save one first.' });
    }
    if (!row.emailit_from_email) {
      return res.status(400).json({ ok: false, error: 'No default From email configured. Save one first.' });
    }

    const testAddress = req.body.testAddress || row.emailit_from_email;
    const from = formatFrom(row.emailit_from_email, row.emailit_from_name);

    const result = await testApiKey({
      apiKey: row.emailit_api_key,
      from,
      testAddress,
    });

    if (result.ok) {
      return res.json({ ok: true, message: `Test email sent to ${testAddress}`, emailitId: result.id });
    }
    return res.status(400).json({ ok: false, error: result.error || 'Test failed' });
  } catch (err) { next(err); }
};
