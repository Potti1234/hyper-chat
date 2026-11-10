import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { button, buttonLink } from '@/ui/button'
import { checkbox } from '@/ui/checkbox'
import * as Dialog from '@/ui/dialog'
import { input } from '@/ui/input'

import { requireMember } from '../auth'
import { ChannelKind, DEFAULT_CHANNEL, MAX_CHANNEL_NAME, MAX_DESCRIPTION, Member, canRead, channelSlug, compareChannels, isMemberOf } from '../domain'
import { Workspace, type WorkspaceState } from '../store'
import { box, pageRoot, slack } from '../view/design'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, sidebar, topBar, WORKSPACE_NAME } from '../view/shell'

/* Slack's channel browser ("All channels"): every public channel and the
   private ones you are in, with members and description; join or leave from
   the list. "Create channel" names a new one (public or private) and opens it. */

// MODEL

export const ChannelRow = S.Struct({
  id: S.String,
  name: S.String,
  kind: ChannelKind,
  description: S.String,
  memberCount: S.Number,
  isMember: S.Boolean,
  isArchived: S.Boolean,
})
export type ChannelRow = typeof ChannelRow.Type

export const Show = S.Literals(['all', 'mine', 'archived'])
export type Show = typeof Show.Type

export const Model = S.Struct({
  me: Member,
  rows: S.Array(ChannelRow),
  nav: Nav,
  members: S.Array(Member),
  collapsed: S.Array(S.String),
  filter: S.String,
  show: Show,
  /** The row whose Join/Leave is on its way. */
  pending: S.NullOr(S.String),
  create: Dialog.Model,
  form: S.Struct({ name: S.String, description: S.String, isPrivate: S.Boolean, isSaving: S.Boolean }),
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedFilter: { text: S.String },
  ClickedShow: { show: Show },
  ClickedJoin: { channelId: S.String },
  ClickedLeave: { channelId: S.String },
  ClickedCreate: {},
  GotCreateDialog: { message: Dialog.Message },
  ChangedName: { text: S.String },
  ChangedDescription: { text: S.String },
  ToggledPrivate: { isChecked: S.Boolean },
  SubmittedCreate: {},
  ClickedToggleTheme: {},
  ClickedToggleSection: { section: S.String },
  ClickedDismissNotice: {},
  GotChannels: { rows: S.Array(ChannelRow), nav: Nav, members: S.Array(Member), me: Member },
  CreatedChannel: { channelId: S.String },
  FailedChange: { reason: S.String },
  CompletedChange: {},
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.ClickedShow,
  Message.ClickedJoin,
  Message.ClickedLeave,
  Message.ClickedCreate,
  Message.ToggledPrivate,
  Message.SubmittedCreate,
  Message.ClickedToggleTheme,
  Message.ClickedToggleSection,
  Message.ClickedDismissNotice,
  S.TaggedStruct('GotCreateDialog', { message: Dialog.Message.RequestedClose }),
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const JoinChannel = Command.define('JoinChannel', {
  args: { channelId: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, actorId }) => Workspace.use(workspace => workspace.joinChannel(channelId, actorId)).pipe(Effect.as(Message.CompletedChange()), Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason })))),
})

export const LeaveChannel = Command.define('LeaveChannel', {
  args: { channelId: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, actorId }) => Workspace.use(workspace => workspace.leaveChannel(channelId, actorId)).pipe(Effect.as(Message.CompletedChange()), Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason })))),
})

export const CreateChannel = Command.define('CreateChannel', {
  args: { name: S.String, description: S.String, isPrivate: S.Boolean, actorId: S.String },
  messages: [Message.CreatedChannel, Message.FailedChange],
  execute: ({ actorId, ...input }) =>
    Workspace.use(workspace => workspace.createChannel(input, actorId)).pipe(
      Effect.map(channel => Message.CreatedChannel({ channelId: channel.id })),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
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

/** The channels someone can see: every public one and the private ones they are in. */
export const channelsOf = (state: WorkspaceState, me: Member): ReadonlyArray<ChannelRow> =>
  state.channels
    .filter(channel => channel.kind !== 'dm' && canRead(channel, me.id))
    .sort(compareChannels)
    .map(channel => ({ id: channel.id, name: channel.name, kind: channel.kind, description: channel.description, memberCount: channel.memberIds.length, isMember: isMemberOf(channel, me.id), isArchived: channel.isArchived }))

/** The rows a filter and tab show. */
export const shownOf = (model: Pick<Model, 'rows' | 'filter' | 'show'>): ReadonlyArray<ChannelRow> => {
  const filter = channelSlug(model.filter)
  return model.rows.filter(
    row =>
      (model.show === 'archived' ? row.isArchived : !row.isArchived && (model.show === 'all' || row.isMember)) &&
      (filter === '' || row.name.includes(filter) || row.description.toLowerCase().includes(model.filter.trim().toLowerCase())),
  )
}

// INIT

export type Flags = Readonly<{ me: Member; rows: ReadonlyArray<ChannelRow>; nav: Nav; members: ReadonlyArray<Member>; isCreating: boolean }>

const emptyForm = { name: '', description: '', isPrivate: false, isSaving: false }

export const init = ({ isCreating, ...flags }: Flags): Update.Return<Model, Message, Workspace> => {
  const base: Model = { ...flags, collapsed: [], filter: '', show: 'all', pending: null, create: Dialog.init({ id: 'create-channel' }), form: emptyForm, notice: null }
  return isCreating ? withCreate(base, Dialog.open(base.create)) : { model: base }
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const withCreate = (model: Model, dialogUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, create: dialogUpdate.model, form: dialogUpdate.model.isOpen ? model.form : emptyForm },
  commands: Command.mapMessages(dialogUpdate.commands, message => Message.GotCreateDialog({ message })),
})

const rowOf = (model: Model, channelId: string) => model.rows.find(row => row.id === channelId && !row.isArchived)

const create = (model: Model): UpdateReturn => {
  const { form } = model
  if (form.isSaving || !model.create.isOpen) return { model }
  const name = channelSlug(form.name)
  if (name === '') return { model: { ...model, notice: 'Give the channel a name.' } }
  if (model.rows.some(row => row.name === name)) return { model: { ...model, notice: `#${name} already exists. Pick another name.` } }
  return { model: { ...model, form: { ...form, isSaving: true } }, commands: [CreateChannel({ name, description: form.description, isPrivate: form.isPrivate, actorId: model.me.id })] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedFilter: ({ text }) => ({ model: { ...model, filter: text.slice(0, 80) } }),
      ClickedShow: ({ show }) => ({ model: { ...model, show } }),
      ClickedJoin: ({ channelId }) => {
        const row = rowOf(model, channelId)
        if (row === undefined || row.isMember || row.kind !== 'public' || model.pending !== null) return { model }
        return { model: { ...model, pending: channelId }, commands: [JoinChannel({ channelId, actorId: model.me.id })] }
      },
      ClickedLeave: ({ channelId }) => {
        const row = rowOf(model, channelId)
        if (row === undefined || !row.isMember || model.pending !== null) return { model }
        if (row.name === DEFAULT_CHANNEL) return { model: { ...model, notice: `Everyone stays in #${DEFAULT_CHANNEL}.` } }
        return { model: { ...model, pending: channelId }, commands: [LeaveChannel({ channelId, actorId: model.me.id })] }
      },
      ClickedCreate: () => withCreate(model, Dialog.open(model.create)),
      GotCreateDialog: ({ message }) => withCreate(model, Dialog.update(model.create, message)),
      ChangedName: ({ text }) => ({ model: { ...model, form: { ...model.form, name: text.slice(0, MAX_CHANNEL_NAME + 20) } } }),
      ChangedDescription: ({ text }) => ({ model: { ...model, form: { ...model.form, description: text.slice(0, MAX_DESCRIPTION + 20) } } }),
      ToggledPrivate: ({ isChecked }) => ({ model: { ...model, form: { ...model.form, isPrivate: isChecked } } }),
      SubmittedCreate: () => create(model),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedToggleSection: ({ section }) => ({ model: { ...model, collapsed: model.collapsed.includes(section) ? model.collapsed.filter(id => id !== section) : [...model.collapsed, section].slice(-8) } }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      GotChannels: data => ({ model: { ...model, ...data } }),
      CreatedChannel: ({ channelId }) => ({ model: { ...model, form: { ...model.form, isSaving: false } }, commands: [LoadUrl({ url: `/client/${channelId}` })] }),
      FailedChange: ({ reason }) => ({ model: { ...model, pending: null, form: { ...model.form, isSaving: false }, notice: reason } }),
      CompletedChange: () => ({ model: { ...model, pending: null } }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ rows: ReadonlyArray<ChannelRow>; nav: Nav; members: ReadonlyArray<Member>; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return me === null ? { rows: [], nav: emptyNav, members: state.members, me } : { rows: channelsOf(state, me), nav: navOf(state, me), members: state.members, me }
}

const sameRow = (a: ChannelRow, b: ChannelRow) =>
  a.id === b.id && a.name === b.name && a.kind === b.kind && a.description === b.description && a.memberCount === b.memberCount && a.isMember === b.isMember && a.isArchived === b.isArchived
const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && a.rows.length === b.rows.length && a.rows.every((row, index) => sameRow(row, b.rows[index] as ChannelRow)) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  channels: entry(
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
                Stream.map(slice => Message.GotChannels(slice)),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const dot = (h: HtmlBuilder<Message>): Html => box({ as: 'span', attributes: [h.AriaHidden(true)], children: ['·'] }, h)

const rowView = (model: Model, row: ChannelRow, h: HtmlBuilder<Message>): Html =>
  box({ as: 'li', class: slack.browseRow, attributes: [h.Key(row.id), h.DataAttribute('channel', row.name)], children: [
      buttonLink({ href: `/client/${row.id}`, variant: 'browse-row', size: 'browse', ariaLabel: `#${row.name}`, children: [
          box({ as: 'span', class: 'flex items-center gap-1 text-[15px] font-bold', children: [Icon.icon(row.kind === 'private' ? 'lock' : 'hash', { class: 'size-4' }, h), row.name] }, h),
          box({ as: 'span', class: 'flex min-w-0 items-center gap-1.5 text-[13px] font-normal text-muted-foreground', children: [
              ...(row.isMember ? [box({ as: 'span', class: 'flex items-center gap-0.5 font-semibold text-success', children: [Icon.icon('check', { class: 'size-3.5' }, h), 'Joined'] }, h), dot(h)] : []),
              box({ as: 'span', class: 'shrink-0', children: [`${row.memberCount} ${row.memberCount === 1 ? 'member' : 'members'}`] }, h),
              ...(row.description === '' ? [] : [dot(h), box({ as: 'span', class: 'min-w-0 truncate', children: [row.description] }, h)]),
            ] }, h),
        ] }, h),
      ...(row.isArchived
        ? []
        : row.isMember
          ? [button({ variant: 'outline', size: 'sm', marker: ['row-action', row.id], ariaLabel: `Leave #${row.name}`, isDisabled: model.pending === row.id || row.name === DEFAULT_CHANNEL, onClick: Message.ClickedLeave({ channelId: row.id }), children: ['Leave'] }, h)]
          : row.kind === 'public'
            ? [button({ variant: 'join', size: 'sm', marker: ['row-action', row.id], ariaLabel: `Join #${row.name}`, isDisabled: model.pending === row.id, onClick: Message.ClickedJoin({ channelId: row.id }), children: ['Join'] }, h)]
            : []),
    ] }, h)

const tab = (model: Model, show: Show, label: string, h: HtmlBuilder<Message>): Html =>
  button({ variant: model.show === show ? 'tab-active' : 'tab', size: 'tab', isPressed: model.show === show, onClick: Message.ClickedShow({ show }), children: [label] }, h)

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const rows = shownOf(model)
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('channel-browser')], children: [
      box({ class: 'flex flex-col gap-3 px-6 pt-4 pb-2', children: [
          input({ id: 'channel-filter', type: 'search', value: model.filter, placeholder: 'Search for channels', ariaLabel: 'Search for channels', autocomplete: 'off', onInput: text => Message.ChangedFilter({ text }) }, h),
          box({ class: 'flex items-center gap-1', attributes: [h.AriaLabel('Show')], children: [tab(model, 'all', 'All channels', h), tab(model, 'mine', 'Your channels', h), tab(model, 'archived', 'Archived', h)] }, h),
          box({ as: 'p', class: 'text-[13px] text-muted-foreground', children: [`${rows.length} ${rows.length === 1 ? 'result' : 'results'}`] }, h),
        ] }, h),
      box({ as: 'ul', class: 'min-h-0 flex-1 overflow-y-auto border-t px-2', attributes: [h.Id('channel-rows'), h.DataAttribute('keep-scroll', 'channels'), h.AriaLabel('Channels')], children: rows.length === 0
          ? [box({ as: 'li', class: 'py-10 text-center text-[15px] text-muted-foreground', children: [model.show === 'archived' ? 'No archived channels.' : 'No channels match your search.'] }, h)]
          : rows.map(row => rowView(model, row, h)) }, h),
    ] }, h)
}

const createDialog = (model: Model, h: HtmlBuilder<Message>): Html => {
  const name = channelSlug(model.form.name)
  return Dialog.dialog({
    model: model.create,
    toParentMessage: message => Message.GotCreateDialog({ message }),
    title: 'Create a channel',
    description: 'Channels are where conversations happen around a topic. Use a name that is easy to find and understand.',
    content: () => [
      box({ as: 'form', class: 'flex flex-col gap-4', attributes: [h.Id('create-channel-form'), h.OnSubmit(Message.SubmittedCreate())], children: [
          box({ class: 'flex flex-col gap-1.5', children: [
              box({ as: 'label', class: 'text-[14px] font-bold', attributes: [h.For('channel-name')], children: ['Name'] }, h),
              input({ id: 'channel-name', value: model.form.name, placeholder: 'e.g. plan-budget', autocomplete: 'off', onInput: text => Message.ChangedName({ text }), ariaLabel: 'Name' }, h),
              box({ as: 'p', class: 'text-[12px] text-muted-foreground', children: [name === '' ? 'Lower case, without spaces or periods.' : `#${name} · ${MAX_CHANNEL_NAME - name.length} characters left`] }, h),
            ] }, h),
          box({ class: 'flex flex-col gap-1.5', children: [
              box({ as: 'label', class: 'text-[14px] font-bold', attributes: [h.For('channel-description')], children: ['Description ', box({ as: 'span', class: 'font-normal text-muted-foreground', children: ['(optional)'] }, h)] }, h),
              input({ id: 'channel-description', value: model.form.description, placeholder: 'What is this channel about?', autocomplete: 'off', onInput: text => Message.ChangedDescription({ text }), ariaLabel: 'Description' }, h),
            ] }, h),
          checkbox({ id: 'channel-private', isChecked: model.form.isPrivate, onToggle: isChecked => Message.ToggledPrivate({ isChecked }), label: 'Make private: only invited people can find and read it' }, h),
        ] }, h),
    ],
    footer: () => [
      button({ variant: 'outline', onClick: Message.GotCreateDialog({ message: Dialog.Message.RequestedClose() }), children: ['Cancel'] }, h),
      button({ id: 'create-channel-button', variant: 'join', type: 'submit', form: 'create-channel-form', isDisabled: name === '' || model.form.isSaving, children: ['Create'] }, h),
    ],
  }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `All channels - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      region(h, { id: 'rail', deps: [model.me, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, active: 'home', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          region(h, { id: 'sidebar', deps: [model.nav, model.members, model.collapsed], render: () => sidebar({ nav: model.nav, members: model.members, activeId: 'channels', collapsed: model.collapsed, onToggleSection: section => Message.ClickedToggleSection({ section }) }, h) }),
          box({ as: 'main', class: slack.main, children: [
              box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', children: [
                  box({ as: 'h1', class: 'flex-1 text-[18px] font-black', children: ['All channels'] }, h),
                  button({ id: 'open-create-channel', variant: 'outline', size: 'sm', onClick: Message.ClickedCreate(), leadingIcon: Icon.icon('plus', {}, h), children: ['Create channel'] }, h),
                ] }, h),
              region(h, { id: 'channel-browser', deps: [model.rows, model.filter, model.show, model.pending], render: () => listView(model, h) }),
            ] }, h),
        ] }, h),
      region(h, { id: 'create', deps: [model.create, model.form, model.rows], render: () => box({ attributes: [h.Id('create')], children: [createDialog(model, h)] }, h) }),
      region(h, {
        id: 'notice',
        deps: [model.notice],
        render: () =>
          box({ class: 'pointer-events-none fixed right-4 bottom-24 z-[60]', attributes: [h.Id('notice'), h.AriaLive('polite')], children: model.notice === null
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
  name: 'channels',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      // `/channels?new` opens "Create a channel" (the sidebar's Add channels).
      return { me, rows: channelsOf(state, me), nav: navOf(state, me), members: state.members, isCreating: request.url.searchParams.has('new') }
    }),
  init,
  update,
  view,
  subscriptions,
  clientCommands: {
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
    LoadUrl: ({ url }) => (typeof url === 'string' && url.startsWith('/client/') ? { load: url } : undefined),
  },
  snapshotDeps: model => [model.collapsed, model.filter, model.show, model.create, model.form, model.notice],
}
