import type { HttpMethod, JobInput } from '../../shared/types'
import { HTTP_METHODS } from '../../shared/types'
import { CronError, parseCron } from './cron'
import type { Env } from './env'
import { describeAllowlist, parseAllowlist, urlAllowed } from './hosts'
import { interpolate, missingRefs, refsIn } from './secrets'

export type Validated = { ok: true; input: JobInput } | { ok: false; message: string; missing?: string[] }

const MAX_NAME = 100
const MAX_NOTES = 500
const MAX_BODY = 64 * 1024
const MAX_HEADER_VALUE = 2048
const MIN_TIMEOUT = 1_000
export const MAX_TIMEOUT = 30_000

/** RFC 7230 token characters. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/**
 * `Headers.set` throws on these, so nothing is smuggled either way — but a job
 * saved with one can only ever fail, once a minute, forever.
 */
const BAD_HEADER_VALUE = /[\r\n\u0000]/

/** The runtime owns these; letting one through misrepresents the request. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])

/** Shape only: references are swapped for a token so `new URL` can parse it. */
function checkUrl(url: string): string | null {
  const probe = url.replace(/\$\{CRONHUB_[A-Z0-9_]+\}/g, 'x')
  let parsed: URL
  try {
    parsed = new URL(probe)
  } catch {
    return 'The URL is not a valid absolute URL.'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `The URL must be http or https, not ${parsed.protocol.replace(':', '')}.`
  }
  return null
}

export function validateJobInput(raw: unknown, env: Env): Validated {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Expected a job object.' }
  }
  const source = raw as Record<string, unknown>

  const name = typeof source.name === 'string' ? source.name.trim() : ''
  if (name === '') return { ok: false, message: 'A name is required.' }
  if (name.length > MAX_NAME) return { ok: false, message: `The name must be ${MAX_NAME} characters or fewer.` }

  const cron = typeof source.cron === 'string' ? source.cron.trim() : ''
  try {
    parseCron(cron)
  } catch (cause) {
    if (cause instanceof CronError) return { ok: false, message: `Schedule: ${cause.message}.` }
    throw cause
  }

  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const urlProblem = checkUrl(url)
  if (urlProblem) return { ok: false, message: urlProblem }

  const method = String(source.method ?? 'POST').toUpperCase() as HttpMethod
  if (!HTTP_METHODS.includes(method)) {
    return { ok: false, message: `Method must be one of ${HTTP_METHODS.join(', ')}.` }
  }

  const headers: Record<string, string> = {}
  const rawHeaders = source.headers
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      return { ok: false, message: 'Headers must be an object of name/value pairs.' }
    }
    const seen = new Map<string, string>()
    for (const [headerName, headerValue] of Object.entries(rawHeaders as Record<string, unknown>)) {
      const trimmed = headerName.trim()
      if (trimmed === '') continue
      if (!HEADER_NAME.test(trimmed)) return { ok: false, message: `'${trimmed}' is not a valid header name.` }

      const lower = trimmed.toLowerCase()
      if (RESERVED_HEADERS.has(lower)) {
        return { ok: false, message: `The ${trimmed} header is set by the runtime and cannot be overridden.` }
      }
      // Case-insensitive on the wire, so two such rows become one header and
      // the last silently wins — say so rather than send an unshown value.
      const clash = seen.get(lower)
      if (clash !== undefined) {
        return {
          ok: false,
          message: `'${clash}' and '${trimmed}' are the same header — names are case-insensitive. Keep one.`,
        }
      }
      seen.set(lower, trimmed)

      if (typeof headerValue !== 'string') return { ok: false, message: `The ${trimmed} header must be a string.` }
      if (headerValue.length > MAX_HEADER_VALUE) {
        return { ok: false, message: `The ${trimmed} header value must be ${MAX_HEADER_VALUE} characters or fewer.` }
      }
      if (BAD_HEADER_VALUE.test(headerValue)) {
        return { ok: false, message: `The ${trimmed} header value cannot contain line breaks or null bytes.` }
      }
      headers[trimmed] = headerValue
    }
  }

  let body: string | null = null
  if (typeof source.body === 'string' && source.body !== '') {
    if (source.body.length > MAX_BODY) return { ok: false, message: 'The body must be 64 KB or smaller.' }
    body = source.body
  }

  const timeout = Number(source.timeout_ms ?? 10_000)
  if (!Number.isFinite(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
    return { ok: false, message: `The timeout must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} ms.` }
  }

  let notes: string | null = null
  if (typeof source.notes === 'string' && source.notes.trim() !== '') {
    if (source.notes.length > MAX_NOTES) return { ok: false, message: `Notes must be ${MAX_NOTES} characters or fewer.` }
    notes = source.notes.trim()
  }

  // Otherwise `${cronhub_token}` is sent literally and reads as a broken
  // endpoint rather than as the typo it is.
  const suspicious = /\$\{(?!CRONHUB_[A-Z0-9_]+\})[^}]*\}/
  const templates: Array<[string, string]> = [
    ['URL', url],
    ['body', body ?? ''],
    ...Object.entries(headers).map(([key, value]): [string, string] => [`${key} header`, value]),
  ]
  for (const [label, text] of templates) {
    if (suspicious.test(text)) {
      return {
        ok: false,
        message: `The ${label} contains a placeholder that is not a secret reference. Secret references look like \${CRONHUB_NAME} — uppercase, with the CRONHUB_ prefix.`,
      }
    }
  }

  // `Boolean("false")` is true, which turned "pause this" into "resume this".
  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
    return { ok: false, message: 'Enabled must be true or false.' }
  }

  const input: JobInput = {
    name,
    cron,
    url,
    method,
    headers,
    body,
    timeout_ms: Math.round(timeout),
    enabled: source.enabled === undefined ? true : source.enabled,
    notes,
  }

  const missing = missingRefs(input, env)
  if (missing.length > 0) {
    return {
      ok: false,
      message: `No secret is set for ${missing.join(', ')}. Add it with \`wrangler secret put ${missing[0]}\` and redeploy.`,
      missing,
    }
  }

  // Checked on the URL as it will be sent, not on `checkUrl`'s probe: a secret
  // containing `@` or `/` changes which host it resolves to.
  const allowlist = parseAllowlist(env.ALLOWED_HOSTS)
  if (allowlist.state !== 'unrestricted') {
    let resolved: URL
    try {
      resolved = new URL(interpolate(url, env))
    } catch {
      return { ok: false, message: 'The URL is not a valid absolute URL.' }
    }
    if (!urlAllowed(resolved, allowlist)) {
      // Named only when no reference could be hiding a secret in the host.
      const shown = refsIn(url).length === 0 ? `'${resolved.host}' is` : 'that URL resolves to a host that is'
      return {
        ok: false,
        message: `${shown} not in this deployment's allowed hosts: ${describeAllowlist(allowlist)}.`,
      }
    }
  }

  if (body !== null && (method === 'GET' || method === 'HEAD')) {
    return { ok: false, message: `A ${method} request cannot carry a body.` }
  }

  return { ok: true, input }
}
