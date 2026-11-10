import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'

import { DEFAULT_PREFERENCES, dayLabel, dayOf, formatTime, preferencesOf } from '@/app/domain'
import { init, update } from '@/app/preferences/page'
import { SIDEBAR_THEMES, isSidebarSlug } from '@/app/preferences'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

const LATE_BERLIN = Date.UTC(2026, 10, 9, 22, 30) // 23:30 in Berlin, 07:30 the next day in Tokyo

describe('preferences', () => {
  it('formats times and days for the viewer', () => {
    const berlin = { timeZone: 'Europe/Berlin' }
    assert.strictEqual(formatTime(LATE_BERLIN, berlin), '11:30 PM')
    assert.strictEqual(formatTime(LATE_BERLIN, { ...berlin, preferences: { ...DEFAULT_PREFERENCES, is24Hour: true } }), '23:30')
    assert.strictEqual(formatTime(LATE_BERLIN, { timeZone: 'Asia/Tokyo', preferences: { ...DEFAULT_PREFERENCES, is24Hour: true } }), '07:30')
    assert.notStrictEqual(dayOf(LATE_BERLIN, berlin), dayOf(LATE_BERLIN, { timeZone: 'Asia/Tokyo' }))
    assert.strictEqual(dayLabel(LATE_BERLIN, LATE_BERLIN, berlin), 'Today')
    assert.deepStrictEqual(preferencesOf(undefined), DEFAULT_PREFERENCES)
  })

  it('knows the sidebar themes', () => {
    assert.isTrue(SIDEBAR_THEMES.every(theme => isSidebarSlug(theme.slug)))
    assert.isTrue(isSidebarSlug(''))
    assert.isFalse(isSidebarSlug('neon'))
  })

  it.effect('stores choices and refuses unknown themes', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const before = yield* workspace.member('mem_avery')
      assert.deepStrictEqual(preferencesOf(before), DEFAULT_PREFERENCES)
      yield* workspace.setPreferences('mem_avery', { sidebar: 'jade', isCompact: true, is24Hour: false })
      const after = yield* workspace.member('mem_avery')
      assert.deepStrictEqual(after?.preferences, { sidebar: 'jade', isCompact: true, is24Hour: false })
      yield* workspace.setPreferences('mem_avery', { sidebar: 'jade', isCompact: true, is24Hour: false })
      assert.strictEqual(yield* workspace.member('mem_avery'), after)
      const bad = yield* Effect.exit(workspace.setPreferences('mem_avery', { sidebar: 'neon', isCompact: false, is24Hour: false }))
      assert.isTrue(Exit.isFailure(bad))
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('the page shows a choice at once and checks what the browser posts', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const me = state.members.find(member => member.id === 'mem_avery')
      if (me === undefined) return assert.fail('no Avery')
      const { model } = init({ me, members: state.members, nav: navOf(state, me), now: LATE_BERLIN })
      const picked = update(model, { _tag: 'ClickedSidebar', slug: 'barbra' })
      assert.strictEqual(picked.model.me.preferences?.sidebar, 'barbra')
      assert.strictEqual(picked.commands?.length, 1)
      const unknown = update(model, { _tag: 'ClickedSidebar', slug: 'neon' })
      assert.strictEqual(unknown.model, model)
      assert.isUndefined(unknown.commands)
      const preset = update(model, { _tag: 'ClickedPreset', slug: 'nord' })
      assert.strictEqual(preset.model.me.theme, 'nord')
      assert.strictEqual(update(model, { _tag: 'ClickedPreset', slug: 'nope' }).model, model)
      const compact = update(model, { _tag: 'ClickedDensity', isCompact: true })
      assert.isTrue(compact.model.me.preferences?.isCompact)
      assert.strictEqual(update(compact.model, { _tag: 'ClickedDensity', isCompact: true }).model, compact.model)
    }).pipe(Effect.provide(workspaceLayer())))
})
