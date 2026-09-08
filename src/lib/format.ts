/** UTC throughout: that is what a cron expression means. */

const pad = (value: number) => String(value).padStart(2, '0')


export function utc(ms: number): string {
  const date = new Date(ms)
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  )
}


export function utcClock(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`
}


export function utcDay(ms: number): string {
  const date = new Date(ms)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]
  return `${day} ${pad(date.getUTCDate())} ${month}`
}

/** Shown beside a UTC time so the two can be compared. */
export function local(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export const localZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'local'
  }
})()


export function relative(ms: number, now = Date.now()): string {
  const delta = ms - now
  const ahead = delta > 0
  const seconds = Math.round(Math.abs(delta) / 1000)

  const shape = (value: number, unit: string) => (ahead ? `in ${value}${unit}` : `${value}${unit} ago`)
  // Short: this sits in a fixed-width column beside other times.
  if (seconds < 45) return ahead ? 'in <1m' : 'just now'
  if (seconds < 3600) return shape(Math.round(seconds / 60), 'm')
  if (seconds < 86_400) return shape(Math.round(seconds / 3600), 'h')
  return shape(Math.round(seconds / 86_400), 'd')
}


export function duration(msValue: number | null): string {
  if (msValue === null) return ''
  return msValue >= 1000 ? `${(msValue / 1000).toFixed(1)}s` : `${msValue}ms`
}

/** Splits a 5-field expression into the aligned crontab columns. */
export function cronFields(expression: string): string[] {
  const parts = expression.trim().split(/\s+/)
  return parts.length === 5 ? parts : [expression, '', '', '', '']
}
