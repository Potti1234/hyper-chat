import type { Html, HtmlBuilder } from 'foldkit/html'

import { type TextareaBehaviorProps, renderTextarea } from '@/lib/textarea'
import { cn } from '@/lib/utils'

/* Ported from shadcn/ui textarea.tsx. The textarea class string is verbatim.
   The foldkit Textarea primitive sets the native disabled attribute, so
   shadcn's `disabled:` variants work unchanged. It also wires the optional
   label and description to the textarea through its attribute groups. */

const TEXTAREA_CLASS =
  'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40'

const LABEL_CLASS =
  'flex items-center gap-2 text-sm leading-none font-medium select-none'

const DESCRIPTION_CLASS = 'text-muted-foreground text-sm'

const RESIZE_CLASS = {
  none: 'resize-none',
  vertical: 'resize-y',
  horizontal: 'resize-x',
  both: 'resize',
} as const

/* Borderless variants for text that is edited in place (descriptions). */
export const textareaVariants = {
  default: '',
  inline: 'min-h-20 rounded-md border-transparent bg-transparent px-0 py-1 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 md:text-[14px] dark:bg-transparent',
  'inline-grow': 'field-sizing-content min-h-32 rounded-md border-transparent bg-transparent px-0 py-1 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 md:text-[14px] dark:bg-transparent',
  'note': 'field-sizing-content min-h-20 rounded-md border bg-transparent px-3 py-2 text-[13px] shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[13px]',
  'message-edit': 'field-sizing-content max-h-60 min-h-10 rounded-md border bg-background px-3 py-2 text-[14px] shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[14px]',
  'composer': 'field-sizing-content max-h-48 min-h-10 rounded-lg border bg-background px-3 py-2.5 text-[14px] shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[14px]',
  'comment': 'field-sizing-content block min-h-16 rounded-none border-0 bg-transparent px-3.5 pt-3 text-[13.5px] shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent',
  'bare': 'min-h-24 rounded-none border-0 bg-transparent px-0 py-1 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-[14px] dark:bg-transparent',
} as const

export type TextareaProps<Msg> = Omit<TextareaBehaviorProps<Msg>, 'attributes'> &
  Readonly<{
    variant?: keyof typeof textareaVariants
    ariaLabel?: string
    /** Sent when the field loses focus (save on blur). */
    onBlur?: Msg
    class?: string
  }>

export const textarea = <Msg>(
  props: TextareaProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  return renderTextarea(
    {
      ...props,
      attributes: [
        ...(props.ariaLabel === undefined ? [] : [h.AriaLabel(props.ariaLabel)]),
        ...(props.onBlur === undefined ? [] : [h.OnBlur(props.onBlur)]),
      ],
    },
    {
      field: [h.Class('grid gap-2')],
      label: [h.Class(LABEL_CLASS)],
      textarea: [
        h.Class(
          cn(
            TEXTAREA_CLASS,
            RESIZE_CLASS[props.resize ?? 'vertical'],
            textareaVariants[props.variant ?? 'default'],
            props.class,
          ),
        ),
      ],
      description: [h.Class(DESCRIPTION_CLASS)],
    },
    h,
  )
}
