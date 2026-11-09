import { Schema as S } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Icon from '@/lib/icon'
import { badge } from '@/ui/badge'
import { button, buttonLink } from '@/ui/button'

import { type Channel, ChannelKind, type Member, canRead, compareChannels, conversationName, dmPartners, isMemberOf, mentions, readAt } from '../domain'
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
})
export type NavRow = typeof NavRow.Type

export const Nav = S.Struct({ channels: S.Array(NavRow), dms: S.Array(NavRow) })
export type Nav = typeof Nav.Type

const navRow = (state: WorkspaceState, channel: Channel, me: Member): NavRow => {
  const seen = readAt(state.reads, me.id, channel.id)
  const unread = state.messages.filter(message => message.channelId === channel.id && message.authorId !== me.id && message.createdAt > seen)
  return {
    id: channel.id,
    label: conversationName(channel, state.members, me.id),
    kind: channel.kind,
    isUnread: unread.length > 0,
    // Every unread direct message counts, like a mention.
    mentions: channel.kind === 'dm' ? unread.length : unread.filter(message => mentions(message.text, me)).length,
    partnerIds: channel.kind === 'dm' ? dmPartners(channel, me.id) : [],
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
  }
}

const sameRow = (a: NavRow, b: NavRow) =>
  a.id === b.id && a.label === b.label && a.kind === b.kind && a.isUnread === b.isUnread && a.mentions === b.mentions && a.partnerIds.join() === b.partnerIds.join()
const sameRows = (a: ReadonlyArray<NavRow>, b: ReadonlyArray<NavRow>) => a.length === b.length && a.every((row, index) => sameRow(row, b[index] as NavRow))
export const sameNav = (a: Nav, b: Nav): boolean => sameRows(a.channels, b.channels) && sameRows(a.dms, b.dms)

export const hasUnread = (nav: Nav): boolean => [...nav.channels, ...nav.dms].some(row => row.isUnread)

// RAIL

export type RailItem = 'home' | 'dms' | 'activity' | 'later'

type RailProps<Msg> = Readonly<{
  me: Member
  active: RailItem
  onToggleTheme: Msg
  hasUnread: boolean
}>

const railLink = <Msg>(item: Readonly<{ href: string; label: string; icon: Html; isActive: boolean; dot?: boolean }>, h: HtmlBuilder<Msg>): Html =>
  buttonLink(
    {
      href: item.href,
      variant: item.isActive ? 'rail-active' : 'rail',
      size: 'rail',
      ariaLabel: item.label,
      children: [box({ as: 'span', class: 'rail-icon', attributes: [h.DataAttribute('slot', 'rail-icon')], children: [item.icon, ...(item.dot === true ? [box({ as: 'span', class: slack.railDot }, h)] : [])] }, h), item.label],
    },
    h,
  )

export const rail = <Msg>(props: RailProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'nav', class: slack.rail, attributes: [h.Id('rail'), h.AriaLabel('Workspace')], children: [
      box({ as: 'a', class: 'mb-3', attributes: [h.Href('/'), h.Title(WORKSPACE_NAME)], children: [workspaceIcon(WORKSPACE_NAME, h)] }, h),
      railLink({ href: '/', label: 'Home', icon: Icon.house({}, h), isActive: props.active === 'home', dot: props.active !== 'home' && props.hasUnread }, h),
      railLink({ href: '/dms', label: 'DMs', icon: Icon.icon('messages-square', {}, h), isActive: props.active === 'dms' }, h),
      railLink({ href: '/activity', label: 'Activity', icon: Icon.icon('bell', {}, h), isActive: props.active === 'activity' }, h),
      railLink({ href: '/later', label: 'Later', icon: Icon.bookmark({}, h), isActive: props.active === 'later' }, h),
      box({ class: 'flex-1' }, h),
      button({ variant: 'sidebar-icon', size: 'icon', ariaLabel: props.me.isDark ? 'Light mode' : 'Dark mode', title: props.me.isDark ? 'Light mode' : 'Dark mode', onClick: props.onToggleTheme, children: [Icon.icon(props.me.isDark ? 'sun' : 'moon', {}, h)] }, h),
      box({ as: 'form', attributes: [h.Method('post'), h.Action('/logout')], children: [
          button({ variant: 'sidebar-icon', size: 'icon', type: 'submit', ariaLabel: 'Sign out', title: 'Sign out', children: [Icon.icon('log-out', {}, h)] }, h),
        ] }, h),
      box({ as: 'span', class: 'relative mt-1', attributes: [h.Title(props.me.name)], children: [avatar(props.me, h, 'md'), box({ as: 'span', class: slack.presenceDot, attributes: [h.AriaLabel('Active')] }, h)] }, h),
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
  return avatar(members.find(member => member.id === row.partnerIds[0]), h, 'sm')
}

const sidebarRow = <Msg>(row: NavRow, props: SidebarProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  buttonLink(
    {
      href: `/client/${row.id}`,
      variant: row.id === props.activeId ? 'sidebar-active' : row.isUnread ? 'sidebar-unread' : 'sidebar',
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

export const sidebar = <Msg>(props: SidebarProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'aside', class: slack.sidebar, attributes: [h.Id('sidebar'), h.AriaLabel('Conversations')], children: [
      box({ as: 'header', class: 'flex h-12 shrink-0 items-center gap-1 px-3', children: [
          box({ as: 'h2', class: 'flex min-w-0 flex-1 items-center gap-1 truncate text-[18px] font-bold text-sidebar-accent-foreground', children: [WORKSPACE_NAME, Icon.chevronDown({ class: 'size-4' }, h)] }, h),
        ] }, h),
      box({ class: 'min-h-0 flex-1 overflow-y-auto px-2 pb-4', attributes: [h.DataAttribute('keep-scroll', 'sidebar')], children: [
          section('channels', 'Channels', props.nav.channels.map(row => sidebarRow(row, props, h)), props, h),
          section('dms', 'Direct messages', props.nav.dms.map(row => sidebarRow(row, props, h)), props, h),
        ] }, h),
    ] }, h)
