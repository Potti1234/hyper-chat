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

  it.effect('lets only the author edit and delete a message', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Draft', 'mem_avery')
      const other = yield* Effect.flip(workspace.editMessage(message.id, 'Hijacked', 'mem_blake'))
      assert.strictEqual(other.reason, 'You can only edit your own messages.')
      const edited = yield* workspace.editMessage(message.id, ' Final ', 'mem_avery')
      assert.strictEqual(edited.text, 'Final')
      assert.isNotNull(edited.editedAt)
      assert.strictEqual((yield* Effect.flip(workspace.deleteMessage(message.id, 'mem_blake'))).reason, 'You can only delete your own messages.')
      yield* workspace.deleteMessage(message.id, 'mem_avery')
      assert.isFalse((yield* workspace.current).messages.some(candidate => candidate.id === message.id))
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('toggles reactions for members, with emoji from the picker', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Ship it', 'mem_avery')
      const reactions = () => Effect.map(workspace.current, state => state.messages.find(candidate => candidate.id === message.id)?.reactions)
      yield* workspace.toggleReaction(message.id, '🚀', 'mem_blake') // eslint-disable-line crease/no-native-glyphs -- reaction content
      yield* workspace.toggleReaction(message.id, '🚀', 'mem_casey') // eslint-disable-line crease/no-native-glyphs -- reaction content
      assert.deepStrictEqual(yield* reactions(), [{ emoji: '🚀', memberIds: ['mem_blake', 'mem_casey'] }]) // eslint-disable-line crease/no-native-glyphs -- reaction content
      yield* workspace.toggleReaction(message.id, '🚀', 'mem_blake') // eslint-disable-line crease/no-native-glyphs -- reaction content
      yield* workspace.toggleReaction(message.id, '🚀', 'mem_casey') // eslint-disable-line crease/no-native-glyphs -- reaction content
      assert.deepStrictEqual(yield* reactions(), [])
      assert.strictEqual((yield* Effect.flip(workspace.toggleReaction(message.id, 'nope', 'mem_blake'))).reason, 'Pick an emoji from the list.')
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
