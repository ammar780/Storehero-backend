const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const SQL = [
  // ── Users ──
  `CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255), role VARCHAR(50) DEFAULT 'admin', timezone VARCHAR(100) DEFAULT 'America/New_York',
    currency VARCHAR(10) DEFAULT 'USD', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Products ──
  `CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY, woo_product_id INTEGER UNIQUE, name VARCHAR(500) NOT NULL, sku VARCHAR(255),
    price DECIMAL(12,2) DEFAULT 0, cogs DECIMAL(12,2) DEFAULT 0, category VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', image_url TEXT, breakeven_roas DECIMAL(8,4),
    gross_margin_pct DECIMAL(8,4), total_sold INTEGER DEFAULT 0, total_revenue DECIMAL(14,2) DEFAULT 0,
    total_profit DECIMAL(14,2) DEFAULT 0, weight DECIMAL(8,2), variant_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Customers ──
  `CREATE TABLE IF NOT EXISTS customers(
    id SERIAL PRIMARY KEY, woo_customer_id INTEGER, email VARCHAR(255), first_name VARCHAR(255),
    last_name VARCHAR(255), first_order_date TIMESTAMPTZ, last_order_date TIMESTAMPTZ,
    total_orders INTEGER DEFAULT 0, total_revenue DECIMAL(14,2) DEFAULT 0, total_profit DECIMAL(14,2) DEFAULT 0,
    ltv DECIMAL(14,2) DEFAULT 0, aov DECIMAL(12,2) DEFAULT 0, cohort_month VARCHAR(7),
    acquisition_channel VARCHAR(255), country VARCHAR(100), state VARCHAR(100), city VARCHAR(255),
    is_returning BOOLEAN DEFAULT FALSE, tags TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Orders ──
  `CREATE TABLE IF NOT EXISTS orders(
    id SERIAL PRIMARY KEY, woo_order_id VARCHAR(100) UNIQUE, customer_id INTEGER REFERENCES customers(id),
    order_date TIMESTAMPTZ NOT NULL, status VARCHAR(50), revenue DECIMAL(12,2) DEFAULT 0,
    cogs DECIMAL(12,2) DEFAULT 0, shipping_cost DECIMAL(12,2) DEFAULT 0, payment_fees DECIMAL(12,2) DEFAULT 0,
    discount DECIMAL(12,2) DEFAULT 0, tax DECIMAL(12,2) DEFAULT 0, refund_amount DECIMAL(12,2) DEFAULT 0,
    gross_profit DECIMAL(12,2) DEFAULT 0, contribution_margin DECIMAL(12,2) DEFAULT 0,
    net_profit DECIMAL(12,2) DEFAULT 0, margin_pct DECIMAL(8,4) DEFAULT 0, country VARCHAR(100),
    state VARCHAR(100), city VARCHAR(255),
    utm_source VARCHAR(255), utm_medium VARCHAR(255), utm_campaign VARCHAR(255), coupon_code VARCHAR(255),
    is_first_order BOOLEAN DEFAULT FALSE, payment_method VARCHAR(100), items_count INTEGER DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'USD', shipping_method VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Order Items ──
  `CREATE TABLE IF NOT EXISTS order_items(
    id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id), woo_product_id INTEGER, product_name VARCHAR(500),
    sku VARCHAR(255), quantity INTEGER DEFAULT 1, unit_price DECIMAL(12,2) DEFAULT 0,
    unit_cogs DECIMAL(12,2) DEFAULT 0, line_total DECIMAL(12,2) DEFAULT 0,
    line_cogs DECIMAL(12,2) DEFAULT 0, line_profit DECIMAL(12,2) DEFAULT 0)`,

  // ── Daily Metrics ──
  `CREATE TABLE IF NOT EXISTS daily_metrics(
    id SERIAL PRIMARY KEY, date DATE UNIQUE NOT NULL, revenue DECIMAL(14,2) DEFAULT 0,
    cogs DECIMAL(14,2) DEFAULT 0, ad_spend DECIMAL(14,2) DEFAULT 0, meta_spend DECIMAL(14,2) DEFAULT 0,
    google_spend DECIMAL(14,2) DEFAULT 0, tiktok_spend DECIMAL(14,2) DEFAULT 0,
    shipping_cost DECIMAL(14,2) DEFAULT 0, payment_fees DECIMAL(14,2) DEFAULT 0,
    discount_total DECIMAL(14,2) DEFAULT 0, refund_total DECIMAL(14,2) DEFAULT 0,
    tax_total DECIMAL(14,2) DEFAULT 0, fixed_costs_daily DECIMAL(14,2) DEFAULT 0,
    gross_profit DECIMAL(14,2) DEFAULT 0, contribution_margin DECIMAL(14,2) DEFAULT 0,
    net_profit DECIMAL(14,2) DEFAULT 0, orders_count INTEGER DEFAULT 0, items_sold INTEGER DEFAULT 0,
    new_customers INTEGER DEFAULT 0, returning_customers INTEGER DEFAULT 0, aov DECIMAL(12,2) DEFAULT 0,
    mer DECIMAL(8,4) DEFAULT 0, sessions INTEGER DEFAULT 0, conversion_rate DECIMAL(8,4) DEFAULT 0,
    email_revenue DECIMAL(14,2) DEFAULT 0, organic_revenue DECIMAL(14,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Ad Spend Daily ──
  `CREATE TABLE IF NOT EXISTS ad_spend_daily(
    id SERIAL PRIMARY KEY, date DATE NOT NULL, platform VARCHAR(50) NOT NULL,
    campaign_id VARCHAR(255) DEFAULT '', campaign_name VARCHAR(500), adset_name VARCHAR(500),
    spend DECIMAL(12,2) DEFAULT 0, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0, conversion_value DECIMAL(12,2) DEFAULT 0,
    ctr DECIMAL(8,4) DEFAULT 0, cpc DECIMAL(8,4) DEFAULT 0, cpm DECIMAL(8,4) DEFAULT 0,
    roas DECIMAL(8,4) DEFAULT 0, cpa DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(date, platform, campaign_id))`,

  // ── Ad Creatives ──
  `CREATE TABLE IF NOT EXISTS ad_creatives(
    id SERIAL PRIMARY KEY, platform VARCHAR(50), creative_id VARCHAR(255), ad_id VARCHAR(255),
    campaign_name VARCHAR(500), adset_name VARCHAR(500), headline VARCHAR(500), body TEXT,
    image_url TEXT, video_url TEXT, thumbnail_url TEXT, creative_type VARCHAR(50),
    total_spend DECIMAL(14,2) DEFAULT 0, total_impressions INTEGER DEFAULT 0,
    total_clicks INTEGER DEFAULT 0, total_conversions INTEGER DEFAULT 0,
    total_revenue DECIMAL(14,2) DEFAULT 0, ctr DECIMAL(8,4) DEFAULT 0, roas DECIMAL(8,4) DEFAULT 0,
    cpa DECIMAL(12,2) DEFAULT 0, status VARCHAR(50) DEFAULT 'active',
    start_date DATE, end_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Cohorts ──
  `CREATE TABLE IF NOT EXISTS cohorts(
    id SERIAL PRIMARY KEY, cohort_month VARCHAR(7) UNIQUE NOT NULL, customers_count INTEGER DEFAULT 0,
    repeat_rate DECIMAL(8,4) DEFAULT 0, avg_ltv DECIMAL(14,2) DEFAULT 0, avg_orders DECIMAL(8,2) DEFAULT 0,
    avg_aov DECIMAL(12,2) DEFAULT 0, cac DECIMAL(12,2) DEFAULT 0, payback_days INTEGER DEFAULT 0,
    month1_retention DECIMAL(8,4) DEFAULT 0, month3_retention DECIMAL(8,4) DEFAULT 0,
    month6_retention DECIMAL(8,4) DEFAULT 0, month12_retention DECIMAL(8,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Goals ──
  `CREATE TABLE IF NOT EXISTS goals(
    id SERIAL PRIMARY KEY, year INTEGER NOT NULL, metric_type VARCHAR(100) NOT NULL,
    annual_target DECIMAL(14,2) NOT NULL, monthly_targets JSONB DEFAULT '{}',
    seasonal_weights JSONB DEFAULT '{}', notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(year, metric_type))`,

  // ── Fixed Costs ──
  `CREATE TABLE IF NOT EXISTS fixed_costs(
    id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, amount_monthly DECIMAL(12,2) NOT NULL,
    category VARCHAR(100), is_active BOOLEAN DEFAULT TRUE, notes TEXT,
    start_date DATE, end_date DATE, created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Report Configs ──
  `CREATE TABLE IF NOT EXISTS report_configs(
    id SERIAL PRIMARY KEY, report_type VARCHAR(50) NOT NULL, frequency VARCHAR(50) NOT NULL,
    recipients JSONB DEFAULT '[]', is_active BOOLEAN DEFAULT TRUE, last_sent_at TIMESTAMPTZ,
    send_time VARCHAR(10) DEFAULT '08:00', timezone VARCHAR(100) DEFAULT 'America/New_York',
    include_sections JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Alert Thresholds ──
  `CREATE TABLE IF NOT EXISTS alert_thresholds(
    id SERIAL PRIMARY KEY, metric VARCHAR(255) NOT NULL, operator VARCHAR(10) NOT NULL,
    threshold_value DECIMAL(14,2) NOT NULL, notification_channels JSONB DEFAULT '["email"]',
    is_active BOOLEAN DEFAULT TRUE, last_triggered_at TIMESTAMPTZ, cooldown_hours INTEGER DEFAULT 24,
    message_template TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── AI Insights ──
  `CREATE TABLE IF NOT EXISTS ai_insights(
    id SERIAL PRIMARY KEY, date DATE NOT NULL, insight_type VARCHAR(100), title VARCHAR(500),
    content TEXT, priority VARCHAR(50), action_items JSONB DEFAULT '[]',
    metrics_snapshot JSONB, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Integrations ──
  `CREATE TABLE IF NOT EXISTS integrations(
    id SERIAL PRIMARY KEY, platform VARCHAR(100) UNIQUE NOT NULL, is_connected BOOLEAN DEFAULT FALSE,
    config JSONB DEFAULT '{}', last_sync_at TIMESTAMPTZ, sync_status VARCHAR(50) DEFAULT 'idle',
    error_message TEXT, sync_frequency VARCHAR(50) DEFAULT 'daily',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Forecasts ──
  `CREATE TABLE IF NOT EXISTS forecasts(
    id SERIAL PRIMARY KEY, generated_date DATE NOT NULL, forecast_type VARCHAR(100),
    monthly_forecasts JSONB DEFAULT '{}', confidence_level DECIMAL(5,2),
    assumptions JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`,

  // ── Indexes ──
  `CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date)`,
  // Migration: change woo_order_id to varchar if it was integer (for marketplace order IDs)
  `ALTER TABLE orders ALTER COLUMN woo_order_id TYPE VARCHAR(100) USING woo_order_id::VARCHAR(100)`,
  // Ensure email_revenue column exists
  `ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS email_revenue DECIMAL(14,2) DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_orders_cust ON orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_country ON orders(country)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_prod ON order_items(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dm_date ON daily_metrics(date)`,
  `CREATE INDEX IF NOT EXISTS idx_ad_date ON ad_spend_daily(date)`,
  `CREATE INDEX IF NOT EXISTS idx_ad_platform ON ad_spend_daily(platform)`,
  `CREATE INDEX IF NOT EXISTS idx_cust_cohort ON customers(cohort_month)`,
  `CREATE INDEX IF NOT EXISTS idx_cust_email ON customers(email)`,
  `CREATE INDEX IF NOT EXISTS idx_prod_woo ON products(woo_product_id)`,

  // ── Seed data ──
  `INSERT INTO integrations(platform,is_connected) VALUES
    ('woocommerce',false),('meta_ads',false),('google_ads',false),('tiktok_ads',false),
    ('stripe',false),('paypal',false),('klaviyo',false),('google_analytics',false),
    ('search_console',false),('slack',false),('shipstation',false),
    ('elavon',false),('amazon_mcf',false),('amazon_marketplace',false),
    ('tiktok_shop',false),('meta_shop',false),('enginemailer',false)
   ON CONFLICT(platform) DO NOTHING`,

  `INSERT INTO report_configs(report_type,frequency,recipients,is_active,include_sections) VALUES
    ('daily_summary','daily','[]',true,'["revenue","profit","orders","marketing"]'),
    ('weekly_summary','weekly','[]',true,'["revenue","profit","orders","marketing","products","ltv"]'),
    ('monthly_pnl','monthly','[]',true,'["full_pnl","goals","cohorts","forecast"]')
   ON CONFLICT DO NOTHING`
];

async function run() {
  console.log("Running migrations...");
  const c = await pool.connect();
  try {
    for (let i = 0; i < SQL.length; i++) {
      try { await c.query(SQL[i]); }
      catch (e) {
        if (!e.message.includes("already exists") && !e.message.includes("duplicate"))
          console.warn("  Warn #" + (i + 1) + ": " + e.message.slice(0, 100));
      }
    }
    console.log("All " + SQL.length + " migrations completed!");
  } finally { c.release(); await pool.end(); }
}
run();
