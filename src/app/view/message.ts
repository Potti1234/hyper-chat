import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Member, handleOf } from '../domain'
import { type Block, type Inline, parse } from '../mrkdwn'
import { statusOf } from '../profile'
import { box, slack } from './design'

/* Message text as Slack shows it: mrkdwn (src/app/mrkdwn.ts) with bold,
   italic, strike, code, code blocks, quotes and lists, links that open in a
   new tab, :emoji: names and @mentions of people (and @here/@channel)
   highlighted. */

const inline = <Msg>(nodes: ReadonlyArray<Inline>, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): ReadonlyArray<Html | string> =>
  nodes.map(node => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'break':
        return box({ as: 'br' }, h)
      case 'code':
        return box({ as: 'code', class: slack.mdCode, children: [node.text] }, h)
      case 'bold':
        return box({ as: 'strong', class: 'font-bold', children: inline(node.children, members, h) }, h)
      case 'italic':
        return box({ as: 'em', children: inline(node.children, members, h) }, h)
      case 'strike':
        return box({ as: 's', children: inline(node.children, members, h) }, h)
      case 'link':
        return box({ as: 'a', attributes: [h.Href(node.url), h.Target('_blank'), h.Rel('noopener noreferrer')], children: inline(node.children, members, h) }, h)
      case 'emoji':
        return box({ as: 'span', attributes: [h.Title(`:${node.name}:`), h.DataAttribute('emoji-name', node.name)], children: [node.glyph] }, h)
      case 'mention': {
        const member = members.find(candidate => handleOf(candidate) === node.handle)
        if (member !== undefined) return box({ as: 'span', class: slack.mention, attributes: [h.DataAttribute('mention', member.id)], children: [`@${member.name}`] }, h)
        return node.handle === 'here' || node.handle === 'channel' || node.handle === 'everyone' ? box({ as: 'span', class: slack.mention, children: [`@${node.handle}`] }, h) : `@${node.handle}`
      }
    }
  })

const block = <Msg>(node: Block, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): Html => {
  switch (node.kind) {
    case 'paragraph':
      return box({ as: 'p', class: slack.mdParagraph, children: inline(node.children, members, h) }, h)
    case 'quote':
      return box({ as: 'blockquote', class: slack.mdQuote, children: inline(node.children, members, h) }, h)
    case 'code':
      return box({ as: 'pre', class: slack.mdCodeBlock, children: [node.text] }, h)
    case 'bullets':
    case 'numbers':
      return box({
        as: node.kind === 'bullets' ? 'ul' : 'ol',
        class: node.kind === 'bullets' ? slack.mdBullets : slack.mdNumbers,
        attributes: node.kind === 'numbers' && node.start !== 1 ? [h.Attribute('start', String(node.start))] : [],
        children: node.items.map(item => box({ as: 'li', children: inline(item, members, h) }, h)),
      }, h)
  }
}

export const messageText = <Msg>(text: string, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): ReadonlyArray<Html | string> => parse(text).map(node => block(node, members, h))

/** The author line's name: a link to their profile, then their status emoji. */
export const authorName = <Msg>(author: Member | undefined, now: number, h: HtmlBuilder<Msg>, size = 'text-[15px]'): Html => {
  if (author === undefined) return box({ as: 'strong', class: `${size} font-bold`, children: ['Former member'] }, h)
  const status = statusOf(author, now)
  return box({ as: 'span', class: 'inline-flex min-w-0 items-baseline gap-1', children: [
      box({ as: 'a', class: `${size} font-bold hover:underline`, attributes: [h.Href(`/people/${author.id}`), h.DataAttribute('author', author.id)], children: [author.name] }, h),
      ...(status === undefined ? [] : [box({ as: 'span', class: 'text-[13px] leading-none', attributes: [h.Title(status.text), h.AriaLabel(`Status: ${status.text}`), h.DataAttribute('status-emoji', '')], children: [status.emoji] }, h)]),
    ] }, h)
}
