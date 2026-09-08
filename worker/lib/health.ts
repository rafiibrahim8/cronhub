import type { Job, JobWithHealth, Run } from '../../shared/types'
import { nextAfter, parseCron } from './cron'

/** Cloudflare's crons arrive a little late, so allow slack before alarming. */
const GRACE_MS = 3 * 60_000

/**
 * Attaches next-run and `stale`, the only signal that the heartbeat itself
 * stopped — a tick that never happens writes no failure row to notice.
 */
export function withHealth(job: Job, lastRun: Run | null, now: number): JobWithHealth {
  let nextRun: number | null = null
  let stale = false

  try {
    const spec = parseCron(job.cron)
    nextRun = nextAfter(spec, now)

    if (job.enabled) {
      // Not the newest run row: runs are pruned at 14 days, so anything sparser
      // would read overdue forever. `updated_at` floors it, so editing a
      // schedule is not judged against the old one's expectation.
      const since = Math.max(job.last_fired_at ?? 0, job.updated_at)
      const expected = nextAfter(spec, since)
      stale = expected !== null && expected < now - GRACE_MS
    }
  } catch {
    // An unparseable schedule already logs a failed run every tick.
  }

  return { ...job, last_run: lastRun, next_run: nextRun, stale }
}
