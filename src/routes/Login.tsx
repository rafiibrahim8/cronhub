import { createSignal, Show } from 'solid-js'
import { ApiFailure, login } from '../lib/api'
import './login.css'

export default function Login(props: { onDone: () => void }) {
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const ready = () => username().trim() !== '' && password() !== ''

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || !ready()) return
    setBusy(true)
    setError(null)
    try {
      await login(username().trim(), password())
      props.onDone()
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Could not sign in.')
      setBusy(false)
    }
  }

  return (
    <main class="gate">
      <form class="gate-form" onSubmit={submit}>
        <h1 class="gate-title mono">cronhub</h1>

        <label class="gate-label" for="username">
          Username
        </label>
        <input
          id="username"
          class="gate-field mono"
          type="text"
          value={username()}
          onInput={(event) => setUsername(event.currentTarget.value)}
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          autofocus
          required
        />

        <label class="gate-label" for="password">
          Password
        </label>
        <input
          id="password"
          class="gate-field gate-field-secret mono"
          type="password"
          value={password()}
          onInput={(event) => setPassword(event.currentTarget.value)}
          autocomplete="current-password"
          required
        />

        <Show when={error()}>
          <p class="gate-error" role="alert">
            {error()}
          </p>
        </Show>

        <button type="submit" class="button gate-go" disabled={busy() || !ready()}>
          {busy() ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
