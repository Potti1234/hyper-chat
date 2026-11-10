import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Console, Effect } from 'effect'

import { NewMember, normalizeEmail, validate } from '@/app/domain'
import * as Postgres from '@/app/postgres'
import { Workspace } from '@/app/store'

/* Creates an account (it joins #general):

     npm run user:create -- --name "Avery Finch" --email afinch@hyperchat.example --password "…"

   In Docker: docker compose exec app npm run user:create -- … */

const { values } = parseArgs({
  options: { name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } },
})

const program = Effect.gen(function* () {
  const input = validate(NewMember, { name: values.name?.trim() ?? '', email: normalizeEmail(values.email ?? ''), password: values.password ?? '' })
  if (!input.ok) {
    for (const [field, message] of Object.entries(input.errors)) yield* Console.error(`--${field}: ${message}`)
    return yield* Effect.sync(() => process.exit(1))
  }
  const member = yield* Workspace.use(workspace => workspace.addMember(input.value))
  yield* Console.log(`Created ${member.name} <${member.email}>.`)
})

program.pipe(
  Effect.catchTag('InvalidChange', ({ reason }) => Console.error(`Not created: ${reason}`).pipe(Effect.andThen(Effect.sync(() => process.exit(1))))),
  Effect.provide(Postgres.layer),
  Effect.provide(Postgres.clientLayer),
  NodeRuntime.runMain,
)
