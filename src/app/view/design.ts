import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'

/* The app's owned design layer (crease.lock.json: hyperchat/view): the
   domain patterns creaseui has no component for: the Slack frame (rail,
   sidebar, panes), message rows and reaction pills. Region roots carry h.Id
   (hyper-effect morphs by id). Component CSS for these roots is in
   design.css; colours come from theme tokens. */

export type BoxElement =
  | 'div' | 'span' | 'p' | 'a' | 'ul' | 'ol' | 'li' | 'header' | 'footer' | 'main' | 'aside' | 'nav'
  | 'section' | 'article' | 'form' | 'label' | 'strong' | 'em' | 'code' | 'pre' | 'h1' | 'h2' | 'h3'
  | 'button' | 'br'

type Attributes<Msg> = ReadonlyArray<Attribute<Msg> | ChildAttribute>
type Builder<Msg> = (attributes: Attributes<Msg>, children: ReadonlyArray<Html | string>) => Html

/** A plain element for layout that keeps its own utility classes. */
export const box = <Msg>(
  props: Readonly<{
    as?: BoxElement
    id?: string
    class?: string | undefined
    style?: Readonly<Record<string, string>> | undefined
    attributes?: NoInfer<Attributes<Msg>>
    children?: ReadonlyArray<Html | string>
  }>,
  h: HtmlBuilder<Msg>,
): Html =>
  (h[props.as ?? 'div'] as Builder<Msg>)(
    [
      ...(props.id === undefined ? [] : [h.Id(props.id)]),
      ...(props.attributes ?? []),
      ...(props.class === undefined || props.class === '' ? [] : [h.Class(props.class)]),
      ...(props.style === undefined ? [] : [h.Style(props.style)]),
    ],
    [...(props.children ?? [])],
  )

/** A color chip with a runtime CSS color (theme preset previews). */
export const swatch = <Msg>(props: Readonly<{ color: string }>, h: HtmlBuilder<Msg>): Html =>
  h.span([h.Class('inline-block size-6 shrink-0 rounded-md border'), h.Style({ background: props.color })], [])

/** A listbox option of the pickers and menus: a roving-focus row whose
 *  active state the page moves before the server answers (data-active). */
export const optionRow = <Msg>(
  props: Readonly<{
    id: string
    value: string
    isActive: boolean
    onClick: Msg
    children: ReadonlyArray<Html | string>
  }>,
  h: HtmlBuilder<Msg>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Role('option'),
      h.Id(props.id),
      h.AriaSelected(props.isActive),
      h.DataAttribute('active', String(props.isActive)),
      h.DataAttribute('value', props.value),
      h.Tabindex(-1),
      h.Class('relative flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-hidden select-none hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-accent-foreground'),
      h.OnClick(props.onClick),
    ],
    [...props.children],
  )

/** The page root: light/dark and the member's theme preset as classes. */
export const pageRoot = <Msg>(
  props: Readonly<{ isDark: boolean; theme: string; class?: string; children: ReadonlyArray<Html> }>,
  h: HtmlBuilder<Msg>,
): Html =>
  h.div(
    [h.Id('app'), h.Class(cn('app-root flex h-dvh overflow-hidden bg-background text-foreground', props.isDark && 'dark', props.theme !== '' && `theme-${props.theme}`, props.class))],
    [...props.children],
  )

/** Classes of the Slack frame and message list (design.css), named once. */
export const slack = {
  frame: 'slack-frame',
  rail: 'slack-rail',
  railDot: 'rail-dot',
  workspaceIcon: 'workspace-icon',
  presenceDot: 'presence-dot',
  sidebar: 'slack-sidebar',
  dmCount: 'dm-count',
  main: 'slack-main',
  messageRow: 'message-row',
  messageGutter: 'message-gutter',
  messageHoverTime: 'message-hover-time',
  messageText: 'message-text',
  mention: 'mention',
  dayDivider: 'day-divider',
  newDivider: 'new-divider',
  composer: 'composer',
} as const
