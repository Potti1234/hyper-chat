import { Data, Effect } from 'effect'

import { activityOf } from './activity'
import { ACTIVITY_READ, AVATAR_COLORS, type Channel, DEFAULT_CHANNEL, MAX_CHANNEL_NAME, MAX_DESCRIPTION, MAX_MESSAGE, MAX_TOPIC, type Member, type Message, type Read, type Saved, type SavedState, canRead, channelSlug, inChannel, isMemberOf } from './domain'
import { isEmoji } from './emoji'

/* The workspace's data and every change to it, as pure operations: an
   operation takes the data (and the time and an id source) and returns its
   result and the next data, or fails without changing anything. The
   in-memory store (tests) and the Postgres store (the app) run the same
   operations; Postgres then writes the rows that changed (`postgres.ts`),
   found by reference, so operations keep untouched objects as they are. */

export type WorkspaceData = Readonly<{
  members: ReadonlyArray<Member>
  channels: ReadonlyArray<Channel>
  messages: ReadonlyArray<Message>
  reads: ReadonlyArray<Read>
  saves: ReadonlyArray<Saved>
  /** Password hashes by member id. They never leave the store. */
  passwords: Readonly<Record<string, string>>
}>

export const emptyData: WorkspaceData = { members: [], channels: [], messages: [], reads: [], saves: [], passwords: {} }

export class InvalidChange extends Data.TaggedError('InvalidChange')<{ readonly reason: string }> {}

export type OpContext = Readonly<{ at: number; id: (prefix: string) => string }>
export type Op<A, E = never> = (data: WorkspaceData, context: OpContext) => Effect.Effect<readonly [A, WorkspaceData], E>

export const invalid = (reason: string) => Effect.fail(new InvalidChange({ reason }))

const unchanged = <A>(result: A, data: WorkspaceData) => Effect.succeed([result, data] as const)

const replace = <A extends { readonly id: string }>(items: ReadonlyArray<A>, next: A): ReadonlyArray<A> =>
  items.map(item => (item.id === next.id ? next : item))

// MEMBERS

export type NewAccountInput = Readonly<{ name: string; email: string; passwordHash: string }>

export const addMember =
  (input: NewAccountInput): Op<Member, InvalidChange> =>
  (data, { id }) => {
    if (data.members.some(member => member.email === input.email)) return invalid('Someone already signs in with that email.')
    const member: Member = {
      id: id('mem'),
      name: input.name,
      email: input.email,
      color: AVATAR_COLORS[data.members.length % AVATAR_COLORS.length] ?? 'bg-indigo-500',
      title: '',
      isDark: false,
      theme: '',
      isDemo: false,
    }
    // New accounts join #general, Slack's default channel.
    const general = data.channels.find(channel => channel.kind === 'public' && channel.name === DEFAULT_CHANNEL)
    return Effect.succeed([
      member,
      {
        ...data,
        members: [...data.members, member],
        passwords: { ...data.passwords, [member.id]: input.passwordHash },
        channels: general === undefined ? data.channels : replace(data.channels, { ...general, memberIds: [...general.memberIds, member.id] }),
      },
    ] as const)
  }

const updateMember = (data: WorkspaceData, memberId: string, patch: Partial<Member>): WorkspaceData => {
  const member = data.members.find(candidate => candidate.id === memberId)
  if (member === undefined) return data
  const next = { ...member, ...patch }
  return (Object.keys(patch) as ReadonlyArray<keyof Member>).every(key => member[key] === next[key]) ? data : { ...data, members: replace(data.members, next) }
}

export const setTheme =
  (memberId: string, isDark: boolean): Op<void> =>
  data =>
    unchanged(undefined, updateMember(data, memberId, { isDark }))

export const setPreset =
  (memberId: string, theme: string): Op<void> =>
  data =>
    unchanged(undefined, updateMember(data, memberId, { theme }))

// CONVERSATIONS

/** Slack's limit for a group direct message, you included. */
export const MAX_DM_PEOPLE = 9

/** The direct message between you and these people (only you: your notes),
 *  started if there is none yet. Each set of people has one. */
export const openConversation =
  (memberIds: ReadonlyArray<string>, actorId: string): Op<Channel, InvalidChange> =>
  (data, { at, id }) => {
    const people = [...new Set([actorId, ...memberIds])]
    if (!people.every(memberId => data.members.some(member => member.id === memberId))) return invalid('Pick people from your workspace.')
    if (people.length > MAX_DM_PEOPLE) return invalid(`A direct message has up to ${MAX_DM_PEOPLE} people, you included.`)
    const key = [...people].sort().join()
    const existing = data.channels.find(channel => channel.kind === 'dm' && !channel.isArchived && [...channel.memberIds].sort().join() === key)
    if (existing !== undefined) return unchanged(existing, data)
    const channel: Channel = { id: id('dm'), name: '', kind: 'dm', topic: '', description: '', memberIds: people, createdBy: actorId, createdAt: at, isArchived: false, isDemo: false }
    return Effect.succeed([channel, { ...data, channels: [...data.channels, channel] }] as const)
  }

// CHANNELS

const channelNameOf = (data: WorkspaceData, input: string, except: string | null): Effect.Effect<string, InvalidChange> => {
  const name = channelSlug(input)
  if (name === '') return invalid('Give the channel a name.')
  if (name.length > MAX_CHANNEL_NAME) return invalid(`Keep channel names under ${MAX_CHANNEL_NAME} characters.`)
  if (data.channels.some(channel => channel.kind !== 'dm' && channel.id !== except && channel.name === name)) return invalid(`#${name} already exists. Pick another name.`)
  return Effect.succeed(name)
}

const limited = (text: string, max: number, what: string): Effect.Effect<string, InvalidChange> => {
  const body = text.trim()
  return body.length > max ? invalid(`Keep the ${what} under ${max} characters.`) : Effect.succeed(body)
}

export type NewChannelInput = Readonly<{ name: string; isPrivate: boolean; description: string }>

/** A new channel with its creator as the only member. */
export const createChannel =
  (input: NewChannelInput, actorId: string): Op<Channel, InvalidChange> =>
  (data, { at, id }) =>
    Effect.gen(function* () {
      if (!data.members.some(member => member.id === actorId)) return yield* invalid('Sign in again to create channels.')
      const name = yield* channelNameOf(data, input.name, null)
      const description = yield* limited(input.description, MAX_DESCRIPTION, 'description')
      const channel: Channel = { id: id('ch'), name, kind: input.isPrivate ? 'private' : 'public', topic: '', description, memberIds: [actorId], createdBy: actorId, createdAt: at, isArchived: false, isDemo: false }
      return [channel, { ...data, channels: [...data.channels, channel] }] as const
    })

const findOpenChannel = (data: WorkspaceData, channelId: string, actorId: string): Effect.Effect<Channel, InvalidChange> =>
  Effect.flatMap(findChannel(data, channelId), channel =>
    channel.kind === 'dm' || !canRead(channel, actorId) ? invalid('That channel does not exist.') : channel.isArchived ? invalid('This channel is archived.') : Effect.succeed(channel),
  )

/** Anyone joins a public channel; private ones take an invitation. */
export const joinChannel =
  (channelId: string, actorId: string): Op<Channel, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const channel = yield* findOpenChannel(data, channelId, actorId)
      if (isMemberOf(channel, actorId)) return [channel, data] as const
      if (channel.kind !== 'public') return yield* invalid('Ask a member to add you to this private channel.')
      const next = { ...channel, memberIds: [...channel.memberIds, actorId] }
      return [next, { ...data, channels: replace(data.channels, next) }] as const
    })

export const leaveChannel =
  (channelId: string, actorId: string): Op<void, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const channel = yield* findOpenChannel(data, channelId, actorId)
      if (!isMemberOf(channel, actorId)) return [undefined, data] as const
      if (channel.name === DEFAULT_CHANNEL) return yield* invalid(`Everyone stays in #${DEFAULT_CHANNEL}.`)
      const next = { ...channel, memberIds: channel.memberIds.filter(id => id !== actorId) }
      return [undefined, { ...data, channels: replace(data.channels, next) }] as const
    })

/** Members add people to their channel; the people must be in the workspace. */
export const addToChannel =
  (channelId: string, memberIds: ReadonlyArray<string>, actorId: string): Op<Channel, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const channel = yield* findOpenChannel(data, channelId, actorId)
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to add people to it.`)
      if (!memberIds.every(memberId => data.members.some(member => member.id === memberId))) return yield* invalid('Pick people from your workspace.')
      const added = [...new Set(memberIds)].filter(memberId => !isMemberOf(channel, memberId))
      if (added.length === 0) return [channel, data] as const
      const next = { ...channel, memberIds: [...channel.memberIds, ...added] }
      return [next, { ...data, channels: replace(data.channels, next) }] as const
    })

export type ChannelDetails = Readonly<{ name?: string; topic?: string; description?: string }>

/** Members rename a channel and set its topic and description (#general keeps its name). */
export const updateChannel =
  (channelId: string, details: ChannelDetails, actorId: string): Op<Channel, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const channel = yield* findOpenChannel(data, channelId, actorId)
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to edit it.`)
      const name = details.name === undefined ? channel.name : yield* channelNameOf(data, details.name, channel.id)
      if (name !== channel.name && channel.name === DEFAULT_CHANNEL) return yield* invalid(`#${DEFAULT_CHANNEL} keeps its name.`)
      const topic = details.topic === undefined ? channel.topic : yield* limited(details.topic, MAX_TOPIC, 'topic')
      const description = details.description === undefined ? channel.description : yield* limited(details.description, MAX_DESCRIPTION, 'description')
      if (name === channel.name && topic === channel.topic && description === channel.description) return [channel, data] as const
      const next = { ...channel, name, topic, description }
      return [next, { ...data, channels: replace(data.channels, next) }] as const
    })

/** Members archive a channel: it leaves every sidebar and takes no messages, until unarchived. */
export const setArchived =
  (channelId: string, isArchived: boolean, actorId: string): Op<void, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const channel = yield* findChannel(data, channelId)
      if (channel.kind === 'dm' || !canRead(channel, actorId)) return yield* invalid('That channel does not exist.')
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to archive it.`)
      if (channel.name === DEFAULT_CHANNEL) return yield* invalid(`#${DEFAULT_CHANNEL} cannot be archived.`)
      if (channel.isArchived === isArchived) return [undefined, data] as const
      return [undefined, { ...data, channels: replace(data.channels, { ...channel, isArchived }) }] as const
    })

// MESSAGES

export const findChannel = (data: WorkspaceData, channelId: string): Effect.Effect<Channel, InvalidChange> => {
  const channel = data.channels.find(candidate => candidate.id === channelId)
  return channel === undefined ? invalid('That conversation does not exist.') : Effect.succeed(channel)
}

const withRead = (reads: ReadonlyArray<Read>, read: Read): ReadonlyArray<Read> => {
  const current = reads.find(candidate => candidate.memberId === read.memberId && candidate.channelId === read.channelId)
  if (current === undefined) return [...reads, read]
  if (current.at >= read.at) return reads
  return reads.map(candidate => (candidate === current ? read : candidate))
}

export const messageText = (text: string): Effect.Effect<string, InvalidChange> => {
  const body = text.trim()
  if (body === '') return invalid('Write something first.')
  if (body.length > MAX_MESSAGE) return invalid(`Keep messages under ${MAX_MESSAGE} characters.`)
  return Effect.succeed(body)
}

export type PostOptions = Readonly<{ threadId?: string | null; alsoInChannel?: boolean }>

/** Posts to a conversation, or as a reply in a thread of one of its messages. */
export const postMessage =
  (channelId: string, text: string, actorId: string, options: PostOptions = {}): Op<Message, InvalidChange> =>
  (data, { at, id }) =>
    Effect.gen(function* () {
      const channel = yield* findChannel(data, channelId)
      if (channel.isArchived) return yield* invalid('This channel is archived.')
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to write in it.`)
      const body = yield* messageText(text)
      const threadId = options.threadId ?? null
      if (threadId !== null) {
        const parent = data.messages.find(candidate => candidate.id === threadId)
        if (parent === undefined || parent.channelId !== channelId) return yield* invalid('That thread was deleted.')
        if (parent.threadId !== null) return yield* invalid('Reply to the thread itself.')
      }
      const message: Message = { id: id('msg'), channelId, authorId: actorId, text: body, createdAt: at, editedAt: null, reactions: [], threadId, alsoInChannel: threadId !== null && options.alsoInChannel === true, isDemo: false }
      return [message, { ...data, messages: [...data.messages, message], reads: withRead(data.reads, { memberId: actorId, channelId, at }) }] as const
    })

const findMessage = (data: WorkspaceData, messageId: string): Effect.Effect<Message, InvalidChange> => {
  const message = data.messages.find(candidate => candidate.id === messageId)
  return message === undefined ? invalid('That message was deleted.') : Effect.succeed(message)
}

const replaceMessage = (data: WorkspaceData, before: Message, after: Message): WorkspaceData => ({
  ...data,
  messages: data.messages.map(message => (message === before ? after : message)),
})

/** Only its author edits a message (Slack's default permission). */
export const editMessage =
  (messageId: string, text: string, actorId: string): Op<Message, InvalidChange> =>
  (data, { at }) =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      if (message.authorId !== actorId) return yield* invalid('You can only edit your own messages.')
      const body = yield* messageText(text)
      if (body === message.text) return [message, data] as const
      const edited: Message = { ...message, text: body, editedAt: at }
      return [edited, replaceMessage(data, message, edited)] as const
    })

/** Only its author deletes a message; a thread goes with its replies. */
export const deleteMessage =
  (messageId: string, actorId: string): Op<void, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      if (message.authorId !== actorId) return yield* invalid('You can only delete your own messages.')
      const messages = data.messages.filter(candidate => candidate !== message && candidate.threadId !== message.id)
      const gone = new Set(data.messages.filter(candidate => !messages.includes(candidate)).map(candidate => candidate.id))
      const saves = data.saves.some(saved => gone.has(saved.messageId)) ? data.saves.filter(saved => !gone.has(saved.messageId)) : data.saves
      return [undefined, { ...data, messages, saves }] as const
    })

/** Saves a message for later, or takes it out of Later. True if it is saved now. */
export const toggleSaved =
  (messageId: string, memberId: string): Op<boolean, InvalidChange> =>
  (data, { at }) =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      const channel = yield* findChannel(data, message.channelId)
      if (!canRead(channel, memberId) || !data.members.some(member => member.id === memberId)) return yield* invalid('That message was deleted.')
      const current = data.saves.find(saved => saved.memberId === memberId && saved.messageId === messageId)
      if (current?.state === 'saved') return [false, { ...data, saves: data.saves.filter(saved => saved !== current) }] as const
      const next: Saved = { memberId, messageId, state: 'saved', at }
      return [true, { ...data, saves: current === undefined ? [...data.saves, next] : data.saves.map(saved => (saved === current ? next : saved)) }] as const
    })

/** Marks a saved message completed, or back in progress. */
export const setSavedState =
  (messageId: string, memberId: string, state: SavedState): Op<void, InvalidChange> =>
  (data, { at }) =>
    Effect.gen(function* () {
      const current = data.saves.find(saved => saved.memberId === memberId && saved.messageId === messageId)
      if (current === undefined) return yield* invalid('That item is no longer saved.')
      if (current.state === state) return [undefined, data] as const
      return [undefined, { ...data, saves: data.saves.map(saved => (saved === current ? { ...current, state, at } : saved)) }] as const
    })

/** Removes a message from Later, in progress or completed. */
export const removeSaved =
  (messageId: string, memberId: string): Op<void> =>
  data => {
    const saves = data.saves.filter(saved => !(saved.memberId === memberId && saved.messageId === messageId))
    return unchanged(undefined, saves.length === data.saves.length ? data : { ...data, saves })
  }

/** Pins a message to its conversation, or un-pins it. Members do this,
 *  for messages shown in the conversation. True if it is pinned now. */
export const togglePin =
  (messageId: string, actorId: string): Op<boolean, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      const channel = yield* findChannel(data, message.channelId)
      if (!isMemberOf(channel, actorId)) return yield* invalid('Join this conversation to pin messages.')
      if (channel.isArchived) return yield* invalid('This channel is archived.')
      if (!inChannel(message)) return yield* invalid('Pin messages in the conversation itself.')
      if (message.pinnedBy !== undefined) {
        const { pinnedBy: _, ...unpinned } = message
        return [false, replaceMessage(data, message, unpinned)] as const
      }
      return [true, replaceMessage(data, message, { ...message, pinnedBy: actorId })] as const
    })

/** Adds your reaction, or takes it back if it is there. Members of the
 *  conversation react, with an emoji from the picker. */
export const toggleReaction =
  (messageId: string, emoji: string, actorId: string): Op<void, InvalidChange> =>
  (data, { at }) =>
    Effect.gen(function* () {
      if (!isEmoji(emoji)) return yield* invalid('Pick an emoji from the list.')
      const message = yield* findMessage(data, messageId)
      const channel = yield* findChannel(data, message.channelId)
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to react.`)
      const current = message.reactions.find(reaction => reaction.emoji === emoji)
      // Stamped for the author's Activity, so their own reactions don't count.
      const stamp = actorId === message.authorId ? {} : { at }
      const reactions =
        current === undefined
          ? [...message.reactions, { emoji, memberIds: [actorId], ...stamp }]
          : message.reactions
              .map(reaction =>
                reaction !== current
                  ? reaction
                  : current.memberIds.includes(actorId)
                    ? { ...current, memberIds: current.memberIds.filter(id => id !== actorId) }
                    : { ...current, memberIds: [...current.memberIds, actorId], ...stamp },
              )
              .filter(reaction => reaction.memberIds.length > 0)
      return [undefined, replaceMessage(data, message, { ...message, reactions })] as const
    })

/** Someone has read a conversation up to its newest message. */
export const markRead =
  (channelId: string, memberId: string): Op<void> =>
  data => {
    const channel = data.channels.find(candidate => candidate.id === channelId)
    if (channel === undefined || !canRead(channel, memberId)) return unchanged(undefined, data)
    const newest = data.messages.reduce((latest, message) => (message.channelId === channelId && message.createdAt > latest ? message.createdAt : latest), 0)
    if (newest === 0) return unchanged(undefined, data)
    const reads = withRead(data.reads, { memberId, channelId, at: newest })
    return unchanged(undefined, reads === data.reads ? data : { ...data, reads })
  }

/** Marks a conversation unread from a message on: read up to just before it. */
export const markUnread =
  (messageId: string, actorId: string): Op<void, InvalidChange> =>
  data =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      const channel = yield* findChannel(data, message.channelId)
      if (!isMemberOf(channel, actorId)) return yield* invalid('Join this conversation first.')
      if (!inChannel(message)) return yield* invalid('Mark a message in the conversation itself unread.')
      const read: Read = { memberId: actorId, channelId: channel.id, at: message.createdAt - 1 }
      const current = data.reads.find(candidate => candidate.memberId === actorId && candidate.channelId === channel.id)
      if (current?.at === read.at) return [undefined, data] as const
      return [undefined, { ...data, reads: current === undefined ? [...data.reads, read] : data.reads.map(candidate => (candidate === current ? read : candidate)) }] as const
    })

/** Someone has seen their Activity up to its newest item. */
export const seeActivity =
  (memberId: string): Op<void> =>
  data => {
    const me = data.members.find(member => member.id === memberId)
    const newest = me === undefined ? 0 : (activityOf(data, me)[0]?.at ?? 0)
    if (newest === 0) return unchanged(undefined, data)
    const reads = withRead(data.reads, { memberId, channelId: ACTIVITY_READ, at: newest })
    return unchanged(undefined, reads === data.reads ? data : { ...data, reads })
  }

// DEMO CONTENT

export type DemoCounts = Readonly<{ members: number; channels: number; messages: number }>

/** Adds the demo content (false if it is there already). */
export const addDemo =
  (demo: WorkspaceData): Op<boolean, InvalidChange> =>
  data => {
    if (data.members.some(member => member.isDemo)) return unchanged(false, data)
    const emails = new Set(data.members.map(member => member.email))
    const clash = demo.members.find(member => emails.has(member.email))
    if (clash !== undefined) return invalid(`${clash.email} has an account already.`)
    return Effect.succeed([
      true,
      {
        members: [...data.members, ...demo.members],
        channels: [...data.channels, ...demo.channels],
        messages: [...data.messages, ...demo.messages],
        reads: [...data.reads, ...demo.reads],
        saves: [...data.saves, ...demo.saves],
        passwords: { ...data.passwords, ...demo.passwords },
      },
    ] as const)
  }

/** Removes everything the demo script entered. */
export const clearDemo = (): Op<DemoCounts> => data => {
  const demoMembers = new Set(data.members.filter(member => member.isDemo).map(member => member.id))
  const channels = data.channels.filter(channel => !channel.isDemo)
  const channelIds = new Set(channels.map(channel => channel.id))
  const messages = data.messages.filter(message => !message.isDemo && channelIds.has(message.channelId) && !demoMembers.has(message.authorId))
  const messageIds = new Set(messages.map(message => message.id))
  const counts = { members: demoMembers.size, channels: data.channels.length - channels.length, messages: data.messages.length - messages.length }
  return unchanged(counts, {
    members: data.members.filter(member => !member.isDemo),
    channels: channels.map(channel => (channel.memberIds.some(id => demoMembers.has(id)) ? { ...channel, memberIds: channel.memberIds.filter(id => !demoMembers.has(id)) } : channel)),
    messages,
    reads: data.reads.filter(read => !demoMembers.has(read.memberId) && (channelIds.has(read.channelId) || read.channelId === ACTIVITY_READ)),
    saves: data.saves.filter(saved => !demoMembers.has(saved.memberId) && messageIds.has(saved.messageId)),
    passwords: Object.fromEntries(Object.entries(data.passwords).filter(([id]) => !demoMembers.has(id))),
  })
}
