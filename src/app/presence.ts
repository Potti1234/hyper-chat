import { Effect, Ref, type Scope, Stream, SubscriptionRef } from 'effect'

/* Presence, as Slack shows it: someone is active while a page of theirs is
   connected and away otherwise. Pages hold a connection (`Workspace.connect`)
   in a Subscription that depends on `isConnected`, so it opens and closes
   with the page's live stream. It is not workspace data: it is never
   journaled, and a crashed process's people go away when its heartbeat
   stops (Postgres) or with the process (memory). */

export type Presence = Readonly<{
  /** Who has a page open, by id A to Z. */
  online: Effect.Effect<ReadonlyArray<string>>
  changes: Stream.Stream<ReadonlyArray<string>>
  /** Marks the member active until the scope closes. */
  connect: (memberId: string) => Effect.Effect<void, never, Scope.Scope>
}>

export const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((id, index) => id === b[index])

/** Counts this process's connections per member and calls `publish` with
 *  the members it has whenever that set changes. */
export const localConnections = (publish: (memberIds: ReadonlyArray<string>) => Effect.Effect<void>) =>
  Effect.map(Ref.make<ReadonlyMap<string, number>>(new Map()), counts => {
    const change = (memberId: string, by: 1 | -1) =>
      Ref.modify(counts, before => {
        const next = new Map(before)
        const count = (before.get(memberId) ?? 0) + by
        if (count <= 0) next.delete(memberId)
        else next.set(memberId, count)
        return [before.has(memberId) !== next.has(memberId) ? [...next.keys()].sort() : null, next] as const
      }).pipe(Effect.flatMap(ids => (ids === null ? Effect.void : publish(ids))))
    return (memberId: string) => Effect.acquireRelease(change(memberId, 1), () => change(memberId, -1))
  })

/** Presence within one process (tests, and the memory store). */
export const memoryPresence: Effect.Effect<Presence> = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
  const connect = yield* localConnections(ids => SubscriptionRef.set(ref, ids))
  return { online: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref), connect }
})

/** Whether the member has a page open. */
export const isOnline = (online: ReadonlyArray<string>, memberId: string): boolean => online.includes(memberId)
