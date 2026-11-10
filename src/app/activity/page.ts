import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { badge } from '@/ui/badge'
import { button, buttonLink } from '@/ui/button'

import { ActivityItem, activityOf, hrefOf } from '../activity'
import { requireMember } from '../auth'
import { ACTIVITY_READ, Member, Message as ChatMessage, dayLabel, firstName, formatTime, readAt } from '../domain'
import { Workspace, type WorkspaceState, presenceWhile } from '../store'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'
import { box, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { authorName, messageText } from '../view/message'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, topBar, WORKSPACE_NAME } from '../view/shell'

/* Slack's Activity tab: mentions of you, replies in your threads and
   reactions to your messages, newest first, in a list pane with filter
   tabs. The picked item shows on the right with a link to where it is.
   What arrives while the page is open counts as seen. */

// MODEL

export const Tab = S.Literals(['all', 'mention', 'reply', 'reaction'])
export type Tab = typeof Tab.Type

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  items: S.Array(ActivityItem),
  /** For a picked reply: the message that started its thread. */
  root: S.NullOr(ChatMessage),
  nav: Nav,
  switcher: Switcher,
  now: S.Number,
  tab: Tab,
  isUnreadOnly: S.Boolean,
  /** The item shown on the right. */
  picked: S.NullOr(S.String),
  /** Seen up to here when the page opened: newer items show as unread. */
  seenAt: S.Number,
  /** Marked seen up to here (a SeeActivity Command). */
  markedUpTo: S.Number,
  isConnected: S.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedTab: { tab: Tab },
  ClickedUnreadOnly: {},
  GotSwitcher: { event: SwitcherEvent },
  ClickedToggleTheme: {},
  ChangedConnection: { isConnected: S.Boolean },
  GotActivity: { items: S.Array(ActivityItem), root: S.NullOr(ChatMessage), members: S.Array(Member), nav: Nav, me: Member, now: S.Number },
  CompletedChange: {},
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). */
export const ClientMessage = S.Union([Message.ClickedTab, Message.ClickedUnreadOnly, S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }), Message.ClickedToggleTheme])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SeeActivity = Command.define('SeeActivity', {
  args: { memberId: S.String },
  messages: [Message.CompletedChange],
  execute: ({ memberId }) => Workspace.use(workspace => workspace.seeActivity(memberId)).pipe(Effect.as(Message.CompletedChange())),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

// DATA

export const shownOf = (model: Pick<Model, 'items' | 'tab' | 'isUnreadOnly' | 'seenAt'>): ReadonlyArray<ActivityItem> =>
  model.items.filter(item => (model.tab === 'all' || item.kind === model.tab) && (!model.isUnreadOnly || item.at > model.seenAt))

const rootOf = (state: WorkspaceState, items: ReadonlyArray<ActivityItem>, picked: string | null): ChatMessage | null => {
  const threadId = items.find(item => item.id === picked)?.message.threadId ?? null
  return threadId === null ? null : (state.messages.find(message => message.id === threadId) ?? null)
}

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; items: ReadonlyArray<ActivityItem>; root: ChatMessage | null; nav: Nav; now: number; tab: Tab; picked: string | null; seenAt: number }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({
  model: { ...flags, switcher: initSwitcher(), isUnreadOnly: false, markedUpTo: flags.seenAt, isConnected: false },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

/** While the page is open, what arrives counts as seen. */
const markSeen = (model: Model): UpdateReturn => {
  const newest = model.items[0]?.at ?? 0
  if (!model.isConnected || newest <= model.markedUpTo) return { model }
  return { model: { ...model, markedUpTo: newest }, commands: [SeeActivity({ memberId: model.me.id })] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ClickedTab: ({ tab }) => ({ model: { ...model, tab } }),
      ClickedUnreadOnly: () => ({ model: { ...model, isUnreadOnly: !model.isUnreadOnly } }),
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ChangedConnection: ({ isConnected }) => markSeen({ ...model, isConnected }),
      GotActivity: data => markSeen({ ...model, ...data, picked: data.items.some(item => item.id === model.picked) ? model.picked : null }),
      CompletedChange: () => ({ model }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ items: ReadonlyArray<ActivityItem>; root: ChatMessage | null; members: ReadonlyArray<Member>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string, picked: string | null): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  const items = me === null ? [] : activityOf(state, me)
  return { items, root: rootOf(state, items, picked), members: state.members, nav: me === null ? emptyNav : navOf(state, me), me }
}

const sameItems = (a: ReadonlyArray<ActivityItem>, b: ReadonlyArray<ActivityItem>) =>
  a.length === b.length && a.every((item, index) => {
    const other = b[index] as ActivityItem
    return item.id === other.id && item.message === other.message && item.at === other.at && item.channelName === other.channelName
  })
const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && a.root === b.root && sameItems(a.items, b.items) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  presence: entry(
    { memberId: S.String, isConnected: S.Boolean },
    { modelToDependencies: model => ({ memberId: model.me.id, isConnected: model.isConnected }), dependenciesToStream: ({ memberId, isConnected }) => presenceWhile(memberId, isConnected) },
  ),
  activity: entry(
    { memberId: S.String, picked: S.NullOr(S.String) },
    {
      modelToDependencies: model => ({ memberId: model.me.id, picked: model.picked }),
      dependenciesToStream: ({ memberId, picked }) =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => sliceOf(state, memberId, picked)),
                Stream.changesWith(sameSlice),
                Stream.filter((slice): slice is Slice & { me: Member } => slice.me !== null),
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotActivity({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['all', 'All'],
  ['mention', 'Mentions'],
  ['reply', 'Threads'],
  ['reaction', 'Reactions'],
]

const nameOf = (model: Model, id: string) => (id === model.me.id ? 'You' : (model.members.find(member => member.id === id)?.name ?? 'Former member'))

const whoOf = (model: Model, item: ActivityItem): string => {
  const names = item.actorIds.map(id => nameOf(model, id))
  const [last, ...rest] = [...names].reverse()
  if (rest.length === 0) return last ?? 'Someone'
  return rest.length === 1 ? `${firstName(last ?? '')} and ${firstName(rest[0] ?? '')}` : `${firstName(last ?? '')} and ${rest.length} others`
}

const titleOf = (item: ActivityItem): string => {
  const where = item.channelKind === 'private' ? item.channelName : `#${item.channelName}`
  return item.kind === 'mention' ? `Mention in ${where}` : item.kind === 'reply' ? `Thread in ${where}` : `Reaction in ${where}`
}

const summaryOf = (model: Model, item: ActivityItem): string =>
  item.kind === 'reaction' ? `${whoOf(model, item)} reacted ${item.emoji} to your message` : `${whoOf(model, item)}: ${item.message.text}`

const whenOf = (model: Model, at: number): string => {
  const day = dayLabel(at, model.now, model.me)
  return day === 'Today' ? formatTime(at, model.me) : day
}

const kindIcon = (item: ActivityItem, h: HtmlBuilder<Message>): Html =>
  Icon.icon(item.kind === 'mention' ? 'at-sign' : item.kind === 'reply' ? 'message-square-text' : 'smile-plus', { class: 'size-3.5' }, h)

const tabHref = (tab: Tab, picked: string | null) => {
  const params = [...(tab === 'all' ? [] : [`tab=${tab}`]), ...(picked === null ? [] : [`item=${encodeURIComponent(picked)}`])]
  return params.length === 0 ? '/activity' : `/activity?${params.join('&')}`
}

const itemRow = (model: Model, item: ActivityItem, h: HtmlBuilder<Message>): Html => {
  const isUnread = item.at > model.seenAt
  const actor = model.members.find(member => member.id === item.actorIds.at(-1))
  return buttonLink({
    href: tabHref(model.tab, item.id),
    variant: item.id === model.picked ? 'dm-row-active' : isUnread ? 'dm-row-unread' : 'dm-row',
    size: 'dm',
    marker: ['activity', item.id],
    children: [
      avatar(actor, h, 'lg'),
      box({ as: 'span', class: 'flex min-w-0 flex-1 flex-col gap-0.5', children: [
          box({ as: 'span', class: 'flex items-center gap-1.5 text-[13px]', children: [
              kindIcon(item, h),
              box({ as: 'span', class: 'min-w-0 flex-1 truncate', children: [titleOf(item)] }, h),
              box({ as: 'span', class: 'shrink-0 text-[12px] font-normal opacity-80', children: [whenOf(model, item.at)] }, h),
            ] }, h),
          box({ as: 'span', class: 'line-clamp-2 min-w-0 text-[14px] font-normal opacity-90', children: [summaryOf(model, item)] }, h),
        ] }, h),
      ...(isUnread ? [box({ as: 'span', class: slack.unreadDot, attributes: [h.AriaLabel('Unread')] }, h)] : []),
    ],
  }, h)
}

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const shown = shownOf(model)
  return box({ as: 'aside', class: slack.dmList, attributes: [h.Id('activity-list'), h.AriaLabel('Activity')], children: [
      box({ as: 'header', class: 'flex h-12 shrink-0 items-center gap-1 px-4', children: [
          box({ as: 'h2', class: 'min-w-0 flex-1 truncate text-[18px] font-bold text-sidebar-accent-foreground', children: ['Activity'] }, h),
          button({ id: 'unread-only', variant: model.isUnreadOnly ? 'pane-tab-active' : 'pane-tab', size: 'tab', isPressed: model.isUnreadOnly, onClick: Message.ClickedUnreadOnly(), children: ['Unreads'] }, h),
        ] }, h),
      box({ class: 'flex flex-wrap items-center gap-1 px-3 pb-2', attributes: [h.AriaLabel('Filter activity')], children: TABS.map(([tab, label]) =>
          button({ variant: model.tab === tab ? 'pane-tab-active' : 'pane-tab', size: 'tab', isPressed: model.tab === tab, onClick: Message.ClickedTab({ tab }), marker: ['tab', tab], children: [label] }, h),
        ) }, h),
      box({ as: 'nav', class: 'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4', attributes: [h.Id('activity-items'), h.DataAttribute('keep-scroll', 'activity'), h.AriaLabel('Activity items')], children: shown.length === 0
          ? [box({ as: 'p', class: 'px-2 py-6 text-center text-[13px] opacity-80', children: [model.isUnreadOnly ? 'You’re all caught up.' : 'Nothing here yet.'] }, h)]
          : shown.map(item => itemRow(model, item, h)) }, h),
    ] }, h)
}

const messageView = (model: Model, message: ChatMessage, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === message.authorId)
  return box({ class: slack.messageRow, attributes: [h.DataAttribute('preview-message', message.id)], children: [
      box({ class: slack.messageGutter, children: [avatar(author, h, 'md')] }, h),
      box({ class: 'min-w-0 flex-1', children: [
          box({ class: 'flex items-baseline gap-2', children: [
              authorName(author, model.now, h, 'text-[15px]'),
              box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [`${dayLabel(message.createdAt, model.now, model.me)} at ${formatTime(message.createdAt, model.me)}`] }, h),
            ] }, h),
          box({ class: slack.messageText, children: messageText(message.text, model.members, h) }, h),
          ...(message.reactions.length === 0
            ? []
            : [box({ class: 'mt-1 flex flex-wrap gap-1', children: message.reactions.map(reaction =>
                badge({ variant: 'outline', children: [reaction.emoji, String(reaction.memberIds.length)] }, h),
              ) }, h)]),
        ] }, h),
    ] }, h)
}

const previewView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const item = model.items.find(candidate => candidate.id === model.picked)
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('activity-preview')], children: item === undefined
      ? [box({ class: 'flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center', children: [
          Icon.icon('bell', { class: 'size-10 text-muted-foreground' }, h),
          box({ as: 'h2', class: 'text-[18px] font-bold', children: [model.items.length === 0 ? 'No activity yet' : 'Pick an item'] }, h),
          box({ as: 'p', class: 'max-w-[380px] text-[14px] text-muted-foreground', children: ['Mentions of you, replies in your threads and reactions to your messages show up here.'] }, h),
        ] }, h)]
      : [
          box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', children: [
              box({ as: 'h1', class: 'flex min-w-0 flex-1 items-center gap-1.5 truncate text-[18px] font-black', children: [kindIcon(item, h), titleOf(item)] }, h),
              buttonLink({ id: 'open-item', href: hrefOf(item), variant: 'outline', size: 'sm', children: [item.message.threadId === null ? 'Open in channel' : 'Open thread'] }, h),
            ] }, h),
          box({ class: 'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-4', children: [
              ...(item.kind === 'reaction' ? [box({ as: 'p', class: 'px-5 pb-2 text-[14px] text-muted-foreground', children: [`${whoOf(model, item)} reacted ${item.emoji}`] }, h)] : []),
              ...(model.root === null ? [] : [messageView(model, model.root, h), box({ as: 'p', class: 'px-5 py-1 text-[13px] text-muted-foreground', children: ['Reply:'] }, h)]),
              messageView(model, item.message, h),
            ] }, h),
        ] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Activity - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, preferences: model.me.preferences, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'activity', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          region(h, { id: 'activity-list', deps: [model.items, model.members, model.tab, model.isUnreadOnly, model.picked, model.seenAt, model.now, model.me.timeZone, model.me.preferences], render: () => listView(model, h) }),
          box({ as: 'main', class: slack.main, children: [
              region(h, { id: 'activity-preview', deps: [model.items, model.root, model.members, model.picked, model.now, model.me.timeZone, model.me.preferences], render: () => previewView(model, h) }),
            ] }, h),
        ] }, h),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'activity',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      const items = activityOf(state, me)
      const asked = request.url.searchParams.get('item')
      const picked = items.some(item => item.id === asked) ? asked : null
      const tab = S.decodeUnknownOption(Tab)(request.url.searchParams.get('tab')).pipe(o => (o._tag === 'Some' ? o.value : 'all'))
      return { me, members: state.members, items, root: rootOf(state, items, picked), nav: navOf(state, me), now, tab, picked, seenAt: readAt(state.reads, me.id, ACTIVITY_READ) }
    }),
  init,
  update,
  view,
  subscriptions,
  clientCommands: switcherClientCommands,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  snapshotDeps: model => [model.tab, model.isUnreadOnly],
}
