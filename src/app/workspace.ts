import { Data, Effect } from 'effect'

import { activityOf } from './activity'
import { ACTIVITY_READ, AVATAR_COLORS, type Channel, DEFAULT_CHANNEL, MAX_CHANNEL_NAME, MAX_DESCRIPTION, MAX_FILES, MAX_MESSAGE, MAX_TOPIC, type Attachment, type Member, type Message, type NotifyLevel, type Preferences, type Read, type Saved, type SavedState, type Scheduled, canRead, channelSlug, defaultNotify, inChannel, isMemberOf, notifyLevel, preferencesOf } from './domain'
import { isSidebarSlug } from './preferences'
import { STATUS_EMOJI, isEmoji } from './emoji'
import { MAX_NAME, MAX_PRONOUNS, MAX_STATUS, MAX_TITLE, isTimeZone } from './profile'

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
  /** Messages waiting for their time (Schedule for later). */
  scheduled: ReadonlyArray<Scheduled>
  /** Password hashes by member id. They never leave the store. */
  passwords: Readonly<Record<string, string>>
}>

export const emptyData: WorkspaceData = { members: [], channels: [], messages: [], reads: [], saves: [], scheduled: [], passwords: {} }

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

const clearMember = (data: WorkspaceData, memberId: string, key: 'status' | 'pausedUntil' | 'muted' | 'starred' | 'notify'): WorkspaceData => {
  const member = data.members.find(candidate => candidate.id === memberId)
  if (member === undefined || member[key] === undefined) return data
  const { [key]: _cleared, ...rest } = member
  return { ...data, members: replace(data.members, rest) }
}

export const setTheme =
  (memberId: string, isDark: boolean): Op<void> =>
  data =>
    unchanged(undefined, updateMember(data, memberId, { isDark }))

export const setPreset =
  (memberId: string, theme: string): Op<void> =>
  data =>
    unchanged(undefined, updateMember(data, memberId, { theme }))

export const setPreferences =
  (memberId: string, preferences: Preferences): Op<void, InvalidChange> =>
  data => {
    if (!isSidebarSlug(preferences.sidebar)) return invalid('Unknown sidebar theme.')
    const member = data.members.find(candidate => candidate.id === memberId)
    if (member === undefined) return invalid('Unknown member.')
    const before = preferencesOf(member)
    const same = before.sidebar === preferences.sidebar && before.isCompact === preferences.isCompact && before.is24Hour === preferences.is24Hour
    return unchanged(undefined, same ? data : updateMember(data, memberId, { preferences: { sidebar: preferences.sidebar, isCompact: preferences.isCompact, is24Hour: preferences.is24Hour } }))
  }

export type ProfileInput = Readonly<{ name: string; title: string; pronouns: string; timeZone: string }>

export const updateProfile =
  (memberId: string, input: ProfileInput): Op<Member, InvalidChange> =>
  data => {
    const member = data.members.find(candidate => candidate.id === memberId)
    if (member === undefined) return invalid('Unknown member.')
    const name = input.name.trim().replace(/\s+/g, ' ')
    const title = input.title.trim()
    const pronouns = input.pronouns.trim()
    if (name === '') return invalid('Your full name can’t be empty.')
    if (name.length > MAX_NAME) return invalid(`Keep your name to ${MAX_NAME} characters.`)
    if (title.length > MAX_TITLE) return invalid(`Keep your title to ${MAX_TITLE} characters.`)
    if (pronouns.length > MAX_PRONOUNS) return invalid(`Keep pronouns to ${MAX_PRONOUNS} characters.`)
    if (!isTimeZone(input.timeZone)) return invalid('Pick a time zone from the list.')
    const next = updateMember(data, memberId, { name, title, pronouns, timeZone: input.timeZone })
    return Effect.succeed([next.members.find(candidate => candidate.id === memberId) ?? member, next] as const)
  }

/** Sets a custom status, or clears it when both emoji and text are empty. A
 *  text without an emoji gets Slack's speech bubble. */
export const setStatus =
  (memberId: string, input: Readonly<{ emoji: string; text: string; until: number }>): Op<void, InvalidChange> =>
  (data, { at }) => {
    const text = input.text.trim()
    if (text.length > MAX_STATUS) return invalid(`Keep your status to ${MAX_STATUS} characters.`)
    if (input.emoji !== '' && !isEmoji(input.emoji)) return invalid('Pick an emoji from the list.')
    if (input.until !== 0 && input.until <= at) return invalid('That time has passed.')
    if (text === '' && input.emoji === '') return unchanged(undefined, clearMember(data, memberId, 'status'))
    return unchanged(undefined, updateMember(data, memberId, { status: { emoji: input.emoji === '' ? STATUS_EMOJI : input.emoji, text, until: input.until } }))
  }

/** Adds a conversation to, or takes it out of, one of a member's lists. */
const setListed =
  (key: 'muted' | 'starred', memberId: string, channelId: string, isListed: boolean): Op<void, InvalidChange> =>
  data => {
    const member = data.members.find(candidate => candidate.id === memberId)
    if (member === undefined) return invalid('Unknown member.')
    const channel = data.channels.find(candidate => candidate.id === channelId)
    if (channel === undefined || !canRead(channel, memberId) || !isMemberOf(channel, memberId)) return invalid('Join the conversation first.')
    const before = member[key] ?? []
    if (before.includes(channelId) === isListed) return unchanged(undefined, data)
    const after = isListed ? [...before, channelId].sort() : before.filter(id => id !== channelId)
    return unchanged(undefined, after.length === 0 ? clearMember(data, memberId, key) : updateMember(data, memberId, { [key]: after }))
  }

/** Mutes or unmutes a conversation for one member (Slack's "Mute channel"). */
export const setMuted = (memberId: string, channelId: string, isMuted: boolean): Op<void, InvalidChange> => setListed('muted', memberId, channelId, isMuted)

/** Stars a conversation for one member, or takes the star off. */
export const setStarred = (memberId: string, channelId: string, isStarred: boolean): Op<void, InvalidChange> => setListed('starred', memberId, channelId, isStarred)

/** Sets what a member hears about from one conversation; the default level
 *  is stored as no entry at all. */
export const setNotify =
  (memberId: string, channelId: string, level: NotifyLevel): Op<void, InvalidChange> =>
  data => {
    const member = data.members.find(candidate => candidate.id === memberId)
    if (member === undefined) return invalid('Unknown member.')
    const channel = data.channels.find(candidate => candidate.id === channelId)
    if (channel === undefined || !canRead(channel, memberId) || !isMemberOf(channel, memberId)) return invalid('Join the conversation first.')
    if (notifyLevel(member, channel) === level) return unchanged(undefined, data)
    const { [channelId]: _previous, ...others } = member.notify ?? {}
    const after = level === defaultNotify(channel.kind) ? others : { ...others, [channelId]: level }
    return unchanged(undefined, Object.keys(after).length === 0 ? clearMember(data, memberId, 'notify') : updateMember(data, memberId, { notify: after }))
  }

/** Pauses notifications until then; 0 (or a moment past) resumes them. */
export const setPaused =
  (memberId: string, until: number): Op<void> =>
  (data, { at }) =>
    unchanged(undefined, until <= at ? clearMember(data, memberId, 'pausedUntil') : updateMember(data, memberId, { pausedUntil: until }))

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

export const messageText = (text: string, isEmptyAllowed = false): Effect.Effect<string, InvalidChange> => {
  const body = text.trim()
  if (body === '' && !isEmptyAllowed) return invalid('Write something first.')
  if (body.length > MAX_MESSAGE) return invalid(`Keep messages under ${MAX_MESSAGE} characters.`)
  return Effect.succeed(body)
}

export type PostOptions = Readonly<{
  threadId?: string | null
  alsoInChannel?: boolean
  /** Files stored by the Files service (files.ts); a message may be only files. */
  files?: ReadonlyArray<Attachment>
}>

/** Posts to a conversation, or as a reply in a thread of one of its messages. */
export const postMessage =
  (channelId: string, text: string, actorId: string, options: PostOptions = {}): Op<Message, InvalidChange> =>
  (data, { at, id }) =>
    Effect.gen(function* () {
      const channel = yield* findChannel(data, channelId)
      if (channel.isArchived) return yield* invalid('This channel is archived.')
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to write in it.`)
      const files = options.files ?? []
      if (files.length > MAX_FILES) return yield* invalid(`Share at most ${MAX_FILES} files at once.`)
      const body = yield* messageText(text, files.length > 0)
      const threadId = options.threadId ?? null
      if (threadId !== null) {
        const parent = data.messages.find(candidate => candidate.id === threadId)
        if (parent === undefined || parent.channelId !== channelId) return yield* invalid('That thread was deleted.')
        if (parent.threadId !== null) return yield* invalid('Reply to the thread itself.')
      }
      const message: Message = { id: id('msg'), channelId, authorId: actorId, text: body, createdAt: at, editedAt: null, reactions: [], threadId, alsoInChannel: threadId !== null && options.alsoInChannel === true, ...(files.length === 0 ? {} : { files }), isDemo: false }
      return [message, { ...data, messages: [...data.messages, message], reads: withRead(data.reads, { memberId: actorId, channelId, at }) }] as const
    })

// SCHEDULED MESSAGES AND REMINDERS

/** Schedule for later: checked like a message now, posted at `sendAt` by
 *  `deliverDue`. */
export const scheduleMessage =
  (channelId: string, text: string, actorId: string, sendAt: number, files: ReadonlyArray<Attachment> = []): Op<Scheduled, InvalidChange> =>
  (data, { at, id }) =>
    Effect.gen(function* () {
      const channel = yield* findChannel(data, channelId)
      if (channel.isArchived) return yield* invalid('This channel is archived.')
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to write in it.`)
      if (files.length > MAX_FILES) return yield* invalid(`Share at most ${MAX_FILES} files at once.`)
      if (sendAt <= at) return yield* invalid('Pick a time in the future.')
      const body = yield* messageText(text, files.length > 0)
      const item: Scheduled = { id: id('sch'), authorId: actorId, channelId, text: body, ...(files.length === 0 ? {} : { files }), sendAt, createdAt: at }
      return [item, { ...data, scheduled: [...data.scheduled, item] }] as const
    })

const findScheduled = (data: WorkspaceData, scheduledId: string, actorId: string): Effect.Effect<Scheduled, InvalidChange> => {
  const item = data.scheduled.find(candidate => candidate.id === scheduledId && candidate.authorId === actorId)
  return item === undefined ? invalid('That message was sent or cancelled already.') : Effect.succeed(item)
}

export const cancelScheduled =
  (scheduledId: string, actorId: string): Op<void, InvalidChange> =>
  data =>
    Effect.map(findScheduled(data, scheduledId, actorId), item => [undefined, { ...data, scheduled: data.scheduled.filter(candidate => candidate !== item) }] as const)

const send = (item: Scheduled): Op<Message, InvalidChange> => (data, context) =>
  postMessage(item.channelId, item.text, item.authorId, { files: item.files ?? [] })({ ...data, scheduled: data.scheduled.filter(candidate => candidate !== item) }, context)

/** "Send now" on a scheduled message. */
export const sendScheduledNow =
  (scheduledId: string, actorId: string): Op<Message, InvalidChange> =>
  (data, context) =>
    Effect.flatMap(findScheduled(data, scheduledId, actorId), item => send(item)(data, context))

/** Whether `deliverDue` has anything to do at `now` (checked before taking
 *  the lock, so idle processes stay out of the database). */
export const isDue = (data: Pick<WorkspaceData, 'scheduled' | 'saves'>, now: number): boolean =>
  data.scheduled.some(item => item.sendAt <= now) || data.saves.some(saved => saved.remindAt !== undefined && saved.reminded !== true && saved.remindAt <= now)

/** Posts the scheduled messages whose time came (those that can no longer
 *  be posted, say in a channel archived since, are dropped) and sets off
 *  due reminders. The number of messages posted. */
export const deliverDue = (): Op<number> => (data, context) =>
  Effect.gen(function* () {
    let next = data
    let posted = 0
    for (const item of data.scheduled.filter(candidate => candidate.sendAt <= context.at).sort((a, b) => a.sendAt - b.sendAt)) {
      const result = yield* Effect.result(send(item)(next, context))
      if (result._tag === 'Success') {
        next = result.success[1]
        posted++
      } else next = { ...next, scheduled: next.scheduled.filter(candidate => candidate.id !== item.id) }
    }
    if (next.saves.some(saved => saved.remindAt !== undefined && saved.reminded !== true && saved.remindAt <= context.at))
      next = { ...next, saves: next.saves.map(saved => (saved.remindAt !== undefined && saved.reminded !== true && saved.remindAt <= context.at ? { ...saved, reminded: true } : saved)) }
    return [posted, next] as const
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
      const body = yield* messageText(text, (message.files?.length ?? 0) > 0)
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
      // Completing an item ends its reminder, as in Slack.
      const { remindAt: _remindAt, reminded: _reminded, ...rest } = current
      const next: Saved = state === 'done' ? { ...rest, state, at } : { ...current, state, at }
      return [undefined, { ...data, saves: data.saves.map(saved => (saved === current ? next : saved)) }] as const
    })

/** "Remind me about this": saves the message for later (back in progress if
 *  it was completed) with a reminder at `remindAt`, or (null) drops the
 *  reminder and keeps it saved. */
export const setReminder =
  (messageId: string, memberId: string, remindAt: number | null): Op<void, InvalidChange> =>
  (data, { at }) =>
    Effect.gen(function* () {
      const message = yield* findMessage(data, messageId)
      const channel = yield* findChannel(data, message.channelId)
      if (!canRead(channel, memberId) || !data.members.some(member => member.id === memberId)) return yield* invalid('That message was deleted.')
      if (remindAt !== null && remindAt <= at) return yield* invalid('Pick a time in the future.')
      const current = data.saves.find(saved => saved.memberId === memberId && saved.messageId === messageId)
      if (remindAt === null) {
        if (current?.remindAt === undefined) return [undefined, data] as const
        const { remindAt: _remindAt, reminded: _reminded, ...rest } = current
        return [undefined, { ...data, saves: data.saves.map(saved => (saved === current ? rest : saved)) }] as const
      }
      const next: Saved = { memberId, messageId, state: 'saved', at: current?.state === 'saved' ? current.at : at, remindAt }
      return [undefined, { ...data, saves: current === undefined ? [...data.saves, next] : data.saves.map(saved => (saved === current ? next : saved)) }] as const
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
        scheduled: [...data.scheduled, ...demo.scheduled],
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
    scheduled: data.scheduled.filter(item => !demoMembers.has(item.authorId) && channelIds.has(item.channelId)),
    passwords: Object.fromEntries(Object.entries(data.passwords).filter(([id]) => !demoMembers.has(id))),
  })
}
