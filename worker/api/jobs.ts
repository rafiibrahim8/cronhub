import type { Job, JobInput } from '../../shared/types'
import { createJob, deleteJob, getJob, getLastRun, insertRun, listJobsWithLastRun, updateJob } from '../lib/db'
import { dispatch } from '../lib/dispatch'
import type { Env } from '../lib/env'
import { badRequest, json, notFound } from '../lib/http'
import { withHealth } from '../lib/health'
import { validateJobInput } from '../lib/validate'

export async function list(env: Env): Promise<Response> {
  const now = Date.now()
  const rows = await listJobsWithLastRun(env.DB)
  return json({ jobs: rows.map(({ job, last_run }) => withHealth(job, last_run, now)) })
}

export async function create(request: Request, env: Env): Promise<Response> {
  const raw = await request.json().catch(() => null)
  const checked = validateJobInput(raw, env)
  if (!checked.ok) return badRequest(checked.message, { missing: checked.missing })

  try {
    const job = await createJob(env.DB, checked.input)
    return json({ job: withHealth(job, null, Date.now()) }, { status: 201 })
  } catch (cause) {
    if (String(cause).includes('UNIQUE')) return badRequest('A job with that name already exists.')
    throw cause
  }
}

/** Partial: merged over what is stored, then validated whole. */
export async function update(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await getJob(env.DB, id)
  if (!existing) return notFound('No such job.')

  const patch = await request.json().catch(() => null)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return badRequest('Expected a job object.')

  const current: JobInput = {
    name: existing.name,
    cron: existing.cron,
    url: existing.url,
    method: existing.method,
    headers: existing.headers,
    body: existing.body,
    timeout_ms: existing.timeout_ms,
    enabled: existing.enabled,
    notes: existing.notes,
  }

  const checked = validateJobInput({ ...current, ...(patch as Record<string, unknown>) }, env)
  if (!checked.ok) return badRequest(checked.message, { missing: checked.missing })

  try {
    const job = await updateJob(env.DB, id, checked.input)
    if (!job) return notFound('No such job.')
    // Not null: passing null reported a healthy job as stale.
    const lastRun = await getLastRun(env.DB, id)
    return json({ job: withHealth(job, lastRun, Date.now()) })
  } catch (cause) {
    if (String(cause).includes('UNIQUE')) return badRequest('A job with that name already exists.')
    throw cause
  }
}

export async function remove(env: Env, id: string): Promise<Response> {
  const deleted = await deleteJob(env.DB, id)
  if (!deleted) return notFound('No such job.')
  return json({ ok: true })
}

/** Ignores the schedule and the enabled flag, but not the allowlist. */
export async function runNow(env: Env, id: string): Promise<Response> {
  const job: Job | null = await getJob(env.DB, id)
  if (!job) return notFound('No such job.')

  const record = await dispatch(job, env, 'manual')
  const run = await insertRun(env.DB, record)
  return json({ run })
}
