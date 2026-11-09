import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Member, initials } from '../domain'
import { cn } from '@/lib/utils'
import { box, slack } from '@/app/view/design'

/* Our own glyphs: square Slack-style avatars with initials (members have no
   photos) and the workspace icon of the rail. */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZE: Readonly<Record<AvatarSize, string>> = {
  xs: 'size-4 rounded text-[8px]',
  sm: 'size-5 rounded-[5px] text-[9px]',
  md: 'size-9 rounded-lg text-[13px]',
  lg: 'size-12 rounded-lg text-base',
  xl: 'size-60 rounded-xl text-6xl',
}

export const avatar = <Msg>(member: Member | undefined, h: HtmlBuilder<Msg>, size: AvatarSize = 'sm', className = ''): Html =>
  box(
    {
      as: 'span',
      class: cn('inline-flex shrink-0 select-none items-center justify-center font-semibold text-white', member?.color ?? 'bg-muted-foreground', SIZE[size], className),
      attributes: [h.DataAttribute('slot', 'avatar'), h.Role('img'), h.AriaLabel(member?.name ?? 'Someone')],
      children: [member === undefined ? '?' : initials(member.name)],
    },
    h,
  )

/** The workspace's icon in the rail: its initial on a rounded square. */
export const workspaceIcon = <Msg>(name: string, h: HtmlBuilder<Msg>): Html =>
  box({ as: 'span', class: slack.workspaceIcon, attributes: [h.Role('img'), h.AriaLabel(name)], children: [name.charAt(0).toUpperCase()] }, h)
