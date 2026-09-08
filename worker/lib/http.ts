import type { ApiError } from '../../shared/types'

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
  headers.set('x-robots-tag', 'noindex, nofollow')
  return new Response(JSON.stringify(data), { ...init, headers })
}

export function fail(status: number, error: string, message: string, extra?: Partial<ApiError>): Response {
  return json({ error, message, ...extra } satisfies ApiError, { status })
}

export const badRequest = (message: string, extra?: Partial<ApiError>) => fail(400, 'bad_request', message, extra)
export const notFound = (message = 'Not found.') => fail(404, 'not_found', message)
