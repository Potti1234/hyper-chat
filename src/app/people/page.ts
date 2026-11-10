import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { button, buttonLink } from '@/ui/button'
import * as Dialog from '@/ui/dialog'
import { input } from '@/ui/input'

import { requireMember } from '../auth'
import { Member, handleOf } from '../domain'
import { STATUS_CHOICES, STATUS_PRESETS, isEmoji } from '../emoji'
import { CLEAR_AFTER, CLEAR_AFTER_LABELS, MAX_NAME, MAX_PRONOUNS, MAX_STATUS, MAX_TITLE, PAUSE_FOR, TIME_ZONES, clearAt, isClearAfter, isPaused, isTimeZone, localTime, statusOf, timeZoneLabel, timeZoneOf, untilLabel } from '../profile'
import { sameIds } from '../presence'
import { Workspace, type WorkspaceState, presenceWhile } from '../store'
import { box, optionRow, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, topBar, WORKSPACE_NAME } from '../view/shell'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'

/* Slack's People: everyone in the workspace, filtered by name or title, and
   a profile pane (`/people/:id`) with their title, pronouns, local time and
   status, and a Message button. On your own profile you edit it, set a
   custom status and pause notifications. */

// MODEL

const ProfileForm = S.Struct({ name: S.String, title: S.String, pronouns: S.String, timeZone: S.String, isSaving: S.Boolean })
type ProfileForm = typeof ProfileForm.Type

const StatusForm = S.Struct({ emoji: S.String, text: S.String, clearAfter: S.String, isSaving: S.Boolean })
type StatusForm = typeof StatusForm.Type

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  online: S.Array(S.String),
  nav: Nav,
  switcher: Switcher,
  isConnected: S.Boolean,
  now: S.Number,
  filter: S.String,
  personId: S.NullOr(S.String),
  edit: Dialog.Model,
  profile: ProfileForm,
  status: Dialog.Model,
  statusForm: StatusForm,
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

const ProfileField = S.Literals(['name', 'title', 'pronouns'])

export const Message = defineMessageUnion({
  ChangedFilter: { text: S.String },
  ClickedEditProfile: {},
  GotEditDialog: { message: Dialog.Message },
  ChangedProfile: { field: ProfileField, text: S.String },
  PickedTimeZone: { zone: S.String },
  SubmittedProfile: {},
  ClickedSetStatus: {},
  GotStatusDialog: { message: Dialog.Message },
  PickedStatusEmoji: { emoji: S.String },
  ChangedStatusText: { text: S.String },
  PickedClearAfter: { choice: S.String },
  PickedPreset: { index: S.Number },
  SubmittedStatus: {},
  ClickedClearStatus: {},
  ClickedPause: { minutes: S.Number },
  ClickedResume: {},
  GotSwitcher: { event: SwitcherEvent },
  ChangedConnection: { isConnected: S.Boolean },
  ClickedToggleTheme: {},
  GotPeople: { members: S.Array(Member), online: S.Array(S.String), nav: Nav, me: Member, now: S.Number },
  CompletedProfile: {},
  CompletedStatus: {},
  CompletedChange: {},
  FailedChange: { reason: S.String },
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). */
export const ClientMessage = S.Union([
  Message.ChangedFilter, Message.ClickedEditProfile, S.TaggedStruct('GotEditDialog', { message: Dialog.Message.RequestedClose }),
  Message.ChangedProfile, Message.PickedTimeZone, Message.SubmittedProfile,
  Message.ClickedSetStatus, S.TaggedStruct('GotStatusDialog', { message: Dialog.Message.RequestedClose }),
  Message.PickedStatusEmoji, Message.ChangedStatusText, Message.PickedClearAfter, Message.PickedPreset, Message.SubmittedStatus, Message.ClickedClearStatus,
  Message.ClickedPause, Message.ClickedResume,
  S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }), Message.ClickedToggleTheme,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

const failed = ({ reason }: Readonly<{ reason: string }>) => Effect.succeed(Message.FailedChange({ reason }))

export const UpdateProfile = Command.define('UpdateProfile', {
  args: { memberId: S.String, name: S.String, title: S.String, pronouns: S.String, timeZone: S.String },
  messages: [Message.CompletedProfile, Message.FailedChange],
  execute: ({ memberId, ...input }) =>
    Workspace.use(workspace => workspace.updateProfile(memberId, input)).pipe(Effect.as(Message.CompletedProfile()), Effect.catchTag('InvalidChange', failed)),
})

export const SetStatus = Command.define('SetStatus', {
  args: { memberId: S.String, emoji: S.String, text: S.String, clearAfter: S.String },
  messages: [Message.CompletedStatus, Message.FailedChange],
  execute: ({ memberId, emoji, text, clearAfter }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const workspace = yield* Workspace
      const me = yield* workspace.member(memberId)
      const until = me === undefined || !isClearAfter(clearAfter) ? 0 : clearAt(clearAfter, now, timeZoneOf(me))
      yield* workspace.setStatus(memberId, { emoji, text, until })
      return Message.CompletedStatus()
    }).pipe(Effect.catchTag('InvalidChange', failed)),
})

export const SetPaused = Command.define('SetPaused', {
  args: { memberId: S.String, minutes: S.Number },
  messages: [Message.CompletedChange],
  execute: ({ memberId, minutes }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Workspace.use(workspace => workspace.setPaused(memberId, minutes <= 0 ? 0 : now + minutes * 60_000))
      return Message.CompletedChange()
    }),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

// DATA

/** Everyone whose name, handle or title has every word of the filter, A to Z. */
export const peopleOf = (members: ReadonlyArray<Member>, filter: string): ReadonlyArray<Member> => {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  return members
    .filter(member => words.every(word => `${member.name} ${handleOf(member)} ${member.title}`.toLowerCase().includes(word)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const profileFormOf = (me: Member): ProfileForm => ({ name: me.name, title: me.title, pronouns: me.pronouns ?? '', timeZone: timeZoneOf(me), isSaving: false })

const statusFormOf = (me: Member, now: number): StatusForm => {
  const status = statusOf(me, now)
  return { emoji: status?.emoji ?? '', text: status?.text ?? '', clearAfter: status === undefined ? 'today' : 'never', isSaving: false }
}

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; online: ReadonlyArray<string>; nav: Nav; now: number; personId: string | null }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({
  model: {
    ...flags,
    switcher: initSwitcher(), isConnected: false,
    filter: '',
    edit: Dialog.init({ id: 'edit-profile' }),
    profile: profileFormOf(flags.me),
    status: Dialog.init({ id: 'set-status' }),
    statusForm: statusFormOf(flags.me, flags.now),
    notice: null,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const withEdit = (model: Model, dialogUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, edit: dialogUpdate.model, notice: null, profile: dialogUpdate.model.isOpen && model.edit.isOpen ? model.profile : profileFormOf(model.me) },
  commands: Command.mapMessages(dialogUpdate.commands, message => Message.GotEditDialog({ message })),
})

const withStatus = (model: Model, dialogUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, status: dialogUpdate.model, notice: null, statusForm: dialogUpdate.model.isOpen && model.status.isOpen ? model.statusForm : statusFormOf(model.me, model.now) },
  commands: Command.mapMessages(dialogUpdate.commands, message => Message.GotStatusDialog({ message })),
})

const isMine = (model: Model) => model.personId === model.me.id

const editProfile = (model: Model, patch: Partial<ProfileForm>): UpdateReturn =>
  model.edit.isOpen && !model.profile.isSaving ? { model: { ...model, profile: { ...model.profile, ...patch } } } : { model }

const editStatus = (model: Model, patch: Partial<StatusForm>): UpdateReturn =>
  model.status.isOpen && !model.statusForm.isSaving ? { model: { ...model, statusForm: { ...model.statusForm, ...patch } } } : { model }

const LIMITS: Readonly<Record<typeof ProfileField.Type, number>> = { name: MAX_NAME, title: MAX_TITLE, pronouns: MAX_PRONOUNS }

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedFilter: ({ text }) => ({ model: { ...model, filter: text.slice(0, 100) } }),
      ClickedEditProfile: () => (isMine(model) ? withEdit(model, Dialog.open(model.edit)) : { model }),
      GotEditDialog: ({ message }) => withEdit(model, Dialog.update(model.edit, message)),
      ChangedProfile: ({ field, text }) => editProfile(model, { [field]: text.slice(0, LIMITS[field]) }),
      PickedTimeZone: ({ zone }) => (isTimeZone(zone) ? editProfile(model, { timeZone: zone }) : { model }),
      SubmittedProfile: () => {
        const form = model.profile
        if (!model.edit.isOpen || form.isSaving) return { model }
        if (form.name.trim() === '') return { model: { ...model, notice: 'Your full name can’t be empty.' } }
        return { model: { ...model, notice: null, profile: { ...form, isSaving: true } }, commands: [UpdateProfile({ memberId: model.me.id, name: form.name, title: form.title, pronouns: form.pronouns, timeZone: form.timeZone })] }
      },
      ClickedSetStatus: () => (isMine(model) ? withStatus(model, Dialog.open(model.status)) : { model }),
      GotStatusDialog: ({ message }) => withStatus(model, Dialog.update(model.status, message)),
      PickedStatusEmoji: ({ emoji }) => (isEmoji(emoji) ? editStatus(model, { emoji }) : { model }),
      ChangedStatusText: ({ text }) => editStatus(model, { text: text.slice(0, MAX_STATUS) }),
      PickedClearAfter: ({ choice }) => (isClearAfter(choice) ? editStatus(model, { clearAfter: choice }) : { model }),
      PickedPreset: ({ index }) => {
        const preset = STATUS_PRESETS[index]
        return preset === undefined ? { model } : editStatus(model, { emoji: preset[0], text: preset[1], clearAfter: preset[2] })
      },
      SubmittedStatus: () => {
        const form = model.statusForm
        if (!model.status.isOpen || form.isSaving) return { model }
        return { model: { ...model, notice: null, statusForm: { ...form, isSaving: true } }, commands: [SetStatus({ memberId: model.me.id, emoji: form.emoji, text: form.text, clearAfter: form.clearAfter })] }
      },
      ClickedClearStatus: () =>
        statusOf(model.me, model.now) === undefined ? { model } : { model, commands: [SetStatus({ memberId: model.me.id, emoji: '', text: '', clearAfter: 'never' })] },
      ClickedPause: ({ minutes }) => (PAUSE_FOR.some(([choice]) => choice === minutes) ? { model, commands: [SetPaused({ memberId: model.me.id, minutes })] } : { model }),
      ClickedResume: () => (isPaused(model.me, model.now) ? { model, commands: [SetPaused({ memberId: model.me.id, minutes: 0 })] } : { model }),
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      GotPeople: data => ({ model: { ...model, ...data } }),
      CompletedProfile: () => withEdit({ ...model, profile: { ...model.profile, isSaving: false } }, Dialog.close(model.edit)),
      CompletedStatus: () => withStatus({ ...model, statusForm: { ...model.statusForm, isSaving: false } }, Dialog.close(model.status)),
      CompletedChange: () => ({ model }),
      FailedChange: ({ reason }) => ({ model: { ...model, notice: reason, profile: { ...model.profile, isSaving: false }, statusForm: { ...model.statusForm, isSaving: false } } }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ members: ReadonlyArray<Member>; online: ReadonlyArray<string>; nav: Nav; me: Member | null }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return { members: state.members, online: state.online, nav: me === null ? emptyNav : navOf(state, me), me }
}

const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && sameIds(a.online, b.online) && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  presence: entry(
    { memberId: S.String, isConnected: S.Boolean },
    { modelToDependencies: model => ({ memberId: model.me.id, isConnected: model.isConnected }), dependenciesToStream: ({ memberId, isConnected }) => presenceWhile(memberId, isConnected) },
  ),
  people: entry(
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
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotPeople({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const statusLine = (member: Member, now: number, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const status = statusOf(member, now)
  return status === undefined
    ? []
    : [box({ as: 'p', class: 'flex items-center gap-1.5 text-[14px]', attributes: [h.DataAttribute('profile-status', '')], children: [
        box({ as: 'span', children: [status.emoji] }, h),
        box({ as: 'span', class: 'min-w-0 truncate', children: [status.text] }, h),
        ...(status.until === 0 ? [] : [box({ as: 'span', class: 'shrink-0 text-muted-foreground', children: [untilLabel(status.until, now, timeZoneOf(member))] }, h)]),
      ] }, h)]
}

const presenceOf = (model: Model, person: Member, h: HtmlBuilder<Message>): Html => {
  const isActive = model.online.includes(person.id)
  return box({ as: 'span', class: isActive ? slack.presenceOn : slack.presenceOff, attributes: [h.AriaLabel(isActive ? 'Active' : 'Away'), h.DataAttribute('presence', isActive ? 'active' : 'away')] }, h)
}

const personCard = (model: Model, person: Member, h: HtmlBuilder<Message>): Html => {
  const status = statusOf(person, model.now)
  return box({ as: 'li', children: [
      box({ as: 'a', class: slack.personCard, attributes: [h.Href(`/people/${person.id}`), h.DataAttribute('person', person.id), ...(person.id === model.personId ? [h.AriaCurrent('page')] : [])], children: [
          avatar(person, h, 'xl', 'w-full h-auto aspect-square text-5xl'),
          box({ class: 'flex min-w-0 flex-col gap-0.5 p-3', children: [
              box({ as: 'p', class: 'flex items-center gap-1.5 text-[15px] font-bold', children: [
                  presenceOf(model, person, h),
                  box({ as: 'span', class: 'min-w-0 truncate', children: [person.id === model.me.id ? `${person.name} (you)` : person.name] }, h),
                  ...(status === undefined ? [] : [box({ as: 'span', attributes: [h.Title(status.text)], children: [status.emoji] }, h)]),
                ] }, h),
              box({ as: 'p', class: 'min-w-0 truncate text-[13px] text-muted-foreground', children: [person.title === '' ? `@${handleOf(person)}` : person.title] }, h),
            ] }, h),
        ] }, h),
    ] }, h)
}

const directoryView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const people = peopleOf(model.members, model.filter)
  return box({ class: 'flex min-h-0 flex-1 flex-col', attributes: [h.Id('people')], children: [
      box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-5', children: [
          box({ as: 'h1', class: 'flex-1 text-[18px] font-black', children: ['People'] }, h),
        ] }, h),
      box({ class: 'relative shrink-0 px-5 pt-4', children: [
          Icon.icon('search', { class: 'pointer-events-none absolute top-6.5 left-7.5 z-10 size-4 text-muted-foreground' }, h),
          input({ id: 'people-filter', type: 'search', value: model.filter, placeholder: 'Search for people', ariaLabel: 'Search for people', autocomplete: 'off', onInput: text => Message.ChangedFilter({ text }), variant: 'search' }, h),
        ] }, h),
      box({ as: 'p', class: 'shrink-0 px-5 pt-3 text-[13px] text-muted-foreground', children: [`${people.length} ${people.length === 1 ? 'person' : 'people'}`] }, h),
      people.length === 0
        ? box({ class: 'flex flex-col items-center gap-2 px-6 py-16 text-center', children: [
            Icon.users({ class: 'size-10 text-muted-foreground' }, h),
            box({ as: 'p', class: 'text-[18px] font-bold', children: [`No one matches “${model.filter.trim()}”`] }, h),
          ] }, h)
        : box({ as: 'ul', class: slack.peopleGrid, attributes: [h.Id('people-list'), h.DataAttribute('keep-scroll', 'people'), h.AriaLabel('People')], children: people.map(person => personCard(model, person, h)) }, h),
    ] }, h)
}

const fact = (label: string, value: Html | string, h: HtmlBuilder<Message>): Html =>
  box({ class: 'flex flex-col gap-0.5', children: [
      box({ as: 'p', class: 'text-[13px] font-bold', children: [label] }, h),
      box({ as: 'p', class: 'text-[14px] text-muted-foreground', children: [value] }, h),
    ] }, h)

/** Their one-to-one DM if you have one, otherwise a new message to them. */
const messageHref = (model: Model, personId: string): string => {
  const dm = model.nav.dms.find(row => row.partnerIds.length === 1 && row.partnerIds[0] === personId)
  return dm === undefined ? `/dms?to=${personId}` : `/client/${dm.id}`
}

const ownControls = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const paused = isPaused(model.me, model.now)
  return [
    box({ class: 'flex flex-wrap gap-2', children: [
        button({ id: 'set-status-button', variant: 'outline', size: 'sm', onClick: Message.ClickedSetStatus(), leadingIcon: Icon.icon('smile', {}, h), children: [statusOf(model.me, model.now) === undefined ? 'Set a status' : 'Edit status'] }, h),
        ...(statusOf(model.me, model.now) === undefined ? [] : [button({ id: 'clear-status-button', variant: 'outline', size: 'sm', onClick: Message.ClickedClearStatus(), children: ['Clear status'] }, h)]),
        button({ id: 'edit-profile-button', variant: 'outline', size: 'sm', onClick: Message.ClickedEditProfile(), leadingIcon: Icon.icon('pencil', {}, h), children: ['Edit profile'] }, h),
      ] }, h),
    box({ class: 'flex flex-col gap-2 border-t pt-4', attributes: [h.Id('pause')], children: [
        box({ as: 'p', class: 'flex items-center gap-1.5 text-[13px] font-bold', children: [Icon.icon(paused ? 'bell-off' : 'bell', { class: 'size-4' }, h), paused ? `Notifications paused ${untilLabel(model.me.pausedUntil ?? 0, model.now, timeZoneOf(model.me))}` : 'Pause notifications'] }, h),
        box({ class: 'flex flex-wrap gap-1.5', children: paused
            ? [button({ id: 'resume-button', variant: 'outline', size: 'sm', onClick: Message.ClickedResume(), children: ['Resume notifications'] }, h)]
            : PAUSE_FOR.map(([minutes, label]) => button({ variant: 'outline', size: 'sm', marker: ['pause', String(minutes)], onClick: Message.ClickedPause({ minutes }), children: [label] }, h)) }, h),
      ] }, h),
  ]
}

const profileView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const person = model.members.find(member => member.id === model.personId)
  if (person === undefined) return box({ as: 'aside', class: slack.profilePane, attributes: [h.Id('profile'), h.AriaLabel('Profile')], children: model.personId === null ? [] : [box({ as: 'p', class: 'p-5 text-muted-foreground', children: ['This person is no longer in the workspace.'] }, h)] }, h)
  const mine = person.id === model.me.id
  return box({ as: 'aside', class: slack.profilePane, attributes: [h.Id('profile'), h.AriaLabel(`Profile of ${person.name}`), h.DataAttribute('profile', person.id)], children: [
      box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', children: [
          box({ as: 'h2', class: 'flex-1 text-[18px] font-black', children: ['Profile'] }, h),
          buttonLink({ href: '/people', variant: 'ghost', size: 'icon-sm', ariaLabel: 'Close profile', children: [Icon.icon('x', {}, h)] }, h),
        ] }, h),
      box({ class: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5', children: [
          avatar(person, h, 'xl', 'mx-auto'),
          box({ class: 'flex flex-col gap-1', children: [
              box({ as: 'h3', class: 'text-[22px] font-black', attributes: [h.Id('profile-name')], children: [person.name, ...(person.pronouns === undefined || person.pronouns === '' ? [] : [box({ as: 'span', class: 'ml-2 text-[15px] font-normal text-muted-foreground', children: [person.pronouns] }, h)])] }, h),
              ...(person.title === '' ? [] : [box({ as: 'p', class: 'text-[15px]', attributes: [h.Id('profile-title')], children: [person.title] }, h)]),
              box({ as: 'p', class: 'flex items-center gap-1.5 text-[13px] text-muted-foreground', attributes: [h.Id('profile-presence')], children: [presenceOf(model, person, h), model.online.includes(person.id) ? 'Active' : 'Away'] }, h),
              ...statusLine(person, model.now, h),
              ...(isPaused(person, model.now) ? [box({ as: 'p', class: 'flex items-center gap-1.5 text-[13px] text-muted-foreground', children: [Icon.icon('bell-off', { class: 'size-3.5' }, h), 'Notifications paused'] }, h)] : []),
            ] }, h),
          ...(mine ? ownControls(model, h) : [box({ class: 'flex gap-2', children: [buttonLink({ id: 'message-person', href: messageHref(model, person.id), variant: 'outline', size: 'sm', leadingIcon: Icon.icon('message-circle', {}, h), children: ['Message'] }, h)] }, h)]),
          box({ class: 'flex flex-col gap-3 border-t pt-4', children: [
              fact('Local time', `${localTime(person, model.now)} · ${timeZoneLabel(timeZoneOf(person))}`, h),
              fact('Email address', box({ as: 'a', class: 'text-link hover:underline', attributes: [h.Href(`mailto:${person.email}`)], children: [person.email] }, h), h),
              fact('Handle', `@${handleOf(person)}`, h),
            ] }, h),
        ] }, h),
    ] }, h)
}

const field = (id: string, label: string, control: Html, h: HtmlBuilder<Message>): Html =>
  box({ class: 'flex flex-col gap-1.5', children: [box({ as: 'label', class: 'text-[14px] font-bold', attributes: [h.For(id)], children: [label] }, h), control] }, h)

const noticeView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.notice === null ? [] : [box({ as: 'p', class: 'text-[13px] text-destructive', attributes: [h.Role('alert')], children: [model.notice] }, h)]

const editDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Dialog.dialog({
    model: model.edit,
    toParentMessage: message => Message.GotEditDialog({ message }),
    title: 'Edit your profile',
    content: () => [
      box({ as: 'form', class: 'flex flex-col gap-4', attributes: [h.Id('edit-profile-form'), h.OnSubmit(Message.SubmittedProfile())], children: [
          field('profile-name-input', 'Full name', input({ id: 'profile-name-input', value: model.profile.name, autocomplete: 'off', onInput: text => Message.ChangedProfile({ field: 'name', text }), ariaLabel: 'Full name' }, h), h),
          field('profile-title-input', 'Title', input({ id: 'profile-title-input', value: model.profile.title, placeholder: 'What do you do?', autocomplete: 'off', onInput: text => Message.ChangedProfile({ field: 'title', text }), ariaLabel: 'Title' }, h), h),
          field('profile-pronouns-input', 'Pronouns', input({ id: 'profile-pronouns-input', value: model.profile.pronouns, placeholder: 'e.g. she/her', autocomplete: 'off', onInput: text => Message.ChangedProfile({ field: 'pronouns', text }), ariaLabel: 'Pronouns' }, h), h),
          box({ class: 'flex flex-col gap-1.5', children: [
              box({ as: 'p', class: 'text-[14px] font-bold', attributes: [h.Id('time-zone-label')], children: ['Time zone'] }, h),
              box({ class: 'flex max-h-[180px] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-md border p-1', attributes: [h.Id('time-zones'), h.Role('listbox'), h.AriaLabelledBy('time-zone-label')], children: TIME_ZONES.map(([zone, label]) =>
                  optionRow({ id: `zone-${zone.replace(/\//g, '-')}`, value: zone, isActive: model.profile.timeZone === zone, onClick: Message.PickedTimeZone({ zone }), children: [label] }, h),
                ) }, h),
            ] }, h),
          ...noticeView(model, h),
        ] }, h),
    ],
    footer: () => [
      button({ variant: 'outline', onClick: Message.GotEditDialog({ message: Dialog.Message.RequestedClose() }), children: ['Cancel'] }, h),
      button({ id: 'save-profile-button', variant: 'join', type: 'submit', form: 'edit-profile-form', isDisabled: model.profile.isSaving || model.profile.name.trim() === '', children: ['Save changes'] }, h),
    ],
  }, h)

const statusDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Dialog.dialog({
    model: model.status,
    toParentMessage: message => Message.GotStatusDialog({ message }),
    title: 'Set a status',
    content: () => [
      box({ as: 'form', class: 'flex flex-col gap-4', attributes: [h.Id('set-status-form'), h.OnSubmit(Message.SubmittedStatus())], children: [
          box({ class: 'flex flex-wrap gap-1', attributes: [h.Id('status-emoji'), h.Role('group'), h.AriaLabel('Status emoji')], children: STATUS_CHOICES.map(emoji =>
              button({ variant: model.statusForm.emoji === emoji ? 'reaction-mine' : 'emoji', size: 'icon-sm', isPressed: model.statusForm.emoji === emoji, ariaLabel: `Use ${emoji}`, onClick: Message.PickedStatusEmoji({ emoji }), children: [emoji] }, h),
            ) }, h),
          field('status-text', "What's your status?", input({ id: 'status-text', value: model.statusForm.text, placeholder: "What's your status?", autocomplete: 'off', onInput: text => Message.ChangedStatusText({ text }), ariaLabel: 'Status' }, h), h),
          box({ class: 'flex flex-col gap-1', children: [
              box({ as: 'p', class: 'text-[13px] font-bold text-muted-foreground', children: ['For example:'] }, h),
              box({ class: 'flex flex-col', attributes: [h.Id('status-presets')], children: STATUS_PRESETS.map(([emoji, text, clearAfter], index) =>
                  optionRow({ id: `preset-${index}`, value: text, isActive: model.statusForm.text === text && model.statusForm.emoji === emoji, onClick: Message.PickedPreset({ index }), children: [
                      box({ as: 'span', children: [emoji] }, h),
                      box({ as: 'span', class: 'font-semibold', children: [text] }, h),
                      box({ as: 'span', class: 'text-muted-foreground', children: [`— ${CLEAR_AFTER_LABELS[clearAfter]}`] }, h),
                    ] }, h),
                ) }, h),
            ] }, h),
          box({ class: 'flex flex-col gap-1.5', children: [
              box({ as: 'p', class: 'text-[14px] font-bold', children: ['Clear after'] }, h),
              box({ class: 'flex flex-wrap gap-1', attributes: [h.Id('clear-after'), h.Role('group'), h.AriaLabel('Clear after')], children: CLEAR_AFTER.map(choice =>
                  button({ variant: model.statusForm.clearAfter === choice ? 'tab-active' : 'tab', size: 'tab', isPressed: model.statusForm.clearAfter === choice, marker: ['clear-after', choice], onClick: Message.PickedClearAfter({ choice }), children: [CLEAR_AFTER_LABELS[choice]] }, h),
                ) }, h),
            ] }, h),
          ...noticeView(model, h),
        ] }, h),
    ],
    footer: () => [
      button({ variant: 'outline', onClick: Message.GotStatusDialog({ message: Dialog.Message.RequestedClose() }), children: ['Cancel'] }, h),
      button({ id: 'save-status-button', variant: 'join', type: 'submit', form: 'set-status-form', isDisabled: model.statusForm.isSaving || (model.statusForm.text.trim() === '' && model.statusForm.emoji === ''), children: ['Save'] }, h),
    ],
  }, h)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.members.find(member => member.id === model.personId)?.name ?? 'People'} - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'people', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          box({ as: 'main', class: slack.main, children: [
              region(h, { id: 'people', deps: [model.members, model.me.id, model.filter, model.personId, model.now, model.online], render: () => directoryView(model, h) }),
            ] }, h),
          ...(model.personId === null ? [] : [region(h, { id: 'profile', deps: [model.members, model.me, model.personId, model.now, model.nav.dms, model.online], render: () => profileView(model, h) })]),
        ] }, h),
      region(h, { id: 'profile-dialogs', deps: [model.edit, model.profile, model.status, model.statusForm, model.notice], render: () => box({ attributes: [h.Id('profile-dialogs')], children: [editDialog(model, h), statusDialog(model, h)] }, h) }),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'people',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      return { me, members: state.members, online: state.online, nav: navOf(state, me), now, personId: request.params['person'] ?? null }
    }),
  init,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  update,
  view,
  subscriptions,
  clientCommands: switcherClientCommands,
}
