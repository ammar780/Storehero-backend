// Verify each bug fix individually
const { analyzeEmail } = require('../src/services/analyzer');

(async () => {
  console.log('\n=== BUG FIX VERIFICATION ===\n');

  // Bug 1: white bg + black text should NOT be flagged as hidden
  const r1 = await analyzeEmail({
    subject: 'Hi',
    html: '<body style="background:white;color:black"><p>normal email</p></body>',
    sender: null,
  });
  const hasHiddenIssue = r1.issues.some(i => i.toLowerCase().includes('hidden'));
  console.log(`Bug 1 — White bg + black text NOT flagged as hidden: ${!hasHiddenIssue ? '✓ FIXED' : '✗ STILL BROKEN'}`);

  // Bug 1b: same colour text/bg SHOULD be flagged
  const r1b = await analyzeEmail({
    subject: 'Hi',
    html: '<p style="color:#fff;background:#fff">hidden text trick</p><p>visible</p>',
    sender: null,
  });
  const hasHiddenIssueB = r1b.issues.some(i => i.toLowerCase().includes('hidden'));
  console.log(`Bug 1 — Same-colour text/bg DOES get flagged:        ${hasHiddenIssueB ? '✓ FIXED' : '✗ STILL BROKEN'}`);

  // Bug 2: acronyms should NOT be penalised
  const r2a = await analyzeEmail({
    subject: 'Welcome to our NEW store in the USA',
    html: '<p>Hello there how are you today friend</p>',
    sender: null,
  });
  const hasCapsIssue = r2a.issues.some(i => i.toLowerCase().includes('uppercase'));
  console.log(`Bug 2 — Subject with acronyms NOT flagged ALL CAPS:  ${!hasCapsIssue ? '✓ FIXED' : '✗ STILL BROKEN'}`);

  // Bug 2b: real ALL CAPS SHOULD be flagged
  const r2b = await analyzeEmail({
    subject: 'CONGRATULATIONS YOU HAVE WON THE LOTTERY GUARANTEED',
    html: '<p>hi</p>',
    sender: null,
  });
  const hasCapsIssueB = r2b.issues.some(i => i.toLowerCase().includes('uppercase'));
  console.log(`Bug 2 — Real ALL CAPS DOES get flagged:              ${hasCapsIssueB ? '✓ FIXED' : '✗ STILL BROKEN'}`);

  // Bug 3: HTML entities should be decoded for word matching
  const r3 = await analyzeEmail({
    subject: 'Hi',
    html: '<p>Save 50% &amp; get free shipping &amp; free shipping again</p>',
    sender: null,
  });
  const promoHits = r3.breakdown.content.details?.promoWordHits || [];
  const matchedPhrase = promoHits.find(h => h.word === 'free shipping');
  console.log(`Bug 3 — HTML entities decoded ("free shipping" 2x):  ${matchedPhrase && matchedPhrase.count >= 2 ? '✓ FIXED' : '✗ STILL BROKEN'} (got count=${matchedPhrase?.count || 0})`);

  // Bug 4: percentages always sum to 100
  let allSum = true;
  for (let i = 0; i < 20; i++) {
    const r = await analyzeEmail({
      subject: 'Random ' + Math.random(),
      html: '<p>random ' + Math.random() + '</p>',
      sender: null,
    });
    const s = r.probabilities.primary + r.probabilities.promotions + r.probabilities.spam;
    if (s !== 100) { allSum = false; console.log(`  ✗ sum=${s}`); }
  }
  console.log(`Bug 4 — Percentages always sum to 100 (20 random):   ${allSum ? '✓ FIXED' : '✗ STILL BROKEN'}`);

  // Bug 5: phrase matching with special chars (e.g. "100% free")
  const r5 = await analyzeEmail({
    subject: 'Get 100% free shipping today',
    html: '<p>hi</p>',
    sender: null,
  });
  const hits = r5.breakdown.subject.details?.subjectSpamHits || [];
  const has100Free = hits.some(h => h.word === '100% free');
  console.log(`Bug 5 — Phrase "100% free" matched in subject:       ${has100Free ? '✓ FIXED' : '✗ STILL BROKEN'}`);
})();
