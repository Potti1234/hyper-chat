import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { activityOf } from '@/app/activity'
import { init as activityInit, shownOf, update as activityUpdate } from '@/app/activity/page'
import { init as clientInit, sliceOf, update as clientUpdate } from '@/app/client/page'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

const tick = TestClock.adjust('1 second')

describe('activity and unreads', () => {
  it.effect('lists mentions, thread replies and reactions, and counts what is unseen', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* tick
      const mine = yield* workspace.postMessage('ch_general', 'Who has the deck?', 'mem_avery')
      yield* tick
      const mention = yield* workspace.postMessage('ch_general', '@avery the deck is here', 'mem_blake')
      yield* tick
      const reply = yield* workspace.postMessage('ch_general', 'Me', 'mem_casey', { threadId: mine.id })
      yield* tick
      yield* workspace.toggleReaction(mine.id, '🎉', 'mem_blake')
      yield* tick
      yield* workspace.toggleReaction(mine.id, '👀', 'mem_avery')
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const items = activityOf(state, avery)
      assert.deepStrictEqual(items.slice(0, 3).map(item => item.id), [`reaction:${mine.id}:🎉`, `reply:${reply.id}`, `mention:${mention.id}`])
      // Your own reaction on your own message is not activity.
      assert.isFalse(items.some(item => item.id === `reaction:${mine.id}:👀`))
      const before = navOf(state, avery).activity
      assert.isAtLeast(before, 3)
      yield* tick
      yield* workspace.seeActivity('mem_avery')
      assert.strictEqual(navOf(yield* workspace.current, avery).activity, 0)
      yield* tick
      yield* workspace.postMessage('ch_general', '@here standup', 'mem_blake')
      assert.strictEqual(navOf(yield* workspace.current, avery).activity, 1)
      // Blake's activity does not include messages from a private channel he is not in.
      const blake = state.members.find(member => member.id === 'mem_blake')!
      assert.isFalse(activityOf(state, blake).some(item => item.channelId === 'ch_leads' && !state.channels.find(channel => channel.id === 'ch_leads')!.memberIds.includes('mem_blake')))
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('filters by tab and unread, and marks seen once connected', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* tick
      yield* workspace.postMessage('ch_general', '@avery ping', 'mem_blake')
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const items = activityOf(state, avery)
      const { model } = activityInit({ me: avery, members: state.members, items, root: null, nav: navOf(state, avery), now: 0, tab: 'all', picked: null, seenAt: 0 })
      assert.isTrue(shownOf({ ...model, tab: 'mention' }).every(item => item.kind === 'mention'))
      assert.deepStrictEqual(shownOf({ ...model, isUnreadOnly: true, seenAt: Number.MAX_SAFE_INTEGER }), [])
      const connected = activityUpdate(model, { _tag: 'ChangedConnection', isConnected: true })
      assert.strictEqual(connected.commands?.length, 1)
      assert.strictEqual(connected.model.markedUpTo, items[0]!.at)
      assert.strictEqual(activityUpdate(connected.model, { _tag: 'ChangedConnection', isConnected: true }).commands, undefined)
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('marks a conversation unread from a message', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* tick
      const first = yield* workspace.postMessage('ch_general', 'One', 'mem_blake')
      yield* tick
      yield* workspace.postMessage('ch_general', 'Two', 'mem_blake')
      yield* tick
      yield* workspace.markRead('ch_general', 'mem_avery')
      const read = yield* workspace.current
      const avery = read.members.find(member => member.id === 'mem_avery')!
      assert.isFalse(navOf(read, avery).channels.find(row => row.id === 'ch_general')!.isUnread)
      yield* tick
      yield* workspace.markUnread(first.id, 'mem_avery')
      const after = yield* workspace.current
      assert.isTrue(navOf(after, avery).channels.find(row => row.id === 'ch_general')!.isUnread)
      yield* tick
      const stranger = yield* Effect.flip(workspace.markUnread(first.id, 'mem_nobody'))
      assert.strictEqual(stranger.reason, 'Join this conversation first.')

      const slice = sliceOf(after, 'ch_general', 'mem_avery')
      const { model } = clientInit({ me: avery, channelId: 'ch_general', channel: slice.channel!, members: slice.members, messages: slice.messages, older: slice.older, nav: slice.nav, now: 0, readMarker: Number.MAX_SAFE_INTEGER, threadId: null })
      const marked = clientUpdate(model, { _tag: 'ClickedMarkUnread', messageId: first.id })
      assert.strictEqual(marked.model.readMarker, first.createdAt - 1)
      assert.strictEqual(marked.commands?.length, 1)
      // It stays unread while the conversation is open.
      const later = clientUpdate(marked.model, { _tag: 'ChangedConnection', isConnected: true })
      assert.strictEqual(later.commands?.length ?? 0, 0)
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
