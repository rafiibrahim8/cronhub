# cronhub

A centralized cron platform on one Cloudflare Worker: upload what request to send where, and it
sends it. Jobs live in D1 and are editable at runtime, so adding a schedule does not mean a deploy.

Built because GitHub disables scheduled workflows after 60 days of repository inactivity, and
because a Worker's own `triggers.crons` are deploy-time configuration — a job list has to be data.

## How it works

One `* * * * *` heartbeat. Every enabled job carries its own cron expression, which is matched in
JavaScript against the minute the tick was scheduled for. Jobs that match get their request sent;
every attempt, successful or not, is written to a run log.

```
                 ┌──────────────────────────────────────────┐
   * * * * *  ──▶│  scheduled()                             │
                 │    read enabled jobs           (1 query) │
                 │    match cron in JS                      │
                 │    interpolate ${CRONHUB_*}               │
                 │    fetch, in parallel        (≤40 calls) │──▶ your endpoints
                 │    write run records            (1 call) │
                 └──────────────────────────────────────────┘
                                    │
   dashboard  ◀── fetch() /api ─────┴── D1: jobs + runs
```

Failures are logged, never pushed anywhere. Nothing emails, pings or pages you — the dashboard is
the only place a failure appears, so it is built to make failures findable: a Failures view, the
last run inline on every job, and an **overdue** flag.

That flag is the one non-obvious piece. A failed dispatch writes a row, but a heartbeat that never
happens writes nothing at all — a dropped cron trigger, a Worker that stopped, a deploy that lost
`triggers.crons`. So the dashboard also asks "when should this have fired next, given when it last
did?" and marks the job overdue if that moment has passed. Without it the UI would show three
reassuring green pills from two weeks ago.

The answer to "when did it last fire" is `jobs.last_fired_at`, written by the heartbeat, rather than
the newest row in `runs`. Run records are pruned after 14 days, so deriving it from them made every
schedule sparser than a fortnight read as permanently overdue. Manual runs deliberately do not
update it — a job you fired by hand is no evidence the heartbeat is alive. Editing or enabling a job
restarts the clock, so a schedule change is not judged against an expectation set by the old one.

## Secrets

The `CRONHUB_` prefix means exactly one thing: **a secret a job is allowed to reference.** That makes
the prefix the security boundary.

| binding | in the dashboard | usable in a job |
|---|---|---|
| `APP_USERNAME`, `APP_PASSWORD`, `AUTH_SECRET`, `ALLOWED_HOSTS` | never | never |
| `CRONHUB_GH_TOKEN`, … | name only | yes |

Write `${CRONHUB_GH_TOKEN}` anywhere in a job's URL, header values or body. The value is substituted
in the Worker moments before the request goes out. Three consequences worth knowing:

- **The dashboard only ever receives names.** `GET /api/secrets` returns a name list and there is no
  route in the Worker that returns a value, so a bypassed session leaks nothing but names.
- **A reference to a secret that does not exist is refused at save time**, with the missing names in
  the error — you get a precise message without a value crossing the wire.
- **Responses are redacted before they are stored.** Plenty of endpoints echo a request header back
  on error; without this, a token would land in the run log and be rendered in the UI. Any secret
  value appearing in a response body or an error message is replaced with its `${NAME}` reference.
  Only the secrets a given job actually sends are searched for, so the redactor cannot be used to
  confirm a guess about a secret the job never references.

**What redaction is and is not.** It catches the common accident — an endpoint reflecting the
credential you just sent it — and it is not a defence against a hostile endpoint. Anything that
already received a token can encode it (base64, hex, one byte per response) and no literal search
will match. Treat the run log as trustworthy against mistakes, not against a target you do not
control. Values shorter than 6 characters are not searched for at all, because matching a
two-character string shreds unrelated text and proves nothing: do not use short job secrets.

Within that limit it searches for more than the raw bytes. A value containing a quote, a backslash
or a control character comes back from an ordinary JSON API in its **escaped** form, which one
`JSON.parse` reverses — so the JSON-escaped, URL-encoded and HTML-escaped forms are searched too.
Alphanumeric tokens like GitHub PATs never trip this, which is exactly why it is easy to miss:
basic-auth passwords and connection strings do.

**Every secret is searched for, not only the ones a job references** — a value that turns up in a
response for some unrelated reason is still a live credential heading for the database and the
dashboard. Only referenced secrets are *named* in the rewrite; anything else becomes an anonymous
`${REDACTED}`, so the rewrite cannot tell a reader which secret an echoed candidate matched. What
remains is confirmation that some secret has exactly that value, which is useless against anything
with real entropy and strictly less than what someone able to create jobs can already do.

### A secret in the hostname is not confidential

`http://${CRONHUB_INTERNAL_HOST}/path` works, and there are good reasons to keep a host out of the
database. But be clear about what it does not do: before any response comes back, that value has
already gone out as a DNS query, as the TLS SNI, and as the `Host` header. Redaction cleans the
stored snippet; it cannot reach a resolver. Use a host reference to keep configuration out of the
job list, never to keep a credential secret — and note that a wildcard entry in `ALLOWED_HOSTS`
permits `http://${CRONHUB_TOKEN}.example.com/`, which ships a token to a resolver as a DNS label.

Secrets are created from the CLI, never from the browser — there is no write path for them at all:

```bash
wrangler secret put CRONHUB_GH_TOKEN
```

Every `CRONHUB_`-prefixed binding is discovered automatically on the next request; no registry to
update. The free plan allows 64 variables per Worker at 5 KB each.

## Where jobs may point

Set `ALLOWED_HOSTS` to restrict the hosts a job can target:

```
ALLOWED_HOSTS=api.github.com,*.example.com,internal.example.com:8443
```

- `api.github.com` matches that host exactly — not `github.com`, and nothing beneath it.
- `*.example.com` matches any host under example.com at any depth, but **not** example.com itself.
  List both if you want both; a wildcard should never silently widen to the apex.
- An entry may pin a port. Without one, any port on that host is allowed — fine for the https
  endpoints this mostly guards, but note that a bare `127.0.0.1` permits every service on loopback.
- Comparison is case-insensitive, a trailing root dot is the same host, and IDN is compared in its
  punycode form so a unicode homograph cannot pass as an ASCII entry.
- **Unset or empty means no restriction**, so adding this to a running deployment cannot break it.
  A single `*` says the same thing explicitly, for anyone who prefers the intent visible in config.
  The dashboard states which is in force rather than implying a protection that is not there.
- **A value that lists no hostnames at all — `",,,"` — refuses everything** rather than falling back
  to allowing everything, and says so in the dashboard and the Worker log. A security setting that
  quietly stops applying is worse than one that stops working, and no realistic typo reaches this
  state: any value containing an actual hostname parses to at least one entry.
- There is **no public-suffix guard**: `*.com` really would allow every `.com` host. A wildcard over
  a single label is legitimate for internal TLDs like `*.internal`, and the two intentions are
  indistinguishable, so this is left to you.

It is enforced twice. At save time, so a job that could never be delivered is refused with an
explanation instead of logging the same failure once a minute forever — and the check runs on the URL
*with its secrets substituted*, not on the placeholder-stripped probe used for shape validation,
because a secret value containing `@` or `/` changes which host a URL resolves to. And again at
dispatch, immediately before the request goes out, because the two moments are separated by arbitrary
time: the list can be tightened, a `${CRONHUB_*}` reference in a URL can resolve somewhere new after
the secret is rotated, and a row can reach D1 without ever passing validation.

A refusal names the offending host only when the URL template contained no secret references — the
resolved host can *be* a secret value, and an error message is not the place for it.

`ALLOWED_HOSTS` is deliberately not `CRONHUB_`-prefixed: that prefix marks secrets a job may
reference, and this is the opposite — policy a job must not be able to read or interpolate.

## Setup

```bash
pnpm install

wrangler d1 create cronhub          # paste the printed id into wrangler.jsonc
pnpm run db:init                   # apply schema.sql to the remote database

wrangler secret put APP_USERNAME   # the dashboard login
wrangler secret put APP_PASSWORD
wrangler secret put AUTH_SECRET    # openssl rand -base64 32

wrangler secret put ALLOWED_HOSTS  # optional; see "Where jobs may point"
wrangler secret put CRONHUB_GH_TOKEN

pnpm run deploy
```

`AUTH_SECRET` signs the session cookie; rotating it signs everyone out. A wrong username and a
wrong password give the same error, so the form cannot be used to discover the username.

**Every login attempt takes one second**, successful or not, so the response time says nothing about
which half was wrong. Note what that does not do: it is a per-request sleep, not a limiter, so
concurrent attempts still finish in about a second between them. The shared password must be strong,
and if this is reachable from anywhere hostile, put a rate-limiting rule in front of `/api/login` at
the edge — Cloudflare's free tier includes one.

Requests carrying a body must send `content-type: application/json`. That is the CSRF defence for
the one route a session cookie cannot protect: a cross-site form can send `text/plain` but not JSON.

### Upgrading an existing database

`migrations/` holds schema changes for databases created before them. Fresh ones get everything from
`schema.sql`.

```bash
wrangler d1 execute cronhub --remote --file=./migrations/0001-last-fired-at.sql
```

## Local development

```bash
cp .dev.vars.example .dev.vars     # put local values in it
pnpm run db:init:local
pnpm run dev                       # UI on 5173, Worker and /api on 8788
```

To fire the heartbeat by hand:

```bash
curl "http://127.0.0.1:8788/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

Note that path — `/__scheduled` is answered by the asset worker and silently does nothing, because
`run_worker_first` only routes `/api/*` to the Worker.

The checked-in `.wrangler` local database may already hold a few demo jobs pointing at
`127.0.0.1:9099`; delete them, or run a listener there.

## Free plan limits this is built around

| limit | value | how it shows up here |
|---|---|---|
| Subrequests per invocation | 50 | caps the fan-out; D1 calls count too |
| Bound parameters per D1 statement | 100 | run records are written 12 rows per statement, batched |
| CPU per invocation | 10 ms | cron matching skips whole months rather than scanning minutes |
| Requests per day | 100,000 | the heartbeat spends 1,440 of them |
| Variables per Worker | 64 at 5 KB | the ceiling on job secrets |
| Cron triggers per account | 5 | this uses one, forever |

**Up to 40 jobs can fire in the same minute.** Beyond that, the surplus jobs get a run record saying
so rather than being dropped silently — stagger the schedules, or move to the paid plan, which raises
the subrequest ceiling 200-fold.

## Schedules

Standard five-field cron, **always UTC**:

```
min  hour  dom  mon  dow
 45     1    *    *    *     every day at 01:45 UTC
 30     0    *    *  mon     Mondays at 00:30 UTC
*/15  9-17    *    *  1-5    every 15 minutes, 09:00–17:59, weekdays
```

Supported: `*`, `N`, `a-b`, `*/n`, `a-b/n`, `N/n`, comma lists, month and day names, `0-7` for
day-of-week with `7` meaning Sunday, and Vixie's rule that a restricted day-of-month **or**
day-of-week matches — where a bare `*` restricts nothing but `*/n` does. Six-field expressions are
rejected: a one-minute heartbeat cannot honour seconds, and failing loudly beats silently rounding.
Expressions are capped at 200 characters, because the heartbeat re-parses every enabled job against a
10 ms CPU budget and a 5 KB expression alone costs twice that — one saved row would stop everything.

Timing is best-effort. Cloudflare delivers crons a few seconds late routinely, and a missed minute
is skipped rather than backfilled.

## Behaviour worth knowing

- **Redirects are not followed.** A 3xx is recorded as a failure, because following one would forward
  your `Authorization` header to whatever host it points at. Point the job at the final URL.
- **A job's request never carries a body on GET or HEAD**, and saving one is refused.
- **`user-agent` defaults to `curl/8.13.0`** unless the job sets its own. Some APIs, GitHub's
  included, reject requests that send none.
- **Run history is kept for 14 days**, pruned on the hour. Staleness does not depend on it.
- **Header values are validated at save time** — no line breaks or null bytes, 2 KB max — because a
  value the runtime rejects would otherwise fail once a minute forever. Two header names differing
  only in case are refused rather than silently collapsed into whichever one wins.
- **`enabled` must be a real boolean.** `"false"` is a 400, not `true`.
- **Run now ignores the schedule and the paused flag**, and is logged as `ran by hand`. It does not
  bypass the host allowlist.

The dashboard carries its own manual under **Help**, which reads this deployment's real configuration
from `/api/config` — the allowlist, the retention window, the per-minute cap — so it cannot drift
from what the Worker actually enforces.

## API

Session-gated except where noted. Same shape as the dashboard uses.

| route | |
|---|---|
| `GET /api/session` | open; `{authenticated, configured}` |
| `POST /api/login` | open; `{username, password}` |
| `POST /api/logout` | |
| `GET /api/jobs` | jobs with last run, next run and the overdue flag |
| `POST /api/jobs` | create |
| `PATCH /api/jobs/:id` | partial; merged over what is stored, then validated whole |
| `DELETE /api/jobs/:id` | cascades to the job's runs |
| `POST /api/jobs/:id/run` | fire now |
| `GET /api/runs?job_id=&failed=1&limit=` | run log |
| `GET /api/secrets` | `{names}` |
| `GET /api/config` | allowlist, retention, per-tick cap — what the manual reads so it cannot drift |
| `POST /api/preview` | next five fire times, and which references are missing |

## Layout

```
worker/
  index.ts          fetch + scheduled
  router.ts         /api routing and the session gate
  lib/cron.ts       5-field parser, matcher, next-fire search
  lib/hosts.ts      the outbound host allowlist
  lib/secrets.ts    CRONHUB_ discovery, interpolation, redaction
  lib/dispatch.ts   one job, executed and recorded
  lib/tick.ts       the heartbeat
  lib/health.ts     next-run and overdue, computed on read
  lib/validate.ts   job input rules
  lib/{auth,db,http,env}.ts
  api/{auth,jobs,runs,meta}.ts
src/                Solid dashboard (jobs, failures, and a Help page behind the login)
shared/types.ts     wire types, used by both
schema.sql
migrations/         schema changes for databases created before them
```

## License

MIT — see [LICENSE](LICENSE).
