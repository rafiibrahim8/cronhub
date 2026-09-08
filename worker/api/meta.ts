import type { Config, CronPreview, TemplateCheck } from '../../shared/types'
import { CronError, nextRuns, parseCron } from '../lib/cron'
import type { Env } from '../lib/env'
import { badRequest, json } from '../lib/http'
import { parseAllowlist } from '../lib/hosts'
import { listSecretNames, missingRefs, refsInJob, SECRET_PREFIX } from '../lib/secrets'
import { MAX_DISPATCHES, RUN_RETENTION_DAYS } from '../lib/tick'
import { MAX_TIMEOUT } from '../lib/validate'

/** Names only; no route in this Worker returns a value. */
export function secrets(env: Env): Response {
  return json({ names: listSecretNames(env) })
}

/** Policy, so the manual cannot drift from what the Worker enforces. */
export function config(env: Env): Response {
  const allowlist = parseAllowlist(env.ALLOWED_HOSTS)
  return json({
    allowed_hosts: allowlist.state === 'restricted' ? allowlist.patterns : [],
    allowed_hosts_state: allowlist.state,
    retention_days: RUN_RETENTION_DAYS,
    max_per_tick: MAX_DISPATCHES,
    max_timeout_ms: MAX_TIMEOUT,
    secret_prefix: SECRET_PREFIX,
  } satisfies Config)
}

const PREVIEW_COUNT = 5

/** Next fire times, and which references in a draft resolve to nothing. */
export async function preview(request: Request, env: Env): Promise<Response> {
  const raw = await request.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return badRequest('Expected an object.')
  const draft = raw as Record<string, unknown>

  let cron: CronPreview = { valid: false, next: [] }
  if (typeof draft.cron === 'string' && draft.cron.trim() !== '') {
    try {
      cron = { valid: true, next: nextRuns(parseCron(draft.cron), Date.now(), PREVIEW_COUNT) }
    } catch (cause) {
      cron = { valid: false, message: cause instanceof CronError ? cause.message : String(cause), next: [] }
    }
  } else {
    cron = { valid: false, message: 'the schedule is empty', next: [] }
  }

  const headers: Record<string, string> = {}
  if (draft.headers && typeof draft.headers === 'object' && !Array.isArray(draft.headers)) {
    for (const [key, value] of Object.entries(draft.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const shape = {
    url: typeof draft.url === 'string' ? draft.url : '',
    headers,
    body: typeof draft.body === 'string' ? draft.body : null,
  }

  const template: TemplateCheck = { refs: refsInJob(shape), missing: missingRefs(shape, env) }
  return json({ cron, template })
}
