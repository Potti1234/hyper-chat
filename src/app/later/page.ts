import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { button, buttonLink } from '@/ui/button'

import { requireMember } from '../auth'
import { ChannelKind, Member, Message as ChatMessage, SavedState, canRead, conversationName, dayLabel, formatTime } from '../domain'
import { Workspace, type WorkspaceState } from '../store'
import { box, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { messageText } from '../view/message'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, topBar, WORKSPACE_NAME } from '../view/shell'

/* Slack's Later: messages you saved, in progress or completed, newest
   saved first. Each one can be completed, moved back or removed, and
   links to where it was said. */

// MODEL

export const LaterItem = S.Struct({
  state: SavedState,
  at: S.Number,
  channelId: S.String,
  conversation: S.String,
  channelKind: ChannelKind,
  message: ChatMessage,
})
export type LaterItem = typeof LaterItem.Type

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  items: S.Array(LaterItem),
  nav: Nav,
  now: S.Number,
  tab: SavedState,
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedTab: { tab: SavedState },
  ClickedSetState: { messageId: S.String, state: SavedState },
  ClickedRemove: { messageId: S.String },
  ClickedToggleTheme: {},
  GotLater: { items: S.Array(LaterItem), members: S.Array(Member), nav: Nav, me: Member, now: S.Number },
  CompletedChange: {},
  FailedChange: { reason: S.String },
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). */
export const ClientMessage = S.Union([Message.ClickedTab, Message.ClickedSetState, Message.ClickedRemove, Message.ClickedToggleTheme])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SetSavedState = Command.define('SetSavedState', {
  args: { messageId: S.String, memberId: S.String, state: SavedState },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, memberId, state }) =>
    Workspace.use(workspace => workspace.setSavedState(messageId, memberId, state)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const RemoveSaved = Command.define('RemoveSaved', {
  args: { messageId: S.String, memberId: S.String },
  messages: [Message.CompletedChange],
  execute: ({ messageId, memberId }) => Workspace.use(workspace => workspace.removeSaved(messageId, memberId)).pipe(Effect.as(Message.CompletedChange())),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

// DATA

/** Your saved messages that you can still see, newest saved first. */
export const laterOf = (state: WorkspaceState, me: Member): ReadonlyArray<LaterItem> =>
  state.saves
    .filter(saved => saved.memberId === me.id)
    .flatMap(saved => {
      const message = state.messages.find(candidate => candidate.id === saved.messageId)
      const channel = message === undefined ? undefined : state.channels.find(candidate => candidate.id === message.channelId)
      if (message === undefined || channel === undefined || !canRead(channel, me.id)) return []
      return [{ state: saved.state, at: saved.at, channelId: channel.id, conversation: conversationName(channel, state.members, me.id), channelKind: channel.kind, message }]
    })
    .sort((a, b) => b.at - a.at)

export const shownOf = (model: Pick<Model, 'items' | 'tab'>): ReadonlyArray<LaterItem> => model.items.filter(item => item.state === model.tab)

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; items: ReadonlyArray<LaterItem>; nav: Nav; now: number; tab: SavedState }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({ model: { ...flags, notice: null } })

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const withState = (model: Model, messageId: string, state: SavedState | null): Model => ({
  ...model,
  notice: null,
  items: state === null ? model.items.filter(item => item.message.id !== messageId) : model.items.map(item => (item.message.id === messageId ? { ...item, state } : item)),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ClickedTab: ({ tab }) => ({ model: { ...model, tab } }),
      ClickedSetState: ({ messageId, state }) =>
        model.items.some(item => item.message.id === messageId && item.state !== state)
          ? { model: withState(model, messageId, state), commands: [SetSavedState({ messageId, memberId: model.me.id, state })] }
          : { model },
      ClickedRemove: ({ messageId }) =>
        model.items.some(item => item.message.id === messageId) ? { model: withState(model, messageId, null), commands: [RemoveSaved({ messageId, memberId: model.me.id })] } : { model },
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      GotLater: data => ({ model: { ...model, ...data } }),
      CompletedChange: () => ({ model }),
      FailedChange: ({ reason }) => ({ model: { ...model, notice: reason } }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ items: ReadonlyArray<LaterItem>; members: ReadonlyArray<Member>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return { items: me === null ? [] : laterOf(state, me), members: state.members, nav: me === null ? emptyNav : navOf(state, me), me }
}

const sameItems = (a: ReadonlyArray<LaterItem>, b: ReadonlyArray<LaterItem>) =>
  a.length === b.length && a.every((item, index) => {
    const other = b[index] as LaterItem
    return item.message === other.message && item.state === other.state && item.at === other.at && item.conversation === other.conversation
  })
const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && sameItems(a.items, b.items) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  later: entry(
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
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotLater({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const TABS: ReadonlyArray<readonly [SavedState, string]> = [
  ['saved', 'In progress'],
  ['done', 'Completed'],
]

const hrefOf = (item: LaterItem) => (item.message.threadId === null ? `/client/${item.channelId}` : `/client/${item.channelId}/thread/${item.message.threadId}`)

const itemView = (model: Model, item: LaterItem, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === item.message.authorId)
  const where = item.channelKind === 'dm' ? item.conversation : `${item.channelKind === 'private' ? '' : '#'}${item.conversation}`
  return box({ as: 'li', class: 'flex gap-3 border-b px-5 py-3', attributes: [h.DataAttribute('later', item.message.id)], children: [
      avatar(author, h, 'md'),
      box({ class: 'flex min-w-0 flex-1 flex-col gap-0.5', children: [
          box({ class: 'flex items-baseline gap-2 text-[12px] text-muted-foreground', children: [
              box({ as: 'span', class: 'font-semibold', children: [item.message.threadId === null ? where : `Thread in ${where}`] }, h),
              box({ as: 'span', children: [`Saved ${dayLabel(item.at, model.now).toLowerCase()}`] }, h),
            ] }, h),
          box({ class: 'flex items-baseline gap-2', children: [
              box({ as: 'strong', class: 'text-[15px] font-bold', children: [author?.name ?? 'Former member'] }, h),
              box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [`${dayLabel(item.message.createdAt, model.now)} at ${formatTime(item.message.createdAt)}`] }, h),
            ] }, h),
          box({ class: slack.messageText, attributes: [h.DataAttribute('message-text', '')], children: messageText(item.message.text, model.members, h) }, h),
        ] }, h),
      box({ class: 'flex shrink-0 items-start gap-1', children: [
          item.state === 'saved'
            ? button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Mark complete', title: 'Mark complete', onClick: Message.ClickedSetState({ messageId: item.message.id, state: 'done' }), children: [Icon.icon('circle-check', {}, h)] }, h)
            : button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Move to in progress', title: 'Move to in progress', onClick: Message.ClickedSetState({ messageId: item.message.id, state: 'saved' }), children: [Icon.icon('rotate-ccw', {}, h)] }, h),
          button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Remove from Later', title: 'Remove from Later', onClick: Message.ClickedRemove({ messageId: item.message.id }), children: [Icon.icon('x', {}, h)] }, h),
          buttonLink({ href: hrefOf(item), variant: 'outline', size: 'sm', children: ['Open'] }, h),
        ] }, h),
    ] }, h)
}

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const shown = shownOf(model)
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('later')], children: [
      box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-5', children: [
          box({ as: 'h1', class: 'flex-1 text-[18px] font-black', children: ['Later'] }, h),
        ] }, h),
      box({ class: 'flex shrink-0 items-center gap-1 border-b px-4 py-2', attributes: [h.AriaLabel('Later tabs')], children: TABS.map(([tab, label]) =>
          button({ variant: model.tab === tab ? 'tab-active' : 'tab', size: 'tab', isPressed: model.tab === tab, onClick: Message.ClickedTab({ tab }), marker: ['tab', tab], children: [`${label} ${model.items.filter(item => item.state === tab).length}`] }, h),
        ) }, h),
      ...(model.notice === null ? [] : [box({ as: 'p', class: 'px-5 py-2 text-[13px] text-destructive', attributes: [h.Role('alert')], children: [model.notice] }, h)]),
      box({ as: 'ul', class: 'min-h-0 flex-1 overflow-y-auto', attributes: [h.Id('later-items'), h.DataAttribute('keep-scroll', 'later'), h.AriaLabel('Saved messages')], children: shown.length === 0
          ? [box({ as: 'li', class: 'flex flex-col items-center gap-2 px-6 py-16 text-center', children: [
              Icon.bookmark({ class: 'size-10 text-muted-foreground' }, h),
              box({ as: 'p', class: 'text-[18px] font-bold', children: [model.tab === 'saved' ? 'Nothing saved for later' : 'Nothing completed yet'] }, h),
              box({ as: 'p', class: 'max-w-[380px] text-[14px] text-muted-foreground', children: ['Save a message with the bookmark in its toolbar to come back to it here.'] }, h),
            ] }, h)]
          : shown.map(item => itemView(model, item, h)) }, h),
    ] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Later - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      region(h, { id: 'rail', deps: [model.me, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, active: 'later', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          box({ as: 'main', class: slack.main, children: [
              region(h, { id: 'later', deps: [model.items, model.members, model.tab, model.now, model.notice], render: () => listView(model, h) }),
            ] }, h),
        ] }, h),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'later',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      const tab = request.url.searchParams.get('tab') === 'done' ? 'done' : 'saved'
      return { me, members: state.members, items: laterOf(state, me), nav: navOf(state, me), now, tab }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: model => [model.tab],
}
