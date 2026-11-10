/* Calendar days as text (2026-11-20) and months (2026-11), for the calendar
   page and the date picker. Weeks start on Monday; names are German. Days
   are calendar days, not instants, so the arithmetic runs at noon UTC and no
   time zone can move a day. */

export const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

const noon = (day: string) => Date.parse(`${day}T12:00:00Z`)

/** A real day (not 2026-02-30). */
export const isDay = (value: string): boolean => DAY.test(value) && new Date(noon(value)).toISOString().slice(0, 10) === value

export const addDays = (day: string, by: number): string => new Date(noon(day) + by * 86_400_000).toISOString().slice(0, 10)

export const shiftMonth = (month: string, by: number): string => {
  const [year = 2026, number = 1] = month.split('-').map(Number)
  const index = year * 12 + (number - 1) + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** The weeks shown for a month: Monday to Sunday, from the week of the 1st
 *  to the week of the last day. */
export const weeksOf = (month: string): ReadonlyArray<ReadonlyArray<string>> => {
  const first = `${month}-01`
  const weekday = (new Date(noon(first)).getUTCDay() + 6) % 7
  const weeks: Array<Array<string>> = []
  for (let day = addDays(first, -weekday); weeks.length === 0 || day.slice(0, 7) <= month; ) {
    const week: Array<string> = []
    for (let index = 0; index < 7; index++, day = addDays(day, 1)) week.push(day)
    weeks.push(week)
  }
  return weeks
}

export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const

/** November 2026 */
export const monthLabel = (month: string): string =>
  new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(noon(`${month}-15`))

/** Fr., 20. Nov. */
export const shortDay = (day: string): string =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(noon(day))

/** Fr., 20. Nov. 2026 */
export const longDay = (day: string): string =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(noon(day))

/** Freitag, 20. November 2026 (for screen readers). */
export const fullDay = (day: string): string =>
  new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(noon(day))
