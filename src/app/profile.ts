import type { Member, Status } from './domain'

/* Profiles: custom status, paused notifications and local time. Pure, so
   pages compute what to show from their Model's `now`. */

export const MAX_STATUS = 100
export const MAX_PRONOUNS = 30
export const MAX_TITLE = 80
export const MAX_NAME = 80

export const DEFAULT_TIME_ZONE = 'Europe/Berlin'

/** The zones a profile can pick, west to east. */
export const TIME_ZONES: ReadonlyArray<readonly [zone: string, label: string]> = [
  ['America/Los_Angeles', 'Pacific Time (Los Angeles)'],
  ['America/Denver', 'Mountain Time (Denver)'],
  ['America/Chicago', 'Central Time (Chicago)'],
  ['America/New_York', 'Eastern Time (New York)'],
  ['America/Sao_Paulo', 'São Paulo'],
  ['Europe/London', 'London'],
  ['Europe/Berlin', 'Central European Time (Berlin)'],
  ['Europe/Helsinki', 'Eastern European Time (Helsinki)'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Kolkata', 'India (Kolkata)'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
]

export const isTimeZone = (zone: string): boolean => TIME_ZONES.some(([candidate]) => candidate === zone)

export const timeZoneOf = (member: Member): string => member.timeZone ?? DEFAULT_TIME_ZONE

export const timeZoneLabel = (zone: string): string => TIME_ZONES.find(([candidate]) => candidate === zone)?.[1] ?? zone

/** "4:05 PM local time" for the member right now. */
export const localTime = (member: Member, now: number): string =>
  new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timeZoneOf(member) })

/** How long a status lasts, as Slack offers it. */
export const CLEAR_AFTER = ['never', '30m', '1h', '4h', 'today', 'week'] as const
export type ClearAfter = (typeof CLEAR_AFTER)[number]

export const CLEAR_AFTER_LABELS: Readonly<Record<ClearAfter, string>> = {
  never: "Don't clear",
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  today: 'Today',
  week: 'This week',
}

export const isClearAfter = (value: string): value is ClearAfter => (CLEAR_AFTER as ReadonlyArray<string>).includes(value)

/** Milliseconds until the next local midnight in `zone`. */
export const untilMidnight = (now: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZone: zone }).formatToParts(now)
  const part = (type: string) => Number(parts.find(candidate => candidate.type === type)?.value ?? 0)
  return ((24 - part('hour')) * 3600 - part('minute') * 60 - part('second')) * 1000
}

export const DAY = 24 * 3600 * 1000

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Days from today to the end of Sunday in `zone`, today included. */
export const daysLeftInWeek = (now: number, zone: string): number =>
  6 - Math.max(0, WEEKDAYS.indexOf(new Date(now).toLocaleDateString('en-US', { weekday: 'short', timeZone: zone })))

const SPANS: Readonly<Record<'30m' | '1h' | '4h', number>> = { '30m': 30 * 60_000, '1h': 3600_000, '4h': 4 * 3600_000 }

/** The moment a status set `now` with this choice clears (0: never). */
export const clearAt = (choice: ClearAfter, now: number, zone: string): number =>
  choice === 'never'
    ? 0
    : choice === 'today'
      ? now + untilMidnight(now, zone)
      : choice === 'week'
        ? now + untilMidnight(now, zone) + daysLeftInWeek(now, zone) * DAY
        : now + SPANS[choice]

/** Their status, unless it has cleared. */
export const statusOf = (member: Member | undefined, now: number): Status | undefined => {
  const status = member?.status
  return status === undefined || (status.until !== 0 && status.until <= now) ? undefined : status
}

export const isPaused = (member: Member | undefined, now: number): boolean => (member?.pausedUntil ?? 0) > now

/** How long notifications can be paused for. */
export const PAUSE_FOR: ReadonlyArray<readonly [minutes: number, label: string]> = [
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [24 * 60, '24 hours'],
]

/** "until 4:05 PM" today, else "until Tue 9:00 AM", in `zone`. */
export const untilLabel = (until: number, now: number, zone: string): string => {
  const time = new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
  return until - now < untilMidnight(now, zone) ? `until ${time}` : `until ${new Date(until).toLocaleDateString('en-US', { weekday: 'short', timeZone: zone })} ${time}`
}
