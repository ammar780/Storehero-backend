// Test sender analyzer against real, well-known domains
const { analyzeSender } = require('../src/services/analyzer/senderAnalyzer');

const TESTS = [
  { email: 'noreply@google.com',          expectQuality: 'high', desc: 'Google (full auth)' },
  { email: 'support@github.com',          expectQuality: 'high', desc: 'GitHub' },
  { email: 'hello@stripe.com',            expectQuality: 'high', desc: 'Stripe' },
  { email: 'someone@gmail.com',           expectQuality: 'low',  desc: 'Free provider Gmail' },
  { email: 'someone@yahoo.com',           expectQuality: 'low',  desc: 'Free provider Yahoo' },
  { email: 'invalid-email-no-at',         expectQuality: 'fail', desc: 'Invalid email' },
  { email: 'test@thisdomaindoesnotexistxyz999.com', expectQuality: 'low', desc: 'Non-existent domain' },
];

(async () => {
  console.log('\n=== SENDER DNS ANALYSIS — REAL DOMAINS ===\n');
  for (const t of TESTS) {
    const start = Date.now();
    try {
      const r = await analyzeSender(t.email, null);
      const elapsed = Date.now() - start;
      console.log(`${t.desc} (${t.email})`);
      console.log(`  Quality: ${r.quality}/100   |   Domain: ${r.domain || 'n/a'}   |   ${elapsed}ms`);
      console.log(`  MX:${r.mx.found ? '✓' : '✗'}  SPF:${r.spf.found ? '✓ ' + r.spf.policy : '✗'}  DKIM:${r.dkim.found ? '✓ ' + r.dkim.selector : '✗'}  DMARC:${r.dmarc.found ? '✓ p=' + r.dmarc.policy : '✗'}  BIMI:${r.bimi.found ? '✓' : '✗'}`);
      console.log(`  Issues: ${r.issues.length}   |   Positives: ${r.positives.length}`);
      console.log('');
    } catch (err) {
      console.log(`✗ ${t.desc} CRASH: ${err.message}\n`);
    }
  }
})();
