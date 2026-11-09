import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, keyBindings, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { anchoredStyle } from '@/lib/anchored'
import { button, buttonLink } from '@/ui/button'
import { input } from '@/ui/input'
import { textarea } from '@/ui/textarea'

import { requireMember } from '../auth'
import { MAX_MESSAGE, Member, dayLabel, firstName, formatTime, inChannel, isMemberOf } from '../domain'
import { Workspace, type WorkspaceState } from '../store'
import { MAX_DM_PEOPLE } from '../workspace'
import { box, optionRow, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { Nav, emptyNav, NavRow, WORKSPACE_NAME, hasUnread, navOf, rail, sameNav } from '../view/shell'

/* Slack's DMs tab: your direct messages, the most recent first, with who
   wrote last and what, and a filter; beside them "New message", where you
   pick people (To:) and write the first message. Sending opens the
   conversation, the one you already have with those people if there is one. */

/** People suggested in the To field. */
export const SUGGESTED = 8

// MODEL

export const LastMessage = S.Struct({ authorId: S.String, text: S.String, createdAt: S.Number })

export const DmRow = S.Struct({ ...NavRow.fields, memberIds: S.Array(S.String), last: S.NullOr(LastMessage), lastAt: S.Number })
export type DmRow = typeof DmRow.Type

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  dms: S.Array(DmRow),
  nav: Nav,
  now: S.Number,
  /** "Find a DM". */
  filter: S.String,
  /** The people picked in the To field (you are always in it). */
  to: S.Array(S.String),
  toQuery: S.String,
  /** The suggestion Enter picks. */
  toActive: S.Number,
  draft: S.String,
  isSending: S.Boolean,
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedFilter: { text: S.String },
  ChangedToQuery: { text: S.String },
  ChangedDraft: { text: S.String },
  ClickedPerson: { memberId: S.String },
  ClickedRemovePerson: { memberId: S.String },
  SubmittedMessage: {},
  PressedKey: { key: S.Literals(['Enter', 'ArrowDown', 'ArrowUp', 'Backspace', 'Escape']), targetId: S.String },
  ClickedToggleTheme: {},
  ClickedDismissNotice: {},
  GotDms: { dms: S.Array(DmRow), members: S.Array(Member), nav: Nav, me: Member, now: S.Number },
  StartedConversation: { channelId: S.String },
  FailedChange: { reason: S.String },
  CompletedChange: {},
  CompletedBrowserAction: {},
  ChangedConnection: { isConnected: S.Boolean },
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). Typed text arrives
 *  through the inputs' handlers; keys through key bindings. */
export const ClientMessage = S.Union([
  Message.ClickedPerson,
  Message.ClickedRemovePerson,
  Message.SubmittedMessage,
  Message.PressedKey,
  Message.ClickedToggleTheme,
  Message.ClickedDismissNotice,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const StartConversation = Command.define('StartConversation', {
  args: { memberIds: S.Array(S.String), text: S.String, actorId: S.String },
  messages: [Message.StartedConversation, Message.FailedChange],
  execute: ({ memberIds, text, actorId }) =>
    Workspace.use(workspace =>
      Effect.gen(function* () {
        const channel = yield* workspace.openConversation(memberIds, actorId)
        yield* workspace.postMessage(channel.id, text, actorId)
        return Message.StartedConversation({ channelId: channel.id })
      }),
    ).pipe(Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason })))),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

/** Browser actions, forwarded by `clientCommands`. */
export const LoadUrl = Command.define('LoadUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

export const FocusElement = Command.define('FocusElement', {
  args: { selector: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

// DATA

/** Someone's direct messages, the most recent first. */
export const dmsOf = (state: WorkspaceState, me: Member, nav: Nav = navOf(state, me)): ReadonlyArray<DmRow> => {
  const channels = new Map(state.channels.filter(channel => channel.kind === 'dm' && !channel.isArchived && isMemberOf(channel, me.id)).map(channel => [channel.id, channel]))
  const last = new Map<string, Readonly<{ authorId: string; text: string; createdAt: number; index: number }>>()
  state.messages.forEach((message, index) => {
    if (channels.has(message.channelId) && inChannel(message)) last.set(message.channelId, { authorId: message.authorId, text: message.text, createdAt: message.createdAt, index })
  })
  return nav.dms
    .flatMap(row => {
      const channel = channels.get(row.id)
      if (channel === undefined) return []
      const latest = last.get(row.id)
      return [{ row: { ...row, memberIds: channel.memberIds, last: latest === undefined ? null : { authorId: latest.authorId, text: latest.text, createdAt: latest.createdAt }, lastAt: latest?.createdAt ?? channel.createdAt }, index: latest?.index ?? -1 }]
    })
    .sort((a, b) => b.row.lastAt - a.row.lastAt || b.index - a.index)
    .map(({ row }) => row)
}

/** The people the To field suggests for what was typed. */
export const suggestionsOf = (model: Model): ReadonlyArray<Member> => {
  const query = model.toQuery.trim().toLowerCase()
  if (query === '') return []
  return model.members
    .filter(member => !model.to.includes(member.id) && (member.name.toLowerCase().split(/\s+/).some(part => part.startsWith(query)) || member.name.toLowerCase().startsWith(query) || member.email.startsWith(query)))
    .slice(0, SUGGESTED)
}

const keyOf = (memberIds: ReadonlyArray<string>, meId: string) => [...new Set([meId, ...memberIds])].sort().join()

/** The direct message you already have with the people in the To field. */
export const existingOf = (model: Model): DmRow | undefined => {
  if (model.to.length === 0) return undefined
  const key = keyOf(model.to, model.me.id)
  return model.dms.find(row => keyOf(row.memberIds, model.me.id) === key)
}

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; dms: ReadonlyArray<DmRow>; nav: Nav; now: number; to: ReadonlyArray<string> }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({
  model: { ...flags, filter: '', toQuery: '', toActive: 0, draft: '', isSending: false, notice: null },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const pick = (model: Model, memberId: string): UpdateReturn => {
  if (!model.members.some(member => member.id === memberId) || model.to.includes(memberId)) return { model }
  if (new Set([model.me.id, ...model.to, memberId]).size > MAX_DM_PEOPLE) return { model: { ...model, notice: `A direct message has up to ${MAX_DM_PEOPLE} people, you included.` } }
  return { model: { ...model, to: [...model.to, memberId], toQuery: '', toActive: 0 }, commands: [FocusElement({ selector: '#to-input' })] }
}

const send = (model: Model): UpdateReturn => {
  const text = model.draft.trim()
  if (model.to.length === 0 || text === '' || model.isSending) return { model }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, isSending: true }, commands: [StartConversation({ memberIds: model.to, text, actorId: model.me.id })] }
}

const pressed = (model: Model, key: 'Enter' | 'ArrowDown' | 'ArrowUp' | 'Backspace' | 'Escape', targetId: string): UpdateReturn => {
  if (targetId === 'dm-draft') return key === 'Enter' ? send(model) : { model }
  if (targetId !== 'to-input') return { model }
  const found = suggestionsOf(model)
  return M.value(key).pipe(
    M.withReturnType<UpdateReturn>(),
    M.when('Enter', () => {
      const chosen = found[Math.min(model.toActive, found.length - 1)]
      return chosen === undefined ? (model.to.length > 0 ? { model, commands: [FocusElement({ selector: '#dm-draft' })] } : { model }) : pick(model, chosen.id)
    }),
    M.when('ArrowDown', () => ({ model: { ...model, toActive: found.length === 0 ? 0 : (model.toActive + 1) % found.length } })),
    M.when('ArrowUp', () => ({ model: { ...model, toActive: found.length === 0 ? 0 : (model.toActive - 1 + found.length) % found.length } })),
    M.when('Backspace', () => (model.toQuery === '' && model.to.length > 0 ? { model: { ...model, to: model.to.slice(0, -1) } } : { model })),
    M.when('Escape', () => ({ model: { ...model, toQuery: '', toActive: 0 } })),
    M.exhaustive,
  )
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedFilter: ({ text }) => ({ model: { ...model, filter: text.slice(0, 80) } }),
      ChangedToQuery: ({ text }) => ({ model: { ...model, toQuery: text.slice(0, 80), toActive: 0 } }),
      ChangedDraft: ({ text }) => ({ model: { ...model, draft: text } }),
      ClickedPerson: ({ memberId }) => pick(model, memberId),
      ClickedRemovePerson: ({ memberId }) => ({ model: { ...model, to: model.to.filter(id => id !== memberId) } }),
      SubmittedMessage: () => send(model),
      PressedKey: ({ key, targetId }) => pressed(model, key, targetId),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      GotDms: data => {
        const ids = new Set(data.members.map(member => member.id))
        return { model: { ...model, ...data, to: model.to.filter(id => ids.has(id)) } }
      },
      StartedConversation: ({ channelId }) => ({ model: { ...model, draft: '', isSending: false }, commands: [LoadUrl({ url: `/client/${channelId}` })] }),
      FailedChange: ({ reason }) => ({ model: { ...model, isSending: false, notice: reason } }),
      CompletedChange: () => ({ model }),
      CompletedBrowserAction: () => ({ model }),
      // Slack puts you in the To field (or the message, if someone is in it already).
      ChangedConnection: ({ isConnected }) => (isConnected ? { model, commands: [FocusElement({ selector: model.to.length === 0 ? '#to-input' : '#dm-draft' })] } : { model }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ dms: ReadonlyArray<DmRow>; members: ReadonlyArray<Member>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  if (me === null) return { dms: [], members: state.members, nav: emptyNav, me }
  const nav = navOf(state, me)
  return { dms: dmsOf(state, me, nav), members: state.members, nav, me }
}

const sameDm = (a: DmRow, b: DmRow) =>
  a.id === b.id && a.label === b.label && a.isUnread === b.isUnread && a.mentions === b.mentions && a.lastAt === b.lastAt && a.last?.text === b.last?.text && a.last?.authorId === b.last?.authorId && a.memberIds.join() === b.memberIds.join()
const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && a.dms.length === b.dms.length && a.dms.every((row, index) => sameDm(row, b.dms[index] as DmRow)) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  dms: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.me.id }),
      dependenciesToStream: ({ memberId }) =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => sliceOf(state, memberId)),
                Stream.changesWith(sameSlice),
                Stream.filter((slice): slice is Slice & { me: Member } => slice.me !== null),
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotDms({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const personOf = (model: Model, id: string) => model.members.find(member => member.id === id)

const dmIcon = (model: Model, row: DmRow, h: HtmlBuilder<Message>): Html =>
  row.partnerIds.length > 1
    ? box({ as: 'span', class: 'relative size-9 shrink-0', children: [
        avatar(personOf(model, row.partnerIds[0] ?? ''), h, 'md', 'absolute top-0 left-0 size-6 rounded-md text-[10px]'),
        avatar(personOf(model, row.partnerIds[1] ?? ''), h, 'md', 'absolute right-0 bottom-0 size-6 rounded-md text-[10px] ring-2 ring-sidebar'),
      ] }, h)
    : avatar(personOf(model, row.partnerIds[0] ?? ''), h, 'md')

const previewOf = (model: Model, row: DmRow): string => {
  if (row.last === null) return 'No messages yet'
  const author = row.last.authorId === model.me.id ? 'You' : row.partnerIds.length > 1 ? firstName(personOf(model, row.last.authorId)?.name ?? 'Someone') : null
  return author === null ? row.last.text : `${author}: ${row.last.text}`
}

const whenOf = (model: Model, at: number): string => {
  const day = dayLabel(at, model.now)
  return day === 'Today' ? formatTime(at) : day
}

const dmRowView = (model: Model, row: DmRow, h: HtmlBuilder<Message>): Html =>
  buttonLink({
    href: `/client/${row.id}`,
    variant: row.isUnread ? 'dm-row-unread' : 'dm-row',
    size: 'dm',
    children: [
      dmIcon(model, row, h),
      box({ as: 'span', class: 'flex min-w-0 flex-1 flex-col gap-0.5', children: [
          box({ as: 'span', class: 'flex items-baseline gap-2', children: [
              box({ as: 'span', class: 'min-w-0 flex-1 truncate text-[15px]', children: [row.partnerIds.length === 1 && row.partnerIds[0] === model.me.id ? `${row.label} (you)` : row.label] }, h),
              box({ as: 'span', class: 'shrink-0 text-[12px] font-normal opacity-80', children: [row.last === null ? '' : whenOf(model, row.last.createdAt)] }, h),
            ] }, h),
          box({ as: 'span', class: 'min-w-0 truncate text-[13px] font-normal opacity-80', children: [previewOf(model, row)] }, h),
        ] }, h),
    ],
  }, h)

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const filter = model.filter.trim().toLowerCase()
  const rows = filter === '' ? model.dms : model.dms.filter(row => row.label.toLowerCase().includes(filter))
  return box({ as: 'aside', class: slack.dmList, attributes: [h.Id('dm-list'), h.AriaLabel('Direct messages')], children: [
      box({ as: 'header', class: 'flex h-12 shrink-0 items-center gap-1 px-4', children: [
          box({ as: 'h2', class: 'min-w-0 flex-1 truncate text-[18px] font-bold text-sidebar-accent-foreground', children: ['Direct messages'] }, h),
          buttonLink({ href: '/dms', variant: 'sidebar-icon', size: 'icon-sm', ariaLabel: 'New message', children: [Icon.icon('square-pen', {}, h)] }, h),
        ] }, h),
      box({ class: 'px-4 pb-2', children: [
          input({ id: 'dm-filter', type: 'search', value: model.filter, placeholder: 'Find a DM', ariaLabel: 'Find a DM', autocomplete: 'off', onInput: text => Message.ChangedFilter({ text }), variant: 'sidebar-search' }, h),
        ] }, h),
      box({ as: 'nav', class: 'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4', attributes: [h.DataAttribute('keep-scroll', 'dms'), h.AriaLabel('Conversations')], children: rows.length === 0
          ? [box({ as: 'p', class: 'px-2 py-6 text-center text-[13px] opacity-80', children: [filter === '' ? 'No direct messages yet.' : 'No direct messages match.'] }, h)]
          : rows.map(row => dmRowView(model, row, h)) }, h),
    ] }, h)
}

const suggestionsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const found = suggestionsOf(model)
  return box({ class: 'contents', attributes: [h.Id('people-suggestions')], children: model.toQuery.trim() === ''
      ? []
      : [box({ class: 'z-50 flex min-w-[360px] flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]', style: anchoredStyle('--anchor-to', { side: 'bottom', align: 'start' }), attributes: [h.Id('people-picker'), h.Role('listbox'), h.AriaLabel('People')], children: found.length === 0
          ? [box({ class: 'px-2 py-3 text-[13px] text-muted-foreground', children: ['No one matches'] }, h)]
          : found.map((member, index) =>
              optionRow({ id: `person-${member.id}`, value: member.id, isActive: index === Math.min(model.toActive, found.length - 1), onClick: Message.ClickedPerson({ memberId: member.id }), children: [
                  avatar(member, h, 'sm'),
                  box({ as: 'span', class: 'font-semibold', children: [member.id === model.me.id ? `${member.name} (you)` : member.name] }, h),
                  box({ as: 'span', class: 'min-w-0 flex-1 truncate text-muted-foreground', children: [member.title] }, h),
                ] }, h),
            ) }, h)] }, h)
}

const toView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: slack.toField, style: { anchorName: '--anchor-to' }, attributes: [h.Id('recipient-field')], children: [
      box({ as: 'span', class: 'text-[15px] text-muted-foreground', children: ['To:'] }, h),
      ...model.to.map(id => {
        const member = personOf(model, id)
        return button({ variant: 'person-chip', size: 'xs', ariaLabel: `Remove ${member?.name ?? 'Someone'}`, title: 'Remove', onClick: Message.ClickedRemovePerson({ memberId: id }), marker: ['person', id], children: [avatar(member, h, 'xs'), member?.name ?? 'Someone', Icon.x({ class: 'size-3' }, h)] }, h)
      }),
      box({ class: 'min-w-[160px] flex-1', children: [
          input({ id: 'to-input', value: model.toQuery, placeholder: model.to.length === 0 ? 'Type the name of a coworker' : '', ariaLabel: 'To', autocomplete: 'off', onInput: text => Message.ChangedToQuery({ text }), variant: 'inline' }, h),
        ] }, h),
    ] }, h)

const bodyView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const people = model.to.map(id => personOf(model, id)).filter(member => member !== undefined)
  const existing = existingOf(model)
  const names = people.map(member => (member.id === model.me.id ? 'yourself' : member.name)).join(', ')
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('new-message-body')], children: [
      box({ class: 'flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto px-5 pb-4', children: people.length === 0
          ? [box({ class: 'flex flex-1 flex-col items-center justify-center gap-2 text-center', children: [
              Icon.icon('send', { class: 'size-10 text-muted-foreground' }, h),
              box({ as: 'h2', class: 'text-[18px] font-bold', children: ['Start a conversation'] }, h),
              box({ as: 'p', class: 'max-w-[360px] text-[14px] text-muted-foreground', children: ['Add one or more people in the To field to message them directly.'] }, h),
            ] }, h)]
          : [
              box({ class: 'flex items-center gap-1', children: people.slice(0, 4).map(member => avatar(member, h, 'lg')) }, h),
              box({ as: 'p', class: 'text-[15px]', children: [
                  existing === undefined ? `This is the very beginning of your direct message history with ${names}.` : `You already have a conversation with ${names}. Your message continues it.`,
                ] }, h),
              ...(existing === undefined ? [] : [buttonLink({ href: `/client/${existing.id}`, variant: 'outline', size: 'sm', class: 'self-start', children: ['Open conversation'] }, h)]),
            ] }, h),
      box({ as: 'form', class: slack.composer, attributes: [h.OnSubmit(Message.SubmittedMessage())], children: [
          textarea({ id: 'dm-draft', value: model.draft, rows: 1, placeholder: people.length === 0 ? 'Start a new message' : `Message ${names}`, onInput: text => Message.ChangedDraft({ text }), ariaLabel: 'Message', resize: 'none', variant: 'slack-composer' }, h),
          box({ class: 'flex items-center justify-end px-2 pb-1.5', children: [
              button({ variant: 'send', size: 'icon-md', type: 'submit', ariaLabel: 'Send now', title: 'Send now', isDisabled: people.length === 0 || model.draft.trim() === '' || model.isSending, children: [Icon.icon('send', {}, h)] }, h),
            ] }, h),
        ] }, h),
    ] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Direct messages - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      region(h, { id: 'rail', deps: [model.me, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, active: 'dms', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          region(h, { id: 'dm-list', deps: [model.dms, model.members, model.filter, model.now, model.me.id], render: () => listView(model, h) }),
          box({ as: 'main', class: slack.main, children: [
              box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', attributes: [h.Id('new-message-header')], children: [
                  box({ as: 'h1', class: 'text-[18px] font-black', children: ['New message'] }, h),
                ] }, h),
              region(h, { id: 'recipient-field', deps: [model.to, model.toQuery, model.members], render: () => toView(model, h) }),
              region(h, { id: 'new-message-body', deps: [model.to, model.members, model.dms, model.draft, model.isSending, model.me.id], render: () => bodyView(model, h) }),
            ] }, h),
        ] }, h),
      region(h, { id: 'people-suggestions', deps: [model.toQuery, model.toActive, model.to, model.members], render: () => suggestionsView(model, h) }),
      region(h, {
        id: 'keys',
        deps: [],
        render: () =>
          box({ attributes: [h.Id('keys')], children: [
              keyBindings(h, (['Enter', 'ArrowDown', 'ArrowUp', 'Backspace', 'Escape'] as const).map(key => ({ keys: key, whileTyping: 'Allow' as const, message: ({ targetId }: { targetId: string }) => Message.PressedKey({ key, targetId }) }))),
            ] }, h),
      }),
      region(h, {
        id: 'notice',
        deps: [model.notice],
        render: () =>
          box({ class: 'pointer-events-none fixed right-4 bottom-24 z-50', attributes: [h.Id('notice'), h.AriaLive('polite')], children: model.notice === null
              ? []
              : [box({ class: 'pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3.5 py-2.5 text-[14px] shadow-lg', children: [
                  Icon.icon('circle-alert', { class: 'size-4 text-destructive' }, h),
                  box({ as: 'span', children: [model.notice] }, h),
                  button({ variant: 'ghost', size: 'icon-xs', ariaLabel: 'Dismiss', onClick: Message.ClickedDismissNotice(), children: [Icon.x({}, h)] }, h),
                ] }, h)] }, h),
      }),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'dms',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      const nav = navOf(state, me)
      // `/dms?to=mem_x` starts a message to someone (from a profile, say).
      const asked = request.url.searchParams.get('to') ?? ''
      const to = state.members.some(member => member.id === asked) ? [asked] : []
      return { me, members: state.members, dms: dmsOf(state, me, nav), nav, now, to }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  clientCommands: {
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
    LoadUrl: ({ url }) => (typeof url === 'string' && url.startsWith('/client/') ? { load: url } : undefined),
  },
  snapshotDeps: model => [model.filter, model.to, model.toQuery, model.toActive, model.draft, model.notice],
}
