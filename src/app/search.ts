import { Schema as S } from 'effect'

import { type Channel, ChannelKind, type Member, Message, canRead, conversationName, handleOf, isMemberOf } from './domain'
import type { WorkspaceState } from './store'

/* Slack's search: words to find, narrowed with `in:#channel` and
   `from:@person`. Messages come from conversations you can read (public
   channels too), newest first; channels and people match by name. */

export type Query = Readonly<{ terms: ReadonlyArray<string>; in: string | null; from: string | null }>

const strip = (value: string, prefix: string) => (value.startsWith(prefix) ? value.slice(prefix.length) : value)

export const parseQuery = (text: string): Query => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  const pick = (key: string) => [...words].reverse().find(word => word.startsWith(`${key}:`) && word.length > key.length + 1)
  const inWord = pick('in')
  const fromWord = pick('from')
  return {
    terms: words.filter(word => !/^(in|from):/.test(word)),
    in: inWord === undefined ? null : strip(strip(inWord.slice(3), '#'), '@'),
    from: fromWord === undefined ? null : strip(fromWord.slice(5), '@'),
  }
}

/** The query text with one filter set (or removed with null). */
export const withFilter = (text: string, key: 'in' | 'from', value: string | null): string =>
  [...text.trim().split(/\s+/).filter(word => word !== '' && !word.toLowerCase().startsWith(`${key}:`)), ...(value === null ? [] : [`${key}:${key === 'in' ? '#' : '@'}${value}`])].join(' ')

export const MessageHit = S.Struct({
  message: Message,
  channelId: S.String,
  conversation: S.String,
  channelKind: ChannelKind,
})
export type MessageHit = typeof MessageHit.Type

export const ChannelHit = S.Struct({
  id: S.String,
  name: S.String,
  kind: ChannelKind,
  topic: S.String,
  memberCount: S.Number,
  isMember: S.Boolean,
})
export type ChannelHit = typeof ChannelHit.Type

export type Results = Readonly<{ messages: ReadonlyArray<MessageHit>; channels: ReadonlyArray<ChannelHit>; people: ReadonlyArray<Member> }>

export const emptyResults: Results = { messages: [], channels: [], people: [] }

/** The most messages a search shows. */
export const MAX_HITS = 50

const hasAll = (text: string, terms: ReadonlyArray<string>) => {
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
}

const matchesConversation = (channel: Channel, name: string, wanted: string) =>
  channel.id.toLowerCase() === wanted || name.toLowerCase() === wanted || name.toLowerCase().replace(/[\s,]+/g, '-') === wanted

const matchesPerson = (member: Member, wanted: string) =>
  handleOf(member) === wanted || member.id.toLowerCase() === wanted || member.name.toLowerCase().replace(/\s+/g, '') === wanted.replace(/[-_.]/g, '')

export const searchOf = (state: WorkspaceState, me: Member, text: string): Results => {
  const query = parseQuery(text)
  if (query.terms.length === 0 && query.in === null && query.from === null) return emptyResults
  const readable = state.channels.filter(channel => canRead(channel, me.id) && (channel.kind !== 'dm' || isMemberOf(channel, me.id)))
  const names = new Map(readable.map(channel => [channel.id, conversationName(channel, state.members, me.id)]))
  const scope = query.in === null ? readable : readable.filter(channel => matchesConversation(channel, names.get(channel.id) ?? '', query.in ?? ''))
  const byId = new Map(scope.map(channel => [channel.id, channel]))
  const authors = query.from === null ? null : new Set(state.members.filter(member => matchesPerson(member, query.from ?? '')).map(member => member.id))
  const messages: Array<MessageHit> = []
  for (let index = state.messages.length - 1; index >= 0 && messages.length < MAX_HITS; index--) {
    const message = state.messages[index] as Message
    const channel = byId.get(message.channelId)
    if (channel === undefined || (authors !== null && !authors.has(message.authorId)) || !hasAll(message.text, query.terms)) continue
    messages.push({ message, channelId: channel.id, conversation: names.get(channel.id) ?? channel.name, channelKind: channel.kind })
  }
  messages.sort((a, b) => b.message.createdAt - a.message.createdAt)
  const named = query.in === null && query.from === null && query.terms.length > 0
  return {
    messages,
    channels: named
      ? readable
          .filter(channel => channel.kind !== 'dm' && !channel.isArchived && hasAll(`${channel.name} ${channel.topic}`, query.terms))
          .map(channel => ({ id: channel.id, name: channel.name, kind: channel.kind, topic: channel.topic, memberCount: channel.memberIds.length, isMember: isMemberOf(channel, me.id) }))
      : [],
    people: named ? state.members.filter(member => hasAll(`${member.name} ${member.title} ${handleOf(member)}`, query.terms)) : [],
  }
}
