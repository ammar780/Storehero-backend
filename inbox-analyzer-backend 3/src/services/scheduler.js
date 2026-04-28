// Scheduler service. Polls every 60 seconds for scheduled_sends whose
// scheduled_at <= NOW() and status = 'scheduled'. For each, creates a
// send_job with recipients snapshotted from the group at fire time, then
// kicks off the sender.

const db = require('../config/db');
const { startJob } = require('./sender');

const POLL_INTERVAL_MS = 60 * 1000;
let pollTimer = null;
let isRunning = false;

/**
 * Create a send_job + recipient rows for a due scheduled send, kick it off.
 */
async function fireScheduledSend(sched) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check status (guards against double-firing if two workers race)
    const recheck = await client.query(
      `SELECT status FROM scheduled_sends WHERE id = $1 FOR UPDATE`,
      [sched.id]
    );
    if (!recheck.rows[0] || recheck.rows[0].status !== 'scheduled') {
      await client.query('ROLLBACK');
      return;
    }

    // Mark as running
    await client.query(
      `UPDATE scheduled_sends SET status = 'running', fired_at = NOW() WHERE id = $1`,
      [sched.id]
    );

    // Snapshot recipients from the group at this moment
    if (!sched.group_id) {
      await client.query(
        `UPDATE scheduled_sends SET status = 'failed',
           error_message = 'Group was deleted before scheduled time'
         WHERE id = $1`,
        [sched.id]
      );
      await client.query('COMMIT');
      return;
    }

    const recRes = await client.query(
      `SELECT email, first_name, last_name FROM group_emails WHERE group_id = $1`,
      [sched.group_id]
    );
    const recipients = recRes.rows;

    if (recipients.length === 0) {
      await client.query(
        `UPDATE scheduled_sends SET status = 'failed',
           error_message = 'Group had no recipients at fire time'
         WHERE id = $1`,
        [sched.id]
      );
      await client.query('COMMIT');
      return;
    }

    // Create the send_job
    const jobRes = await client.query(
      `INSERT INTO send_jobs
         (user_id, group_id, campaign_label, subject, html_template,
          from_email, from_name, reply_to, status, total_recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
       RETURNING id`,
      [
        sched.user_id, sched.group_id, sched.campaign_label,
        sched.subject, sched.html_template,
        sched.from_email, sched.from_name, sched.reply_to,
        recipients.length,
      ]
    );
    const jobId = jobRes.rows[0].id;

    // Insert recipients
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const r of recipients) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(jobId, r.email, r.first_name, r.last_name);
    }
    await client.query(
      `INSERT INTO send_recipients (job_id, email, first_name, last_name)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    // Link the scheduled send to this job
    await client.query(
      `UPDATE scheduled_sends
       SET status = 'completed', send_job_id = $1
       WHERE id = $2`,
      [jobId, sched.id]
    );

    await client.query('COMMIT');

    // Fire the send_job in background
    startJob(jobId);

    console.log(`✓ Fired scheduled send #${sched.id} → job #${jobId} (${recipients.length} recipients)`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`✗ Fire scheduled send #${sched.id} failed:`, err);
    try {
      await db.query(
        `UPDATE scheduled_sends SET status = 'failed', error_message = $1 WHERE id = $2`,
        [String(err.message || 'Unknown error').slice(0, 500), sched.id]
      );
    } catch {}
  } finally {
    client.release();
  }
}

async function poll() {
  if (isRunning) return;
  isRunning = true;
  try {
    const r = await db.query(
      `SELECT id, user_id, group_id, campaign_label, subject, html_template,
              from_email, from_name, reply_to, scheduled_at
       FROM scheduled_sends
       WHERE status = 'scheduled' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 25`
    );
    for (const sched of r.rows) {
      await fireScheduledSend(sched);
    }
  } catch (err) {
    console.error('Scheduler poll error:', err);
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  if (pollTimer) return;
  console.log('✓ Scheduler started (polling every 60s)');
  // Run once on startup, then every minute
  poll().catch(() => {});
  pollTimer = setInterval(() => poll().catch(() => {}), POLL_INTERVAL_MS);
}

function stopScheduler() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

module.exports = { startScheduler, stopScheduler, poll };
