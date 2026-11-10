import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Member, handleOf } from '../domain'
import { statusOf } from '../profile'
import { box, slack } from './design'

/* Message text as Slack shows it: line breaks kept, links that open in a
   new tab, @mentions of people (and @here/@channel) highlighted. */

const TOKEN = /(https?:\/\/[^\s<>"]+|@[A-Za-z][\w.-]*)/

export const messageText = <Msg>(text: string, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): ReadonlyArray<Html | string> =>
  text.split('\n').flatMap((line, index) => [
    ...(index === 0 ? [] : [box({ as: 'br' }, h)]),
    ...line.split(TOKEN).map((part, partIndex) => {
      if (partIndex % 2 === 0) return part
      if (!part.startsWith('@')) return box({ as: 'a', attributes: [h.Href(part), h.Target('_blank'), h.Rel('noopener noreferrer')], children: [part] }, h)
      const name = part.slice(1).toLowerCase()
      const member = members.find(candidate => handleOf(candidate) === name)
      if (member !== undefined) return box({ as: 'span', class: slack.mention, attributes: [h.DataAttribute('mention', member.id)], children: [`@${member.name}`] }, h)
      return name === 'here' || name === 'channel' || name === 'everyone' ? box({ as: 'span', class: slack.mention, children: [part] }, h) : part
    }),
  ])

/** The author line's name: a link to their profile, then their status emoji. */
export const authorName = <Msg>(author: Member | undefined, now: number, h: HtmlBuilder<Msg>, size = 'text-[15px]'): Html => {
  if (author === undefined) return box({ as: 'strong', class: `${size} font-bold`, children: ['Former member'] }, h)
  const status = statusOf(author, now)
  return box({ as: 'span', class: 'inline-flex min-w-0 items-baseline gap-1', children: [
      box({ as: 'a', class: `${size} font-bold hover:underline`, attributes: [h.Href(`/people/${author.id}`), h.DataAttribute('author', author.id)], children: [author.name] }, h),
      ...(status === undefined ? [] : [box({ as: 'span', class: 'text-[13px] leading-none', attributes: [h.Title(status.text), h.AriaLabel(`Status: ${status.text}`), h.DataAttribute('status-emoji', '')], children: [status.emoji] }, h)]),
    ] }, h)
}
