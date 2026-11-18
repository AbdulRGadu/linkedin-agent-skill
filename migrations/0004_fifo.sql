ALTER TABLE scheduled_posts ADD COLUMN queue_position INTEGER;
ALTER TABLE scheduled_posts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_posts ADD COLUMN retry_at INTEGER;
ALTER TABLE scheduled_posts ADD COLUMN publish_day TEXT;

CREATE UNIQUE INDEX scheduled_posts_queue_position ON scheduled_posts(queue_position);
CREATE UNIQUE INDEX scheduled_posts_one_per_day ON scheduled_posts(publish_day)
  WHERE status IN ('publishing','published','needs_review');
CREATE UNIQUE INDEX scheduled_posts_one_in_flight ON scheduled_posts(status) WHERE status='publishing' AND publish_day IS NOT NULL;
CREATE INDEX scheduled_posts_fifo ON scheduled_posts(queue_position, scheduled_at)
  WHERE status IN ('scheduled','blocked');
