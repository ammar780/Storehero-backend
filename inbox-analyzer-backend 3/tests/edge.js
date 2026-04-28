// Edge cases - things that might break the analyzer
const { analyzeEmail } = require('../src/services/analyzer');

const CASES = [
  { name: 'Empty subject', subject: '', html: '<p>hi</p>' },
  { name: 'Empty HTML', subject: 'Hi', html: '' },
  { name: 'Only whitespace HTML', subject: 'Hi', html: '   \n   ' },
  { name: 'Plain text (no HTML tags)', subject: 'Hi', html: 'just some plain text here' },
  { name: 'Malformed HTML', subject: 'Hi', html: '<p>oops <strong>missing close <a href="x">' },
  { name: 'HTML entities', subject: 'Save 50%', html: '<p>Save 50% &amp; get 2 for the price of 1!</p>' },
  { name: 'Subject with leading whitespace', subject: '   Order confirmed   ', html: '<p>Hi</p>' },
  { name: 'Hidden text via matching colours (real spam)', subject: 'Hi', html: '<p style="color:#fff;background:#fff">hidden spam</p><p>visible content here</p>' },
  { name: 'White bg dark text (NOT hidden, normal)', subject: 'Hi', html: '<body style="background:white;color:black"><p>Hi this is a normal email</p></body>' },
  { name: 'Acronym in subject (NEW USA)', subject: 'NEW USA Vitamins', html: '<p>hi</p>' },
  { name: 'Very long subject', subject: 'A'.repeat(300), html: '<p>hi</p>' },
  { name: 'Unicode/emoji subject', subject: '🎉🎊✨ Big news 🎁', html: '<p>hi</p>' },
];

(async () => {
  for (const c of CASES) {
    try {
      const r = await analyzeEmail({ html: c.html, subject: c.subject, sender: null });
      const sum = r.probabilities.primary + r.probabilities.promotions + r.probabilities.spam;
      const sumOk = sum === 100 ? '✓' : `✗ sum=${sum}`;
      console.log(`${sumOk} ${c.name.padEnd(45)} P:${String(r.probabilities.primary).padStart(3)} Pr:${String(r.probabilities.promotions).padStart(3)} S:${String(r.probabilities.spam).padStart(3)} Q:${String(r.templateQuality).padStart(3)} issues:${r.issues.length}`);
    } catch (err) {
      console.log(`✗ ${c.name.padEnd(45)} CRASH: ${err.message}`);
    }
  }
})();
