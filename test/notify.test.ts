import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { activityOf } from '@/app/activity'
import { notifyLevel } from '@/app/domain'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('per-conversation notifications', () => {
  it.effect('decide what the badge and Activity count', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const avery = 'mem_avery'
      const state0 = yield* workspace.current
      const me = () => Effect.map(workspace.current, state => state.members.find(member => member.id === avery)!)
      const random = state0.channels.find(channel => channel.id === 'ch_random')!
      assert.strictEqual(notifyLevel(yield* me(), random), 'mentions')
      yield* workspace.markRead('ch_random', avery)
      yield* workspace.postMessage('ch_random', 'plain news', 'mem_blake')
      yield* workspace.postMessage('ch_random', 'hey @avery', 'mem_blake')
      const badge = () => Effect.map(workspace.current, state => navOf(state, state.members.find(member => member.id === avery)!).channels.find(row => row.id === 'ch_random')?.mentions)
      const mentioned = () => Effect.map(workspace.current, state => activityOf(state, state.members.find(member => member.id === avery)!).some(item => item.kind === 'mention' && item.channelId === 'ch_random'))
      assert.strictEqual(yield* badge(), 1)
      yield* workspace.setNotify(avery, 'ch_random', 'all')
      assert.isAbove((yield* badge()) ?? 0, 1)
      yield* workspace.setNotify(avery, 'ch_random', 'nothing')
      assert.strictEqual(yield* badge(), 0)
      assert.isFalse(yield* mentioned())
      yield* workspace.setNotify(avery, 'ch_random', 'mentions')
      assert.isTrue(yield* mentioned())
      assert.isUndefined((yield* me()).notify)
      const error = yield* Effect.flip(workspace.setNotify('mem_casey', 'ch_leads', 'all'))
      assert.strictEqual(error._tag, 'InvalidChange')
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
