import type { Job } from '../../shared/types'
import { BODYLESS_METHODS } from '../../shared/types'
import type { Env } from './env'
import type { RunInput } from './db'
import { describeAllowlist, parseAllowlist, urlAllowed } from './hosts'
import {
  MissingSecretError,
  applyRedaction,
  buildRedaction,
  dropCutNeedle,
  interpolate,
  refsIn,
  refsInJob,
} from './secrets'


const SNIPPET_BYTES = 512

/** GitHub and friends reject requests with no user-agent at all. */
const DEFAULT_USER_AGENT = 'curl/8.13.0'

/**
 * Cancels after `limit`, so a huge response is not buffered to slice a line off
 * it. Reports whether it stopped early, which the caller needs: a value cut by
 * the limit cannot be recognised, so it cannot be redacted.
 */
async function readSnippet(response: Response, limit: number): Promise<{ text: string; cut: boolean }> {
  if (!response.body) return { text: '', cut: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let ended = false
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return { text: new TextDecoder().decode(joined.slice(0, limit)), cut: !ended || total > limit }
}

/**
 * Never throws. A failed dispatch is a row in `runs`, because the log is the
 * only place a failure surfaces at all.
 */
export async function dispatch(job: Job, env: Env, trigger: 'cron' | 'manual'): Promise<RunInput> {
  const startedAt = Date.now()

  // Built once; also tells the snippet reader how far past its cut to read.
  const referenced = refsInJob(job)
  const redaction = buildRedaction(env, referenced)
  const hide = (text: string) => applyRedaction(text, redaction)

  const record = (fields: Partial<RunInput>): RunInput => ({
    job_id: job.id,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
    status: null,
    ok: false,
    trigger,
    error: null,
    response_snip: null,
    ...fields,
  })

  let url: string
  const headers = new Headers()
  let body: string | undefined

  try {
    url = interpolate(job.url, env)
    for (const [name, value] of Object.entries(job.headers)) {
      if (name.trim() === '') continue
      headers.set(name, interpolate(value, env))
    }
    if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_USER_AGENT)
    if (job.body !== null && !BODYLESS_METHODS.includes(job.method)) {
      body = interpolate(job.body, env)
    }
  } catch (cause) {
    if (cause instanceof MissingSecretError) {
      return record({ error: `Secret not set on this deployment: ${cause.names.join(', ')}` })
    }
    return record({ error: hide(`Could not build the request: ${String(cause)}`) })
  }

  // Re-checked here, not only at save time: the list can be tightened, a
  // secret can be rotated, and a row can reach D1 without ever being validated.
  const allowlist = parseAllowlist(env.ALLOWED_HOSTS)
  if (allowlist.state !== 'unrestricted') {
    let resolved: URL
    try {
      resolved = new URL(url)
    } catch {
      return record({ error: 'The URL is not valid once its secrets are substituted.' })
    }
    if (!urlAllowed(resolved, allowlist)) {
      // Named only when no reference could be hiding a secret in the host.
      const shown = refsIn(job.url).length === 0 ? `'${resolved.host}'` : 'the resolved host'
      return record({
        error: `Not sent: ${shown} is not in this deployment's allowed hosts (${describeAllowlist(allowlist)}).`,
      })
    }
  }

  try {
    const response = await fetch(url, {
      method: job.method,
      headers,
      body,
      // Following one would forward credentials to wherever it points.
      redirect: 'manual',
      signal: AbortSignal.timeout(job.timeout_ms),
    })

    // Read past the cut, redact, then slice. Cutting first leaves the raw prefix
    // of a straddling secret, and never matches one longer than 512.
    const read = await readSnippet(response, SNIPPET_BYTES + redaction.longestNeedle)
    let cleaned = hide(read.text)

    // Redaction shrinks what it rewrites, which drags later material back under
    // the 512th byte — including a value the read cut in half, which no rewrite
    // could match. Removing the remnant has to happen before the slice, or the
    // slice hands it back.
    if (read.cut) cleaned = dropCutNeedle(cleaned, redaction)

    const snippet = cleaned.slice(0, SNIPPET_BYTES)
    const ok = response.status >= 200 && response.status < 300
    const redirected = response.status >= 300 && response.status < 400

    return record({
      status: response.status,
      ok,
      response_snip: snippet === '' ? null : snippet,
      error: ok
        ? null
        : redirected
          ? `HTTP ${response.status}: the URL redirects, which is not followed (credentials would leak to the target) — point the job at the final URL`
          : hide(`HTTP ${response.status} ${response.statusText}`.trim()),
    })
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return record({ error: `Timed out after ${job.timeout_ms}ms` })
    }
    // A network error can embed the URL, which may carry an interpolated secret.
    return record({ error: hide(cause instanceof Error ? cause.message : String(cause)) })
  }
}
