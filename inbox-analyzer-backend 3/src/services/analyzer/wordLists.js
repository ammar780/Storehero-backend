// Word lists used by the analyzer.
// Calibrated against Gmail's actual classifier behaviour (Promotions vs Primary vs Spam)
// and CAN-SPAM/Gmail bulk sender requirements (Feb 2024).

// Strong spam triggers — each occurrence adds significant risk.
// These are the patterns that overwhelmingly correlate with spam folder placement.
const SPAM_WORDS_STRONG = [
  // Pharma / health scams
  'viagra', 'cialis', 'pharmacy online', 'no prescription', 'cheap meds',
  // Money / lottery scams
  'casino', 'gambling', 'lottery', 'jackpot', 'sweepstakes',
  'nigerian prince', 'inheritance', 'beneficiary', 'unclaimed funds',
  'wire transfer', 'western union',
  // Get-rich-quick
  'guaranteed income', 'guaranteed earnings', 'work from home',
  'make money fast', 'easy money', 'extra cash', 'cash bonus',
  'be your own boss', 'earn per week', 'earn $', 'make $$$',
  // Debt/credit scams
  'no credit check', 'consolidate debt', 'eliminate debt',
  'lower interest rate', 'pre-approved', 'pre approved',
  // Spam-defining phrases
  '100% free', '100% satisfied', '100% guaranteed',
  'risk free', 'risk-free', 'no risk', 'no obligation', 'no purchase',
  'click here now', 'click below now', 'urgent response', 'final notice',
  'congratulations you', 'you have won', "you've won", 'you are a winner',
  'this is not spam', 'not a scam', 'not junk',
  'bulk email', 'mass email',
  'increase sales overnight', 'increase your traffic',
  // Adult / suspicious
  'meet singles', 'hot singles',
];

// Medium-risk promotional words — push toward Promotions tab.
// Most of these are LEGITIMATE for marketing emails but signal "this is a campaign".
const PROMO_WORDS = [
  'sale', 'discount', 'deal', 'offer', 'save', 'savings',
  'limited time', 'limited offer', 'exclusive', 'special offer',
  'best price', 'lowest price',
  'shop', 'shop now', 'order now', 'buy now',
  'coupon', 'promo code', 'voucher', 'rebate',
  'bonus', 'gift', 'reward', 'rewards',
  'subscribe', 'membership', 'free trial',
  'launch', 'introducing', 'new collection',
  'flash sale', 'clearance', 'closeout', 'sold out',
  'free shipping',
  '% off', 'percent off', 'half price', 'bogo',
  'today only', 'this week only', 'ends today', 'ends soon',
  'don\'t miss', 'last day', 'last hours',
  'expires', 'expiring soon',
  'restock', 'back in stock',
];

// Personal / conversational signals — push strongly toward Primary.
const PERSONAL_WORDS = [
  'thanks', 'thank you', 'thanks so much',
  'hi', 'hello', 'hey',
  'question', 'wondering', 'wanted to ask', 'wanted to',
  'follow up', 'following up', 'checking in',
  'reply', 'let me know', 'get back to me',
  'meeting', 'call', 'chat', 'talk',
  'sorry', 'apologies', 'apologize',
  'congrats', 'congratulations on', 'great work', 'nice work',
  'how are you', 'hope you',
];

// Transactional signals — strongly Primary.
const TRANSACTIONAL_WORDS = [
  'order confirmation', 'order #', 'order number',
  'receipt', 'invoice', 'payment received', 'payment confirmation',
  'shipping confirmation', 'tracking number', 'tracking #',
  'has shipped', 'has been shipped', 'is on the way',
  'delivered', 'out for delivery',
  'appointment confirmation', 'reservation confirmed',
  'booking confirmed', 'booking confirmation',
  'password reset', 'reset your password',
  'verify your email', 'email verification', 'verification code',
  'two-factor', '2fa', 'security code',
  'account created', 'welcome to',
  'subscription confirmed',
  'refund issued', 'refund processed',
];

// Suspicious TLDs commonly seen in phishing
const SUSPICIOUS_TLDS = [
  '.tk', '.ml', '.ga', '.cf', '.gq', '.top', '.work', '.click',
  '.country', '.stream', '.download', '.review', '.science',
  '.zip', '.mov', '.win', '.bid', '.loan',
];

// URL shorteners
const URL_SHORTENERS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 't.co', 'is.gd',
  'buff.ly', 'tiny.cc', 'shorte.st', 'rebrand.ly', 'cutt.ly',
  'rb.gy', 'shorturl.at', 'soo.gd', 'tr.im',
];

// Free email providers (bad for marketing as the From address)
const FREE_EMAIL_PROVIDERS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'live.com',
  'msn.com', 'protonmail.com', 'yandex.com', 'mail.com',
  'gmx.com', 'zoho.com', 'fastmail.com', 'proton.me',
];

module.exports = {
  SPAM_WORDS_STRONG,
  PROMO_WORDS,
  PERSONAL_WORDS,
  TRANSACTIONAL_WORDS,
  SUSPICIOUS_TLDS,
  URL_SHORTENERS,
  FREE_EMAIL_PROVIDERS,
};
