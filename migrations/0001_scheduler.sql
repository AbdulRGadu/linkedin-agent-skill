CREATE TABLE scheduler_credentials (
  target_urn TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  invalid INTEGER NOT NULL DEFAULT 0 CHECK (invalid IN (0, 1))
);
CREATE TABLE scheduled_posts (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 3000),
  target_type TEXT NOT NULL DEFAULT 'person' CHECK (target_type = 'person'),
  target_urn TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  approved_at INTEGER NOT NULL,
  approval_grant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'publishing', 'published', 'cancelled', 'blocked', 'failed', 'needs_review')),
  attempted_at INTEGER,
  attempt_id TEXT,
  published_at INTEGER,
  linkedin_post_id TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX scheduled_posts_due ON scheduled_posts(status, scheduled_at);
CREATE INDEX scheduled_posts_member ON scheduled_posts(target_urn, scheduled_at, id);
-- Retain previous times after rescheduling so delayed retries cannot recreate them.
CREATE TABLE schedule_keys (
  dedupe_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES scheduled_posts(id)
);
CREATE TABLE scheduler_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at INTEGER NOT NULL,
  last_completed_at INTEGER,
  problem TEXT
);
