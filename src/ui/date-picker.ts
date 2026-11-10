import type { Html, HtmlBuilder } from 'foldkit/html'

import { anchoredStyle } from '@/lib/anchored'
import { WEEKDAYS, fullDay, longDay, monthLabel, shiftMonth, weeksOf } from '@/lib/dates'
import * as Icon from '@/lib/icon'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/ui/button'

/* crease/ui's date picker (shadcn's date-picker demo on its calendar),
   rendered on the server: an outline trigger with the date, and below it a
   popover with the month. The classes are crease's calendar classes.

   crease's DatePicker places its popover with browser code when it mounts.
   Here the popover is placed with anchoredStyle (src/lib/anchored.ts), so it
   needs no browser code and stays on screen. The page owns the state: whether
   the popover is open and which month it shows (`openMonth`, null when
   closed). Its Messages set the date, move the month and close the popover.
   Use this instead of <input type="date"> (test/native-controls.test.ts). */

export type DatePickerProps<Msg> = Readonly<{
  id: string
  /** The day (2026-11-20), or '' for none. */
  value: string
  /** The month the open popover shows (2026-11), or null when it is closed. */
  openMonth: string | null
  today: string
  /** Days before this one cannot be picked (an end after a start). */
  min?: string
  placeholder?: string
  ariaLabel: string
  describedBy?: string
  isInvalid?: boolean
  isDisabled?: boolean
  onToggle: Msg
  onClose: Msg
  onMonth: (month: string) => Msg
  onSelect: (day: string) => Msg
  /** Shows "Clear" in the popover (an optional date). */
  onClear?: Msg
  /** `dense`: 32px high in 13px type, readable when disabled. */
  size?: 'default' | 'dense'
  class?: string
}>

// crease/ui calendar (src/ui/calendar.ts), for a calendar in a popover.
const ROOT_CLASS = 'group/calendar bg-transparent p-3 [--cell-size:--spacing(8)] w-fit'
const MONTH_CLASS = 'relative flex w-full flex-col gap-4'
const NAV_CLASS = 'pointer-events-none absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1'
const NAV_BUTTON_CLASS = cn('pointer-events-auto', buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-(--cell-size) p-0 select-none aria-disabled:opacity-50')
const CAPTION_CLASS = 'flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)'
const HEADER_ROW_CLASS = 'flex'
const WEEKDAY_CLASS = 'flex size-(--cell-size) flex-1 items-center justify-center rounded-md text-[0.8rem] font-normal text-muted-foreground select-none'
const WEEK_CLASS = 'mt-2 flex w-full'
const DAY_CELL_CLASS =
  'group/day relative aspect-square size-(--cell-size) p-0 text-center select-none data-[today]:rounded-md data-[today]:bg-accent data-[today]:text-accent-foreground data-[outside-month]:text-muted-foreground data-[disabled]:text-muted-foreground data-[disabled]:opacity-50'
const DAY_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'ghost', size: 'icon' }),
  'group-data-[selected]/day:hover:bg-primary group-data-[selected]/day:hover:text-primary-foreground dark:group-data-[selected]/day:hover:bg-primary dark:group-data-[selected]/day:hover:text-primary-foreground',
  'flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal group-data-[selected]/day:bg-primary group-data-[selected]/day:text-primary-foreground group-data-[outside-month]/day:text-muted-foreground group-data-[disabled]/day:pointer-events-none group-data-[disabled]/day:opacity-50 dark:hover:text-accent-foreground',
)
// crease/ui date-picker (src/ui/date-picker.ts).
const TRIGGER_CLASS = 'w-full justify-start text-left font-normal align-top'
const PANEL_CLASS = 'z-50 w-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-hidden'
const BACKDROP_CLASS = 'fixed inset-0 z-40'

export const datePickerAnchor = (id: string) => `--anchor-${id}`

export const datePicker = <Msg>(props: DatePickerProps<Msg>, h: HtmlBuilder<Msg>): Html => {
  const isOpen = props.openMonth !== null && props.isDisabled !== true
  const month = props.openMonth ?? (props.value === '' ? props.today : props.value).slice(0, 7)
  const panelId = `${props.id}-panel`
  const trigger = h.button(
    [
      h.Type('button'),
      h.Id(props.id),
      h.DataAttribute('slot', 'popover-trigger'),
      h.DataAttribute('value', props.value),
      h.AriaLabel(`${props.ariaLabel}: ${props.value === '' ? (props.placeholder ?? 'none') : fullDay(props.value)}`),
      h.AriaHasPopup('dialog'),
      h.AriaExpanded(isOpen),
      h.AriaControls(panelId),
      ...(props.isInvalid === true ? [h.AriaInvalid(true)] : []),
      ...(props.describedBy === undefined ? [] : [h.AriaDescribedBy(props.describedBy)]),
      ...(props.isDisabled === true ? [h.Disabled(true), h.DataAttribute('disabled', '')] : [h.OnClick(props.onToggle)]),
      h.Style({ anchorName: datePickerAnchor(props.id) }),
      h.Class(cn(buttonVariants({ variant: 'outline' }), TRIGGER_CLASS, props.value === '' && 'text-muted-foreground', props.size === 'dense' && 'h-8 text-[13px] disabled:opacity-100', props.class)),
    ],
    [Icon.calendarIcon({}, h), h.span([h.Class('truncate')], [props.value === '' ? (props.placeholder ?? 'Pick a date') : longDay(props.value)])],
  )
  if (!isOpen) return h.div([h.Class('contents')], [trigger])

  const navButton = (label: string, to: string, icon: Html) =>
    h.button([h.Type('button'), h.AriaLabel(label), h.Class(NAV_BUTTON_CLASS), h.OnClick(props.onMonth(to))], [icon])
  const day = (date: string) => {
    const isDisabled = props.min !== undefined && props.min !== '' && date < props.min
    const isSelected = date === props.value
    return h.div(
      [
        h.Role('gridcell'),
        h.Class(DAY_CELL_CLASS),
        ...(date === props.today ? [h.DataAttribute('today', '')] : []),
        ...(date.slice(0, 7) !== month ? [h.DataAttribute('outside-month', '')] : []),
        ...(isSelected ? [h.DataAttribute('selected', ''), h.AriaSelected(true)] : []),
        ...(isDisabled ? [h.DataAttribute('disabled', '')] : []),
      ],
      [
        h.button(
          [
            h.Type('button'),
            h.Id(`${props.id}-day-${date}`),
            h.DataAttribute('slot', 'calendar-day'),
            h.DataAttribute('day', date),
            h.AriaLabel(fullDay(date)),
            ...(date === props.today ? [h.AriaCurrent('date')] : []),
            ...(isDisabled ? [h.Disabled(true)] : [h.OnClick(props.onSelect(date))]),
            h.Class(DAY_BUTTON_CLASS),
          ],
          [String(Number(date.slice(8, 10)))],
        ),
      ],
    )
  }

  return h.div(
    [h.Class('contents')],
    [
      trigger,
      h.div([h.AriaHidden(true), h.Class(BACKDROP_CLASS), h.OnClick(props.onClose)], []),
      h.div(
        [
          h.Id(panelId),
          h.Role('dialog'),
          h.AriaLabel(props.ariaLabel),
          h.DataAttribute('slot', 'popover-content'),
          h.Class(PANEL_CLASS),
          // Below the trigger, flipping to stay on screen.
          h.Style(anchoredStyle(datePickerAnchor(props.id))),
        ],
        [
          h.div(
            [h.DataAttribute('slot', 'calendar'), h.Class(ROOT_CLASS)],
            [
              h.div(
                [h.Class(MONTH_CLASS)],
                [
                  h.div(
                    [h.Class(NAV_CLASS)],
                    [
                      navButton('Previous month', shiftMonth(month, -1), Icon.chevronLeft({ class: 'size-4' }, h)),
                      navButton('Next month', shiftMonth(month, 1), Icon.chevronRight({ class: 'size-4' }, h)),
                    ],
                  ),
                  h.div([h.Class(CAPTION_CLASS)], [h.span([h.Id(`${props.id}-month`), h.Class('text-sm font-medium select-none'), h.AriaLive('polite')], [monthLabel(month)])]),
                  h.div(
                    [h.Role('grid'), h.AriaLabelledBy(`${props.id}-month`), h.Class('w-full border-collapse outline-none')],
                    [
                      h.div([h.Role('row'), h.Class(HEADER_ROW_CLASS)], WEEKDAYS.map(name => h.div([h.Role('columnheader'), h.Class(WEEKDAY_CLASS)], [name]))),
                      ...weeksOf(month).map(week => h.div([h.Role('row'), h.Class(WEEK_CLASS)], week.map(day))),
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class('flex items-center justify-between gap-2 border-t px-3 py-2')],
            [
              props.min !== undefined && props.today < props.min
                ? h.span([], [])
                : h.button([h.Type('button'), h.Id(`${props.id}-today`), h.Class(buttonVariants({ variant: 'ghost', size: 'xs' })), h.OnClick(props.onSelect(props.today))], ['Today']),
              ...(props.onClear === undefined || props.value === ''
                ? []
                : [h.button([h.Type('button'), h.Id(`${props.id}-clear`), h.Class(cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'text-muted-foreground')), h.OnClick(props.onClear)], ['Clear'])]),
            ],
          ),
        ],
      ),
    ],
  )
}
