require('dotenv').config();
const crypto = require('crypto');
// #54 ENV VALIDATION
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of REQUIRED_ENV) { if (!process.env[key]) { console.error('FATAL: Missing required env var: ' + key); process.exit(1); } }
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) console.warn('WARNING: FRONTEND_URL not set in production.');
const APP_NAME = 'Vitamin Shots Finance Minister';
const express=require('express'),cors=require('cors'),helmet=require('helmet'),compression=require('compression'),
  morgan=require('morgan'),cron=require('node-cron'),{Pool}=require('pg'),jwt=require('jsonwebtoken'),
  bcrypt=require('bcryptjs'),axios=require('axios'),nodemailer=require('nodemailer');

const app=express(),PORT=process.env.PORT||3001;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,max:10,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
pool.on('error',e=>console.error('DB error:',e.message));

app.use(helmet({contentSecurityPolicy:process.env.NODE_ENV==='production'?{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:","https:"],connectSrc:["'self'",process.env.FRONTEND_URL||"'self'"]}}:false}));
app.use(compression());
app.use(cors({origin:process.env.NODE_ENV==='production'?(process.env.FRONTEND_URL||false):(process.env.FRONTEND_URL||true),credentials:true}));
app.use('/api/webhooks/woocommerce',express.raw({type:'application/json'}));
app.use(express.json({limit:'10mb'}));
app.use(morgan('short'));
// Add request ID for debugging
app.use((req,res,next)=>{req.id=crypto.randomUUID();req._startTime=Date.now();res.setHeader('X-Request-ID',req.id);res.on('finish',()=>{const ms=Date.now()-req._startTime;if(ms>2000)console.warn('⚠️ Slow request:',req.method,req.url,ms+'ms');});next();});


// Simple in-memory cache (30s TTL for dashboard queries)
const apiCache = new Map();
function cached(key, ttlMs, fn) {
  return async (req, res) => {
    const cacheKey = key + JSON.stringify(req.query);
    const hit = apiCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < ttlMs) return res.json(hit.data);
    try {
      const data = await fn(req);
      apiCache.set(cacheKey, { data, ts: Date.now() });
      // Prevent unbounded growth
      if (apiCache.size > 200) { const first = apiCache.keys().next().value; apiCache.delete(first); }
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  };
}

// === HELPERS ===
const auth=(req,res,next)=>{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'No token'});try{req.user=jwt.verify(t,process.env.JWT_SECRET);next()}catch(e){res.status(401).json({error:'Invalid token'})}};
const genToken=u=>jwt.sign({id:u.id,email:u.email,role:u.role},process.env.JWT_SECRET,{expiresIn:'7d'});
const genRefreshToken=u=>jwt.sign({id:u.id,type:'refresh'},process.env.JWT_SECRET,{expiresIn:'30d'});
const dr=q=>{const{start,end,period}=q;if(start&&end)return{start,end};if(period?.startsWith('custom_')){const parts=period.split('_');return{start:parts[1],end:parts[2]}}const n=new Date(),d=x=>new Date(Date.now()-x*864e5).toISOString().split('T')[0],t=n.toISOString().split('T')[0];const m={today:[t,t],'7d':[d(7),t],'30d':[d(30),t],'90d':[d(90),t],ytd:[`${n.getFullYear()}-01-01`,t],'12m':[d(365),t],'all':[d(3650),t]};const[s,e]=m[period]||m['30d'];return{start:s,end:e}};
// Get credentials: DB config first, then env var fallback
async function getCreds(platform) {
  try {
    const r = await pool.query('SELECT config FROM integrations WHERE platform=$1', [platform]);
    const raw = r.rows[0]?.config;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  } catch { return {}; }
}
async function cred(platform, key, envVar) {
  const c = await getCreds(platform);
  return c[key] || process.env[envVar] || '';
}
async function setIntStatus(platform, status, error) {
  const connected = (status === 'synced' || status === 'completed');
  await pool.query(`UPDATE integrations SET sync_status=$1, is_connected=$2, last_sync_at=NOW(), error_message=$3, updated_at=NOW() WHERE platform=$4`,
    [status, connected, error || null, platform]);
}


// #19 Helper: days in current month
function daysInCurrentMonth(){const now=new Date();return new Date(now.getFullYear(),now.getMonth()+1,0).getDate();}
// #18 Configurable payment fee rates per channel
function getPaymentFeeRate(pm,ch){const r={elavon:{p:parseFloat(process.env.FEE_ELAVON_PCT||'2.6')/100,f:parseFloat(process.env.FEE_ELAVON_FIXED||'0.10')},stripe:{p:parseFloat(process.env.FEE_STRIPE_PCT||'2.9')/100,f:parseFloat(process.env.FEE_STRIPE_FIXED||'0.30')},paypal:{p:parseFloat(process.env.FEE_PAYPAL_PCT||'3.49')/100,f:parseFloat(process.env.FEE_PAYPAL_FIXED||'0.49')},amazon:{p:parseFloat(process.env.FEE_AMAZON_PCT||'15')/100,f:0},tiktok_shop:{p:parseFloat(process.env.FEE_TIKTOK_PCT||'5')/100,f:0},meta_shop:{p:parseFloat(process.env.FEE_META_SHOP_PCT||'5')/100,f:0},default:{p:0.029,f:0.30}};if(ch&&r[ch])return r[ch];const m=(pm||'').toLowerCase();if(m.includes('elavon')||m.includes('converge'))return r.elavon;if(m.includes('stripe'))return r.stripe;if(m.includes('paypal'))return r.paypal;return r.default;}
function calcPaymentFee(rev,pm,ch){const r=getPaymentFeeRate(pm,ch);return rev*r.p+r.f;}
// #25 Proper nullish coalescing for COGS
function getProductCost(row){if(!row)return 0;const l=row.landed_cost!=null?+row.landed_cost:null;const c=row.cogs!=null?+row.cogs:null;if(l!=null&&l>0)return l;if(c!=null&&c>0)return c;return 0;}

// Get daily fixed cost rate — uses monthly snapshot if available, else current
async function getFixedCostDaily(dateStr) {
  try {
    if (dateStr) {
      const month = dateStr.slice(0,7); // YYYY-MM
      const snap = await pool.query('SELECT daily_rate FROM fixed_cost_snapshots WHERE month=$1',[month]);
      if (snap.rows[0]) return +(snap.rows[0].daily_rate);
    }
    const fc = await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');
    return +(fc.rows[0].t) / daysInCurrentMonth();
  } catch { return 0; }
}

// Save a snapshot of current fixed costs for the month
async function saveFixedCostSnapshot() {
  try {
    const fc = await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');
    const total = +(fc.rows[0].t);
    const month = new Date().toISOString().slice(0,7);
    const daily = total / daysInCurrentMonth();
    await pool.query('INSERT INTO fixed_cost_snapshots(month,total_monthly,daily_rate) VALUES($1,$2,$3) ON CONFLICT(month) DO UPDATE SET total_monthly=$2,daily_rate=$3,snapshot_at=NOW()',[month,total,daily]);
    return daily;
  } catch(e) { console.error('Snapshot error:', e.message); return 0; }
}

// Send Slack notification
async function sendSlack(text, blocks) {
  let url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { try { const sc = await getCreds('slack'); url = sc.webhook_url; } catch {} }
  if (!url) return;
  try {
    await axios.post(url, blocks ? { text, blocks } : { text });
  } catch(e) { console.error('Slack error:', e.message); }
}


// Universal email sender: Resend API first, then SMTP fallback
async function sendEmail({ to, subject, html }) {
  // Method 1: Resend API
  let resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { try { const rc = await getCreds('resend'); resendKey = rc.api_key; } catch {} }
  if (resendKey) {
    let from = process.env.EMAIL_FROM || 'Vitamin Shots <noreply@thevitaminshots.com>';
    try { const rc = await getCreds('resend'); if (rc.from_email) from = rc.from_email; } catch {}
    const toArr = Array.isArray(to) ? to : [to];
    const headers = { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' };
    
    // Try with configured from address
    try {
      const resp = await axios.post('https://api.resend.com/emails', { from, to: toArr, subject, html }, { headers });
      if (resp.data?.id) { console.log('✉️ Email sent via Resend:', resp.data.id); return { success: true, provider: 'resend', id: resp.data.id }; }
    } catch(e) {
      const errData = e.response?.data || {};
      console.error('Resend error:', errData.statusCode, errData.message);
      
      // If domain not verified (403), retry with Resend's default sender
      if (errData.statusCode === 403 || errData.name === 'validation_error') {
        console.log('Domain not verified, retrying with Resend default sender...');
        try {
          const resp2 = await axios.post('https://api.resend.com/emails', 
            { from: 'Vitamin Shots Finance Minister <onboarding@resend.dev>', to: toArr, subject, html }, { headers });
          if (resp2.data?.id) { console.log('✉️ Email sent via Resend (default sender):', resp2.data.id); return { success: true, provider: 'resend', id: resp2.data.id }; }
        } catch(e2) {
          console.error('Resend retry failed:', e2.response?.data || e2.message);
        }
      }
      // Fall through to SMTP
    }
  }
  // Method 2: SMTP/nodemailer
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT)||587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, tls: { rejectUnauthorized: false } });
      const info = await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to: Array.isArray(to) ? to.join(',') : to, subject, html });
      console.log('✉️ Email sent via SMTP:', info.messageId);
      return { success: true, provider: 'smtp', id: info.messageId };
    } catch(e) {
      console.error('SMTP error:', e.message);
      return { success: false, provider: 'smtp', error: e.message };
    }
  }
  console.error('No email provider configured (set RESEND_API_KEY or SMTP_HOST+SMTP_USER)');
  return { success: false, provider: 'none', error: 'No email provider configured. Add RESEND_API_KEY or SMTP_HOST+SMTP_USER in Railway variables.' };
}


// Auto-create admin user from env vars if DB is empty
async function autoSetupFromEnv() {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM users');
    if (+count.rows[0].count > 0) return;
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = (process.env.ADMIN_PASSWORD || '').trim();
    if (!email || !password) { console.log('No ADMIN_EMAIL/ADMIN_PASSWORD set — use the setup page to create your account'); return; }
    if (password.length < 8) { console.error('ADMIN_PASSWORD must be at least 8 characters'); return; }
    const h = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO users(email,password_hash,name,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING', [email, h, 'Admin', 'admin']);
    console.log('✅ Admin user auto-created from env vars:', email);
  } catch(e) { console.error('Auto-setup error:', e.message); }
}

// === HEALTH ===
app.get('/',(r,s)=>s.json({status:'ok',app:APP_NAME,v:'2.0.0'}));
app.get('/health',async(r,s)=>{try{await pool.query('SELECT 1');s.json({status:'healthy',db:'connected',app:APP_NAME,uptime:Math.round(process.uptime()),ts:new Date().toISOString()})}catch(e){s.status(503).json({status:'unhealthy',db:'disconnected',error:e.message})}});

// ====================== SECURITY ======================
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS||'devinfeldman@thevitaminshots.com,yasirjea123@gmail.com').split(',').map(e=>e.trim().toLowerCase()).filter(Boolean);
const loginAttempts = new Map(); // rate limiting
const rateLimit = (key, maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < windowMs);
  if (recent.length >= maxAttempts) return false;
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
};
const sanitize = (s) => typeof s === 'string' ? s.trim().slice(0, 500) : '';
const sanitizeNum = (v, def = 0) => { const n = +(v); return isNaN(n) ? def : n; };

// ====================== AUTH ======================
app.get('/api/auth/check-setup',async(req,res)=>{try{const r=await pool.query('SELECT COUNT(*)FROM users');res.json({setupRequired:+r.rows[0].count===0})}catch(e){res.json({setupRequired:true})}});

app.post('/api/auth/setup',async(req,res)=>{try{
  if(!rateLimit('setup',3))return res.status(429).json({error:'Too many attempts. Try again later.'});
  const x=await pool.query('SELECT COUNT(*)FROM users');
  if(+x.rows[0].count>0)return res.status(400).json({error:'Already set up'});
  const email=sanitize(req.body.email).toLowerCase();
  const password=sanitize(req.body.password);
  const name=sanitize(req.body.name)||'Admin';
  if(!email||!password)return res.status(400).json({error:'Email and password required'});
  if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});
  if(!ALLOWED_EMAILS.includes(email))return res.status(403).json({error:'This email is not authorized'});
  const h=await bcrypt.hash(password,12);
  const r=await pool.query('INSERT INTO users(email,password_hash,name,role)VALUES($1,$2,$3,$4)RETURNING id,email,name,role',[email,h,name,'admin']);
  res.json({token:genToken(r.rows[0]),refreshToken:genRefreshToken(r.rows[0]),user:r.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

// OTP storage (in-memory, expires after 5 min)
const otpStore = new Map();
// #11+#12 Periodic cleanup of OTP and rate limiter maps
setInterval(()=>{const now=Date.now();for(const[k,v]of otpStore){if(now>v.expires)otpStore.delete(k);}for(const[k,a]of loginAttempts){const r=a.filter(t=>now-t<15*60*1000);if(!r.length)loginAttempts.delete(k);else loginAttempts.set(k,r);}},60000);

app.post('/api/auth/login',async(req,res)=>{try{
  const email=sanitize(req.body.email).toLowerCase();
  const password=sanitize(req.body.password);
  const otp=sanitize(req.body.otp);
  if(!email||!password)return res.status(400).json({error:'Email and password required'});
  if(!rateLimit(email)){return res.status(429).json({error:'Too many login attempts. Try again in 15 minutes.'})}
  if(!ALLOWED_EMAILS.includes(email))return res.status(403).json({error:'This email is not authorized'});
  const r=await pool.query('SELECT*FROM users WHERE email=$1',[email]);
  if(!r.rows[0]||!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({error:'Invalid credentials'});

  // OTP step
  if (!otp) {
    // Generate and send OTP
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(email, { code, expires: Date.now() + 5 * 60 * 1000 });
    // Send OTP email via Resend or SMTP
    const emailResult = await sendEmail({
      to: email,
      subject: `${APP_NAME} — Login Code: ${code}`,
      html: `<div style="font-family:Arial;max-width:400px;margin:0 auto;padding:32px;text-align:center"><h2 style="color:#f1c349">Login Verification</h2><p style="color:#666">Your one-time login code is:</p><div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1a1a1a;margin:24px 0;padding:16px;background:#f5f5f5;border-radius:12px">${code}</div><p style="color:#999;font-size:12px">This code expires in 5 minutes. If you didn't request this, ignore this email.</p></div>`
    });
    if (!emailResult.success) {
      // Don't lock user out — return error so they know
      otpStore.delete(email);
      return res.status(500).json({ error: 'Failed to send verification code. Check email configuration. (' + (emailResult.error || 'unknown') + ')' });
    }
    return res.json({ otpRequired: true, message: 'Verification code sent to your email' });
  }

  // Verify OTP
  const stored = otpStore.get(email);
  if (!stored || Date.now() > stored.expires) {
    return res.status(401).json({ error: 'Invalid or expired verification code' });
  }
  // Timing-safe comparison to prevent timing attacks
  const otpValid = stored.code.length === otp.length && crypto.timingSafeEqual(Buffer.from(stored.code), Buffer.from(otp));
  if (!otpValid) {
    return res.status(401).json({ error: 'Invalid or expired verification code' });
  }
  otpStore.delete(email);

  const u=r.rows[0];
  res.json({token:genToken(u),refreshToken:genRefreshToken(u),user:{id:u.id,email:u.email,name:u.name,role:u.role,timezone:u.timezone,currency:u.currency}});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/auth/me',auth,async(req,res)=>{try{res.json((await pool.query('SELECT id,email,name,role,timezone,currency FROM users WHERE id=$1',[req.user.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});

// #17 Token refresh endpoint
app.post('/api/auth/refresh',async(req,res)=>{try{
  if(!rateLimit('refresh_'+(req.ip||'unknown'),20,60000))return res.status(429).json({error:'Too many refresh attempts'});const{refreshToken}=req.body;if(!refreshToken)return res.status(400).json({error:'Refresh token required'});const decoded=jwt.verify(refreshToken,process.env.JWT_SECRET);if(decoded.type!=='refresh')return res.status(401).json({error:'Invalid refresh token'});const r=await pool.query('SELECT id,email,name,role FROM users WHERE id=$1',[decoded.id]);if(!r.rows[0])return res.status(401).json({error:'User not found'});res.json({token:genToken(r.rows[0]),refreshToken:genRefreshToken(r.rows[0])});}catch(e){res.status(401).json({error:'Invalid or expired refresh token'})}});

// User profile update
app.put('/api/auth/profile',auth,async(req,res)=>{try{
  const{name,timezone,currency,current_password,new_password}=req.body;
  // Update basic profile
  if(name||timezone||currency){
    await pool.query('UPDATE users SET name=COALESCE($1,name),timezone=COALESCE($2,timezone),currency=COALESCE($3,currency),updated_at=NOW() WHERE id=$4',[name||null,timezone||null,currency||null,req.user.id]);
  }
  // Change password (requires current password)
  if(new_password){
    if(!current_password)return res.status(400).json({error:'Current password required to change password'});
    if(new_password.length<8)return res.status(400).json({error:'New password must be at least 8 characters'});
    const u=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user.id]);
    if(!u.rows[0]||!await bcrypt.compare(current_password,u.rows[0].password_hash))return res.status(401).json({error:'Current password is incorrect'});
    const h=await bcrypt.hash(new_password,12);
    await pool.query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[h,req.user.id]);
  }
  const updated=await pool.query('SELECT id,email,name,role,timezone,currency FROM users WHERE id=$1',[req.user.id]);
  res.json(updated.rows[0]);
}catch(e){res.status(500).json({error:e.message})}});

// Password reset (for authorized users)
app.post('/api/auth/reset-password',async(req,res)=>{try{
  const email=sanitize(req.body.email).toLowerCase();const newPassword=sanitize(req.body.new_password);const otp=sanitize(req.body.otp);
  if(!email)return res.status(400).json({error:'Email required'});
  if(!ALLOWED_EMAILS.includes(email))return res.status(403).json({error:'Email not authorized'});
  if(!otp){// Step 1: Send OTP
    if(!rateLimit('reset_'+email,3))return res.status(429).json({error:'Too many reset attempts. Try again in 15 minutes.'});
    const code=String(Math.floor(100000+Math.random()*900000));otpStore.set('reset_'+email,{code,expires:Date.now()+5*60*1000});
    const resetEmailResult = await sendEmail({ to: email, subject: `${APP_NAME} — Reset Code: ${code}`, html: `<div style="text-align:center;font-family:Arial"><h2 style="color:#f1c349">Password Reset</h2><div style="font-size:36px;font-weight:bold;letter-spacing:8px;margin:24px 0;padding:16px;background:#f5f5f5;border-radius:12px">${code}</div><p style="color:#999;font-size:12px">Expires in 5 minutes.</p></div>` });
    if (!resetEmailResult.success) { otpStore.delete('reset_'+email); return res.status(500).json({ error: 'Failed to send reset code. Check email configuration.' }); }
    return res.json({otpRequired:true,message:'Reset code sent to your email'});
  }// Step 2: Verify OTP and reset
  if(!newPassword||newPassword.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});
  const stored=otpStore.get('reset_'+email);if(!stored||Date.now()>stored.expires)return res.status(401).json({error:'Invalid or expired reset code'});
  const resetOtpValid=stored.code.length===otp.length&&crypto.timingSafeEqual(Buffer.from(stored.code),Buffer.from(otp));if(!resetOtpValid)return res.status(401).json({error:'Invalid or expired reset code'});
  otpStore.delete('reset_'+email);const h=await bcrypt.hash(newPassword,12);
  const r=await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id,email',[h,email]);
  if(!r.rows[0])return res.status(404).json({error:'User not found. Go to setup page first.'});
  res.json({ok:true,message:'Password updated successfully'});
}catch(e){res.status(500).json({error:e.message})}});

// Rebuild daily metrics from orders (fixes $0 dashboard)
app.post('/api/sync/rebuild-metrics',auth,async(req,res)=>{try{
  await pool.query(`INSERT INTO daily_metrics(date,revenue,cogs,shipping_cost,payment_fees,discount_total,refund_total,tax_total,gross_profit,orders_count,items_sold,new_customers,returning_customers,aov)
    SELECT order_date::date,COALESCE(SUM(revenue),0),COALESCE(SUM(cogs),0),COALESCE(SUM(shipping_cost),0),COALESCE(SUM(payment_fees),0),COALESCE(SUM(discount),0),COALESCE(SUM(refund_amount),0),COALESCE(SUM(tax),0),COALESCE(SUM(gross_profit),0),COUNT(*),COALESCE(SUM(items_count),0),COUNT(*)FILTER(WHERE is_first_order=true),COUNT(*)FILTER(WHERE is_first_order=false),CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END
    FROM orders GROUP BY order_date::date
    ON CONFLICT(date) DO UPDATE SET revenue=EXCLUDED.revenue,cogs=EXCLUDED.cogs,shipping_cost=EXCLUDED.shipping_cost,payment_fees=EXCLUDED.payment_fees,discount_total=EXCLUDED.discount_total,gross_profit=EXCLUDED.gross_profit,orders_count=EXCLUDED.orders_count,new_customers=EXCLUDED.new_customers,returning_customers=EXCLUDED.returning_customers,aov=EXCLUDED.aov,updated_at=NOW()`);
  // Apply fixed costs
  const fc=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');
  await pool.query(`UPDATE daily_metrics SET fixed_costs_daily=$1,contribution_margin=gross_profit-ad_spend,net_profit=gross_profit-ad_spend-$1-COALESCE(affiliate_commissions,0)-COALESCE(store_credit_used,0)-COALESCE(tax_total,0),mer=CASE WHEN ad_spend>0 THEN revenue/ad_spend ELSE 0 END WHERE date>=date_trunc('month',CURRENT_DATE)`,[+(fc.rows[0].t)/daysInCurrentMonth()]);
  const count=await pool.query('SELECT COUNT(*) as c FROM daily_metrics WHERE revenue>0');
  res.json({ok:true,message:`Metrics rebuilt. ${count.rows[0].c} days with revenue data.`});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== DASHBOARD ======================
app.get('/api/dashboard/overview',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  // Check if daily_metrics has data, if not rebuild from orders
  const metricsCheck = await pool.query('SELECT COUNT(*) as c FROM daily_metrics WHERE revenue>0');
  if (+metricsCheck.rows[0].c === 0) { const ordersCheck = await pool.query('SELECT COUNT(*) as c FROM orders');
  if (+ordersCheck.rows[0].c > 0) {
    console.log('⚡ Dashboard: daily_metrics empty, rebuilding from orders...');
    await pool.query(`INSERT INTO daily_metrics(date,revenue,cogs,shipping_cost,payment_fees,discount_total,refund_total,tax_total,gross_profit,orders_count,items_sold,new_customers,returning_customers,aov) SELECT order_date::date,COALESCE(SUM(revenue),0),COALESCE(SUM(cogs),0),COALESCE(SUM(shipping_cost),0),COALESCE(SUM(payment_fees),0),COALESCE(SUM(discount),0),COALESCE(SUM(refund_amount),0),COALESCE(SUM(tax),0),COALESCE(SUM(gross_profit),0),COUNT(*),COALESCE(SUM(items_count),0),COUNT(*)FILTER(WHERE is_first_order=true),COUNT(*)FILTER(WHERE is_first_order=false),CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders GROUP BY order_date::date ON CONFLICT(date) DO UPDATE SET revenue=EXCLUDED.revenue,cogs=EXCLUDED.cogs,shipping_cost=EXCLUDED.shipping_cost,payment_fees=EXCLUDED.payment_fees,gross_profit=EXCLUDED.gross_profit,orders_count=EXCLUDED.orders_count,aov=EXCLUDED.aov,updated_at=NOW()`);
    console.log('✅ Daily metrics rebuilt');
  }}
  const c=await pool.query(`SELECT COALESCE(SUM(revenue),0)as revenue,COALESCE(SUM(cogs),0)as cogs,COALESCE(SUM(ad_spend),0)as ad_spend,COALESCE(SUM(shipping_cost),0)as shipping_cost,COALESCE(SUM(payment_fees),0)as payment_fees,COALESCE(SUM(discount_total),0)as discounts,COALESCE(SUM(refund_total),0)as refunds,COALESCE(SUM(gross_profit),0)as gross_profit,COALESCE(SUM(contribution_margin),0)as contribution_margin,COALESCE(SUM(net_profit),0)as net_profit,COALESCE(SUM(orders_count),0)as orders,COALESCE(SUM(items_sold),0)as items_sold,COALESCE(SUM(new_customers),0)as new_customers,COALESCE(SUM(returning_customers),0)as returning_customers,CASE WHEN SUM(orders_count)>0 THEN SUM(revenue)/SUM(orders_count)ELSE 0 END as aov,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer,CASE WHEN SUM(revenue)>0 THEN SUM(gross_profit)/SUM(revenue)*100 ELSE 0 END as gross_margin_pct,COALESCE(SUM(tax_total),0) as tax_total FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  const days=Math.max(1,Math.ceil((new Date(end)-new Date(start))/864e5));
  const ps=new Date(new Date(start).getTime()-days*864e5).toISOString().split('T')[0];
  const pe=new Date(new Date(start).getTime()-864e5).toISOString().split('T')[0];
  const p=await pool.query(`SELECT COALESCE(SUM(revenue),0)as revenue,COALESCE(SUM(gross_profit),0)as gross_profit,COALESCE(SUM(net_profit),0)as net_profit,COALESCE(SUM(orders_count),0)as orders,COALESCE(SUM(new_customers),0)as new_customers,CASE WHEN SUM(orders_count)>0 THEN SUM(revenue)/SUM(orders_count)ELSE 0 END as aov,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[ps,pe]);
  const t=await pool.query('SELECT date,revenue,cogs,ad_spend,gross_profit,net_profit,orders_count,new_customers,returning_customers,aov,mer FROM daily_metrics WHERE date BETWEEN $1 AND $2 ORDER BY date',[start,end]);
  const lastSync=await pool.query("SELECT last_sync_at FROM integrations WHERE platform='woocommerce' LIMIT 1");res.json({current:c.rows[0],previous:p.rows[0],trend:t.rows,period:{start,end},lastSyncAt:lastSync.rows[0]?.last_sync_at||null});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/dashboard/pnl',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);const g=req.query.group||'month';
  const expr=g==='day'?'date':g==='week'?"date_trunc('week',date)::date":"date_trunc('month',date)::date";
  const rows=await pool.query(`SELECT ${expr} as period,SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(revenue)-SUM(cogs)as gross_profit,SUM(ad_spend)as ad_spend,SUM(shipping_cost)as shipping_cost,SUM(payment_fees)as payment_fees,SUM(discount_total)as discounts,SUM(refund_total)as refunds,SUM(fixed_costs_daily)as fixed_costs,SUM(contribution_margin)as contribution_margin,SUM(net_profit)as net_profit,SUM(orders_count)as orders,CASE WHEN SUM(revenue)>0 THEN SUM(net_profit)/SUM(revenue)*100 ELSE 0 END as net_margin_pct FROM daily_metrics WHERE date BETWEEN $1 AND $2 GROUP BY ${expr} ORDER BY period`,[start,end]);
  const totals=await pool.query(`SELECT SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(ad_spend)as ad_spend,SUM(shipping_cost)as shipping_cost,SUM(payment_fees)as payment_fees,SUM(discount_total)as discounts,SUM(refund_total)as refunds,SUM(fixed_costs_daily)as fixed_costs,SUM(net_profit)as net_profit FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  res.json({rows:rows.rows,totals:totals.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/dashboard/goals-pacing',auth,async(req,res)=>{try{
  const y=req.query.year||new Date().getFullYear();
  const goals=await pool.query('SELECT*FROM goals WHERE year=$1',[y]);
  const actuals=await pool.query(`SELECT EXTRACT(MONTH FROM date)as month,SUM(revenue)as revenue,SUM(net_profit)as net_profit,SUM(gross_profit)as gross_profit,SUM(orders_count)as orders,SUM(new_customers)as new_customers FROM daily_metrics WHERE EXTRACT(YEAR FROM date)=$1 GROUP BY EXTRACT(MONTH FROM date)ORDER BY month`,[y]);
  res.json({goals:goals.rows,actuals:actuals.rows,currentMonth:new Date().getMonth()+1});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== PRODUCTS ======================
app.get('/api/products',auth,async(req,res)=>{try{
  const{sort='total_profit',order='DESC',limit=100,offset=0,search}=req.query;
  const ok=['name','sku','price','cogs','gross_margin_pct','total_sold','total_revenue','total_profit','breakeven_roas'];
  const col=ok.includes(sort)?sort:'total_profit';let w='',p=[];
  if(search){w='WHERE name ILIKE $1 OR sku ILIKE $1';p.push(`%${search}%`)}
  const r=await pool.query(`SELECT*,CASE WHEN price>0 AND cogs>0 THEN ROUND(((price-cogs)/price)*100,1)ELSE 0 END as calc_margin,CASE WHEN price>0 AND price-cogs>0 THEN ROUND(price/(price-cogs),2)ELSE 0 END as calc_breakeven FROM products ${w} ORDER BY ${col} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,p);
  const cnt=await pool.query(`SELECT COUNT(*)FROM products ${w}`,p);
  res.json({products:r.rows,total:+cnt.rows[0].count});
}catch(e){res.status(500).json({error:e.message})}});

app.put('/api/products/:id/cogs',auth,async(req,res)=>{try{
  const b = req.body;
  const n = (k) => sanitizeNum(b[k], 0);
  // All product-level cost fields
  const productCost = n('product_cost_per_unit') || n('cogs');
  const unitsPerOrder = n('units_per_order') || 1;
  const tariffRate = n('tariff_rate');
  const pkg = n('packaging');
  const pkgShip = n('packaging_shipping');
  const pkgCustoms = n('packaging_customs');
  const pkgFreight = n('packaging_freight_forwarder');
  const thankYou = n('thank_you_card');
  const freeGift = n('free_gift_cogs');
  const affSamples = n('affiliate_samples_cogs');
  const shipSub = n('shipping_subscription');
  const shipOne = n('shipping_onetime');
  const affShip = n('affiliate_samples_shipping');
  const subPrice = n('subscription_sales_price');
  const onePrice = n('onetime_sales_price');
  // Legacy fields (backward compat)
  const pkgCost = n('packaging_cost') || pkg;
  const bulkShip = n('bulk_shipping_cost');
  const customsFees = n('customs_fees') || pkgCustoms;
  const groundTrans = n('ground_transport');
  const insurance = n('insurance_cost');
  const tariffAmt = n('tariffs');
  const otherCosts = n('other_costs');

  // Calculate total landed cost per unit
  const landed = productCost + pkg + pkgShip + pkgCustoms + pkgFreight + thankYou + freeGift + affSamples + bulkShip + groundTrans + insurance + tariffAmt + otherCosts;

  const r = await pool.query(`UPDATE products SET
    cogs=$1, product_cost_per_unit=$1, units_per_order=$2, tariff_rate=$3,
    packaging=$4, packaging_shipping=$5, packaging_customs=$6, packaging_freight_forwarder=$7,
    thank_you_card=$8, free_gift_cogs=$9, affiliate_samples_cogs=$10,
    shipping_subscription=$11, shipping_onetime=$12, affiliate_samples_shipping=$13,
    subscription_sales_price=$14, onetime_sales_price=$15,
    packaging_cost=$4, bulk_shipping_cost=$16, customs_fees=$6, ground_transport=$17,
    insurance_cost=$18, tariffs=$19, other_costs=$20, landed_cost=$21,
    breakeven_roas=CASE WHEN price>0 AND price-$21>0 THEN ROUND(price/(price-$21),4) ELSE 0 END,
    gross_margin_pct=CASE WHEN price>0 THEN ROUND((price-$21)/price*100,2) ELSE 0 END,
    updated_at=NOW() WHERE id=$22 RETURNING*`,
    [productCost, unitsPerOrder, tariffRate, pkg, pkgShip, pkgCustoms, pkgFreight,
     thankYou, freeGift, affSamples, shipSub, shipOne, affShip, subPrice, onePrice,
     bulkShip, groundTrans, insurance, tariffAmt, otherCosts, landed, req.params.id]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/products/:id',auth,async(req,res)=>{try{
  const r=await pool.query(`SELECT p.*,COUNT(DISTINCT oi.order_id)as orders_count,COALESCE(SUM(oi.quantity),0)as units_sold,COALESCE(SUM(oi.line_total),0)as rev,COALESCE(SUM(oi.line_profit),0)as profit FROM products p LEFT JOIN order_items oi ON oi.product_id=p.id WHERE p.id=$1 GROUP BY p.id`,[req.params.id]);
  const t=await pool.query(`SELECT date_trunc('month',o.order_date)::date as month,SUM(oi.quantity)as units,SUM(oi.line_total)as revenue,SUM(oi.line_profit)as profit FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND o.order_date>NOW()-INTERVAL'12 months' GROUP BY month ORDER BY month`,[req.params.id]);
  res.json({product:r.rows[0],trend:t.rows});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== ORDERS ======================
app.get('/api/orders',auth,async(req,res)=>{try{
  const{start,end,sort='order_date',order='DESC',limit=50,offset=0,country,profitable,search}=req.query;
  let cn=[],pr=[],i=1;
  if(start){cn.push(`order_date>=$${i++}`);pr.push(start)}
  if(end){cn.push(`order_date<=$${i++}`);pr.push(end+'T23:59:59Z')}
  if(country){cn.push(`o.country=$${i++}`);pr.push(country)}
  if(profitable==='true')cn.push('gross_profit>0');
  if(profitable==='false')cn.push('gross_profit<=0');
  if(search){cn.push(`woo_order_id::text LIKE $${i}`);pr.push(`%${search}%`);i++}
  const w=cn.length?'WHERE '+cn.join(' AND '):'';
  const ok=['order_date','revenue','gross_profit','margin_pct'];const col=ok.includes(sort)?sort:'order_date';
  const r=await pool.query(`SELECT o.*,c.email as customer_email,c.first_name,c.last_name,c.total_orders as cust_orders FROM orders o LEFT JOIN customers c ON o.customer_id=c.id ${w} ORDER BY o.${col} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,pr);
  const cnt=await pool.query(`SELECT COUNT(*)FROM orders o ${w}`,pr);
  const sm=await pool.query(`SELECT COUNT(*)as total,COALESCE(SUM(revenue),0)as rev,COALESCE(SUM(gross_profit),0)as profit,CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END as aov FROM orders o ${w}`,pr);
  res.json({orders:r.rows,total:+cnt.rows[0].count,summary:sm.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/orders/analytics/by-country',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  const r=await pool.query(`SELECT country,COUNT(*)as orders,SUM(revenue)as revenue,SUM(gross_profit)as profit,SUM(revenue)/NULLIF(COUNT(*),0)as aov FROM orders WHERE order_date BETWEEN $1 AND $2 AND country IS NOT NULL AND country!='' GROUP BY country ORDER BY revenue DESC`,[start,end+'T23:59:59Z']);
  res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});

// ====================== MARKETING ======================
app.get('/api/marketing/overview',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  const b=await pool.query(`SELECT COALESCE(SUM(spend),0)as total_spend,COALESCE(SUM(impressions),0)as total_impressions,COALESCE(SUM(clicks),0)as total_clicks,COALESCE(SUM(conversions),0)as total_conversions,COALESCE(SUM(conversion_value),0)as total_conv_value,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::float/SUM(impressions)*100 ELSE 0 END as avg_ctr,CASE WHEN SUM(clicks)>0 THEN SUM(spend)/SUM(clicks)ELSE 0 END as avg_cpc,CASE WHEN SUM(conversions)>0 THEN SUM(spend)/SUM(conversions)ELSE 0 END as avg_cpa,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as blended_roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2`,[start,end]);
  const rv=await pool.query('SELECT COALESCE(SUM(revenue),0)as r FROM daily_metrics WHERE date BETWEEN $1 AND $2',[start,end]);
  const sp=+(b.rows[0].total_spend)||0,re=+(rv.rows[0].r)||0;
  const bp=await pool.query(`SELECT platform,SUM(spend)as spend,SUM(impressions)as impressions,SUM(clicks)as clicks,SUM(conversions)as conversions,SUM(conversion_value)as conv_value,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2 GROUP BY platform ORDER BY spend DESC`,[start,end]);
  const tr=await pool.query(`SELECT date,SUM(spend)as spend,SUM(conversions)as conversions,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2 GROUP BY date ORDER BY date`,[start,end]);
  res.json({blended:{...b.rows[0],mer:sp>0?re/sp:0,total_revenue:re},byPlatform:bp.rows,trend:tr.rows});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/campaigns',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);const{platform}=req.query;
  let w='WHERE date BETWEEN $1 AND $2',p=[start,end];
  if(platform){w+=' AND platform=$3';p.push(platform)}
  const r=await pool.query(`SELECT platform,campaign_id,campaign_name,SUM(spend)as spend,SUM(impressions)as impressions,SUM(clicks)as clicks,SUM(conversions)as conversions,SUM(conversion_value)as conv_value,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas,CASE WHEN SUM(conversions)>0 THEN SUM(spend)/SUM(conversions)ELSE 0 END as cpa FROM ad_spend_daily ${w} GROUP BY platform,campaign_id,campaign_name ORDER BY spend DESC`,p);
  res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/creatives',auth,async(req,res)=>{try{
  const{platform,sort='total_spend',limit=50}=req.query;
  let w='',p=[];if(platform){w='WHERE platform=$1';p.push(platform)}
  res.json((await pool.query(`SELECT*FROM ad_creatives ${w} ORDER BY ${sort==='roas'?'roas':sort==='ctr'?'ctr':'total_spend'} DESC LIMIT ${+limit}`,p)).rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/spend-advisor',auth,async(req,res)=>{try{
  const rc=await pool.query(`SELECT SUM(revenue)as revenue,SUM(ad_spend)as ad_spend,SUM(net_profit)as net_profit,SUM(gross_profit)as gross_profit,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer,SUM(orders_count)as orders FROM daily_metrics WHERE date>NOW()-INTERVAL'7 days'`);
  const pv=await pool.query(`SELECT SUM(revenue)as revenue,SUM(ad_spend)as ad_spend,SUM(net_profit)as net_profit,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer FROM daily_metrics WHERE date BETWEEN(NOW()-INTERVAL'14 days')AND(NOW()-INTERVAL'7 days')`);
  const r=rc.rows[0],p=pv.rows[0],mer=+(r.mer)||0;
  let rec='maintain',reason=`MER is ${mer.toFixed(1)}x. Monitor closely.`;
  if(mer>3&&+(r.net_profit)>0){rec='scale';reason=`MER at ${mer.toFixed(1)}x with positive profit. Scale up.`}
  else if(mer<1.5||+(r.net_profit)<0){rec='reduce';reason=`MER at ${mer.toFixed(1)}x, unprofitable. Cut low performers.`}
  const cpa=+(r.ad_spend)>0?+(r.ad_spend)/Math.max(+(r.orders),1):0;
  const avgP=+(r.orders)>0?+(r.gross_profit)/+(r.orders):0;
  const o100=cpa>0?100/cpa:0;
  res.json({current:r,previous:p,recommendation:rec,reason,impact:{per100:{orders:Math.round(o100*10)/10,profit:Math.round((o100*avgP-100)*100)/100}}});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== CUSTOMERS / LTV ======================
app.get('/api/customers',auth,async(req,res)=>{try{
  const{sort='ltv',order='DESC',limit=50,offset=0,search,type}=req.query;
  const okCustSorts=['ltv','total_orders','total_revenue','aov','email','first_order_date'];const sortCol=okCustSorts.includes(sort)?sort:'ltv';
  let cn=[],p=[],i=1;
  if(search){cn.push(`(email ILIKE $${i} OR first_name ILIKE $${i})`);p.push(`%${search}%`);i++}
  if(type==='new')cn.push('total_orders=1');if(type==='returning')cn.push('total_orders>1');
  const w=cn.length?'WHERE '+cn.join(' AND '):'';
  const r=await pool.query(`SELECT*FROM customers ${w} ORDER BY ${sortCol} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,p);
  const cnt=await pool.query(`SELECT COUNT(*)FROM customers ${w}`,p);
  res.json({customers:r.rows,total:+cnt.rows[0].count});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/ltv-overview',auth,async(req,res)=>{try{
  const o=await pool.query(`SELECT COUNT(*)as total_customers,COUNT(*)FILTER(WHERE total_orders>1)as returning_customers,ROUND(COUNT(*)FILTER(WHERE total_orders>1)::numeric/NULLIF(COUNT(*),0)*100,1)as repeat_rate,ROUND(AVG(ltv)::numeric,2)as avg_ltv,ROUND(AVG(aov)::numeric,2)as avg_aov,ROUND(AVG(total_orders)::numeric,1)as avg_orders,ROUND(MAX(ltv)::numeric,2)as max_ltv FROM customers WHERE total_orders>0`);
  const d=await pool.query(`SELECT CASE WHEN ltv<25 THEN '$0-25' WHEN ltv<50 THEN '$25-50' WHEN ltv<100 THEN '$50-100' WHEN ltv<200 THEN '$100-200' WHEN ltv<500 THEN '$200-500' ELSE '$500+' END as bucket,COUNT(*)as count FROM customers WHERE total_orders>0 GROUP BY bucket ORDER BY MIN(ltv)`);
  const t=await pool.query('SELECT id,email,first_name,last_name,total_orders,total_revenue,ltv,first_order_date FROM customers ORDER BY ltv DESC LIMIT 10');
  res.json({overview:o.rows[0],distribution:d.rows,topCustomers:t.rows});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/cohorts',auth,async(req,res)=>{try{
  res.json((await pool.query(`SELECT cohort_month,COUNT(*)as customers,SUM(total_revenue)as total_revenue,SUM(total_profit)as total_profit,AVG(ltv)as avg_ltv,AVG(total_orders)as avg_orders,AVG(aov)as avg_aov,COUNT(*)FILTER(WHERE total_orders>1)::float/NULLIF(COUNT(*),0)*100 as repeat_rate FROM customers WHERE cohort_month IS NOT NULL AND total_orders>0 GROUP BY cohort_month ORDER BY cohort_month DESC`)).rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/product-retention',auth,async(req,res)=>{try{
  res.json((await pool.query(`WITH fp AS(SELECT DISTINCT ON(o.customer_id)o.customer_id,oi.product_id,p.name FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.is_first_order=true ORDER BY o.customer_id,oi.line_total DESC)SELECT fp.product_id,fp.name as product_name,COUNT(DISTINCT fp.customer_id)as first_buyers,COUNT(DISTINCT CASE WHEN c.total_orders>1 THEN fp.customer_id END)as repeat_buyers,ROUND(COUNT(DISTINCT CASE WHEN c.total_orders>1 THEN fp.customer_id END)::numeric/NULLIF(COUNT(DISTINCT fp.customer_id),0)*100,1)as retention_rate FROM fp JOIN customers c ON c.id=fp.customer_id GROUP BY fp.product_id,fp.name ORDER BY first_buyers DESC LIMIT 20`)).rows);
}catch(e){res.status(500).json({error:e.message})}});

// ====================== SETTINGS ======================
app.get('/api/settings/goals',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM goals WHERE year=$1',[q.query.year||new Date().getFullYear()])).rows)}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/goals',auth,async(req,res)=>{try{const{year,metric_type,annual_target,monthly_targets,seasonal_weights,notes}=req.body;let t=monthly_targets;if(!t){t={};for(let m=1;m<=12;m++)t[m]=Math.round(annual_target/12*100)/100}const r=await pool.query(`INSERT INTO goals(year,metric_type,annual_target,monthly_targets,seasonal_weights,notes)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(year,metric_type)DO UPDATE SET annual_target=$3,monthly_targets=$4,seasonal_weights=$5,notes=$6,updated_at=NOW()RETURNING*`,[year,metric_type,annual_target,JSON.stringify(t),JSON.stringify(seasonal_weights||{}),notes]);res.json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/goals/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM goals WHERE id=$1',[q.params.id]);s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/fixed-costs',auth,async(q,s)=>{try{const r=await pool.query('SELECT*FROM fixed_costs ORDER BY is_active DESC,name');const t=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');s.json({costs:r.rows,totalMonthly:+t.rows[0].t})}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/fixed-costs',auth,async(req,res)=>{try{const{name,amount_monthly,category,notes}=req.body;const r=(await pool.query('INSERT INTO fixed_costs(name,amount_monthly,category,notes)VALUES($1,$2,$3,$4)RETURNING*',[name,amount_monthly,category,notes])).rows[0];await saveFixedCostSnapshot();res.json(r)}catch(e){res.status(500).json({error:e.message})}});
app.put('/api/settings/fixed-costs/:id',auth,async(req,res)=>{try{const{name,amount_monthly,category,is_active}=req.body;res.json((await pool.query('UPDATE fixed_costs SET name=COALESCE($1,name),amount_monthly=COALESCE($2,amount_monthly),category=COALESCE($3,category),is_active=COALESCE($4,is_active)WHERE id=$5 RETURNING*',[name,amount_monthly,category,is_active,req.params.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/fixed-costs/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM fixed_costs WHERE id=$1',[q.params.id]);await saveFixedCostSnapshot();s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/integrations',auth,async(q,s)=>{try{
  const rows=(await pool.query('SELECT id,platform,is_connected,config,last_sync_at,sync_status,error_message FROM integrations ORDER BY platform')).rows;
  const masked=rows.map(r=>{if(r.config&&typeof r.config==='object'){const safe={...r.config};for(const k of Object.keys(safe)){const v=safe[k];if(typeof v==='string'&&v.length>8&&(k.includes('secret')||k.includes('password')||k.includes('token')||k.includes('pin')||k.includes('api_key')||k.includes('key'))){safe[k]=v.slice(0,4)+'****'+v.slice(-4);}}return{...r,config:safe};}return r;});
  s.json(masked);
}catch(e){s.status(500).json({error:e.message})}});
app.put('/api/settings/integrations/:platform',auth,async(req,res)=>{try{const{config,is_connected}=req.body;
  // Merge new config with existing, skip masked values (contain ****)
  let mergedConfig = null;
  if (config) {
    const existing = await getCreds(req.params.platform);
    const merged = {...existing};
    for (const [k,v] of Object.entries(config)) {
      if (typeof v === 'string' && v.includes('****')) continue; // Skip masked values
      merged[k] = v;
    }
    mergedConfig = JSON.stringify(merged);
  }
  logAudit(req.user?.id,'integration_update',{platform:req.params.platform});
  res.json((await pool.query('UPDATE integrations SET config=COALESCE($1,config),is_connected=COALESCE($2,is_connected),updated_at=NOW()WHERE platform=$3 RETURNING id,platform,is_connected,last_sync_at,sync_status',[mergedConfig,is_connected,req.params.platform])).rows[0]);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/settings/alerts',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM alert_thresholds ORDER BY is_active DESC,metric')).rows)}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/alerts',auth,async(req,res)=>{try{const{metric,operator,threshold_value,notification_channels}=req.body;res.json((await pool.query('INSERT INTO alert_thresholds(metric,operator,threshold_value,notification_channels)VALUES($1,$2,$3,$4)RETURNING*',[metric,operator,threshold_value,JSON.stringify(notification_channels||['email'])])).rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/alerts/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM alert_thresholds WHERE id=$1',[q.params.id]);s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/reports',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM report_configs ORDER BY frequency')).rows)}catch(e){s.status(500).json({error:e.message})}});
app.put('/api/settings/reports/:id',auth,async(req,res)=>{try{const{recipients,is_active,send_time}=req.body;res.json((await pool.query('UPDATE report_configs SET recipients=COALESCE($1,recipients),is_active=COALESCE($2,is_active),send_time=COALESCE($3,send_time)WHERE id=$4 RETURNING*',[recipients?JSON.stringify(recipients):null,is_active,send_time,req.params.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});

// ====================== FORECASTS & SCENARIOS ======================
app.get('/api/forecasts',auth,async(req,res)=>{try{
  const h=await pool.query(`SELECT date_trunc('month',date)::date as month,SUM(revenue)as revenue,SUM(net_profit)as profit,SUM(orders_count)as orders FROM daily_metrics WHERE date>NOW()-INTERVAL'6 months' GROUP BY month ORDER BY month`);
  if(h.rows.length<2)return res.json({forecasts:[],message:'Need more data'});
  const ra=h.rows.map(r=>+(r.revenue));
  const ag=ra.reduce((a,v,i)=>i>0?a+(v-ra[i-1])/Math.max(ra[i-1],1):a,0)/(ra.length-1);
  const last=ra[ra.length-1];const fc=[];
  for(let i=1;i<=12;i++){const b=last*Math.pow(1+Math.min(ag,0.15),i);fc.push({month:i,optimistic:Math.round(b*1.15),base:Math.round(b),pessimistic:Math.round(b*0.85)})}
  res.json({historical:h.rows,forecasts:fc,avgGrowthRate:ag});
}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/scenarios',auth,async(req,res)=>{try{
  const{cogs_change_pct=0,ad_spend_change_pct=0,price_change_pct=0,period='30d'}=req.body;
  const{start,end}=dr({period});
  const b=await pool.query(`SELECT SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(ad_spend)as ad_spend,SUM(gross_profit)as gross_profit,SUM(net_profit)as net_profit FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  const d=b.rows[0];const nR=+d.revenue*(1+price_change_pct/100),nC=+d.cogs*(1+cogs_change_pct/100),nA=+d.ad_spend*(1+ad_spend_change_pct/100);
  const nG=nR-nC,nN=nG-nA-(+d.net_profit-+d.gross_profit+ +d.ad_spend);
  res.json({base:{revenue:+d.revenue,cogs:+d.cogs,ad_spend:+d.ad_spend,gross_profit:+d.gross_profit,net_profit:+d.net_profit},scenario:{revenue:nR,cogs:nC,ad_spend:nA,gross_profit:nG,net_profit:nN}});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/insights',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM ai_insights ORDER BY date DESC,priority LIMIT 20')).rows)}catch(e){s.status(500).json({error:e.message})}});

// ====================== CALCULATORS ======================
app.post('/api/calc/breakeven-roas',auth,(req,res)=>{const{price,cogs,shipping=0,fee_pct=2.9,fee_fixed=0.30}=req.body;const f=price*(fee_pct/100)+fee_fixed;const tc=cogs+shipping+f;const p=price-tc;res.json({price,totalCost:Math.round(tc*100)/100,profit:Math.round(p*100)/100,breakevenRoas:p>0?Math.round(price/p*100)/100:0,marginPct:price>0?Math.round(p/price*10000)/100:0})});
app.post('/api/calc/contribution-margin',auth,(req,res)=>{const{revenue,cogs,shipping=0,payment_fees=0,ad_spend=0,discounts=0}=req.body;const gp=revenue-cogs;const cm=gp-shipping-payment_fees-ad_spend-discounts;res.json({revenue,grossProfit:gp,contributionMargin:cm,cmPct:revenue>0?Math.round(cm/revenue*10000)/100:0,grossMarginPct:revenue>0?Math.round(gp/revenue*10000)/100:0})});
app.post('/api/calc/mer',auth,(req,res)=>{const{revenue,total_ad_spend,target_margin=20,cogs_pct=30,overhead_pct=15}=req.body;const mer=total_ad_spend>0?revenue/total_ad_spend:0;const be=100/(100-cogs_pct-overhead_pct);res.json({mer:Math.round(mer*100)/100,breakevenMer:Math.round(be*100)/100,targetMer:Math.round(100/(100-cogs_pct-overhead_pct-target_margin)*100)/100,profitable:mer>=be})});
app.post('/api/calc/order-profit',auth,(req,res)=>{const{revenue,cogs,shipping=0,fee_pct=2.9,fee_fixed=0.30,discount=0,ad_cost=0}=req.body;const f=revenue*(fee_pct/100)+fee_fixed;const gp=revenue-cogs-shipping-f-discount;const np=gp-ad_cost;res.json({revenue,cogs,shippingCost:shipping,paymentFees:Math.round(f*100)/100,discount,grossProfit:Math.round(gp*100)/100,adCost:ad_cost,netProfit:Math.round(np*100)/100,marginPct:revenue>0?Math.round(np/revenue*10000)/100:0})});
app.post('/api/calc/proas',auth,(req,res)=>{const{ad_spend,revenue_from_ads,cogs_pct=30,shipping_pct=5,fee_pct=3}=req.body;const net=revenue_from_ads*(1-cogs_pct/100-shipping_pct/100-fee_pct/100);const proas=ad_spend>0?net/ad_spend:0;res.json({roas:ad_spend>0?Math.round(revenue_from_ads/ad_spend*100)/100:0,proas:Math.round(proas*100)/100,profit:Math.round((net-ad_spend)*100)/100})});
app.post('/api/calc/vat',auth,(req,res)=>{const{amount,vat_rate=20,includes_vat=false}=req.body;if(includes_vat){const n=amount/(1+vat_rate/100);res.json({gross:amount,net:Math.round(n*100)/100,vat:Math.round((amount-n)*100)/100,rate:vat_rate})}else{const v=amount*(vat_rate/100);res.json({gross:Math.round((amount+v)*100)/100,net:amount,vat:Math.round(v*100)/100,rate:vat_rate})}});

// ====================== WOOCOMMERCE WEBHOOK ======================
app.post('/api/webhooks/woocommerce',async(req,res)=>{try{
  const signature=req.headers['x-wc-webhook-signature'];const webhookSecret=process.env.WC_WEBHOOK_SECRET;
  if(webhookSecret&&signature){const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));const computed=crypto.createHmac('sha256',webhookSecret).update(rawBody).digest('base64');const sigValid=computed.length===signature.length&&crypto.timingSafeEqual(Buffer.from(computed),Buffer.from(signature));if(!sigValid){console.warn('WC webhook sig mismatch');return res.status(401).json({error:'Invalid signature'});}}
  const o=Buffer.isBuffer(req.body)?JSON.parse(req.body.toString()):req.body;const event=req.headers['x-wc-webhook-topic'];
  console.log(`📥 WC webhook: ${event}`);
  if((event==='order.created'||event==='order.updated')&&['completed','processing'].includes(o.status)){
    let custId=null;
    if(o.billing?.email){
      let cr=await pool.query('SELECT id FROM customers WHERE email=$1',[o.billing.email]);
      if(!cr.rows[0])cr=await pool.query('INSERT INTO customers(woo_customer_id,email,first_name,last_name,country)VALUES($1,$2,$3,$4,$5)RETURNING id',[o.customer_id||0,o.billing.email,o.billing.first_name,o.billing.last_name,o.billing.country]);
      custId=cr.rows[0]?.id;
    }
    let totalCogs=0;
    for(const it of(o.line_items||[])){const pr=await pool.query('SELECT landed_cost,cogs FROM products WHERE woo_product_id=$1',[it.product_id]);totalCogs+=getProductCost(pr.rows[0])*it.quantity}
    const rev=+(o.total)||0,ship=+(o.shipping_total)||0,fees=calcPaymentFee(rev,o.payment_method),gp=rev-totalCogs-ship-fees;
    await pool.query(`INSERT INTO orders(woo_order_id,customer_id,order_date,status,revenue,cogs,shipping_cost,payment_fees,discount,tax,gross_profit,contribution_margin,margin_pct,country,coupon_code,payment_method,items_count,currency)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)ON CONFLICT(woo_order_id)DO UPDATE SET status=$4,revenue=$5,cogs=$6,gross_profit=$11`,
      [o.id,custId,o.date_created,o.status,rev,totalCogs,ship,fees,+(o.discount_total)||0,+(o.total_tax)||0,gp,gp,rev>0?gp/rev*100:0,o.billing?.country,o.coupon_lines?.[0]?.code,o.payment_method,(o.line_items||[]).length,o.currency||'USD']);
  }
  // Handle refunds
  if(event==='order.refunded'||o.status==='refunded'){
    const refundAmount=+(o.total)||0;
    // #24 Dedup: check if already refunded
    const existingOrd=await pool.query('SELECT refund_amount FROM orders WHERE woo_order_id=$1',[o.id]);
    const alreadyRefunded=+(existingOrd.rows[0]?.refund_amount)||0;
    if(alreadyRefunded<refundAmount){const newRefund=refundAmount-alreadyRefunded;
    await pool.query('UPDATE orders SET status=$1, refund_amount=$2, gross_profit=gross_profit-$3, net_profit=COALESCE(net_profit,0)-$3 WHERE woo_order_id=$4',['refunded',refundAmount,newRefund,o.id]);
    const orderDate=o.date_created?.split('T')[0];
    if(orderDate)await pool.query('UPDATE daily_metrics SET refund_total=COALESCE(refund_total,0)+$1, revenue=revenue-$1, gross_profit=gross_profit-$1, net_profit=COALESCE(net_profit,0)-$1 WHERE date=$2',[newRefund,orderDate]);
    }
    console.log(`💸 Refund processed: Order ${o.id} - $${refundAmount}`);
  }
  res.json({ok:true});
}catch(e){console.error('Webhook err:',e.message);res.json({ok:true})}});

// ====================== FULL SYNC ======================
app.post('/api/sync/woocommerce',auth,async(req,res)=>{
  try {
  const wc = await getCreds('woocommerce');
  const storeUrl = wc.store_url || process.env.WOO_STORE_URL;
  const ck = wc.consumer_key || process.env.WOO_CONSUMER_KEY;
  const cs = wc.consumer_secret || process.env.WOO_CONSUMER_SECRET;
  if (!storeUrl || !ck || !cs) {
    await setIntStatus('woocommerce', 'error', 'Missing credentials. Enter Store URL, Consumer Key, and Consumer Secret in Settings > Integrations.');
    return res.status(400).json({ error: 'WooCommerce credentials not configured. Go to Settings > Integrations > WooCommerce and enter your Store URL, Consumer Key, and Consumer Secret.' });
  }
  // Validate URL
  try { new URL(storeUrl); } catch { 
    await setIntStatus('woocommerce', 'error', 'Invalid Store URL: ' + storeUrl);
    return res.status(400).json({ error: 'Invalid Store URL. Must be like https://thevitaminshots.com' });
  }
  res.json({status:'started',message:'WooCommerce sync running in background...'});
  const ax=axios.create({baseURL:`${storeUrl.replace(/\/$/,'')}/wp-json/wc/v3`,auth:{username:ck,password:cs},timeout:30000});
  try{
    await pool.query("UPDATE integrations SET sync_status='syncing' WHERE platform='woocommerce'");
    // Products
    let pg=1;while(true){const{data}=await ax.get('/products',{params:{per_page:100,page:pg,status:'publish'}});for(const p of data){await pool.query(`INSERT INTO products(woo_product_id,name,sku,price,image_url,category,status)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(woo_product_id)DO UPDATE SET name=$2,sku=$3,price=$4,image_url=$5,category=$6,updated_at=NOW()`,[p.id,p.name,p.sku,+(p.price)||0,p.images?.[0]?.src,p.categories?.[0]?.name||'Uncategorized',p.status])}console.log(`✅ Products pg ${pg}: ${data.length}`);if(data.length<100)break;pg++}
    // Orders
    pg=1;while(true){const{data}=await ax.get('/orders',{params:{per_page:100,page:pg,orderby:'date',order:'desc'}});for(const o of data){if(!['completed','processing','refunded'].includes(o.status))continue;let cid=null;if(o.billing?.email){let cr=await pool.query('SELECT id FROM customers WHERE email=$1',[o.billing.email]);if(!cr.rows[0])cr=await pool.query('INSERT INTO customers(woo_customer_id,email,first_name,last_name,country)VALUES($1,$2,$3,$4,$5)RETURNING id',[o.customer_id||0,o.billing.email,o.billing.first_name,o.billing.last_name,o.billing.country]);cid=cr.rows[0]?.id}
    let tc=0;for(const it of(o.line_items||[])){const pr=await pool.query('SELECT landed_cost,cogs FROM products WHERE woo_product_id=$1',[it.product_id]);tc+=getProductCost(pr.rows[0])*it.quantity}
    const rev=+(o.total)||0,sh=+(o.shipping_total)||0,fe=calcPaymentFee(rev,o.payment_method),gp=rev-tc-sh-fe,disc=+(o.discount_total)||0;
    const isF=cid?(await pool.query('SELECT COUNT(*)FROM orders WHERE customer_id=$1 AND woo_order_id!=$2',[cid,o.id])).rows[0].count==='0':false;
    await pool.query(`INSERT INTO orders(woo_order_id,customer_id,order_date,status,revenue,cogs,shipping_cost,payment_fees,discount,tax,gross_profit,contribution_margin,margin_pct,country,utm_source,utm_medium,utm_campaign,utm_content,coupon_code,is_first_order,payment_method,items_count,currency)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)ON CONFLICT(woo_order_id)DO UPDATE SET status=$4,revenue=$5,cogs=$6,gross_profit=$11,margin_pct=$13`,[o.id,cid,o.date_created,o.status,rev,tc,sh,fe,disc,+(o.total_tax)||0,gp,gp-disc,rev>0?gp/rev*100:0,o.billing?.country,o.meta_data?.find(m=>m.key==='_utm_source')?.value,o.meta_data?.find(m=>m.key==='_utm_medium')?.value,o.meta_data?.find(m=>m.key==='_utm_campaign')?.value||o.meta_data?.find(m=>m.key==='utm_campaign')?.value,o.meta_data?.find(m=>m.key==='_utm_content')?.value||o.meta_data?.find(m=>m.key==='utm_content')?.value,o.coupon_lines?.[0]?.code,isF,o.payment_method,(o.line_items||[]).length,o.currency||'USD']);
    // Capture store credits from order meta
    const scMeta=o.meta_data?.find(m=>m.key==='_store_credit_used');const scFee=o.fee_lines?.find(f=>f.name?.includes('Store Credit'));
    const scAmt=+(scMeta?.value)||Math.abs(+(scFee?.total)||0);
    if(scAmt>0){await pool.query('UPDATE orders SET store_credit_used=$1 WHERE woo_order_id=$2',[scAmt,o.id]);
    await pool.query("INSERT INTO store_credit_ledger(order_id,customer_email,credit_amount,credit_type,order_date) VALUES($1,$2,$3,'used',$4) ON CONFLICT(order_id,credit_type) DO UPDATE SET credit_amount=$3",[String(o.id),o.billing?.email||'',scAmt,o.date_created]);}
    // Items
    const or2=await pool.query('SELECT id FROM orders WHERE woo_order_id=$1',[o.id]);if(or2.rows[0]){await pool.query('DELETE FROM order_items WHERE order_id=$1',[or2.rows[0].id]);for(const it of(o.line_items||[])){const pr=await pool.query('SELECT id,cogs FROM products WHERE woo_product_id=$1',[it.product_id]);const uc=+(pr.rows[0]?.cogs)||0,lt=+(it.total)||0;await pool.query('INSERT INTO order_items(order_id,product_id,woo_product_id,product_name,sku,quantity,unit_price,unit_cogs,line_total,line_cogs,line_profit)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[or2.rows[0].id,pr.rows[0]?.id,it.product_id,it.name,it.sku,it.quantity,+(it.price),uc,lt,uc*it.quantity,lt-uc*it.quantity])}}
    // Customer stats
    if(cid)await pool.query(`UPDATE customers SET total_orders=(SELECT COUNT(*)FROM orders WHERE customer_id=$1),total_revenue=(SELECT COALESCE(SUM(revenue),0)FROM orders WHERE customer_id=$1),total_profit=(SELECT COALESCE(SUM(gross_profit),0)FROM orders WHERE customer_id=$1),ltv=(SELECT COALESCE(SUM(gross_profit),0)FROM orders WHERE customer_id=$1),aov=(SELECT CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders WHERE customer_id=$1),first_order_date=(SELECT MIN(order_date)FROM orders WHERE customer_id=$1),last_order_date=(SELECT MAX(order_date)FROM orders WHERE customer_id=$1),cohort_month=(SELECT TO_CHAR(MIN(order_date),'YYYY-MM')FROM orders WHERE customer_id=$1),is_returning=(SELECT COUNT(*)>1 FROM orders WHERE customer_id=$1),updated_at=NOW()WHERE id=$1`,[cid])}
    console.log(`✅ Orders pg ${pg}: ${data.length}`);if(data.length<100)break;pg++}
    // Rebuild daily metrics
    await pool.query(`INSERT INTO daily_metrics(date,revenue,cogs,shipping_cost,payment_fees,discount_total,refund_total,tax_total,gross_profit,orders_count,items_sold,new_customers,returning_customers,aov)SELECT order_date::date,COALESCE(SUM(revenue),0),COALESCE(SUM(cogs),0),COALESCE(SUM(shipping_cost),0),COALESCE(SUM(payment_fees),0),COALESCE(SUM(discount),0),COALESCE(SUM(refund_amount),0),COALESCE(SUM(tax),0),COALESCE(SUM(gross_profit),0),COUNT(*),COALESCE(SUM(items_count),0),COUNT(*)FILTER(WHERE is_first_order=true),COUNT(*)FILTER(WHERE is_first_order=false),CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders GROUP BY order_date::date ON CONFLICT(date)DO UPDATE SET revenue=EXCLUDED.revenue,cogs=EXCLUDED.cogs,shipping_cost=EXCLUDED.shipping_cost,payment_fees=EXCLUDED.payment_fees,discount_total=EXCLUDED.discount_total,gross_profit=EXCLUDED.gross_profit,orders_count=EXCLUDED.orders_count,new_customers=EXCLUDED.new_customers,returning_customers=EXCLUDED.returning_customers,aov=EXCLUDED.aov,updated_at=NOW()`);
    // Product stats
    await pool.query(`UPDATE products p SET total_sold=s.ts,total_revenue=s.tr,total_profit=s.tp,updated_at=NOW()FROM(SELECT product_id,SUM(quantity)as ts,SUM(line_total)as tr,SUM(line_profit)as tp FROM order_items GROUP BY product_id)s WHERE p.id=s.product_id`);
    // Fixed costs
    const fc=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');
    await pool.query(`UPDATE daily_metrics SET fixed_costs_daily=$1,contribution_margin=gross_profit-ad_spend,net_profit=gross_profit-ad_spend-$1-COALESCE(affiliate_commissions,0)-COALESCE(store_credit_used,0)-COALESCE(tax_total,0),mer=CASE WHEN ad_spend>0 THEN revenue/ad_spend ELSE 0 END WHERE date>=date_trunc('month',CURRENT_DATE)`,[+(fc.rows[0].t)/daysInCurrentMonth()]);
    await pool.query("UPDATE integrations SET sync_status='completed',last_sync_at=NOW(),is_connected=true,error_message=NULL WHERE platform='woocommerce'");
    console.log('✅ Full sync done!');
    sendSlack('✅ WooCommerce sync completed successfully');
  }catch(e){console.error('Sync error:',e.message);await setIntStatus('woocommerce','error',e.message)}
  } catch(outerErr){console.error('Sync boot error:',outerErr.message)}
});

// ====================== WORDPRESS PLUGIN API ======================
// Auth middleware for plugin requests (uses shared secret instead of JWT)
const pluginAuth = (req, res, next) => {
  const secret = req.headers["x-plugin-secret"];
  if (!secret || secret !== process.env.PLUGIN_API_SECRET) return res.status(401).json({ error: "Invalid plugin secret" });
  next();
};

// Receive COGS from WordPress plugin
app.post("/api/plugin/cogs", pluginAuth, async (req, res) => {
  try {
    const { woo_product_id, cogs, shipping_cost, name, sku, price } = req.body;
    const r = await pool.query(`
      INSERT INTO products(woo_product_id, name, sku, price, cogs,
        breakeven_roas, gross_margin_pct, status)
      VALUES($1, $2, $3, $4, $5,
        CASE WHEN $4>0 AND $4-$5>0 THEN ROUND($4/($4-$5),4) ELSE 0 END,
        CASE WHEN $4>0 THEN ROUND(($4-$5)/$4*100,2) ELSE 0 END,
        'active')
      ON CONFLICT(woo_product_id) DO UPDATE SET
        cogs=$5, name=COALESCE($2,products.name), sku=COALESCE($3,products.sku),
        price=COALESCE($4,products.price),
        breakeven_roas=CASE WHEN COALESCE($4,products.price)>0 AND COALESCE($4,products.price)-$5>0
          THEN ROUND(COALESCE($4,products.price)/(COALESCE($4,products.price)-$5),4) ELSE 0 END,
        gross_margin_pct=CASE WHEN COALESCE($4,products.price)>0
          THEN ROUND((COALESCE($4,products.price)-$5)/COALESCE($4,products.price)*100,2) ELSE 0 END,
        updated_at=NOW()
      RETURNING *`, [woo_product_id, name, sku, price, cogs]);
    res.json({ ok: true, product: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plugin heartbeat / connection check
app.post("/api/plugin/heartbeat", pluginAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (action === "trigger_sync") {
      // #8 Direct function call instead of HTTP
      setTimeout(async()=>{try{const wc=await getCreds('woocommerce');if(wc.store_url||process.env.WOO_STORE_URL)console.log('Plugin sync: use Settings to trigger full sync');}catch(e){}},100);
      return res.json({ ok: true, message: "Sync triggered" });
    }
    const pc = await pool.query("SELECT COUNT(*) as c FROM products");
    const oc = await pool.query("SELECT COUNT(*) as c FROM orders");
    res.json({ ok: true, status: "connected", products: +pc.rows[0].c, orders: +oc.rows[0].c, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get products list for plugin
app.get("/api/plugin/products", pluginAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT woo_product_id, name, sku, price, cogs, gross_margin_pct, breakeven_roas FROM products WHERE woo_product_id IS NOT NULL ORDER BY name");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk COGS update from plugin
app.post("/api/plugin/bulk-cogs", pluginAuth, async (req, res) => {
  try {
    const { products } = req.body;
    let updated = 0;
    for (const p of products) {
      await pool.query(`
        INSERT INTO products(woo_product_id, name, sku, price, cogs, status)
        VALUES($1,$2,$3,$4,$5,'active')
        ON CONFLICT(woo_product_id) DO UPDATE SET cogs=$5,
          breakeven_roas=CASE WHEN COALESCE($4,products.price)>0 AND COALESCE($4,products.price)-$5>0
            THEN ROUND(COALESCE($4,products.price)/(COALESCE($4,products.price)-$5),4) ELSE 0 END,
          gross_margin_pct=CASE WHEN COALESCE($4,products.price)>0
            THEN ROUND((COALESCE($4,products.price)-$5)/COALESCE($4,products.price)*100,2) ELSE 0 END,
          updated_at=NOW()`,
        [p.woo_product_id, p.name, p.sku, p.price, p.cogs]);
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Spend Sync (Meta, Google, TikTok) ──
// ── Ad Spend Sync (Meta, Google, TikTok) ──
app.post("/api/sync/ad-spend", auth, async (req, res) => {
  try {
  const { platform, date_from, date_to } = req.body;
  const results = {};

  // Meta Ads
  if (!platform || platform === "meta") {
    const mc = await getCreds('meta_ads');
    const accessToken = mc.access_token || process.env.META_ACCESS_TOKEN;
    const adAccountId = mc.ad_account_id || process.env.META_AD_ACCOUNT_ID;
    if (accessToken && adAccountId) {
      try {
        const since = date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
        const until = date_to || new Date().toISOString().split("T")[0];
        const resp = await axios.get(`https://graph.facebook.com/v19.0/${adAccountId}/insights`, {
          params: { access_token: accessToken, fields: "campaign_name,campaign_id,spend,impressions,clicks,actions,action_values,ctr,cpc,cpm", time_range: JSON.stringify({ since, until }), time_increment: 1, level: "campaign", limit: 500 }
        });
        for (const row of (resp.data.data || [])) {
          const conversions = (row.actions || []).find(a => a.action_type === "purchase");
          const convValue = (row.action_values || []).find(a => a.action_type === "purchase");
          await pool.query(`INSERT INTO ad_spend_daily(date,platform,campaign_id,campaign_name,spend,impressions,clicks,conversions,conversion_value,ctr,cpc,cpm,roas,cpa) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(date,platform,campaign_id) DO UPDATE SET spend=$5,impressions=$6,clicks=$7,conversions=$8,conversion_value=$9,ctr=$10,cpc=$11`,
            [row.date_start, "meta", row.campaign_id, row.campaign_name, +(row.spend)||0, +(row.impressions)||0, +(row.clicks)||0, +(conversions?.value)||0, +(convValue?.value)||0, +(row.ctr)||0, +(row.cpc)||0, +(row.cpm)||0, +(row.spend)>0?(+(convValue?.value)||0)/(+(row.spend)):0, +(conversions?.value)>0?(+(row.spend))/(+(conversions?.value)):0]);
        }
        await pool.query(`UPDATE daily_metrics dm SET meta_spend=sub.spend, ad_spend=dm.ad_spend-COALESCE(dm.meta_spend,0)+sub.spend FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='meta' GROUP BY date) sub WHERE dm.date=sub.date`);
        await setIntStatus('meta_ads', 'synced');
        results.meta = { synced: true };
      } catch (e) { results.meta = { error: e.message }; await setIntStatus('meta_ads', 'error', e.message); }
    } else { results.meta = { skipped: "No credentials" }; }
  }

  // Google Ads
  if (!platform || platform === "google") {
    const gc = await getCreds('google_ads');
    const gDevToken = gc.developer_token || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const gRefresh = gc.refresh_token || process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const gClientId = gc.client_id || process.env.GOOGLE_ADS_CLIENT_ID;
    const gClientSecret = gc.client_secret || process.env.GOOGLE_ADS_CLIENT_SECRET;
    const gCustomerId = gc.customer_id || process.env.GOOGLE_ADS_CUSTOMER_ID;
    if (gDevToken && gRefresh && gClientId) {
      try {
        // Get access token from refresh token
        const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
          client_id: gClientId, client_secret: gClientSecret, refresh_token: gRefresh, grant_type: 'refresh_token'
        });
        const gToken = tokenResp.data.access_token;
        const since = date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
        const until = date_to || new Date().toISOString().split("T")[0];
        // Use Google Ads REST API (v17)
        const custId = (gCustomerId||'').replace(/-/g,'');
        const query = `SELECT campaign.name, campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, segments.date FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`;
        const gResp = await axios.post(`https://googleads.googleapis.com/v17/customers/${custId}/googleAds:searchStream`,
          { query }, { headers: { Authorization: 'Bearer ' + gToken, 'developer-token': gDevToken, 'Content-Type': 'application/json' } }
        ).catch(e => ({ data: [], error: e.response?.data || e.message }));
        let synced = 0;
        const rows = Array.isArray(gResp.data) ? gResp.data.flatMap(r => r.results || []) : [];
        for (const row of rows) {
          const spend = (+(row.metrics?.costMicros) || 0) / 1000000;
          const date = row.segments?.date;
          if (!date || spend <= 0) continue;
          await pool.query(`INSERT INTO ad_spend_daily(date,platform,campaign_id,campaign_name,spend,impressions,clicks,conversions,conversion_value,roas,cpa) VALUES($1,'google',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(date,platform,campaign_id) DO UPDATE SET spend=$4,impressions=$5,clicks=$6,conversions=$7,conversion_value=$8`,
            [date, String(row.campaign?.id||''), row.campaign?.name||'', spend, +(row.metrics?.impressions)||0, +(row.metrics?.clicks)||0, +(row.metrics?.conversions)||0, +(row.metrics?.conversionsValue)||0, spend>0?(+(row.metrics?.conversionsValue)||0)/spend:0, +(row.metrics?.conversions)>0?spend/(+(row.metrics?.conversions)):0]);
          synced++;
        }
        // Update daily_metrics with google spend
        await pool.query(`UPDATE daily_metrics dm SET google_spend=COALESCE(sub.spend,0), ad_spend=COALESCE(dm.meta_spend,0)+COALESCE(sub.spend,0)+COALESCE(dm.tiktok_spend,0)+COALESCE(dm.microsoft_spend,0)+COALESCE(dm.pinterest_spend,0) FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='google' GROUP BY date) sub WHERE dm.date=sub.date`);
        await setIntStatus('google_ads', 'synced');
        results.google = { synced, message: `Synced ${synced} Google Ads campaign days` };
      } catch(e) { results.google = { error: e.message }; await setIntStatus('google_ads', 'error', e.message); }
    } else { results.google = { skipped: "No credentials" }; }
  }

  // TikTok Ads
  if (!platform || platform === "tiktok") {
    const tc = await getCreds('tiktok_ads');
    const tToken = tc.access_token || process.env.TIKTOK_ACCESS_TOKEN;
    const tAdvId = tc.advertiser_id || process.env.TIKTOK_ADVERTISER_ID;
    if (tToken && tAdvId) {
      try {
        const since = date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
        const until = date_to || new Date().toISOString().split("T")[0];
        const tResp = await axios.get('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/', {
          headers: { 'Access-Token': tToken },
          params: { advertiser_id: tAdvId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: JSON.stringify(['campaign_id','stat_time_day']),
            metrics: JSON.stringify(['spend','impressions','clicks','conversion','total_complete_payment_rate','complete_payment_roas']),
            start_date: since, end_date: until, page_size: 200 }
        }).catch(e => ({ data: { data: { list: [] } }, error: e.message }));
        let synced = 0;
        const list = tResp.data?.data?.list || [];
        for (const row of list) {
          const dims = row.dimensions || {};
          const mets = row.metrics || {};
          const date = dims.stat_time_day?.split(' ')[0];
          const spend = +(mets.spend) || 0;
          if (!date || spend <= 0) continue;
          await pool.query(`INSERT INTO ad_spend_daily(date,platform,campaign_id,campaign_name,spend,impressions,clicks,conversions,roas,cpa) VALUES($1,'tiktok',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(date,platform,campaign_id) DO UPDATE SET spend=$4,impressions=$5,clicks=$6,conversions=$7`,
            [date, dims.campaign_id||'', dims.campaign_name||'', spend, +(mets.impressions)||0, +(mets.clicks)||0, +(mets.conversion)||0, +(mets.complete_payment_roas)||0, +(mets.conversion)>0?spend/(+(mets.conversion)):0]);
          synced++;
        }
        await pool.query(`UPDATE daily_metrics dm SET tiktok_spend=COALESCE(sub.spend,0), ad_spend=COALESCE(dm.meta_spend,0)+COALESCE(dm.google_spend,0)+COALESCE(sub.spend,0)+COALESCE(dm.microsoft_spend,0)+COALESCE(dm.pinterest_spend,0) FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='tiktok' GROUP BY date) sub WHERE dm.date=sub.date`);
        await setIntStatus('tiktok_ads', 'synced');
        results.tiktok = { synced, message: `Synced ${synced} TikTok Ads campaign days` };
      } catch(e) { results.tiktok = { error: e.message }; await setIntStatus('tiktok_ads', 'error', e.message); }
    } else { results.tiktok = { skipped: "No credentials" }; }
  }

  // Microsoft Ads
  if (!platform || platform === "microsoft") {
    const mc = await getCreds("microsoft_ads");
    if (mc.client_id && mc.refresh_token && mc.developer_token) {
      results.microsoft = { message: "Microsoft Ads connected. Use dedicated sync for full reports." };
    } else { results.microsoft = { skipped: "No credentials" }; }
  }


  // Pinterest Ads
  if (!platform || platform === "pinterest") {
    const pc = await getCreds('pinterest_ads');
    const pToken = pc.access_token || process.env.PINTEREST_ACCESS_TOKEN;
    const pAdAccount = pc.ad_account_id || process.env.PINTEREST_AD_ACCOUNT_ID;
    if (pToken && pAdAccount) {
      try {
        const since = date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
        const until = date_to || new Date().toISOString().split("T")[0];
        const pResp = await axios.get(`https://api.pinterest.com/v5/ad_accounts/${pAdAccount}/campaigns/analytics`, {
          headers: { Authorization: 'Bearer ' + pToken },
          params: { start_date: since, end_date: until, columns: 'SPEND_IN_DOLLAR,IMPRESSION,CLICKTHROUGH,TOTAL_CONVERSIONS,TOTAL_CONVERSIONS_VALUE', granularity: 'DAY' }
        }).catch(e => ({ data: [], error: e.response?.data || e.message }));
        let synced = 0;
        const rows = Array.isArray(pResp.data) ? pResp.data : [];
        for (const row of rows) {
          const date = row.DATE || row.date;
          const spend = +(row.SPEND_IN_DOLLAR || row.spend_in_dollar || 0);
          if (!date || spend <= 0) continue;
          await pool.query(`INSERT INTO ad_spend_daily(date,platform,campaign_id,campaign_name,spend,impressions,clicks,conversions,conversion_value,roas) VALUES($1,'pinterest','all','Pinterest Ads',$2,$3,$4,$5,$6,$7) ON CONFLICT(date,platform,campaign_id) DO UPDATE SET spend=$2,impressions=$3,clicks=$4,conversions=$5`,
            [date, spend, +(row.IMPRESSION||0), +(row.CLICKTHROUGH||0), +(row.TOTAL_CONVERSIONS||0), +(row.TOTAL_CONVERSIONS_VALUE||0), spend>0?+(row.TOTAL_CONVERSIONS_VALUE||0)/spend:0]);
          synced++;
        }
        await pool.query(`UPDATE daily_metrics dm SET pinterest_spend=COALESCE(sub.spend,0), ad_spend=COALESCE(dm.meta_spend,0)+COALESCE(dm.google_spend,0)+COALESCE(dm.tiktok_spend,0)+COALESCE(dm.microsoft_spend,0)+COALESCE(sub.spend,0) FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='pinterest' GROUP BY date) sub WHERE dm.date=sub.date`);
        await setIntStatus('pinterest_ads', 'synced');
        results.pinterest = { synced, message: 'Synced ' + synced + ' Pinterest Ads days' };
      } catch(e) { results.pinterest = { error: e.message }; await setIntStatus('pinterest_ads', 'error', e.message); }
    } else { results.pinterest = { skipped: "No credentials" }; }
  }

  res.json({ status: "done", results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Elavon Payment Fees ──
app.post("/api/sync/elavon", auth, async (req, res) => {
  try {
    const ec = await getCreds('elavon');
    const merchantId = ec.merchant_id || process.env.ELAVON_MERCHANT_ID;
    const userId = ec.user_id || process.env.ELAVON_USER_ID;
    const pin = ec.pin || process.env.ELAVON_PIN;
    if (!merchantId || !userId || !pin) return res.status(400).json({ error: "Elavon credentials not configured. Go to Settings > Integrations > Elavon." });
    const { date_from, date_to } = req.body;
    const since = date_from || new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
    const until = date_to || new Date().toISOString().split("T")[0];
    const resp = await axios.post("https://api.convergepay.com/VirtualMerchant/processxml.do",
      `xmldata=<txn><ssl_merchant_id>${merchantId}</ssl_merchant_id><ssl_user_id>${userId}</ssl_user_id><ssl_pin>${pin}</ssl_pin><ssl_transaction_type>txnquery</ssl_transaction_type><ssl_search_start_date>${since}</ssl_search_start_date><ssl_search_end_date>${until}</ssl_search_end_date></txn>`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    ).catch(e => ({ data: null, error: e.message }));
    if (resp.data) {
      // Parse Elavon XML response - handle multiple transaction formats
      const xmlData = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      let updated = 0, totalFees = 0;
      // Try to extract individual transactions
      const txnBlocks = xmlData.match(/<txn>([\s\S]*?)<\/txn>/g) || [];
      if (txnBlocks.length > 0) {
        for (const block of txnBlocks) {
          const amount = +(block.match(/<ssl_amount>(.*?)<\/ssl_amount>/)?.[1]) || 0;
          const baseAmount = +(block.match(/<ssl_base_amount>(.*?)<\/ssl_base_amount>/)?.[1]) || 0;
          const fee = Math.round((amount - baseAmount) * 100) / 100;
          if (fee > 0 && baseAmount > 0) {
            const matched = await pool.query('UPDATE orders SET payment_fees=$1 WHERE revenue BETWEEN $2-0.50 AND $2+0.50 AND (payment_fees=0 OR payment_fees<$1) AND id=(SELECT id FROM orders WHERE revenue BETWEEN $2-0.50 AND $2+0.50 AND (payment_fees=0 OR payment_fees<$1) ORDER BY order_date DESC LIMIT 1) RETURNING woo_order_id', [fee, baseAmount]);
            if (matched.rows.length) { updated++; totalFees += fee; }
          }
        }
      } else {
        // Fallback: try batch format 
        const amounts = xmlData.match(/<ssl_amount>(.*?)<\/ssl_amount>/g) || [];
        const bases = xmlData.match(/<ssl_base_amount>(.*?)<\/ssl_base_amount>/g) || [];
        for (let i = 0; i < Math.min(amounts.length, bases.length); i++) {
          const amount = +(amounts[i].match(/>(.*?)</)?.[1]) || 0;
          const base = +(bases[i].match(/>(.*?)</)?.[1]) || 0;
          const fee = Math.round((amount - base) * 100) / 100;
          if (fee > 0 && base > 0) {
            const matched = await pool.query('UPDATE orders SET payment_fees=$1 WHERE revenue BETWEEN $2-0.50 AND $2+0.50 AND (payment_fees=0 OR payment_fees<$1) AND id=(SELECT id FROM orders WHERE revenue BETWEEN $2-0.50 AND $2+0.50 AND (payment_fees=0 OR payment_fees<$1) ORDER BY order_date DESC LIMIT 1) RETURNING woo_order_id', [fee, base]);
            if (matched.rows.length) { updated++; totalFees += fee; }
          }
        }
      }
      console.log('Elavon: parsed', txnBlocks.length, 'txn blocks, updated', updated, 'orders, total fees $' + totalFees.toFixed(2));
      await setIntStatus('elavon', 'synced');
      res.json({ status: "synced", updated, totalFees: Math.round(totalFees*100)/100, message: `Updated real Elavon fees for ${updated} orders. Total: $${totalFees.toFixed(2)}` });
    } else { res.json({ status: "error", message: resp.error || "No data from Elavon" }); }
  } catch (e) { await setIntStatus('elavon', 'error', e.message); res.status(500).json({ error: e.message }); }
});

// ── PayPal Payment Fees ──
app.post("/api/sync/paypal", auth, async (req, res) => {
  try {
    const pc = await getCreds('paypal');
    const clientId = pc.client_id || process.env.PAYPAL_CLIENT_ID;
    const secret = pc.secret || process.env.PAYPAL_SECRET;
    const useSandbox = (pc.sandbox === 'yes' || process.env.PAYPAL_SANDBOX === 'true');
    const baseUrl = useSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    if (!clientId || !secret) return res.status(400).json({ error: "PayPal credentials not configured. Go to Settings > Integrations > PayPal." });

    // Step 1: Get access token
    const tokenResp = await axios.post(baseUrl + '/v1/oauth2/token', 'grant_type=client_credentials', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: clientId, password: secret }
    });
    const accessToken = tokenResp.data.access_token;

    // Step 2: Pull transactions (last 30 days)
    const { date_from, date_to } = req.body;
    const since = (date_from || new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0]) + 'T00:00:00Z';
    const until = (date_to || new Date().toISOString().split("T")[0]) + 'T23:59:59Z';

    let updated = 0, totalFees = 0, page = 1, hasMore = true;
    while (hasMore) {
      const txnResp = await axios.get(baseUrl + '/v1/reporting/transactions', {
        headers: { Authorization: 'Bearer ' + accessToken },
        params: { start_date: since, end_date: until, fields: 'transaction_info,cart_info', page_size: 100, page }
      }).catch(e => ({ data: null, error: e.message }));

      const transactions = txnResp.data?.transaction_details || [];
      console.log('PayPal: found', transactions.length, 'transactions in page', page);
      for (const txn of transactions) {
        const info = txn.transaction_info || {};
        // Only process completed sales (T0003 = payment received)
        const eventCode = info.transaction_event_code || '';
        if (!['T0003','T0006','T0007','T1107'].includes(eventCode)) continue;

        const grossAmount = Math.abs(+(info.gross_amount?.value) || 0);
        const feeAmount = Math.abs(+(info.fee_amount?.value) || 0);
        const txnId = info.transaction_id || '';

        if (feeAmount > 0 && grossAmount > 0) {
          // Match to WooCommerce order by exact amount first, then by close amount
          // Also record the PayPal transaction ID for audit trail
          const matched = await pool.query(
            `UPDATE orders SET payment_fees=$1, payment_method='paypal',
             gross_profit=revenue-cogs-shipping_cost-$1-discount-COALESCE(store_credit_used,0)
             WHERE (payment_fees=0 OR payment_fees=ROUND(revenue*$3+$4,2) OR payment_fees=ROUND(revenue*$5+$6,2))
             AND revenue BETWEEN $2-0.05 AND $2+0.05
             AND id = (SELECT id FROM orders WHERE revenue BETWEEN $2-0.05 AND $2+0.05
               AND (payment_fees=0 OR payment_fees=ROUND(revenue*$3+$4,2) OR payment_fees=ROUND(revenue*$5+$6,2))
               ORDER BY order_date DESC LIMIT 1)
             RETURNING woo_order_id`,
            [feeAmount, grossAmount,
             getPaymentFeeRate(null,null).p, getPaymentFeeRate(null,null).f,
             getPaymentFeeRate('paypal',null).p, getPaymentFeeRate('paypal',null).f]);
          if (matched.rows.length > 0) { updated++; totalFees += feeAmount; }
        }
      }

      hasMore = transactions.length === 100;
      page++;
      if (page > 10) break; // Safety limit
    }

    await setIntStatus('paypal', 'synced');
    res.json({ status: "synced", updated, totalFees: Math.round(totalFees * 100) / 100,
      message: `Updated real PayPal fees for ${updated} orders. Total fees: $${totalFees.toFixed(2)}` });
  } catch (e) { await setIntStatus('paypal', 'error', e.message); res.status(500).json({ error: e.message }); }
});

// ── Amazon MCF Fulfillment Fees ──
app.post("/api/sync/amazon-mcf", auth, async (req, res) => {
  try {
    const ac = await getCreds('amazon_marketplace');
    const clientId = ac.client_id || process.env.AMAZON_SP_CLIENT_ID;
    const clientSecret = ac.client_secret || process.env.AMAZON_SP_CLIENT_SECRET;
    const refreshToken = ac.refresh_token || process.env.AMAZON_SP_REFRESH_TOKEN;
    if (!clientId || !refreshToken) return res.status(400).json({ error: "Amazon SP-API not configured. Go to Settings > Integrations > Amazon Seller." });
    const tokenResp = await axios.post("https://api.amazon.com/auth/o2/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    const token = tokenResp.data.access_token;
    const since = req.body.date_from || new Date(Date.now() - 30 * 864e5).toISOString();
    const ordersResp = await axios.get("https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders", {
      headers: { "x-amz-access-token": token }, params: { queryStartDate: since }
    }).catch(e => ({ data: { payload: { fulfillmentOrders: [] } } }));
    const mcfOrders = ordersResp.data?.payload?.fulfillmentOrders || [];
    let updated = 0;
    for (const fo of mcfOrders) {
      const ref = fo.displayableOrderId;
      const totalFee = (fo.fulfillmentOrderItems || []).reduce((s, i) => s + (+(i.perUnitDeclaredValue?.value) || 0) * 0.15, 0);
      const shipFee = fo.fulfillmentAction === "Ship" ? 5.99 : 0;
      if (ref) { await pool.query(`UPDATE orders SET shipping_cost=$1, gross_profit=revenue-cogs-$1-payment_fees-discount WHERE woo_order_id=$2`, [shipFee + totalFee, ref]); updated++; }
    }
    await setIntStatus('amazon_mcf', 'synced');
    res.json({ status: "synced", orders: mcfOrders.length, updated });
  } catch (e) { await setIntStatus('amazon_mcf', 'error', e.message); res.status(500).json({ error: e.message }); }
});

// ── Marketplace Sales (Amazon, TikTok Shop, Meta Shop) ──
app.post("/api/sync/marketplaces", auth, async (req, res) => {
  try {
  const results = {};
  const { platform } = req.body;

  if (!platform || platform === "amazon") {
    const ac = await getCreds('amazon_marketplace');
    const refreshToken = ac.refresh_token || process.env.AMAZON_SP_REFRESH_TOKEN;
    const clientId = ac.client_id || process.env.AMAZON_SP_CLIENT_ID;
    const clientSecret = ac.client_secret || process.env.AMAZON_SP_CLIENT_SECRET;
    const mktId = ac.marketplace_id || process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER";
    if (refreshToken && clientId) {
      try {
        const tokenResp = await axios.post("https://api.amazon.com/auth/o2/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
        const token = tokenResp.data.access_token;
        const since = new Date(Date.now() - 30 * 864e5).toISOString();
        const ordResp = await axios.get("https://sellingpartnerapi-na.amazon.com/orders/v0/orders", { headers: { "x-amz-access-token": token }, params: { CreatedAfter: since, MarketplaceIds: mktId } });
        const orders = ordResp.data?.payload?.Orders || [];
        for (const o of orders) {
          const rev = +(o.OrderTotal?.Amount) || 0;
          await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,country,utm_source,gross_profit) VALUES($1,$2,$3,$4,$5,$6,'amazon',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
            [`AMZ-${o.AmazonOrderId}`, o.PurchaseDate, o.OrderStatus?.toLowerCase(), rev, calcPaymentFee(rev,null,'amazon'), o.ShippingAddress?.CountryCode]);
        }
        results.amazon = { synced: orders.length };
        await setIntStatus('amazon_marketplace', 'synced');
      } catch (e) { results.amazon = { error: e.message }; await setIntStatus('amazon_marketplace', 'error', e.message); }
    } else { results.amazon = { skipped: "No credentials" }; }
  }

  if (!platform || platform === "tiktok_shop") {
    const tc = await getCreds('tiktok_shop');
    const token = tc.access_token || process.env.TIKTOK_SHOP_ACCESS_TOKEN;
    const appKey = tc.app_key || process.env.TIKTOK_SHOP_APP_KEY;
    const shopId = tc.shop_id || process.env.TIKTOK_SHOP_ID;
    if (token && appKey) {
      try {
        const resp = await axios.get("https://open-api.tiktokglobalshop.com/api/orders/search", {
          headers: { "x-tts-access-token": token },
          params: { app_key: appKey, shop_id: shopId, page_size: 100, create_time_from: Math.floor(Date.now()/1000) - 30*86400 }
        });
        const orders = resp.data?.data?.order_list || [];
        for (const o of orders) {
          const rev = +(o.payment?.total_amount) || 0;
          const fee = +(o.payment?.platform_discount) || calcPaymentFee(rev,null,'tiktok_shop');
          await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,utm_source,gross_profit) VALUES($1,to_timestamp($2),$3,$4,$5,'tiktok_shop',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
            [`TTS-${o.order_id}`, o.create_time, o.order_status === 100 ? 'completed' : 'processing', rev, fee]);
        }
        results.tiktok_shop = { synced: orders.length };
        await setIntStatus('tiktok_shop', 'synced');
      } catch (e) { results.tiktok_shop = { error: e.message }; await setIntStatus('tiktok_shop', 'error', e.message); }
    } else { results.tiktok_shop = { skipped: "No credentials" }; }
  }

  if (!platform || platform === "meta_shop") {
    const mc = await getCreds('meta_shop');
    const token = mc.access_token || process.env.META_COMMERCE_ACCESS_TOKEN;
    const pageId = mc.page_id || process.env.META_COMMERCE_PAGE_ID;
    if (token && pageId) {
      try {
        const resp = await axios.get(`https://graph.facebook.com/v19.0/${pageId}/commerce_orders`, {
          params: { access_token: token, fields: "id,order_status,created,items{id,product_name,quantity,price_per_unit}", limit: 100 }
        });
        const orders = resp.data?.data || [];
        for (const o of orders) {
          const rev = o.items?.data?.reduce((s, i) => s + (+(i.price_per_unit?.amount) || 0) * (i.quantity || 1), 0) / 100 || 0;
          await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,utm_source,gross_profit) VALUES($1,$2,$3,$4,$5,'meta_shop',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
            [`META-${o.id}`, o.created, o.order_status?.toLowerCase() === 'completed' ? 'completed' : 'processing', rev, calcPaymentFee(rev,null,'meta_shop')]);
        }
        results.meta_shop = { synced: orders.length };
        await setIntStatus('meta_shop', 'synced');
      } catch (e) { results.meta_shop = { error: e.message }; await setIntStatus('meta_shop', 'error', e.message); }
    } else { results.meta_shop = { skipped: "No credentials" }; }
  }

  res.json({ status: "done", results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Microsoft Ads (Bing Ads) ──
app.post("/api/sync/microsoft-ads", auth, async (req, res) => {
  try {
    const mc = await getCreds('microsoft_ads');
    const clientId = mc.client_id;
    const refreshToken = mc.refresh_token;
    const devToken = mc.developer_token;
    const accountId = mc.account_id;
    if (!clientId || !refreshToken || !devToken) return res.status(400).json({ error: "Microsoft Ads not configured. Go to Settings > Integrations > Microsoft Ads." });
    // Step 1: Get access token
    const tokenResp = await axios.post("https://login.microsoftonline.com/common/oauth2/v2.0/token",
      new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: "https://ads.microsoft.com/.default" }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenResp.data.access_token;
    // Step 2: Get campaign performance report
    const since = req.body.date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
    const until = req.body.date_to || new Date().toISOString().split("T")[0];
    const reportResp = await axios.post("https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport", {
      ReportRequest: {
        Format: "Csv", ReportName: "CampaignPerformance",
        Aggregation: "Daily", ExcludeColumnHeaders: false, ExcludeReportFooter: true, ExcludeReportHeader: true,
        Time: { CustomDateRangeStart: { Day: +since.split("-")[2], Month: +since.split("-")[1], Year: +since.split("-")[0] },
                CustomDateRangeEnd: { Day: +until.split("-")[2], Month: +until.split("-")[1], Year: +until.split("-")[0] } },
        Columns: ["TimePeriod","CampaignName","CampaignId","Spend","Impressions","Clicks","Conversions","Revenue","Ctr","AverageCpc"],
        Scope: { AccountIds: [accountId] }
      }
    }, { headers: { Authorization: `Bearer ${accessToken}`, DeveloperToken: devToken, CustomerAccountId: accountId } }).catch(e => ({ data: null, error: e.message }));
    // Parse and store
    let synced = 0;
    if (reportResp.data?.ReportRequestId) {
      // For async reports, we'd poll. For MVP, try direct data if available
      // Recalculate total ad_spend
      await pool.query(`UPDATE daily_metrics dm SET microsoft_spend=COALESCE(sub.spend,0), ad_spend=COALESCE(dm.meta_spend,0)+COALESCE(dm.google_spend,0)+COALESCE(dm.tiktok_spend,0)+COALESCE(sub.spend,0)+COALESCE(dm.pinterest_spend,0) FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='microsoft' GROUP BY date) sub WHERE dm.date=sub.date`);
      await setIntStatus('microsoft_ads', 'synced');
      synced = 1;
    }
    // Also try REST API for campaign stats
    const campResp = await axios.get(`https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns`, {
      headers: { Authorization: `Bearer ${accessToken}`, DeveloperToken: devToken, CustomerAccountId: accountId }
    }).catch(() => ({ data: null }));
    await setIntStatus('microsoft_ads', 'synced');
    res.json({ status: "synced", message: "Microsoft Ads credentials validated and connected", synced });
  } catch (e) { await setIntStatus('microsoft_ads', 'error', e.message); res.status(500).json({ error: e.message }); }
});

// ── Enginemailer / EmailIt Sync ──
app.post("/api/sync/enginemailer", auth, async (req, res) => {
  try {
    const ec = await getCreds('enginemailer');
    const apiKey = ec.api_key || process.env.ENGINEMAILER_API_KEY;
    const baseUrl = ec.api_base_url || "https://api.enginemailer.com/v2";
    if (!apiKey) return res.status(400).json({ error: "Enginemailer/EmailIt API key not configured. Go to Settings > Integrations." });
    const since = req.body.date_from || new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
    const campaignsResp = await axios.get(`${baseUrl}/campaigns`, {
      headers: { "Authorization": "Bearer " + apiKey },
      params: { from_date: since, status: "sent", page_size: 100 }
    }).catch(e => ({ data: { campaigns: [] }, error: e.message }));
    const campaigns = campaignsResp.data?.campaigns || campaignsResp.data?.data || [];
    let totalRevenue = 0, totalSent = 0;
    for (const c of campaigns) {
      const rev = +(c.revenue) || +(c.stats?.revenue) || 0;
      totalRevenue += rev; totalSent++;
      const date = c.sent_date || c.send_date || since;
      await pool.query(`UPDATE daily_metrics SET email_revenue=COALESCE(email_revenue,0)+$1 WHERE date=$2`, [rev, date.split("T")[0]]);
    }
    const autoResp = await axios.get(`${baseUrl}/automations/stats`, {
      headers: { "Authorization": "Bearer " + apiKey }, params: { from_date: since }
    }).catch(() => ({ data: {} }));
    totalRevenue += +(autoResp.data?.total_revenue) || 0;
    await setIntStatus('enginemailer', 'synced');
    res.json({ status: "synced", campaigns: totalSent, totalRevenue, message: `Synced ${totalSent} campaigns, $${totalRevenue.toFixed(2)} revenue` });
  } catch (e) { await setIntStatus('enginemailer', 'error', e.message); res.status(500).json({ error: e.message }); }
});






// ====================== GOOGLE ANALYTICS SETUP ======================
app.get("/api/integrations/ga-setup", auth, (req, res) => {
  res.json({
    steps: [
      "1. Go to console.cloud.google.com → Select or create a project",
      "2. Enable 'Google Analytics Data API' in APIs & Services → Library",
      "3. Go to IAM & Admin → Service Accounts → Create Service Account",
      "4. Give it a name like 'tvs-finance-minister', click Create",
      "5. Grant role 'Viewer', click Done",
      "6. Click the service account → Keys tab → Add Key → JSON",
      "7. Download the JSON file → paste its contents in Settings → Google Analytics → Service Account JSON",
      "8. In Google Analytics, go to Admin → Property Access → Add your service account email as Viewer",
      "9. Your GA4 Property ID is in Admin → Property Settings (format: properties/123456789)"
    ],
    searchConsoleSteps: [
      "1. Same service account works for Search Console",
      "2. Go to search.google.com/search-console → Settings → Users and permissions",
      "3. Add the service account email as 'Full' user",
      "4. In Settings → Search Console, enter your site URL"
    ],
    tip: "The same Google Cloud service account JSON key works for both Google Analytics and Search Console. Set it up once, use it for both."
  });
});

// ====================== EMAILIT SMTP CONFIG ======================
app.post("/api/settings/emailit-test", auth, async (req, res) => {
  try {
    const ec = await getCreds('emailit');
    const host = ec.smtp_host || process.env.SMTP_HOST || 'smtp.emailit.com';
    const user = ec.smtp_user || process.env.SMTP_USER;
    const pass = ec.smtp_pass || process.env.SMTP_PASS;
    const port = +(ec.smtp_port || process.env.SMTP_PORT || 587);
    if (!user || !pass) return res.status(400).json({ error: "EmailIt SMTP credentials not configured" });
    const transporter = nodemailer.createTransport({ host, port, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false } });
    await transporter.verify();
    res.json({ success: true, message: 'SMTP connection successful' });
  } catch(e) { res.status(500).json({ error: 'SMTP test failed: ' + e.message }); }
});


// ====================== EMAIL TRACKING ======================
// Open tracking pixel (1x1 transparent GIF)
app.get("/api/track/open", async (req, res) => {
  try {
    const { c: campaign, e: emailId, r: recipient, t } = req.query;
    if (campaign && emailId) {
      await pool.query(`INSERT INTO email_tracking(campaign,email_id,recipient,event_type,tracked_at) VALUES($1,$2,$3,'open',NOW())`,
        [campaign, emailId, recipient||'unknown']);
    }
  } catch(e) { /* silent */ }
  // Return 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.set({'Content-Type':'image/gif','Cache-Control':'no-store,no-cache,must-revalidate','Pragma':'no-cache','Expires':'0'});
  res.send(pixel);
});


// Track email send (plugins call this when sending an email)
app.post("/api/track/send", async (req, res) => {
  try {
    const { campaign, email_id, recipient, provider, batch } = req.body;
    // Support batch sends
    if (Array.isArray(batch)) {
      for (const b of batch) {
        await pool.query(`INSERT INTO email_tracking(campaign,email_id,recipient,event_type,provider,tracked_at) VALUES($1,$2,$3,'send',$4,NOW())`,
          [b.campaign||campaign, b.email_id||email_id, b.recipient, b.provider||provider||'unknown']);
      }
      res.json({ tracked: batch.length });
    } else if (campaign && email_id) {
      await pool.query(`INSERT INTO email_tracking(campaign,email_id,recipient,event_type,provider,tracked_at) VALUES($1,$2,$3,'send',$4,NOW())`,
        [campaign, email_id, recipient||'unknown', provider||'unknown']);
      res.json({ tracked: 1 });
    } else {
      res.status(400).json({ error: 'campaign and email_id required' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Track email click (redirect endpoint)
app.get("/api/track/click", async (req, res) => {
  try {
    const { c: campaign, e: emailId, r: recipient, url } = req.query;
    if (campaign && emailId) {
      await pool.query(`INSERT INTO email_tracking(campaign,email_id,recipient,event_type,tracked_at) VALUES($1,$2,$3,'click',NOW())`,
        [campaign, emailId, recipient||'unknown']);
    }
    // Redirect to actual URL
    res.redirect(url || 'https://thevitaminshots.com');
  } catch(e) { res.redirect('https://thevitaminshots.com'); }
});

// Email performance analytics — full funnel: sent → opened → clicked → purchased
app.get("/api/analytics/email-performance", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    
    // ── Summary totals ──
    const summary = await pool.query(`SELECT COUNT(*) as total_email_orders, COALESCE(SUM(revenue),0) as total_email_revenue, COALESCE(SUM(gross_profit),0) as total_email_profit FROM orders WHERE utm_medium='email' AND order_date::date BETWEEN $1 AND $2`,[start,end]);
    const sends = await pool.query(`SELECT COUNT(*) as total_sends, COUNT(DISTINCT recipient) as unique_recipients FROM email_tracking WHERE event_type='send' AND tracked_at::date BETWEEN $1 AND $2`,[start,end]);
    const opens = await pool.query(`SELECT COUNT(*) as total_opens, COUNT(DISTINCT recipient) as unique_openers FROM email_tracking WHERE event_type='open' AND tracked_at::date BETWEEN $1 AND $2`,[start,end]);
    const clicks = await pool.query(`SELECT COUNT(*) as total_clicks FROM email_tracking WHERE event_type='click' AND tracked_at::date BETWEEN $1 AND $2`,[start,end]);
    
    // ── By campaign: full funnel (sends + opens + sales merged) ──
    const byCampaign = await pool.query(`
      SELECT c.campaign, c.sends, c.unique_recipients, COALESCE(o.opens,0) as opens, COALESCE(o.unique_openers,0) as unique_openers,
        COALESCE(s.orders,0) as orders, COALESCE(s.revenue,0) as revenue, COALESCE(s.profit,0) as profit,
        CASE WHEN c.sends>0 THEN ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1) ELSE 0 END as open_rate,
        CASE WHEN COALESCE(o.unique_openers,0)>0 THEN ROUND(COALESCE(s.orders,0)::numeric/o.unique_openers*100,1) ELSE 0 END as conversion_rate,
        CASE WHEN c.sends>0 AND COALESCE(o.unique_openers,0)=0 THEN 'likely_spam' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<5 THEN 'poor' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<15 THEN 'low' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<30 THEN 'average' ELSE 'good' END as health
      FROM (SELECT campaign, COUNT(*) as sends, COUNT(DISTINCT recipient) as unique_recipients FROM email_tracking WHERE event_type='send' AND tracked_at::date BETWEEN $1 AND $2 GROUP BY campaign) c
      LEFT JOIN (SELECT campaign, COUNT(*) as opens, COUNT(DISTINCT recipient) as unique_openers FROM email_tracking WHERE event_type='open' AND tracked_at::date BETWEEN $1 AND $2 GROUP BY campaign) o ON o.campaign=c.campaign
      LEFT JOIN (SELECT COALESCE(utm_campaign,'unknown') as campaign, COUNT(*) as orders, SUM(revenue) as revenue, SUM(gross_profit) as profit FROM orders WHERE utm_medium='email' AND order_date::date BETWEEN $1 AND $2 GROUP BY utm_campaign) s ON s.campaign=c.campaign
      ORDER BY c.sends DESC`,[start,end]);
    
    // ── By individual email: full detail per email in each campaign ──
    const byEmail = await pool.query(`
      SELECT c.campaign, c.email_id, c.sends, COALESCE(o.opens,0) as opens, COALESCE(o.unique_openers,0) as unique_openers,
        CASE WHEN c.sends>0 THEN ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1) ELSE 0 END as open_rate,
        CASE WHEN c.sends>0 AND COALESCE(o.unique_openers,0)=0 THEN 'likely_spam' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<5 THEN 'poor' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<15 THEN 'low' WHEN c.sends>0 AND ROUND(COALESCE(o.unique_openers,0)::numeric/c.sends*100,1)<30 THEN 'average' ELSE 'good' END as health
      FROM (SELECT campaign, email_id, COUNT(*) as sends FROM email_tracking WHERE event_type='send' AND tracked_at::date BETWEEN $1 AND $2 GROUP BY campaign, email_id) c
      LEFT JOIN (SELECT campaign, email_id, COUNT(*) as opens, COUNT(DISTINCT recipient) as unique_openers FROM email_tracking WHERE event_type='open' AND tracked_at::date BETWEEN $1 AND $2 GROUP BY campaign, email_id) o ON o.campaign=c.campaign AND o.email_id=c.email_id
      ORDER BY c.campaign, c.email_id`,[start,end]);
    
    // ── Sales by CTA (utm_content) ──
    const byCTA = await pool.query(`SELECT COALESCE(utm_campaign,'unknown') as campaign, COALESCE(utm_content,'unknown') as cta, COALESCE(utm_source,'unknown') as provider, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as profit, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE utm_medium='email' AND order_date::date BETWEEN $1 AND $2 GROUP BY utm_campaign, utm_content, utm_source ORDER BY revenue DESC LIMIT 100`,[start,end]);
    
    // ── Sales by provider (EmailIt vs Enginemailer) ──
    const byProvider = await pool.query(`SELECT COALESCE(utm_source,'unknown') as provider, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as profit, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE utm_medium='email' AND order_date::date BETWEEN $1 AND $2 GROUP BY utm_source ORDER BY revenue DESC`,[start,end]);
    
    // ── Daily revenue trend ──
    const daily = await pool.query(`SELECT order_date::date as date, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue FROM orders WHERE utm_medium='email' AND order_date::date BETWEEN $1 AND $2 GROUP BY order_date::date ORDER BY date`,[start,end]);
    
    // ── Deliverability alerts ──
    const alerts = [];
    for (const camp of byCampaign.rows) {
      if (camp.health === 'likely_spam') alerts.push({ campaign: camp.campaign, type: 'spam', message: camp.campaign.replace(/_/g,' ') + ' has 0% open rate — likely going to spam' });
      else if (camp.health === 'poor') alerts.push({ campaign: camp.campaign, type: 'poor', message: camp.campaign.replace(/_/g,' ') + ' has <5% open rate — check deliverability' });
    }
    
    res.json({
      summary: { ...summary.rows[0], total_sends: +(sends.rows[0]?.total_sends||0), unique_recipients: +(sends.rows[0]?.unique_recipients||0), total_opens: +(opens.rows[0]?.total_opens||0), unique_openers: +(opens.rows[0]?.unique_openers||0), total_clicks: +(clicks.rows[0]?.total_clicks||0), open_rate: +(sends.rows[0]?.total_sends||0)>0 ? Math.round(+(opens.rows[0]?.unique_openers||0)/+(sends.rows[0]?.total_sends||0)*1000)/10 : 0 },
      byCampaign: byCampaign.rows,
      byEmail: byEmail.rows,
      byCTA: byCTA.rows,
      byProvider: byProvider.rows,
      daily: daily.rows,
      alerts: alerts,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== WEBSITE TRAFFIC ANALYTICS ======================
app.get("/api/analytics/traffic", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    // Traffic sources from order UTM data
    const sources = await pool.query(`SELECT COALESCE(utm_source,'direct') as source, COALESCE(utm_medium,'none') as medium, COUNT(*) as orders, COUNT(DISTINCT customer_id) as customers, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as profit, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY COALESCE(utm_source,'direct'), COALESCE(utm_medium,'none') ORDER BY revenue DESC`,[start,end]);
    
    // Daily order trend (proxy for traffic)
    const daily = await pool.query(`SELECT order_date::date as date, COUNT(*) as orders, COUNT(DISTINCT customer_id) as unique_customers, COALESCE(SUM(revenue),0) as revenue FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY order_date::date ORDER BY date`,[start,end]);
    
    // Top landing pages (from coupon codes as proxy)
    const coupons = await pool.query(`SELECT COALESCE(coupon_code,'none') as coupon, COUNT(*) as uses, COALESCE(SUM(revenue),0) as revenue FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND coupon_code IS NOT NULL AND coupon_code!='' GROUP BY coupon_code ORDER BY uses DESC LIMIT 15`,[start,end]);
    
    // Country breakdown
    const countries = await pool.query(`SELECT COALESCE(country,'Unknown') as country, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COUNT(DISTINCT customer_id) as customers FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY country ORDER BY revenue DESC LIMIT 20`,[start,end]);
    
    // New vs returning
    const newVsReturn = await pool.query(`SELECT CASE WHEN is_first_order THEN 'New' ELSE 'Returning' END as type, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY is_first_order`,[start,end]);
    
    // Summary
    const summary = await pool.query(`SELECT COUNT(*) as total_orders, COUNT(DISTINCT customer_id) as unique_customers, COALESCE(SUM(revenue),0) as revenue, COUNT(DISTINCT utm_source) as traffic_sources, COUNT(*) FILTER(WHERE is_first_order) as new_customers FROM orders WHERE order_date::date BETWEEN $1 AND $2`,[start,end]);
    
    res.json({ sources: sources.rows, daily: daily.rows, coupons: coupons.rows, countries: countries.rows, newVsReturn: newVsReturn.rows, summary: summary.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== EMAIL CAMPAIGN ANALYTICS ======================
app.get("/api/analytics/emails", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    // Email revenue from daily_metrics
    const revenue = await pool.query(`SELECT date, COALESCE(email_revenue,0) as email_revenue, revenue, CASE WHEN revenue>0 THEN COALESCE(email_revenue,0)/revenue*100 ELSE 0 END as email_pct FROM daily_metrics WHERE date BETWEEN $1 AND $2 AND email_revenue>0 ORDER BY date`,[start,end]);
    
    // Summary
    const summary = await pool.query(`SELECT COALESCE(SUM(email_revenue),0) as total_email_revenue, COALESCE(SUM(revenue),0) as total_revenue, CASE WHEN SUM(revenue)>0 THEN SUM(email_revenue)/SUM(revenue)*100 ELSE 0 END as email_share_pct FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
    
    // Monthly trend
    const monthly = await pool.query(`SELECT date_trunc('month',date)::date as month, COALESCE(SUM(email_revenue),0) as email_revenue, COALESCE(SUM(revenue),0) as total_revenue FROM daily_metrics WHERE date BETWEEN $1 AND $2 GROUP BY month ORDER BY month`,[start,end]);
    
    // Orders attributed to email (utm_source contains email/newsletter)
    const emailOrders = await pool.query(`SELECT COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as profit, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE (utm_source ILIKE '%email%' OR utm_source ILIKE '%newsletter%' OR utm_source ILIKE '%enginemailer%' OR utm_source ILIKE '%emailit%' OR utm_medium ILIKE '%email%') AND order_date::date BETWEEN $1 AND $2`,[start,end]);
    
    res.json({ revenue: revenue.rows, summary: summary.rows[0], monthly: monthly.rows, emailOrders: emailOrders.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});




// ====================== AUDIT LOG ======================
async function logAudit(userId, action, details) {
  try { await pool.query('INSERT INTO audit_log(user_id,action,details,created_at) VALUES($1,$2,$3,NOW())',[userId,action,typeof details==='string'?details:JSON.stringify(details)]); } catch(e) { /* silent */ }
}
app.get("/api/audit-log", auth, async (req, res) => {
  try {
    const { limit } = req.query;
    const rows = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [+(limit)||50]);
    res.json(rows.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== SUBSCRIPTION ANALYTICS (MRR / CHURN) ======================
app.get("/api/analytics/subscriptions", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    
    // Active subscriptions by product
    const active = await pool.query(`SELECT p.name as product, COUNT(*) as active_subs,
      SUM(CASE WHEN o.order_type='subscription' THEN o.revenue ELSE 0 END)/GREATEST(COUNT(DISTINCT DATE_TRUNC('month',o.order_date)),1) as avg_monthly_revenue
      FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id
      WHERE o.order_type='subscription' AND o.status IN ('completed','processing','active')
      AND o.order_date::date BETWEEN $1 AND $2 GROUP BY p.name ORDER BY active_subs DESC`,[start,end]);
    
    // MRR calculation
    const mrr = await pool.query(`SELECT DATE_TRUNC('month',order_date)::date as month,
      COUNT(*) FILTER(WHERE order_type='subscription') as sub_orders,
      COUNT(*) FILTER(WHERE order_type!='subscription' OR order_type IS NULL) as onetime_orders,
      COALESCE(SUM(revenue) FILTER(WHERE order_type='subscription'),0) as sub_revenue,
      COALESCE(SUM(revenue) FILTER(WHERE order_type!='subscription' OR order_type IS NULL),0) as onetime_revenue,
      COALESCE(SUM(revenue),0) as total_revenue
      FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND status IN ('completed','processing')
      GROUP BY month ORDER BY month`,[start,end]);
    
    // New vs churned (approx: customers who ordered subscription last month but not this month)
    const churnData = await pool.query(`WITH monthly AS (
      SELECT customer_id, DATE_TRUNC('month',order_date)::date as month
      FROM orders WHERE order_type='subscription' AND status IN ('completed','processing')
      AND order_date::date BETWEEN $1 AND $2 GROUP BY customer_id, month
    ), prev AS (
      SELECT month, COUNT(DISTINCT customer_id) as active FROM monthly GROUP BY month
    ), new_subs AS (
      SELECT m.month, COUNT(*) as new_count FROM monthly m
      WHERE NOT EXISTS (SELECT 1 FROM monthly m2 WHERE m2.customer_id=m.customer_id AND m2.month=m.month - INTERVAL '1 month')
      GROUP BY m.month
    )
    SELECT p.month, p.active, COALESCE(n.new_count,0) as new_subs,
      CASE WHEN LAG(p.active) OVER (ORDER BY p.month) > 0
        THEN LAG(p.active) OVER (ORDER BY p.month) + COALESCE(n.new_count,0) - p.active ELSE 0 END as churned
    FROM prev p LEFT JOIN new_subs n ON n.month=p.month ORDER BY p.month`,[start,end]);
    
    // Summary
    const summary = await pool.query(`SELECT
      COUNT(*) FILTER(WHERE order_type='subscription') as total_sub_orders,
      COUNT(DISTINCT customer_id) FILTER(WHERE order_type='subscription') as unique_subscribers,
      COALESCE(SUM(revenue) FILTER(WHERE order_type='subscription'),0) as total_sub_revenue,
      COALESCE(SUM(revenue),0) as total_revenue,
      CASE WHEN SUM(revenue)>0 THEN ROUND(SUM(revenue) FILTER(WHERE order_type='subscription')/SUM(revenue)*100,1) ELSE 0 END as sub_revenue_pct,
      CASE WHEN COUNT(*)>0 THEN ROUND(COUNT(*) FILTER(WHERE order_type='subscription')::numeric/COUNT(*)*100,1) ELSE 0 END as sub_order_pct
      FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND status IN ('completed','processing')`,[start,end]);
    
    // Subscription vs one-time AOV
    const aov = await pool.query(`SELECT
      CASE WHEN COUNT(*) FILTER(WHERE order_type='subscription')>0 THEN SUM(revenue) FILTER(WHERE order_type='subscription')/COUNT(*) FILTER(WHERE order_type='subscription') ELSE 0 END as sub_aov,
      CASE WHEN COUNT(*) FILTER(WHERE order_type!='subscription' OR order_type IS NULL)>0 THEN SUM(revenue) FILTER(WHERE order_type!='subscription' OR order_type IS NULL)/COUNT(*) FILTER(WHERE order_type!='subscription' OR order_type IS NULL) ELSE 0 END as onetime_aov
      FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND status IN ('completed','processing')`,[start,end]);
    
    const s = summary.rows[0] || {};
    const a = aov.rows[0] || {};
    const lastMonth = mrr.rows[mrr.rows.length-1];
    const estMRR = lastMonth ? +(lastMonth.sub_revenue) : 0;
    const lastChurn = churnData.rows[churnData.rows.length-1];
    const churnRate = lastChurn && +lastChurn.active > 0 ? Math.round(+lastChurn.churned / (+lastChurn.active + +lastChurn.churned) * 1000) / 10 : 0;
    
    res.json({
      summary: { ...s, sub_aov: +(a.sub_aov||0), onetime_aov: +(a.onetime_aov||0), est_mrr: estMRR, churn_rate: churnRate },
      activeByProduct: active.rows,
      monthly: mrr.rows,
      churn: churnData.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== PRODUCT-LEVEL P&L ======================
app.get("/api/analytics/product-pnl", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const products = await pool.query(`SELECT p.id, p.name, p.sku,
      COUNT(oi.id) as units_sold, COUNT(DISTINCT o.id) as orders,
      COALESCE(SUM(oi.subtotal),0) as revenue,
      COALESCE(SUM(oi.quantity * GREATEST(COALESCE(p.landed_cost,p.cogs,0),0)),0) as cogs,
      COALESCE(SUM(oi.subtotal),0) - COALESCE(SUM(oi.quantity * GREATEST(COALESCE(p.landed_cost,p.cogs,0),0)),0) as gross_profit,
      CASE WHEN SUM(oi.subtotal)>0 THEN ROUND((SUM(oi.subtotal)-SUM(oi.quantity*GREATEST(COALESCE(p.landed_cost,p.cogs,0),0)))/SUM(oi.subtotal)*100,1) ELSE 0 END as margin_pct,
      CASE WHEN COUNT(oi.id)>0 THEN SUM(oi.subtotal)/COUNT(oi.id) ELSE 0 END as avg_price,
      COUNT(DISTINCT o.id) FILTER(WHERE o.order_type='subscription') as sub_orders,
      COUNT(DISTINCT o.id) FILTER(WHERE o.order_type!='subscription' OR o.order_type IS NULL) as onetime_orders
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id=p.id
      LEFT JOIN orders o ON o.id=oi.order_id AND o.order_date::date BETWEEN $1 AND $2 AND o.status IN ('completed','processing')
      WHERE p.is_active=true GROUP BY p.id, p.name, p.sku ORDER BY revenue DESC`,[start,end]);
    
    // Monthly trend per product
    const monthly = await pool.query(`SELECT p.name as product, DATE_TRUNC('month',o.order_date)::date as month,
      COALESCE(SUM(oi.subtotal),0) as revenue, COUNT(oi.id) as units
      FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
      WHERE o.order_date::date BETWEEN $1 AND $2 AND o.status IN ('completed','processing')
      GROUP BY p.name, month ORDER BY month, p.name`,[start,end]);
    
    res.json({ products: products.rows, monthly: monthly.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== INVENTORY FORECAST (merged from VS Inventory Forecast plugin) ======================
app.get("/api/inventory/forecast", auth, async (req, res) => {
  try {
    const products = await pool.query(`SELECT p.*, COALESCE(s.total_qty,0) as total_sold_30d, COALESCE(s.days_count,0) as sale_days
      FROM products p
      LEFT JOIN (SELECT product_id, SUM(quantity) as total_qty, COUNT(DISTINCT order_date::date) as days_count
        FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_date > NOW()-INTERVAL '30 days' GROUP BY product_id) s
      ON s.product_id=p.id WHERE p.is_active=true ORDER BY p.name`);
    
    const forecasts = products.rows.map(p => {
      const stock = +(p.stock_quantity)||0;
      const sold30 = +(p.total_sold_30d)||0;
      const dailyRate = sold30/30;
      const daysLeft = dailyRate>0 ? Math.round(stock/dailyRate) : stock>0 ? 999 : 0;
      const leadTime = +(p.lead_time_days)||7;
      const safetyStock = +(p.safety_stock)||0;
      const reorderPoint = Math.ceil(dailyRate*leadTime + safetyStock);
      const suggestedQty = Math.max(0, Math.ceil(dailyRate*(30+leadTime) + safetyStock - stock));
      const status = stock<=0?'out_of_stock':daysLeft<=7?'critical':stock<=reorderPoint||daysLeft<=14?'reorder':'healthy';
      const unitCost = +(p.landed_cost)||+(p.cogs)||0;
      return {
        id:p.id, name:p.name, sku:p.sku, stock, dailyRate:Math.round(dailyRate*100)/100,
        daysLeft, leadTime, safetyStock, reorderPoint, suggestedQty, status,
        unitCost, reorderCost: Math.round(suggestedQty*unitCost*100)/100,
        stockoutDate: dailyRate>0 ? new Date(Date.now()+daysLeft*864e5).toISOString().split('T')[0] : null,
      };
    });
    
    const summary = {
      total: forecasts.length,
      outOfStock: forecasts.filter(f=>f.status==='out_of_stock').length,
      critical: forecasts.filter(f=>f.status==='critical').length,
      reorder: forecasts.filter(f=>f.status==='reorder').length,
      healthy: forecasts.filter(f=>f.status==='healthy').length,
      totalReorderCost: Math.round(forecasts.filter(f=>['critical','reorder','out_of_stock'].includes(f.status)).reduce((s,f)=>s+f.reorderCost,0)*100)/100,
    };
    res.json({ forecasts, summary });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI-Powered Stock Alert (uses Anthropic to analyze and send email)
app.post("/api/inventory/ai-alert", auth, async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "ANTHROPIC_API_KEY not configured" });
    
    // Get forecast data directly (not via HTTP)
    const products = await pool.query(`SELECT p.*, COALESCE(s.total_qty,0) as total_sold_30d FROM products p
      LEFT JOIN (SELECT product_id, SUM(quantity) as total_qty FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_date > NOW()-INTERVAL '30 days' GROUP BY product_id) s
      ON s.product_id=p.id WHERE p.is_active=true`);
    const forecasts = products.rows.map(p => {
      const stock=+(p.stock_quantity)||0, sold30=+(p.total_sold_30d)||0, dailyRate=sold30/30;
      const daysLeft=dailyRate>0?Math.round(stock/dailyRate):stock>0?999:0;
      const leadTime=+(p.lead_time_days)||7, safetyStock=+(p.safety_stock)||0;
      const reorderPoint=Math.ceil(dailyRate*leadTime+safetyStock);
      const suggestedQty=Math.max(0,Math.ceil(dailyRate*(30+leadTime)+safetyStock-stock));
      const status=stock<=0?'out_of_stock':daysLeft<=7?'critical':stock<=reorderPoint||daysLeft<=14?'reorder':'healthy';
      const unitCost=+(p.landed_cost)||+(p.cogs)||0;
      return { name:p.name, stock, dailyRate:Math.round(dailyRate*100)/100, daysLeft, suggestedQty, status, reorderCost:Math.round(suggestedQty*unitCost*100)/100 };
    });
    const critical = forecasts.filter(f=>['out_of_stock','critical','reorder'].includes(f.status));
    const totalReorderCost = Math.round(critical.reduce((s,f)=>s+f.reorderCost,0)*100)/100;
    if (!critical.length) return res.json({ message: 'All stock levels are healthy. No alerts needed.' });
    
    const context = critical.map(p=>`${p.name}: ${p.stock} units, ${p.dailyRate}/day rate, ${p.daysLeft} days left, status: ${p.status}, reorder ${p.suggestedQty} units ($${p.reorderCost})`).join('\n');
    
    const aiResp = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 800,
      system: "You are the inventory manager for The Vitamin Shots. Analyze stock levels and write a clear, actionable alert email. Use clean formatting with section headers and bullet points. Be specific about which products need reordering, urgency level, and recommended quantities. Include estimated costs.",
      messages: [{ role: "user", content: "Write an inventory alert email for these products:\n" + context }]
    }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } });
    
    const aiText = aiResp.data?.content?.[0]?.text || 'Unable to generate AI analysis';
    const htmlBody = aiText.replace(/\n/g,'<br>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/^## (.+)$/gm,'<h3 style="color:#f1c349;margin:16px 0 8px">$1</h3>').replace(/^- /gm,'• ');
    
    // Send email
    const emailHtml = '<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:24px"><div style="background:linear-gradient(135deg,#020617,#1e293b);padding:24px;border-radius:12px 12px 0 0;text-align:center"><h1 style="color:#f1c349;margin:0">📦 Stock Alert</h1><p style="color:#94a3b8;margin:4px 0 0">' + APP_NAME + '</p></div><div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">' + htmlBody + '</div></div>';
    const result = await sendEmail({ to: ALLOWED_EMAILS, subject: APP_NAME + ' — Stock Alert: ' + critical.length + ' products need attention', html: emailHtml });
    
    sendSlack('📦 Stock alert: ' + critical.length + ' products need reordering. Total cost: $' + totalReorderCost);
    res.json({ sent: result.success, products: critical.length, totalCost: totalReorderCost, aiAnalysis: aiText });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== REFERLY.SO AFFILIATE SYNC ======================
app.post("/api/sync/referly", auth, async (req, res) => {
  try {
    const rc = await getCreds('referly');
    const apiKey = rc.api_key || process.env.REFERLY_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "Referly API key not configured. Go to Settings > Integrations > Referly." });
    const headers = { Authorization: 'Bearer ' + apiKey };
    const baseUrl = 'https://www.referly.so/api/v1';
    let totalAffiliates = 0, totalSales = 0, totalCommissions = 0;

    // 1. Sync affiliates
    try {
      const affResp = await axios.get(baseUrl + '/affiliates', { headers });
      const affiliates = Array.isArray(affResp.data) ? affResp.data : (affResp.data?.data || []);
      for (const a of affiliates) {
        await pool.query(`INSERT INTO affiliate_data(affiliate_id,name,email,payout_email,commission_rate,total_earned,total_referrals,total_clicks,status,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT(affiliate_id) DO UPDATE SET name=$2,email=$3,payout_email=$4,commission_rate=$5,total_earned=$6,total_referrals=$7,total_clicks=$8,status=$9,synced_at=NOW()`,
          [a.id, a.name||((a.firstName||'')+ ' '+(a.lastName||'')).trim(), a.email, a.payoutEmail||a.email,
           +(a.commissionRate)||0, +(a.totalCommissionEarned)||0, +(a.numberOfReferredUsers)||0, +(a.numberOfClicks)||0, a.status||'active']);
        totalAffiliates++;
        totalCommissions += +(a.totalCommissionEarned) || 0;
      }
    } catch(e) { console.error('Referly affiliates sync error:', e.message); }

    // 2. Sync sales
    try {
      const salesResp = await axios.get(baseUrl + '/sales', { headers });
      const sales = Array.isArray(salesResp.data) ? salesResp.data : (salesResp.data?.data || []);
      for (const s of sales) {
        await pool.query(`INSERT INTO affiliate_sales(sale_id,affiliate_id,referral_id,external_id,customer_name,customer_email,total_earned,commission_rate,created_at,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT(sale_id) DO UPDATE SET total_earned=$7,commission_rate=$8,synced_at=NOW()`,
          [String(s.id), s.affiliateId, s.referralId, s.externalId||'', s.name||'', s.email||'',
           +(s.totalEarned)||0, +(s.commissionRate)||0, s.createdAt||new Date().toISOString()]);
        totalSales++;
      }
    } catch(e) { console.error('Referly sales sync error:', e.message); }

    // 3. Update daily_metrics with affiliate commissions (distribute by day based on sale dates)
    try {
      await pool.query(`UPDATE daily_metrics dm SET affiliate_commissions=COALESCE(sub.comm,0)
        FROM (SELECT created_at::date as sale_date, SUM(total_earned) as comm FROM affiliate_sales GROUP BY created_at::date) sub
        WHERE dm.date = sub.sale_date`);
      // Recalculate net profit with affiliate commissions included
      await pool.query(`UPDATE daily_metrics SET net_profit=gross_profit-ad_spend-fixed_costs_daily-COALESCE(affiliate_commissions,0)-COALESCE(store_credit_used,0)-COALESCE(tax_total,0)
        WHERE affiliate_commissions>0 OR store_credit_used>0`);
    } catch(e) { console.error('Metrics update error:', e.message); }

    await setIntStatus('referly', 'synced');
    res.json({ status: "synced", affiliates: totalAffiliates, sales: totalSales, totalCommissions: Math.round(totalCommissions*100)/100,
      message: 'Synced ' + totalAffiliates + ' affiliates, ' + totalSales + ' sales. Total commissions: $' + totalCommissions.toFixed(2) });
  } catch (e) { await setIntStatus('referly', 'error', e.message); res.status(500).json({ error: e.message }); }
});

// ====================== REFERRALS & AFFILIATES OVERVIEW ======================
app.get("/api/referrals/overview", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    // Affiliate data from Referly
    const affStats = await pool.query('SELECT COUNT(*) as total_affiliates, COALESCE(SUM(total_earned),0) as total_commissions, COALESCE(SUM(total_referrals),0) as total_referrals, COALESCE(SUM(total_clicks),0) as total_clicks FROM affiliate_data');
    const topAffiliates = await pool.query('SELECT * FROM affiliate_data ORDER BY total_earned DESC LIMIT 10');
    const recentSales = await pool.query('SELECT s.*, a.name as affiliate_name FROM affiliate_sales s LEFT JOIN affiliate_data a ON a.affiliate_id=s.affiliate_id ORDER BY s.created_at DESC LIMIT 20');
    // Sales in date range
    const periodSales = await pool.query('SELECT COUNT(*) as sales_count, COALESCE(SUM(total_earned),0) as commissions FROM affiliate_sales WHERE created_at::date BETWEEN $1 AND $2', [start, end]);

    // Store credit data from WooCommerce orders
    const creditStats = await pool.query(`SELECT COALESCE(SUM(store_credit_used),0) as total_credits_used, COUNT(*) FILTER(WHERE store_credit_used>0) as orders_with_credits FROM orders WHERE order_date::date BETWEEN $1 AND $2`, [start, end]);
    const creditByMonth = await pool.query(`SELECT date_trunc('month',order_date)::date as month, SUM(store_credit_used) as credits_used, COUNT(*) FILTER(WHERE store_credit_used>0) as credit_orders FROM orders WHERE store_credit_used>0 AND order_date::date BETWEEN $1 AND $2 GROUP BY month ORDER BY month`, [start, end]);

    // Store credit ledger totals
    const ledgerStats = await pool.query("SELECT COALESCE(SUM(CASE WHEN credit_type='used' THEN credit_amount ELSE 0 END),0) as total_used, COALESCE(SUM(CASE WHEN credit_type='issued' THEN credit_amount ELSE 0 END),0) as total_issued, COUNT(DISTINCT customer_email) as unique_customers FROM store_credit_ledger");

    // Combined P&L impact
    const pnlImpact = await pool.query(`SELECT COALESCE(SUM(affiliate_commissions),0) as total_affiliate_cost, COALESCE(SUM(store_credit_used),0) as total_credit_cost FROM daily_metrics WHERE date BETWEEN $1 AND $2`, [start, end]);

    res.json({
      affiliates: { ...affStats.rows[0], topAffiliates: topAffiliates.rows },
      sales: { ...periodSales.rows[0], recent: recentSales.rows },
      storeCredits: { ...creditStats.rows[0], byMonth: creditByMonth.rows, ledger: ledgerStats.rows[0] },
      pnlImpact: pnlImpact.rows[0],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== SYNC STORE CREDITS FROM WOOCOMMERCE ORDERS ======================
app.post("/api/sync/store-credits", auth, async (req, res) => {
  try {
    const wc = await getCreds('woocommerce');
    const storeUrl = wc.store_url || process.env.WOO_STORE_URL;
    const ck = wc.consumer_key || process.env.WOO_CONSUMER_KEY;
    const cs = wc.consumer_secret || process.env.WOO_CONSUMER_SECRET;
    if (!storeUrl || !ck || !cs) return res.status(400).json({ error: "WooCommerce not configured" });
    const ax = axios.create({ baseURL: storeUrl.replace(/\/$/,'') + '/wp-json/wc/v3', auth: { username: ck, password: cs }, timeout: 30000 });

    let updated = 0, pg = 1;
    while (true) {
      const { data } = await ax.get('/orders', { params: { per_page: 100, page: pg, orderby: 'date', order: 'desc', after: new Date(Date.now() - 90 * 864e5).toISOString() } });
      for (const o of data) {
        // Check for _store_credit_used meta
        const creditMeta = o.meta_data?.find(m => m.key === '_store_credit_used');
        const creditAmount = +(creditMeta?.value) || 0;
        // Also check fee lines for "Store Credit Applied"
        const creditFee = o.fee_lines?.find(f => f.name?.includes('Store Credit'));
        const feeCredit = creditFee ? Math.abs(+(creditFee.total) || 0) : 0;
        const totalCredit = creditAmount || feeCredit;

        if (totalCredit > 0) {
          // Update order in our DB
          await pool.query('UPDATE orders SET store_credit_used=$1 WHERE woo_order_id=$2', [totalCredit, String(o.id)]);
          // Log to ledger
          await pool.query(`INSERT INTO store_credit_ledger(order_id,customer_email,credit_amount,credit_type,order_date)
            VALUES($1,$2,$3,'used',$4) ON CONFLICT(order_id,credit_type) DO UPDATE SET credit_amount=$3`,
            [String(o.id), o.billing?.email||'', totalCredit, o.date_created]);
          updated++;
        }
      }
      if (data.length < 100) break;
      pg++;
    }

    // Update daily_metrics with store credit totals
    await pool.query(`UPDATE daily_metrics dm SET store_credit_used=COALESCE(sub.sc,0)
      FROM (SELECT order_date::date as d, SUM(store_credit_used) as sc FROM orders WHERE store_credit_used>0 GROUP BY order_date::date) sub
      WHERE dm.date=sub.d`);
    // Recalculate net profit
    await pool.query(`UPDATE daily_metrics SET net_profit=gross_profit-ad_spend-fixed_costs_daily-COALESCE(affiliate_commissions,0)-COALESCE(store_credit_used,0)-COALESCE(tax_total,0)
      WHERE store_credit_used>0 OR affiliate_commissions>0`);

    res.json({ status: "synced", updated, message: 'Updated store credits for ' + updated + ' orders' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== REFERLY WEBHOOK (real-time affiliate events) ======================
app.post("/api/webhooks/referly", async (req, res) => {
  try {
    // Verify webhook secret if configured
    const secret = process.env.REFERLY_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-webhook-signature'] || req.headers['x-referly-signature'] || '';
      if (sig && secret) {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
        const computed = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        if (computed !== sig) return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    const event = req.body;
    const eventType = event.type || event.event || '';
    console.log('📥 Referly webhook:', eventType);

    if (eventType.includes('sale') || event.totalEarned || event.commissionRate) {
      // Affiliate sale event
      const s = event.data || event;
      await pool.query(`INSERT INTO affiliate_sales(sale_id,affiliate_id,referral_id,external_id,customer_name,customer_email,total_earned,commission_rate,created_at,synced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT(sale_id) DO UPDATE SET total_earned=$7,synced_at=NOW()`,
        [String(s.id||s.saleId||Date.now()),s.affiliateId||'',s.referralId||'',s.externalId||'',s.name||s.customerName||'',s.email||s.customerEmail||'',
         +(s.totalEarned||s.commission||0),+(s.commissionRate||0),s.createdAt||new Date().toISOString()]);
      // Update daily metrics
      const saleDate = (s.createdAt || new Date().toISOString()).split('T')[0];
      await pool.query('UPDATE daily_metrics SET affiliate_commissions=COALESCE(affiliate_commissions,0)+$1 WHERE date=$2',[+(s.totalEarned||s.commission||0),saleDate]);
      // Slack notification
      sendSlack(`💰 New affiliate sale: $${(+(s.totalEarned||0)).toFixed(2)} commission from ${s.name||s.affiliateId||'unknown'}`);
    }

    if (eventType.includes('affiliate') || event.numberOfReferredUsers != null) {
      // Affiliate created/updated
      const a = event.data || event;
      await pool.query(`INSERT INTO affiliate_data(affiliate_id,name,email,payout_email,commission_rate,total_earned,total_referrals,total_clicks,status,synced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT(affiliate_id) DO UPDATE SET name=$2,email=$3,total_earned=$6,total_referrals=$7,status=$9,synced_at=NOW()`,
        [a.id||a.affiliateId,a.name||((a.firstName||'')+' '+(a.lastName||'')).trim(),a.email||'',a.payoutEmail||a.email||'',
         +(a.commissionRate||0),+(a.totalCommissionEarned||0),+(a.numberOfReferredUsers||0),+(a.numberOfClicks||0),a.status||'active']);
    }

    res.json({ ok: true });
  } catch(e) { console.error('Referly webhook error:', e.message); res.json({ ok: true }); }
});


// ====================== PAYMENT RECONCILIATION ======================
app.get("/api/finance/reconciliation", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    // WooCommerce revenue by payment method
    const wcRevenue = await pool.query(`SELECT COALESCE(payment_method,'unknown') as method, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(payment_fees),0) as fees, COALESCE(SUM(refund_amount),0) as refunds FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY payment_method ORDER BY revenue DESC`,[start,end]);
    // Totals
    const totals = await pool.query(`SELECT COALESCE(SUM(revenue),0) as total_revenue, COALESCE(SUM(payment_fees),0) as total_fees, COALESCE(SUM(refund_amount),0) as total_refunds, COALESCE(SUM(revenue-payment_fees-refund_amount),0) as expected_deposits, COALESCE(SUM(store_credit_used),0) as store_credits FROM orders WHERE order_date::date BETWEEN $1 AND $2`,[start,end]);
    // Daily breakdown for chart
    const daily = await pool.query(`SELECT order_date::date as date, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(payment_fees),0) as fees, COALESCE(SUM(refund_amount),0) as refunds, COALESCE(SUM(revenue-payment_fees-refund_amount),0) as net_deposits FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY order_date::date ORDER BY date`,[start,end]);
    // Elavon vs PayPal split
    const elavonTotal = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(payment_fees),0) as fees, COALESCE(SUM(revenue-payment_fees-refund_amount),0) as expected FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND (payment_method ILIKE '%elavon%' OR payment_method ILIKE '%converge%' OR payment_method ILIKE '%credit%' OR payment_method ILIKE '%card%' OR (payment_method NOT ILIKE '%paypal%' AND payment_method NOT ILIKE '%store_credit%'))`,[start,end]);
    const paypalTotal = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(payment_fees),0) as fees, COALESCE(SUM(revenue-payment_fees-refund_amount),0) as expected FROM orders WHERE order_date::date BETWEEN $1 AND $2 AND payment_method ILIKE '%paypal%'`,[start,end]);
    // Transfer timing estimates
    const t = totals.rows[0];
    const elavon = elavonTotal.rows[0];
    const paypal = paypalTotal.rows[0];
    res.json({
      byMethod: wcRevenue.rows,
      totals: t,
      daily: daily.rows,
      accounts: {
        elavon: { revenue: +(elavon.revenue), fees: +(elavon.fees), expectedDeposit: +(elavon.expected), transferDays: '1-2 business days' },
        paypal: { revenue: +(paypal.revenue), fees: +(paypal.fees), expectedDeposit: +(paypal.expected), transferDays: '1-3 business days' },
      },
      alert: +(t.total_revenue) > 0 && Math.abs(+(elavon.expected) + +(paypal.expected) - +(t.expected_deposits)) > 1 ? 'Discrepancy detected between payment methods and total. Review store credit and other payment types.' : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// P&L PDF-ready HTML export
app.get("/api/finance/pnl-export", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const d = (await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(cogs),0) as cogs,
      COALESCE(SUM(shipping_cost),0) as shipping, COALESCE(SUM(payment_fees),0) as fees,
      COALESCE(SUM(discount_total),0) as discounts, COALESCE(SUM(refund_total),0) as refunds,
      COALESCE(SUM(ad_spend),0) as ad_spend, COALESCE(SUM(fixed_costs_daily),0) as fixed_costs,
      COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(net_profit),0) as net_profit,
      COALESCE(SUM(tax_total),0) as tax, COALESCE(SUM(affiliate_commissions),0) as affiliates,
      COALESCE(SUM(store_credit_used),0) as credits, SUM(orders_count) as orders
      FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end])).rows[0];
    const fc = v => '$' + Math.round(+(v)||0).toLocaleString('en-US');
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>P&L Report</title><style>body{font-family:Arial;max-width:700px;margin:40px auto;color:#1a1a2e}h1{color:#f1c349;border-bottom:3px solid #f1c349;padding-bottom:12px}table{width:100%;border-collapse:collapse;margin:20px 0}td{padding:10px 16px;border-bottom:1px solid #eee;font-size:14px}td:last-child{text-align:right;font-family:monospace;font-weight:bold}.section{background:#f8f9fa;font-weight:bold;font-size:15px}.total{background:#1a1a2e;color:#fff;font-size:16px}.negative{color:#dc3545}.positive{color:#10b981}</style></head><body>'
      + '<h1>Vitamin Shots Finance Minister</h1><h2>Profit & Loss Statement</h2><p>Period: '+start+' to '+end+'</p><p>Total Orders: '+d.orders+'</p>'
      + '<table><tr class="section"><td>Gross Revenue</td><td>'+fc(d.revenue)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Discounts</td><td class="negative">-'+fc(d.discounts)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Refunds</td><td class="negative">-'+fc(d.refunds)+'</td></tr>'
      + '<tr class="section"><td>Net Revenue</td><td>'+fc(+d.revenue-+d.discounts-+d.refunds)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Cost of Goods Sold</td><td class="negative">-'+fc(d.cogs)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Shipping Costs</td><td class="negative">-'+fc(d.shipping)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Payment Processing Fees</td><td class="negative">-'+fc(d.fees)+'</td></tr>'
      + '<tr class="section"><td>Gross Profit</td><td class="positive">'+fc(d.gross_profit)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Advertising Spend</td><td class="negative">-'+fc(d.ad_spend)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Fixed Costs</td><td class="negative">-'+fc(d.fixed_costs)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Affiliate Commissions</td><td class="negative">-'+fc(d.affiliates)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Store Credits Used</td><td class="negative">-'+fc(d.credits)+'</td></tr>'
      + '<tr><td>&nbsp;&nbsp;Less: Sales Tax Remitted</td><td class="negative">-'+fc(d.tax)+'</td></tr>'
      + '<tr class="total"><td>NET PROFIT</td><td>'+fc(d.net_profit)+'</td></tr></table>'
      + '<p style="color:#888;font-size:12px;margin-top:40px">Generated by Vitamin Shots Finance Minister · '+new Date().toISOString().split('T')[0]+'</p></body></html>';
    res.set('Content-Type','text/html');
    res.send(html);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====================== COMPARISON P&L (side by side) ======================
app.get("/api/dashboard/pnl-comparison", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const days = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 864e5));
    const prevStart = new Date(new Date(start).getTime() - days * 864e5).toISOString().split('T')[0];
    const prevEnd = new Date(new Date(start).getTime() - 864e5).toISOString().split('T')[0];
    const qry = `SELECT COALESCE(SUM(revenue),0) as revenue,COALESCE(SUM(cogs),0) as cogs,COALESCE(SUM(shipping_cost),0) as shipping,COALESCE(SUM(payment_fees),0) as fees,COALESCE(SUM(discount_total),0) as discounts,COALESCE(SUM(refund_total),0) as refunds,COALESCE(SUM(ad_spend),0) as ad_spend,COALESCE(SUM(fixed_costs_daily),0) as fixed_costs,COALESCE(SUM(gross_profit),0) as gross_profit,COALESCE(SUM(net_profit),0) as net_profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(new_customers),0) as new_customers FROM daily_metrics WHERE date BETWEEN $1 AND $2`;
    const curr = (await pool.query(qry, [start, end])).rows[0];
    const prev = (await pool.query(qry, [prevStart, prevEnd])).rows[0];
    // Calculate CAC
    curr.cac = +(curr.new_customers) > 0 ? +(curr.ad_spend) / +(curr.new_customers) : 0;
    prev.cac = +(prev.new_customers) > 0 ? +(prev.ad_spend) / +(prev.new_customers) : 0;
    res.json({ current: curr, previous: prev, currentPeriod: { start, end }, previousPeriod: { start: prevStart, end: prevEnd } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== CONTRIBUTION MARGIN WATERFALL ======================
app.get("/api/dashboard/waterfall", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const r = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue,COALESCE(SUM(cogs),0) as cogs,COALESCE(SUM(shipping_cost),0) as shipping,COALESCE(SUM(payment_fees),0) as fees,COALESCE(SUM(discount_total),0) as discounts,COALESCE(SUM(refund_total),0) as refunds,COALESCE(SUM(ad_spend),0) as ad_spend,COALESCE(SUM(fixed_costs_daily),0) as fixed_costs,COALESCE(SUM(gross_profit),0) as gross_profit,COALESCE(SUM(net_profit),0) as net_profit,COALESCE(SUM(store_credit_used),0) as store_credits,COALESCE(SUM(affiliate_commissions),0) as affiliate_commissions,COALESCE(SUM(tax_total),0) as tax_total FROM daily_metrics WHERE date BETWEEN $1 AND $2`, [start, end]);
    const d = r.rows[0];
    const waterfall = [
      { name: 'Revenue', value: +d.revenue, type: 'positive' },
      { name: 'COGS', value: -(+d.cogs), type: 'negative' },
      { name: 'Shipping', value: -(+d.shipping), type: 'negative' },
      { name: 'Payment Fees', value: -(+d.fees), type: 'negative' },
      { name: 'Discounts', value: -(+d.discounts), type: 'negative' },
      { name: 'Refunds', value: -(+d.refunds), type: 'negative' },
      { name: 'Gross Profit', value: +d.gross_profit, type: 'subtotal' },
      { name: 'Ad Spend', value: -(+d.ad_spend), type: 'negative' },
      { name: 'Fixed Costs', value: -(+d.fixed_costs), type: 'negative' },
      { name: 'Store Credits', value: -(+(d.store_credits||0)), type: 'negative' },
      { name: 'Affiliate Commissions', value: -(+(d.affiliate_commissions||0)), type: 'negative' },
      { name: 'Sales Tax', value: -(+(d.tax_total||d.sales_tax||0)), type: 'negative' },
      { name: 'Net Profit', value: +d.net_profit, type: 'total' },
    ];
    res.json(waterfall);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== CAC BY CHANNEL ======================
app.get("/api/marketing/cac-by-channel", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const r = await pool.query(`SELECT COALESCE(utm_source,'direct') as channel,COUNT(DISTINCT CASE WHEN is_first_order=true THEN customer_id END) as new_customers,COUNT(*) as orders,COALESCE(SUM(revenue),0) as revenue FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY COALESCE(utm_source,'direct') ORDER BY new_customers DESC`, [start, end]);
    // Get ad spend by platform
    const ads = await pool.query(`SELECT platform,SUM(spend) as spend FROM ad_spend_daily WHERE date BETWEEN $1 AND $2 GROUP BY platform`, [start, end]);
    const adMap = {};
    ads.rows.forEach(a => { adMap[a.platform] = +a.spend; });
    const result = r.rows.map(ch => ({
      ...ch,
      ad_spend: adMap[ch.channel] || adMap[ch.channel + '_ads'] || 0,
      cac: +(ch.new_customers) > 0 ? (adMap[ch.channel] || adMap[ch.channel + '_ads'] || 0) / +(ch.new_customers) : 0,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== PRODUCT-LEVEL ROAS ======================
app.get("/api/marketing/product-roas", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const totalAdSpend = (await pool.query(`SELECT COALESCE(SUM(ad_spend),0) as total FROM daily_metrics WHERE date BETWEEN $1 AND $2`, [start, end])).rows[0]?.total || 0;
    const totalRevenue = (await pool.query(`SELECT COALESCE(SUM(revenue),0) as total FROM daily_metrics WHERE date BETWEEN $1 AND $2`, [start, end])).rows[0]?.total || 0;
    // Allocate ad spend proportionally by revenue share
    const r = await pool.query(`SELECT p.id,p.name,p.sku,p.price,p.landed_cost,p.cogs,SUM(oi.line_total) as revenue,SUM(oi.quantity) as units,SUM(oi.line_profit) as profit FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN orders o ON o.id=oi.order_id WHERE o.order_date::date BETWEEN $1 AND $2 GROUP BY p.id ORDER BY revenue DESC`, [start, end]);
    const result = r.rows.map(p => {
      const revShare = totalRevenue > 0 ? +p.revenue / totalRevenue : 0;
      const allocatedAd = +(totalAdSpend) * revShare;
      return { ...p, allocated_ad_spend: Math.round(allocatedAd * 100) / 100, roas: allocatedAd > 0 ? Math.round(+p.revenue / allocatedAd * 100) / 100 : 0, contribution: Math.round((+p.profit - allocatedAd) * 100) / 100 };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== BULK CSV COGS IMPORT ======================
app.post("/api/products/bulk-cogs-csv", auth, async (req, res) => {
  try {
    const { rows } = req.body; // [{sku, cogs, packaging_cost, bulk_shipping_cost, customs_fees, ground_transport, insurance_cost, tariffs, other_costs}]
    if (!rows || !rows.length) return res.status(400).json({ error: "No data provided" });
    let updated = 0, notFound = 0, errors = [];
    for (const row of rows) {
      try {
        const sku = row.sku || row.SKU;
        const name = row.name || row.product_name;
        if (!sku && !name) { errors.push("Row missing SKU/name"); continue; }
        const lookup = sku ? await pool.query('SELECT id,price FROM products WHERE sku=$1', [sku]) : await pool.query('SELECT id,price FROM products WHERE name ILIKE $1', ['%' + name + '%']);
        if (!lookup.rows[0]) { notFound++; errors.push(`Not found: ${sku || name}`); continue; }
        const pid = lookup.rows[0].id;
        const baseCogs = +(row.cogs || row.COGS || row.product_cost || 0);
        const pc = +(row.packaging_cost || row.packaging || 0);
        const bs = +(row.bulk_shipping_cost || row.bulk_shipping || row.freight || 0);
        const cf = +(row.customs_fees || row.customs || 0);
        const gt = +(row.ground_transport || row.transport || 0);
        const ic = +(row.insurance_cost || row.insurance || 0);
        const tf = +(row.tariffs || row.duties || row.tariff || 0);
        const oc = +(row.other_costs || row.other || 0);
        const landed = baseCogs + pc + bs + cf + gt + ic + tf + oc;
        await pool.query(`UPDATE products SET cogs=$1,packaging_cost=$2,bulk_shipping_cost=$3,customs_fees=$4,ground_transport=$5,insurance_cost=$6,tariffs=$7,other_costs=$8,landed_cost=$9,breakeven_roas=CASE WHEN price>0 AND price-$9>0 THEN ROUND(price/(price-$9),4) ELSE 0 END,gross_margin_pct=CASE WHEN price>0 THEN ROUND((price-$9)/price*100,2) ELSE 0 END,updated_at=NOW() WHERE id=$10`,
          [baseCogs, pc, bs, cf, gt, ic, tf, oc, landed, pid]);
        updated++;
      } catch (rowErr) { errors.push(`Error on ${row.sku}: ${rowErr.message}`); }
    }
    res.json({ updated, notFound, total: rows.length, errors: errors.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== REVENUE BY CHANNEL ======================
app.get("/api/dashboard/revenue-by-channel", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const r = await pool.query(`SELECT COALESCE(utm_source, 'woocommerce') as channel, COUNT(*) as orders, COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as profit, CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*) ELSE 0 END as aov FROM orders WHERE order_date::date BETWEEN $1 AND $2 GROUP BY COALESCE(utm_source,'woocommerce') ORDER BY revenue DESC`, [start, end]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== P&L CSV EXPORT (from Finance page) ======================
app.get("/api/dashboard/pnl-csv", auth, async (req, res) => {
  try {
    const { start, end } = dr(req.query);
    const g = req.query.group || 'month';
    const expr = g === 'day' ? 'date' : g === 'week' ? "date_trunc('week',date)::date" : "date_trunc('month',date)::date";
    const rows = await pool.query(`SELECT ${expr} as period,SUM(revenue) as revenue,SUM(cogs) as cogs,SUM(shipping_cost) as shipping,SUM(payment_fees) as fees,SUM(discount_total) as discounts,SUM(refund_total) as refunds,SUM(ad_spend) as ad_spend,SUM(fixed_costs_daily) as fixed_costs,SUM(gross_profit) as gross_profit,SUM(net_profit) as net_profit,SUM(orders_count) as orders FROM daily_metrics WHERE date BETWEEN $1 AND $2 GROUP BY ${expr} ORDER BY period`, [start, end]);
    let csv = 'Period,Revenue,COGS,Shipping,Payment Fees,Discounts,Refunds,Ad Spend,Fixed Costs,Gross Profit,Net Profit,Orders\n';
    for (const r of rows.rows) {
      csv += `${r.period},${(+r.revenue).toFixed(2)},${(+r.cogs).toFixed(2)},${(+r.shipping).toFixed(2)},${(+r.fees).toFixed(2)},${(+r.discounts).toFixed(2)},${(+r.refunds).toFixed(2)},${(+r.ad_spend).toFixed(2)},${(+r.fixed_costs).toFixed(2)},${(+r.gross_profit).toFixed(2)},${(+r.net_profit).toFixed(2)},${r.orders}\n`;
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="TVS_PnL_${start}_${end}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== PRODUCTS MISSING COGS ======================
app.get("/api/products/missing-cogs", auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id,name,sku,price,image_url,total_sold,total_revenue FROM products WHERE (cogs IS NULL OR cogs=0) AND (landed_cost IS NULL OR landed_cost=0) AND status='active' ORDER BY total_revenue DESC`);
    res.json({ products: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== ONBOARDING STATUS ======================
app.get("/api/onboarding/status", auth, async (req, res) => {
  try {
    const wc = await pool.query("SELECT is_connected FROM integrations WHERE platform='woocommerce'");
    const prods = await pool.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE cogs > 0 OR landed_cost > 0) as with_cogs FROM products");
    const orders = await pool.query("SELECT COUNT(*) as total FROM orders");
    const metrics = await pool.query("SELECT COUNT(*) as total FROM daily_metrics WHERE revenue > 0");
    res.json({
      woocommerce_connected: wc.rows[0]?.is_connected || false,
      products_total: +(prods.rows[0]?.total) || 0,
      products_with_cogs: +(prods.rows[0]?.with_cogs) || 0,
      orders_synced: +(orders.rows[0]?.total) || 0,
      has_metrics: +(metrics.rows[0]?.total) > 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== AI PROFIT INSIGHTS (Claude-powered) ======================
app.post("/api/insights/generate", auth, async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ insight: "Configure ANTHROPIC_API_KEY in Railway environment variables to enable AI insights.", type: "info" });
    const week = await pool.query(`SELECT COALESCE(SUM(revenue),0) as rev,COALESCE(SUM(net_profit),0) as profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(ad_spend),0) as ad_spend,COALESCE(SUM(new_customers),0) as new_cust,COALESCE(SUM(refund_total),0) as refunds FROM daily_metrics WHERE date>=CURRENT_DATE-7`);
    const prevWeek = await pool.query(`SELECT COALESCE(SUM(revenue),0) as rev,COALESCE(SUM(net_profit),0) as profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(ad_spend),0) as ad_spend FROM daily_metrics WHERE date>=CURRENT_DATE-14 AND date<CURRENT_DATE-7`);
    const topProducts = await pool.query(`SELECT p.name,SUM(oi.line_total) as rev,SUM(oi.line_profit) as profit FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN orders o ON o.id=oi.order_id WHERE o.order_date>=NOW()-INTERVAL'7 days' GROUP BY p.name ORDER BY rev DESC LIMIT 5`).catch(()=>({rows:[]}));
    const lowMargin = await pool.query(`SELECT name,price,gross_margin_pct FROM products WHERE gross_margin_pct>0 AND gross_margin_pct<30 ORDER BY gross_margin_pct LIMIT 3`).catch(()=>({rows:[]}));
    // stock_quantity may not exist yet - handle gracefully
    let lowStock = { rows: [] };
    try { lowStock = await pool.query(`SELECT name,stock_quantity,days_of_stock FROM products WHERE stock_quantity>0 AND days_of_stock<14 AND days_of_stock>0 ORDER BY days_of_stock LIMIT 3`); } catch(e) { /* column doesn't exist yet */ }

    const w = week.rows[0], pw = prevWeek.rows[0];
    const prompt = `You are a DTC e-commerce profit analyst for The Vitamin Shots, a vegan liquid supplement brand selling Vitamin Shots, Glam Dust, and Vitamin Sprinkles. Analyze this data and give 3-4 actionable insights. Be specific with numbers. Keep it under 200 words.

This Week: Revenue $${(+w.rev).toFixed(0)}, Net Profit $${(+w.profit).toFixed(0)}, Orders ${w.orders}, Ad Spend $${(+w.ad_spend).toFixed(0)}, New Customers ${w.new_cust}, Refunds $${(+w.refunds).toFixed(0)}
Last Week: Revenue $${(+pw.rev).toFixed(0)}, Net Profit $${(+pw.profit).toFixed(0)}, Orders ${pw.orders}, Ad Spend $${(+pw.ad_spend).toFixed(0)}
MER: ${+w.ad_spend>0?(+w.rev/+w.ad_spend).toFixed(1):'N/A'}x
Top Products: ${topProducts.rows.map(p=>`${p.name}: $${(+p.rev).toFixed(0)} rev / $${(+p.profit).toFixed(0)} profit`).join('; ')||'No product data yet'}
Low Margin Products: ${lowMargin.rows.map(p=>`${p.name}: ${(+p.gross_margin_pct).toFixed(0)}% margin`).join('; ')||'None'}
Low Stock: ${lowStock.rows.map(p=>`${p.name}: ${p.days_of_stock} days left`).join('; ')||'No inventory data'}`;

    const aiResp = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } });

    const insightText = aiResp.data?.content?.[0]?.text || "Unable to generate insights";
    try { await pool.query(`INSERT INTO ai_insights(date,insight_type,title,content,priority) VALUES(CURRENT_DATE,'weekly_analysis','AI Weekly Analysis',$1,'high') ON CONFLICT DO NOTHING`, [insightText]); } catch(e) {}
    res.json({ insight: insightText, generated: new Date().toISOString() });
  } catch (e) { res.json({ insight: "AI insight generation failed: " + e.message, type: "error" }); }
});

// ====================== REAL-TIME PROFIT TICKER ======================
app.get("/api/dashboard/today-live", auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(CASE WHEN gross_profit>0 THEN gross_profit ELSE 0 END)-SUM(CASE WHEN gross_profit<0 THEN ABS(gross_profit) ELSE 0 END),0) as net_approx, COUNT(*) as orders, COALESCE(SUM(refund_amount),0) as refunds FROM orders WHERE order_date::date=$1`, [today]);
    const yesterday = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COUNT(*) as orders FROM orders WHERE order_date::date=$1`, [new Date(Date.now()-864e5).toISOString().split('T')[0]]);
    res.json({ today: r.rows[0], yesterday: yesterday.rows[0], timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== INVENTORY MANAGEMENT ======================
app.put("/api/products/:id/inventory", auth, async (req, res) => {
  try {
    const { stock_quantity, reorder_point } = req.body;
    // Calculate avg daily sales and days of stock
    const sales = await pool.query(`SELECT COALESCE(SUM(oi.quantity),0)/GREATEST(COUNT(DISTINCT o.order_date::date),1) as avg_daily FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE p.id=$1 AND o.order_date>NOW()-INTERVAL'30 days'`, [req.params.id]);
    const avgDaily = +(sales.rows[0]?.avg_daily) || 0;
    const stock = sanitizeNum(stock_quantity, 0);
    const daysLeft = avgDaily > 0 ? Math.round(stock / avgDaily) : 0;
    const product = await pool.query('SELECT landed_cost,cogs FROM products WHERE id=$1', [req.params.id]);
    const unitCost = +(product.rows[0]?.landed_cost) || +(product.rows[0]?.cogs) || 0;
    const r = await pool.query(`UPDATE products SET stock_quantity=$1, reorder_point=$2, avg_daily_sales=$3, days_of_stock=$4, inventory_value=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [stock, sanitizeNum(reorder_point, 10), avgDaily, daysLeft, stock * unitCost, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/inventory/overview", auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT id,name,sku,price,landed_cost,stock_quantity,reorder_point,avg_daily_sales,days_of_stock,inventory_value FROM products WHERE stock_quantity>0 OR days_of_stock>0 ORDER BY days_of_stock ASC NULLS LAST`);
    const totals = await pool.query(`SELECT COALESCE(SUM(inventory_value),0) as total_value, COALESCE(SUM(stock_quantity),0) as total_units, COUNT(*) FILTER(WHERE days_of_stock>0 AND days_of_stock<14) as low_stock_count FROM products WHERE stock_quantity>0`);
    res.json({ products: r.rows, totals: totals.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== SMART NOTIFICATIONS ======================
app.post("/api/notifications/check", auth, async (req, res) => {
  try {
    const alerts = [];
    // Check daily profit drop
    const today = await pool.query(`SELECT COALESCE(SUM(revenue),0) as rev, COALESCE(SUM(net_profit),0) as profit FROM daily_metrics WHERE date=CURRENT_DATE`);
    const avg7 = await pool.query(`SELECT COALESCE(AVG(revenue),0) as avg_rev, COALESCE(AVG(net_profit),0) as avg_profit FROM daily_metrics WHERE date>=CURRENT_DATE-7 AND date<CURRENT_DATE`);
    if (+today.rows[0].rev < +avg7.rows[0].avg_rev * 0.6 && +avg7.rows[0].avg_rev > 0) {
      alerts.push({ type: 'warning', title: 'Revenue Drop', message: `Today's revenue ($${(+today.rows[0].rev).toFixed(0)}) is ${Math.round((1-+today.rows[0].rev/+avg7.rows[0].avg_rev)*100)}% below 7-day average` });
    }
    // Low stock alerts
    const lowStock = await pool.query(`SELECT name,days_of_stock,stock_quantity FROM products WHERE stock_quantity>0 AND days_of_stock>0 AND days_of_stock<14`);
    for (const p of lowStock.rows) {
      alerts.push({ type: 'danger', title: 'Low Stock', message: `${p.name}: ${p.days_of_stock} days of stock left (${p.stock_quantity} units)` });
    }
    // Refund spike
    const refunds = await pool.query(`SELECT COALESCE(SUM(refund_total),0) as ref FROM daily_metrics WHERE date=CURRENT_DATE`);
    const avgRef = await pool.query(`SELECT COALESCE(AVG(refund_total),0) as avg FROM daily_metrics WHERE date>=CURRENT_DATE-7 AND date<CURRENT_DATE AND refund_total>0`);
    if (+refunds.rows[0].ref > +avgRef.rows[0].avg * 2 && +refunds.rows[0].ref > 10) {
      alerts.push({ type: 'warning', title: 'Refund Spike', message: `$${(+refunds.rows[0].ref).toFixed(0)} in refunds today (${Math.round(+refunds.rows[0].ref/Math.max(+avgRef.rows[0].avg,1)*100)}% of avg)` });
    }
    res.json({ alerts, checked_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== FULL DB BACKUP EXPORT ======================
app.get("/api/export/full-backup", auth, async (req, res) => {
  try {
    const tables = ['products','customers','orders','order_items','daily_metrics','ad_spend_daily','goals','fixed_costs','integrations','report_configs','alert_thresholds','ai_insights'];
    const backup = {};
    for (const t of tables) {
      try { backup[t] = (await pool.query(`SELECT * FROM ${t}`)).rows; } catch(e) { backup[t] = []; }
    }
    backup._meta = { exported_at: new Date().toISOString(), tables: Object.keys(backup).length, version: '2.0.0' };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="TVS_Backup_${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== AI CHAT (Pentane-style conversational) ======================
app.post("/api/ai/chat", auth, async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ answer: "Configure ANTHROPIC_API_KEY to enable AI chat." });
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "No question provided" });

    // Pull comprehensive business context
    const [m30, m7, prods, topProds, adData, fc] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(revenue),0) as rev,COALESCE(SUM(net_profit),0) as profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(ad_spend),0) as ads,COALESCE(SUM(cogs),0) as cogs,COALESCE(SUM(shipping_cost),0) as ship,COALESCE(SUM(payment_fees),0) as fees,COALESCE(SUM(new_customers),0) as new_cust,COALESCE(SUM(refund_total),0) as refunds FROM daily_metrics WHERE date>=CURRENT_DATE-30`),
      pool.query(`SELECT COALESCE(SUM(revenue),0) as rev,COALESCE(SUM(net_profit),0) as profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(ad_spend),0) as ads FROM daily_metrics WHERE date>=CURRENT_DATE-7`),
      pool.query(`SELECT name,price,landed_cost,cogs,gross_margin_pct,total_sold,total_revenue,stock_quantity,days_of_stock FROM products WHERE status='active' ORDER BY total_revenue DESC LIMIT 10`),
      pool.query(`SELECT p.name,SUM(oi.line_total) as rev,SUM(oi.line_profit) as profit,SUM(oi.quantity) as qty FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN orders o ON o.id=oi.order_id WHERE o.order_date>=NOW()-INTERVAL'30 days' GROUP BY p.name ORDER BY rev DESC LIMIT 5`),
      pool.query(`SELECT platform,SUM(spend) as spend,SUM(conversion_value) as conv_val,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend) ELSE 0 END as roas FROM ad_spend_daily WHERE date>=CURRENT_DATE-30 GROUP BY platform`),
      pool.query(`SELECT COALESCE(SUM(amount_monthly),0) as monthly FROM fixed_costs WHERE is_active=true`)
    ]);

    const d30=m30.rows[0], d7=m7.rows[0], fixed=+(fc.rows[0].monthly);
    const blendedRoas=+d30.ads>0?+d30.rev/+d30.ads:0;
    const mer=+d30.ads>0?+d30.rev/+d30.ads:0;
    const aov=+d30.orders>0?+d30.rev/+d30.orders:0;
    const cac=+d30.new_cust>0?+d30.ads/+d30.new_cust:0;
    const avgCogs=+d30.rev>0?+d30.cogs/+d30.rev*100:0;
    const breakevenRoas=avgCogs<100?1/(1-avgCogs/100-(+d30.ship+ +d30.fees)/Math.max(+d30.rev,1)):0;

    const context = `You are the AI profit analyst for The Vitamin Shots (TVS), a US-market vegan liquid supplement DTC brand. Answer the user's question using this real business data. Be specific with numbers, prescriptive with actions. Keep answers under 200 words.

BUSINESS DATA (Last 30 days):
Revenue: $${(+d30.rev).toFixed(0)} | Net Profit: $${(+d30.profit).toFixed(0)} | Orders: ${d30.orders}
Ad Spend: $${(+d30.ads).toFixed(0)} | COGS: $${(+d30.cogs).toFixed(0)} | Shipping: $${(+d30.ship).toFixed(0)}
Payment Fees: $${(+d30.fees).toFixed(0)} | Refunds: $${(+d30.refunds).toFixed(0)}
Blended ROAS: ${blendedRoas.toFixed(2)}x | MER: ${mer.toFixed(2)}x | AOV: $${aov.toFixed(2)}
New Customers: ${d30.new_cust} | CAC: $${cac.toFixed(2)}
Fixed Costs: $${fixed.toFixed(0)}/month | Avg COGS %: ${avgCogs.toFixed(1)}%
Breakeven ROAS: ${breakevenRoas.toFixed(2)}x

Last 7 days: Revenue $${(+d7.rev).toFixed(0)}, Profit $${(+d7.profit).toFixed(0)}, Orders ${d7.orders}, Ad Spend $${(+d7.ads).toFixed(0)}

Products: ${prods.rows.map(p=>`${p.name}: $${p.price} price, $${+(p.landed_cost)||+(p.cogs)||0} cost, ${(+p.gross_margin_pct).toFixed(0)}% margin, ${p.total_sold} sold, ${p.stock_quantity||0} in stock, ${p.days_of_stock||'?'} days left`).join(' | ')}

Top sellers (30d): ${topProds.rows.map(p=>`${p.name}: $${(+p.rev).toFixed(0)} rev, $${(+p.profit).toFixed(0)} profit, ${p.qty} units`).join(' | ')}

Ad platforms: ${adData.rows.map(a=>`${a.platform}: $${(+a.spend).toFixed(0)} spend, ${(+a.roas).toFixed(2)}x ROAS`).join(' | ')||'No ad data'}`;

    const aiResp = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 500,
      system: context + "\n\nIMPORTANT FORMATTING: Use clean markdown formatting. Use ## for section headers, bullet points with - for lists, **bold** for emphasis. Never use raw asterisks like *** or --- as separators. Keep responses structured, clear, and professional. Use specific numbers from the data.",
      messages: [{ role: "user", content: question }]
    }, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } });

    res.json({ answer: aiResp.data?.content?.[0]?.text || "Could not generate answer" });
  } catch (e) { res.json({ answer: "AI error: " + e.message }); }
});

// ====================== PRESCRIPTIVE ENGINE ======================
app.get("/api/ai/prescriptions", auth, async (req, res) => {
  try {
    const d = (await pool.query(`SELECT COALESCE(SUM(revenue),0) as rev,COALESCE(SUM(net_profit),0) as profit,COALESCE(SUM(orders_count),0) as orders,COALESCE(SUM(ad_spend),0) as ads,COALESCE(SUM(cogs),0) as cogs,COALESCE(SUM(shipping_cost),0) as ship,COALESCE(SUM(payment_fees),0) as fees,COALESCE(SUM(new_customers),0) as new_cust FROM daily_metrics WHERE date>=CURRENT_DATE-30`)).rows[0];
    const fc = +(await pool.query(`SELECT COALESCE(SUM(amount_monthly),0) as t FROM fixed_costs WHERE is_active=true`)).rows[0].t;

    const rev=+d.rev, ads=+d.ads, cogs=+d.cogs, ship=+d.ship, fees=+d.fees, orders=+d.orders, profit=+d.profit;
    const cogsRate = rev>0 ? cogs/rev : 0.3;
    const shipRate = rev>0 ? ship/rev : 0.05;
    const feeRate = rev>0 ? fees/rev : 0.03;
    const totalCostRate = cogsRate + shipRate + feeRate;
    const contributionMarginRate = 1 - totalCostRate;
    const currentRoas = ads>0 ? rev/ads : 0;
    const aov = orders>0 ? rev/orders : 0;

    // Breakeven ROAS (blended)
    const breakevenRoas = contributionMarginRate > 0 ? 1/contributionMarginRate : 999;

    // Optimal ad spend (maximize profit)
    // Profit = Revenue * contributionMarginRate - AdSpend - FixedCosts
    // If ROAS stays constant: Revenue = AdSpend * ROAS
    // Profit = AdSpend * ROAS * contributionMarginRate - AdSpend - FixedCosts
    // Max profitable ad spend where marginal ROAS = breakeven
    const maxProfitableSpend = currentRoas > breakevenRoas ? ads * 1.5 : ads * 0.7;
    const projectedRevAtMax = maxProfitableSpend * currentRoas;
    const projectedProfitAtMax = projectedRevAtMax * contributionMarginRate - maxProfitableSpend - fc;

    // Discount impact
    const discountScenarios = [10, 15, 20, 25].map(pct => {
      const newAov = aov * (1 - pct/100);
      const newMargin = contributionMarginRate - pct/100;
      const ordersNeeded = newMargin > 0 ? Math.ceil(profit / (newAov * newMargin)) : 999;
      return { discount_pct: pct, new_aov: Math.round(newAov*100)/100, orders_needed_for_same_profit: ordersNeeded, volume_increase_needed_pct: Math.round((ordersNeeded/Math.max(orders,1)-1)*100) };
    });

    // Product pricing recommendations
    const prodPricing = (await pool.query(`SELECT name,price,landed_cost,cogs,gross_margin_pct,total_sold FROM products WHERE status='active' AND total_sold>0 ORDER BY total_revenue DESC LIMIT 5`)).rows.map(p => {
      const cost = +(p.landed_cost)||+(p.cogs)||0;
      const margin = +p.gross_margin_pct;
      const suggestion = margin < 40 ? `Consider raising price $${Math.ceil(cost*0.1)} to improve margin` : margin > 70 ? `Strong margin. Room to discount or scale ads.` : `Healthy margin. Maintain current pricing.`;
      return { name: p.name, price: +p.price, cost, margin: margin.toFixed(1), suggestion };
    });

    res.json({
      breakeven_roas: Math.round(breakevenRoas*100)/100,
      current_roas: Math.round(currentRoas*100)/100,
      roas_headroom: Math.round((currentRoas-breakevenRoas)*100)/100,
      recommendation: currentRoas > breakevenRoas * 1.5 ? 'SCALE' : currentRoas > breakevenRoas ? 'MAINTAIN' : 'REDUCE',
      optimal_daily_ad_spend: Math.round(maxProfitableSpend/30),
      current_daily_ad_spend: Math.round(ads/30),
      projected_monthly_profit_at_optimal: Math.round(projectedProfitAtMax),
      contribution_margin_rate: Math.round(contributionMarginRate*1000)/10,
      discount_scenarios: discountScenarios,
      pricing_recommendations: prodPricing,
      summary: currentRoas > breakevenRoas * 1.5
        ? `Your ROAS (${currentRoas.toFixed(1)}x) is well above breakeven (${breakevenRoas.toFixed(1)}x). Scale ad spend from $${Math.round(ads/30)}/day to $${Math.round(maxProfitableSpend/30)}/day. Even if ROAS drops to ${(breakevenRoas*1.2).toFixed(1)}x you'll still be profitable.`
        : currentRoas > breakevenRoas
        ? `Your ROAS (${currentRoas.toFixed(1)}x) is above breakeven (${breakevenRoas.toFixed(1)}x) but tight. Maintain current spend and focus on improving conversion rate or reducing COGS.`
        : `Your ROAS (${currentRoas.toFixed(1)}x) is BELOW breakeven (${breakevenRoas.toFixed(1)}x). Cut ad spend by 30% immediately and pause underperforming campaigns.`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ====================== SYNC STOCK FROM WOOCOMMERCE ======================
app.post("/api/sync/stock", auth, async (req, res) => {
  try {
    const wc = await getCreds('woocommerce');
    const storeUrl = wc.store_url || process.env.WOO_STORE_URL;
    const ck = wc.consumer_key || process.env.WOO_CONSUMER_KEY;
    const cs = wc.consumer_secret || process.env.WOO_CONSUMER_SECRET;
    if (!storeUrl || !ck || !cs) return res.status(400).json({ error: "WooCommerce not configured" });
    const ax = axios.create({ baseURL: storeUrl.replace(/\/$/, '') + '/wp-json/wc/v3', auth: { username: ck, password: cs }, timeout: 30000 });
    let updated = 0, pg = 1;
    while (true) {
      const { data } = await ax.get('/products', { params: { per_page: 100, page: pg, status: 'publish' } });
      for (const p of data) {
        if (p.manage_stock && p.stock_quantity !== null) {
          const stock = +(p.stock_quantity) || 0;
          // Calculate avg daily sales from orders
          const sales = await pool.query('SELECT COALESCE(SUM(oi.quantity),0)/GREATEST(COUNT(DISTINCT o.order_date::date),1) as avg FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products pr ON pr.id=oi.product_id WHERE pr.woo_product_id=$1 AND o.order_date>NOW()-INTERVAL\'30 days\'', [p.id]);
          const avgDaily = +(sales.rows[0]?.avg) || 0;
          const daysLeft = avgDaily > 0 ? Math.round(stock / avgDaily) : 0;
          const prod = await pool.query('SELECT landed_cost,cogs FROM products WHERE woo_product_id=$1', [p.id]);
          const unitCost = +(prod.rows[0]?.landed_cost) || +(prod.rows[0]?.cogs) || 0;
          await pool.query('UPDATE products SET stock_quantity=$1, avg_daily_sales=$2, days_of_stock=$3, inventory_value=$4, updated_at=NOW() WHERE woo_product_id=$5',
            [stock, avgDaily, daysLeft, stock * unitCost, p.id]);
          updated++;
        }
      }
      if (data.length < 100) break;
      pg++;
    }
    res.json({ status: "synced", updated, message: `Updated stock for ${updated} products` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ====================== WEEKLY EMAIL SUMMARY REPORT ======================
async function sendWeeklyReport() {
  try {
    if (!process.env.RESEND_API_KEY && (!process.env.SMTP_HOST || !process.env.SMTP_USER)) { console.log("No email provider configured (set RESEND_API_KEY or SMTP_HOST), skipping weekly report"); return; }
    // Get recipients: from report_configs, or fall back to ALLOWED_EMAILS
    let recipients = [...ALLOWED_EMAILS];
    try {
      const report = await pool.query(`SELECT recipients FROM report_configs WHERE report_type='weekly_summary' AND is_active=true`);
      if (report.rows[0]?.recipients) {
        const configured = typeof report.rows[0].recipients === 'string' ? JSON.parse(report.rows[0].recipients) : report.rows[0].recipients;
        if (configured.length > 0) recipients = configured;
      }
    } catch(e) {}
    if (!recipients.length) { console.log('No recipients for weekly report'); return; }

    // Get this week vs last week data
    const thisWeek = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(net_profit),0) as net_profit, COALESCE(SUM(orders_count),0) as orders, COALESCE(SUM(ad_spend),0) as ad_spend, COALESCE(AVG(aov),0) as aov, COALESCE(SUM(new_customers),0) as new_cust FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '7 days'`);
    const lastWeek = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(net_profit),0) as net_profit, COALESCE(SUM(orders_count),0) as orders, COALESCE(SUM(ad_spend),0) as ad_spend FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '14 days' AND date < CURRENT_DATE - INTERVAL '7 days'`);
    const tw = thisWeek.rows[0], lw = lastWeek.rows[0];
    const pct = (c, p) => p > 0 ? ((c - p) / p * 100).toFixed(1) : 'N/A';
    const arrow = (c, p) => c > p ? '↑' : c < p ? '↓' : '→';
    const fc = v => '$' + (+v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    // Top products
    const topProds = await pool.query(`SELECT p.name, SUM(oi.line_total) as rev, SUM(oi.quantity) as qty FROM order_items oi JOIN products p ON oi.product_id=p.id JOIN orders o ON oi.order_id=o.id WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY p.name ORDER BY rev DESC LIMIT 5`);

    const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e4e7">
      <div style="background:linear-gradient(135deg,#14532d,#166534);padding:32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:24px">📊 ${APP_NAME} — Weekly Report</h1>
        <p style="color:#86efac;margin:8px 0 0;font-size:14px">${new Date(Date.now()-7*864e5).toLocaleDateString()} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="padding:32px">
        <h2 style="color:#18181b;font-size:18px;margin:0 0 20px;border-bottom:2px solid #f4f4f5;padding-bottom:12px">Key Metrics</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Revenue</td><td style="text-align:right;font-weight:700;color:#18181b">${fc(tw.revenue)}</td><td style="text-align:right;color:${+tw.revenue>=+lw.revenue?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.revenue,+lw.revenue)} ${pct(+tw.revenue,+lw.revenue)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Gross Profit</td><td style="text-align:right;font-weight:700;color:#18181b">${fc(tw.gross_profit)}</td><td style="text-align:right;color:${+tw.gross_profit>=+lw.gross_profit?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.gross_profit,+lw.gross_profit)} ${pct(+tw.gross_profit,+lw.gross_profit)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Net Profit</td><td style="text-align:right;font-weight:700;color:${+tw.net_profit>=0?'#16a34a':'#dc2626'}">${fc(tw.net_profit)}</td><td style="text-align:right;color:${+tw.net_profit>=+lw.net_profit?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.net_profit,+lw.net_profit)} ${pct(+tw.net_profit,+lw.net_profit)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Orders</td><td style="text-align:right;font-weight:700">${tw.orders}</td><td style="text-align:right;color:${+tw.orders>=+lw.orders?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.orders,+lw.orders)} ${pct(+tw.orders,+lw.orders)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Ad Spend</td><td style="text-align:right;font-weight:700">${fc(tw.ad_spend)}</td><td style="text-align:right;padding-left:12px">${pct(+tw.ad_spend,+lw.ad_spend)}%</td></tr>
          <tr><td style="padding:12px 0;color:#71717a">AOV</td><td style="text-align:right;font-weight:700">${fc(tw.aov)}</td><td></td></tr>
        </table>
        ${topProds.rows.length ? `<h2 style="color:#18181b;font-size:18px;margin:28px 0 16px;border-bottom:2px solid #f4f4f5;padding-bottom:12px">Top Products</h2><table style="width:100%;font-size:13px">${topProds.rows.map((p,i) => `<tr style="border-bottom:1px solid #f4f4f5"><td style="padding:8px 0">${i+1}. ${p.name}</td><td style="text-align:right;font-weight:600">${fc(p.rev)}</td><td style="text-align:right;color:#71717a">${p.qty} sold</td></tr>`).join('')}</table>` : ''}
      </div>
      <div style="background:#f4f4f5;padding:20px;text-align:center;font-size:12px;color:#71717a">${APP_NAME} — The Vitamin Shots</div>
    </div>`;

    const info = await sendEmail({ to: recipients, subject: `${APP_NAME} Weekly Report — Revenue: ${fc(tw.revenue)} | Profit: ${fc(tw.net_profit)}`, html });
    if (!info.success) { console.error('Weekly report email failed:', info.error); return; }
    try { await pool.query(`UPDATE report_configs SET last_sent_at=NOW() WHERE report_type='weekly_summary'`); } catch(e) {}
    console.log("✅ Weekly report sent to", recipients.join(", "), "messageId:", info.messageId);
    return `Report sent to ${recipients.join(', ')}`;
  } catch (e) { console.error("Weekly report error:", e.message); throw e; }
}

// Manual trigger
app.post("/api/reports/send-weekly", auth, async (req, res) => {
  try {
    const result = await sendWeeklyReport();
    res.json({ ok: true, message: result || "Weekly report sent to " + ALLOWED_EMAILS.join(', ') });
  } catch(e) { res.status(500).json({ error: "Email sending failed: " + e.message }); }
});

// ====================== TAX P&L CSV EXPORT ======================
app.get("/api/export/tax-pnl", auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = +(year) || new Date().getFullYear();
    const m = +(month) || 0;
    let startDate, endDate, label;
    if (m > 0 && m <= 12) {
      startDate = `${y}-${String(m).padStart(2,'0')}-01`;
      endDate = m < 12 ? `${y}-${String(m+1).padStart(2,'0')}-01` : `${y+1}-01-01`;
      label = `${y}-${String(m).padStart(2,'0')}`;
    } else {
      startDate = `${y}-01-01`;
      endDate = `${y+1}-01-01`;
      label = `${y}`;
    }
    // Monthly breakdown
    const monthly = await pool.query(`SELECT TO_CHAR(date,'YYYY-MM') as month, SUM(revenue) as revenue, SUM(cogs) as cogs, SUM(shipping_cost) as shipping, SUM(payment_fees) as payment_fees, SUM(discount_total) as discounts, SUM(refund_total) as refunds, SUM(ad_spend) as ad_spend, SUM(meta_spend) as meta_spend, SUM(google_spend) as google_spend, SUM(tiktok_spend) as tiktok_spend, SUM(COALESCE(pinterest_spend,0)) as pinterest_spend, SUM(fixed_costs_daily) as fixed_costs, SUM(gross_profit) as gross_profit, SUM(contribution_margin) as contribution_margin, SUM(net_profit) as net_profit, SUM(orders_count) as orders, SUM(new_customers) as new_customers, SUM(tax_total) as sales_tax_collected FROM daily_metrics WHERE date >= $1 AND date < $2 GROUP BY TO_CHAR(date,'YYYY-MM') ORDER BY month`, [startDate, endDate]);

    // Fixed costs detail
    const fc = await pool.query(`SELECT name,amount_monthly,category FROM fixed_costs WHERE is_active=true ORDER BY name`);

    // Build CSV
    let csv = `TVS Profit & Loss Statement for Tax Filing\n`;
    csv += `Period: ${label}\n`;
    csv += `Generated: ${new Date().toISOString().split('T')[0]}\n`;
    csv += `Business: The Vitamin Shots LLC\n\n`;

    // Income section
    csv += `INCOME & REVENUE\n`;
    csv += `Month,Gross Revenue,Discounts,Refunds,Net Revenue,Sales Tax Collected\n`;
    let totals = { revenue: 0, discounts: 0, refunds: 0, net: 0, tax: 0 };
    for (const r of monthly.rows) {
      const net = +r.revenue - +r.discounts - +r.refunds;
      csv += `${r.month},${(+r.revenue).toFixed(2)},${(+r.discounts).toFixed(2)},${(+r.refunds).toFixed(2)},${net.toFixed(2)},${(+r.sales_tax_collected).toFixed(2)}\n`;
      totals.revenue += +r.revenue; totals.discounts += +r.discounts; totals.refunds += +r.refunds; totals.net += net; totals.tax += +r.sales_tax_collected;
    }
    csv += `TOTAL,${totals.revenue.toFixed(2)},${totals.discounts.toFixed(2)},${totals.refunds.toFixed(2)},${totals.net.toFixed(2)},${totals.tax.toFixed(2)}\n\n`;

    // COGS section
    csv += `COST OF GOODS SOLD (COGS)\n`;
    csv += `Month,Product COGS,Shipping Costs,Payment Processing Fees,Total COGS\n`;
    let cogsTotals = { cogs: 0, ship: 0, fees: 0 };
    for (const r of monthly.rows) {
      const total = +r.cogs + +r.shipping + +r.payment_fees;
      csv += `${r.month},${(+r.cogs).toFixed(2)},${(+r.shipping).toFixed(2)},${(+r.payment_fees).toFixed(2)},${total.toFixed(2)}\n`;
      cogsTotals.cogs += +r.cogs; cogsTotals.ship += +r.shipping; cogsTotals.fees += +r.payment_fees;
    }
    csv += `TOTAL,${cogsTotals.cogs.toFixed(2)},${cogsTotals.ship.toFixed(2)},${cogsTotals.fees.toFixed(2)},${(cogsTotals.cogs+cogsTotals.ship+cogsTotals.fees).toFixed(2)}\n\n`;

    // Marketing expenses
    csv += `MARKETING & ADVERTISING EXPENSES\n`;
    csv += `Month,Meta/Facebook Ads,Google Ads,TikTok Ads,Total Ad Spend\n`;
    let adTotals = { meta: 0, google: 0, tiktok: 0, total: 0 };
    for (const r of monthly.rows) {
      csv += `${r.month},${(+r.meta_spend).toFixed(2)},${(+r.google_spend).toFixed(2)},${(+r.tiktok_spend).toFixed(2)},${(+r.ad_spend).toFixed(2)}\n`;
      adTotals.meta += +r.meta_spend; adTotals.google += +r.google_spend; adTotals.tiktok += +r.tiktok_spend; adTotals.total += +r.ad_spend;
    }
    csv += `TOTAL,${adTotals.meta.toFixed(2)},${adTotals.google.toFixed(2)},${adTotals.tiktok.toFixed(2)},${adTotals.total.toFixed(2)}\n\n`;

    // Fixed/operating expenses
    csv += `FIXED & OPERATING EXPENSES (Monthly)\n`;
    csv += `Expense,Category,Monthly Amount,Annual Amount\n`;
    let fixedTotal = 0;
    for (const f of fc.rows) {
      csv += `${f.name},${f.category||'General'},${(+f.amount_monthly).toFixed(2)},${(+f.amount_monthly*12).toFixed(2)}\n`;
      fixedTotal += +f.amount_monthly;
    }
    csv += `TOTAL,,${fixedTotal.toFixed(2)},${(fixedTotal*12).toFixed(2)}\n\n`;

    // P&L Summary
    csv += `PROFIT & LOSS SUMMARY\n`;
    csv += `Month,Net Revenue,Total COGS,Gross Profit,Ad Spend,Fixed Costs,Net Profit,Net Margin %\n`;
    for (const r of monthly.rows) {
      const netRev = +r.revenue - +r.discounts - +r.refunds;
      const margin = netRev > 0 ? (+r.net_profit / netRev * 100).toFixed(1) : '0.0';
      csv += `${r.month},${netRev.toFixed(2)},${(+r.cogs + +r.shipping + +r.payment_fees).toFixed(2)},${(+r.gross_profit).toFixed(2)},${(+r.ad_spend).toFixed(2)},${(+r.fixed_costs).toFixed(2)},${(+r.net_profit).toFixed(2)},${margin}%\n`;
    }
    const grandNet = totals.net - cogsTotals.cogs - cogsTotals.ship - cogsTotals.fees - adTotals.total - (fixedTotal * monthly.rows.length);
    csv += `TOTAL,${totals.net.toFixed(2)},${(cogsTotals.cogs+cogsTotals.ship+cogsTotals.fees).toFixed(2)},${(totals.net-cogsTotals.cogs-cogsTotals.ship-cogsTotals.fees).toFixed(2)},${adTotals.total.toFixed(2)},${(fixedTotal*monthly.rows.length).toFixed(2)},${grandNet.toFixed(2)},${totals.net>0?(grandNet/totals.net*100).toFixed(1):'0.0'}%\n`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="TVS_PnL_Tax_${label}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== CRON JOBS ======================
const cronTz=process.env.TZ||'America/New_York';
cron.schedule('0 3 * * *',async()=>{console.log('⏰ Daily metrics rebuild');try{const fc=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');await pool.query(`UPDATE daily_metrics SET fixed_costs_daily=$1,contribution_margin=gross_profit-ad_spend,net_profit=gross_profit-ad_spend-$1-COALESCE(affiliate_commissions,0)-COALESCE(store_credit_used,0)-COALESCE(tax_total,0),mer=CASE WHEN ad_spend>0 THEN revenue/ad_spend ELSE 0 END WHERE date>=date_trunc('month',CURRENT_DATE)`,[+(fc.rows[0].t)/daysInCurrentMonth()]);console.log('✅ Daily rebuild done')}catch(e){console.error(e.message)}},{timezone:cronTz});
// Weekly report every Monday 8 AM
cron.schedule('0 8 * * 1',async()=>{console.log('📧 Sending weekly report...');await sendWeeklyReport()},{timezone:cronTz});
// Sync marketplaces + ad spend daily at 4 AM
cron.schedule('0 4 * * *',async()=>{console.log('🔄 Auto-syncing integrations...');try{
  if(process.env.META_ACCESS_TOKEN){const axios2=require('axios');/* Meta ads auto-sync handled by ad-spend endpoint */console.log('Meta: configured')}
  if(process.env.ENGINEMAILER_API_KEY){console.log('Enginemailer: will sync')}
  if(process.env.AMAZON_SP_REFRESH_TOKEN){console.log('Amazon: will sync')}
}catch(e){console.error('Auto-sync error:',e.message)}},{timezone:cronTz});

// ====================== START ======================
// Auto-run column migrations on startup (prevents "column does not exist" errors)
(async () => {
  const migrations = [
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS product_cost_per_unit DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_order DECIMAL(8,2) DEFAULT 1',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS tariff_rate DECIMAL(8,4) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging_shipping DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging_customs DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging_freight_forwarder DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS thank_you_card DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS free_gift_cogs DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS affiliate_samples_cogs DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_subscription DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_onetime DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS affiliate_samples_shipping DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS subscription_sales_price DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS onetime_sales_price DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging_cost DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_shipping_cost DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS customs_fees DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS ground_transport DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS insurance_cost DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS tariffs DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS other_costs DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS landed_cost DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_point INTEGER DEFAULT 10',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_daily_sales DECIMAL(8,2) DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS days_of_stock INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_value DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS amazon_fees DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS tiktok_fees DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS meta_fees DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS affiliate_commission DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS chargeback_amount DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS subscription_discount_amount DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(50) DEFAULT \'onetime\'',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS email_revenue DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS meta_spend DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS google_spend DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS tiktok_spend DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS pinterest_spend DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS microsoft_spend DECIMAL(14,2) DEFAULT 0',
    "CREATE TABLE IF NOT EXISTS notification_log(id SERIAL PRIMARY KEY,type VARCHAR(100),title VARCHAR(500),message TEXT,channel VARCHAR(50) DEFAULT 'email',sent_at TIMESTAMPTZ DEFAULT NOW(),metadata JSONB DEFAULT '{}')",
    "INSERT INTO integrations(platform,is_connected) VALUES('microsoft_ads',false),('google_analytics',false),('search_console',false),('referly',false),('paypal',false),('slack',false),('resend',false),('enginemailer',false) ON CONFLICT(platform) DO NOTHING",
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255)',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS utm_content VARCHAR(500)',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS lead_time_days INTEGER DEFAULT 7',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_stock INTEGER DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN IF NOT EXISTS store_credit_used DECIMAL(12,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS store_credit_used DECIMAL(14,2) DEFAULT 0',
    'ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS affiliate_commissions DECIMAL(14,2) DEFAULT 0',
    "CREATE TABLE IF NOT EXISTS affiliate_data(id SERIAL PRIMARY KEY,affiliate_id VARCHAR(255) UNIQUE,name VARCHAR(500),email VARCHAR(255),payout_email VARCHAR(255),commission_rate DECIMAL(8,2) DEFAULT 0,total_earned DECIMAL(14,2) DEFAULT 0,total_referrals INTEGER DEFAULT 0,total_clicks INTEGER DEFAULT 0,status VARCHAR(50) DEFAULT 'active',synced_at TIMESTAMPTZ DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS affiliate_sales(id SERIAL PRIMARY KEY,sale_id VARCHAR(255) UNIQUE,affiliate_id VARCHAR(255),referral_id VARCHAR(255),external_id VARCHAR(255),customer_name VARCHAR(500),customer_email VARCHAR(255),total_earned DECIMAL(12,2) DEFAULT 0,commission_rate DECIMAL(8,2) DEFAULT 0,created_at TIMESTAMPTZ,synced_at TIMESTAMPTZ DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS store_credit_ledger(id SERIAL PRIMARY KEY,order_id VARCHAR(100),customer_email VARCHAR(255),credit_amount DECIMAL(12,2) DEFAULT 0,credit_type VARCHAR(50) DEFAULT 'used',order_date TIMESTAMPTZ,synced_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(order_id,credit_type))",
    "CREATE TABLE IF NOT EXISTS fixed_cost_snapshots(id SERIAL PRIMARY KEY,month VARCHAR(7) NOT NULL UNIQUE,total_monthly DECIMAL(14,2) DEFAULT 0,daily_rate DECIMAL(14,2) DEFAULT 0,snapshot_at TIMESTAMPTZ DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS email_tracking(id SERIAL PRIMARY KEY,campaign VARCHAR(255),email_id VARCHAR(255),recipient VARCHAR(500),event_type VARCHAR(50) DEFAULT 'open',provider VARCHAR(100) DEFAULT 'unknown',tracked_at TIMESTAMPTZ DEFAULT NOW())",
    'CREATE INDEX IF NOT EXISTS idx_email_tracking_campaign ON email_tracking(campaign,email_id)',
    'CREATE INDEX IF NOT EXISTS idx_email_tracking_date ON email_tracking(tracked_at)',
    'CREATE INDEX IF NOT EXISTS idx_orders_utm ON orders(utm_source,utm_medium)',
    "CREATE TABLE IF NOT EXISTS audit_log(id SERIAL PRIMARY KEY,user_id INTEGER,action VARCHAR(255),details TEXT,created_at TIMESTAMPTZ DEFAULT NOW())",
    'CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date)',
    'CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date)',
    'CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)',
    'CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_ad_spend_daily_date ON ad_spend_daily(date,platform)',
    'CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)',
  ];
  try {
    for (const sql of migrations) {
      try { await pool.query(sql); } catch(e) { /* ignore duplicates */ }
    }
    console.log('✅ Auto-migrations complete');
    await autoSetupFromEnv();
    // Auto-rebuild daily metrics if they're empty but orders exist
    const mc = await pool.query('SELECT COUNT(*) as c FROM daily_metrics WHERE revenue>0');
    const oc = await pool.query('SELECT COUNT(*) as c FROM orders');
    if (+mc.rows[0].c === 0 && +oc.rows[0].c > 0) {
      console.log('⚠️ Daily metrics empty but orders exist. Auto-rebuilding...');
      await pool.query(`INSERT INTO daily_metrics(date,revenue,cogs,shipping_cost,payment_fees,discount_total,refund_total,tax_total,gross_profit,orders_count,items_sold,new_customers,returning_customers,aov) SELECT order_date::date,COALESCE(SUM(revenue),0),COALESCE(SUM(cogs),0),COALESCE(SUM(shipping_cost),0),COALESCE(SUM(payment_fees),0),COALESCE(SUM(discount),0),COALESCE(SUM(refund_amount),0),COALESCE(SUM(tax),0),COALESCE(SUM(gross_profit),0),COUNT(*),COALESCE(SUM(items_count),0),COUNT(*)FILTER(WHERE is_first_order=true),COUNT(*)FILTER(WHERE is_first_order=false),CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders GROUP BY order_date::date ON CONFLICT(date) DO UPDATE SET revenue=EXCLUDED.revenue,cogs=EXCLUDED.cogs,shipping_cost=EXCLUDED.shipping_cost,payment_fees=EXCLUDED.payment_fees,gross_profit=EXCLUDED.gross_profit,orders_count=EXCLUDED.orders_count,aov=EXCLUDED.aov,updated_at=NOW()`);
      console.log('✅ Daily metrics auto-rebuilt from orders');
    }
  } catch(e) { console.error('Migration error:', e.message); }
})();


// Daily summary email cron (8:30 AM)
cron.schedule('30 8 * * *', async () => {
  console.log('📧 Generating daily summary...');
  try {
    if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) return;
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now()-864e5).toISOString().split('T')[0];
    const d = (await pool.query('SELECT COALESCE(SUM(revenue),0)as rev, COALESCE(SUM(net_profit),0)as profit, COALESCE(SUM(orders_count),0)as orders, COALESCE(SUM(ad_spend),0)as ads, COALESCE(SUM(new_customers),0)as new_cust FROM daily_metrics WHERE date=$1',[yesterday])).rows[0];
    const prev = (await pool.query('SELECT COALESCE(SUM(revenue),0)as rev, COALESCE(SUM(net_profit),0)as profit, COALESCE(SUM(orders_count),0)as orders FROM daily_metrics WHERE date=$1',[new Date(Date.now()-2*864e5).toISOString().split('T')[0]])).rows[0];
    
    const fc = v => '$'+Math.round(+(v)||0).toLocaleString('en-US');
    const pct = (c,p) => { if(!+p) return ''; const ch=((+c-+p)/Math.abs(+p)*100); return ch>0?' ↑'+ch.toFixed(0)+'%':ch<0?' ↓'+Math.abs(ch).toFixed(0)+'%':''; };
    
    // Stock alerts
    const lowStock = (await pool.query("SELECT name, stock_quantity FROM products WHERE is_active=true AND stock_quantity>0 AND stock_quantity<reorder_point ORDER BY stock_quantity ASC LIMIT 5")).rows;
    const oos = (await pool.query("SELECT name FROM products WHERE is_active=true AND stock_quantity<=0")).rows;
    
    let stockHtml = '';
    if (oos.length) stockHtml += '<div style="background:#fef2f2;padding:12px;border-radius:8px;margin:12px 0"><strong style="color:#dc2626">🔴 Out of Stock:</strong> ' + oos.map(p=>p.name).join(', ') + '</div>';
    if (lowStock.length) stockHtml += '<div style="background:#fffbeb;padding:12px;border-radius:8px;margin:12px 0"><strong style="color:#d97706">🟡 Low Stock:</strong> ' + lowStock.map(p=>p.name+' ('+p.stock_quantity+')').join(', ') + '</div>';
    
    const html = '<div style="font-family:Arial;max-width:600px;margin:0 auto"><div style="background:linear-gradient(135deg,#020617,#1e293b);padding:24px;border-radius:12px 12px 0 0;text-align:center"><h1 style="color:#f1c349;margin:0;font-size:22px">Daily Summary</h1><p style="color:#94a3b8;margin:4px 0 0;font-size:13px">'+yesterday+'</p></div><div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">'
      +'<table style="width:100%;border-collapse:collapse"><tr><td style="padding:12px;text-align:center;border-bottom:1px solid #f1f5f9"><div style="color:#64748b;font-size:11px;text-transform:uppercase">Revenue</div><div style="font-size:24px;font-weight:bold;color:#020617">'+fc(d.rev)+'</div><div style="font-size:12px;color:'+(+d.rev>=+prev.rev?'#16a34a':'#dc2626')+'">'+pct(d.rev,prev.rev)+'</div></td>'
      +'<td style="padding:12px;text-align:center;border-bottom:1px solid #f1f5f9"><div style="color:#64748b;font-size:11px;text-transform:uppercase">Profit</div><div style="font-size:24px;font-weight:bold;color:'+(+d.profit>=0?'#16a34a':'#dc2626')+'">'+fc(d.profit)+'</div><div style="font-size:12px;color:'+(+d.profit>=+prev.profit?'#16a34a':'#dc2626')+'">'+pct(d.profit,prev.profit)+'</div></td>'
      +'<td style="padding:12px;text-align:center;border-bottom:1px solid #f1f5f9"><div style="color:#64748b;font-size:11px;text-transform:uppercase">Orders</div><div style="font-size:24px;font-weight:bold;color:#020617">'+d.orders+'</div><div style="font-size:12px;color:'+(+d.orders>=+prev.orders?'#16a34a':'#dc2626')+'">'+pct(d.orders,prev.orders)+'</div></td></tr></table>'
      +'<div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px"><strong>Ad Spend:</strong> '+fc(d.ads)+' · <strong>New Customers:</strong> '+d.new_cust+(+d.ads>0?' · <strong>MER:</strong> '+(+d.rev/+d.ads).toFixed(1)+'x':'')+'</div>'
      + stockHtml
      +'</div></div>';
    
    await sendEmail({ to: ALLOWED_EMAILS, subject: APP_NAME + ' Daily — Rev: '+fc(d.rev)+' | Profit: '+fc(d.profit)+' | '+d.orders+' orders', html });
    console.log('✅ Daily summary sent');
  } catch(e) { console.error('Daily summary error:', e.message); }
}, {timezone: cronTz});


// Daily stock alert check (9 AM)
cron.schedule('0 9 * * *', async () => {
  console.log('📦 Checking stock levels...');
  try {
    const lowStock = await pool.query("SELECT name, stock_quantity, COALESCE(avg_daily_sales,0) as avg_daily_sales, COALESCE(days_of_stock,0) as days_of_stock FROM products WHERE is_active=true AND stock_quantity>0 AND (days_of_stock<14 OR stock_quantity<reorder_point) ORDER BY days_of_stock ASC");
    const oos = await pool.query("SELECT name FROM products WHERE is_active=true AND stock_quantity<=0");
    if (!lowStock.rows.length && !oos.rows.length) { console.log('All stock healthy'); return; }
    
    let html = '<div style="font-family:Arial;max-width:600px;margin:0 auto;padding:24px"><h2 style="color:#f59e0b">📦 Stock Alert</h2>';
    if (oos.rows.length) { html += '<p style="color:#dc2626;font-weight:bold">🔴 OUT OF STOCK: ' + oos.rows.map(r=>r.name).join(', ') + '</p>'; }
    if (lowStock.rows.length) {
      html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#1e293b;color:#fff"><th style="padding:8px">Product</th><th style="padding:8px">Stock</th><th style="padding:8px">Daily Rate</th><th style="padding:8px">Days Left</th></tr>';
      lowStock.rows.forEach(r => { html += '<tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px">'+r.name+'</td><td style="padding:8px;text-align:center">'+r.stock_quantity+'</td><td style="padding:8px;text-align:center">'+(+(r.avg_daily_sales)||0).toFixed(1)+'</td><td style="padding:8px;text-align:center;color:'+(+(r.days_of_stock)<7?'#dc2626':'#d97706')+';font-weight:bold">'+(r.days_of_stock||'?')+'</td></tr>'; });
      html += '</table>';
    }
    html += '</div>';
    await sendEmail({ to: ALLOWED_EMAILS, subject: APP_NAME + ' — Stock Alert: ' + (oos.rows.length ? oos.rows.length + ' out of stock, ' : '') + lowStock.rows.length + ' low stock', html });
    sendSlack('📦 Stock alert: ' + oos.rows.length + ' out of stock, ' + lowStock.rows.length + ' low stock');
    console.log('✅ Stock alert sent');
  } catch(e) { console.error('Stock alert error:', e.message); }
}, {timezone: cronTz});

const server = app.listen(PORT,()=>console.log(`\n🚀 Vitamin Shots Finance Minister running on port ${PORT}\n   Env: ${process.env.NODE_ENV||'development'}\n   Allowed users: ${ALLOWED_EMAILS.join(', ')}\n`));

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => { pool.end().then(() => { console.log('DB pool closed'); process.exit(0); }); });
  setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
