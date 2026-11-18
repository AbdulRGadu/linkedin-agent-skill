ALTER TABLE scheduler_credentials ADD COLUMN community_ciphertext TEXT;
ALTER TABLE scheduler_credentials ADD COLUMN community_person_urn TEXT;
ALTER TABLE scheduler_credentials ADD COLUMN community_scopes TEXT;
ALTER TABLE scheduler_credentials ADD COLUMN community_expires_at INTEGER;
ALTER TABLE scheduler_credentials ADD COLUMN community_client_id TEXT;
ALTER TABLE scheduler_credentials ADD COLUMN community_invalid INTEGER NOT NULL DEFAULT 0 CHECK (community_invalid IN (0,1));
