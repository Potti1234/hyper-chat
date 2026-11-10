import { Schema as S } from 'effect'

import { dayLabel, formatTime, type Member } from './domain'
import { DAY, daysLeftInWeek, timeZoneOf, untilMidnight } from './profile'

/* Slack's "Schedule for later" and "Remind me about this" times: a few
   minutes or hours from now, or 9:00 AM tomorrow or next Monday in the
   member's time zone. */

export const SCHEDULE_CHOICES = ['30m', '1h', 'tomorrow', 'monday'] as const
export const REMIND_CHOICES = ['20m', '1h', '3h', 'tomorrow', 'monday'] as const

export const ScheduleChoice = S.Literals(SCHEDULE_CHOICES)
export const RemindChoice = S.Literals(REMIND_CHOICES)

export type WhenChoice = (typeof SCHEDULE_CHOICES)[number] | (typeof REMIND_CHOICES)[number]

const SPANS: Readonly<Record<'20m' | '30m' | '1h' | '3h', number>> = { '20m': 20 * 60_000, '30m': 30 * 60_000, '1h': 3600_000, '3h': 3 * 3600_000 }

const NINE = 9 * 3600_000

export const isScheduleChoice = (value: string): value is (typeof SCHEDULE_CHOICES)[number] => (SCHEDULE_CHOICES as ReadonlyArray<string>).includes(value)
export const isRemindChoice = (value: string): value is (typeof REMIND_CHOICES)[number] => (REMIND_CHOICES as ReadonlyArray<string>).includes(value)

/** The moment a choice made `now` stands for, in `zone`. */
export const whenAt = (choice: WhenChoice, now: number, zone: string): number =>
  choice === 'tomorrow'
    ? now + untilMidnight(now, zone) + NINE
    : choice === 'monday'
      ? now + untilMidnight(now, zone) + daysLeftInWeek(now, zone) * DAY + NINE
      : now + SPANS[choice]

/** "Today at 3:41 PM", "Tomorrow at 9:00 AM", "Monday, November 16th at 9:00 AM". */
export const whenLabel = (at: number, now: number, viewer: Member): string => {
  const today = dayLabel(at, now, viewer)
  const day = today === 'Today' || today === 'Yesterday' ? today : dayLabel(at, now + DAY, viewer) === 'Today' ? 'Tomorrow' : today
  return `${day} at ${formatTime(at, viewer)}`
}

/** A `whenLabel` inside a sentence: "today at 9:00 AM", "on Monday, November 16 at 9:00 AM". */
export const inSentence = (label: string): string =>
  /^(Today|Tomorrow|Yesterday) /.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : `on ${label}`

/** What a choice reads as in a menu, made `now` by `member`. */
export const choiceLabel = (choice: WhenChoice, now: number, member: Member): string =>
  choice === '20m' ? 'In 20 minutes' : choice === '30m' ? 'In 30 minutes' : choice === '1h' ? 'In 1 hour' : choice === '3h' ? 'In 3 hours' : choice === 'tomorrow' ? `Tomorrow at ${formatTime(whenAt(choice, now, timeZoneOf(member)), member)}` : `Monday at ${formatTime(whenAt(choice, now, timeZoneOf(member)), member)}`
