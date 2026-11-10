import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '@/app/store'
import { navOf, sidebarOrder, steppedTo } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('Alt+↑/↓', () => {
  it.effect('steps through the sidebar, wrapping, and to unread ones with Shift', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* workspace.setStarred('mem_avery', 'ch_random', true)
      const state = yield* workspace.current
      const nav = navOf(state, state.members.find(member => member.id === 'mem_avery')!)
      const rows = sidebarOrder(nav)
      assert.strictEqual(rows[0]?.id, 'ch_random')
      assert.strictEqual(steppedTo(nav, 'ch_random', 1, false)?.id, rows[1]?.id)
      assert.strictEqual(steppedTo(nav, 'ch_random', -1, false)?.id, rows.at(-1)?.id)
      assert.strictEqual(steppedTo(nav, undefined, 1, false)?.id, 'ch_random')
      const unread = steppedTo(nav, 'ch_random', 1, true)
      assert.isTrue(unread === undefined || unread.isUnread || unread.mentions > 0)
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
