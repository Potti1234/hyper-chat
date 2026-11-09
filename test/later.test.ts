import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { init as clientInit, sliceOf, update as clientUpdate } from '@/app/client/page'
import { isSaved } from '@/app/domain'
import { init as laterInit, laterOf, shownOf, update as laterUpdate } from '@/app/later/page'
import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

const tick = TestClock.adjust('1 second')

describe('saved for later and pins', () => {
  it.effect('saves messages for later, completes and removes them', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Read this later', 'mem_blake')
      yield* tick
      assert.isTrue(yield* workspace.toggleSaved(message.id, 'mem_avery'))
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      assert.isTrue(isSaved(state.saves, 'mem_avery', message.id))
      assert.strictEqual(laterOf(state, avery)[0]!.message.id, message.id)
      yield* workspace.setSavedState(message.id, 'mem_avery', 'done')
      const done = laterOf(yield* workspace.current, avery)
      assert.strictEqual(done.find(item => item.message.id === message.id)!.state, 'done')
      assert.isTrue(yield* workspace.toggleSaved(message.id, 'mem_avery'))
      assert.isFalse(yield* workspace.toggleSaved(message.id, 'mem_avery'))
      yield* workspace.toggleSaved(message.id, 'mem_avery')
      yield* workspace.removeSaved(message.id, 'mem_avery')
      assert.isFalse((yield* workspace.current).saves.some(saved => saved.messageId === message.id))
      const missing = yield* Effect.flip(workspace.setSavedState(message.id, 'mem_avery', 'done'))
      assert.strictEqual(missing.reason, 'That item is no longer saved.')
      // Private channels you are not in stay out of reach.
      const secret = (yield* workspace.current).messages.find(candidate => candidate.channelId === 'ch_leads')
      if (secret !== undefined) assert.strictEqual((yield* Effect.flip(workspace.toggleSaved(secret.id, 'mem_casey'))).reason, 'That message was deleted.')
      // Deleting a message removes it from everyone's Later.
      yield* workspace.toggleSaved(message.id, 'mem_avery')
      yield* workspace.deleteMessage(message.id, 'mem_blake')
      assert.isFalse((yield* workspace.current).saves.some(saved => saved.messageId === message.id))
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('pins messages for members of the conversation', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Office hours: Tuesdays', 'mem_blake')
      assert.isTrue(yield* workspace.togglePin(message.id, 'mem_avery'))
      const pinned = (yield* workspace.current).messages.find(candidate => candidate.id === message.id)!
      assert.strictEqual(pinned.pinnedBy, 'mem_avery')
      const slice = sliceOf(yield* workspace.current, 'ch_general', 'mem_avery')
      assert.strictEqual(slice.pins[0]!.id, message.id)
      const outsider = yield* Effect.flip(workspace.togglePin(message.id, 'mem_nobody'))
      assert.strictEqual(outsider.reason, 'Join this conversation to pin messages.')
      const reply = yield* workspace.postMessage('ch_general', 'In a thread', 'mem_blake', { threadId: message.id })
      assert.strictEqual((yield* Effect.flip(workspace.togglePin(reply.id, 'mem_avery'))).reason, 'Pin messages in the conversation itself.')
      assert.isFalse(yield* workspace.togglePin(message.id, 'mem_blake'))
      assert.isFalse('pinnedBy' in (yield* workspace.current).messages.find(candidate => candidate.id === message.id)!)
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('the pages update optimistically and re-check what was clicked', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Pin me', 'mem_blake')
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const slice = sliceOf(state, 'ch_general', 'mem_avery')
      const { model } = clientInit({ me: avery, channelId: 'ch_general', channel: slice.channel!, members: slice.members, messages: slice.messages, older: slice.older, pins: slice.pins, saved: slice.saved, nav: slice.nav, now: 0, readMarker: 0, threadId: null })
      const saved = clientUpdate(model, { _tag: 'ClickedSave', messageId: message.id })
      assert.include(saved.model.saved, message.id)
      assert.strictEqual(saved.commands?.length, 1)
      assert.strictEqual(clientUpdate(model, { _tag: 'ClickedSave', messageId: 'msg_unknown' }).commands, undefined)
      assert.strictEqual(clientUpdate(model, { _tag: 'ClickedPin', messageId: message.id }).commands?.length, 1)
      assert.strictEqual(clientUpdate(model, { _tag: 'ClickedPin', messageId: 'msg_unknown' }).commands, undefined)

      yield* workspace.toggleSaved(message.id, 'mem_avery')
      const later = laterInit({ me: avery, members: state.members, items: laterOf(yield* workspace.current, avery), nav: slice.nav, now: 0, tab: 'saved' }).model
      const completed = laterUpdate(later, { _tag: 'ClickedSetState', messageId: message.id, state: 'done' })
      assert.isFalse(shownOf(completed.model).some(item => item.message.id === message.id))
      assert.isTrue(shownOf({ ...completed.model, tab: 'done' }).some(item => item.message.id === message.id))
      assert.strictEqual(laterUpdate(later, { _tag: 'ClickedRemove', messageId: 'msg_unknown' }).commands, undefined)
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
