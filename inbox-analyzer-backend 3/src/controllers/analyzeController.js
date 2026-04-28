const db = require('../config/db');
const { analyzeEmail } = require('../services/analyzer');

exports.analyzeTemplate = async (req, res, next) => {
  try {
    const { subject, html, campaignLabel } = req.body;
    // Accept empty subject (the analyzer will flag it as an issue)
    if (subject !== undefined && subject !== null && typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject must be a string' });
    }
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: 'HTML template is required' });
    }
    if (html.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'HTML too large (max 4MB)' });
    }

    const cleanSubject = (subject || '').slice(0, 500);
    const cleanLabel = campaignLabel ? String(campaignLabel).slice(0, 200) : null;

    const result = await analyzeEmail({ html, subject: cleanSubject, sender: null });

    // Persist
    const ins = await db.query(
      `INSERT INTO analyses
        (user_id, mode, campaign_label, subject, html_template, sender_email, sender_name,
         primary_score, promotions_score, spam_score, template_quality,
         sender_quality, combined_score, result_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, created_at`,
      [
        req.user.id, 'template', cleanLabel,
        cleanSubject, html, null, null,
        result.probabilities.primary, result.probabilities.promotions, result.probabilities.spam,
        result.templateQuality, null, null,
        JSON.stringify(result),
      ]
    );

    res.json({ id: ins.rows[0].id, created_at: ins.rows[0].created_at, ...result });
  } catch (err) { next(err); }
};

exports.analyzeFull = async (req, res, next) => {
  try {
    const { subject, html, senderEmail, senderName, campaignLabel } = req.body;
    if (subject !== undefined && subject !== null && typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject must be a string' });
    }
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: 'HTML template is required' });
    }
    if (!senderEmail || typeof senderEmail !== 'string') {
      return res.status(400).json({ error: 'Sender email is required for full analysis' });
    }
    if (html.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'HTML too large (max 4MB)' });
    }

    const cleanSubject = (subject || '').slice(0, 500);
    const cleanLabel = campaignLabel ? String(campaignLabel).slice(0, 200) : null;
    const cleanSenderEmail = String(senderEmail).trim().slice(0, 254);
    const cleanSenderName = senderName ? String(senderName).trim().slice(0, 100) : null;

    const result = await analyzeEmail({
      html, subject: cleanSubject,
      sender: { email: cleanSenderEmail, name: cleanSenderName },
    });

    const ins = await db.query(
      `INSERT INTO analyses
        (user_id, mode, campaign_label, subject, html_template, sender_email, sender_name,
         primary_score, promotions_score, spam_score, template_quality,
         sender_quality, combined_score, result_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, created_at`,
      [
        req.user.id, 'full', cleanLabel,
        cleanSubject, html, cleanSenderEmail, cleanSenderName,
        result.probabilities.primary, result.probabilities.promotions, result.probabilities.spam,
        result.templateQuality, result.senderQuality, result.combinedScore,
        JSON.stringify(result),
      ]
    );

    res.json({ id: ins.rows[0].id, created_at: ins.rows[0].created_at, ...result });
  } catch (err) { next(err); }
};
