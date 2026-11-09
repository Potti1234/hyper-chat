import type { Html, HtmlBuilder } from 'foldkit/html'

import { anchoredStyle } from '@/lib/anchored'
import * as Icon from '@/lib/icon'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/ui/button'

/* A time picker in crease/ui's style: an outline trigger with the time, and
   a popover with the hours (00–23) and the minutes in steps of five, in
   crease's picker grid (the month and year grids of its calendar).

   Like the date picker (src/ui/date-picker.ts), it is rendered on the
   server and placed with anchoredStyle, and the page owns the state.
   Picking an hour keeps the popover open for the minutes; picking a minute
   closes it. Use this instead of <input type="time">
   (test/native-controls.test.ts). */

export type TimePickerProps<Msg> = Readonly<{
  id: string
  /** 14:30, or '' for none. */
  value: string
  isOpen: boolean
  placeholder?: string
  ariaLabel: string
  describedBy?: string
  isInvalid?: boolean
  isDisabled?: boolean
  onToggle: Msg
  onClose: Msg
  onHour: (hour: string) => Msg
  onMinute: (minute: string) => Msg
  /** Shows "Clear" in the popover (an optional time). */
  onClear?: Msg
  /** `dense`: 32px high in 13px type, readable when disabled. */
  size?: 'default' | 'dense'
  class?: string
}>

export const HOURS: ReadonlyArray<string> = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'))
export const MINUTES: ReadonlyArray<string> = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, '0'))

// crease/ui calendar picker grid (src/ui/calendar.ts), with six columns.
const GRID_CLASS = 'grid grid-cols-6 gap-1 outline-none'
const CELL_CLASS = 'group/cell flex h-(--cell-size) items-center justify-center rounded-md text-sm'
const CELL_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'ghost' }),
  'group-data-[selected]/cell:hover:bg-primary group-data-[selected]/cell:hover:text-primary-foreground dark:group-data-[selected]/cell:hover:bg-primary dark:group-data-[selected]/cell:hover:text-primary-foreground',
  'h-(--cell-size) w-full px-0 font-normal tabular-nums group-data-[selected]/cell:bg-primary group-data-[selected]/cell:text-primary-foreground',
)
const TRIGGER_CLASS = 'w-full justify-start text-left font-normal align-top tabular-nums'
const PANEL_CLASS = 'z-50 w-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-hidden'
const BACKDROP_CLASS = 'fixed inset-0 z-40'

export const timePickerAnchor = (id: string) => `--anchor-${id}`

export const timePicker = <Msg>(props: TimePickerProps<Msg>, h: HtmlBuilder<Msg>): Html => {
  const isOpen = props.isOpen && props.isDisabled !== true
  const [hour = '', minute = ''] = props.value === '' ? [] : props.value.split(':')
  const panelId = `${props.id}-panel`
  const trigger = h.button(
    [
      h.Type('button'),
      h.Id(props.id),
      h.DataAttribute('slot', 'popover-trigger'),
      h.DataAttribute('value', props.value),
      h.AriaLabel(`${props.ariaLabel}: ${props.value === '' ? (props.placeholder ?? 'none') : props.value}`),
      h.AriaHasPopup('dialog'),
      h.AriaExpanded(isOpen),
      h.AriaControls(panelId),
      ...(props.isInvalid === true ? [h.AriaInvalid(true)] : []),
      ...(props.describedBy === undefined ? [] : [h.AriaDescribedBy(props.describedBy)]),
      ...(props.isDisabled === true ? [h.Disabled(true), h.DataAttribute('disabled', '')] : [h.OnClick(props.onToggle)]),
      h.Style({ anchorName: timePickerAnchor(props.id) }),
      h.Class(cn(buttonVariants({ variant: 'outline' }), TRIGGER_CLASS, props.value === '' && 'text-muted-foreground', props.size === 'dense' && 'h-8 text-[13px] disabled:opacity-100', props.class)),
    ],
    [Icon.icon('clock', {}, h), h.span([h.Class('truncate')], [props.value === '' ? (props.placeholder ?? 'Pick a time') : props.value])],
  )
  if (!isOpen) return h.div([h.Class('contents')], [trigger])

  const grid = (label: string, kind: 'hour' | 'minute', values: ReadonlyArray<string>, selected: string, onPick: (value: string) => Msg) =>
    h.div(
      [h.Class('grid gap-1.5')],
      [
        h.span([h.Id(`${props.id}-${kind}-label`), h.Class('px-1 text-[0.8rem] text-muted-foreground select-none')], [label]),
        h.div(
          [h.Role('listbox'), h.AriaLabelledBy(`${props.id}-${kind}-label`), h.Class(GRID_CLASS)],
          values.map(value =>
            h.div(
              [h.Class(CELL_CLASS), ...(value === selected ? [h.DataAttribute('selected', '')] : [])],
              [
                h.button(
                  [
                    h.Type('button'),
                    h.Id(`${props.id}-${kind}-${value}`),
                    h.Role('option'),
                    h.AriaSelected(value === selected),
                    h.Class(CELL_BUTTON_CLASS),
                    h.OnClick(onPick(value)),
                  ],
                  [kind === 'minute' ? `:${value}` : value],
                ),
              ],
            ),
          ),
        ),
      ],
    )

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
          h.Style(anchoredStyle(timePickerAnchor(props.id))),
        ],
        [
          h.div(
            [h.Class('grid w-64 gap-3 p-3 [--cell-size:--spacing(8)]')],
            [grid('Hour', 'hour', HOURS, hour, props.onHour), grid('Minute', 'minute', MINUTES, minute, props.onMinute)],
          ),
          ...(props.onClear === undefined || props.value === ''
            ? []
            : [
                h.div(
                  [h.Class('flex justify-end border-t px-3 py-2')],
                  [h.button([h.Type('button'), h.Id(`${props.id}-clear`), h.Class(cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'text-muted-foreground')), h.OnClick(props.onClear)], ['Clear'])],
                ),
              ]),
        ],
      ),
    ],
  )
}
