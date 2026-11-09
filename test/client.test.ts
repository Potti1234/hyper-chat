import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { homeChannel, rowsOf, sliceOf, summaryOf } from '@/app/client/page'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

const message = (id: string, authorId: string, createdAt: number) => ({ id, channelId: 'c', authorId, text: id, createdAt, editedAt: null, reactions: [], threadId: null, alsoInChannel: false, isDemo: false })

describe('conversation page', () => {
  it('groups messages by day and author and marks where you stopped', () => {
    const day = Date.UTC(2026, 10, 9, 10)
    const rows = rowsOf([message('a', 'x', day), message('b', 'x', day + 60_000), message('c', 'y', day + 120_000), message('d', 'y', day + 86_400_000)], day + 90_000, 'me')
    assert.deepStrictEqual(
      rows.map(row => (row._tag === 'message' ? `${row.message.id}${row.isFirst ? '*' : ''}` : row._tag)),
      ['day', 'a*', 'b', 'new', 'c*', 'day', 'd*'],
    )
  })

  it('summarizes a thread: reply count, last reply and who replied', () => {
    const replies = [message('r1', 'x', 1), message('r2', 'y', 2), message('r3', 'x', 3)]
    assert.deepStrictEqual(summaryOf(replies), { count: 3, lastAt: 3, replierIds: ['x', 'y'] })
    assert.isNull(summaryOf([]))
  })

  it.effect('keeps thread replies with their message and out of the channel list', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const parent = yield* workspace.postMessage('ch_general', 'Thoughts?', 'mem_avery')
      const reply = yield* workspace.postMessage('ch_general', 'Yes', 'mem_blake', { threadId: parent.id })
      const slice = sliceOf(yield* workspace.current, 'ch_general', 'mem_avery')
      assert.isTrue(slice.messages.some(candidate => candidate.id === reply.id))
      const avery = (yield* workspace.current).members.find(member => member.id === 'mem_avery')!
      // A reply in a thread does not make the channel unread.
      const row = navOf(yield* workspace.current, avery).channels.find(candidate => candidate.id === 'ch_general')
      assert.isFalse(row?.isUnread)
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('shows private channels only to their members and lists your conversations', () =>
    Effect.gen(function* () {
      const state = yield* Workspace.use(workspace => workspace.current)
      assert.isNull(sliceOf(state, 'ch_leads', 'mem_devon').channel)
      assert.strictEqual(sliceOf(state, 'ch_leads', 'mem_avery').channel?.name, 'leadership')
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const nav = navOf(state, avery)
      assert.include(nav.channels.map(row => row.label), 'leadership')
      assert.deepStrictEqual(nav.dms.map(row => row.label), ['Blake Okafor', 'Casey Lindqvist', 'Devon, Emery'])
      assert.strictEqual(homeChannel(state, avery), 'ch_general')
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
