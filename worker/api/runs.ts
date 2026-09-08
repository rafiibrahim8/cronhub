import { listRuns } from '../lib/db'
import type { Env } from '../lib/env'
import { badRequest, json } from '../lib/http'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function list(url: URL, env: Env): Promise<Response> {
  const rawJobId = url.searchParams.get('job_id')

  // Present but empty is a caller bug: falling through to the unfiltered query
  // showed one job's runs under another job's heading.
  if (rawJobId !== null && rawJobId.trim() === '') {
    return badRequest('job_id was given but empty. Omit it to list runs for every job.')
  }
  const jobId = rawJobId?.trim() || undefined
  const failedOnly = url.searchParams.get('failed') === '1'

  const rawLimit = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (rawLimit !== null) {
    const parsed = Number(rawLimit)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return badRequest(`limit must be a whole number between 1 and ${MAX_LIMIT}.`)
    }
    limit = parsed
  }

  const runs = await listRuns(env.DB, { jobId, failedOnly, limit })
  return json({ runs })
}
