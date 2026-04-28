const { analyzeEmail } = require('../src/services/analyzer');

const tests = [
  {
    name: 'Stripe-like transactional receipt',
    expect: 'primary >= 60',
    subject: 'Your receipt from Acme Inc. [#1043-3756]',
    html: `<!DOCTYPE html><html><body style="font-family:Arial">
      <p>Hi Devin,</p>
      <p>Thanks for your purchase. Here's your receipt for $89.99.</p>
      <p>Order #1043-3756<br>Date: April 24, 2026<br>Payment method: Visa ending in 4242</p>
      <p>If you have any questions, just reply to this email — we're happy to help.</p>
      <p>Thanks,<br>The team</p>
      <p style="font-size:11px;color:#666">Acme Inc., 510 Townsend Street, San Francisco, CA 94103</p>
    </body></html>`,
  },
  {
    name: 'Personal founder note (one-on-one feel)',
    expect: 'primary >= 60',
    subject: 'Quick question about your subscription',
    html: `<!DOCTYPE html><html><body><p>Hi Sarah,</p>
      <p>Following up on the message from last week. Did you get a chance to think about it?</p>
      <p>No pressure — just wanted to check in.</p>
      <p>Thanks,<br>Alexa</p></body></html>`,
  },
  {
    name: 'Clean newsletter (well-built marketing)',
    expect: 'promotions >= 50, spam < 15',
    subject: 'New Glam Dust drops Friday',
    html: `<!DOCTYPE html><html><body>
      <table width="600" align="center"><tr><td>
      <h1>New Glam Dust drops Friday</h1>
      <p>Our new Glam Dust formula launches Friday. Subscribers get early access.</p>
      <a href="https://thevitaminshots.com/glam-dust" style="background:#f1c349;padding:14px 28px">Shop the launch</a>
      </td></tr></table>
      <p style="font-size:11px;text-align:center">The Vitamin Shots, 123 Market St, San Francisco, CA 94103<br>
        <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p>
    </body></html>`,
  },
  {
    name: 'Heavy promo email (legitimate marketing)',
    expect: 'promotions >= 50, spam < 25',
    subject: '50% off everything ends tonight',
    html: `<!DOCTYPE html><html><body>
      <table width="600" align="center" bgcolor="#fff3d6"><tr><td bgcolor="#f1c349" style="padding:24px;text-align:center">
        <h1>FLASH SALE</h1>
        <h2>50% OFF EVERYTHING</h2>
        <p>Today only. Use code SAVE50.</p>
      </td></tr></table>
      <a href="https://thevitaminshots.com/sale">Shop now</a>
      <p style="font-size:11px">The Vitamin Shots, 123 Market St, San Francisco, CA 94103<br>
        <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p>
    </body></html>`,
  },
  {
    name: 'Obvious spam',
    expect: 'spam >= 50',
    subject: 'CONGRATULATIONS!!! YOU HAVE WON $1000!!! CLICK NOW!!!',
    html: '<html><body><h1 style="color:#fff;background:#fff">FREE FREE FREE</h1><p>100% guaranteed make money fast! Click here now!</p><a href="http://bit.ly/x">CLICK</a><a href="http://192.168.1.1">FREE</a><script>x</script></body></html>',
  },
];

(async () => {
  for (const t of tests) {
    const r = await analyzeEmail({ html: t.html, subject: t.subject, sender: null });
    const p = r.probabilities;
    console.log(`\n${t.name}`);
    console.log(`  Expected: ${t.expect}`);
    console.log(`  Got: Primary ${p.primary}%  Promo ${p.promotions}%  Spam ${p.spam}%  Quality ${r.templateQuality}/100`);
    if (r.issues.length > 0) console.log(`  Issues: ${r.issues.slice(0, 3).join(' / ')}`);
  }
})();
