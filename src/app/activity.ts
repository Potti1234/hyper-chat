import { Schema as S } from 'effect'

import { type Channel, ChannelKind, type Member, type Message, type Saved, Message as ChatMessage, canRead, isMemberOf, mentions, notifyLevel } from './domain'

/* Slack's Activity: what happened to you, newest first. Mentions of you
   (or @here / @channel) in channels you are in, replies in threads you
   started or replied in, and reactions to your messages. Direct messages
   have their own tab, so they are left out, like in Slack. Reminders you
   set ("Remind me about this") show once they went off, DMs included,
   until the saved item is completed or removed. */

/** Items listed. */
export const LISTED = 100

export const ActivityKind = S.Literals(['mention', 'reply', 'reaction', 'reminder'])
export type ActivityKind = typeof ActivityKind.Type

export const ActivityItem = S.Struct({
  /** `kind:message` (`reaction:message:emoji` for reactions). */
  id: S.String,
  kind: ActivityKind,
  channelId: S.String,
  channelName: S.String,
  channelKind: ChannelKind,
  message: ChatMessage,
  /** Who did it: the author, or who reacted (newest last). */
  actorIds: S.Array(S.String),
  /** The reaction's emoji ('' otherwise). */
  emoji: S.String,
  at: S.Number,
})
export type ActivityItem = typeof ActivityItem.Type

type Data = Readonly<{ channels: ReadonlyArray<Channel>; messages: ReadonlyArray<Message>; saves?: ReadonlyArray<Saved> }>

/** Where an item opens: its thread for replies, otherwise the conversation. */
export const hrefOf = (item: ActivityItem): string =>
  item.message.threadId === null ? `/client/${item.channelId}` : `/client/${item.channelId}/thread/${item.message.threadId}`

export const activityOf = (data: Data, me: Member): ReadonlyArray<ActivityItem> => {
  const channels = new Map(data.channels.filter(channel => channel.kind !== 'dm' && !channel.isArchived && isMemberOf(channel, me.id) && canRead(channel, me.id)).map(channel => [channel.id, channel]))
  // Threads you are part of: you wrote the message that started them or replied.
  const mine = new Set<string>()
  for (const message of data.messages) {
    if (message.authorId !== me.id) continue
    mine.add(message.threadId ?? message.id)
  }
  const items: Array<ActivityItem> = []
  data.messages.forEach(message => {
    const channel = channels.get(message.channelId)
    if (channel === undefined) return
    const base = { channelId: channel.id, channelName: channel.name, channelKind: channel.kind, message }
    if (message.authorId !== me.id) {
      if (mentions(message.text, me) && notifyLevel(me, channel) !== 'nothing') items.push({ ...base, id: `mention:${message.id}`, kind: 'mention', actorIds: [message.authorId], emoji: '', at: message.createdAt })
      else if (message.threadId !== null && mine.has(message.threadId)) items.push({ ...base, id: `reply:${message.id}`, kind: 'reply', actorIds: [message.authorId], emoji: '', at: message.createdAt })
      return
    }
    for (const reaction of message.reactions) {
      const others = reaction.memberIds.filter(id => id !== me.id)
      if (others.length > 0) items.push({ ...base, id: `reaction:${message.id}:${reaction.emoji}`, kind: 'reaction', actorIds: others, emoji: reaction.emoji, at: reaction.at ?? message.createdAt })
    }
  })
  const reminded = (data.saves ?? []).filter(saved => saved.memberId === me.id && saved.reminded === true && saved.state === 'saved' && saved.remindAt !== undefined)
  if (reminded.length > 0) {
    const byId = new Map(data.messages.map(message => [message.id, message]))
    for (const saved of reminded) {
      const message = byId.get(saved.messageId)
      const channel = message === undefined ? undefined : data.channels.find(candidate => candidate.id === message.channelId)
      if (message === undefined || channel === undefined || !canRead(channel, me.id)) continue
      items.push({ id: `reminder:${message.id}`, kind: 'reminder', channelId: channel.id, channelName: channel.name, channelKind: channel.kind, message, actorIds: [], emoji: '', at: saved.remindAt ?? 0 })
    }
  }
  const order = new Map(data.messages.map((message, index) => [message.id, index]))
  return items.sort((a, b) => b.at - a.at || (order.get(b.message.id) ?? 0) - (order.get(a.message.id) ?? 0)).slice(0, LISTED)
}

/** How many items are newer than the Activity read marker. */
export const unseenCount = (items: ReadonlyArray<ActivityItem>, seenAt: number): number => items.filter(item => item.at > seenAt).length
