/**
 * The outbound host allowlist: `ALLOWED_HOSTS=github.com,*.example.com`.
 * See the README for the matching rules and why it is checked twice.
 */

export type Allowlist =
  | { state: 'unrestricted' }
  | { state: 'invalid' }
  | { state: 'restricted'; patterns: string[] }

/**
 * Unset means unrestricted, so adding this to a live deployment cannot brick
 * it — but a value that was typed and yields no entry fails closed rather than
 * silently reverting to allow-all.
 */
export function parseAllowlist(raw: unknown): Allowlist {
  if (typeof raw !== 'string' || raw.trim() === '') return { state: 'unrestricted' }

  const patterns = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')

  if (patterns.length === 0) {
    // Length only: config has no business in a log pipeline.
    console.error(
      `ALLOWED_HOSTS is set (${raw.length} characters) but contains no hostnames. Refusing every host until it is fixed.`,
    )
    return { state: 'invalid' }
  }
  if (patterns.length === 1 && patterns[0] === '*') return { state: 'unrestricted' }

  return { state: 'restricted', patterns }
}

/** Lowercase, trailing root dot dropped. IDN arrives already punycoded. */
function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

/** Only a trailing `:digits` counts as a port, so IPv6 literals survive. */
function splitEntry(entry: string): { host: string; port: string | null } {
  const colon = entry.lastIndexOf(':')
  if (colon > 0 && /^[0-9]+$/.test(entry.slice(colon + 1))) {
    return { host: normalizeHost(entry.slice(0, colon)), port: entry.slice(colon + 1) }
  }
  return { host: normalizeHost(entry), port: null }
}

/** `*.example.com` matches beneath example.com but never the apex itself. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return host.length > suffix.length && host.endsWith(suffix)
  }
  return host === pattern
}

/** Includes protocol defaults, since that is the port it will dial. */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * Takes the parsed URL, never a string: `new URL()` decides where a request
 * actually goes, so anything else is a check on the wrong thing.
 */
export function urlAllowed(url: URL, list: Allowlist): boolean {
  if (list.state === 'unrestricted') return true
  if (list.state === 'invalid') return false
  const host = normalizeHost(url.hostname)
  if (host === '') return false
  const port = effectivePort(url)

  return list.patterns.some((entry) => {
    const { host: wanted, port: wantedPort } = splitEntry(entry)
    if (!hostMatches(wanted, host)) return false
    return wantedPort === null || wantedPort === port
  })
}

/** For error messages; null when unrestricted. */
export function describeAllowlist(list: Allowlist): string | null {
  if (list.state === 'restricted') return list.patterns.join(', ')
  if (list.state === 'invalid') return 'none — ALLOWED_HOSTS is set but contains no hostnames'
  return null
}
