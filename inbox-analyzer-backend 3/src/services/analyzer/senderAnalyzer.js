const dns = require('dns').promises;
const { FREE_EMAIL_PROVIDERS } = require('./wordLists');

// Use Cloudflare + Google DNS for reliability (Railway containers sometimes have flaky default resolvers)
try { dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4']); } catch { /* ignore */ }

// 50+ DKIM selectors covering Mailchimp, SendGrid, Klaviyo, Mailgun, Postmark, AWS SES,
// ConvertKit, Constant Contact, ActiveCampaign, HubSpot, Iterable, Drip, Customer.io,
// MailerLite, Brevo (Sendinblue), Salesforce Marketing Cloud, Microsoft 365, Google Workspace, etc.
const DKIM_SELECTORS = [
  // Generic
  'default', 'dkim', 'mail', 'email', 'k1', 'k2', 'k3', 's1', 's2', 's3', 'selector1', 'selector2',
  // Microsoft / Google
  'google', 'selector1-azurecomm-net', 'sig1',
  // Mailchimp / Mandrill
  'mandrill', 'k1', 'k2', 'k3',
  // SendGrid
  's1', 's2', 'm1', 'sm', 'sendgrid',
  // Klaviyo
  'dkim', 'k1', 'klaviyo',
  // Mailgun
  'mta', 'mailo', 'pic', 'mg', 'pf2014', 'k1',
  // Postmark
  'pm', '20210112',
  // AWS SES
  'amazonses',
  // Brevo / Sendinblue
  'mail', 'sib',
  // ConvertKit
  'convertkit-mail2', 'cv', 'convertkit',
  // ActiveCampaign
  'dk', 'activecampaign',
  // HubSpot
  'hs1-' , 'hs2-', 'hubspot',
  // Constant Contact
  'cc', 'cc1', 'constantcontact',
  // Customer.io
  'cio1', 'cio2', 'customerio',
  // MailerLite / MailerSend
  'ml', 'mlsend',
  // Drip
  'dripemail2', 'dripemail',
  // Iterable
  'iterable1', 'iterable2',
  // Salesforce Marketing Cloud / ExactTarget
  'et', 'exacttarget', '200520',
  // Misc
  'mxvault', 'krs', 'fdik', 'protonmail', 'protonmail2', 'protonmail3', 'zoho', 'zohomail',
];

/** Wrap a promise with a per-call timeout — DNS queries can hang on slow resolvers. */
function withTimeout(p, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    p.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(fallback);
    });
  });
}

function extractDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

async function checkSPF(domain) {
  try {
    const records = await withTimeout(dns.resolveTxt(domain), 4000, null);
    if (!records) return { found: false, value: null, policy: null };
    const flat = records.map(r => r.join('').toLowerCase());
    const spf = flat.find(r => r.startsWith('v=spf1'));
    if (!spf) return { found: false, value: null, policy: null };
    let policy = 'neutral';
    if (spf.includes('-all')) policy = 'strict';
    else if (spf.includes('~all')) policy = 'soft';
    else if (spf.includes('?all')) policy = 'neutral';
    else if (spf.includes('+all')) policy = 'permissive';
    return { found: true, value: spf, policy };
  } catch {
    return { found: false, value: null, policy: null };
  }
}

async function checkDMARC(domain) {
  try {
    const records = await withTimeout(dns.resolveTxt(`_dmarc.${domain}`), 4000, null);
    if (!records) return { found: false, value: null, policy: null };
    const flat = records.map(r => r.join('').toLowerCase());
    const dmarc = flat.find(r => r.startsWith('v=dmarc1'));
    if (!dmarc) return { found: false, value: null, policy: null };
    let policy = 'none';
    const m = dmarc.match(/p=(none|quarantine|reject)/);
    if (m) policy = m[1];
    return { found: true, value: dmarc, policy };
  } catch {
    return { found: false, value: null, policy: null };
  }
}

async function checkMX(domain) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), 4000, null);
    if (!records) return { found: false, count: 0, records: [] };
    return { found: records.length > 0, count: records.length, records };
  } catch {
    return { found: false, count: 0, records: [] };
  }
}

async function checkBIMI(domain) {
  try {
    const records = await withTimeout(dns.resolveTxt(`default._bimi.${domain}`), 4000, null);
    if (!records) return { found: false, value: null };
    const flat = records.map(r => r.join('').toLowerCase());
    const bimi = flat.find(r => r.startsWith('v=bmi1'));
    return { found: !!bimi, value: bimi || null };
  } catch {
    return { found: false, value: null };
  }
}

/**
 * Probe many DKIM selectors in parallel — much faster than sequential.
 * Returns the first valid DKIM record found.
 */
async function checkDKIM(domain) {
  // De-duplicate the selector list
  const uniqueSelectors = [...new Set(DKIM_SELECTORS)];

  const probes = uniqueSelectors.map(async (sel) => {
    try {
      const records = await withTimeout(
        dns.resolveTxt(`${sel}._domainkey.${domain}`),
        3500,
        null
      );
      if (!records) return null;
      const flat = records.map(r => r.join('').toLowerCase());
      const dkim = flat.find(r => r.includes('v=dkim1') || r.includes('k=rsa') || r.includes('p='));
      return dkim ? { selector: sel, value: dkim } : null;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(probes);
  const found = results.find(r => r !== null);
  return found
    ? { found: true, selector: found.selector, value: found.value }
    : { found: false, selector: null, value: null };
}

async function analyzeSender(email, name) {
  const result = {
    email: email || null,
    name: name || null,
    domain: null,
    valid: false,
    isFreeProvider: false,
    spf: { found: false },
    dmarc: { found: false },
    dkim: { found: false },
    mx: { found: false },
    bimi: { found: false },
    issues: [],
    positives: [],
    quality: 0,
  };

  if (!email || !isValidEmail(email)) {
    result.issues.push('Invalid sender email format.');
    return result;
  }
  result.valid = true;

  const domain = extractDomain(email);
  result.domain = domain;

  if (FREE_EMAIL_PROVIDERS.includes(domain)) {
    result.isFreeProvider = true;
    result.issues.push(
      `Sending from a free provider domain (${domain}) is heavily penalised. ` +
      `Bulk mail "from" gmail.com / yahoo.com / etc. fails their own DMARC. ` +
      `Use a branded domain like @thevitaminshots.com.`
    );
  }

  // Run all DNS lookups in parallel with a global 15s timeout safety
  const dnsPromise = Promise.all([
    checkSPF(domain),
    checkDMARC(domain),
    checkMX(domain),
    checkBIMI(domain),
    checkDKIM(domain),
  ]);
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), 15000));

  try {
    const [spf, dmarc, mx, bimi, dkim] = await Promise.race([dnsPromise, timeout]);
    result.spf = spf;
    result.dmarc = dmarc;
    result.mx = mx;
    result.bimi = bimi;
    result.dkim = dkim;
  } catch (err) {
    result.issues.push('DNS lookup timed out — domain may not exist or DNS is slow.');
  }

  if (result.mx.found) result.positives.push(`MX records configured (${result.mx.count}).`);
  else result.issues.push('No MX records found — domain cannot receive mail.');

  if (result.spf.found) {
    result.positives.push(`SPF record present (policy: ${result.spf.policy}).`);
    if (result.spf.policy === 'permissive') result.issues.push('SPF policy is +all (permissive) — risky.');
  } else {
    result.issues.push('No SPF record — Gmail / Yahoo will mark mail as suspicious.');
  }

  if (result.dmarc.found) {
    result.positives.push(`DMARC record present (policy: ${result.dmarc.policy}).`);
    if (result.dmarc.policy === 'none') {
      result.issues.push('DMARC policy is "none" — set p=quarantine or p=reject for stronger protection.');
    }
  } else {
    result.issues.push('No DMARC record — required for bulk sending to Gmail & Yahoo since Feb 2024.');
  }

  if (result.dkim.found) {
    result.positives.push(`DKIM key found (selector: ${result.dkim.selector}).`);
  } else {
    result.issues.push('No DKIM key found at any common selector — confirm your ESP\'s DKIM is published.');
  }

  if (result.bimi.found) result.positives.push('BIMI record found — your logo can show in Gmail.');

  // Quality score 0-100
  let q = 0;
  if (result.mx.found)    q += 15;
  if (result.spf.found)   q += 20;
  if (result.spf.policy === 'strict') q += 5;
  else if (result.spf.policy === 'soft') q += 3;
  if (result.dkim.found)  q += 25;
  if (result.dmarc.found) q += 20;
  if (result.dmarc.policy === 'reject')     q += 8;
  else if (result.dmarc.policy === 'quarantine') q += 5;
  if (result.bimi.found)  q += 7;
  // Free provider is fatal for marketing — cap quality at 25
  if (result.isFreeProvider) q = Math.min(25, Math.max(0, q - 50));

  result.quality = Math.max(0, Math.min(100, q));

  return result;
}

module.exports = { analyzeSender, extractDomain, isValidEmail };
