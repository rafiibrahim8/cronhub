-- Adds jobs.last_fired_at, so staleness survives the 14-day run prune.
--
-- Apply to an existing database with:
--   wrangler d1 execute cronhub --remote --file=./migrations/0001-last-fired-at.sql
-- Fresh databases get this from schema.sql and do not need it.

ALTER TABLE jobs ADD COLUMN last_fired_at INTEGER;

-- Backfill from surviving history, so existing jobs are not all overdue.
UPDATE jobs
   SET last_fired_at = (
         SELECT MAX(started_at) FROM runs
          WHERE runs.job_id = jobs.id AND runs.trigger = 'cron'
       );
