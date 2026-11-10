import type { Html, HtmlBuilder } from 'foldkit/html'
import { text } from '@/ui/text'
import { toggle } from '@/ui/toggle'
import { box } from './design'

/** One card in a pick-one group: a pressed outline toggle with a label, an
 *  optional description and leading media (icons or swatches). */
export const choice = <Msg>(
  props: Readonly<{ id: string; isActive: boolean; onPick: Msg; label: string; description?: string; media: ReadonlyArray<Html> }>,
  h: HtmlBuilder<Msg>,
): Html =>
  toggle({
    id: props.id,
    isPressed: props.isActive,
    onToggle: props.onPick,
    variant: 'outline',
    size: 'card',
    ariaLabel: props.label,
    children: [
      box({ class: 'flex shrink-0 items-center gap-1', children: props.media }, h),
      box({ class: 'min-w-0', children: [
          text({ children: [props.label], type: 'body', weight: 'medium', display: 'block' }, h),
          ...(props.description === undefined ? [] : [text({ children: [props.description], type: 'supporting', color: 'secondary', display: 'block' }, h)]),
        ] }, h),
    ],
  }, h)
