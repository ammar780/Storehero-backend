// Six real-world style templates we'll score and verify
module.exports = {
  transactional: {
    name: 'Order confirmation (transactional)',
    expect: 'primary',
    subject: 'Your order #4521 is confirmed',
    html: `<!DOCTYPE html><html><body style="font-family:Arial">
      <p>Hi John,</p>
      <p>Thanks so much for your order. Here are the details you need:</p>
      <p><strong>Order #4521</strong><br>Total: $89.99</p>
      <p>We'll send tracking info as soon as it ships. If you have any questions, just reply to this email and we'll help out.</p>
      <p>Thanks,<br>Alexa from The Vitamin Shots</p>
      <hr>
      <p style="font-size:11px;color:#666">The Vitamin Shots Inc., 123 Market St, San Francisco, CA 94103, USA<br>
        <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p>
    </body></html>`,
  },

  personalReply: {
    name: 'Personal-style follow-up',
    expect: 'primary',
    subject: 'Quick question about your subscription',
    html: `<!DOCTYPE html><html><body style="font-family:Arial">
      <p>Hi {{first_name}},</p>
      <p>I wanted to follow up on the message I sent last week. Did you get a chance to look at it?</p>
      <p>Just let me know if you have any questions — happy to help.</p>
      <p>Thanks,<br>Alexa</p>
      <p style="font-size:11px;color:#888">The Vitamin Shots, 123 Market St, San Francisco, CA 94103<br>
        <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p>
    </body></html>`,
  },

  cleanNewsletter: {
    name: 'Well-built newsletter (clean promo)',
    expect: 'promotions',
    subject: 'New Glam Dust drops this Friday ✨',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
      <table width="600" align="center" cellspacing="0" cellpadding="0" border="0">
        <tr><td>
          <img src="https://example.com/logo.png" alt="The Vitamin Shots" width="180" height="48">
          <h1 style="font-family:Georgia">New Glam Dust drops Friday</h1>
          <p>Our new Glam Dust formula launches Friday with 30% off for our subscribers.</p>
          <table cellspacing="0" cellpadding="0"><tr>
            <td width="48%"><img src="https://example.com/p1.jpg" alt="Glam Dust Pink" width="280" height="280"></td>
            <td width="4%">&nbsp;</td>
            <td width="48%"><img src="https://example.com/p2.jpg" alt="Glam Dust Gold" width="280" height="280"></td>
          </tr></table>
          <p>Two flavors. Ten essential vitamins. One sparkly powder.</p>
          <a href="https://thevitaminshots.com/glam-dust" style="background:#f1c349;padding:14px 28px;color:#000;text-decoration:none;font-weight:bold;border-radius:6px;display:inline-block">Shop the launch</a>
          <p style="margin-top:32px;font-size:14px">P.S. — Your subscriber discount is automatic at checkout.</p>
        </td></tr>
        <tr><td style="padding-top:32px;border-top:1px solid #eee;font-size:11px;color:#666;text-align:center">
          <p>The Vitamin Shots Inc., 123 Market St, San Francisco, CA 94103 USA</p>
          <p><a href="https://thevitaminshots.com/email-prefs">Email preferences</a> · <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a></p>
        </td></tr>
      </table>
    </body></html>`,
  },

  saleEmail: {
    name: 'Heavy promotional sale email',
    expect: 'promotions',
    subject: '🎉 50% OFF everything – ends tonight!',
    html: `<!DOCTYPE html><html><body bgcolor="#fff3d6">
      <table width="600" align="center"><tr><td bgcolor="#f1c349" style="padding:24px;text-align:center">
        <h1 style="color:#000;font-size:36px">⚡ FLASH SALE ⚡</h1>
        <h2>50% OFF EVERYTHING</h2>
        <p>Today only. Use code <strong>SAVE50</strong>.</p>
      </td></tr></table>
      <table width="600" align="center"><tr>
        <td><img src="https://example.com/p1.jpg" alt="Vitamin Shots" width="180" height="180"></td>
        <td><img src="https://example.com/p2.jpg" alt="Glam Dust" width="180" height="180"></td>
        <td><img src="https://example.com/p3.jpg" alt="Sprinkles" width="180" height="180"></td>
      </tr></table>
      <table width="600" align="center"><tr><td style="text-align:center;padding:20px">
        <a href="https://thevitaminshots.com/sale" style="background:#000;color:#f1c349;padding:18px 36px;text-decoration:none;font-weight:bold;font-size:18px">SHOP THE SALE NOW</a>
        <p style="font-size:24px;font-weight:bold">Save 50%! Free shipping! Limited time only!</p>
        <p>Don't miss this exclusive offer. Sale ends tonight at midnight.</p>
        <a href="https://thevitaminshots.com/vitamin-shots" style="background:#f1c349;padding:12px 24px;text-decoration:none">Vitamin Shots — Shop Now</a>
        <a href="https://thevitaminshots.com/glam-dust" style="background:#f1c349;padding:12px 24px;text-decoration:none">Glam Dust — Shop Now</a>
        <a href="https://thevitaminshots.com/sprinkles" style="background:#f1c349;padding:12px 24px;text-decoration:none">Sprinkles — Shop Now</a>
      </td></tr></table>
      <p style="font-size:11px;text-align:center;color:#666">
        The Vitamin Shots Inc., 123 Market St, San Francisco, CA 94103 USA<br>
        <a href="https://thevitaminshots.com/unsubscribe">Unsubscribe</a> · <a href="https://thevitaminshots.com/preferences">Update preferences</a>
      </p>
    </body></html>`,
  },

  spammy: {
    name: 'Obvious spam (should score badly)',
    expect: 'spam',
    subject: 'CONGRATULATIONS!!! YOU HAVE WON $1000!!! CLICK NOW!!!',
    html: `<html><body>
      <h1 style="color:#ffffff;background:#ffffff">FREE FREE FREE FREE FREE</h1>
      <p style="font-size:0">hidden keyword stuffing for SEO viagra cialis casino</p>
      <h2>CONGRATULATIONS!!! 100% GUARANTEED MAKE MONEY FAST!!!</h2>
      <p>CLICK HERE NOW to claim your FREE PRIZE!!!</p>
      <p>Work from home! Make money fast! Earn $5000/week! No risk! No obligation!</p>
      <p>Pre-approved! Be your own boss! Lottery winner!</p>
      <a href="http://bit.ly/abc123">CLICK HERE NOW!!!</a>
      <a href="http://192.168.1.1/free">FREE GIFT</a>
      <a href="http://scam.tk">CLAIM PRIZE</a>
      <a href="http://malware.click">DOWNLOAD</a>
      <script>alert('xss')</script>
      <iframe src="http://evil.com"></iframe>
    </body></html>`,
  },

  brokenButTrying: {
    name: 'Marketing email with several issues',
    expect: 'promotions-or-spam',
    subject: 'BUY NOW!! Limited offer just for YOU!!',
    html: `<html><body>
      <h1>SAVE BIG TODAY ONLY!!</h1>
      <img src="https://example.com/big.jpg">
      <img src="https://example.com/big2.jpg">
      <img src="https://example.com/big3.jpg">
      <a href="http://tinyurl.com/xyz">SHOP NOW</a>
      <p>Free trial! Risk-free! Money back guarantee!</p>
    </body></html>`,
  },
};
