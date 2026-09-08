/**
 * A 5-field cron parser and matcher, UTC only. `nextAfter()` skips whole
 * months, days and hours rather than walking minutes, because the free plan
 * allows 10ms of CPU and a naive scan for a yearly job is half a million steps.
 */

export class CronError extends Error {}

export type CronSpec = {
  source: string
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Vixie's rule: with both day fields restricted, either match wins. */
  domRestricted: boolean
  dowRestricted: boolean
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type FieldDef = { name: string; min: number; max: number; names?: string[] }

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  // 7 is accepted for Sunday and normalized to 0.
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES },
]

function parseValue(raw: string, field: FieldDef): number {
  const token = raw.trim().toLowerCase()
  if (field.names) {
    const named = field.names.indexOf(token)
    if (named !== -1) return named + field.min
  }
  if (!/^\d+$/.test(token)) {
    throw new CronError(`${field.name}: '${raw}' is not a number${field.names ? ' or name' : ''}`)
  }
  const value = Number(token)
  if (value < field.min || value > field.max) {
    throw new CronError(`${field.name}: ${value} is outside ${field.min}-${field.max}`)
  }
  return value
}

function parseField(raw: string, field: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  let restricted = false

  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (piece === '') throw new CronError(`${field.name}: empty value in '${raw}'`)

    const [range, stepRaw, ...extra] = piece.split('/')
    if (extra.length > 0) throw new CronError(`${field.name}: '${piece}' has more than one step`)

    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        throw new CronError(`${field.name}: '${stepRaw}' is not a positive step`)
      }
      step = Number(stepRaw)
    }

    let from: number
    let to: number
    if (range === '*') {
      from = field.min
      to = field.max
      // `*` restricts nothing, `*/n` does. Only matters in the two day fields,
      // where an unrestricted field short-circuits `dayMatches` — miss this and
      // `*/2` in day-of-month is parsed, stored, then silently ignored.
      if (stepRaw !== undefined) restricted = true
    } else if (range.includes('-')) {
      const [a, b, ...rest] = range.split('-')
      if (rest.length > 0) throw new CronError(`${field.name}: '${range}' is not a range`)
      from = parseValue(a, field)
      to = parseValue(b, field)
      if (from > to) throw new CronError(`${field.name}: range ${range} runs backwards`)
      restricted = true
    } else {
      from = parseValue(range, field)
      // `5/10` means from 5 to the end of the field, every 10.
      to = stepRaw === undefined ? from : field.max
      restricted = true
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  if (values.size === 0) throw new CronError(`${field.name}: '${raw}' matches nothing`)
  return { values, restricted }
}

/**
 * Parsing is linear in length and the tick re-parses every job every minute, so
 * without a cap one saved row stops everything: 5 KB already costs ~11ms.
 */
const MAX_LENGTH = 200

/** Parses a 5-field expression. Throws `CronError` with a human-readable reason. */
export function parseCron(expression: string): CronSpec {
  const source = expression.trim()
  if (source === '') throw new CronError('the schedule is empty')
  if (source.length > MAX_LENGTH) {
    throw new CronError(`a schedule cannot be longer than ${MAX_LENGTH} characters (this one is ${source.length})`)
  }

  const parts = source.split(/\s+/)
  if (parts.length === 6) {
    throw new CronError('six fields look like a seconds-precision schedule, which a one-minute heartbeat cannot honour — use five fields')
  }
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`)
  }

  const minute = parseField(parts[0], FIELDS[0])
  const hour = parseField(parts[1], FIELDS[1])
  const dom = parseField(parts[2], FIELDS[2])
  const month = parseField(parts[3], FIELDS[3])
  const dow = parseField(parts[4], FIELDS[4])

  // Sunday-as-7 normalized away, so matching only ever sees 0-6.
  const dowValues = new Set<number>()
  for (const value of dow.values) dowValues.add(value === 7 ? 0 : value)

  return {
    source,
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dowValues,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const domHit = spec.dom.has(date.getUTCDate())
  const dowHit = spec.dow.has(date.getUTCDay())
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit
  if (spec.domRestricted) return domHit
  if (spec.dowRestricted) return dowHit
  return true
}

/** True when this schedule fires on `date`'s UTC minute. */
export function matches(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getUTCMinutes()) &&
    spec.hour.has(date.getUTCHours()) &&
    spec.month.has(date.getUTCMonth() + 1) &&
    dayMatches(spec, date)
  )
}

const MINUTE_MS = 60_000

/**
 * Nine years, because `0 0 29 feb *` can gap by eight: century years are not
 * leap years, so 2096 is followed by 2104. Too short a horizon returns null,
 * which also means "never fires", and the job stops being checked for staleness.
 */
const HORIZON_MS = 9 * 366 * 24 * 60 * MINUTE_MS
const MAX_STEPS = 20_000

/** First fire strictly after `fromMs`; null if none inside the horizon. */
export function nextAfter(spec: CronSpec, fromMs: number): number | null {
  const limit = fromMs + HORIZON_MS
  // Next whole minute: a schedule never fires twice within one.
  const cursor = new Date(Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS)

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (cursor.getTime() > limit) return null

    if (!spec.month.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCFullYear(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }

    if (!dayMatches(spec, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      cursor.setUTCHours(0, 0, 0, 0)
      continue
    }

    if (!spec.hour.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0)
      continue
    }

    if (!spec.minute.has(cursor.getUTCMinutes())) {
      const current = cursor.getUTCMinutes()
      let nextMinute = -1
      for (const candidate of spec.minute) {
        if (candidate > current && (nextMinute === -1 || candidate < nextMinute)) nextMinute = candidate
      }
      if (nextMinute === -1) cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0)
      else cursor.setUTCMinutes(nextMinute, 0, 0)
      continue
    }

    return cursor.getTime()
  }

  return null
}

/** For the editor's preview. */
export function nextRuns(spec: CronSpec, fromMs: number, count: number): number[] {
  const out: number[] = []
  let at = fromMs
  for (let i = 0; i < count; i += 1) {
    const next = nextAfter(spec, at)
    if (next === null) break
    out.push(next)
    at = next
  }
  return out
}
