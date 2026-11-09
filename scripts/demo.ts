import { NodeRuntime } from '@effect/platform-node'
import { Clock, Console, Effect } from 'effect'

import * as Postgres from '@/app/postgres'
import { DEMO_MEMBERS, demoData, demoPassword, demoPasswords } from '@/app/seed'
import { Workspace } from '@/app/store'

/* The demo content in the database (DATABASE_URL, or the development one):

     npm run demo:seed     adds it, unless it is there already
     npm run demo:clear    removes it again (demo people, channels and
                           messages); real content stays
     npm run demo:reset    both: fresh demo content

   A running app picks the change up at once (Postgres notifications). */

const seed = Effect.gen(function* () {
  const workspace = yield* Workspace
  const now = yield* Clock.currentTimeMillis
  const data = demoData(now)
  const added = yield* workspace.seedDemo({ ...data, passwords: yield* demoPasswords })
  if (!added) return yield* Console.log('The demo content is there already (npm run demo:reset starts it afresh).')
  yield* Console.log(`Added the demo workspace: ${data.members.length} people, ${data.channels.length} conversations, ${data.messages.length} messages. Sign in with, for example:`)
  for (const member of DEMO_MEMBERS.slice(0, 3)) yield* Console.log(`  ${member.email}  /  ${demoPassword(member)}`)
  yield* Console.log('Every demo password is the first name.')
})

const clear = Effect.gen(function* () {
  const removed = yield* Workspace.use(workspace => workspace.clearDemo)
  yield* Console.log(`Removed the demo content: ${removed.members} people, ${removed.channels} conversations, ${removed.messages} messages.`)
})

const command = process.argv[2]
const program =
  command === 'seed' ? seed : command === 'clear' ? clear : command === 'reset' ? Effect.andThen(clear, seed) : Console.error('Usage: demo.ts seed | clear | reset')

program.pipe(
  Effect.catchTag('InvalidChange', ({ reason }) => Console.error(`Not changed: ${reason}`)),
  Effect.provide(Postgres.layer),
  Effect.provide(Postgres.clientLayer),
  NodeRuntime.runMain,
)
