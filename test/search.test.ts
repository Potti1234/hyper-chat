import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { parseQuery, searchOf, withFilter } from '@/app/search'
import { init, update, urlOf } from '@/app/search/page'
import { Workspace } from '@/app/store'
import { emptyNav } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('search', () => {
  it('parses words and in:/from: filters', () => {
    assert.deepStrictEqual(parseQuery('  Launch  in:#product-launch FROM:@Avery notes '), { terms: ['launch', 'notes'], in: 'product-launch', from: 'avery' })
    assert.deepStrictEqual(parseQuery('in: from:'), { terms: [], in: null, from: null })
    assert.strictEqual(withFilter('launch in:#random', 'in', 'general'), 'launch in:#general')
    assert.strictEqual(withFilter('launch from:@blake', 'from', null), 'launch')
  })

  it.effect('finds readable messages, channels and people', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const avery = state.members.find(member => member.id === 'mem_avery')!
      const casey = state.members.find(member => member.id === 'mem_casey')!
      const launch = searchOf(state, avery, 'launch')
      assert.isAbove(launch.messages.length, 0)
      assert.isTrue(launch.messages.every(hit => hit.message.text.toLowerCase().includes('launch')))
      assert.isTrue(launch.messages.every((hit, index) => index === 0 || launch.messages[index - 1]!.message.createdAt >= hit.message.createdAt))
      assert.isTrue(launch.channels.some(channel => channel.name === 'product-launch'))
      // Private channels stay hidden from people outside them.
      assert.isAbove(searchOf(state, avery, 'candidates').messages.length, 0)
      assert.strictEqual(searchOf(state, casey, 'candidates').messages.length, 0)
      assert.isFalse(searchOf(state, casey, 'leadership').channels.some(channel => channel.id === 'ch_leads'))
      // Filters narrow messages by conversation and author.
      const inLaunch = searchOf(state, avery, 'in:#product-launch')
      assert.isAbove(inLaunch.messages.length, 0)
      assert.isTrue(inLaunch.messages.every(hit => hit.channelId === inLaunch.messages[0]!.channelId && hit.conversation === 'product-launch'))
      assert.isTrue(searchOf(state, avery, 'from:@avery').messages.every(hit => hit.message.authorId === 'mem_avery'))
      assert.deepStrictEqual(searchOf(state, avery, 'from:@avery').people, [])
      // People by name and title.
      assert.deepStrictEqual(searchOf(state, avery, 'blake').people.map(person => person.id), ['mem_blake'])
      assert.deepStrictEqual(searchOf(state, avery, '   '), { messages: [], channels: [], people: [] })
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('updates the query and address as you type', () =>
    Effect.gen(function* () {
      const state = yield* Workspace.use(workspace => workspace.current)
      const me = state.members.find(member => member.id === 'mem_avery')!
      const { model } = init({ me, members: state.members, query: '', tab: 'messages', nav: emptyNav, now: 0, messages: [], channels: [], people: [] })
      const typed = update(model, { _tag: 'ChangedQuery', text: 'launch' })
      assert.strictEqual(typed.model.query, 'launch')
      assert.deepStrictEqual(typed.commands?.map(command => command.name), ['ReplaceUrl'])
      assert.strictEqual(urlOf('launch', 'people'), '/search?q=launch&tab=people')
      const filtered = update(typed.model, { _tag: 'ClickedFilter', key: 'from', value: 'avery' })
      assert.strictEqual(filtered.model.query, 'launch from:@avery')
      assert.strictEqual(update(filtered.model, { _tag: 'ClickedFilter', key: 'from', value: null }).model.query, 'launch')
      assert.strictEqual(update(model, { _tag: 'ChangedQuery', text: 'x'.repeat(500) }).model.query.length, 200)
      assert.strictEqual(update(typed.model, { _tag: 'ClickedTab', tab: 'channels' }).model.tab, 'channels')
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
