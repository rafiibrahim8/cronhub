import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import type { JobInput, JobWithHealth, Run } from '../../shared/types'
import JobEditor from '../components/JobEditor'
import JobTable from '../components/JobTable'
import RunLog from '../components/RunLog'
import Help from './Help'
import { ApiFailure, createJob, deleteJob, getConfig, getJobs, getRuns, getSecretNames, patchJob, runJob } from '../lib/api'
import './dashboard.css'


const POLL_MS = 30_000

type Editing = { job: JobWithHealth | null } | null

/** Two fetches with the same signature are indistinguishable on screen. */
const signature = (job: JobWithHealth) =>
  [
    job.id,
    job.updated_at,
    job.enabled,
    job.stale,
    job.next_run,
    job.last_run?.id,
    job.last_run?.ok,
    job.last_run?.status,
    job.last_run?.duration_ms,
  ].join('|')

/** Exact, not heuristic: a run is written once, so a known id is the same run. */
function mergeRuns(previous: Run[] | undefined, next: Run[]): Run[] {
  if (!previous) return next
  const byId = new Map(previous.map((run) => [run.id, run]))
  return next.map((run) => byId.get(run.id) ?? run)
}

/**
 * `<For>` reconciles on item identity and every poll returns fresh objects, so
 * without this each row is rebuilt twice a minute.
 */
function reuseUnchanged(previous: JobWithHealth[] | undefined, next: JobWithHealth[]): JobWithHealth[] {
  if (!previous) return next
  const byId = new Map(previous.map((job) => [job.id, job]))
  return next.map((job) => {
    const old = byId.get(job.id)
    return old && signature(old) === signature(job) ? old : job
  })
}

export default function Dashboard(props: { onSignOut: () => void; onExpired: () => void }) {
  const [now, setNow] = createSignal(Date.now())
  const [view, setView] = createSignal<'jobs' | 'failures' | 'help'>('jobs')
  const [editing, setEditing] = createSignal<Editing>(null)
  const [runsByJob, setRunsByJob] = createSignal<Record<string, Run[]>>({})
  const [busyId, setBusyId] = createSignal<string | null>(null)
  const [expandedId, setExpandedId] = createSignal<string | null>(null)
  const [flash, setFlash] = createSignal<string | null>(null)

  let known: JobWithHealth[] | undefined
  const [jobs, { refetch: refetchJobs, mutate: mutateJobs }] = createResource(async () => {
    known = reuseUnchanged(known, await getJobs())
    return known
  })
  const [secrets] = createResource(() => getSecretNames())
  const [config] = createResource(() => getConfig())
  const [failures, { refetch: refetchFailures }] = createResource(
    () => (view() === 'failures' ? 'failures' : undefined),
    () => getRuns({ failedOnly: true, limit: 100 }),
  )

  // The cookie expired while the tab sat open; hand back to the login gate.
  const guard = (cause: unknown) => {
    if (cause instanceof ApiFailure && cause.status === 401) props.onExpired()
    return cause
  }

  // A poll begun before a mutation resolves after it and writes the old row
  // back, flipping the switch under the cursor.
  const [pending, setPending] = createSignal(0)
  const during = async <T,>(work: () => Promise<T>): Promise<T> => {
    setPending(pending() + 1)
    try {
      return await work()
    } finally {
      setPending(pending() - 1)
    }
  }

  const tick = () => {
    setNow(Date.now())
    if (pending() === 0) void refetchJobs()
    if (view() === 'failures') void refetchFailures()
    const open = expandedId()
    if (open) void loadRuns(open)
  }

  onMount(() => {
    const timer = window.setInterval(tick, POLL_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  const list = (): JobWithHealth[] => (jobs.error ? [] : (jobs() ?? []))

  const counts = createMemo(() => {
    const all = list()
    return {
      total: all.length,
      failing: all.filter((job) => job.last_run !== null && !job.last_run.ok).length,
      overdue: all.filter((job) => job.stale).length,
      paused: all.filter((job) => !job.enabled).length,
    }
  })

  const jobName = (id: string) => list().find((job) => job.id === id)?.name ?? 'deleted job'

  const loadRuns = async (jobId: string) => {
    try {
      const runs = await getRuns({ jobId, limit: 20 })
      setRunsByJob({ ...runsByJob(), [jobId]: mergeRuns(runsByJob()[jobId], runs) })
    } catch (cause) {
      guard(cause)
    }
  }

  const onExpand = (jobId: string | null) => {
    setExpandedId(jobId)
    if (jobId) void loadRuns(jobId)
  }

  const announce = (message: string) => {
    setFlash(message)
    window.setTimeout(() => setFlash((current) => (current === message ? null : current)), 6000)
  }

  const onRun = async (job: JobWithHealth) => {
    setBusyId(job.id)
    try {
      const run = await runJob(job.id)
      announce(
        run.ok
          ? `Ran ${job.name} — HTTP ${run.status}`
          : `${job.name} failed — ${run.error ?? `HTTP ${run.status}`}`,
      )
      setRunsByJob({ ...runsByJob(), [job.id]: [run, ...(runsByJob()[job.id] ?? [])] })
      void refetchJobs()
    } catch (cause) {
      guard(cause)
      announce(`Could not run ${job.name}.`)
    } finally {
      setBusyId(null)
    }
  }

  const onToggle = async (job: JobWithHealth, enabled: boolean) => {
    // Optimistic: the switch should not lag the finger.
    known = list().map((each) => (each.id === job.id ? { ...each, enabled } : each))
    mutateJobs(known)
    try {
      await during(() => patchJob(job.id, { enabled }))
    } catch (cause) {
      guard(cause)
      announce(`Could not ${enabled ? 'resume' : 'pause'} ${job.name}.`)
    }
    void refetchJobs()
  }

  const onSave = async (input: JobInput) => {
    const target = editing()?.job ?? null
    if (target) await during(() => patchJob(target.id, input))
    else await during(() => createJob(input))
    setEditing(null)
    announce(target ? `Saved ${input.name}.` : `Created ${input.name}. It fires on the next matching minute.`)
    void refetchJobs()
  }

  const onDelete = async () => {
    const target = editing()?.job
    if (!target) return
    await during(() => deleteJob(target.id))
    const { [target.id]: _gone, ...rest } = runsByJob()
    setRunsByJob(rest)
    setEditing(null)
    announce(`Deleted ${target.name}.`)
    void refetchJobs()
  }

  return (
    <div class="shell">
      <header class="bar">
        <h1 class="brand mono">cronhub</h1>

        <div class="tally">
          <span>
            <span class="num">{counts().total}</span> {counts().total === 1 ? 'job' : 'jobs'}
          </span>
          <Show when={counts().failing > 0}>
            <span class="tally-fail">
              <span class="num">{counts().failing}</span> failing
            </span>
          </Show>
          <Show when={counts().overdue > 0}>
            <span class="tally-stale">
              <span class="num">{counts().overdue}</span> overdue
            </span>
          </Show>
          <Show when={counts().paused > 0}>
            <span class="tally-muted">
              <span class="num">{counts().paused}</span> paused
            </span>
          </Show>
        </div>

        <nav class="views">
          <button type="button" class="view" data-on={view() === 'jobs'} onClick={() => setView('jobs')}>
            Jobs
          </button>
          <button
            type="button"
            class="view"
            data-on={view() === 'failures'}
            onClick={() => {
              setView('failures')
              void refetchFailures()
            }}
          >
            Failures
          </button>
          <button type="button" class="view" data-on={view() === 'help'} onClick={() => setView('help')}>
            Help
          </button>
        </nav>

        <div class="bar-actions">
          <button type="button" class="button" onClick={() => setEditing({ job: null })}>
            New job
          </button>
          <button type="button" class="button button-quiet" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <Show when={config()?.allowed_hosts_state === 'invalid'}>
        <p class="misconfig" role="alert">
          ALLOWED_HOSTS is set but lists no hostnames, so every job is being refused before it is
          sent. See Help.
        </p>
      </Show>

      <Show when={flash()}>
        <p class="flash" role="status">
          {flash()}
        </p>
      </Show>

      <main class="main">
        <Show when={jobs.error && view() !== 'help'}>
          <p class="field-error load-error">
            The job list did not load.{' '}
            <button type="button" class="button button-quiet" onClick={() => void refetchJobs()}>
              Try again
            </button>
          </p>
        </Show>

        <Show when={view() === 'jobs'}>
          <Show
            when={list().length > 0}
            fallback={
              <Show when={!jobs.loading && !jobs.error}>
                <div class="empty">
                  <h2 class="empty-title">Nothing scheduled yet</h2>
                  <p class="empty-copy">
                    Add a job and the heartbeat picks it up on the next matching minute — no deploy needed.
                    Reference a token in the URL, a header or the body as{' '}
                    <code class="mono">${'{CRONHUB_NAME}'}</code> and it is filled in when the request is sent.
                  </p>
                  <button type="button" class="button" onClick={() => setEditing({ job: null })}>
                    New job
                  </button>
                </div>
              </Show>
            }
          >
            <JobTable
              jobs={list()}
              now={now()}
              runsFor={(jobId) => runsByJob()[jobId]}
              onExpand={onExpand}
              onEdit={(job) => setEditing({ job })}
              onRun={(job) => void onRun(job)}
              onToggle={(job, enabled) => void onToggle(job, enabled)}
              busyId={busyId()}
            />
          </Show>
        </Show>

        <Show when={view() === 'failures'}>
          <section class="failures">
            <p class="failures-copy">
              Every failed dispatch from the last 14 days. A job that stopped firing altogether shows as
              overdue in the job list instead — there is no failed request to record when the request was
              never made.
            </p>
            <Show when={!failures.loading || failures()}>
              <RunLog
                runs={failures() ?? []}
                now={now()}
                jobName={jobName}
                empty="No failures recorded. Every dispatch in the retention window succeeded."
              />
            </Show>
          </section>
        </Show>

        <Show when={view() === 'help'}>
          <Help config={config.error ? undefined : config()} />
        </Show>
      </main>

      <Show when={editing()}>
        {(current) => (
          <JobEditor
            job={current().job}
            secrets={secrets() ?? []}
            allowedHosts={config()?.allowed_hosts ?? []}
            onSave={onSave}
            onDelete={current().job ? onDelete : null}
            onClose={() => setEditing(null)}
          />
        )}
      </Show>

      <footer class="foot">
        <span>Times are UTC.</span>
      </footer>
    </div>
  )
}
