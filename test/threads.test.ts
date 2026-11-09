import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { threadsOf } from '@/app/threads/page'
import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

describe('the Threads view', () => {
  it.effect('lists threads you started, replied in or were mentioned in, newest reply first', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const start = yield* workspace.postMessage('ch_general', 'Mine', 'mem_avery')
      const other = yield* workspace.postMessage('ch_general', 'Not mine', 'mem_blake')
      const mention = yield* workspace.postMessage('ch_general', 'Pinging', 'mem_blake')
      yield* workspace.postMessage('ch_general', 'Answer', 'mem_blake', { threadId: start.id })
      yield* workspace.postMessage('ch_general', 'Between us', 'mem_casey', { threadId: other.id })
      yield* workspace.postMessage('ch_general', 'What do you think @avery?', 'mem_casey', { threadId: mention.id })
      const state = yield* workspace.current
      const me = state.members.find(member => member.id === 'mem_avery')!
      const ids = threadsOf(state, me).map(card => card.root.id)
      assert.include(ids, start.id)
      assert.include(ids, mention.id)
      assert.notInclude(ids, other.id)
      assert.isBelow(ids.indexOf(mention.id), ids.indexOf(start.id))
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
