/**
 * The `CRONHUB_` prefix is the security boundary: prefixed bindings are secrets
 * a job may reference, unprefixed ones are platform config a job cannot see or
 * name. Nothing here returns a value to a caller.
 */

export const SECRET_PREFIX = 'CRONHUB_'

/** Uppercase-only, so a typo fails at save time rather than being sent. */
const REFERENCE = /\$\{(CRONHUB_[A-Z0-9_]+)\}/g

/** Below this, a match proves nothing and shreds unrelated text. */
const MIN_REDACTABLE = 6

export class MissingSecretError extends Error {
  constructor(public readonly names: string[]) {
    super(`no such secret: ${names.join(', ')}`)
  }
}

type SecretBag = Record<string, unknown>

/** The only secret-derived value any API route may return. */
export function listSecretNames(env: SecretBag): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(SECRET_PREFIX) && typeof env[key] === 'string' && env[key] !== '')
    .sort()
}

/** Distinct references, in first-seen order. */
export function refsIn(template: string | null | undefined): string[] {
  if (!template) return []
  const seen = new Set<string>()
  for (const match of template.matchAll(REFERENCE)) seen.add(match[1])
  return [...seen]
}


export function refsInJob(job: { url: string; headers: Record<string, string>; body?: string | null }): string[] {
  const seen = new Set<string>()
  for (const ref of refsIn(job.url)) seen.add(ref)
  for (const value of Object.values(job.headers)) for (const ref of refsIn(value)) seen.add(ref)
  for (const ref of refsIn(job.body)) seen.add(ref)
  return [...seen]
}

/** Empty means every reference resolves. */
export function missingRefs(job: { url: string; headers: Record<string, string>; body?: string | null }, env: SecretBag): string[] {
  const known = new Set(listSecretNames(env))
  return refsInJob(job).filter((ref) => !known.has(ref))
}

/** Only called on the dispatch path, moments before the outbound fetch. */
export function interpolate(template: string, env: SecretBag): string {
  const missing: string[] = []
  const filled = template.replace(REFERENCE, (whole, name: string) => {
    const value = env[name]
    if (typeof value !== 'string' || value === '') {
      missing.push(name)
      return whole
    }
    return value
  })
  if (missing.length > 0) throw new MissingSecretError([...new Set(missing)])
  return filled
}

/** Stands in for a secret the job never referenced. */
const UNNAMED = '${REDACTED}'

/**
 * The raw bytes are not enough: a value containing a quote or a control
 * character comes back from any ordinary JSON API escaped, and one JSON.parse
 * recovers it. Alphanumeric tokens never trip this, which is why it hides.
 * Deliberate encoding still defeats it and always will.
 */
function needlesFor(value: string): string[] {
  const jsonEscaped = JSON.stringify(value).slice(1, -1)
  const html = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  let uri = value
  try {
    uri = encodeURIComponent(value)
  } catch {
    // Lone surrogates throw; the raw form still applies.
  }
  return [...new Set([value, jsonEscaped, html, uri])].filter((needle) => needle.length >= MIN_REDACTABLE)
}

export type Redaction = { needles: Array<[string, string]>; longestNeedle: number }

/**
 * Every secret is searched for, since one turning up unexpectedly is still a
 * live credential heading for the database. Only referenced ones are named:
 * anonymising the rest stops the rewrite identifying which secret an echoed
 * candidate matched. Longest needle first, so nested values redact whole.
 */
export function buildRedaction(env: SecretBag, referenced: readonly string[]): Redaction {
  const named = new Set(referenced)
  const needles: Array<[string, string]> = []

  for (const name of listSecretNames(env)) {
    const label = named.has(name) ? `\${${name}}` : UNNAMED
    for (const needle of needlesFor(env[name] as string)) needles.push([needle, label])
  }
  needles.sort((a, b) => b[0].length - a[0].length)

  const longestNeedle = needles.reduce((max, [needle]) => Math.max(max, needle.length), 0)
  // Cloudflare caps a variable at 5 KB; escaping can expand it, so allow room
  // for that without letting a pathological value dictate the read size.
  return { needles, longestNeedle: Math.min(longestNeedle, 16 * 1024) }
}

export function applyRedaction(text: string, redaction: Redaction): string {
  let out = text
  for (const [needle, label] of redaction.needles) out = out.replaceAll(needle, label)
  return out
}

/**
 * Drops a value the reader cut in half.
 *
 * A caller reading a bounded window can slice a value mid-way, and a partial is
 * not a needle, so redaction leaves it verbatim. It can only happen at the very
 * end of what was read, so a surviving remnant is whatever runs from some
 * offset to the end of the text and is a prefix of a needle. Found by its first
 * few characters and confirmed against the whole needle, which keeps this a
 * couple of `indexOf` calls rather than a scan of every length.
 *
 * Only for text that really was cut: in a complete response, a tail that
 * happens to match is the endpoint's own content.
 */
export function dropCutNeedle(text: string, redaction: Redaction): string {
  let start = -1
  for (const [needle] of redaction.needles) {
    if (needle.length <= MIN_REDACTABLE) continue
    const probe = needle.slice(0, MIN_REDACTABLE)
    for (let from = 0; ; ) {
      const at = text.indexOf(probe, from)
      if (at === -1) break
      if (needle.startsWith(text.slice(at))) {
        if (start === -1 || at < start) start = at
        break
      }
      from = at + 1
    }
  }
  return start === -1 ? text : text.slice(0, start)
}


export function redact(text: string, env: SecretBag, referenced: readonly string[] = []): string {
  return applyRedaction(text, buildRedaction(env, referenced))
}
