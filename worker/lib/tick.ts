import type { Job } from '../../shared/types'
import { CronError, matches, parseCron } from './cron'
import type { RunInput } from './db'
import { MAX_RUNS_PER_TICK, listEnabledJobs, markFiredStatement, pruneRuns, runInsertStatements } from './db'
import { dispatch } from './dispatch'
import type { Env } from './env'

/**
 * The free plan allows 50 subrequests per invocation and D1 calls draw on the
 * same budget. 40 keeps it inside even if every statement in a batch counts:
 * 1 read + 40 dispatches + 8 inserts + 1 prune.
 */
export const MAX_DISPATCHES = 40

export const RUN_RETENTION_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000


const toMinute = (ms: number) => Math.floor(ms / 60_000) * 60_000

export type TickSummary = {
  minute: number
  considered: number
  fired: number
  failed: number
  skipped: number
  pruned: number
}

/**
 * Keyed off `scheduledTime`, not the wall clock: a tick delivered after the
 * next minute boundary would otherwise skip its own jobs and double-fire the
 * following minute's.
 */
export async function tick(scheduledTime: number, env: Env): Promise<TickSummary> {
  const minute = toMinute(scheduledTime)
  const at = new Date(minute)

  const jobs = await listEnabledJobs(env.DB)
  const due: Job[] = []
  const records: RunInput[] = []

  for (const job of jobs) {
    try {
      if (matches(parseCron(job.cron), at)) due.push(job)
    } catch (cause) {
      // Only a hand-edited row gets here. Logged, not thrown, so one bad
      // schedule cannot stop every other job.
      records.push({
        job_id: job.id,
        started_at: minute,
        duration_ms: 0,
        status: null,
        ok: false,
        trigger: 'cron',
        error: `Schedule '${job.cron}' could not be parsed: ${cause instanceof CronError ? cause.message : String(cause)}`,
        response_snip: null,
      })
    }
  }

  // Deterministic, so the job that loses to the cap is the same one next tick.
  due.sort((a, b) => a.name.localeCompare(b.name))
  const firing = due.slice(0, MAX_DISPATCHES)
  const shed = due.slice(MAX_DISPATCHES)

  for (const job of shed) {
    records.push({
      job_id: job.id,
      started_at: minute,
      duration_ms: 0,
      status: null,
      ok: false,
      trigger: 'cron',
      error: `Not dispatched: ${due.length} jobs were due this minute and a single tick can only make ${MAX_DISPATCHES} requests. Stagger these schedules.`,
      response_snip: null,
    })
  }

  const results = await Promise.all(firing.map((job) => dispatch(job, env, 'cron')))

  // Real outcomes first, shed notices fill what is left of the write budget.
  const toWrite = [...results, ...records].slice(0, MAX_RUNS_PER_TICK)
  const dropped = results.length + records.length - toWrite.length
  if (dropped > 0) {
    console.error(`tick ${new Date(minute).toISOString()}: ${dropped} run records dropped, over the ${MAX_RUNS_PER_TICK} per-tick write budget`)
  }

  // One batch, so one subrequest. The stamp is written even when the dispatch
  // failed — the heartbeat did its part either way, which is what stale means.
  const statements = runInsertStatements(env.DB, toWrite)
  if (firing.length > 0) {
    statements.push(markFiredStatement(env.DB, firing.map((job) => job.id), minute))
  }
  if (statements.length === 1) await statements[0].run()
  else if (statements.length > 1) await env.DB.batch(statements)

  // Hourly, so 59 ticks in 60 do not pay the extra subrequest.
  let pruned = 0
  if (at.getUTCMinutes() === 0) {
    pruned = await pruneRuns(env.DB, minute - RUN_RETENTION_DAYS * DAY_MS)
  }

  const failed = toWrite.filter((record) => !record.ok).length
  const summary: TickSummary = {
    minute,
    considered: jobs.length,
    fired: firing.length,
    failed,
    skipped: shed.length,
    pruned,
  }

  console.log(
    `tick ${new Date(minute).toISOString()} considered=${summary.considered} fired=${summary.fired} failed=${summary.failed} skipped=${summary.skipped} pruned=${summary.pruned}`,
  )
  return summary
}
