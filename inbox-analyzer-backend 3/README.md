# TVS Inbox Analyzer — Backend

Email template inbox-placement analyzer for The Vitamin Shots. Scores any HTML email template (and optionally the sender) for likelihood of landing in **Primary**, **Promotions**, or **Spam** — with focus on Gmail.

## Stack
- Node.js 20 + Express
- PostgreSQL (via `pg`)
- JWT auth (bcryptjs)
- Cheerio for HTML parsing
- Native DNS for SPF / DKIM / DMARC / MX / BIMI checks

## Railway Deployment

### 1. Add a PostgreSQL plugin
Railway → New → Database → PostgreSQL. Railway will inject `DATABASE_URL` automatically.

### 2. Deploy this backend
- New service → Deploy from GitHub repo (or upload zip)
- Railway will auto-detect Node.js via `nixpacks.toml`
- Set the env vars below

### 3. Environment Variables (Railway → Variables)
| Variable | Required | Example |
|---|---|---|
| `DATABASE_URL` | Yes | *Auto-injected by Railway PG plugin* |
| `JWT_SECRET` | **Yes** | A long random string (32+ chars) |
| `JWT_EXPIRES_IN` | No | `7d` (default) |
| `CORS_ORIGIN` | Yes | `https://tvs-inbox-analyzer-frontend.up.railway.app` |
| `PORT` | No | Auto-set by Railway |
| `NODE_ENV` | No | `production` |

> Generate a JWT secret quickly: `openssl rand -hex 32`

### 4. First deploy
On boot, the server runs `runMigrations()` which creates the `users` and `analyses` tables automatically. No separate migration step needed.

## API

### Auth
- `POST /api/auth/register` → `{ email, password, name? }` → `{ user, token }`
- `POST /api/auth/login` → `{ email, password }` → `{ user, token }`
- `GET  /api/auth/me` → (Bearer) → `{ user }`

### Analyze (Bearer required)
- `POST /api/analyze/template` → `{ subject, html, campaignLabel? }`
- `POST /api/analyze/full` → `{ subject, html, senderEmail, senderName?, campaignLabel? }`

Response:
```json
{
  "id": 42,
  "probabilities": { "primary": 38, "promotions": 51, "spam": 11 },
  "templateQuality": 76,
  "senderQuality": 82,
  "combinedScore": 64,
  "issues": [...],
  "positives": [...],
  "breakdown": { "subject": {...}, "html": {...}, "content": {...}, "links": {...}, "compliance": {...}, "sender": {...} },
  "summary": { "verdict": "...", ... }
}
```

### History (Bearer required)
- `GET    /api/history` — list past analyses
- `GET    /api/history/:id` — full detail
- `DELETE /api/history/:id` — delete

## Local development
```bash
cp .env.example .env
# fill in DATABASE_URL pointing to a local Postgres
npm install
npm run migrate
npm run dev
```

## Scoring methodology
Five rule-based analyzers (subject, HTML structure, content, links, compliance) each contribute weighted points to three buckets (primary / promotions / spam). Scores are summed with sensible base values, capped, and normalised to sum to 100%. Sender DNS analysis runs in parallel using the native `dns/promises` module — no third-party API needed.

The combined score (when sender provided) blends 50% template inbox-placement probability + 25% template quality + 25% sender quality, with penalties for very weak template or sender.
