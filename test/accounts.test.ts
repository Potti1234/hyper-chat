import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

describe('accounts (npm run user:create)', () => {
  it.effect('a new account joins #general and signs in with its password', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const dana = yield* workspace.addMember({ name: 'Dana Reyes', email: 'dreyes@hyperchat.example', password: 'dana-password-1' })
      const state = yield* workspace.current
      assert.isTrue(state.channels.find(channel => channel.name === 'general')?.memberIds.includes(dana.id))
      assert.strictEqual((yield* workspace.authenticate('dreyes@hyperchat.example', 'dana-password-1'))?.id, dana.id)
      assert.isUndefined(yield* workspace.authenticate('dreyes@hyperchat.example', 'wrong-password'))
      const again = yield* Effect.flip(workspace.addMember({ name: 'Dana Again', email: 'dreyes@hyperchat.example', password: 'another-password' }))
      assert.strictEqual(again.reason, 'Someone already signs in with that email.')
    }).pipe(Effect.provide(workspaceLayer())))
})
