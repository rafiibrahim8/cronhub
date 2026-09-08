import type { ApiError, Config, CronPreview, Job, JobInput, JobWithHealth, Run, Session, TemplateCheck } from '../../shared/types'

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly missing?: string[],
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const error = (payload ?? {}) as ApiError
    throw new ApiFailure(
      error.message ?? `Request failed with ${response.status}.`,
      response.status,
      error.error ?? 'unknown',
      error.missing,
    )
  }
  return payload as T
}

export type { Session }

export const getSession = () => call<Session>('/api/session')

export const login = (username: string, password: string) =>
  call<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })

export const logout = () => call<{ ok: true }>('/api/logout', { method: 'POST' })

export const getJobs = () => call<{ jobs: JobWithHealth[] }>('/api/jobs').then((r) => r.jobs)

export const createJob = (input: JobInput) =>
  call<{ job: JobWithHealth }>('/api/jobs', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.job)

export const patchJob = (id: string, patch: Partial<JobInput>) =>
  call<{ job: JobWithHealth }>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.job)

export const deleteJob = (id: string) => call<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' })

export const runJob = (id: string) =>
  call<{ run: Run }>(`/api/jobs/${id}/run`, { method: 'POST' }).then((r) => r.run)

export const getRuns = (options: { jobId?: string; failedOnly?: boolean; limit?: number } = {}) => {
  const params = new URLSearchParams()
  if (options.jobId) params.set('job_id', options.jobId)
  if (options.failedOnly) params.set('failed', '1')
  if (options.limit) params.set('limit', String(options.limit))
  const query = params.toString()
  return call<{ runs: Run[] }>(`/api/runs${query ? `?${query}` : ''}`).then((r) => r.runs)
}

export const getSecretNames = () => call<{ names: string[] }>('/api/secrets').then((r) => r.names)

export const getConfig = () => call<Config>('/api/config')

export const preview = (draft: { cron: string; url: string; headers: Record<string, string>; body: string | null }) =>
  call<{ cron: CronPreview; template: TemplateCheck }>('/api/preview', {
    method: 'POST',
    body: JSON.stringify(draft),
  })

export type { Config, Job, JobInput, JobWithHealth, Run }
