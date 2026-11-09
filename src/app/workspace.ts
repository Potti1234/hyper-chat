import { Data, Effect } from 'effect'

import { AVATAR_COLORS, type Channel, MAX_MESSAGE, type Member, type Message, type Read, canRead, isMemberOf } from './domain'

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
  /** Password hashes by member id. They never leave the store. */
  passwords: Readonly<Record<string, string>>
}>

export const emptyData: WorkspaceData = { members: [], channels: [], messages: [], reads: [], passwords: {} }

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
    const general = data.channels.find(channel => channel.kind === 'public' && channel.name === 'general')
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

export const postMessage =
  (channelId: string, text: string, actorId: string): Op<Message, InvalidChange> =>
  (data, { at, id }) =>
    Effect.gen(function* () {
      const channel = yield* findChannel(data, channelId)
      if (channel.isArchived) return yield* invalid('This channel is archived.')
      if (!isMemberOf(channel, actorId)) return yield* invalid(`Join #${channel.name} to write in it.`)
      const body = yield* messageText(text)
      const message: Message = { id: id('msg'), channelId, authorId: actorId, text: body, createdAt: at, editedAt: null, reactions: [], isDemo: false }
      return [message, { ...data, messages: [...data.messages, message], reads: withRead(data.reads, { memberId: actorId, channelId, at }) }] as const
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
  const counts = { members: demoMembers.size, channels: data.channels.length - channels.length, messages: data.messages.length - messages.length }
  return unchanged(counts, {
    members: data.members.filter(member => !member.isDemo),
    channels: channels.map(channel => (channel.memberIds.some(id => demoMembers.has(id)) ? { ...channel, memberIds: channel.memberIds.filter(id => !demoMembers.has(id)) } : channel)),
    messages,
    reads: data.reads.filter(read => !demoMembers.has(read.memberId) && channelIds.has(read.channelId)),
    passwords: Object.fromEntries(Object.entries(data.passwords).filter(([id]) => !demoMembers.has(id))),
  })
}
