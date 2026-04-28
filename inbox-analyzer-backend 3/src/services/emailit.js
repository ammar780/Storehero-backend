// EmailIt API v2 client
// Docs: https://emailit.com/docs/api-reference/endpoints/

const EMAILIT_ENDPOINT = process.env.EMAILIT_ENDPOINT || 'https://api.emailit.com/v2/emails';

/**
 * Send one email via EmailIt.
 * @param {object} opts
 * @param {string} opts.apiKey - EmailIt API key
 * @param {string} opts.from - "Name <email>" or just "email"
 * @param {string|string[]} opts.to - recipient email(s)
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.replyTo]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, id?: string, status?: string, error?: string, httpStatus?: number}>}
 */
async function sendEmail({ apiKey, from, to, subject, html, replyTo, timeoutMs = 15000 }) {
  if (!apiKey) return { ok: false, error: 'Missing EmailIt API key' };
  if (!from)   return { ok: false, error: 'Missing from address' };
  if (!to)     return { ok: false, error: 'Missing to address' };
  if (!subject) subject = '(no subject)';
  if (!html)   html = '';

  const body = { from, to, subject, html };
  if (replyTo) body.reply_to = replyTo;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(EMAILIT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    let data = null;
    try { data = await res.json(); } catch { /* not json */ }

    if (!res.ok) {
      const errMsg = (data && (data.message || data.error || data.detail)) || `HTTP ${res.status}`;
      return { ok: false, error: errMsg, httpStatus: res.status };
    }

    return {
      ok: true,
      id: data?.id || data?.data?.id || null,
      status: data?.status || data?.data?.status || 'sent',
      httpStatus: res.status,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { ok: false, error: `Request timed out after ${timeoutMs}ms` };
    return { ok: false, error: err.message || 'Network error' };
  }
}

/**
 * Test an API key by sending a no-op request (we actually just send a test email to the sender itself).
 * Takes from address for the test.
 */
async function testApiKey({ apiKey, from, testAddress }) {
  if (!apiKey) return { ok: false, error: 'No API key provided' };
  if (!from) return { ok: false, error: 'No from address provided' };
  const to = testAddress || from.replace(/^.*<|>.*$/g, '').trim();

  return await sendEmail({
    apiKey,
    from,
    to,
    subject: 'TVS Analyzer — API test',
    html: '<p>This is a test message from the TVS Inbox Analyzer. If you received this, your EmailIt API key is configured correctly.</p>',
    timeoutMs: 10000,
  });
}

function formatFrom(email, name) {
  if (!email) return '';
  if (name && name.trim()) return `${name.trim()} <${email.trim()}>`;
  return email.trim();
}

/** Simple {{first_name}} token replacement. */
function applyMergeTags(text, recipient) {
  if (!text || !recipient) return text;
  return text
    .replace(/\{\{\s*first[_ ]?name\s*\}\}/gi, recipient.first_name || 'there')
    .replace(/\{\{\s*last[_ ]?name\s*\}\}/gi, recipient.last_name || '')
    .replace(/\{\{\s*email\s*\}\}/gi, recipient.email || '')
    .replace(/\{\{\s*name\s*\}\}/gi, recipient.first_name || 'there');
}

module.exports = { sendEmail, testApiKey, formatFrom, applyMergeTags, EMAILIT_ENDPOINT };
