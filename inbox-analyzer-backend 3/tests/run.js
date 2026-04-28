// Quick smoke test - scores all fixtures and prints a table
const { analyzeEmail } = require('../src/services/analyzer');
const FIXTURES = require('./fixtures');

(async () => {
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│  TVS Inbox Analyzer — Test Run                                              │');
  console.log('└─────────────────────────────────────────────────────────────────────────────┘\n');

  let pass = 0, fail = 0;

  for (const [key, t] of Object.entries(FIXTURES)) {
    const r = await analyzeEmail({ html: t.html, subject: t.subject, sender: null });
    const { primary, promotions, spam } = r.probabilities;
    const sum = primary + promotions + spam;
    const winner = primary >= promotions && primary >= spam ? 'primary'
                 : spam >= promotions ? 'spam' : 'promotions';

    let status = '✓';
    let testNote = '';
    if (sum !== 100) { status = '✗'; testNote = `SUM=${sum}!=100`; fail++; }
    else if (t.expect === 'primary' && winner !== 'primary') { status = '✗'; testNote = `expected primary, got ${winner}`; fail++; }
    else if (t.expect === 'promotions' && winner === 'spam') { status = '✗'; testNote = `expected promo, got spam`; fail++; }
    else if (t.expect === 'spam' && winner !== 'spam') { status = '✗'; testNote = `expected spam, got ${winner}`; fail++; }
    else if (t.expect === 'promotions-or-spam' && winner === 'primary') { status = '✗'; testNote = `expected promo/spam, got primary`; fail++; }
    else { pass++; }

    console.log(`${status} ${t.name}`);
    console.log(`   Subject: "${t.subject.slice(0, 70)}${t.subject.length > 70 ? '…' : ''}"`);
    console.log(`   Primary: ${String(primary).padStart(3)}%   Promotions: ${String(promotions).padStart(3)}%   Spam: ${String(spam).padStart(3)}%   (winner: ${winner.toUpperCase()})`);
    console.log(`   Template Quality: ${r.templateQuality}/100   |   Issues: ${r.issues.length}   |   Positives: ${r.positives.length}`);
    if (testNote) console.log(`   ⚠ ${testNote}`);
    console.log('');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed of ${pass + fail} tests\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
