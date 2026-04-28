-- TVS Inbox Analyzer Schema

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS analyses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode VARCHAR(20) NOT NULL,
  campaign_label VARCHAR(255),
  subject TEXT NOT NULL,
  html_template TEXT NOT NULL,
  sender_email VARCHAR(255),
  sender_name VARCHAR(255),
  primary_score INTEGER NOT NULL,
  promotions_score INTEGER NOT NULL,
  spam_score INTEGER NOT NULL,
  template_quality INTEGER NOT NULL,
  sender_quality INTEGER,
  combined_score INTEGER,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analyses_user_id ON analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  emailit_api_key TEXT,
  emailit_from_email VARCHAR(255),
  emailit_from_name VARCHAR(255),
  emailit_reply_to VARCHAR(255),
  send_rate_per_minute INTEGER DEFAULT 30,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_groups_user_id ON test_groups(user_id);

CREATE TABLE IF NOT EXISTS group_emails (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES test_groups(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, email)
);
CREATE INDEX IF NOT EXISTS idx_group_emails_group_id ON group_emails(group_id);

CREATE TABLE IF NOT EXISTS send_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES test_groups(id) ON DELETE SET NULL,
  campaign_label VARCHAR(255),
  subject TEXT NOT NULL,
  html_template TEXT NOT NULL,
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255),
  reply_to VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_send_jobs_user_id ON send_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_send_jobs_status ON send_jobs(status);
CREATE INDEX IF NOT EXISTS idx_send_jobs_created_at ON send_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS send_recipients (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  emailit_id VARCHAR(100),
  error_message TEXT,
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_send_recipients_job_id ON send_recipients(job_id);
CREATE INDEX IF NOT EXISTS idx_send_recipients_status ON send_recipients(status);

-- Scheduled sends: user picks a date/time, scheduler fires them automatically
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES test_groups(id) ON DELETE SET NULL,
  campaign_label VARCHAR(255),
  subject TEXT NOT NULL,
  html_template TEXT NOT NULL,
  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(255),
  reply_to VARCHAR(255),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  -- scheduled, running, completed, failed, cancelled
  send_job_id INTEGER REFERENCES send_jobs(id) ON DELETE SET NULL,
  error_message TEXT,
  fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_user_id ON scheduled_sends(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_scheduled_at ON scheduled_sends(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_status ON scheduled_sends(status);
