import { For, Show, createSignal } from 'solid-js'
import type { JobWithHealth, Run } from '../lib/api'
import { cronFields, duration, relative, utc } from '../lib/format'
import RunLog from './RunLog'
import './jobtable.css'

/**
 * The five cron fields keep aligned columns down the whole table, so the left
 * edge reads as the crontab it is and the heading names each field.
 */
export default function JobTable(props: {
  jobs: JobWithHealth[]
  now: number
  runsFor: (jobId: string) => Run[] | undefined
  onExpand: (jobId: string | null) => void
  onEdit: (job: JobWithHealth) => void
  onRun: (job: JobWithHealth) => void
  onToggle: (job: JobWithHealth, enabled: boolean) => void
  busyId: string | null
}) {
  const [open, setOpen] = createSignal<string | null>(null)

  const toggleOpen = (id: string) => {
    const next = open() === id ? null : id
    setOpen(next)
    props.onExpand(next)
  }

  return (
    <div class="table" role="table">
      <div class="row row-head" role="row">
        <span class="cell-f" role="columnheader">min</span>
        <span class="cell-f" role="columnheader">hour</span>
        <span class="cell-f" role="columnheader">dom</span>
        <span class="cell-f" role="columnheader">mon</span>
        <span class="cell-f" role="columnheader">dow</span>
        <span class="cell-job" role="columnheader">Job</span>
        <span role="columnheader">Last run</span>
        <span class="cell-r" role="columnheader">Next</span>
        <span role="columnheader"><span class="sr">Actions</span></span>
      </div>

      <For each={props.jobs}>
        {(job) => {
          const fields = () => cronFields(job.cron)
          const last = () => job.last_run
          const verdict = () => (job.last_run === null ? 'none' : job.last_run.ok ? 'ok' : 'failed')

          return (
            <>
              <div
                class="row row-job"
                role="row"
                data-verdict={verdict()}
                data-stale={job.stale}
                data-off={!job.enabled}
                data-open={open() === job.id}
              >
                <For each={fields()}>{(field) => <span class="cell-f mono">{field}</span>}</For>
                {/* For the narrow layout, where five columns cannot hold. */}
                <span class="cell-cron mono">{job.cron}</span>

                <button
                  type="button"
                  class="cell-job cell-name"
                  role="cell"
                  onClick={() => toggleOpen(job.id)}
                  aria-expanded={open() === job.id}
                >
                  <span class="name mono">{job.name}</span>
                  <Show when={!job.enabled}>
                    <span class="tag tag-paused">paused</span>
                  </Show>
                  <Show when={job.stale}>
                    <span class="tag tag-stale">overdue</span>
                  </Show>
                  <Show when={job.notes}>
                    <span class="note">{job.notes}</span>
                  </Show>
                </button>

                <span class="cell-last" role="cell">
                  <Show when={last()} fallback={<span class="muted">not run yet</span>}>
                    {(run) => (
                      <>
                        <span class="outcome">
                          <span class="verdict">{run().ok ? 'ok' : 'failed'}</span>
                          <Show when={run().duration_ms !== null}>
                            <span class="took num">({duration(run().duration_ms)})</span>
                          </Show>
                        </span>
                        <span class="num when" title={utc(run().started_at)}>
                          {relative(run().started_at, props.now)}
                        </span>
                      </>
                    )}
                  </Show>
                </span>

                <span class="cell-r num next" role="cell">
                  <Show when={job.enabled && job.next_run !== null} fallback={<span class="muted">—</span>}>
                    <span title={utc(job.next_run as number)}>{relative(job.next_run as number, props.now)}</span>
                  </Show>
                </span>

                <span class="cell-actions" role="cell">
                  <button
                    type="button"
                    class="button button-quiet"
                    onClick={() => props.onRun(job)}
                    disabled={props.busyId === job.id}
                  >
                    {props.busyId === job.id ? 'Running' : 'Run now'}
                  </button>
                  <button type="button" class="button button-quiet" onClick={() => props.onEdit(job)}>
                    Edit
                  </button>
                  <label class="switch">
                    <input
                      type="checkbox"
                      checked={job.enabled}
                      onChange={(event) => props.onToggle(job, event.currentTarget.checked)}
                    />
                    <span class="sr">{job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`}</span>
                  </label>
                </span>
              </div>

              <Show when={open() === job.id}>
                <div class="row-detail">
                  <div class="detail-meta">
                    <span class="mono detail-url">
                      {job.method} {job.url}
                    </span>
                    <Show when={job.next_run !== null}>
                      <span class="muted">
                        next {utc(job.next_run as number)}
                      </span>
                    </Show>
                  </div>
                  <Show
                    when={props.runsFor(job.id)}
                    fallback={<p class="runlog-empty">Loading runs…</p>}
                  >
                    {(runs) => (
                      <RunLog
                        runs={runs()}
                        now={props.now}
                        empty="No runs recorded yet. Run it now, or wait for the next matching minute."
                      />
                    )}
                  </Show>
                </div>
              </Show>
            </>
          )
        }}
      </For>
    </div>
  )
}
