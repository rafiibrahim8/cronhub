import { route } from './router'
import type { Env } from './lib/env'
import { fail } from './lib/http'
import { tick } from './lib/tick'

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (cause) {
      console.error('unhandled error', cause)
      return fail(500, 'internal_error', 'Something went wrong. Check the Worker logs.')
    }
  },

  async scheduled(event, env): Promise<void> {
    await tick(event.scheduledTime, env)
  },
} satisfies ExportedHandler<Env>
