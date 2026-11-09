import { type VariantProps, cva } from 'class-variance-authority'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'
import {
  type ButtonBehaviorProps,
  type ButtonLinkBehaviorProps,
  renderButton,
  renderButtonLink,
} from '@/lib/button'

/* Ported from shadcn/ui button.tsx. The cva config is copied verbatim except:
   - `disabled:` variants became `data-[disabled]:` + `aria-disabled:` because
     the foldkit Button primitive signals disabled state via aria-disabled and
     a data-disabled attribute rather than the native disabled attribute. */
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px data-[disabled]:pointer-events-none data-[disabled]:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40',
        // A confirmed destructive action (Slack's red Delete).
        danger: 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
        // The Slack frame (rail and sidebar) on its dark sidebar colours.
        sidebar: 'w-full justify-start font-normal text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'sidebar-unread': 'w-full justify-start font-bold text-sidebar-accent-foreground hover:bg-sidebar-accent',
        'sidebar-active': 'w-full justify-start font-medium bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary',
        'sidebar-icon': 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent',
        rail: 'text-sidebar-foreground hover:text-sidebar-accent-foreground [&_[data-slot=rail-icon]]:hover:bg-sidebar-accent',
        'rail-active': 'text-sidebar-accent-foreground [&_[data-slot=rail-icon]]:bg-sidebar-accent',
        // Reactions under a message: a pill, blue when you are one of them.
        reaction: 'h-6 gap-1 rounded-full border-border bg-muted/60 px-1.5 text-[12px] font-semibold text-muted-foreground hover:border-muted-foreground/40 hover:bg-background',
        'reaction-mine': 'h-6 gap-1 rounded-full border-link/60 bg-link/10 px-1.5 text-[12px] font-semibold text-link hover:bg-link/15',
        // A cell of the emoji picker and the hover toolbar's buttons.
        emoji: 'text-[20px] hover:bg-muted',
        toolbar: 'text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted',
        // A thread's replies under its message: avatars, "3 replies", last reply.
        'thread-summary': 'h-8 w-full max-w-[560px] justify-start gap-2 rounded-md border-transparent px-1 text-[13px] font-normal text-muted-foreground hover:border-border hover:bg-background',
        // "replied to a thread: …" above a reply also sent to the channel.
        'replied-to': 'h-5 max-w-full min-w-0 justify-start overflow-hidden px-0 text-[12px] font-normal text-link hover:underline',
        // The conversation a card of the Threads view is in.
        'thread-channel': 'h-6 justify-start self-start px-0 has-data-[icon=inline-start]:pl-0 text-[15px] font-bold text-foreground hover:underline',
        // A direct message in the DMs tab: avatar, name and time, last message.
        'dm-row': 'w-full justify-start text-left text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        'dm-row-unread': 'w-full justify-start text-left font-bold text-sidebar-accent-foreground hover:bg-sidebar-accent',
        // Someone picked in the To field; clicking takes them out.
        'person-chip': 'h-7 gap-1.5 rounded-md bg-link/10 px-1.5 text-[14px] font-semibold text-link hover:bg-link/20',
        // The composer's send button: grey until there is something to send.
        send: 'bg-primary text-primary-foreground hover:bg-primary/90 data-[disabled]:bg-transparent data-[disabled]:text-muted-foreground data-[disabled]:opacity-100 aria-disabled:bg-transparent aria-disabled:text-muted-foreground aria-disabled:opacity-100',
      },
      size: {
        default:
          'h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-9',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md',
        'icon-lg': 'size-10',
        compact:
          'h-7 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 text-[12px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        dense:
          'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 text-[13px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        'icon-md': 'size-7 rounded-[min(var(--radius-md),10px)]',
        // A sidebar row: 28 px, Slack's 15 px label.
        row: "h-7 gap-2 rounded-md px-2.5 text-[15px] [&_svg:not([class*='size-'])]:size-4",
        // A row of the DMs tab: two lines beside a 36 px avatar.
        dm: 'h-auto items-start gap-2.5 rounded-lg px-2 py-2 whitespace-normal',
        // A rail item: icon tile above a small label.
        rail: "h-auto flex-col gap-1 p-0 text-[11px] font-semibold [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>

export type ButtonProps<Msg> = ButtonBehaviorProps<Msg> &
  Readonly<{
    variant?: ButtonVariants['variant']
    size?: ButtonVariants['size']
    class?: string
    /** CSS anchor name: the popover this button opens is placed against it
     *  (src/lib/anchored.ts). */
    anchorName?: string
    /** What the button opens (aria-haspopup) and whether it is open. */
    popup?: 'menu' | 'dialog'
    isExpanded?: boolean
    /** A toggle button's state (aria-pressed). */
    isPressed?: boolean
    /** A marker the page's own code or tests find the button by: data-<name>. */
    marker?: readonly [name: string, value: string]
  }>

export const button = <Msg>(
  props: ButtonProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  const variant = props.variant ?? 'default'
  const size = props.size ?? 'default'
  return renderButton(
    props,
    [
      h.DataAttribute('variant', variant),
      ...(props.dataSize === undefined ? [h.DataAttribute('size', size)] : []),
      h.Class(cn(buttonVariants({ variant, size }), props.class)),
      ...(props.anchorName === undefined ? [] : [h.Style({ anchorName: props.anchorName })]),
      ...(props.popup === undefined ? [] : [h.AriaHasPopup(props.popup)]),
      ...(props.isExpanded === undefined ? [] : [h.AriaExpanded(props.isExpanded)]),
      ...(props.isPressed === undefined ? [] : [h.AriaPressed(String(props.isPressed))]),
      ...(props.marker === undefined ? [] : [h.DataAttribute(props.marker[0], props.marker[1])]),
    ],
    h,
  )
}

export type ButtonLinkProps = ButtonLinkBehaviorProps &
  Readonly<{
    variant?: ButtonVariants['variant']
    size?: ButtonVariants['size']
    class?: string
  }>

export const buttonLink = <Msg>(
  props: ButtonLinkProps,
  h: HtmlBuilder<Msg>,
): Html => {
  const variant = props.variant ?? 'default'
  const size = props.size ?? 'default'
  return renderButtonLink(
    props,
    [
      h.DataAttribute('variant', variant),
      ...(props.dataSize === undefined ? [h.DataAttribute('size', size)] : []),
      h.Class(cn(buttonVariants({ variant, size }), props.class)),
    ],
    h,
  )
}
