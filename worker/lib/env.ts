export interface Env {
  DB: D1Database
  ASSETS: Fetcher

  // Platform config. Unprefixed, so no job can read or reference any of it.
  APP_USERNAME?: string
  APP_PASSWORD?: string
  AUTH_SECRET?: string
  /** `github.com,*.example.com`; unset means unrestricted. See `lib/hosts.ts`. */
  ALLOWED_HOSTS?: string

  /**
   * Job secrets are `CRONHUB_*` bindings discovered at runtime, so they cannot
   * be named here. `unknown` keeps every read honest; `lib/secrets.ts` is the
   * only place that touches them.
   */
  [binding: string]: unknown
}
