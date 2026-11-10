import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'
import { initSwitcher, switcherItems, updateSwitcher } from '@/app/view/switcher'

import { workspaceLayer } from './support'

describe('quick switcher', () => {
  it.effect('lists your conversations, people and a search row', () =>
    Effect.gen(function* () {
      const state = yield* Effect.flatMap(Workspace, workspace => workspace.current)
      const me = state.members.find(member => member.id === 'mem_avery')!
      const casey = state.members.find(member => member.id === 'mem_casey')!
      const nav = navOf(state, me)
      const all = switcherItems('', nav, state.members, me)
      assert.isTrue(all.length > 0 && all.every(item => item.kind !== 'search' && item.kind !== 'person'))
      const general = switcherItems('#gen', nav, state.members, me)
      assert.deepStrictEqual(general.map(item => item.href), ['/client/ch_general', '/search?q=%23gen'])
      // Private channels only for members.
      assert.isTrue(switcherItems('leader', nav, state.members, me).some(item => item.id === 'ch_leads'))
      assert.isFalse(switcherItems('leader', navOf(state, casey), state.members, casey).some(item => item.id === 'ch_leads'))
      // Someone you have a DM with shows as that DM, not twice.
      const blake = switcherItems('blake', nav, state.members, me).filter(item => item.kind !== 'search')
      assert.isTrue(blake.some(item => item.kind === 'dm' && item.label === 'Blake Okafor'))
      assert.isFalse(blake.some(item => item.kind === 'person' && item.id === 'mem_blake'))
      assert.isFalse(switcherItems('avery', nav, state.members, me).some(item => item.kind === 'person'))
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('opens, moves, picks and closes', () =>
    Effect.gen(function* () {
      const state = yield* Effect.flatMap(Workspace, workspace => workspace.current)
      const me = state.members.find(member => member.id === 'mem_avery')!
      const nav = navOf(state, me)
      const items = (query: string) => switcherItems(query, nav, state.members, me)
      const closed = initSwitcher()
      assert.strictEqual(updateSwitcher(closed, { _tag: 'ChangedQuery', text: 'x' }, items).switcher.query, '')
      assert.deepStrictEqual(updateSwitcher(closed, { _tag: 'ClickedItem', index: 0 }, items).commands, [])
      const open = updateSwitcher(closed, { _tag: 'Toggled' }, items).switcher
      assert.isTrue(open.dialog.isOpen)
      const typed = updateSwitcher(open, { _tag: 'ChangedQuery', text: 'gen' }, items).switcher
      assert.strictEqual(updateSwitcher(typed, { _tag: 'Moved', by: 1 }, items).switcher.active, 1)
      assert.strictEqual(updateSwitcher(typed, { _tag: 'Moved', by: -1 }, items).switcher.active, items('gen').length - 1)
      assert.deepStrictEqual(updateSwitcher(typed, { _tag: 'PressedEnter', targetId: 'composer' }, items).commands, [])
      const picked = updateSwitcher(typed, { _tag: 'PressedEnter', targetId: 'switcher-input' }, items)
      assert.isFalse(picked.switcher.dialog.isOpen)
      assert.strictEqual(picked.switcher.query, '')
      assert.isTrue(picked.commands.some(command => command.name === 'SwitchTo'))
      assert.deepStrictEqual(updateSwitcher(typed, { _tag: 'ClickedItem', index: 99 }, items).commands, [])
      assert.isFalse(updateSwitcher(open, { _tag: 'Toggled' }, items).switcher.dialog.isOpen)
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
