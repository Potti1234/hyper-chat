import { assert, describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'

import { typingText } from '@/app/client/page'
import { Workspace } from '@/app/store'
import { TYPING_MS, applyTyping, decodeEvent, typingIn } from '@/app/typing'

import { workspaceLayer } from './support'

describe('typing', () => {
  it('words it as Slack does', () => {
    assert.strictEqual(typingText([]), '')
    assert.strictEqual(typingText(['Blake']), 'Blake is typing…')
    assert.strictEqual(typingText(['Blake', 'Casey']), 'Blake and Casey are typing…')
    assert.strictEqual(typingText(['Blake', 'Casey', 'Devon']), 'Several people are typing…')
  })

  it('keeps one entry per person and conversation, and shows others only', () => {
    const one = applyTyping([], { memberId: 'b', channelId: 'c', at: 0, isTyping: true })
    const again = applyTyping(one, { memberId: 'b', channelId: 'c', at: 10, isTyping: true })
    assert.deepStrictEqual(again, [{ memberId: 'b', channelId: 'c', until: 10 + TYPING_MS }])
    assert.deepStrictEqual(typingIn(again, 'c', 'a'), ['b'])
    assert.deepStrictEqual(typingIn(again, 'c', 'b'), [])
    assert.deepStrictEqual(applyTyping(again, { memberId: 'b', channelId: 'c', at: 20, isTyping: false }), [])
  })

  it('ignores payloads that are not typing events', () => {
    assert.isUndefined(decodeEvent('nope'))
    assert.isUndefined(decodeEvent('{"memberId":1}'))
    assert.deepStrictEqual(decodeEvent('{"memberId":"b","channelId":"c","at":1,"isTyping":true}'), { memberId: 'b', channelId: 'c', at: 1, isTyping: true })
  })

  it.effect('reaches other pages and ends when you stop', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* workspace.setTyping('mem_blake', 'ch_general', true)
      const typing = yield* workspace.typing.pipe(Stream.map(typists => typingIn(typists, 'ch_general', 'mem_avery')), Stream.runHead)
      assert.deepStrictEqual(typing._tag === 'Some' ? typing.value : [], ['mem_blake'])
      yield* workspace.setTyping('mem_blake', 'ch_general', false)
      const after = yield* workspace.typing.pipe(Stream.runHead)
      assert.deepStrictEqual(after._tag === 'Some' ? after.value : null, [])
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
