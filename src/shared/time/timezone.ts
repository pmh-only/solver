export const AGENT_TIME_ZONE_ENV = 'AGENT_TZ'

export interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const WEEKDAYS = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6]
])

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export function getAgentTimeZone(value = process.env[AGENT_TIME_ZONE_ENV]): string {
  const configured = value?.trim()
  if (configured && isValidTimeZone(configured)) return configured

  const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return hostTimeZone && isValidTimeZone(hostTimeZone) ? hostTimeZone : 'UTC'
}

export function getZonedDateParts(date: Date, timeZone = getAgentTimeZone()): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-hc-h23', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  }).formatToParts(date)
  const values = new Map(parts.map((part) => [part.type, part.value]))

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
    weekday: WEEKDAYS.get(values.get('weekday') ?? '') ?? 0
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

export function formatAgentDate(date: Date, timeZone = getAgentTimeZone()): string {
  const parts = getZonedDateParts(date, timeZone)
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`
}

export function formatAgentDateTime(date: Date, timeZone = getAgentTimeZone()): string {
  const parts = getZonedDateParts(date, timeZone)
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds()
  )
  const offsetMinutes = Math.round((localAsUtc - date.getTime()) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`

  return `${formatAgentDate(date, timeZone)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(date.getUTCMilliseconds(), 3)}${offset} [${timeZone}]`
}

export function zonedDateTimeToEpoch(
  values: Pick<ZonedDateParts, 'year' | 'month' | 'day' | 'hour'> &
    Partial<Pick<ZonedDateParts, 'minute' | 'second'>>,
  timeZone = getAgentTimeZone()
): number {
  const desired = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute ?? 0,
    values.second ?? 0
  )
  let epoch = desired

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = getZonedDateParts(new Date(epoch), timeZone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    )
    const adjustment = desired - actualAsUtc
    epoch += adjustment
    if (adjustment === 0) break
  }

  return epoch
}
