import { For, Show } from 'solid-js'
import type { Config } from '../../shared/types'
import { localZone } from '../lib/format'
import './help.css'

const SCHEDULE_EXAMPLES: Array<[string, string]> = [
  ['*/5 * * * *', 'every five minutes'],
  ['0 * * * *', 'on the hour'],
  ['45 1 * * *', 'every day at 01:45'],
  ['30 0 * * mon', 'Mondays at 00:30'],
  ['0 9-17 * * 1-5', 'hourly, 09:00 to 17:00, weekdays'],
  ['0 4 1,15 * *', 'the 1st and 15th at 04:00'],
  ['0 0 */2 * *', 'every second day — the 1st, 3rd, 5th and so on'],
]

/** Reads its numbers from /api/config so it cannot drift from what is enforced. */
export default function Help(props: { config: Config | undefined }) {
  const prefix = () => props.config?.secret_prefix ?? 'CRONHUB_'
  const hosts = () => props.config?.allowed_hosts ?? []

  return (
    <article class="manual">
      <section class="man-block">
        <h2 class="man-h">How it runs</h2>
        <p>
          One scheduled Worker wakes up every minute, reads the jobs below, works out which of them
          are due for that minute, and sends their requests. Adding or editing a job takes effect on
          the next minute — there is nothing to deploy and nothing to restart.
        </p>
        <p>
          Because the schedule lives in the database rather than in the Worker's configuration, this
          keeps running whether or not anyone touches the repositories it triggers. That is the whole
          reason it exists: GitHub switches off scheduled workflows after 60 days of repository
          inactivity.
        </p>
      </section>

      <section class="man-block">
        <h2 class="man-h">Writing a schedule</h2>
        <p>
          Five fields, separated by spaces, exactly as in a crontab — and <strong>always UTC</strong>,
          never your local time. Your clock is {localZone}; the editor shows both as you type, and
          every time in this dashboard is labelled Z.
        </p>
        <pre class="man-fields mono">
          {'┌── minute        0-59\n│ ┌── hour        0-23\n│ │ ┌── day        1-31\n│ │ │ ┌── month    1-12  or jan-dec\n│ │ │ │ ┌── weekday 0-7   or sun-sat (0 and 7 are both Sunday)\n│ │ │ │ │\n* * * * *'}
        </pre>
        <table class="man-table">
          <tbody>
            <For each={SCHEDULE_EXAMPLES}>
              {([expression, meaning]) => (
                <tr>
                  <td class="mono man-code">{expression}</td>
                  <td>{meaning}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p>
          Each field takes <code class="mono">*</code>, a number, a range (<code class="mono">9-17</code>),
          a step (<code class="mono">*/15</code>, <code class="mono">9-17/2</code>), a list
          (<code class="mono">1,15,30</code>), or names for months and weekdays. Set both a day and a
          weekday and the job fires when <em>either</em> matches, which is standard cron behaviour and
          usually not what people expect.
        </p>
        <p class="man-aside">
          Six-field expressions are refused rather than rounded: the heartbeat runs once a minute, so
          it cannot honour seconds. Timing is best-effort — a fire can land a few seconds late, and a
          minute the platform misses entirely is skipped rather than caught up afterwards.
        </p>
      </section>

      <section class="man-block">
        <h2 class="man-h">Secrets</h2>
        <p>
          Tokens are never stored with the job. They live in the Worker, and a job refers to one by
          name:
        </p>
        <pre class="man-pre mono">{`Authorization: Bearer \${${prefix()}GH_TOKEN}`}</pre>
        <p>
          The value is filled in the moment before the request goes out. You can use a reference in
          the URL, in any header value, and in the body. The editor lists every available name and
          drops the reference in at your cursor.
        </p>
        <p>Add one from a terminal — there is no way to create or read a secret from this page:</p>
        <pre class="man-pre mono">{`wrangler secret put ${prefix()}MY_TOKEN`}</pre>
        <p>
          Any variable whose name starts with <code class="mono">{prefix()}</code> shows up here
          automatically after a deploy. That prefix is the boundary: variables without it — the login
          password, the cookie signing key, the host allowlist — are invisible to this page and
          cannot be referenced by a job.
        </p>
        <p class="man-aside">
          Responses are stored with any secret they contain swapped back to a{' '}
          <code class="mono">{'${NAME}'}</code> reference, so a service that echoes your token back on
          error does not print it into the run log. The escaped forms a JSON or HTML response would
          use are covered too. This protects against accidents, not against a service you do not
          control — anything that already received a token could encode it past any such check. Point
          jobs at endpoints you trust.
        </p>
        <p class="man-aside">
          Using a secret as the <strong>hostname</strong> keeps it out of the job list, but not off
          the wire: it goes out as a DNS lookup and in the TLS handshake before any response exists.
          Reference a host to keep configuration tidy, never to keep a credential secret.
        </p>
      </section>

      <section class="man-block">
        <h2 class="man-h">Where jobs may point</h2>
        <Show when={props.config?.allowed_hosts_state === 'invalid'}>
          <p class="man-warn">
            <code class="mono">ALLOWED_HOSTS</code> is set on this deployment but contains no
            hostnames, so <strong>every host is refused</strong> and no job can send anything. Fix
            the value — a comma-separated list such as{' '}
            <code class="mono">github.com,*.example.com</code> — and redeploy. It fails this way
            rather than allowing everything, because a security setting that quietly stops applying
            is worse than one that stops working.
          </p>
        </Show>

        <Show
          when={hosts().length > 0}
          fallback={
            <Show when={props.config?.allowed_hosts_state !== 'invalid'}>
              <p>No allowlist is configured on this deployment, so a job may target any host.</p>
              <p class="man-aside">
                To restrict it, set <code class="mono">ALLOWED_HOSTS</code> to a comma-separated list
                — for example <code class="mono">github.com,*.example.com</code> — and redeploy.
                Existing jobs are re-checked when they run, not only when they are saved. A single{' '}
                <code class="mono">*</code> is the explicit way to say "no restriction".
              </p>
            </Show>
          }
        >
          <p>A job's URL must resolve to one of these hosts, or it will not save and will not send:</p>
          <ul class="man-hosts">
            <For each={hosts()}>{(host) => <li class="mono">{host}</li>}</For>
          </ul>
          <p class="man-aside">
            An entry like <code class="mono">github.com</code> matches that host exactly.{' '}
            <code class="mono">*.example.com</code> matches anything beneath example.com but not
            example.com itself. The check runs on the URL with its secrets substituted, and it runs
            again every time the job fires — so tightening the list stops existing jobs too.
          </p>
        </Show>
      </section>

      <section class="man-block">
        <h2 class="man-h">Reading the job list</h2>
        <p>The bar down the left of each row is the state of its last attempt.</p>
        <ul class="man-legend">
          <li>
            <span class="man-bar" data-state="ok" />
            <p>
              <strong>ok</strong> — the endpoint answered 2xx.
            </p>
          </li>
          <li>
            <span class="man-bar" data-state="failed" />
            <p>
              <strong>failed</strong> — it answered something else, timed out, or could not be
              reached. Open the row for the status, the error and the first part of the response.
            </p>
          </li>
          <li>
            <span class="man-bar" data-state="stale" />
            <p>
              <strong>overdue</strong> — the job should have fired by now and has not. This is the
              one state a failure log cannot show you: a request that was never attempted leaves no
              trace, so a stopped scheduler would otherwise look like a wall of old green. If
              everything is overdue at once, the heartbeat itself is the problem.
            </p>
          </li>
          <li>
            <span class="man-bar" data-state="paused" />
            <p>
              <strong>paused</strong> — switched off with the toggle. It keeps its history and never
              fires until resumed.
            </p>
          </li>
        </ul>
        <p class="man-aside">
          Editing a job or resuming it restarts the overdue clock, so changing a schedule is not
          judged against the old one. Running a job by hand does not: it proves the endpoint works,
          not that the scheduler does.
        </p>
      </section>

      <section class="man-block">
        <h2 class="man-h">What gets sent</h2>
        <ul class="man-list">
          <li>
            <code class="mono">user-agent</code> defaults to <code class="mono">curl/8.13.0</code>{' '}
            unless the job sets its own. Some APIs, GitHub's included, reject requests without one.
          </li>
          <li>
            Redirects are not followed. A 3xx is recorded as a failure on purpose — following one
            would hand your credentials to whatever host it points at. Use the final URL.
          </li>
          <li>
            A job waits up to its timeout for a response, at most{' '}
            {(props.config?.max_timeout_ms ?? 30000) / 1000} seconds, then records a timeout. Slow
            endpoints are fine: the wait costs nothing but the wait.
          </li>
          <li>GET and HEAD cannot carry a body, and saving one is refused.</li>
          <li>
            Header names are case-insensitive, so two rows differing only in case are refused rather
            than one silently overwriting the other.
          </li>
        </ul>
      </section>

      <section class="man-block">
        <h2 class="man-h">Limits</h2>
        <p>
          Up to {props.config?.max_per_tick ?? 40} jobs can fire in the same minute. Any beyond that
          are not dropped silently — each one gets a run record saying it was skipped and why, so
          stagger the schedules if you see it.
        </p>
        <p>
          Run history is kept for {props.config?.retention_days ?? 14} days and pruned hourly. The
          overdue check does not depend on that history, so a job that fires less often than the
          retention window still reports correctly.
        </p>
      </section>

      <section class="man-block">
        <h2 class="man-h">When something looks wrong</h2>
        <dl class="man-dl">
          <dt>One job is overdue, the rest are fine</dt>
          <dd>
            Open it. If there are no runs at all, check it is not paused and that its schedule really
            matches when you think — the editor's preview lists the next five fire times.
          </dd>
          <dt>Everything is overdue</dt>
          <dd>
            The heartbeat is not running. Check the Worker is deployed and still has its cron trigger.
          </dd>
          <dt>Failing with 401 or 403</dt>
          <dd>
            The token behind the reference has probably expired or been revoked. Replace it with{' '}
            <code class="mono">wrangler secret put</code> — the job needs no edit, since it only ever
            held the name.
          </dd>
          <dt>Saving is refused for a secret that exists</dt>
          <dd>
            References are case-sensitive and must be spelled{' '}
            <code class="mono">{`\${${prefix()}NAME}`}</code>. A secret added since the last deploy is
            not visible until you redeploy.
          </dd>
        </dl>
      </section>
    </article>
  )
}
