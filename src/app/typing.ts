import { Clock, Effect, Option, Schedule, Schema as S, type Scope, Stream, SubscriptionRef } from 'effect'

/* "Blake is typing…", as Slack shows it under the composer. Like presence it
   is not workspace data: a page tells the store while its draft changes
   (`Workspace.setTyping`), the store tells every process (Postgres NOTIFY,
   or directly in memory), and a typist is dropped TYPING_MS after their
   last keystroke, when they send, or when they clear the draft. Announcing
   is throttled per person and conversation, so typing does not notify on
   every key. */

export const TYPING_MS = 6000
const RESEND_MS = 3000

export type Typist = Readonly<{ memberId: string; channelId: string; until: number }>

export const TypingEvent = S.Struct({ memberId: S.String, channelId: S.String, at: S.Number, isTyping: S.Boolean })
export type TypingEvent = typeof TypingEvent.Type

export type Typing = Readonly<{
  changes: Stream.Stream<ReadonlyArray<Typist>>
  set: (memberId: string, channelId: string, isTyping: boolean) => Effect.Effect<void>
}>

const isSame = (typist: Typist, event: Pick<TypingEvent, 'memberId' | 'channelId'>) => typist.memberId === event.memberId && typist.channelId === event.channelId

export const applyTyping = (typists: ReadonlyArray<Typist>, event: TypingEvent): ReadonlyArray<Typist> => {
  const others = typists.filter(typist => !isSame(typist, event))
  return event.isTyping ? [...others, { memberId: event.memberId, channelId: event.channelId, until: event.at + TYPING_MS }] : others
}

/** Typing in a thread is announced under the conversation and thread ids. */
export const threadTypingKey = (channelId: string, threadId: string): string => `${channelId}:${threadId}`

/** Who is typing in a conversation, other than the viewer, by id. */
export const typingIn = (typists: ReadonlyArray<Typist>, channelId: string, viewerId: string): ReadonlyArray<string> =>
  typists.filter(typist => typist.channelId === channelId && typist.memberId !== viewerId).map(typist => typist.memberId).sort()

/** This process's typists. `broadcast` sends an event to every process;
 *  each delivers it here with `receive`. */
export const localTyping = (broadcast: (event: TypingEvent) => Effect.Effect<void>): Effect.Effect<Typing & Readonly<{ receive: (event: TypingEvent) => Effect.Effect<void> }>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<ReadonlyArray<Typist>>([])
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const before = yield* SubscriptionRef.get(ref)
      const after = before.filter(typist => typist.until > now)
      if (after.length !== before.length) yield* SubscriptionRef.set(ref, after)
    }).pipe(Effect.repeat(Schedule.spaced('1 second')), Effect.forkScoped)
    return {
      changes: SubscriptionRef.changes(ref),
      receive: event => SubscriptionRef.update(ref, typists => applyTyping(typists, event)),
      set: (memberId, channelId, isTyping) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const known = (yield* SubscriptionRef.get(ref)).find(typist => isSame(typist, { memberId, channelId }))
          if (isTyping && known !== undefined && known.until - TYPING_MS + RESEND_MS > now) return
          if (!isTyping && known === undefined) return
          yield* broadcast({ memberId, channelId, at: now, isTyping })
        }),
    }
  })

/** Typing within one process (tests, and the memory store). */
export const memoryTyping: Effect.Effect<Typing, never, Scope.Scope> = Effect.gen(function* () {
  let deliver: (event: TypingEvent) => Effect.Effect<void> = () => Effect.void
  const typing = yield* localTyping(event => deliver(event))
  deliver = typing.receive
  return typing
})

/** A NOTIFY payload, if it is a typing event. */
export const decodeEvent = (payload: string): TypingEvent | undefined => {
  try {
    return Option.getOrUndefined(S.decodeUnknownOption(TypingEvent)(JSON.parse(payload)))
  } catch {
    return undefined
  }
}
