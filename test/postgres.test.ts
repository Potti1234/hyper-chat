import { assert, describe, it } from '@effect/vitest'
import { Context, Effect, Layer, Stream } from 'effect'
import { SqlClient } from 'effect/sql'

import * as Postgres from '@/app/postgres'
import { demoData } from '@/app/seed'
import { Workspace } from '@/app/store'

/* The workspace in Postgres, against a throwaway database:

     TEST_DATABASE_URL=postgres://hyperchat:hyperchat-dev@localhost:5435/hyperchat_test npm test

   (`npm run test:pg` creates that database and runs this.) Two stores on one
   database stand for two app processes: a change one makes reaches the other
   through LISTEN/NOTIFY. Skipped without TEST_DATABASE_URL. */

const url = process.env['TEST_DATABASE_URL']

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE IF EXISTS workspace_meta, members, channels, messages, reads, saves, passwords CASCADE`
}).pipe(Effect.provide(Postgres.clientLayerFor(url ?? '')))

/** One store, as one app process would build it. */
const store = Effect.map(Layer.build(Postgres.layer.pipe(Layer.provide(Postgres.clientLayerFor(url ?? '')))), context => Context.get(context, Workspace))

describe.skipIf(url === undefined)('workspace in Postgres', () => {
  it.live('delivers messages, threads, edits, reactions, reads, saves, pins and deletes to another process', () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* reset
        const one = yield* store
        yield* one.seedDemo(demoData(Date.UTC(2026, 10, 9, 12)))
        const two = yield* store
        const before = yield* two.current
        assert.isTrue(before.messages.some(message => message.threadId !== null))
        const message = yield* one.postMessage('ch_general', 'Persisted', 'mem_avery')
        const reply = yield* one.postMessage('ch_general', 'In the thread', 'mem_blake', { threadId: message.id, alsoInChannel: true })
        yield* one.editMessage(message.id, 'Persisted and edited', 'mem_avery')
        yield* one.toggleReaction(message.id, '🎉', 'mem_casey') // eslint-disable-line crease/no-native-glyphs -- reaction content
        yield* one.markRead('ch_general', 'mem_casey')
        yield* one.toggleSaved(message.id, 'mem_casey')
        yield* one.setSavedState(message.id, 'mem_casey', 'done')
        yield* one.togglePin(message.id, 'mem_blake')
        yield* one.updateProfile('mem_casey', { name: 'Casey Lindqvist', title: 'Design Lead', pronouns: 'they/them', timeZone: 'Asia/Tokyo' })
        yield* one.setStatus('mem_casey', { emoji: '', text: 'Sketching', until: 0 })
        yield* one.setPaused('mem_casey', Date.now() + 3_600_000)
        yield* two.changes.pipe(
          Stream.filter(state => state.messages.some(item => item.id === message.id && item.text === 'Persisted and edited' && item.reactions.length === 1 && item.pinnedBy === 'mem_blake') && state.saves.some(saved => saved.messageId === message.id && saved.state === 'done') && state.messages.some(item => item.id === reply.id) && state.members.some(member => member.id === 'mem_casey' && member.pausedUntil !== undefined)),
          Stream.runHead,
          Effect.timeout('5 seconds'),
        )
        const after = yield* two.current
        const stored = after.messages.find(item => item.threadId === message.id)
        assert.isTrue(stored?.alsoInChannel)
        assert.strictEqual(after.messages.find(item => item.id === message.id)?.reactions[0]?.memberIds[0], 'mem_casey')
        assert.isTrue(after.reads.some(read => read.memberId === 'mem_casey' && read.channelId === 'ch_general'))
        const restarted = yield* (yield* store).current
        assert.strictEqual(restarted.messages.find(item => item.id === message.id)?.pinnedBy, 'mem_blake')
        const casey = restarted.members.find(member => member.id === 'mem_casey')
        assert.deepStrictEqual([casey?.title, casey?.pronouns, casey?.timeZone, casey?.status?.text], ['Design Lead', 'they/them', 'Asia/Tokyo', 'Sketching'])
        assert.isAbove(casey?.pausedUntil ?? 0, 0)
        assert.isTrue(restarted.saves.some(saved => saved.memberId === 'mem_casey' && saved.messageId === message.id && saved.state === 'done'))
        yield* one.deleteMessage(message.id, 'mem_avery')
        yield* two.changes.pipe(Stream.filter(state => !state.messages.some(item => item.id === message.id || item.id === reply.id)), Stream.runHead, Effect.timeout('5 seconds'))
        // A third process starting now reads the same workspace from the tables.
        const three = yield* store
        const fresh = yield* three.current
        assert.strictEqual(fresh.messages.length, (yield* two.current).messages.length)
        assert.isFalse(fresh.messages.some(item => item.id === reply.id))
        assert.isFalse(fresh.saves.some(saved => saved.messageId === message.id))
      }),
    ),
  )
})
