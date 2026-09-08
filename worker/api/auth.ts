import type { Session } from '../../shared/types'
import { COOKIE, clearedCookie, issueToken, readCookie, safeEqual, sessionCookie, verifyToken } from '../lib/auth'
import type { Env } from '../lib/env'
import { fail, json } from '../lib/http'

/**
 * Every attempt takes this long, successful or not, so the response time says
 * nothing about which half was wrong. It is a sleep, not a limiter: concurrent
 * guessing is unbounded, so the password must be strong. Rate-limit
 * /api/login at the edge if this is anywhere hostile.
 */
const LOGIN_DELAY_MS = 1_000

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const configured = (env: Env) => Boolean(env.APP_USERNAME && env.APP_PASSWORD && env.AUTH_SECRET)

/** The cookie is HttpOnly, so the dashboard asks here on boot. */
export async function session(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return json({ authenticated: false, configured: false } satisfies Session)
  const token = readCookie(request, COOKIE)
  const claims = token ? await verifyToken(env.AUTH_SECRET as string, token) : null
  return json({ authenticated: Boolean(claims), configured: true } satisfies Session)
}

export async function login(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) {
    return fail(500, 'not_configured', 'APP_USERNAME, APP_PASSWORD and AUTH_SECRET are not set on this deployment.')
  }

  // Started before the work, awaited after it, so the time is constant.
  const settle = delay(LOGIN_DELAY_MS)

  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  // Both always compared, so the form cannot be used to discover the username.
  const [userOk, passOk] = await Promise.all([
    safeEqual(username, env.APP_USERNAME as string),
    safeEqual(password, env.APP_PASSWORD as string),
  ])

  if (!userOk || !passOk) {
    await settle
    return fail(401, 'bad_credentials', 'That username and password do not match.')
  }

  const token = await issueToken(env.AUTH_SECRET as string, username)
  await settle
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token) } })
}

export async function logout(): Promise<Response> {
  return json({ ok: true }, { headers: { 'set-cookie': clearedCookie() } })
}

export async function authenticate(request: Request, env: Env): Promise<{ sub: string } | null> {
  if (!env.AUTH_SECRET) return null
  const token = readCookie(request, COOKIE)
  if (!token) return null
  return verifyToken(env.AUTH_SECRET as string, token)
}
