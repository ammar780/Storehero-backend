// Background sender — processes send_jobs with per-job rate limiting.
// Runs in-process; for single-instance deployments this is fine. For
// multi-instance, add a SELECT … FOR UPDATE SKIP LOCKED guard.

const db = require('../config/db');
const { sendEmail, formatFrom, applyMergeTags } = require('./emailit');

const activeJobs = new Set();

async function getUserSettings(userId) {
  const r = await db.query(
    `SELECT emailit_api_key, send_rate_per_minute FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function markJobStatus(jobId, status, extra = {}) {
  const sets = ['status = $1'];
  const vals = [status];
  let i = 2;
  if (status === 'running' && !extra.started_at) {
    sets.push(`started_at = NOW()`);
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    sets.push(`completed_at = NOW()`);
  }
  if (extra.error_message) {
    sets.push(`error_message = $${i++}`);
    vals.push(extra.error_message);
  }
  vals.push(jobId);
  await db.query(`UPDATE send_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function incrementJobCounter(jobId, column) {
  await db.query(`UPDATE send_jobs SET ${column} = ${column} + 1 WHERE id = $1`, [jobId]);
}

async function updateRecipient(recipientId, status, extra = {}) {
  const sets = ['status = $1'];
  const vals = [status];
  let i = 2;
  if (status === 'sent') {
    sets.push(`sent_at = NOW()`);
    if (extra.emailit_id) { sets.push(`emailit_id = $${i++}`); vals.push(extra.emailit_id); }
  }
  if (extra.error_message) {
    sets.push(`error_message = $${i++}`);
    vals.push(String(extra.error_message).slice(0, 500));
  }
  vals.push(recipientId);
  await db.query(`UPDATE send_recipients SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

/**
 * Process a single job: fetch pending recipients, send one-by-one with delay.
 */
async function processJob(jobId) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  try {
    const jobRes = await db.query(`SELECT * FROM send_jobs WHERE id = $1`, [jobId]);
    const job = jobRes.rows[0];
    if (!job) return;

    const settings = await getUserSettings(job.user_id);
    if (!settings || !settings.emailit_api_key) {
      await markJobStatus(jobId, 'failed', { error_message: 'EmailIt API key not configured' });
      return;
    }

    const ratePerMin = Math.max(1, Math.min(120, settings.send_rate_per_minute || 30));
    const delayMs = Math.ceil(60000 / ratePerMin);

    await markJobStatus(jobId, 'running');

    const from = formatFrom(job.from_email, job.from_name);

    let keepGoing = true;
    while (keepGoing) {
      // Check for cancellation each loop
      const statusCheck = await db.query(`SELECT status FROM send_jobs WHERE id = $1`, [jobId]);
      if (!statusCheck.rows[0] || statusCheck.rows[0].status === 'cancelled') {
        await markJobStatus(jobId, 'cancelled');
        return;
      }

      // Pull one pending recipient at a time (FIFO)
      const r = await db.query(
        `SELECT id, email, first_name, last_name FROM send_recipients
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY id ASC LIMIT 1`,
        [jobId]
      );
      if (r.rowCount === 0) { keepGoing = false; break; }

      const rec = r.rows[0];

      // Merge tags on subject and html
      const subject = applyMergeTags(job.subject, rec);
      const html    = applyMergeTags(job.html_template, rec);

      const result = await sendEmail({
        apiKey: settings.emailit_api_key,
        from,
        to: rec.email,
        subject,
        html,
        replyTo: job.reply_to || null,
        timeoutMs: 20000,
      });

      if (result.ok) {
        await updateRecipient(rec.id, 'sent', { emailit_id: result.id });
        await incrementJobCounter(jobId, 'sent_count');
      } else {
        await updateRecipient(rec.id, 'failed', { error_message: result.error });
        await incrementJobCounter(jobId, 'failed_count');
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    await markJobStatus(jobId, 'completed');
  } catch (err) {
    console.error('Sender job crashed:', err);
    await markJobStatus(jobId, 'failed', { error_message: err.message || 'Unknown error' });
  } finally {
    activeJobs.delete(jobId);
  }
}

/** Resume any jobs that were running when the process restarted. */
async function resumePendingJobs() {
  try {
    const r = await db.query(
      `SELECT id FROM send_jobs WHERE status IN ('pending', 'running') ORDER BY id ASC`
    );
    for (const row of r.rows) {
      // Fire-and-forget
      setImmediate(() => processJob(row.id));
    }
    if (r.rowCount > 0) console.log(`✓ Resumed ${r.rowCount} pending send job(s)`);
  } catch (err) {
    console.error('Failed to resume jobs:', err);
  }
}

function startJob(jobId) {
  setImmediate(() => processJob(jobId));
}

module.exports = { startJob, processJob, resumePendingJobs };
