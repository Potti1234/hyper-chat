import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'

import { init as peopleInit, peopleOf, update as peopleUpdate } from '@/app/people/page'
import { clearAt, isPaused, localTime, statusOf, untilLabel } from '@/app/profile'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

const NOON_BERLIN = Date.UTC(2026, 10, 9, 11, 0)

describe('profiles, status and people', () => {
  it('works out when a status clears and how it reads', () => {
    assert.strictEqual(clearAt('never', NOON_BERLIN, 'Europe/Berlin'), 0)
    assert.strictEqual(clearAt('30m', NOON_BERLIN, 'Europe/Berlin'), NOON_BERLIN + 30 * 60_000)
    assert.strictEqual(clearAt('today', NOON_BERLIN, 'Europe/Berlin'), Date.UTC(2026, 10, 9, 23, 0))
    assert.strictEqual(clearAt('today', NOON_BERLIN, 'Asia/Tokyo'), Date.UTC(2026, 10, 9, 15, 0))
    assert.isAbove(clearAt('week', NOON_BERLIN, 'Europe/Berlin'), clearAt('today', NOON_BERLIN, 'Europe/Berlin'))
    assert.strictEqual(untilLabel(NOON_BERLIN + 60 * 60_000, NOON_BERLIN, 'Europe/Berlin'), 'until 1:00 PM')
    assert.match(untilLabel(NOON_BERLIN + 3 * 86_400_000, NOON_BERLIN, 'Europe/Berlin'), /^until Thu /)
  })

  it.effect('edits a profile, sets and clears a status and pauses notifications', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const saved = yield* workspace.updateProfile('mem_avery', { name: ' Avery F. ', title: 'Head of Product', pronouns: 'she/her', timeZone: 'Asia/Tokyo' })
      assert.strictEqual(saved.name, 'Avery F.')
      assert.strictEqual(saved.pronouns, 'she/her')
      assert.strictEqual(localTime(saved, NOON_BERLIN), '8:00 PM')
      const bad = yield* Effect.exit(workspace.updateProfile('mem_avery', { name: ' ', title: '', pronouns: '', timeZone: 'Asia/Tokyo' }))
      assert.isTrue(Exit.isFailure(bad))
      const badZone = yield* Effect.exit(workspace.updateProfile('mem_avery', { name: 'Avery', title: '', pronouns: '', timeZone: 'Mars/Olympus' }))
      assert.isTrue(Exit.isFailure(badZone))

      yield* workspace.setStatus('mem_avery', { emoji: '', text: 'Heads down', until: NOON_BERLIN + 60_000 })
      let me = yield* workspace.member('mem_avery')
      assert.deepStrictEqual(statusOf(me, NOON_BERLIN), { emoji: '💬', text: 'Heads down', until: NOON_BERLIN + 60_000 })
      assert.isUndefined(statusOf(me, NOON_BERLIN + 60_000))
      const badEmoji = yield* Effect.exit(workspace.setStatus('mem_avery', { emoji: 'x', text: 'Hi', until: 0 }))
      assert.isTrue(Exit.isFailure(badEmoji))
      yield* workspace.setStatus('mem_avery', { emoji: '', text: '  ', until: 0 })
      me = yield* workspace.member('mem_avery')
      assert.isUndefined(me?.status)

      yield* workspace.setPaused('mem_avery', NOON_BERLIN + 60_000)
      me = yield* workspace.member('mem_avery')
      assert.isTrue(isPaused(me, NOON_BERLIN))
      assert.isFalse(isPaused(me, NOON_BERLIN + 60_000))
      yield* workspace.setPaused('mem_avery', 0)
      me = yield* workspace.member('mem_avery')
      assert.isUndefined(me?.pausedUntil)
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('filters the directory and only lets you edit your own profile', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      assert.deepStrictEqual(peopleOf(state.members, 'engineer').map(member => member.id).sort(), state.members.filter(member => member.title.toLowerCase().includes('engineer')).map(member => member.id).sort())
      assert.deepStrictEqual(peopleOf(state.members, 'avery product').map(member => member.id), ['mem_avery'])
      const flags = { me: avery, members: state.members, online: [], nav: navOf(state, avery), now: NOON_BERLIN }
      const theirs = peopleInit({ ...flags, personId: 'mem_blake' }).model
      assert.isFalse(peopleUpdate(theirs, { _tag: 'ClickedEditProfile' }).model.edit.isOpen)
      assert.isFalse(peopleUpdate(theirs, { _tag: 'ClickedSetStatus' }).model.status.isOpen)
      const mine = peopleInit({ ...flags, personId: 'mem_avery' }).model
      const editing = peopleUpdate(mine, { _tag: 'ClickedEditProfile' }).model
      assert.isTrue(editing.edit.isOpen)
      assert.strictEqual(peopleUpdate(editing, { _tag: 'PickedTimeZone', zone: 'Nowhere/City' }).model.profile.timeZone, editing.profile.timeZone)
      const blank = peopleUpdate(editing, { _tag: 'ChangedProfile', field: 'name', text: '' }).model
      assert.isUndefined(peopleUpdate(blank, { _tag: 'SubmittedProfile' }).commands)
      const saving = peopleUpdate(editing, { _tag: 'SubmittedProfile' })
      assert.strictEqual(saving.commands?.[0]?.name, 'UpdateProfile')
      const status = peopleUpdate(mine, { _tag: 'ClickedSetStatus' }).model
      const preset = peopleUpdate(status, { _tag: 'PickedPreset', index: 0 }).model
      assert.strictEqual(preset.statusForm.text, 'In a meeting')
      assert.strictEqual(peopleUpdate(preset, { _tag: 'PickedStatusEmoji', emoji: 'nope' }).model.statusForm.emoji, preset.statusForm.emoji)
      assert.strictEqual(peopleUpdate(preset, { _tag: 'SubmittedStatus' }).commands?.[0]?.name, 'SetStatus')
      assert.isUndefined(peopleUpdate(mine, { _tag: 'ClickedPause', minutes: 7 }).commands)
      assert.strictEqual(peopleUpdate(mine, { _tag: 'ClickedPause', minutes: 30 }).commands?.[0]?.name, 'SetPaused')
    }).pipe(Effect.provide(workspaceLayer())))
})

describe('presence', () => {
  it.effect('shows someone as active while a page of theirs is connected', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      assert.deepStrictEqual((yield* workspace.current).online, [])
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      yield* Scope.provide(workspace.connect('mem_blake'), first)
      yield* Scope.provide(workspace.connect('mem_blake'), second)
      const state = yield* workspace.current
      assert.deepStrictEqual(state.online, ['mem_blake'])
      const avery = state.members.find(member => member.id === 'mem_avery')!
      assert.isTrue(navOf(state, avery).dms.find(row => row.partnerIds.join() === 'mem_blake')?.isOnline)
      yield* Scope.close(first, Exit.void)
      assert.deepStrictEqual((yield* workspace.current).online, ['mem_blake'])
      yield* Scope.close(second, Exit.void)
      assert.deepStrictEqual((yield* workspace.current).online, [])
    }).pipe(Effect.provide(workspaceLayer())))
})
