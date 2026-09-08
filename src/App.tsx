import { createResource, Show } from 'solid-js'
import Dashboard from './routes/Dashboard'
import Login from './routes/Login'
import { getSession, logout, type Session } from './lib/api'
import './app.css'

export default function App() {
  // The session cookie is HttpOnly, so only the server can tell us.
  const [session, { refetch, mutate }] = createResource(() => getSession())

  // Reading an errored resource rethrows in Solid, so check the error first.
  const state = (): Session | undefined => (session.error ? undefined : session())

  const signOut = async () => {
    await logout().catch(() => undefined)
    mutate({ authenticated: false, configured: true })
  }

  const expire = () => mutate({ authenticated: false, configured: true })

  return (
    <>
      <Show when={session.loading}>
        <div class="boot" role="status" aria-label="Starting" />
      </Show>

      <Show when={session.error}>
        <main class="stall">
          <h1 class="stall-title">Cannot reach the server</h1>
          <p class="stall-copy">The dashboard is up but /api is not answering.</p>
          <button type="button" class="button" onClick={() => void refetch()}>
            Try again
          </button>
        </main>
      </Show>

      <Show when={state()}>
        {(current) => (
          <Show
            when={current().configured}
            fallback={
              <main class="stall">
                <h1 class="stall-title">Not set up yet</h1>
                <p class="stall-copy">
                  This deployment is missing <code class="mono">APP_USERNAME</code>,{' '}
                  <code class="mono">APP_PASSWORD</code> or <code class="mono">AUTH_SECRET</code>. Set all
                  three with <code class="mono">wrangler secret put</code>, then reload.
                </p>
              </main>
            }
          >
            <Show when={current().authenticated} fallback={<Login onDone={refetch} />}>
              <Dashboard onSignOut={signOut} onExpired={expire} />
            </Show>
          </Show>
        )}
      </Show>
    </>
  )
}
