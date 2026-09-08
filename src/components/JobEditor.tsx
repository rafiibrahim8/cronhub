import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { CronPreview, HttpMethod, JobInput, JobWithHealth, TemplateCheck } from '../../shared/types'
import { BODYLESS_METHODS, HTTP_METHODS } from '../../shared/types'
import { ApiFailure, preview } from '../lib/api'
import { local, localZone, utcClock, utcDay } from '../lib/format'
import './jobeditor.css'

type HeaderRow = { name: string; value: string }

const toRows = (headers: Record<string, string>): HeaderRow[] => {
  const rows = Object.entries(headers).map(([name, value]) => ({ name, value }))
  return rows.length > 0 ? rows : [{ name: '', value: '' }]
}

const fromRows = (rows: HeaderRow[]): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const row of rows) if (row.name.trim() !== '') headers[row.name.trim()] = row.value
  return headers
}

/** Only names are loaded; values live in the Worker until dispatch. */
export default function JobEditor(props: {
  job: JobWithHealth | null
  secrets: string[]
  /** Hostnames this deployment permits. Empty means unrestricted. */
  allowedHosts: string[]
  onSave: (input: JobInput) => Promise<void>
  onDelete: (() => Promise<void>) | null
  onClose: () => void
}) {
  const job = props.job

  const [name, setName] = createSignal(job?.name ?? '')
  const [cron, setCron] = createSignal(job?.cron ?? '0 3 * * *')
  const [method, setMethod] = createSignal<HttpMethod>(job?.method ?? 'POST')
  const [url, setUrl] = createSignal(job?.url ?? '')
  const [rows, setRows] = createSignal<HeaderRow[]>(toRows(job?.headers ?? {}))
  const [body, setBody] = createSignal(job?.body ?? '')
  const [timeout, setTimeout_] = createSignal(job?.timeout_ms ?? 10_000)
  const [notes, setNotes] = createSignal(job?.notes ?? '')

  const [cronInfo, setCronInfo] = createSignal<CronPreview | null>(null)
  const [template, setTemplate] = createSignal<TemplateCheck | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)

  /** Where an inserted secret reference lands. */
  let lastFocused: HTMLInputElement | HTMLTextAreaElement | null = null
  const remember = (event: FocusEvent) => {
    lastFocused = event.currentTarget as HTMLInputElement | HTMLTextAreaElement
  }

  const bodyAllowed = () => !BODYLESS_METHODS.includes(method())

  const draft = (): JobInput => ({
    name: name().trim(),
    cron: cron().trim(),
    url: url().trim(),
    method: method(),
    headers: fromRows(rows()),
    body: bodyAllowed() && body() !== '' ? body() : null,
    timeout_ms: Number(timeout()),
    enabled: job?.enabled ?? true,
    notes: notes().trim() === '' ? null : notes().trim(),
  })

  // One debounced round trip: does the schedule parse, and do its refs exist.
  let pending: ReturnType<typeof window.setTimeout> | undefined
  const check = () => {
    window.clearTimeout(pending)
    pending = window.setTimeout(() => {
      const current = draft()
      void preview({ cron: current.cron, url: current.url, headers: current.headers, body: current.body })
        .then((result) => {
          setCronInfo(result.cron)
          setTemplate(result.template)
        })
        .catch(() => undefined)
    }, 250)
  }
  onMount(check)
  onCleanup(() => window.clearTimeout(pending))

  const insertSecret = (secretName: string) => {
    const reference = '${' + secretName + '}'
    const target = lastFocused
    if (!target) {
      void navigator.clipboard?.writeText(reference)
      return
    }
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    const next = target.value.slice(0, start) + reference + target.value.slice(end)

    // Signals are the source of truth, so route the edit through them.
    if (target.dataset.field === 'url') setUrl(next)
    else if (target.dataset.field === 'body') setBody(next)
    else if (target.dataset.field?.startsWith('header-')) {
      const index = Number(target.dataset.field.slice('header-'.length))
      setRows(rows().map((row, i) => (i === index ? { ...row, value: next } : row)))
    } else return

    check()
    requestAnimationFrame(() => {
      target.focus()
      target.setSelectionRange(start + reference.length, start + reference.length)
    })
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.onSave(draft())
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Could not save the job.')
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!props.onDelete) return
    setBusy(true)
    try {
      await props.onDelete()
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : 'Could not delete the job.')
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose()
  }
  onMount(() => document.addEventListener('keydown', onKeyDown))
  onCleanup(() => document.removeEventListener('keydown', onKeyDown))

  const missing = createMemo(() => template()?.missing ?? [])
  const used = createMemo(() => new Set(template()?.refs ?? []))

  return (
    <div class="drawer-scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside class="drawer" role="dialog" aria-label={job ? `Edit ${job.name}` : 'New job'}>
        <form class="editor" onSubmit={save}>
          <header class="editor-head">
            <h2 class="editor-title">{job ? 'Edit job' : 'New job'}</h2>
            <button type="button" class="button button-quiet" onClick={props.onClose}>
              Close
            </button>
          </header>

          <div class="editor-body">
            <label class="field">
              <span class="field-label">Name</span>
              <input
                class="input mono"
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                placeholder="daily-build"
                required
                autofocus={!job}
              />
            </label>

            <label class="field">
              <span class="field-label">Schedule</span>
              <input
                class="input mono input-cron"
                value={cron()}
                onInput={(event) => {
                  setCron(event.currentTarget.value)
                  check()
                }}
                placeholder="45 1 * * *"
                spellcheck={false}
                required
              />
              <span class="field-hint">
                <span class="hint-cols mono">min hour dom mon dow</span>
                <span>Always UTC.</span>
              </span>
              <Show when={cronInfo()}>
                {(info) => (
                  <Show
                    when={info().valid}
                    fallback={<p class="field-error">{info().message}</p>}
                  >
                    <ul class="preview">
                      <For each={info().next}>
                        {(at) => (
                          <li>
                            <span class="mono preview-day">{utcDay(at)}</span>
                            <span class="mono preview-time">{utcClock(at)}</span>
                            <span class="preview-local">
                              {local(at)} {localZone}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                )}
              </Show>
            </label>

            <div class="field field-request">
              <span class="field-label">Request</span>
              <div class="request-line">
                <select
                  class="input select mono"
                  value={method()}
                  onChange={(event) => setMethod(event.currentTarget.value as HttpMethod)}
                >
                  <For each={HTTP_METHODS}>{(option) => <option value={option}>{option}</option>}</For>
                </select>
                <input
                  class="input mono"
                  data-field="url"
                  value={url()}
                  onFocus={remember}
                  onInput={(event) => {
                    setUrl(event.currentTarget.value)
                    check()
                  }}
                  placeholder="https://api.github.com/repos/owner/repo/actions/workflows/build.yml/dispatches"
                  spellcheck={false}
                  required
                />
              </div>
              <Show when={props.allowedHosts.length > 0}>
                <span class="field-hint">
                  <span>Allowed hosts:</span>
                  <span class="mono hint-hosts">{props.allowedHosts.join('  ')}</span>
                </span>
              </Show>
            </div>

            <div class="field">
              <span class="field-label">Headers</span>
              <div class="headers">
                <For each={rows()}>
                  {(row, index) => (
                    <div class="header-row">
                      <input
                        class="input mono"
                        value={row.name}
                        onInput={(event) =>
                          setRows(rows().map((r, i) => (i === index() ? { ...r, name: event.currentTarget.value } : r)))
                        }
                        placeholder="authorization"
                        spellcheck={false}
                      />
                      <input
                        class="input mono"
                        data-field={`header-${index()}`}
                        value={row.value}
                        onFocus={remember}
                        onInput={(event) => {
                          setRows(rows().map((r, i) => (i === index() ? { ...r, value: event.currentTarget.value } : r)))
                          check()
                        }}
                        placeholder="Bearer ${CRONHUB_GH_TOKEN}"
                        spellcheck={false}
                      />
                      <button
                        type="button"
                        class="button button-quiet"
                        onClick={() => setRows(rows().filter((_, i) => i !== index()))}
                        aria-label={`Remove the ${row.name || 'empty'} header`}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <button
                type="button"
                class="button button-quiet add-header"
                onClick={() => setRows([...rows(), { name: '', value: '' }])}
              >
                Add header
              </button>
            </div>

            <Show when={bodyAllowed()}>
              <label class="field">
                <span class="field-label">Body</span>
                <textarea
                  class="input mono textarea"
                  data-field="body"
                  value={body()}
                  onFocus={remember}
                  onInput={(event) => {
                    setBody(event.currentTarget.value)
                    check()
                  }}
                  rows="4"
                  placeholder={'{"ref":"main"}'}
                  spellcheck={false}
                />
              </label>
            </Show>

            <div class="field-pair">
              <label class="field">
                <span class="field-label">Timeout</span>
                <input
                  class="input mono"
                  type="number"
                  min="1000"
                  max="30000"
                  step="500"
                  value={timeout()}
                  onInput={(event) => setTimeout_(Number(event.currentTarget.value))}
                />
                <span class="field-hint">1000–30000 ms</span>
              </label>

              <label class="field">
                <span class="field-label">Note</span>
                <input
                  class="input"
                  value={notes()}
                  onInput={(event) => setNotes(event.currentTarget.value)}
                  placeholder="What this triggers, and why"
                />
              </label>
            </div>

            <section class="secrets">
              <h3 class="field-label">Secrets</h3>
              <Show
                when={props.secrets.length > 0}
                fallback={
                  <p class="secrets-empty">
                    No job secrets are set. Add one with{' '}
                    <code class="mono">wrangler secret put CRONHUB_MY_TOKEN</code> and redeploy — every{' '}
                    <code class="mono">CRONHUB_</code> binding shows up here automatically.
                  </p>
                }
              >
                <p class="secrets-copy">
                  Click one to drop its reference into the last field you were editing. Values stay in the
                  Worker and are filled in when the request is sent.
                </p>
                <ul class="secret-list">
                  <For each={props.secrets}>
                    {(secretName) => (
                      <li>
                        <button
                          type="button"
                          class="secret mono"
                          data-used={used().has(secretName)}
                          onClick={() => insertSecret(secretName)}
                        >
                          {secretName}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={missing().length > 0}>
                <p class="field-error">
                  No secret is set for {missing().join(', ')}. This job cannot run until it exists.
                </p>
              </Show>
            </section>
          </div>

          <footer class="editor-foot">
            <Show when={error()}>
              <p class="field-error editor-error" role="alert">
                {error()}
              </p>
            </Show>
            <div class="editor-actions">
              <Show when={props.onDelete}>
                <Show
                  when={confirming()}
                  fallback={
                    <button type="button" class="button button-quiet button-danger" onClick={() => setConfirming(true)}>
                      Delete
                    </button>
                  }
                >
                  <span class="confirm">
                    <span>Delete {job?.name} and its run history?</span>
                    <button type="button" class="button button-danger" onClick={() => void remove()} disabled={busy()}>
                      Delete job
                    </button>
                    <button type="button" class="button button-quiet" onClick={() => setConfirming(false)}>
                      Keep it
                    </button>
                  </span>
                </Show>
              </Show>
              <span class="editor-spacer" />
              <button type="submit" class="button" disabled={busy() || missing().length > 0}>
                {busy() ? 'Saving' : job ? 'Save changes' : 'Create job'}
              </button>
            </div>
          </footer>
        </form>
      </aside>
    </div>
  )
}
