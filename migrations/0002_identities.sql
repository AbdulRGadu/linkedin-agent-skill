CREATE TABLE schedule_keys_backup AS SELECT * FROM schedule_keys;
DROP TABLE schedule_keys;
CREATE TABLE scheduled_posts_v2 (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 3000),
  target_type TEXT NOT NULL DEFAULT 'person' CHECK (target_type IN ('person', 'organization')),
  target_urn TEXT NOT NULL,
  owner_urn TEXT NOT NULL,
  target_name TEXT,
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
INSERT INTO scheduled_posts_v2 (id,dedupe_key,text,target_type,target_urn,scheduled_at,approved_at,approval_grant_id,status,attempted_at,attempt_id,published_at,linkedin_post_id,reason,updated_at,owner_urn,target_name) SELECT id,dedupe_key,text,target_type,target_urn,scheduled_at,approved_at,approval_grant_id,status,attempted_at,attempt_id,published_at,linkedin_post_id,reason,updated_at,target_urn,'Personal profile' FROM scheduled_posts;
DROP TABLE scheduled_posts;
ALTER TABLE scheduled_posts_v2 RENAME TO scheduled_posts;
CREATE INDEX scheduled_posts_due ON scheduled_posts(status,scheduled_at);
CREATE INDEX scheduled_posts_owner ON scheduled_posts(owner_urn,scheduled_at,id);
CREATE TABLE schedule_keys (dedupe_key TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES scheduled_posts(id));
INSERT INTO schedule_keys SELECT * FROM schedule_keys_backup;
DROP TABLE schedule_keys_backup;
ALTER TABLE scheduler_credentials ADD COLUMN scopes TEXT;
CREATE TABLE linkedin_objects (member_urn TEXT NOT NULL,object_urn TEXT NOT NULL,actor_urn TEXT NOT NULL,kind TEXT NOT NULL,target_urn TEXT,PRIMARY KEY(member_urn,object_urn));
