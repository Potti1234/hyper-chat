import { Schema as S } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Icon from '@/lib/icon'
import { badge } from '@/ui/badge'
import { button, buttonLink } from '@/ui/button'
import { input } from '@/ui/input'

import { activityOf, unseenCount } from '../activity'
import { ACTIVITY_READ, type Channel, ChannelKind, type Member, canRead, compareChannels, conversationName, dmPartners, inChannel, isMemberOf, isMuted, isStarred, mentions, readAt } from '../domain'
import { isPaused } from '../profile'
import type { WorkspaceState } from '../store'
import { box, slack } from './design'
import { avatar, workspaceIcon } from './icons'

/* Slack's frame around every page: the workspace rail (Home, DMs, Activity,
   Later, you) and the sidebar with the conversations you are in. */

export const WORKSPACE_NAME = 'Northwind'

// SIDEBAR DATA

export const NavRow = S.Struct({
  id: S.String,
  label: S.String,
  kind: ChannelKind,
  isUnread: S.Boolean,
  mentions: S.Number,
  partnerIds: S.Array(S.String),
  /** A one-to-one DM whose partner has a page open. */
  isOnline: S.Boolean,
  /** Muted by you: greyed and never bold, though mentions still count. */
  isMuted: S.Boolean,
  /** Starred by you: shown in the Starred section instead of its own. */
  isStarred: S.Boolean,
})
export type NavRow = typeof NavRow.Type

/** Your conversations, and how many Activity items you have not seen. */
export const Nav = S.Struct({ channels: S.Array(NavRow), dms: S.Array(NavRow), activity: S.Number })
export type Nav = typeof Nav.Type

export const emptyNav: Nav = { channels: [], dms: [], activity: 0 }

const navRow = (state: WorkspaceState, channel: Channel, me: Member): NavRow => {
  const seen = readAt(state.reads, me.id, channel.id)
  const partnerIds = channel.kind === 'dm' ? dmPartners(channel, me.id) : []
  const unread = state.messages.filter(message => message.channelId === channel.id && inChannel(message) && message.authorId !== me.id && message.createdAt > seen)
  return {
    id: channel.id,
    label: conversationName(channel, state.members, me.id),
    kind: channel.kind,
    isUnread: unread.length > 0,
    // Every unread direct message counts, like a mention.
    mentions: channel.kind === 'dm' ? unread.length : unread.filter(message => mentions(message.text, me)).length,
    partnerIds,
    isOnline: partnerIds.length === 1 && state.online.includes(partnerIds[0] ?? ''),
    isMuted: isMuted(me, channel.id),
    isStarred: isStarred(me, channel.id),
  }
}

/** The conversations in a member's sidebar: channels they joined, then direct messages. */
export const navOf = (state: WorkspaceState, me: Member): Nav => {
  const mine = state.channels.filter(channel => !channel.isArchived && isMemberOf(channel, me.id) && canRead(channel, me.id))
  return {
    channels: mine.filter(channel => channel.kind !== 'dm').sort(compareChannels).map(channel => navRow(state, channel, me)),
    dms: mine
      .filter(channel => channel.kind === 'dm')
      .map(channel => navRow(state, channel, me))
      .sort((a, b) => a.label.localeCompare(b.label)),
    activity: unseenCount(activityOf(state, me), readAt(state.reads, me.id, ACTIVITY_READ)),
  }
}

const sameRow = (a: NavRow, b: NavRow) =>
  a.id === b.id && a.label === b.label && a.kind === b.kind && a.isUnread === b.isUnread && a.mentions === b.mentions && a.partnerIds.join() === b.partnerIds.join() && a.isOnline === b.isOnline && a.isMuted === b.isMuted && a.isStarred === b.isStarred
const sameRows = (a: ReadonlyArray<NavRow>, b: ReadonlyArray<NavRow>) => a.length === b.length && a.every((row, index) => sameRow(row, b[index] as NavRow))
export const sameNav = (a: Nav, b: Nav): boolean => a.activity === b.activity && sameRows(a.channels, b.channels) && sameRows(a.dms, b.dms)

export const hasUnread = (nav: Nav): boolean => [...nav.channels, ...nav.dms].some(row => row.isUnread && !row.isMuted)

// RAIL

export type RailItem = 'home' | 'dms' | 'activity' | 'later' | 'search' | 'people' | 'preferences'

type RailProps<Msg> = Readonly<{
  me: Member
  now: number
  active: RailItem
  onToggleTheme: Msg
  nav: Nav
}>

const railLink = <Msg>(item: Readonly<{ href: string; label: string; icon: Html; isActive: boolean; dot?: boolean; count?: number }>, h: HtmlBuilder<Msg>): Html =>
  buttonLink(
    {
      href: item.href,
      variant: item.isActive ? 'rail-active' : 'rail',
      size: 'rail',
      ariaLabel: item.label,
      children: [box({ as: 'span', class: 'rail-icon', attributes: [h.DataAttribute('slot', 'rail-icon')], children: [item.icon, ...(item.dot === true ? [box({ as: 'span', class: slack.railDot }, h)] : []), ...(item.count !== undefined && item.count > 0 ? [badge({ variant: 'rail-count', children: [item.count > 99 ? '99+' : String(item.count)] }, h)] : [])] }, h), item.label],
    },
    h,
  )

export const rail = <Msg>(props: RailProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'nav', class: slack.rail, attributes: [h.Id('rail'), h.AriaLabel('Workspace')], children: [
      box({ as: 'a', class: 'mb-3', attributes: [h.Href('/'), h.Title(WORKSPACE_NAME)], children: [workspaceIcon(WORKSPACE_NAME, h)] }, h),
      railLink({ href: '/', label: 'Home', icon: Icon.house({}, h), isActive: props.active === 'home', dot: props.active !== 'home' && hasUnread(props.nav) }, h),
      railLink({ href: '/dms', label: 'DMs', icon: Icon.icon('messages-square', {}, h), isActive: props.active === 'dms' }, h),
      railLink({ href: '/activity', label: 'Activity', icon: Icon.icon('bell', {}, h), isActive: props.active === 'activity', count: props.active === 'activity' ? 0 : props.nav.activity }, h),
      railLink({ href: '/later', label: 'Later', icon: Icon.bookmark({}, h), isActive: props.active === 'later' }, h),
      railLink({ href: '/people', label: 'People', icon: Icon.users({}, h), isActive: props.active === 'people' }, h),
      box({ class: 'flex-1' }, h),
      buttonLink({ id: 'open-preferences', href: '/preferences', variant: 'sidebar-icon', size: 'icon', ariaLabel: 'Preferences', children: [Icon.icon('settings', {}, h)] }, h),
      button({ variant: 'sidebar-icon', size: 'icon', ariaLabel: props.me.isDark ? 'Light mode' : 'Dark mode', title: props.me.isDark ? 'Light mode' : 'Dark mode', onClick: props.onToggleTheme, children: [Icon.icon(props.me.isDark ? 'sun' : 'moon', {}, h)] }, h),
      box({ as: 'form', attributes: [h.Method('post'), h.Action('/logout')], children: [
          button({ variant: 'sidebar-icon', size: 'icon', type: 'submit', ariaLabel: 'Sign out', title: 'Sign out', children: [Icon.icon('log-out', {}, h)] }, h),
        ] }, h),
      box({ as: 'a', class: 'relative mt-1', attributes: [h.Id('my-profile'), h.Href(`/people/${props.me.id}`), h.Title(`${props.me.name}: your profile and status`)], children: [
          avatar(props.me, h, 'md'),
          isPaused(props.me, props.now)
            ? box({ as: 'span', class: slack.pausedBadge, attributes: [h.AriaLabel('Notifications paused'), h.DataAttribute('paused', '')], children: [Icon.icon('moon', {}, h)] }, h)
            : box({ as: 'span', class: slack.presenceDot, attributes: [h.AriaLabel('Active')] }, h),
        ] }, h),
    ] }, h)

// TOP BAR

type TopBarProps<Msg> = Readonly<{
  /** On the search page the field itself; elsewhere a link to it. */
  search?: Readonly<{ value: string; onInput: (text: string) => Msg }>
}>

export const topBar = <Msg>(props: TopBarProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'header', class: slack.topBar, attributes: [h.Id('top-bar')], children: [
      box({ attributes: [h.DataAttribute('slot', 'top-search'), h.Role('search')], children: props.search === undefined
          ? [buttonLink({ id: 'open-search', href: '/search', variant: 'top-search', size: 'compact', leadingIcon: Icon.icon('search', {}, h), children: [`Search ${WORKSPACE_NAME}`] }, h)]
          : [
              Icon.icon('search', { class: 'pointer-events-none absolute top-1.5 left-2.5 z-10 size-4 opacity-70' }, h),
              input({ id: 'search-input', type: 'search', value: props.search.value, placeholder: `Search ${WORKSPACE_NAME}`, ariaLabel: 'Search', autocomplete: 'off', onInput: props.search.onInput, variant: 'top-search' }, h),
            ] }, h),
    ] }, h)

// SIDEBAR

type SidebarProps<Msg> = Readonly<{
  nav: Nav
  members: ReadonlyArray<Member>
  activeId: string
  collapsed: ReadonlyArray<string>
  onToggleSection: (section: string) => Msg
}>

const rowIcon = <Msg>(row: NavRow, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): Html => {
  if (row.kind === 'public') return Icon.icon('hash', {}, h)
  if (row.kind === 'private') return Icon.icon('lock', {}, h)
  if (row.partnerIds.length > 1) return box({ as: 'span', class: slack.dmCount, children: [String(row.partnerIds.length)] }, h)
  return box({ as: 'span', class: 'relative inline-flex', children: [
      avatar(members.find(member => member.id === row.partnerIds[0]), h, 'sm'),
      box({ as: 'span', class: row.isOnline ? slack.presenceOn : slack.presenceOff, attributes: [h.AriaLabel(row.isOnline ? 'Active' : 'Away'), h.DataAttribute('presence', row.isOnline ? 'active' : 'away')] }, h),
    ] }, h)
}

const sidebarRow = <Msg>(row: NavRow, props: SidebarProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  buttonLink(
    {
      href: `/client/${row.id}`,
      variant: row.id === props.activeId ? 'sidebar-active' : row.isMuted ? 'sidebar-muted' : row.isUnread ? 'sidebar-unread' : 'sidebar',
      ...(row.isMuted ? { marker: ['muted', ''] as const } : {}),
      size: 'row',
      leadingIcon: rowIcon(row, props.members, h),
      children: [
        box({ as: 'span', class: 'min-w-0 flex-1 truncate text-left', children: [row.label] }, h),
        ...(row.mentions > 0 && row.id !== props.activeId ? [badge({ variant: 'count', children: [String(row.mentions)] }, h)] : []),
      ],
    },
    h,
  )

const section = <Msg>(
  id: string,
  title: string,
  rows: ReadonlyArray<Html>,
  props: SidebarProps<Msg>,
  h: HtmlBuilder<Msg>,
): Html => {
  const isCollapsed = props.collapsed.includes(id)
  return box({ as: 'section', class: 'mt-4', children: [
      button({
        variant: 'sidebar',
        size: 'row',
        ariaLabel: `${isCollapsed ? 'Expand' : 'Collapse'} ${title}`,
        onClick: props.onToggleSection(id),
        leadingIcon: Icon.icon(isCollapsed ? 'chevron-right' : 'chevron-down', {}, h),
        children: [box({ as: 'span', class: 'flex-1 text-left font-medium', children: [title] }, h)],
      }, h),
      ...(isCollapsed ? [] : rows),
    ] }, h)
}

/** Starred channels, then starred DMs, each in its section's order. */
const starredOf = (nav: Nav): ReadonlyArray<NavRow> => [...nav.channels, ...nav.dms].filter(row => row.isStarred)

/** The conversations in the order the sidebar lists them. */
export const sidebarOrder = (nav: Nav): ReadonlyArray<NavRow> => [...starredOf(nav), ...nav.channels.filter(row => !row.isStarred), ...nav.dms.filter(row => !row.isStarred)]

/** Alt+↑/↓ (Alt+Shift for unread ones only): the conversation `by` rows from
 *  `fromId` in sidebar order, wrapping; from outside a conversation, the
 *  first or last. */
export const steppedTo = (nav: Nav, fromId: string | undefined, by: 1 | -1, isUnreadOnly: boolean): NavRow | undefined => {
  const rows = sidebarOrder(nav)
  const from = rows.findIndex(row => row.id === fromId)
  const start = from === -1 ? (by === 1 ? -1 : rows.length) : from
  for (let step = 1; step <= rows.length; step += 1) {
    const row = rows[(((start + by * step) % rows.length) + rows.length) % rows.length]
    if (row !== undefined && row.id !== fromId && (!isUnreadOnly || (row.isUnread && !row.isMuted) || row.mentions > 0)) return row
  }
  return undefined
}

export const sidebar = <Msg>(props: SidebarProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'aside', class: slack.sidebar, attributes: [h.Id('sidebar'), h.AriaLabel('Conversations')], children: [
      box({ as: 'header', class: 'flex h-12 shrink-0 items-center gap-1 px-3', children: [
          box({ as: 'h2', class: 'flex min-w-0 flex-1 items-center gap-1 truncate text-[18px] font-bold text-sidebar-accent-foreground', children: [WORKSPACE_NAME, Icon.chevronDown({ class: 'size-4' }, h)] }, h),
          buttonLink({ href: '/dms', variant: 'sidebar-icon', size: 'icon-sm', ariaLabel: 'New message', children: [Icon.icon('square-pen', {}, h)] }, h),
        ] }, h),
      box({ class: 'min-h-0 flex-1 overflow-y-auto px-2 pb-4', attributes: [h.DataAttribute('keep-scroll', 'sidebar')], children: [
          box({ as: 'nav', class: 'mt-2 flex flex-col', attributes: [h.AriaLabel('Views')], children: [
              buttonLink({ href: '/threads', variant: props.activeId === 'threads' ? 'sidebar-active' : 'sidebar', size: 'row', leadingIcon: Icon.icon('message-square-text', {}, h), children: [box({ as: 'span', class: 'min-w-0 flex-1 truncate text-left', children: ['Threads'] }, h)] }, h),
            ] }, h),
          ...(starredOf(props.nav).length === 0 ? [] : [section('starred', 'Starred', starredOf(props.nav).map(row => sidebarRow(row, props, h)), props, h)]),
          section('channels', 'Channels', [
              ...props.nav.channels.filter(row => !row.isStarred).map(row => sidebarRow(row, props, h)),
              buttonLink({ href: '/channels', variant: props.activeId === 'channels' ? 'sidebar-active' : 'sidebar', size: 'row', leadingIcon: Icon.icon('plus', {}, h), children: [box({ as: 'span', class: 'min-w-0 flex-1 truncate text-left', children: ['Add channels'] }, h)] }, h),
            ], props, h),
          section('dms', 'Direct messages', props.nav.dms.filter(row => !row.isStarred).map(row => sidebarRow(row, props, h)), props, h),
        ] }, h),
    ] }, h)
