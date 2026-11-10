import { Clock, Effect, Layer, Schedule } from 'effect'

import { Workspace } from './store'
import { isDue } from './workspace'

/* Sends scheduled messages and sets off reminders when their time comes.
   Every server process runs it; `deliverDue` takes the workspace lock, so
   each message is posted once, and a process only asks when its own copy
   of the workspace shows something due. */

const EVERY = '5 seconds'

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspace = yield* Workspace
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (isDue(yield* workspace.current, now)) yield* workspace.deliverDue
    }).pipe(Effect.catchCause(cause => Effect.logWarning('scheduled delivery', cause)), Effect.repeat(Schedule.spaced(EVERY)), Effect.forkScoped)
  }),
)
