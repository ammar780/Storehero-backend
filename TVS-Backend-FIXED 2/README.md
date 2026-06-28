# TVS Profit Dashboard — Backend API

StoreHero-clone profit analytics for The Vitamin Shots (WooCommerce).

## Architecture

```
WordPress (thevitaminshots.com)
  └─ TVS Dashboard Plugin (sends webhooks + COGS data)
        │
        ▼
Railway Backend (this repo)
  ├─ Express.js API (60+ endpoints)
  ├─ PostgreSQL (16 tables, auto-migrated)
  └─ Cron jobs (daily metrics, ad sync)
        │
        ▼
Railway Frontend (separate repo)
  └─ React + Vite + Tailwind dashboard
```

## Quick Deploy to Railway

1. Push this repo to GitHub
2. In Railway dashboard:
   - New Project > Deploy from GitHub repo
   - Add PostgreSQL plugin (click "New" > "Database" > "PostgreSQL")
   - Railway auto-sets `DATABASE_URL`
3. Set environment variables (see `.env.example` for full list)
4. Minimum required variables:
   - `DATABASE_URL` (auto-set by Railway Postgres)
   - `JWT_SECRET` (random 64 chars)
   - `WOO_STORE_URL` = `https://thevitaminshots.com`
   - `WOO_CONSUMER_KEY` (from WooCommerce REST API)
   - `WOO_CONSUMER_SECRET` (from WooCommerce REST API)
   - `PLUGIN_API_SECRET` (must match WordPress plugin)
5. Deploy — tables auto-created on first boot

## First Run

1. Visit `https://your-backend.up.railway.app/` — should show `{"status":"ok"}`
2. POST `/api/auth/setup` with `{"email","password","name"}` to create admin
3. POST `/api/sync/woocommerce` (with auth token) to pull all products/orders
4. Install WordPress plugin and configure API URL + secret

## API Endpoints (60+)

### Auth
- `GET /api/auth/check-setup` — Is first user created?
- `POST /api/auth/setup` — Create first admin
- `POST /api/auth/login` — Login, get JWT
- `GET /api/auth/me` — Current user

### Dashboard
- `GET /api/dashboard/overview?period=30d` — KPI metrics + trend
- `GET /api/dashboard/pnl?period=30d&group=month` — P&L report
- `GET /api/dashboard/goals-pacing?year=2026` — Goals vs actuals

### Products
- `GET /api/products` — List with profitability
- `GET /api/products/:id` — Detail with 12-month trend
- `PUT /api/products/:id/cogs` — Update COGS
- `PUT /api/products/bulk-cogs` — Bulk COGS update

### Orders
- `GET /api/orders` — Filtered list
- `GET /api/orders/:id` — Order detail with items
- `GET /api/orders/analytics/by-country` — Country breakdown

### Marketing
- `GET /api/marketing/overview` — Blended + platform metrics
- `GET /api/marketing/campaigns` — Campaign performance
- `GET /api/marketing/creatives` — Creative performance
- `GET /api/marketing/spend-advisor` — AI spend recommendation

### Customers / LTV
- `GET /api/customers` — Customer list
- `GET /api/customers/ltv-overview` — LTV distribution
- `GET /api/customers/cohorts` — Monthly cohorts
- `GET /api/customers/product-retention` — Retention by first product

### Forecasts & Scenarios
- `GET /api/forecasts` — 12-month projection
- `POST /api/scenarios` — What-if modeling

### Calculators (no auth required)
- `POST /api/calc/breakeven-roas`
- `POST /api/calc/contribution-margin`
- `POST /api/calc/mer`
- `POST /api/calc/order-profit`
- `POST /api/calc/proas`

### Settings
- Goals: `GET/POST/DELETE /api/settings/goals`
- Fixed Costs: `GET/POST/PUT/DELETE /api/settings/fixed-costs`
- Integrations: `GET/PUT /api/settings/integrations`
- Alerts: `GET/POST/DELETE /api/settings/alerts`
- Reports: `GET/PUT /api/settings/reports`

### WooCommerce
- `POST /api/webhooks/woocommerce` — Webhook receiver
- `POST /api/sync/woocommerce` — Full manual sync
- `POST /api/sync/ad-spend` — Pull ad data from platforms

### WordPress Plugin
- `POST /api/plugin/cogs` — Receive COGS from WP plugin
- `POST /api/plugin/heartbeat` — Plugin connection check
- `GET /api/plugin/products` — Products list for plugin
