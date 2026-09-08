/** Wire types shared by the Worker and the dashboard. */


export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']


export const BODYLESS_METHODS: readonly HttpMethod[] = ['GET', 'HEAD']

export type Job = {
  id: string
  name: string
  cron: string
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body: string | null
  timeout_ms: number
  enabled: boolean
  notes: string | null
  /** Set by the heartbeat only, never by a manual run. */
  last_fired_at: number | null
  created_at: number
  updated_at: number
}


export type JobInput = {
  name: string
  cron: string
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body: string | null
  timeout_ms: number
  enabled: boolean
  notes: string | null
}

export type Run = {
  id: number
  job_id: string
  started_at: number
  duration_ms: number | null
  status: number | null
  ok: boolean
  trigger: 'cron' | 'manual'
  error: string | null
  response_snip: string | null
}

/** `stale` means it should have fired by now and has not. */
export type JobWithHealth = Job & {
  last_run: Run | null
  next_run: number | null
  stale: boolean
}

export type Session = { authenticated: boolean; configured: boolean }

/** Deployment policy, so the dashboard can explain itself accurately. */
export type Config = {
  /** Only populated when the state is 'restricted'. */
  allowed_hosts: string[]
  /**
   * 'invalid' is distinct from 'unrestricted' on purpose: an empty list must
   * never be ambiguous between no policy and broken policy.
   */
  allowed_hosts_state: 'unrestricted' | 'restricted' | 'invalid'
  retention_days: number
  max_per_tick: number
  max_timeout_ms: number
  secret_prefix: string
}

export type ApiError = { error: string; message: string; missing?: string[] }

export type CronPreview = {
  valid: boolean
  message?: string
  /** Epoch ms, UTC. */
  next: number[]
}

export type TemplateCheck = {
  refs: string[]
  /** References with no matching secret binding. */
  missing: string[]
}
