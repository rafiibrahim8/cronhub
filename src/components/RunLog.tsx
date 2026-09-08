import { For, Show, createSignal } from 'solid-js'
import type { Run } from '../lib/api'
import { duration, relative, utc } from '../lib/format'
import './runlog.css'

/**
 * Module-level, not component state: a row is rebuilt whenever that job's last
 * run changes, and DOM-held openness closed under you while you were reading.
 * Run ids are immutable, so this survives any number of rebuilds.
 */
const [openSnippets, setOpenSnippets] = createSignal<ReadonlySet<number>>(new Set())

const setOpen = (runId: number, open: boolean) => {
  const next = new Set(openSnippets())
  if (open) next.add(runId)
  else next.delete(runId)
  setOpenSnippets(next)
}

/** The only place a failure surfaces. Snippets arrive redacted from the Worker. */
export default function RunLog(props: {
  runs: Run[]
  now: number

  jobName?: (jobId: string) => string
  empty: string
}) {
  return (
    <Show
      when={props.runs.length > 0}
      fallback={<p class="runlog-empty">{props.empty}</p>}
    >
      <ol class="runlog">
        <For each={props.runs}>
          {(run) => (
            <li class="run" data-ok={run.ok}>
              <span class="run-mark" aria-hidden="true" />
              <div class="run-detail">
                <div class="run-meta">
                  <span class="run-outcome">
                    <span class="run-verdict">{run.ok ? 'ok' : 'failed'}</span>
                    <Show when={run.status !== null}>
                      <span class="run-code num">{run.status}</span>
                    </Show>
                    <Show when={run.duration_ms !== null}>
                      <span class="run-took num">({duration(run.duration_ms)})</span>
                    </Show>
                  </span>
                  <Show when={props.jobName}>
                    {(name) => <span class="run-job">{name()(run.job_id)}</span>}
                  </Show>
                  <span class="run-time num" title={utc(run.started_at)}>
                    {relative(run.started_at, props.now)}
                  </span>
                  <Show when={run.trigger === 'manual'}>
                    <span class="run-manual">ran by hand</span>
                  </Show>
                </div>
                <Show when={run.error}>
                  <p class="run-error">{run.error}</p>
                </Show>
                <Show when={run.response_snip}>
                  <details
                    class="run-body"
                    open={openSnippets().has(run.id)}
                    onToggle={(event) => setOpen(run.id, event.currentTarget.open)}
                  >
                    <summary>Response</summary>
                    <pre class="mono">{run.response_snip}</pre>
                  </details>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
    </Show>
  )
}
