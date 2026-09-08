import type { HttpMethod, Job, JobInput, Run } from '../../shared/types'

export type RunInput = Omit<Run, 'id'>

type JobRow = {
  id: string
  name: string
  cron: string
  url: string
  method: string
  headers: string
  body: string | null
  timeout_ms: number
  enabled: number
  notes: string | null
  last_fired_at: number | null
  created_at: number
  updated_at: number
}

type JobRowWithRun = JobRow & {
  r_id: number | null
  r_started_at: number | null
  r_duration_ms: number | null
  r_status: number | null
  r_ok: number | null
  r_trigger: string | null
  r_error: string | null
  r_response_snip: string | null
}

/** Unparseable blobs read as empty rather than throwing. */
function parseHeaders(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    url: row.url,
    method: row.method as HttpMethod,
    headers: parseHeaders(row.headers),
    body: row.body,
    timeout_ms: row.timeout_ms,
    enabled: row.enabled === 1,
    notes: row.notes,
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toRun(row: {
  id: number
  job_id: string
  started_at: number
  duration_ms: number | null
  status: number | null
  ok: number
  trigger: string
  error: string | null
  response_snip: string | null
}): Run {
  return {
    id: row.id,
    job_id: row.job_id,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    status: row.status,
    ok: row.ok === 1,
    trigger: row.trigger === 'manual' ? 'manual' : 'cron',
    error: row.error,
    response_snip: row.response_snip,
  }
}

const JOB_COLUMNS =
  'id, name, cron, url, method, headers, body, timeout_ms, enabled, notes, last_fired_at, created_at, updated_at'

/** One query. The latest run comes from a subquery, so no column can drift. */
export async function listJobsWithLastRun(db: D1Database): Promise<Array<{ job: Job; last_run: Run | null }>> {
  const { results } = await db
    .prepare(
      `SELECT ${JOB_COLUMNS.split(', ').map((c) => `j.${c}`).join(', ')},
              r.id AS r_id, r.started_at AS r_started_at, r.duration_ms AS r_duration_ms,
              r.status AS r_status, r.ok AS r_ok, r.trigger AS r_trigger,
              r.error AS r_error, r.response_snip AS r_response_snip
         FROM jobs j
         LEFT JOIN runs r
                ON r.id = (SELECT id FROM runs WHERE job_id = j.id ORDER BY started_at DESC, id DESC LIMIT 1)
        ORDER BY j.name COLLATE NOCASE`,
    )
    .all<JobRowWithRun>()

  return (results ?? []).map((row) => ({
    job: toJob(row),
    last_run:
      row.r_id === null
        ? null
        : toRun({
            id: row.r_id,
            job_id: row.id,
            started_at: row.r_started_at as number,
            duration_ms: row.r_duration_ms,
            status: row.r_status,
            ok: row.r_ok as number,
            trigger: row.r_trigger as string,
            error: row.r_error,
            response_snip: row.r_response_snip,
          }),
  }))
}

/** The heartbeat's only read. */
export async function listEnabledJobs(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE enabled = 1`)
    .all<JobRow>()
  return (results ?? []).map(toJob)
}

export async function getJob(db: D1Database, id: string): Promise<Job | null> {
  const row = await db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).bind(id).first<JobRow>()
  return row ? toJob(row) : null
}

export async function createJob(db: D1Database, input: JobInput): Promise<Job> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const row = await db
    .prepare(
      `INSERT INTO jobs (id, name, cron, url, method, headers, body, timeout_ms, enabled, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${JOB_COLUMNS}`,
    )
    .bind(
      id,
      input.name,
      input.cron,
      input.url,
      input.method,
      JSON.stringify(input.headers),
      input.body,
      input.timeout_ms,
      input.enabled ? 1 : 0,
      input.notes,
      now,
      now,
    )
    .first<JobRow>()
  if (!row) throw new Error('insert returned no row')
  return toJob(row)
}

export async function updateJob(db: D1Database, id: string, input: JobInput): Promise<Job | null> {
  const row = await db
    .prepare(
      `UPDATE jobs
          SET name = ?, cron = ?, url = ?, method = ?, headers = ?, body = ?,
              timeout_ms = ?, enabled = ?, notes = ?, updated_at = ?
        WHERE id = ?
       RETURNING ${JOB_COLUMNS}`,
    )
    .bind(
      input.name,
      input.cron,
      input.url,
      input.method,
      JSON.stringify(input.headers),
      input.body,
      input.timeout_ms,
      input.enabled ? 1 : 0,
      input.notes,
      Date.now(),
      id,
    )
    .first<JobRow>()
  return row ? toJob(row) : null
}

export async function deleteJob(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run()
  return (result.meta.changes ?? 0) > 0
}

/** Eight parameters per row against D1's hard cap of 100 per statement. */
const RUNS_PER_STATEMENT = 12

/**
 * Chunked because D1 refuses more than 100 bound parameters per statement: a
 * single multi-VALUES insert works to the twelfth row, then fails the whole
 * tick with `too many SQL variables`.
 */
export function runInsertStatements(db: D1Database, runs: RunInput[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < runs.length; offset += RUNS_PER_STATEMENT) {
    const chunk = runs.slice(offset, offset + RUNS_PER_STATEMENT)
    const bindings: unknown[] = []
    for (const run of chunk) {
      bindings.push(
        run.job_id,
        run.started_at,
        run.duration_ms,
        run.status,
        run.ok ? 1 : 0,
        run.trigger,
        run.error,
        run.response_snip,
      )
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO runs (job_id, started_at, duration_ms, status, ok, trigger, error, response_snip)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .bind(...bindings),
    )
  }

  return statements
}

export async function insertRuns(db: D1Database, runs: RunInput[]): Promise<void> {
  if (runs.length === 0) return
  const statements = runInsertStatements(db, runs)
  if (statements.length === 1) await statements[0].run()
  else await db.batch(statements)
}


export const MAX_RUNS_PER_TICK = RUNS_PER_STATEMENT * 8

/** Returned unexecuted so the tick can batch it with the run records. */
export function markFiredStatement(db: D1Database, jobIds: string[], at: number): D1PreparedStatement {
  const placeholders = jobIds.map(() => '?').join(', ')
  return db
    .prepare(`UPDATE jobs SET last_fired_at = ? WHERE id IN (${placeholders})`)
    .bind(at, ...jobIds)
}

export async function insertRun(db: D1Database, run: RunInput): Promise<Run> {
  const row = await db
    .prepare(
      `INSERT INTO runs (job_id, started_at, duration_ms, status, ok, trigger, error, response_snip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, job_id, started_at, duration_ms, status, ok, trigger, error, response_snip`,
    )
    .bind(
      run.job_id,
      run.started_at,
      run.duration_ms,
      run.status,
      run.ok ? 1 : 0,
      run.trigger,
      run.error,
      run.response_snip,
    )
    .first<Parameters<typeof toRun>[0]>()
  if (!row) throw new Error('insert returned no row')
  return toRun(row)
}

/** The most recent run for one job. */
export async function getLastRun(db: D1Database, jobId: string): Promise<Run | null> {
  const row = await db
    .prepare(
      `SELECT id, job_id, started_at, duration_ms, status, ok, trigger, error, response_snip
         FROM runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .bind(jobId)
    .first<Parameters<typeof toRun>[0]>()
  return row ? toRun(row) : null
}

export async function listRuns(
  db: D1Database,
  options: { jobId?: string; failedOnly?: boolean; limit: number },
): Promise<Run[]> {
  const where: string[] = []
  const bindings: unknown[] = []
  if (options.jobId) {
    where.push('job_id = ?')
    bindings.push(options.jobId)
  }
  if (options.failedOnly) where.push('ok = 0')

  const { results } = await db
    .prepare(
      `SELECT id, job_id, started_at, duration_ms, status, ok, trigger, error, response_snip
         FROM runs
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(...bindings, options.limit)
    .all<Parameters<typeof toRun>[0]>()

  return (results ?? []).map(toRun)
}

export async function pruneRuns(db: D1Database, olderThanMs: number): Promise<number> {
  const result = await db.prepare('DELETE FROM runs WHERE started_at < ?').bind(olderThanMs).run()
  return result.meta.changes ?? 0
}
