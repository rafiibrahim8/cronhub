import { authenticate, login, logout, session } from './api/auth'
import * as jobs from './api/jobs'
import * as meta from './api/meta'
import * as runs from './api/runs'
import type { Env } from './lib/env'
import { fail, notFound } from './lib/http'

/** Reachable without a session, because they are how you get one. */
const OPEN = new Set(['/api/session', '/api/login'])

const methodNotAllowed = (allowed: string) =>
  fail(405, 'method_not_allowed', `Use ${allowed} on this endpoint.`)

/**
 * The CSRF defence for /api/login, which cannot rely on a cookie it is about to
 * issue: a cross-site form can send text/plain but not application/json.
 * Bodyless posts send no content-type and are unaffected.
 */
function bodyTypeAllowed(request: Request): boolean {
  const declared = request.headers.get('content-type')
  if (declared === null) return true
  return declared.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** Assets never reach the Worker; see `run_worker_first` in wrangler.jsonc. */
export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (!path.startsWith('/api')) return notFound()

  if (!bodyTypeAllowed(request)) {
    return fail(415, 'unsupported_media_type', 'Send a JSON body with content-type: application/json.')
  }

  if (!OPEN.has(path)) {
    if (!env.AUTH_SECRET) {
      return fail(500, 'not_configured', 'AUTH_SECRET is not set on this deployment.')
    }
    const claims = await authenticate(request, env)
    if (!claims) return fail(401, 'unauthorized', 'Sign in to manage jobs.')
  }

  switch (path) {
    case '/api/session':
      return request.method === 'GET' ? session(request, env) : methodNotAllowed('GET')

    case '/api/login':
      return request.method === 'POST' ? login(request, env) : methodNotAllowed('POST')

    case '/api/logout':
      return request.method === 'POST' ? logout() : methodNotAllowed('POST')

    case '/api/config':
      return request.method === 'GET' ? meta.config(env) : methodNotAllowed('GET')

    case '/api/secrets':
      return request.method === 'GET' ? meta.secrets(env) : methodNotAllowed('GET')

    case '/api/preview':
      return request.method === 'POST' ? meta.preview(request, env) : methodNotAllowed('POST')

    case '/api/runs':
      return request.method === 'GET' ? runs.list(url, env) : methodNotAllowed('GET')

    case '/api/jobs':
      if (request.method === 'GET') return jobs.list(env)
      if (request.method === 'POST') return jobs.create(request, env)
      return methodNotAllowed('GET or POST')
  }

  const runMatch = /^\/api\/jobs\/([0-9a-f-]{36})\/run$/.exec(path)
  if (runMatch) {
    return request.method === 'POST' ? jobs.runNow(env, runMatch[1]) : methodNotAllowed('POST')
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(path)
  if (jobMatch) {
    if (request.method === 'PATCH') return jobs.update(request, env, jobMatch[1])
    if (request.method === 'DELETE') return jobs.remove(env, jobMatch[1])
    return methodNotAllowed('PATCH or DELETE')
  }

  return notFound()
}
