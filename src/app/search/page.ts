import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { badge } from '@/ui/badge'
import { button, buttonLink } from '@/ui/button'

import { requireMember } from '../auth'
import { Member, dayLabel, formatTime, handleOf } from '../domain'
import { ChannelHit, MAX_HITS, MessageHit, parseQuery, searchOf, withFilter } from '../search'
import { Workspace, type WorkspaceState } from '../store'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'
import { box, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { authorName, messageText } from '../view/message'
import { Nav, WORKSPACE_NAME, emptyNav, hasUnread, navOf, rail, sameNav, topBar } from '../view/shell'

/* Slack's search results: the query in the top bar, results as you type in
   Messages, Channels and People tabs, `in:` and `from:` filters shown as
   chips you can clear. The query lives in the address (?q=). */

// MODEL

export const Tab = S.Literals(['messages', 'channels', 'people'])
export type Tab = typeof Tab.Type

export const MAX_QUERY = 200

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  query: S.String,
  tab: Tab,
  messages: S.Array(MessageHit),
  channels: S.Array(ChannelHit),
  people: S.Array(Member),
  nav: Nav,
  switcher: Switcher,
  now: S.Number,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedQuery: { text: S.String },
  ClickedTab: { tab: Tab },
  ClickedFilter: { key: S.Literals(['in', 'from']), value: S.NullOr(S.String) },
  GotSwitcher: { event: SwitcherEvent },
  ClickedToggleTheme: {},
  ChangedConnection: { isConnected: S.Boolean },
  GotResults: { messages: S.Array(MessageHit), channels: S.Array(ChannelHit), people: S.Array(Member), members: S.Array(Member), nav: Nav, me: Member, now: S.Number },
  CompletedChange: {},
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). */
export const ClientMessage = S.Union([Message.ChangedQuery, Message.ClickedTab, Message.ClickedFilter, S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }), Message.ClickedToggleTheme])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

/** Replaces the address without a load (a forwarded client command). */
export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

/** Moves focus in the browser (a forwarded client command). */
export const FocusElement = Command.define('FocusElement', {
  args: { selector: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

export const urlOf = (query: string, tab: Tab) => {
  const params = new URLSearchParams({ ...(query === '' ? {} : { q: query }), ...(tab === 'messages' ? {} : { tab }) }).toString()
  return `/search${params === '' ? '' : `?${params}`}`
}

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; query: string; tab: Tab; nav: Nav; now: number } & ReturnType<typeof searchOf>>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({ model: { ...flags, switcher: initSwitcher() } })

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const withQuery = (model: Model, query: string): UpdateReturn => {
  const text = query.slice(0, MAX_QUERY)
  return text === model.query ? { model } : { model: { ...model, query: text }, commands: [ReplaceUrl({ url: urlOf(text, model.tab) })] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedQuery: ({ text }) => withQuery(model, text),
      ClickedTab: ({ tab }) => (tab === model.tab ? { model } : { model: { ...model, tab }, commands: [ReplaceUrl({ url: urlOf(model.query, tab) })] }),
      ClickedFilter: ({ key, value }) => withQuery(model, withFilter(model.query, key, value === null ? null : value.replace(/\s+/g, '-').slice(0, 80))),
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ChangedConnection: ({ isConnected }) => (isConnected ? { model, commands: [FocusElement({ selector: '#search-input' })] } : { model }),
      GotResults: data => ({ model: { ...model, ...data } }),
      CompletedChange: () => ({ model }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<ReturnType<typeof searchOf> & { members: ReadonlyArray<Member>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string, query: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return { ...(me === null ? { messages: [], channels: [], people: [] } : searchOf(state, me, query)), members: state.members, nav: me === null ? emptyNav : navOf(state, me), me }
}

const sameList = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>, same: (x: A, y: A) => boolean) => a.length === b.length && a.every((item, index) => same(item, b[index] as A))
const sameSlice = (a: Slice, b: Slice) =>
  a.me === b.me &&
  a.members === b.members &&
  sameNav(a.nav, b.nav) &&
  sameList(a.messages, b.messages, (x, y) => x.message === y.message && x.conversation === y.conversation) &&
  sameList(a.channels, b.channels, (x, y) => x.id === y.id && x.name === y.name && x.topic === y.topic && x.memberCount === y.memberCount && x.isMember === y.isMember) &&
  sameList(a.people, b.people, (x, y) => x === y)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  results: entry(
    { memberId: S.String, query: S.String },
    {
      modelToDependencies: model => ({ memberId: model.me.id, query: model.query }),
      dependenciesToStream: ({ memberId, query }) =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => sliceOf(state, memberId, query)),
                Stream.changesWith(sameSlice),
                Stream.filter((slice): slice is Slice & { me: Member } => slice.me !== null),
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotResults({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const placeOf = (kind: MessageHit['channelKind'], name: string) => (kind === 'dm' ? name : `${kind === 'private' ? '' : '#'}${name}`)

const hrefOf = (hit: MessageHit) => (hit.message.threadId === null ? `/client/${hit.channelId}` : `/client/${hit.channelId}/thread/${hit.message.threadId}`)

const messageHit = (model: Model, hit: MessageHit, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === hit.message.authorId)
  return box({ as: 'li', class: 'flex gap-3 border-b px-5 py-3', attributes: [h.DataAttribute('hit', hit.message.id)], children: [
      avatar(author, h, 'md'),
      box({ class: 'flex min-w-0 flex-1 flex-col gap-0.5', children: [
          box({ class: 'text-[12px] font-semibold text-muted-foreground', children: [hit.message.threadId === null ? placeOf(hit.channelKind, hit.conversation) : `Thread in ${placeOf(hit.channelKind, hit.conversation)}`] }, h),
          box({ class: 'flex items-baseline gap-2', children: [
              authorName(author, model.now, h),
              box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [`${dayLabel(hit.message.createdAt, model.now)} at ${formatTime(hit.message.createdAt)}`] }, h),
            ] }, h),
          box({ class: slack.messageText, attributes: [h.DataAttribute('message-text', '')], children: messageText(hit.message.text, model.members, h) }, h),
        ] }, h),
      buttonLink({ href: hrefOf(hit), variant: 'outline', size: 'sm', children: [hit.message.threadId === null ? 'View in channel' : 'View thread'] }, h),
    ] }, h)
}

const channelHit = (hit: ChannelHit, h: HtmlBuilder<Message>): Html =>
  box({ as: 'li', class: 'flex items-center gap-3 border-b px-5 py-3', attributes: [h.DataAttribute('channel-hit', hit.id)], children: [
      Icon.icon(hit.kind === 'private' ? 'lock' : 'hash', { class: 'size-5 text-muted-foreground' }, h),
      box({ class: 'min-w-0 flex-1', children: [
          box({ as: 'p', class: 'flex items-center gap-2 text-[15px] font-bold', children: [hit.name, ...(hit.isMember ? [badge({ variant: 'outline', children: ['Joined'] }, h)] : [])] }, h),
          box({ as: 'p', class: 'min-w-0 truncate text-[13px] text-muted-foreground', children: [`${hit.memberCount} ${hit.memberCount === 1 ? 'member' : 'members'}${hit.topic === '' ? '' : ` · ${hit.topic}`}`] }, h),
        ] }, h),
      buttonLink({ href: `/client/${hit.id}`, variant: 'outline', size: 'sm', children: [hit.isMember ? 'Open' : 'View'] }, h),
    ] }, h)

const personHit = (model: Model, person: Member, h: HtmlBuilder<Message>): Html =>
  box({ as: 'li', class: 'flex items-center gap-3 border-b px-5 py-3', attributes: [h.DataAttribute('person-hit', person.id)], children: [
      avatar(person, h, 'lg'),
      box({ class: 'min-w-0 flex-1', children: [
          box({ as: 'p', class: 'text-[15px] font-bold', children: [person.id === model.me.id ? `${person.name} (you)` : person.name] }, h),
          box({ as: 'p', class: 'text-[13px] text-muted-foreground', children: [`@${handleOf(person)}${person.title === '' ? '' : ` · ${person.title}`}`] }, h),
        ] }, h),
      ...(person.id === model.me.id ? [] : [buttonLink({ href: `/dms?to=${person.id}`, variant: 'outline', size: 'sm', children: ['Message'] }, h)]),
    ] }, h)

const empty = (title: string, hint: string, h: HtmlBuilder<Message>): Html =>
  box({ as: 'li', class: 'flex flex-col items-center gap-2 px-6 py-16 text-center', children: [
      Icon.icon('search', { class: 'size-10 text-muted-foreground' }, h),
      box({ as: 'p', class: 'text-[18px] font-bold', children: [title] }, h),
      box({ as: 'p', class: 'max-w-[420px] text-[14px] text-muted-foreground', children: [hint] }, h),
    ] }, h)

const resultsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const query = parseQuery(model.query)
  const isEmpty = query.terms.length === 0 && query.in === null && query.from === null
  const counts: Record<Tab, number> = { messages: model.messages.length, channels: model.channels.length, people: model.people.length }
  const tab = (id: Tab, label: string) =>
    button({ variant: model.tab === id ? 'tab-active' : 'tab', size: 'tab', isPressed: model.tab === id, onClick: Message.ClickedTab({ tab: id }), marker: ['tab', id], children: [`${label}${isEmpty ? '' : ` ${counts[id] >= MAX_HITS && id === 'messages' ? `${MAX_HITS}+` : counts[id]}`}`] }, h)
  const chip = (key: 'in' | 'from', label: string) =>
    button({ id: `clear-${key}`, variant: 'secondary', size: 'xs', ariaLabel: `Clear ${key === 'in' ? 'In' : 'From'} filter`, onClick: Message.ClickedFilter({ key, value: null }), children: [label, Icon.x({}, h)] }, h)
  const rows =
    model.tab === 'messages'
      ? model.messages.map(hit => messageHit(model, hit, h))
      : model.tab === 'channels'
        ? model.channels.map(hit => channelHit(hit, h))
        : model.people.map(person => personHit(model, person, h))
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('search-results')], children: [
      box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-5', children: [
          box({ as: 'h1', class: 'min-w-0 flex-1 truncate text-[18px] font-black', children: [isEmpty ? 'Search' : `Results for “${model.query.trim()}”`] }, h),
        ] }, h),
      box({ class: 'flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2', attributes: [h.AriaLabel('Result types')], children: [
          tab('messages', 'Messages'),
          tab('channels', 'Channels'),
          tab('people', 'People'),
          box({ class: 'flex-1' }, h),
          ...(query.in === null ? [] : [chip('in', `In: #${query.in}`)]),
          ...(query.from === null ? [] : [chip('from', `From: @${query.from}`)]),
          ...(query.from === null ? [button({ id: 'from-me', variant: 'outline', size: 'xs', onClick: Message.ClickedFilter({ key: 'from', value: handleOf(model.me) }), children: ['From me'] }, h)] : []),
        ] }, h),
      box({ as: 'ul', class: 'min-h-0 flex-1 overflow-y-auto', attributes: [h.Id('search-hits'), h.AriaLabel('Results')], children: isEmpty
          ? [empty('Search messages, channels and people', 'Type in the search field above. Narrow messages with in:#channel or from:@name.', h)]
          : rows.length === 0
            ? [empty('No results', 'Try other words, or remove a filter.', h)]
            : rows }, h),
    ] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.query.trim() === '' ? 'Search' : `${model.query.trim()} - Search`} - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'search', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          region(h, { id: 'top-bar', deps: [model.query], render: () => topBar({ search: { value: model.query, onInput: text => Message.ChangedQuery({ text }) } }, h) }),
          box({ as: 'main', class: slack.main, children: [
              region(h, { id: 'search-results', deps: [model.query, model.tab, model.messages, model.channels, model.people, model.members, model.me, model.now], render: () => resultsView(model, h) }),
            ] }, h),
        ] }, h),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'search',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      const query = (request.url.searchParams.get('q') ?? '').slice(0, MAX_QUERY)
      const tab = S.decodeUnknownOption(Tab)(request.url.searchParams.get('tab')).pipe(o => (o._tag === 'Some' ? o.value : 'messages'))
      return { me, members: state.members, query, tab, nav: navOf(state, me), now, ...searchOf(state, me, query) }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  clientCommands: {
    ...switcherClientCommands,
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
    ReplaceUrl: ({ url }) => (typeof url === 'string' && url.startsWith('/search') ? { replaceUrl: url } : undefined),
  },
  snapshotDeps: model => [model.query, model.tab],
}
