const cheerio = require('cheerio');
const {
  SPAM_WORDS_STRONG,
  PROMO_WORDS,
  PERSONAL_WORDS,
  TRANSACTIONAL_WORDS,
  SUSPICIOUS_TLDS,
  URL_SHORTENERS,
} = require('./wordLists');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Robust phrase matcher. Handles multi-word phrases and phrases with
 * special characters (e.g. "100% off"). Uses non-word boundaries on
 * the alphanumeric edges of each phrase only.
 */
function countOccurrences(text, phrases) {
  if (!text) return { total: 0, hits: [] };
  const lower = text.toLowerCase();
  let total = 0;
  const hits = [];
  for (const phrase of phrases) {
    const lc = phrase.toLowerCase();
    const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startBoundary = /^[a-z0-9]/.test(lc) ? '(?:^|[^a-z0-9])' : '';
    const endBoundary   = /[a-z0-9]$/.test(lc) ? '(?:[^a-z0-9]|$)' : '';
    let count = 0;
    try {
      const re = new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'gi');
      const matches = lower.match(re);
      count = matches ? matches.length : 0;
    } catch { count = 0; }
    if (count > 0) {
      total += count;
      hits.push({ word: phrase, count });
    }
  }
  return { total, hits };
}

/**
 * Uppercase ratio that ignores short tokens (acronyms like "NEW", "USA",
 * model numbers). Only flags when long words are written in caps.
 */
function uppercaseRatio(text) {
  if (!text) return 0;
  const longWords = text.match(/[A-Za-z]{5,}/g) || [];
  if (longWords.length === 0) return 0;
  const caps = longWords.filter(w => w === w.toUpperCase()).length;
  return caps / longWords.length;
}

function countEmojis(text) {
  if (!text) return 0;
  const re = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/gu;
  const m = text.match(re);
  return m ? m.length : 0;
}

/** Normalise a CSS colour string for comparison. */
function normColor(c) {
  if (!c) return '';
  let v = c.trim().toLowerCase().replace(/\s+/g, '');
  if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  const names = { white: '#ffffff', black: '#000000', red: '#ff0000', blue: '#0000ff' };
  return names[v] || v;
}

/**
 * Classify the email's overall type from its content. This drives different
 * compliance rules — a 1-on-1 personal email shouldn't be penalised for
 * missing an unsubscribe link, while a bulk marketing email must have one.
 *
 * Returns: 'transactional' | 'personal' | 'bulk_marketing' | 'unclear'
 */
function detectEmailType({ subject, html, $ }) {
  const subjectLc = (subject || '').toLowerCase();
  const text = $ ? $.root().text().toLowerCase() : '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Strong transactional patterns in subject
  const transactionalSubjectPatterns = [
    /\border\s*#/i, /\breceipt\b/i, /\binvoice\b/i,
    /\bconfirm/i, /\bshipped\b/i, /\bdelivered\b/i,
    /\btracking\b/i, /\bpayment\b/i,
    /password reset|reset your password/i,
    /\bverification code\b/i, /\bsecurity code\b/i,
    /\b2fa\b/i, /two-factor/i,
    /welcome to \w/i, /your account/i,
  ];
  const transactionalHits = transactionalSubjectPatterns.filter(p => p.test(subject)).length;

  // Transactional words in body
  const txHits = countOccurrences(text, TRANSACTIONAL_WORDS).total;

  // Marketing markers
  const images = $ ? $('img').length : 0;
  const links = $ ? $('a[href]').length : 0;
  const buttons = $ ? $('a[href][style*="background"], a[href][style*="padding:"], a.button, a.btn').length : 0;
  const hasUnsub = /\bunsubscribe\b|\bopt[\s-]?out\b|manage preferences|email preferences/i.test(text);

  // Strong transactional: transactional pattern + low images/links
  if ((transactionalHits >= 1 || txHits >= 2) && images <= 2 && links <= 4) {
    return 'transactional';
  }

  // Personal: short, low images, conversational, no unsub needed
  // Heuristic: word count 30-300, 0-1 images, 0-3 links, has personal greeting
  const hasGreeting = /\b(hi|hello|hey)\s+\w/i.test(text);
  const hasFirstPerson = /\b(i|i'm|i'll|i've|we're)\b/i.test(text);
  if (wordCount > 20 && wordCount < 350 && images <= 1 && links <= 3 && (hasGreeting || hasFirstPerson) && !hasUnsub) {
    return 'personal';
  }

  // Bulk marketing: has unsubscribe OR many images/links/buttons
  if (hasUnsub || images >= 3 || buttons >= 2 || links >= 5) {
    return 'bulk_marketing';
  }

  return 'unclear';
}

// ─────────────────────────────────────────────────────────────
// Subject analysis
// ─────────────────────────────────────────────────────────────

function analyzeSubject(rawSubject) {
  const subject = (rawSubject || '').trim();
  const out = {
    text: subject,
    length: subject.length,
    score: { primary: 0, promotions: 0, spam: 0 },
    issues: [],
    positives: [],
    details: {},
  };

  if (subject.length === 0) {
    out.issues.push('Subject line is empty.');
    out.score.spam += 25;
    return out;
  }

  const len = subject.length;
  out.details.length = len;
  if (len < 10) {
    out.issues.push('Subject is very short (<10 chars).');
    out.score.spam += 4;
  } else if (len > 70) {
    out.issues.push(`Subject is too long (${len} chars). Aim for 35–60.`);
    out.score.promotions += 5;
  } else if (len >= 30 && len <= 60) {
    out.positives.push('Subject length is in the sweet spot (30–60 chars).');
    out.score.primary += 5;
  }

  const upRatio = uppercaseRatio(subject);
  out.details.uppercaseRatio = Math.round(upRatio * 100);
  if (upRatio >= 0.6) {
    out.issues.push('Subject is mostly UPPERCASE — strong spam signal.');
    out.score.spam += 18;
  } else if (upRatio >= 0.35) {
    out.issues.push('Subject has high UPPERCASE word ratio.');
    out.score.spam += 8;
  }

  const exclam = (subject.match(/!/g) || []).length;
  out.details.exclamationCount = exclam;
  if (exclam >= 3) {
    out.issues.push(`Subject has ${exclam} exclamation marks. Use 0–1.`);
    out.score.spam += 14;
  } else if (exclam === 2) {
    out.score.spam += 5;
  }

  if (/!{2,}/.test(subject) || /\?{2,}/.test(subject)) {
    out.issues.push('Subject contains repeated punctuation (!! or ??).');
    out.score.spam += 8;
  }

  if (/[\$€£]/.test(subject)) {
    out.issues.push('Subject contains currency symbols.');
    out.score.promotions += 8;
    out.score.spam += 3;
  }
  if (/%/.test(subject)) {
    out.issues.push('Subject contains "%" — Promotions tab signal.');
    out.score.promotions += 10;
  }

  const emojis = countEmojis(subject);
  out.details.emojiCount = emojis;
  if (emojis >= 3) {
    out.issues.push(`Subject has ${emojis} emojis. Limit to 1.`);
    out.score.promotions += 8;
  } else if (emojis >= 1) {
    out.score.promotions += 3;
  }

  const strongHits = countOccurrences(subject, SPAM_WORDS_STRONG);
  if (strongHits.total > 0) {
    out.issues.push(`Subject has spam-trigger word(s): ${strongHits.hits.map(h => h.word).slice(0, 5).join(', ')}`);
    out.score.spam += Math.min(35, strongHits.total * 14);
    out.details.subjectSpamHits = strongHits.hits;
  }

  const promoHits = countOccurrences(subject, PROMO_WORDS);
  if (promoHits.total > 0) {
    out.score.promotions += Math.min(20, promoHits.total * 5);
    out.details.subjectPromoWords = promoHits.hits;
  }

  const personalHits = countOccurrences(subject, PERSONAL_WORDS);
  if (personalHits.total > 0) {
    out.score.primary += Math.min(15, personalHits.total * 5);
    out.positives.push('Subject uses conversational/personal language.');
  }

  if (/\?/.test(subject) && !/\?{2,}/.test(subject)) {
    out.score.primary += 6;
    out.positives.push('Subject is phrased as a question — conversational.');
  }

  if (/\{\{?\s*(first[_ ]?name|name|firstname)\s*\}?\}/i.test(subject) ||
      /%FIRSTNAME%|%FNAME%|\*\|FNAME\|\*/i.test(subject)) {
    out.score.primary += 8;
    out.positives.push('Subject uses personalisation token (first name).');
  }

  if (/^\s*(re|fwd|fw):\s/i.test(subject)) {
    out.issues.push('Subject starts with RE:/FWD: — deceptive if not a real reply.');
    out.score.spam += 12;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// HTML structure analysis
// ─────────────────────────────────────────────────────────────

function analyzeHTML(html) {
  const out = {
    score: { primary: 0, promotions: 0, spam: 0 },
    issues: [],
    positives: [],
    details: {},
  };

  if (!html || html.trim().length === 0) {
    out.issues.push('HTML body is empty.');
    out.score.spam += 35;
    return out;
  }

  const hasDoctype = /<!doctype/i.test(html);
  if (!hasDoctype) {
    out.issues.push('Missing <!DOCTYPE> declaration.');
    out.score.spam += 3;
  } else {
    out.positives.push('DOCTYPE present.');
  }

  let $;
  try {
    $ = cheerio.load(html, { decodeEntities: true });
  } catch (err) {
    out.issues.push('HTML failed to parse — likely broken markup.');
    out.score.spam += 20;
    return out;
  }

  const scripts = $('script').length;
  out.details.scriptTags = scripts;
  if (scripts > 0) {
    out.issues.push(`<script> tag(s) detected (${scripts}). Email clients strip JS — and filters flag it.`);
    out.score.spam += 28;
  }

  const forms = $('form').length;
  const iframes = $('iframe').length;
  const objects = $('object, embed, applet').length;
  if (forms)   { out.issues.push(`<form> tag(s) detected (${forms}).`);   out.score.spam += 15; }
  if (iframes) { out.issues.push(`<iframe> tag(s) detected (${iframes}).`); out.score.spam += 18; }
  if (objects) { out.issues.push(`<object>/<embed> detected.`); out.score.spam += 12; }
  if ($('meta[http-equiv="refresh"]').length) {
    out.issues.push('<meta refresh> detected — phishing signal.');
    out.score.spam += 22;
  }

  const externalCSS = $('link[rel="stylesheet"]').length;
  if (externalCSS) {
    out.issues.push(`External CSS detected (${externalCSS}). Use inline styles for email.`);
    out.score.spam += 5;
  }

  const styleBlocks = $('style').length;
  out.details.styleBlocks = styleBlocks;

  // Hidden text: only flag elements where text is genuinely invisible.
  let hiddenText = 0;
  $('*').each((_, el) => {
    const style = ($(el).attr('style') || '').toLowerCase();
    const text = $(el).text().trim();
    if (text.length === 0) return;

    let hidden = false;
    if (/display\s*:\s*none/.test(style))           hidden = true;
    if (/visibility\s*:\s*hidden/.test(style))      hidden = true;
    if (/font-size\s*:\s*0(?:\D|$)/.test(style))    hidden = true;
    if (/opacity\s*:\s*0(?:\.0+)?(?:\D|$)/.test(style)) hidden = true;
    if (/max-height\s*:\s*0(?:\D|$)/.test(style))   hidden = true;
    if (/line-height\s*:\s*0(?:\D|$)/.test(style))  hidden = true;

    if (!hidden) {
      const colorM = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
      const bgM = style.match(/background(?:-color)?\s*:\s*([^;]+)/);
      if (colorM && bgM) {
        const c1 = normColor(colorM[1]);
        const c2 = normColor(bgM[1]);
        if (c1 && c2 && c1 === c2) hidden = true;
      }
    }

    if (hidden) hiddenText += 1;
  });
  out.details.hiddenElements = hiddenText;
  if (hiddenText > 0) {
    out.issues.push(`${hiddenText} element(s) contain hidden text — strong spam signal.`);
    out.score.spam += Math.min(30, hiddenText * 10);
  }

  const tables = $('table').length;
  const divs = $('div').length;
  out.details.tableCount = tables;
  out.details.divCount = divs;
  if (tables === 0 && divs > 5) {
    out.issues.push('No <table>-based layout — Outlook & older clients render poorly.');
    out.score.spam += 3;
  }

  let multiColumn = 0;
  $('table').each((_, el) => {
    const cols = $(el).find('tr').first().find('td').length;
    if (cols >= 2) multiColumn += 1;
  });
  out.details.multiColumnTables = multiColumn;
  if (multiColumn >= 2) {
    out.score.promotions += 12;
    out.positives.push('Multi-column layout typical of newsletters/promos.');
  }

  let colouredBgs = 0;
  $('[bgcolor], [style*="background-color"], [style*="background:"]').each(() => { colouredBgs += 1; });
  if (colouredBgs >= 5) out.score.promotions += 8;

  let inlineHandlers = 0;
  $('*').each((_, el) => {
    for (const attr of Object.keys(el.attribs || {})) {
      if (attr.startsWith('on') && attr.length > 2) inlineHandlers += 1;
    }
  });
  if (inlineHandlers > 0) {
    out.issues.push(`Inline JS event handlers detected (${inlineHandlers}). Remove all on* attributes.`);
    out.score.spam += 15;
  }

  let dataUris = 0;
  $('img[src^="data:"]').each(() => { dataUris += 1; });
  if (dataUris > 0) {
    out.issues.push(`${dataUris} image(s) use base64 data URIs. Host images externally.`);
    out.score.spam += Math.min(8, dataUris * 2);
  }

  if ($('meta[charset], meta[http-equiv="Content-Type"]').length === 0) {
    // Minor — Gmail doesn't really penalize this, just a best-practice nudge
    out.details.missingCharset = true;
  }

  out.$ = $;
  return out;
}

// ─────────────────────────────────────────────────────────────
// Content analysis
// ─────────────────────────────────────────────────────────────

function analyzeContent(htmlResult) {
  const out = {
    score: { primary: 0, promotions: 0, spam: 0 },
    issues: [],
    positives: [],
    details: {},
  };
  const $ = htmlResult.$;
  if (!$) return out;

  $('script, style, noscript').remove();

  const visibleText = $('body').length ? $('body').text() : $.root().text();
  const text = visibleText.replace(/\s+/g, ' ').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  out.details.wordCount = wordCount;

  if (wordCount < 20) {
    out.issues.push(`Very low word count (${wordCount}). Image-only or tiny emails get filtered.`);
    out.score.spam += 18;
  } else if (wordCount > 800) {
    out.issues.push(`Very high word count (${wordCount}). Long emails skew toward Promotions.`);
    out.score.promotions += 6;
  }

  const sentences = text.split(/[.!?]/).filter(s => s.trim().length > 12);
  let allCapsSentences = 0;
  for (const s of sentences) if (uppercaseRatio(s) > 0.6) allCapsSentences += 1;
  if (allCapsSentences > 0) {
    out.issues.push(`${allCapsSentences} sentence(s) in ALL CAPS.`);
    out.score.spam += Math.min(15, allCapsSentences * 5);
  }

  const strongHits = countOccurrences(text, SPAM_WORDS_STRONG);
  if (strongHits.total > 0) {
    out.issues.push(`Body has spam-trigger word(s): ${strongHits.hits.slice(0, 6).map(h => h.word).join(', ')}${strongHits.hits.length > 6 ? '…' : ''}`);
    out.score.spam += Math.min(30, strongHits.total * 5);
    out.details.spamWordHits = strongHits.hits;
  }

  const promoHits = countOccurrences(text, PROMO_WORDS);
  if (promoHits.total > 0) {
    out.score.promotions += Math.min(35, promoHits.total * 2);
    out.details.promoWordHits = promoHits.hits.slice(0, 12);
  }

  const personalHits = countOccurrences(text, PERSONAL_WORDS);
  if (personalHits.total > 0) {
    out.score.primary += Math.min(15, personalHits.total * 2);
  }

  // Transactional words = strong Primary signal (receipts, order confirmations, etc.)
  const txHits = countOccurrences(text, TRANSACTIONAL_WORDS);
  if (txHits.total > 0) {
    out.score.primary += Math.min(25, txHits.total * 8);
    out.positives.push('Transactional language detected (receipt/confirmation pattern).');
    out.details.transactionalHits = txHits.hits;
  }

  const dollarCount = (text.match(/\$\d/g) || []).length;
  const percentCount = (text.match(/\d+\s*%/g) || []).length;
  if (dollarCount > 0) out.score.promotions += Math.min(12, dollarCount * 2);
  if (percentCount > 0) out.score.promotions += Math.min(15, percentCount * 3);
  out.details.priceMentions = dollarCount;
  out.details.percentMentions = percentCount;

  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks > 0 && questionMarks < 5) {
    out.score.primary += Math.min(8, questionMarks * 2);
  }

  const pronouns = (text.toLowerCase().match(/\b(you|your|we|i|me|my|us)\b/g) || []).length;
  if (wordCount > 0) {
    const ratio = pronouns / wordCount;
    out.details.pronounRatio = Math.round(ratio * 1000) / 10;
    if (ratio > 0.06) {
      out.score.primary += 8;
      out.positives.push('Strong personal pronoun usage — conversational.');
    } else if (ratio > 0.03) {
      out.score.primary += 4;
    }
  }

  const images = $('img').length;
  out.details.imageCount = images;
  if (images === 0 && wordCount > 30) {
    out.score.primary += 8;
    out.positives.push('No images — text-only emails skew toward Primary.');
  } else if (images > 0) {
    const ratio = wordCount / images;
    out.details.wordsPerImage = Math.round(ratio);
    if (ratio < 20) {
      out.issues.push(`Image-heavy: ${images} image(s) and only ${wordCount} words. Add more text.`);
      out.score.spam += 10;
      out.score.promotions += 8;
    } else if (ratio < 50) {
      out.score.promotions += 6;
    }
  }
  if (images > 8) {
    out.issues.push(`High image count (${images}). Typical newsletter pattern.`);
    out.score.promotions += 8;
  }

  let missingAlt = 0;
  $('img').each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined || alt === null || alt.trim() === '') missingAlt += 1;
  });
  if (missingAlt > 0 && images > 0) {
    out.issues.push(`${missingAlt} of ${images} image(s) missing alt text.`);
    out.score.spam += Math.min(10, missingAlt * 2);
  } else if (images > 0) {
    out.positives.push('All images have alt text.');
  }

  let imagesNoDim = 0;
  $('img').each((_, el) => {
    const w = $(el).attr('width');
    const h = $(el).attr('height');
    const style = $(el).attr('style') || '';
    if (!w && !h && !/width|height/i.test(style)) imagesNoDim += 1;
  });
  if (imagesNoDim > 0) {
    out.issues.push(`${imagesNoDim} image(s) missing width/height — causes layout shift in clients.`);
    out.score.spam += Math.min(5, imagesNoDim);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Links & CTAs
// ─────────────────────────────────────────────────────────────

function analyzeLinks(htmlResult) {
  const out = {
    score: { primary: 0, promotions: 0, spam: 0 },
    issues: [],
    positives: [],
    details: {},
  };
  const $ = htmlResult.$;
  if (!$) return out;

  const links = $('a[href]');
  const linkCount = links.length;
  out.details.linkCount = linkCount;

  if (linkCount === 0) {
    out.score.primary += 8;
    out.positives.push('No links — strong Primary signal (transactional feel).');
  } else if (linkCount === 1) {
    out.score.primary += 6;
    out.positives.push('Single link — clean transactional pattern.');
  } else if (linkCount > 15) {
    out.issues.push(`Very high link count (${linkCount}).`);
    out.score.promotions += 10;
    out.score.spam += 5;
  } else if (linkCount > 6) {
    out.score.promotions += 6;
  }

  let buttons = 0;
  links.each((_, el) => {
    const $a = $(el);
    const style = ($a.attr('style') || '').toLowerCase();
    const cls = ($a.attr('class') || '').toLowerCase();
    if (
      /background(-color)?\s*:/.test(style) ||
      /padding\s*:/.test(style) ||
      /\bbutton\b/.test(cls) ||
      /\bbtn\b/.test(cls)
    ) buttons += 1;
  });
  out.details.buttonCount = buttons;
  if (buttons > 3) {
    out.score.promotions += 8;
  } else if (buttons === 1) {
    out.score.primary += 4;
  }

  let shortenerCount = 0;
  let suspiciousTldCount = 0;
  let ipUrlCount = 0;
  let mismatchedAnchors = 0;
  let nonHttpsCount = 0;
  const domains = new Set();

  links.each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();
    const text = $a.text().trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    let url;
    try { url = new URL(href); } catch { return; }
    const host = url.hostname.toLowerCase();
    if (!host) return;
    domains.add(host);

    if (url.protocol === 'http:') nonHttpsCount += 1;
    if (URL_SHORTENERS.some(s => host === s || host.endsWith('.' + s))) shortenerCount += 1;
    if (SUSPICIOUS_TLDS.some(tld => host.endsWith(tld))) suspiciousTldCount += 1;
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) ipUrlCount += 1;

    if (/^https?:\/\//i.test(text)) {
      try {
        const displayUrl = new URL(text);
        if (displayUrl.hostname.toLowerCase() !== host) mismatchedAnchors += 1;
      } catch { /* ignore */ }
    }
  });

  out.details.uniqueDomains = domains.size;
  out.details.nonHttpsLinks = nonHttpsCount;
  if (shortenerCount > 0) {
    out.issues.push(`${shortenerCount} URL shortener link(s) — strong spam signal.`);
    out.score.spam += Math.min(25, shortenerCount * 8);
  }
  if (suspiciousTldCount > 0) {
    out.issues.push(`${suspiciousTldCount} link(s) on suspicious TLDs.`);
    out.score.spam += Math.min(20, suspiciousTldCount * 6);
  }
  if (ipUrlCount > 0) {
    out.issues.push(`${ipUrlCount} link(s) point to raw IP addresses.`);
    out.score.spam += Math.min(25, ipUrlCount * 12);
  }
  if (mismatchedAnchors > 0) {
    out.issues.push(`${mismatchedAnchors} link(s) display one URL but go to another.`);
    out.score.spam += Math.min(20, mismatchedAnchors * 8);
  }
  if (nonHttpsCount > 0 && linkCount > 0) {
    out.issues.push(`${nonHttpsCount} non-HTTPS link(s). Use https:// for all links.`);
    out.score.spam += Math.min(8, nonHttpsCount * 2);
  }
  if (domains.size > 6) {
    out.issues.push(`Links span ${domains.size} different domains. Stick to 1–3.`);
    out.score.spam += 6;
  }

  let trackingPixels = 0;
  $('img').each((_, el) => {
    const $img = $(el);
    const w = parseInt($img.attr('width') || '0', 10);
    const h = parseInt($img.attr('height') || '0', 10);
    const src = $img.attr('src') || '';
    if ((w === 1 && h === 1) || /pixel|track|open|beacon/i.test(src)) trackingPixels += 1;
  });
  out.details.trackingPixels = trackingPixels;
  if (trackingPixels > 0) out.score.promotions += 4;

  return out;
}

// ─────────────────────────────────────────────────────────────
// Compliance
// ─────────────────────────────────────────────────────────────

function analyzeCompliance(htmlResult, emailType) {
  const out = {
    score: { primary: 0, promotions: 0, spam: 0 },
    issues: [],
    positives: [],
    details: { emailType },
  };
  const $ = htmlResult.$;
  if (!$) return out;

  const text = $.root().text().toLowerCase();
  const html = $.html().toLowerCase();

  const hasUnsub = /\bunsubscribe\b|\bopt[\s-]?out\b|manage preferences|email preferences/.test(text);
  out.details.hasUnsubscribe = hasUnsub;

  // Personal & transactional emails don't legally need unsubscribe (they're 1-on-1 / triggered).
  // CAN-SPAM/Gmail bulk-sender rules only apply to bulk marketing email.
  const isBulk = emailType === 'bulk_marketing';

  if (!hasUnsub) {
    if (isBulk) {
      out.issues.push('No unsubscribe link found — required for bulk mail by CAN-SPAM, GDPR, Gmail bulk-sender rules.');
      out.score.spam += 25;
    } else if (emailType === 'unclear') {
      // Soft warning only — don't penalize as much
      out.issues.push('No unsubscribe link. If sending to a list, add one.');
      out.score.spam += 6;
    }
    // For personal & transactional: no penalty
  } else {
    out.positives.push('Unsubscribe link present.');
    if (isBulk) out.score.promotions += 4;
  }

  const hasAddress =
    /\b\d{1,5}\s+\w+\s+(street|st\.?|avenue|ave\.?|road|rd\.?|blvd|boulevard|drive|dr\.?|lane|ln\.?|suite|ste|way|court|ct)/i.test(text) ||
    /\b\d{5}(-\d{4})?\b/.test(text) ||
    /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(text) ||
    /our address|registered office|mailing address|po box/i.test(text);
  out.details.hasPhysicalAddress = hasAddress;

  if (!hasAddress) {
    if (isBulk) {
      out.issues.push('No physical mailing address detected — CAN-SPAM violation for bulk mail.');
      out.score.spam += 12;
    }
    // Personal/transactional: no penalty for missing address
  } else {
    out.positives.push('Physical address detected.');
  }

  const hasBrowserView = /view (in|on) (your )?browser|view this email|view online/.test(text);
  if (hasBrowserView) {
    out.positives.push('"View in browser" link present.');
    out.score.promotions += 2;
  }

  if (/list-unsubscribe/.test(html)) {
    out.positives.push('List-Unsubscribe reference detected.');
  }

  // Reward email type detection
  if (emailType === 'transactional') {
    out.positives.push('Transactional email pattern — strong Primary signal.');
    out.score.primary += 12;
  } else if (emailType === 'personal') {
    out.positives.push('Personal/conversational email pattern — Primary signal.');
    out.score.primary += 10;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Scoring engine
// ─────────────────────────────────────────────────────────────

function combineScores(factors) {
  const primary    = 25 + factors.reduce((s, f) => s + f.score.primary, 0);
  const promotions = 15 + factors.reduce((s, f) => s + f.score.promotions, 0);
  const spam       =  5 + factors.reduce((s, f) => s + f.score.spam, 0);

  const cappedPrimary = Math.max(0, Math.min(150, primary));
  const cappedPromo   = Math.max(0, Math.min(150, promotions));
  const cappedSpam    = Math.max(0, Math.min(150, spam));

  const total = cappedPrimary + cappedPromo + cappedSpam || 1;
  let pPrimary = Math.round((cappedPrimary / total) * 100);
  let pPromo   = Math.round((cappedPromo   / total) * 100);
  let pSpam    = Math.round((cappedSpam    / total) * 100);

  const sum = pPrimary + pPromo + pSpam;
  if (sum !== 100) {
    const diff = 100 - sum;
    if (pPrimary >= pPromo && pPrimary >= pSpam) pPrimary += diff;
    else if (pPromo >= pSpam) pPromo += diff;
    else pSpam += diff;
  }

  return {
    primary:    Math.max(0, Math.min(100, pPrimary)),
    promotions: Math.max(0, Math.min(100, pPromo)),
    spam:       Math.max(0, Math.min(100, pSpam)),
  };
}

function computeTemplateQuality(factors, probabilities) {
  const totalIssues = factors.reduce((s, f) => s + (f.issues?.length || 0), 0);
  const totalPositives = factors.reduce((s, f) => s + (f.positives?.length || 0), 0);
  const spamPct = probabilities.spam;

  let q = 100;
  q -= spamPct * 0.95;
  q -= Math.min(45, totalIssues * 3.5);
  q += Math.min(20, totalPositives * 2.2);
  return Math.max(0, Math.min(100, Math.round(q)));
}

function computeCombined(probabilities, templateQuality, senderQuality) {
  let combined = probabilities.primary * 0.4 + templateQuality * 0.3 + senderQuality * 0.3;
  if (templateQuality < 50) combined -= (50 - templateQuality) * 0.25;
  if (senderQuality < 50)   combined -= (50 - senderQuality)   * 0.25;
  if (probabilities.spam > 40) combined -= (probabilities.spam - 40) * 0.5;
  return Math.max(0, Math.min(100, Math.round(combined)));
}

// ─────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────

async function analyzeEmail({ html, subject, sender }) {
  const subjectResult    = analyzeSubject(subject);
  const htmlResult       = analyzeHTML(html);
  const contentResult    = analyzeContent(htmlResult);
  const linksResult      = analyzeLinks(htmlResult);

  // Detect email type (personal / transactional / bulk_marketing / unclear)
  // This drives compliance rules — personal/transactional don't need unsubscribe.
  const emailType = detectEmailType({ subject, html, $: htmlResult.$ });
  const complianceResult = analyzeCompliance(htmlResult, emailType);

  const factors = [subjectResult, htmlResult, contentResult, linksResult, complianceResult];
  const probabilities = combineScores(factors);
  const templateQuality = computeTemplateQuality(factors, probabilities);

  const issues    = factors.flatMap(f => f.issues    || []);
  const positives = factors.flatMap(f => f.positives || []);

  const stripped = factors.map(f => {
    const { $, ...rest } = f;
    return rest;
  });

  let senderResult = null;
  let combinedScore = null;
  if (sender && sender.email) {
    const { analyzeSender } = require('./senderAnalyzer');
    senderResult = await analyzeSender(sender.email, sender.name);
    combinedScore = computeCombined(probabilities, templateQuality, senderResult.quality);
  }

  return {
    probabilities,
    templateQuality,
    senderQuality: senderResult ? senderResult.quality : null,
    combinedScore,
    emailType,
    issues,
    positives,
    breakdown: {
      subject:    stripped[0],
      html:       stripped[1],
      content:    stripped[2],
      links:      stripped[3],
      compliance: stripped[4],
      sender:     senderResult,
    },
    summary: buildSummary(probabilities, templateQuality, senderResult, combinedScore),
  };
}

function buildSummary(prob, tplQ, sender, combined) {
  const verdict =
    prob.spam >= 45     ? 'High spam risk — major rework needed' :
    prob.spam >= 30     ? 'Moderate spam risk — review issues' :
    prob.primary >= 60  ? 'Optimised for the Primary inbox' :
    prob.promotions >= 55 ? 'Designed for the Promotions tab' :
    prob.primary > prob.promotions ? 'Likely Primary placement' :
    prob.promotions > prob.primary ? 'Likely Promotions placement' :
    'Mixed signals — review the issues below';

  return {
    verdict,
    primaryPct: prob.primary,
    promotionsPct: prob.promotions,
    spamPct: prob.spam,
    templateQuality: tplQ,
    senderQuality: sender ? sender.quality : null,
    combinedScore: combined,
  };
}

module.exports = { analyzeEmail };
