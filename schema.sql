-- Apply with `pnpm run db:init` or `pnpm run db:init:local`. Safe to re-run.

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  cron        TEXT NOT NULL,                      -- 5-field, UTC
  url         TEXT NOT NULL,                      -- may reference ${CRONHUB_*}
  method      TEXT NOT NULL DEFAULT 'POST',
  headers     TEXT NOT NULL DEFAULT '{}',         -- JSON object; values may reference ${CRONHUB_*}
  body        TEXT,                               -- may reference ${CRONHUB_*}
  timeout_ms  INTEGER NOT NULL DEFAULT 10000,
  enabled     INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  -- Kept here rather than derived from `runs`, which is pruned at 14 days:
  -- anything sparser would otherwise look overdue forever. Manual runs do not
  -- touch it, being no evidence that the heartbeat is alive.
  last_fired_at INTEGER,
  created_at  INTEGER NOT NULL,                   -- epoch ms
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_enabled ON jobs(enabled);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,                 -- epoch ms
  duration_ms   INTEGER,
  status        INTEGER,                          -- HTTP status; NULL if the request never completed
  ok            INTEGER NOT NULL,
  trigger       TEXT NOT NULL,                    -- 'cron' | 'manual'
  error         TEXT,
  response_snip TEXT                              -- first bytes, secret-redacted
);

CREATE INDEX IF NOT EXISTS runs_job_time ON runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_failed   ON runs(ok, started_at DESC);
