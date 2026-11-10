import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { channelLinkTarget, permalinkTarget } from '@/app/links'
import { parseInline, plainText } from '@/app/mrkdwn'
import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

describe('channel links', () => {
  it('parses #channel after a space or at the start', () => {
    assert.deepStrictEqual(parseInline('see #general, not a#b or #'), [
      { kind: 'text', text: 'see ' },
      { kind: 'channel', name: 'general' },
      { kind: 'text', text: ', not a#b or #' },
    ])
    assert.deepStrictEqual(parseInline('(#Design-Team)'), [{ kind: 'text', text: '(' }, { kind: 'channel', name: 'design-team' }, { kind: 'text', text: ')' }])
    assert.strictEqual(plainText('in #random today'), 'in #random today')
  })

  it.effect('open a channel the reader can see, else the browser', () =>
    Effect.gen(function* () {
      const state = yield* Workspace.use(workspace => workspace.current)
      assert.strictEqual(channelLinkTarget(state, 'mem_casey', '#general'), '/client/ch_general')
      assert.strictEqual(channelLinkTarget(state, 'mem_avery', 'leadership'), '/client/ch_leads')
      assert.strictEqual(channelLinkTarget(state, 'mem_casey', 'leadership'), '/channels')
      assert.strictEqual(channelLinkTarget(state, 'mem_casey', 'nowhere'), '/channels')
    }).pipe(Effect.provide(workspaceLayer())),
  )
})

describe('message permalinks', () => {
  it.effect('lead to the message, its thread, or nowhere', () =>
    Effect.gen(function* () {
      const state = yield* Workspace.use(workspace => workspace.current)
      const root = state.messages.find(message => message.threadId === null && message.channelId === 'ch_general')!
      const reply = state.messages.find(message => message.threadId !== null)!
      assert.strictEqual(permalinkTarget(state, 'mem_casey', 'ch_general', root.id), `/client/ch_general#message-${root.id}`)
      assert.strictEqual(permalinkTarget(state, 'mem_avery', reply.channelId, reply.id), `/client/${reply.channelId}/thread/${reply.threadId}#thread-message-${reply.id}`)
      assert.isUndefined(permalinkTarget(state, 'mem_casey', 'ch_random', root.id))
      const secret = state.messages.find(message => message.channelId === 'ch_leads')
      if (secret !== undefined) assert.isUndefined(permalinkTarget(state, 'mem_casey', 'ch_leads', secret.id))
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
