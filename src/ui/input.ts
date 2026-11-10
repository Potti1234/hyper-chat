import type { Html, HtmlBuilder } from 'foldkit/html'

import { type InputBehaviorProps, renderInput } from '@/lib/input'
import { cn } from '@/lib/utils'

/* Ported from shadcn/ui input.tsx + label.tsx. Class strings verbatim — the
   foldkit Input primitive sets the native disabled attribute as well as
   data-disabled, so shadcn's `disabled:` variants work unchanged. The primitive
   also wires label/description ids for free via its attribute groups. */

const INPUT_CLASS =
  'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'

/* Borderless variants for inputs that sit inside another surface: the
   picker's search field and inline title editors. They keep the 13px+ type of
   the app (the page is not zoomed on iOS: these are desktop-first views). */
export const inputVariants = {
  default: '',
  inline: 'h-9 border-0 bg-transparent text-[13px] shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent',
  'inline-lg': 'h-12 border-0 bg-transparent text-[15px] shadow-none focus-visible:ring-0 md:text-[15px] dark:bg-transparent',
  compact: 'h-7 text-[13px] md:text-[13px]',
  dense: 'h-8 text-[13px] md:text-[13px]',
  // Find a DM: on the sidebar's colours.
  'sidebar-search': 'h-8 border-sidebar-border bg-sidebar-accent/40 text-[13px] text-sidebar-accent-foreground shadow-none placeholder:text-sidebar-foreground/70 md:text-[13px] dark:bg-sidebar-accent/40',
  // The top bar's search field on the frame colours.
  'top-search': 'h-7 w-full border-white/25 bg-white/15 pl-8 text-[13px] text-white shadow-none placeholder:text-white/70 focus-visible:bg-background focus-visible:text-foreground focus-visible:placeholder:text-muted-foreground md:text-[13px] dark:bg-white/10',
  search: 'h-7 pl-7 text-[13px] shadow-none md:text-[13px]',
  'title-xl': 'h-auto border-0 px-0 py-1 text-[32px] font-bold tracking-[-0.02em] shadow-none focus-visible:ring-0 md:text-[32px] dark:bg-transparent',
  'title-lg': 'h-auto border-0 px-0 py-1 text-[22px] font-semibold tracking-[-0.01em] shadow-none focus-visible:ring-0 aria-invalid:ring-0 md:text-[22px] dark:bg-transparent',
  'title-md': 'h-9 border-0 px-0 text-[18px] font-semibold shadow-none focus-visible:ring-0 aria-invalid:ring-0 md:text-[18px] dark:bg-transparent',
} as const
export type InputVariant = keyof typeof inputVariants

const LABEL_CLASS =
  'flex items-center gap-2 text-sm leading-none font-medium select-none'

const DESCRIPTION_CLASS = 'text-muted-foreground text-sm'

export type InputProps<Msg> = InputBehaviorProps<Msg> &
  Readonly<{
    variant?: InputVariant
    class?: string
  }>

export const input = <Msg>(
  props: InputProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  return renderInput(
    props,
    {
      field: [h.Class('grid gap-2')],
      label: [h.Class(LABEL_CLASS)],
      input: [h.Class(cn(INPUT_CLASS, inputVariants[props.variant ?? 'default'], props.class))],
      description: [h.Class(DESCRIPTION_CLASS)],
    },
    h,
  )
}
