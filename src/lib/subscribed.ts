import { Schema as S, SchemaGetter } from 'effect'

/* A Model field that a Subscription fills, such as the workspace's issues.
   hyper-effect snapshots a session's Model after each interaction (to carry
   it across restarts). Shared data does not belong in that snapshot: it is
   the same for everyone, can be large (thousands of synced issues), and the
   Subscription delivers it again as soon as a restored session starts.

   So the field is stored as [] in snapshots, without encoding its contents,
   and restored as `empty`. In memory it is the shared value itself. Only
   use it for data a Subscription sends right away. */

export const subscribed = <A>(isValue: (input: unknown) => input is A, empty: A) =>
  S.declare<A>(isValue).pipe(
    S.encodeTo(S.Tuple([]), {
      decode: SchemaGetter.transform(() => empty),
      encode: SchemaGetter.transform(() => [] as const),
    }),
  )

/** A list a Subscription fills (see above). */
export const subscribedArray = <A>() => subscribed((input: unknown): input is ReadonlyArray<A> => Array.isArray(input), [] as ReadonlyArray<A>)
