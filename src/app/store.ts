import { randomUUID } from 'node:crypto'

import { Clock, Context, Effect, Layer, Semaphore, Stream, SubscriptionRef } from 'effect'

import type { Channel, Member, Message, Read } from './domain'
import { hashPassword, verifyPassword } from './password'
import {
  type DemoCounts,
  type InvalidChange,
  type Op,
  type WorkspaceData,
  addDemo,
  addMember,
  clearDemo,
  markRead,
  postMessage,
  setPreset,
  setTheme,
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
}>

/** The data at one version, and the state pages see (without passwords). */
export type Snapshot = Readonly<{ version: number; data: WorkspaceData; state: WorkspaceState }>

export const snapshotOf = (version: number, data: WorkspaceData): Snapshot => ({
  version,
  data,
  state: { version, members: data.members, channels: data.channels, messages: data.messages, reads: data.reads },
})

export type Backend = Readonly<{
  current: Effect.Effect<Snapshot>
  changes: Stream.Stream<Snapshot>
  /** Runs an operation atomically and makes its result the new state. */
  run: <A, E>(op: Op<A, E>) => Effect.Effect<A, E>
}>

export type NewAccount = Readonly<{ name: string; email: string; password: string }>

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly current: Effect.Effect<WorkspaceState>
    readonly changes: Stream.Stream<WorkspaceState>
    readonly member: (id: string) => Effect.Effect<Member | undefined>
    /** The member with this email and password. */
    readonly authenticate: (email: string, password: string) => Effect.Effect<Member | undefined>
    readonly addMember: (input: NewAccount) => Effect.Effect<Member, InvalidChange>
    readonly setTheme: (memberId: string, isDark: boolean) => Effect.Effect<void>
    readonly setPreset: (memberId: string, theme: string) => Effect.Effect<void>
    readonly postMessage: (channelId: string, text: string, actorId: string) => Effect.Effect<Message, InvalidChange>
    readonly markRead: (channelId: string, memberId: string) => Effect.Effect<void>
    /** Adds the demo content (false: it is there already). */
    readonly seedDemo: (demo: WorkspaceData) => Effect.Effect<boolean, InvalidChange>
    readonly clearDemo: Effect.Effect<DemoCounts>
  }
>()('hyperchat/Workspace') {}

export const fromBackend = (backend: Backend): Workspace['Service'] => ({
  current: Effect.map(backend.current, snapshot => snapshot.state),
  changes: Stream.map(backend.changes, snapshot => snapshot.state),
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
  postMessage: (channelId, text, actorId) => backend.run(postMessage(channelId, text, actorId)),
  markRead: (channelId, memberId) => backend.run(markRead(channelId, memberId)),
  seedDemo: demo => backend.run(addDemo(demo)),
  clearDemo: backend.run(clearDemo()),
})

/** Ids that are unique across processes and restarts. */
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`

export const memoryBackend = (initial: WorkspaceData): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(snapshotOf(1, initial))
    const lock = yield* Semaphore.make(1)
    return {
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
