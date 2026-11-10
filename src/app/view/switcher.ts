import { Effect, Match as M, Schema as S } from 'effect'
import { Command } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { keyBindings, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import * as Dialog from '@/ui/dialog'
import { input } from '@/ui/input'
import { kbd, kbdGroup } from '@/ui/kbd'

import { type Member, handleOf } from '../domain'
import { box, optionRow } from './design'
import { avatar } from './icons'
import type { Nav } from './shell'

/* Slack's quick switcher (Ctrl/Cmd+K) on every page: a dialog with a field
   that jumps to a channel, a direct message or a person; the last row
   searches for what you typed. Arrows move, Enter opens. Each page keeps a
   `switcher` in its Model and forwards a `GotSwitcher` Message here. */

export const Switcher = S.Struct({ dialog: Dialog.Model, query: S.String, active: S.Number })
export type Switcher = typeof Switcher.Type

export const initSwitcher = (): Switcher => ({ dialog: Dialog.init({ id: 'switcher' }), query: '', active: 0 })

export const MAX_SWITCHER_QUERY = 100
/** The most rows the switcher lists before its search row. */
export const MAX_SWITCHER_ROWS = 8

export const SwitcherEvent = S.Union([
  S.TaggedStruct('Toggled', {}),
  S.TaggedStruct('ChangedQuery', { text: S.String }),
  S.TaggedStruct('Moved', { by: S.Number }),
  S.TaggedStruct('PressedEnter', { targetId: S.String }),
  S.TaggedStruct('ClickedItem', { index: S.Number }),
  S.TaggedStruct('GotDialog', { message: Dialog.Message }),
  S.TaggedStruct('Completed', {}),
])
export type SwitcherEvent = typeof SwitcherEvent.Type

/** What a browser may post (keys run in the session). */
export const SwitcherClientEvent = S.Union([
  S.TaggedStruct('ChangedQuery', { text: S.String }),
  S.TaggedStruct('ClickedItem', { index: S.Number }),
  S.TaggedStruct('GotDialog', { message: Dialog.Message.RequestedClose }),
])

const Completed = (): SwitcherEvent => ({ _tag: 'Completed' })

/** Loads a page in the browser (a forwarded client command). */
export const SwitchTo = Command.define('SwitchTo', {
  args: { url: S.String },
  messages: [S.TaggedStruct('Completed', {})],
  execute: () => Effect.succeed({ _tag: 'Completed' as const }),
})

/** For each page's `clientCommands`: only same-site addresses load. */
export const switcherClientCommands = {
  SwitchTo: ({ url }: Readonly<Record<string, unknown>>) => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? { load: url } : undefined),
}

// ITEMS

export type SwitcherItem = Readonly<{ id: string; kind: 'public' | 'private' | 'dm' | 'person' | 'search'; label: string; detail: string; href: string; member: Member | null }>

const matches = (text: string, terms: ReadonlyArray<string>) => {
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
}

/** The rows for a query: your channels and DMs, then people you have no DM
 *  with; with a query, a last row searching for it. */
export const switcherItems = (query: string, nav: Nav, members: ReadonlyArray<Member>, me: Member): ReadonlyArray<SwitcherItem> => {
  const text = query.trim()
  const terms = text.toLowerCase().replace(/^[#@]/, '').split(/\s+/).filter(term => term !== '')
  const byId = new Map(members.map(member => [member.id, member]))
  const withDm = new Set(nav.dms.filter(row => row.partnerIds.length === 1).flatMap(row => row.partnerIds))
  const conversations: Array<SwitcherItem> = [...nav.channels, ...nav.dms]
    .filter(row => matches(row.label, terms))
    .sort((a, b) => Number(b.isUnread) - Number(a.isUnread))
    .map(row => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      detail: row.kind === 'dm' ? (row.partnerIds.length === 1 ? byId.get(row.partnerIds[0] ?? '')?.title ?? '' : 'Group conversation') : row.isUnread ? 'Unread' : '',
      href: `/client/${row.id}`,
      member: row.kind === 'dm' && row.partnerIds.length === 1 ? byId.get(row.partnerIds[0] ?? '') ?? null : null,
    }))
  const people: Array<SwitcherItem> =
    terms.length === 0
      ? []
      : members
          .filter(member => member.id !== me.id && !withDm.has(member.id) && matches(`${member.name} ${handleOf(member)} ${member.title}`, terms))
          .map(member => ({ id: member.id, kind: 'person', label: member.name, detail: member.title, href: `/dms?to=${member.id}`, member }))
  const rows = [...conversations, ...people].slice(0, MAX_SWITCHER_ROWS)
  return text === '' ? rows : [...rows, { id: 'search', kind: 'search', label: text, detail: 'Search messages, channels and people', href: `/search?q=${encodeURIComponent(text)}`, member: null }]
}

// UPDATE

type SwitcherReturn = Readonly<{ switcher: Switcher; commands: ReadonlyArray<Command.Command<SwitcherEvent>> }>

const withDialog = (switcher: Switcher, result: ReturnType<typeof Dialog.update>): SwitcherReturn => ({
  switcher: { ...switcher, dialog: result.model, ...(result.model.isOpen ? {} : { query: '', active: 0 }) },
  commands: Command.mapMessages(result.commands, message => ({ _tag: 'GotDialog' as const, message })),
})

const go = (switcher: Switcher, item: SwitcherItem | undefined): SwitcherReturn => {
  if (item === undefined) return { switcher, commands: [] }
  const closed = withDialog(switcher, Dialog.close(switcher.dialog))
  return { switcher: closed.switcher, commands: [...closed.commands, Command.mapMessage(SwitchTo({ url: item.href }), Completed)] }
}

export const updateSwitcher = (switcher: Switcher, event: SwitcherEvent, items: (query: string) => ReadonlyArray<SwitcherItem>): SwitcherReturn =>
  M.value(event).pipe(
    M.withReturnType<SwitcherReturn>(),
    M.tagsExhaustive({
      Toggled: () => withDialog({ ...switcher, query: '', active: 0 }, switcher.dialog.isOpen ? Dialog.close(switcher.dialog) : Dialog.open(switcher.dialog)),
      ChangedQuery: ({ text }) => ({ switcher: switcher.dialog.isOpen ? { ...switcher, query: text.slice(0, MAX_SWITCHER_QUERY), active: 0 } : switcher, commands: [] }),
      Moved: ({ by }) => {
        const count = items(switcher.query).length
        return { switcher: !switcher.dialog.isOpen || count === 0 ? switcher : { ...switcher, active: (((switcher.active + by) % count) + count) % count }, commands: [] }
      },
      PressedEnter: ({ targetId }) => (switcher.dialog.isOpen && targetId === 'switcher-input' ? go(switcher, items(switcher.query)[switcher.active]) : { switcher, commands: [] }),
      ClickedItem: ({ index }) => (switcher.dialog.isOpen ? go(switcher, items(switcher.query)[index]) : { switcher, commands: [] }),
      GotDialog: ({ message }) => withDialog(switcher, Dialog.update(switcher.dialog, message)),
      Completed: () => ({ switcher, commands: [] }),
    }),
  )

// VIEW

type SwitcherViewProps<Msg> = Readonly<{
  switcher: Switcher
  items: ReadonlyArray<SwitcherItem>
  toMessage: (event: SwitcherEvent) => Msg
}>

const itemIcon = <Msg>(item: SwitcherItem, h: HtmlBuilder<Msg>): Html =>
  item.member !== null
    ? avatar(item.member, h, 'sm')
    : item.kind === 'dm'
      ? Icon.icon('users', { class: 'size-4 text-muted-foreground' }, h)
      : Icon.icon(item.kind === 'private' ? 'lock' : item.kind === 'search' ? 'search' : 'hash', { class: 'size-4 text-muted-foreground' }, h)

/** The key bindings (Ctrl/Cmd+K anywhere; arrows and Enter while open). */
export const switcherKeys = <Msg>(props: SwitcherViewProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  keyBindings(
    h,
    [
      { keys: 'Mod+K', whileTyping: 'Allow', message: () => props.toMessage({ _tag: 'Toggled' }) },
      { keys: 'ArrowDown', whileTyping: 'Allow', isEnabled: props.switcher.dialog.isOpen, message: () => props.toMessage({ _tag: 'Moved', by: 1 }) },
      { keys: 'ArrowUp', whileTyping: 'Allow', isEnabled: props.switcher.dialog.isOpen, message: () => props.toMessage({ _tag: 'Moved', by: -1 }) },
      { keys: 'Enter', whileTyping: 'Allow', isEnabled: props.switcher.dialog.isOpen, message: ({ targetId }) => props.toMessage({ _tag: 'PressedEnter', targetId }) },
    ],
    { id: 'switcher-keys' },
  )

export const switcherDialog = <Msg>(props: SwitcherViewProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  Dialog.dialog(
    {
      model: props.switcher.dialog,
      toParentMessage: message => props.toMessage({ _tag: 'GotDialog', message }),
      title: 'Jump to…',
      variant: 'switcher',
      showCloseButton: false,
      content: ({ initialFocusAttributes }) => [
        box({ class: 'relative', children: [
            Icon.icon('search', { class: 'pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground' }, h),
            input({ id: 'switcher-input', value: props.switcher.query, placeholder: 'Search for channels, people or messages', ariaLabel: 'Jump to', autocomplete: 'off', role: 'combobox', initialFocus: initialFocusAttributes(), onInput: text => props.toMessage({ _tag: 'ChangedQuery', text }), variant: 'switcher' }, h),
          ] }, h),
        box({ class: 'flex max-h-[360px] flex-col gap-0.5 overflow-y-auto overscroll-contain', attributes: [h.Id('switcher-items'), h.Role('listbox'), h.AriaLabel('Conversations')], children: props.items.length === 0
            ? [box({ class: 'px-2 py-3 text-[13px] text-muted-foreground', children: ['No conversations yet'] }, h)]
            : props.items.map((item, index) =>
                optionRow({ id: `switch-${item.id}`, value: item.href, isActive: index === props.switcher.active, onClick: props.toMessage({ _tag: 'ClickedItem', index }), children: [
                    itemIcon(item, h),
                    box({ as: 'span', class: 'min-w-0 truncate font-semibold', children: [item.kind === 'search' ? `Search for “${item.label}”` : item.label] }, h),
                    box({ as: 'span', class: 'min-w-0 flex-1 truncate text-muted-foreground', children: [item.detail] }, h),
                  ] }, h),
              ) }, h),
        box({ as: 'p', class: 'flex items-center gap-1 text-[12px] text-muted-foreground', children: [kbdGroup({ children: [kbd({ children: [Icon.arrowUp({}, h)] }, h), kbd({ children: [Icon.arrowDown({}, h)] }, h)] }, h), 'to move ·', kbd({ children: ['Enter'] }, h), 'to open ·', kbd({ children: ['Esc'] }, h), 'to close'] }, h),
      ],
    },
    h,
  )

// PAGES

type Host = Readonly<{ switcher: Switcher; nav: Nav; members: ReadonlyArray<Member>; me: Member }>

/** A page's `GotSwitcher` case. */
export const updateHost = <Model extends Host, Msg>(model: Model, event: SwitcherEvent, toMessage: (event: SwitcherEvent) => Msg): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Msg>> }> => {
  const result = updateSwitcher(model.switcher, event, query => switcherItems(query, model.nav, model.members, model.me))
  return { model: { ...model, switcher: result.switcher }, commands: Command.mapMessages(result.commands, toMessage) }
}

/** A page's switcher region: its keys and dialog. */
export const switcherRegion = <Msg>(model: Host, toMessage: (event: SwitcherEvent) => Msg, h: HtmlBuilder<Msg>): Html =>
  region(h, {
    id: 'switcher-host',
    deps: [model.switcher, model.nav, model.members, model.me],
    render: () => {
      const props = { switcher: model.switcher, items: switcherItems(model.switcher.query, model.nav, model.members, model.me), toMessage }
      return box({ attributes: [h.Id('switcher-host')], children: [switcherKeys(props, h), switcherDialog(props, h)] }, h)
    },
  })
