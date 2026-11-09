import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Member, handleOf } from '../domain'
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
