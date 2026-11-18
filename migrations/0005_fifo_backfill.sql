-- The supplied date is known, but the exact time of the manual publication is not.
UPDATE scheduled_posts SET status='published', linkedin_post_id='urn:li:share:7528913699189747714',
  reason='manual_publication_2026-11-18_time_unknown', publish_day='2026-11-18', updated_at=unixepoch()*1000
WHERE id='ad77a89f-0c8c-4ac9-abd1-2165c84b8598' AND (
  (status='blocked' AND reason='missed_time_requires_reschedule' AND linkedin_post_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM scheduled_posts WHERE linkedin_post_id='urn:li:share:7528913699189747714'))
  OR (status='published' AND linkedin_post_id='urn:li:share:7528913699189747714' AND publish_day IS NULL)
);

-- Keep previous attempts visible. In-flight legacy writes must be reviewed.
UPDATE scheduled_posts SET status='needs_review', reason='legacy_publish_outcome_unknown'
WHERE status='publishing' AND publish_day IS NULL;
UPDATE scheduled_posts SET attempt_count=1 WHERE attempted_at IS NOT NULL AND attempt_count=0;
UPDATE scheduled_posts SET status='scheduled', reason=NULL
WHERE status='blocked' AND reason='missed_time_requires_reschedule' AND attempted_at IS NULL
  AND linkedin_post_id IS NULL AND id<>'ad77a89f-0c8c-4ac9-abd1-2165c84b8598';

WITH positions AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (ORDER BY scheduled_at, approved_at, id) +
    (SELECT COALESCE(MAX(queue_position),0) FROM scheduled_posts) AS position
  FROM scheduled_posts WHERE queue_position IS NULL
)
UPDATE scheduled_posts SET queue_position=(SELECT position FROM positions WHERE positions.id=scheduled_posts.id)
WHERE queue_position IS NULL;
