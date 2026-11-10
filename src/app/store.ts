import { randomUUID } from 'node:crypto'

import { Clock, Context, Effect, Layer, type Scope, Semaphore, Stream, SubscriptionRef } from 'effect'

import type { Channel, Member, Message, Read, Saved, SavedState } from './domain'
import { hashPassword, verifyPassword } from './password'
import { type Presence, memoryPresence, sameIds } from './presence'
import {
  type ChannelDetails,
  type DemoCounts,
  type InvalidChange,
  type NewChannelInput,
  type Op,
  type PostOptions,
  type ProfileInput,
  type WorkspaceData,
  addDemo,
  addMember,
  addToChannel,
  clearDemo,
  createChannel,
  joinChannel,
  leaveChannel,
  setArchived,
  updateChannel,
  markRead,
  markUnread,
  removeSaved,
  seeActivity,
  setSavedState,
  togglePin,
  toggleSaved,
  openConversation,
  editMessage,
  deleteMessage,
  toggleReaction,
  postMessage,
  setPreset,
  setTheme,
  setPaused,
  setStatus,
  updateProfile,
} from './workspace'

export { InvalidChange } from './workspace'

/* The workspace: everyone's shared, live state, with a change feed
   (`changes` emits the current state at once, then every new one); pages
   subscribe to it. A backend holds the data and runs the operations of
   `workspace.ts` one at a time: in memory for tests (`memoryLayer`), in
   Postgres for the app (`postgres.ts`). */

export type WorkspaceState = Readonly<{
  /** Increases with every change. */
  version: number
  members: ReadonlyArray<Member>
  channels: ReadonlyArray<Channel>
  messages: ReadonlyArray<Message>
  reads: ReadonlyArray<Read>
  saves: ReadonlyArray<Saved>
  /** Who has a page open right now, by id (see presence.ts). */
  online: ReadonlyArray<string>
}>

type SharedState = Omit<WorkspaceState, 'online'>

/** The data at one version, and the state pages see (without passwords). */
export type Snapshot = Readonly<{ version: number; data: WorkspaceData; state: SharedState }>

export const snapshotOf = (version: number, data: WorkspaceData): Snapshot => ({
  version,
  data,
  state: { version, members: data.members, channels: data.channels, messages: data.messages, reads: data.reads, saves: data.saves },
})

export type Backend = Readonly<{
  current: Effect.Effect<Snapshot>
  changes: Stream.Stream<Snapshot>
  /** Runs an operation atomically and makes its result the new state. */
  run: <A, E>(op: Op<A, E>) => Effect.Effect<A, E>
  presence: Presence
}>

export type NewAccount = Readonly<{ name: string; email: string; password: string }>

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly current: Effect.Effect<WorkspaceState>
    readonly changes: Stream.Stream<WorkspaceState>
    /** Shows the member as active until the scope closes. */
    readonly connect: (memberId: string) => Effect.Effect<void, never, Scope.Scope>
    readonly member: (id: string) => Effect.Effect<Member | undefined>
    /** The member with this email and password. */
    readonly authenticate: (email: string, password: string) => Effect.Effect<Member | undefined>
    readonly addMember: (input: NewAccount) => Effect.Effect<Member, InvalidChange>
    readonly setTheme: (memberId: string, isDark: boolean) => Effect.Effect<void>
    readonly setPreset: (memberId: string, theme: string) => Effect.Effect<void>
    readonly updateProfile: (memberId: string, input: ProfileInput) => Effect.Effect<Member, InvalidChange>
    readonly setStatus: (memberId: string, input: Readonly<{ emoji: string; text: string; until: number }>) => Effect.Effect<void, InvalidChange>
    readonly setPaused: (memberId: string, until: number) => Effect.Effect<void>
    readonly createChannel: (input: NewChannelInput, actorId: string) => Effect.Effect<Channel, InvalidChange>
    readonly joinChannel: (channelId: string, actorId: string) => Effect.Effect<Channel, InvalidChange>
    readonly leaveChannel: (channelId: string, actorId: string) => Effect.Effect<void, InvalidChange>
    readonly addToChannel: (channelId: string, memberIds: ReadonlyArray<string>, actorId: string) => Effect.Effect<Channel, InvalidChange>
    readonly updateChannel: (channelId: string, details: ChannelDetails, actorId: string) => Effect.Effect<Channel, InvalidChange>
    readonly setArchived: (channelId: string, isArchived: boolean, actorId: string) => Effect.Effect<void, InvalidChange>
    /** The direct message with these people, started if there is none. */
    readonly openConversation: (memberIds: ReadonlyArray<string>, actorId: string) => Effect.Effect<Channel, InvalidChange>
    readonly postMessage: (channelId: string, text: string, actorId: string, options?: PostOptions) => Effect.Effect<Message, InvalidChange>
    readonly markRead: (channelId: string, memberId: string) => Effect.Effect<void>
    readonly markUnread: (messageId: string, actorId: string) => Effect.Effect<void, InvalidChange>
    readonly seeActivity: (memberId: string) => Effect.Effect<void>
    readonly toggleSaved: (messageId: string, memberId: string) => Effect.Effect<boolean, InvalidChange>
    readonly setSavedState: (messageId: string, memberId: string, state: SavedState) => Effect.Effect<void, InvalidChange>
    readonly removeSaved: (messageId: string, memberId: string) => Effect.Effect<void>
    readonly togglePin: (messageId: string, actorId: string) => Effect.Effect<boolean, InvalidChange>
    readonly editMessage: (messageId: string, text: string, actorId: string) => Effect.Effect<Message, InvalidChange>
    readonly deleteMessage: (messageId: string, actorId: string) => Effect.Effect<void, InvalidChange>
    readonly toggleReaction: (messageId: string, emoji: string, actorId: string) => Effect.Effect<void, InvalidChange>
    /** Adds the demo content (false: it is there already). */
    readonly seedDemo: (demo: WorkspaceData) => Effect.Effect<boolean, InvalidChange>
    readonly clearDemo: Effect.Effect<DemoCounts>
  }
>()('hyperchat/Workspace') {}

export const fromBackend = (backend: Backend): Workspace['Service'] => ({
  current: Effect.zipWith(backend.current, backend.presence.online, (snapshot, online) => ({ ...snapshot.state, online })),
  changes: Stream.zipLatestWith(backend.changes, Stream.changesWith(backend.presence.changes, sameIds), (snapshot, online) => ({ ...snapshot.state, online })),
  connect: backend.presence.connect,
  member: id => Effect.map(backend.current, ({ data }) => data.members.find(member => member.id === id)),
  authenticate: (email, password) =>
    Effect.gen(function* () {
      const { data } = yield* backend.current
      const member = data.members.find(candidate => candidate.email === email.trim().toLowerCase())
      // Verify against a dummy hash for unknown emails too, so timing reveals nothing.
      const matches = yield* verifyPassword(password, member === undefined ? undefined : data.passwords[member.id])
      return matches ? member : undefined
    }),
  addMember: input =>
    Effect.gen(function* () {
      const passwordHash = yield* hashPassword(input.password)
      return yield* backend.run(addMember({ name: input.name, email: input.email.trim().toLowerCase(), passwordHash }))
    }),
  setTheme: (memberId, isDark) => backend.run(setTheme(memberId, isDark)),
  setPreset: (memberId, theme) => backend.run(setPreset(memberId, theme)),
  updateProfile: (memberId, input) => backend.run(updateProfile(memberId, input)),
  setStatus: (memberId, input) => backend.run(setStatus(memberId, input)),
  setPaused: (memberId, until) => backend.run(setPaused(memberId, until)),
  createChannel: (input, actorId) => backend.run(createChannel(input, actorId)),
  joinChannel: (channelId, actorId) => backend.run(joinChannel(channelId, actorId)),
  leaveChannel: (channelId, actorId) => backend.run(leaveChannel(channelId, actorId)),
  addToChannel: (channelId, memberIds, actorId) => backend.run(addToChannel(channelId, memberIds, actorId)),
  updateChannel: (channelId, details, actorId) => backend.run(updateChannel(channelId, details, actorId)),
  setArchived: (channelId, isArchived, actorId) => backend.run(setArchived(channelId, isArchived, actorId)),
  openConversation: (memberIds, actorId) => backend.run(openConversation(memberIds, actorId)),
  postMessage: (channelId, text, actorId, options) => backend.run(postMessage(channelId, text, actorId, options)),
  markRead: (channelId, memberId) => backend.run(markRead(channelId, memberId)),
  markUnread: (messageId, actorId) => backend.run(markUnread(messageId, actorId)),
  seeActivity: memberId => backend.run(seeActivity(memberId)),
  toggleSaved: (messageId, memberId) => backend.run(toggleSaved(messageId, memberId)),
  setSavedState: (messageId, memberId, state) => backend.run(setSavedState(messageId, memberId, state)),
  removeSaved: (messageId, memberId) => backend.run(removeSaved(messageId, memberId)),
  togglePin: (messageId, actorId) => backend.run(togglePin(messageId, actorId)),
  editMessage: (messageId, text, actorId) => backend.run(editMessage(messageId, text, actorId)),
  deleteMessage: (messageId, actorId) => backend.run(deleteMessage(messageId, actorId)),
  toggleReaction: (messageId, emoji, actorId) => backend.run(toggleReaction(messageId, emoji, actorId)),
  seedDemo: demo => backend.run(addDemo(demo)),
  clearDemo: backend.run(clearDemo()),
})

/** Ids that are unique across processes and restarts. */
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`

export const memoryBackend = (initial: WorkspaceData): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(snapshotOf(1, initial))
    const lock = yield* Semaphore.make(1)
    const presence = yield* memoryPresence
    return {
      presence,
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      run: op =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const snapshot = yield* SubscriptionRef.get(ref)
            const [result, next] = yield* op(snapshot.data, { at, id: newId })
            if (next !== snapshot.data) yield* SubscriptionRef.set(ref, snapshotOf(snapshot.version + 1, next))
            return result
          }),
        ),
    }
  })

/** The workspace in this process's memory, starting from `initial`. */
export const memoryLayer = (initial: Effect.Effect<WorkspaceData>) =>
  Layer.effect(Workspace, Effect.flatMap(initial, memoryBackend).pipe(Effect.map(fromBackend)))

/** For a page's Subscriptions: shows the member as active while the page is
 *  connected (it never emits). */
export const presenceWhile = (memberId: string, isConnected: boolean): Stream.Stream<never, never, Workspace> =>
  isConnected ? Stream.fromEffect(Effect.scoped(Workspace.use(workspace => Effect.andThen(workspace.connect(memberId), Effect.never)))) : Stream.empty
