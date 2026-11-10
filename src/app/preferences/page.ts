import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type PageRequest, type Program, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { text } from '@/ui/text'

import { requireMember } from '../auth'
import { Member, type Preferences, formatTime, preferencesOf } from '../domain'
import { SIDEBAR_THEMES, type SidebarTheme, isSidebarSlug } from '../preferences'
import { Workspace, type WorkspaceState, presenceWhile } from '../store'
import { choice } from '../view/choice'
import { box, pageRoot, slack, swatch } from '../view/design'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, topBar, WORKSPACE_NAME } from '../view/shell'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'
import { THEME_PRESETS, type ThemePreset, isThemeSlug } from '../view/themes'

/* Slack's Preferences: Appearance (light or dark, a sidebar colour theme
   and a creaseui preset for the rest) and Messages & media (clean or
   compact display, 12- or 24-hour clock). Choices are stored on the member
   and every page they have open picks them up live. */

// MODEL

export const Model = S.Struct({
  me: Member,
  members: S.Array(Member),
  nav: Nav,
  switcher: Switcher,
  isConnected: S.Boolean,
  now: S.Number,
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedMode: { isDark: S.Boolean },
  ClickedSidebar: { slug: S.String },
  ClickedPreset: { slug: S.String },
  ClickedDensity: { isCompact: S.Boolean },
  ClickedClock: { is24Hour: S.Boolean },
  ClickedToggleTheme: {},
  GotSwitcher: { event: SwitcherEvent },
  ChangedConnection: { isConnected: S.Boolean },
  GotPreferences: { me: Member, members: S.Array(Member), nav: Nav, now: S.Number },
  CompletedChange: {},
  FailedChange: { reason: S.String },
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). */
export const ClientMessage = S.Union([
  Message.ClickedMode,
  Message.ClickedSidebar,
  Message.ClickedPreset,
  Message.ClickedDensity,
  Message.ClickedClock,
  Message.ClickedToggleTheme,
  S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }),
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

export const SetPreset = Command.define('SetPreset', {
  args: { memberId: S.String, theme: S.String },
  messages: [Message.CompletedChange],
  execute: ({ memberId, theme }) => Workspace.use(workspace => workspace.setPreset(memberId, theme)).pipe(Effect.as(Message.CompletedChange())),
})

export const SetPreferences = Command.define('SetPreferences', {
  args: { memberId: S.String, sidebar: S.String, isCompact: S.Boolean, is24Hour: S.Boolean },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ memberId, ...preferences }) =>
    Workspace.use(workspace => workspace.setPreferences(memberId, preferences)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

// INIT

export type Flags = Readonly<{ me: Member; members: ReadonlyArray<Member>; nav: Nav; now: number }>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({ model: { ...flags, switcher: initSwitcher(), isConnected: false, notice: null } })

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

/** Shows the choice at once; the store's copy follows through the subscription. */
const choose = (model: Model, change: Partial<Preferences>): UpdateReturn => {
  const before = preferencesOf(model.me)
  const preferences = { ...before, ...change }
  if (preferences.sidebar === before.sidebar && preferences.isCompact === before.isCompact && preferences.is24Hour === before.is24Hour) return { model }
  return { model: { ...model, notice: null, me: { ...model.me, preferences } }, commands: [SetPreferences({ memberId: model.me.id, ...preferences })] }
}

const setMode = (model: Model, isDark: boolean): UpdateReturn =>
  isDark === model.me.isDark ? { model } : { model: { ...model, me: { ...model.me, isDark } }, commands: [SetTheme({ memberId: model.me.id, isDark })] }

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ClickedMode: ({ isDark }) => setMode(model, isDark),
      ClickedToggleTheme: () => setMode(model, !model.me.isDark),
      // Slugs are posted by the browser: only known ones are stored.
      ClickedSidebar: ({ slug }) => (isSidebarSlug(slug) ? choose(model, { sidebar: slug }) : { model }),
      ClickedPreset: ({ slug }) =>
        slug === model.me.theme || !isThemeSlug(slug) ? { model } : { model: { ...model, me: { ...model.me, theme: slug } }, commands: [SetPreset({ memberId: model.me.id, theme: slug })] },
      ClickedDensity: ({ isCompact }) => choose(model, { isCompact }),
      ClickedClock: ({ is24Hour }) => choose(model, { is24Hour }),
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      GotPreferences: data => ({ model: { ...model, ...data } }),
      CompletedChange: () => ({ model }),
      FailedChange: ({ reason }) => ({ model: { ...model, notice: reason } }),
    }),
  )

// SUBSCRIPTION

type Slice = Readonly<{ me: Member | null; members: ReadonlyArray<Member>; nav: Nav }>

const sliceOf = (state: WorkspaceState, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  return { me, members: state.members, nav: me === null ? emptyNav : navOf(state, me) }
}

const sameSlice = (a: Slice, b: Slice) => a.me === b.me && a.members === b.members && sameNav(a.nav, b.nav)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  presence: entry(
    { memberId: S.String, isConnected: S.Boolean },
    { modelToDependencies: model => ({ memberId: model.me.id, isConnected: model.isConnected }), dependenciesToStream: ({ memberId, isConnected }) => presenceWhile(memberId, isConnected) },
  ),
  preferences: entry(
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
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotPreferences({ me: slice.me, members: slice.members, nav: slice.nav, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

/** The app's own look: Slack's palette, no preset class on the page root. */
const SLACK_THEME: ThemePreset = {
  slug: '',
  name: 'Slack',
  description: 'The app’s own theme: Slack’s whites and greys, Lato-like type',
  scheme: 'both',
  swatches: ['oklch(0.5 0.11 165)', 'oklch(0.955 0.004 330)', 'oklch(0.972 0.002 330)', 'oklch(1 0 0)'],
}


const group = (id: string, title: string, hint: string, columns: string, choices: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  box({ as: 'section', class: 'grid gap-2', attributes: [h.Id(id), h.AriaLabel(title)], children: [
      text({ children: [title], type: 'body', weight: 'semibold' }, h),
      text({ children: [hint], type: 'supporting', color: 'secondary' }, h),
      box({ class: `grid grid-cols-1 gap-2 pt-1 ${columns}`, attributes: [h.Role('group'), h.AriaLabel(title)], children: choices }, h),
    ] }, h)

const sidebarChoice = (theme: SidebarTheme, current: string, h: HtmlBuilder<Message>): Html =>
  choice({ id: theme.slug === '' ? 'sidebar-default' : `sidebar-${theme.slug}`, isActive: theme.slug === current, onPick: Message.ClickedSidebar({ slug: theme.slug }), label: theme.name, media: theme.swatches.map(color => swatch({ color }, h)) }, h)

const appearanceView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const preferences = preferencesOf(model.me)
  return box({ class: 'grid gap-8', attributes: [h.Id('appearance')], children: [
      group('color-mode', 'Color mode', 'Light or dark, for every page you open.', 'sm:grid-cols-2', [
        choice({ id: 'mode-light', isActive: !model.me.isDark, onPick: Message.ClickedMode({ isDark: false }), label: 'Light', media: [Icon.icon('sun', {}, h)] }, h),
        choice({ id: 'mode-dark', isActive: model.me.isDark, onPick: Message.ClickedMode({ isDark: true }), label: 'Dark', media: [Icon.icon('moon', {}, h)] }, h),
      ], h),
      group('sidebar-themes', 'Sidebar', 'Slack’s colour themes for the rail and sidebar. Aubergine follows the theme below.', 'sm:grid-cols-2 lg:grid-cols-4', SIDEBAR_THEMES.map(theme => sidebarChoice(theme, preferences.sidebar, h)), h),
      group('themes', 'Theme', 'A creaseui preset for the rest of the app: colours, type and corners.', 'sm:grid-cols-2', [SLACK_THEME, ...THEME_PRESETS].map(preset =>
        choice({ id: preset.slug === '' ? 'preset-default' : `preset-${preset.slug}`, isActive: model.me.theme === preset.slug, onPick: Message.ClickedPreset({ slug: preset.slug }), label: preset.name, description: preset.description, media: preset.swatches.map(color => swatch({ color }, h)) }, h)), h),
    ] }, h)
}

const messagesView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const preferences = preferencesOf(model.me)
  const sample = (is24Hour: boolean) => formatTime(model.now, { ...model.me, preferences: { ...preferences, is24Hour } })
  return box({ class: 'grid gap-8', attributes: [h.Id('messages-media')], children: [
      group('message-display', 'Message display', 'Compact fits more on screen: no pictures next to messages.', 'sm:grid-cols-2', [
        choice({ id: 'display-clean', isActive: !preferences.isCompact, onPick: Message.ClickedDensity({ isCompact: false }), label: 'Clean', description: 'Names and pictures, roomy rows', media: [Icon.icon('rows-3', {}, h)] }, h),
        choice({ id: 'display-compact', isActive: preferences.isCompact, onPick: Message.ClickedDensity({ isCompact: true }), label: 'Compact', description: 'No pictures, tighter rows', media: [Icon.icon('rows-4', {}, h)] }, h),
      ], h),
      group('clock', 'Clock', 'How times next to messages read, in your time zone (set on your profile).', 'sm:grid-cols-2', [
        choice({ id: 'clock-12', isActive: !preferences.is24Hour, onPick: Message.ClickedClock({ is24Hour: false }), label: '12-hour', description: sample(false), media: [Icon.icon('clock', {}, h)] }, h),
        choice({ id: 'clock-24', isActive: preferences.is24Hour, onPick: Message.ClickedClock({ is24Hour: true }), label: '24-hour', description: sample(true), media: [Icon.icon('clock', {}, h)] }, h),
      ], h),
    ] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Preferences - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, preferences: model.me.preferences, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'preferences', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          box({ as: 'main', class: slack.main, children: [
              box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-5', children: [box({ as: 'h1', class: 'text-[18px] font-bold', children: ['Preferences'] }, h)] }, h),
              box({ class: 'min-h-0 flex-1 overflow-y-auto', attributes: [h.DataAttribute('keep-scroll', 'preferences')], children: [
                  box({ class: 'mx-auto grid w-full max-w-4xl gap-10 p-6', children: [
                      box({ as: 'section', class: 'grid gap-6', attributes: [h.AriaLabelledBy('appearance-title')], children: [
                          box({ as: 'h2', class: 'text-[16px] font-bold', attributes: [h.Id('appearance-title')], children: ['Appearance'] }, h),
                          region(h, { id: 'appearance', deps: [model.me.isDark, model.me.theme, preferencesOf(model.me).sidebar], render: () => appearanceView(model, h) }),
                        ] }, h),
                      box({ as: 'section', class: 'grid gap-6', attributes: [h.AriaLabelledBy('messages-title')], children: [
                          box({ as: 'h2', class: 'text-[16px] font-bold', attributes: [h.Id('messages-title')], children: ['Messages & media'] }, h),
                          region(h, { id: 'messages-media', deps: [preferencesOf(model.me).isCompact, preferencesOf(model.me).is24Hour, model.me.timeZone, Math.floor(model.now / 60_000)], render: () => messagesView(model, h) }),
                        ] }, h),
                      ...(model.notice === null ? [] : [text({ children: [model.notice], type: 'supporting', color: 'secondary' }, h)]),
                    ] }, h),
                ] }, h),
            ] }, h),
        ] }, h),
    ] }, h),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'preferences',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const now = yield* Clock.currentTimeMillis
      return { me, members: state.members, nav: navOf(state, me), now }
    }),
  init,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  update,
  view,
  subscriptions,
  clientCommands: switcherClientCommands,
  snapshotDeps: () => [],
}
