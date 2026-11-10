import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { isMuted } from '@/app/domain'
import { Workspace } from '@/app/store'
import { hasUnread, navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('muted conversations', () => {
  it.effect('grey a channel, keep it out of the unread dot, and still count mentions', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const me = () => Effect.map(workspace.current, state => [state, state.members.find(member => member.id === 'mem_avery')!] as const)
      yield* workspace.markRead('ch_general', 'mem_avery')
      yield* workspace.setMuted('mem_avery', 'ch_general', true)
      const [mutedState, avery] = yield* me()
      assert.isTrue(isMuted(avery, 'ch_general'))
      yield* TestClock.adjust('1 second')
      yield* workspace.postMessage('ch_general', 'Lunch?', 'mem_blake')
      yield* workspace.postMessage('ch_general', '@avery lunch?', 'mem_blake')
      const [state, after] = yield* me()
      const row = navOf(state, after).channels.find(channel => channel.id === 'ch_general')!
      assert.isTrue(row.isMuted)
      assert.isTrue(row.isUnread)
      assert.strictEqual(row.mentions, 1)
      assert.isFalse(hasUnread({ channels: [row], dms: [], activity: 0 }))
      // Muting twice changes nothing; unmuting removes the field.
      yield* workspace.setMuted('mem_avery', 'ch_general', true)
      assert.strictEqual((yield* me())[1], after)
      assert.notStrictEqual(mutedState, state)
      yield* workspace.setMuted('mem_avery', 'ch_general', false)
      assert.isUndefined((yield* me())[1].muted)
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('only for conversations you are in', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const outside = state.channels.find(channel => channel.kind !== 'dm' && !channel.memberIds.includes('mem_blake'))!
      const error = yield* Effect.flip(workspace.setMuted('mem_blake', outside.id, true))
      assert.strictEqual(error.reason, 'Join the conversation first.')
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
