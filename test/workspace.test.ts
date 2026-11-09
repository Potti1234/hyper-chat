import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

describe('workspace', () => {
  it.effect('posts a message to a channel the author is in and marks it read for them', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', '  Hello team  ', 'mem_avery')
      assert.strictEqual(message.text, 'Hello team')
      const state = yield* workspace.current
      assert.isTrue(state.messages.some(candidate => candidate.id === message.id))
      assert.strictEqual(state.reads.find(read => read.memberId === 'mem_avery' && read.channelId === 'ch_general')?.at, message.createdAt)
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('refuses empty messages and channels the author has not joined', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const empty = yield* Effect.flip(workspace.postMessage('ch_general', '   ', 'mem_avery'))
      assert.strictEqual(empty.reason, 'Write something first.')
      const outsider = yield* Effect.flip(workspace.postMessage('ch_eng', 'Hi', 'mem_frankie'))
      assert.strictEqual(outsider.reason, 'Join #engineering to write in it.')
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('clears the demo content', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const removed = yield* workspace.clearDemo
      assert.isAbove(removed.messages, 0)
      const state = yield* workspace.current
      assert.deepStrictEqual([state.members.length, state.channels.length, state.messages.length], [0, 0, 0])
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
