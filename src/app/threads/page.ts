import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, keyBindings, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { button, buttonLink } from '@/ui/button'
import { textarea } from '@/ui/textarea'

import { requireMember } from '../auth'
import { ChannelKind, MAX_MESSAGE, Member, Message as ChatMessage, canRead, conversationName, dayLabel, formatTime, isMemberOf, mentions } from '../domain'
import { emojiName } from '../emoji'
import { Workspace, type WorkspaceState, presenceWhile } from '../store'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'
import { box, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { authorName, messageText } from '../view/message'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, sidebar, topBar, WORKSPACE_NAME } from '../view/shell'

/* Slack's Threads view: every thread you are part of (you started it,
   replied in it or were mentioned in it), the most recently answered first.
   Each card shows where it is, the message that started it, its latest
   replies (the rest one click away) and a composer to reply in place.
   Live: a reply anywhere moves its thread to the top. */

/** Replies shown per thread before "Show more replies". */
export const LATEST = 3
/** Threads listed. */
export const LISTED = 50

// MODEL

export const ThreadCard = S.Struct({
  channelId: S.String,
  channelLabel: S.String,
  channelKind: ChannelKind,
  root: ChatMessage,
  replies: S.Array(ChatMessage),
  lastAt: S.Number,
})
export type ThreadCard = typeof ThreadCard.Type

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  threads: S.Array(ThreadCard),
  nav: Nav,
  switcher: Switcher,
  isConnected: S.Boolean,
  now: S.Number,
  /** Threads showing all their replies. */
  expanded: S.Array(S.String),
  /** Reply drafts by thread. */
  drafts: S.Record(S.String, S.String),
  sending: S.NullOr(S.String),
  notice: S.NullOr(S.String),
  collapsed: S.Array(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedReply: { threadId: S.String, text: S.String },
  SubmittedReply: { threadId: S.String },
  PressedEnter: { targetId: S.String },
  ClickedShowAll: { threadId: S.String },
  ClickedReaction: { messageId: S.String, emoji: S.String },
  GotSwitcher: { event: SwitcherEvent },
  ChangedConnection: { isConnected: S.Boolean },
  ClickedToggleTheme: {},
  ClickedToggleSection: { section: S.String },
  ClickedDismissNotice: {},
  GotThreads: { threads: S.Array(ThreadCard), members: S.Array(Member), nav: Nav, me: Member, now: S.Number },
  SucceededReply: { threadId: S.String },
  FailedChange: { reason: S.String },
  CompletedChange: {},
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). Typed text arrives
 *  through the composers' handlers; Enter through a key binding. */
export const ClientMessage = S.Union([
  Message.SubmittedReply,
  Message.PressedEnter,
  Message.ClickedShowAll,
  Message.ClickedReaction,
  S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }), Message.ClickedToggleTheme,
  Message.ClickedToggleSection,
  Message.ClickedDismissNotice,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SendReply = Command.define('SendReply', {
  args: { channelId: S.String, threadId: S.String, text: S.String, actorId: S.String },
  messages: [Message.SucceededReply, Message.FailedChange],
  execute: ({ channelId, threadId, text, actorId }) =>
    Workspace.use(workspace => workspace.postMessage(channelId, text, actorId, { threadId })).pipe(
      Effect.as(Message.SucceededReply({ threadId })),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const ToggleReaction = Command.define('ToggleReaction', {
  args: { messageId: S.String, emoji: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, emoji, actorId }) =>
    Workspace.use(workspace => workspace.toggleReaction(messageId, emoji, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

// DATA

/** The threads someone is part of, in conversations they can read and are in. */
export const threadsOf = (state: WorkspaceState, me: Member): ReadonlyArray<ThreadCard> => {
  const channels = new Map(state.channels.filter(channel => !channel.isArchived && isMemberOf(channel, me.id) && canRead(channel, me.id)).map(channel => [channel.id, channel]))
  const replies = new Map<string, Array<ChatMessage>>()
  for (const message of state.messages) {
    if (message.threadId !== null && channels.has(message.channelId)) replies.set(message.threadId, [...(replies.get(message.threadId) ?? []), message])
  }
  const cards: Array<ThreadCard> = []
  for (const root of state.messages) {
    const answers = replies.get(root.id)
    const channel = channels.get(root.channelId)
    if (answers === undefined || channel === undefined || root.threadId !== null) continue
    const isPart = [root, ...answers].some(message => message.authorId === me.id || mentions(message.text, me))
    if (!isPart) continue
    cards.push({ channelId: channel.id, channelLabel: conversationName(channel, state.members, me.id), channelKind: channel.kind, root, replies: answers, lastAt: answers.at(-1)?.createdAt ?? root.createdAt })
  }
  // Newest reply first; replies at the same moment in the order they were written.
  const order = new Map(state.messages.map((message, index) => [message.id, index]))
  const lastIndex = (card: ThreadCard) => order.get(card.replies.at(-1)?.id ?? card.root.id) ?? 0
  return cards.sort((a, b) => b.lastAt - a.lastAt || lastIndex(b) - lastIndex(a)).slice(0, LISTED)
}

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; threads: ReadonlyArray<ThreadCard>; nav: Nav; now: number }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({
  model: { ...flags, switcher: initSwitcher(), isConnected: false, expanded: [], drafts: {}, sending: null, notice: null, collapsed: [] },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const withDraft = (model: Model, threadId: string, text: string): Model => {
  const { [threadId]: _, ...rest } = model.drafts
  return { ...model, drafts: text === '' ? rest : { ...rest, [threadId]: text } }
}

const reply = (model: Model, threadId: string): UpdateReturn => {
  const card = model.threads.find(thread => thread.root.id === threadId)
  const text = (model.drafts[threadId] ?? '').trim()
  if (card === undefined || text === '' || model.sending !== null) return { model }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, sending: threadId }, commands: [SendReply({ channelId: card.channelId, threadId, text, actorId: model.me.id })] }
}

const findMessage = (model: Model, messageId: string) =>
  model.threads.flatMap(thread => [thread.root, ...thread.replies]).find(message => message.id === messageId)

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedReply: ({ threadId, text }) => ({ model: withDraft(model, threadId, text) }),
      SubmittedReply: ({ threadId }) => reply(model, threadId),
      PressedEnter: ({ targetId }) => (targetId.startsWith('reply-') ? reply(model, targetId.slice('reply-'.length)) : { model }),
      ClickedShowAll: ({ threadId }) => ({
        model: model.threads.some(thread => thread.root.id === threadId) && !model.expanded.includes(threadId) ? { ...model, expanded: [...model.expanded, threadId].slice(-LISTED) } : model,
      }),
      ClickedReaction: ({ messageId, emoji }) => {
        const found = findMessage(model, messageId)
        return found !== undefined && found.reactions.some(reaction => reaction.emoji === emoji) ? { model, commands: [ToggleReaction({ messageId, emoji, actorId: model.me.id })] } : { model }
      },
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedToggleSection: ({ section }) => ({
        model: { ...model, collapsed: model.collapsed.includes(section) ? model.collapsed.filter(id => id !== section) : [...model.collapsed, section].slice(-8) },
      }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      GotThreads: data => {
        const ids = new Set(data.threads.map(thread => thread.root.id))
        return { model: { ...model, ...data, expanded: model.expanded.filter(id => ids.has(id)) } }
      },
      SucceededReply: ({ threadId }) => ({ model: { ...withDraft(model, threadId, ''), sending: null } }),
      FailedChange: ({ reason }) => ({ model: { ...model, sending: null, notice: reason } }),
      CompletedChange: () => ({ model }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ threads: ReadonlyArray<ThreadCard>; members: ReadonlyArray<Member>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return { threads: me === null ? [] : threadsOf(state, me), members: state.members, nav: me === null ? emptyNav : navOf(state, me), me }
}

const sameMessages = (a: ReadonlyArray<ChatMessage>, b: ReadonlyArray<ChatMessage>) => a.length === b.length && a.every((message, index) => message === b[index])
const sameCards = (a: ReadonlyArray<ThreadCard>, b: ReadonlyArray<ThreadCard>) =>
  a.length === b.length && a.every((card, index) => {
    const other = b[index] as ThreadCard
    return card.root === other.root && card.channelLabel === other.channelLabel && sameMessages(card.replies, other.replies)
  })
const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && sameCards(a.threads, b.threads) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  presence: entry(
    { memberId: S.String, isConnected: S.Boolean },
    { modelToDependencies: model => ({ memberId: model.me.id, isConnected: model.isConnected }), dependenciesToStream: ({ memberId, isConnected }) => presenceWhile(memberId, isConnected) },
  ),
  threads: entry(
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
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotThreads({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const messageView = (model: Model, message: ChatMessage, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === message.authorId)
  return box({ as: 'li', class: slack.messageRow, attributes: [h.Key(message.id), h.Id(`threads-message-${message.id}`), h.DataAttribute('author', message.authorId)], children: [
      box({ class: slack.messageGutter, children: [avatar(author, h, 'md')] }, h),
      box({ class: 'min-w-0 flex-1', children: [
          box({ class: 'flex items-baseline gap-2', children: [
              authorName(author, model.now, h),
              box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [`${dayLabel(message.createdAt, model.now)} at ${formatTime(message.createdAt)}`] }, h),
            ] }, h),
          box({ class: slack.messageText, attributes: [h.DataAttribute('message-text', '')], children: [
              ...messageText(message.text, model.members, h),
              ...(message.editedAt === null ? [] : [box({ as: 'span', class: 'ml-1 text-[12px] text-muted-foreground', children: ['(edited)'] }, h)]),
            ] }, h),
          ...(message.reactions.length === 0
            ? []
            : [box({ class: 'mt-1 flex flex-wrap items-center gap-1', attributes: [h.AriaLabel('Reactions')], children: message.reactions.map(reaction => {
                const isMine = reaction.memberIds.includes(model.me.id)
                return button({
                  variant: isMine ? 'reaction-mine' : 'reaction',
                  size: 'xs',
                  ariaLabel: `${reaction.memberIds.length} ${reaction.memberIds.length === 1 ? 'reaction' : 'reactions'}, react with :${emojiName(reaction.emoji)}:${isMine ? ' (yours)' : ''}`,
                  onClick: Message.ClickedReaction({ messageId: message.id, emoji: reaction.emoji }),
                  isPressed: isMine,
                  marker: ['reaction', reaction.emoji],
                  children: [box({ as: 'span', class: 'text-[15px] leading-none', children: [reaction.emoji] }, h), String(reaction.memberIds.length)],
                }, h)
              }) }, h)]),
        ] }, h),
    ] }, h)
}

const cardView = (model: Model, card: ThreadCard, h: HtmlBuilder<Message>): Html => {
  const isExpanded = model.expanded.includes(card.root.id)
  const hidden = isExpanded ? 0 : Math.max(0, card.replies.length - LATEST)
  const draft = model.drafts[card.root.id] ?? ''
  const people = [...new Set([card.root, ...card.replies].map(message => message.authorId))]
    .map(id => model.members.find(member => member.id === id)?.name.split(' ')[0])
    .filter(name => name !== undefined)
  return box({ as: 'article', class: slack.threadCard, attributes: [h.Key(card.root.id), h.Id(`thread-card-${card.root.id}`), h.AriaLabel(`Thread in ${card.channelLabel}`)], children: [
      box({ as: 'header', class: 'flex flex-col gap-0.5 px-5 pt-3 pb-1', children: [
          buttonLink({
            href: `/client/${card.channelId}/thread/${card.root.id}`,
            variant: 'thread-channel',
            size: 'xs',
            ...(card.channelKind === 'dm' ? {} : { leadingIcon: Icon.icon(card.channelKind === 'private' ? 'lock' : 'hash', { class: 'size-3.5' }, h) }),
            children: [card.channelLabel],
          }, h),
          box({ as: 'span', class: 'min-w-0 truncate text-[12px] text-muted-foreground', children: [people.join(', ')] }, h),
        ] }, h),
      box({ as: 'ol', class: 'flex flex-col', attributes: [h.AriaLabel('Messages')], children: [
          messageView(model, card.root, h),
          ...(hidden === 0
            ? []
            : [box({ as: 'li', class: 'px-5 py-1', attributes: [h.Key('more')], children: [
                button({ variant: 'link', size: 'xs', ariaLabel: `Show ${hidden} more ${hidden === 1 ? 'reply' : 'replies'}`, onClick: Message.ClickedShowAll({ threadId: card.root.id }), children: [`Show ${hidden} more ${hidden === 1 ? 'reply' : 'replies'}`] }, h),
              ] }, h)]),
          ...card.replies.slice(hidden).map(message => messageView(model, message, h)),
        ] }, h),
      box({ as: 'form', class: slack.composer, attributes: [h.OnSubmit(Message.SubmittedReply({ threadId: card.root.id }))], children: [
          textarea({ id: `reply-${card.root.id}`, value: draft, rows: 1, placeholder: 'Reply…', onInput: text => Message.ChangedReply({ threadId: card.root.id, text }), ariaLabel: `Reply in thread in ${card.channelLabel}`, resize: 'none', variant: 'slack-composer' }, h),
          box({ class: 'flex items-center justify-end px-2 pb-1.5', children: [
              button({ variant: 'send', size: 'icon-md', type: 'submit', ariaLabel: 'Send reply', title: 'Send reply', isDisabled: draft.trim() === '' || model.sending === card.root.id, children: [Icon.icon('send', {}, h)] }, h),
            ] }, h),
        ] }, h),
    ] }, h)
}

const listView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: 'min-h-0 flex-1 overflow-y-auto', attributes: [h.Id('threads-list'), h.DataAttribute('keep-scroll', 'threads')], children: model.threads.length === 0
      ? [box({ class: 'flex flex-col items-center gap-2 px-6 py-24 text-center', attributes: [h.Id('threads-empty')], children: [
          Icon.icon('messages-square', { class: 'size-10 text-muted-foreground' }, h),
          box({ as: 'h2', class: 'text-[18px] font-bold', children: ['No threads yet'] }, h),
          box({ as: 'p', class: 'max-w-[360px] text-[14px] text-muted-foreground', children: ['Threads you start, reply in or are mentioned in show up here.'] }, h),
        ] }, h)]
      : model.threads.map(card => cardView(model, card, h)) }, h)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Threads - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'home', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          region(h, {
            id: 'sidebar',
            deps: [model.nav, model.members, model.collapsed],
            render: () => sidebar({ nav: model.nav, members: model.members, activeId: 'threads', collapsed: model.collapsed, onToggleSection: section => Message.ClickedToggleSection({ section }) }, h),
          }),
          box({ as: 'main', class: slack.main, children: [
              box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', attributes: [h.Id('threads-header')], children: [
                  box({ as: 'h1', class: 'text-[18px] font-black', children: ['Threads'] }, h),
                ] }, h),
              region(h, { id: 'threads-list', deps: [model.threads, model.members, model.expanded, model.drafts, model.sending, model.now, model.me.id], render: () => listView(model, h) }),
            ] }, h),
        ] }, h),
      region(h, {
        id: 'keys',
        deps: [],
        render: () => box({ attributes: [h.Id('keys')], children: [keyBindings(h, [{ keys: 'Enter', whileTyping: 'Allow', message: ({ targetId }) => Message.PressedEnter({ targetId }) }])] }, h),
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
  name: 'threads',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      return { me, members: state.members, threads: threadsOf(state, me), nav: navOf(state, me), now }
    }),
  init,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  update,
  view,
  subscriptions,
  clientCommands: switcherClientCommands,
  snapshotDeps: model => [model.drafts, model.expanded, model.collapsed, model.notice],
}
