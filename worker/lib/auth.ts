import { notJwtWeb } from 'not-jwt/web'

export const COOKIE = 'cronhub_auth'

/** Short, because this panel edits config that references live credentials. */
const SESSION_SECONDS = 60 * 60 * 24 * 30

type Claims = { sub: string; iat: number; exp: number }

const nowSeconds = () => Math.floor(Date.now() / 1000)

export async function issueToken(secret: string, username: string): Promise<string> {
  const signer = await notJwtWeb(secret)
  const claims: Claims = { sub: username, iat: nowSeconds(), exp: nowSeconds() + SESSION_SECONDS }
  return signer.sign(JSON.stringify(claims))
}

/** not-jwt checks integrity only, so the expiry must be checked here. */
export async function verifyToken(secret: string, token: string): Promise<Claims | null> {
  try {
    const signer = await notJwtWeb(secret)
    const claims = JSON.parse(await signer.verify(token)) as Partial<Claims>
    if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds()) return null
    if (typeof claims.sub !== 'string') return null
    return claims as Claims
  } catch {
    return null
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      // `cronhub_auth=%` throws. Returned undecoded so verification rejects it
      // as a bad token; throwing took out /api/session, the app's boot call,
      // leaving no way to reach the login form at all.
      return raw
    }
  }
  return null
}

export function sessionCookie(token: string): string {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`,
  ].join('; ')
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/** Constant-time: HMAC both under a throwaway key, diff the fixed digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const [left, right] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ])
  const x = new Uint8Array(left)
  const y = new Uint8Array(right)
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i]
  return diff === 0
}
