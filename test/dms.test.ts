import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { type Model, dmsOf, existingOf, suggestionsOf, update } from '@/app/dms/page'
import { Workspace } from '@/app/store'
import { initSwitcher } from '@/app/view/switcher'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('direct messages', () => {
  it.effect('open the one conversation each set of people has, starting it if needed', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const existing = yield* workspace.openConversation(['mem_blake'], 'mem_avery')
      assert.strictEqual(existing.id, 'dm_avery_blake')
      const group = yield* workspace.openConversation(['mem_emery', 'mem_devon', 'mem_avery'], 'mem_avery')
      assert.strictEqual(group.id, 'dm_avery_devon_emery')
      const fresh = yield* workspace.openConversation(['mem_blake', 'mem_frankie'], 'mem_avery')
      assert.strictEqual(fresh.kind, 'dm')
      assert.sameMembers([...fresh.memberIds], ['mem_avery', 'mem_blake', 'mem_frankie'])
      const again = yield* workspace.openConversation(['mem_frankie', 'mem_blake'], 'mem_avery')
      assert.strictEqual(again.id, fresh.id)
      const notes = yield* workspace.openConversation([], 'mem_avery')
      assert.deepStrictEqual(notes.memberIds, ['mem_avery'])
      const stranger = yield* Effect.flip(workspace.openConversation(['mem_nobody'], 'mem_avery'))
      assert.strictEqual(stranger.reason, 'Pick people from your workspace.')
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('are listed newest first, with the last message, and only for their members', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* workspace.postMessage('dm_avery_casey', 'Newest', 'mem_avery')
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const rows = dmsOf(state, avery)
      assert.strictEqual(rows[0]?.id, 'dm_avery_casey')
      assert.deepStrictEqual(rows[0]?.last && { authorId: rows[0].last.authorId, text: rows[0].last.text }, { authorId: 'mem_avery', text: 'Newest' })
      const frankie = state.members.find(member => member.id === 'mem_frankie')!
      assert.deepStrictEqual(dmsOf(state, frankie), [])
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('pick people in the To field and send the first message', () =>
    Effect.gen(function* () {
      const state = yield* Effect.flatMap(Workspace, workspace => workspace.current)
      const me = state.members.find(member => member.id === 'mem_avery')!
      const nav = navOf(state, me)
      const model: Model = { me, members: state.members, dms: dmsOf(state, me, nav), nav, now: 0, filter: '', to: [], toQuery: 'bla', toActive: 0, draft: '', isSending: false, notice: null, switcher: initSwitcher(), isConnected: false }
      assert.deepStrictEqual(suggestionsOf(model).map(member => member.id), ['mem_blake'])
      const picked = update(model, { _tag: 'PressedKey', key: 'Enter', targetId: 'to-input' }).model
      assert.deepStrictEqual(picked.to, ['mem_blake'])
      assert.strictEqual(picked.toQuery, '')
      assert.strictEqual(existingOf(picked)?.id, 'dm_avery_blake')
      assert.deepStrictEqual(update(picked, { _tag: 'ClickedPerson', memberId: 'mem_nobody' }).model.to, ['mem_blake'])
      const empty = update(picked, { _tag: 'SubmittedMessage' })
      assert.isUndefined(empty.commands)
      const sending = update({ ...picked, draft: 'Hi' }, { _tag: 'SubmittedMessage' })
      assert.isTrue(sending.model.isSending)
      assert.strictEqual(sending.commands?.length, 1)
      assert.deepStrictEqual(update(picked, { _tag: 'PressedKey', key: 'Backspace', targetId: 'to-input' }).model.to, [])
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
