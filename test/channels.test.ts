import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { type Model as ChannelsModel, channelsOf, init as channelsInit, shownOf, update as channelsUpdate } from '@/app/channels/page'
import { init as clientInit, sliceOf, update as clientUpdate } from '@/app/client/page'
import { channelSlug } from '@/app/domain'
import { Workspace } from '@/app/store'
import { navOf } from '@/app/view/shell'

import { workspaceLayer } from './support'

describe('channel management', () => {
  it('turns typed names into channel names', () => {
    assert.strictEqual(channelSlug('  #Plan Budget 2027! '), 'plan-budget-2027')
    assert.strictEqual(channelSlug('Ünïcode_ok'), 'ünïcode_ok')
    assert.strictEqual(channelSlug('...'), '')
  })

  it.effect('creates public and private channels with you as the first member', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const open = yield* workspace.createChannel({ name: 'Plan Budget', isPrivate: false, description: ' Money ' }, 'mem_avery')
      assert.deepStrictEqual([open.name, open.kind, open.description, open.memberIds], ['plan-budget', 'public', 'Money', ['mem_avery']])
      const secret = yield* workspace.createChannel({ name: 'offsite', isPrivate: true, description: '' }, 'mem_avery')
      assert.strictEqual(secret.kind, 'private')
      const taken = yield* Effect.flip(workspace.createChannel({ name: '#Random', isPrivate: false, description: '' }, 'mem_blake'))
      assert.strictEqual(taken.reason, '#random already exists. Pick another name.')
      const empty = yield* Effect.flip(workspace.createChannel({ name: '!!', isPrivate: false, description: '' }, 'mem_blake'))
      assert.strictEqual(empty.reason, 'Give the channel a name.')
      const long = yield* Effect.flip(workspace.createChannel({ name: 'x'.repeat(81), isPrivate: false, description: '' }, 'mem_blake'))
      assert.match(long.reason, /under 80/)
      const stranger = yield* Effect.flip(workspace.createChannel({ name: 'mine', isPrivate: false, description: '' }, 'mem_nobody'))
      assert.strictEqual(stranger.reason, 'Sign in again to create channels.')
      const state = yield* workspace.current
      const blake = state.members.find(member => member.id === 'mem_blake')!
      const names = channelsOf(state, blake).map(row => row.name)
      assert.include(names, 'plan-budget')
      assert.notInclude(names, 'offsite')
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('joins public channels, never private ones, and leaves any but #general', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const joined = yield* workspace.joinChannel('ch_eng', 'mem_avery')
      assert.include(joined.memberIds, 'mem_avery')
      const again = yield* workspace.joinChannel('ch_eng', 'mem_avery')
      assert.strictEqual(again.memberIds.filter(id => id === 'mem_avery').length, 1)
      const hidden = yield* Effect.flip(workspace.joinChannel('ch_leads', 'mem_casey'))
      assert.strictEqual(hidden.reason, 'That channel does not exist.')
      const dm = yield* Effect.flip(workspace.joinChannel('dm_avery_blake', 'mem_casey'))
      assert.strictEqual(dm.reason, 'That channel does not exist.')
      yield* workspace.leaveChannel('ch_eng', 'mem_avery')
      const general = yield* Effect.flip(workspace.leaveChannel('ch_general', 'mem_avery'))
      assert.strictEqual(general.reason, 'Everyone stays in #general.')
      const state = yield* workspace.current
      assert.notInclude(state.channels.find(channel => channel.id === 'ch_eng')!.memberIds, 'mem_avery')
      yield* workspace.leaveChannel('ch_leads', 'mem_blake')
      const after = yield* workspace.current
      const blake = after.members.find(member => member.id === 'mem_blake')!
      assert.notInclude(navOf(after, blake).channels.map(row => row.id), 'ch_leads')
      const back = yield* Effect.flip(workspace.joinChannel('ch_leads', 'mem_blake'))
      assert.strictEqual(back.reason, 'That channel does not exist.')
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('lets members add people, edit details and archive', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const added = yield* workspace.addToChannel('ch_leads', ['mem_casey', 'mem_casey', 'mem_avery'], 'mem_avery')
      assert.deepStrictEqual(added.memberIds.filter(id => id === 'mem_casey' || id === 'mem_avery'), ['mem_avery', 'mem_casey'])
      const outsider = yield* Effect.flip(workspace.addToChannel('ch_eng', ['mem_casey'], 'mem_avery'))
      assert.strictEqual(outsider.reason, 'Join #engineering to add people to it.')
      const unknown = yield* Effect.flip(workspace.addToChannel('ch_leads', ['mem_nobody'], 'mem_avery'))
      assert.strictEqual(unknown.reason, 'Pick people from your workspace.')
      const renamed = yield* workspace.updateChannel('ch_design', { name: 'Design Review', topic: ' Fridays ' }, 'mem_avery')
      assert.deepStrictEqual([renamed.name, renamed.topic, renamed.description], ['design-review', 'Fridays', 'Weekly crit on Thursdays at 2 PM.'])
      const before = yield* workspace.current
      const same = yield* workspace.updateChannel('ch_design', { topic: 'Fridays' }, 'mem_avery')
      assert.strictEqual(same, before.channels.find(channel => channel.id === 'ch_design'))
      const clash = yield* Effect.flip(workspace.updateChannel('ch_design', { name: 'random' }, 'mem_avery'))
      assert.strictEqual(clash.reason, '#random already exists. Pick another name.')
      const general = yield* Effect.flip(workspace.updateChannel('ch_general', { name: 'everyone' }, 'mem_avery'))
      assert.strictEqual(general.reason, '#general keeps its name.')
      const topic = yield* workspace.updateChannel('ch_general', { topic: 'Hello' }, 'mem_avery')
      assert.strictEqual(topic.topic, 'Hello')
      const notMine = yield* Effect.flip(workspace.updateChannel('ch_eng', { topic: 'Mine' }, 'mem_avery'))
      assert.strictEqual(notMine.reason, 'Join #engineering to edit it.')
      const tooLong = yield* Effect.flip(workspace.updateChannel('ch_design', { topic: 'x'.repeat(251) }, 'mem_avery'))
      assert.match(tooLong.reason, /topic under 250/)
      yield* workspace.setArchived('ch_design', true, 'mem_avery')
      const archived = yield* workspace.current
      const avery = archived.members.find(member => member.id === 'mem_avery')!
      assert.notInclude(navOf(archived, avery).channels.map(row => row.id), 'ch_design')
      const closed = yield* Effect.flip(workspace.postMessage('ch_design', 'Hi', 'mem_avery'))
      assert.isString(closed.reason)
      const frozen = yield* Effect.flip(workspace.updateChannel('ch_design', { topic: 'x' }, 'mem_avery'))
      assert.strictEqual(frozen.reason, 'This channel is archived.')
      yield* workspace.setArchived('ch_design', false, 'mem_avery')
      const generalArchive = yield* Effect.flip(workspace.setArchived('ch_general', true, 'mem_avery'))
      assert.strictEqual(generalArchive.reason, '#general cannot be archived.')
    }).pipe(Effect.provide(workspaceLayer())),
  )

  it.effect('the channel browser filters, joins only public channels and checks names before creating', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const casey = state.members.find(member => member.id === 'mem_casey')!
      const { model } = channelsInit({ me: casey, rows: channelsOf(state, casey), nav: navOf(state, casey), members: state.members, isCreating: false })
      assert.notInclude(model.rows.map(row => row.id), 'ch_leads')
      const filtered: ChannelsModel = { ...model, filter: 'eng' }
      assert.deepStrictEqual(shownOf(filtered).map(row => row.name), ['engineering'])
      assert.isTrue(shownOf({ ...model, show: 'mine' }).every(row => row.isMember))
      const join = channelsUpdate(model, { _tag: 'ClickedJoin', channelId: 'ch_eng' })
      assert.strictEqual(join.model.pending, 'ch_eng')
      assert.strictEqual(join.commands?.[0]?.name, 'JoinChannel')
      assert.isUndefined(channelsUpdate(model, { _tag: 'ClickedJoin', channelId: 'ch_leads' }).commands)
      assert.strictEqual(channelsUpdate(model, { _tag: 'ClickedLeave', channelId: 'ch_general' }).model.notice, 'Everyone stays in #general.')
      const opened = channelsInit({ me: casey, rows: model.rows, nav: model.nav, members: state.members, isCreating: true }).model
      assert.isTrue(opened.create.isOpen)
      const taken = channelsUpdate({ ...opened, form: { ...opened.form, name: 'Random' } }, { _tag: 'SubmittedCreate' })
      assert.strictEqual(taken.model.notice, '#random already exists. Pick another name.')
      const fresh = channelsUpdate({ ...opened, form: { ...opened.form, name: 'New Thing', isPrivate: true } }, { _tag: 'SubmittedCreate' })
      assert.strictEqual(fresh.commands?.[0]?.name, 'CreateChannel')
      assert.deepInclude(fresh.commands?.[0]?.args, { name: 'new-thing', isPrivate: true })
      assert.isUndefined(channelsUpdate(model, { _tag: 'SubmittedCreate' }).commands)
    }).pipe(Effect.provide(workspaceLayer())),
  )
  it.effect('the conversation page offers Join to visitors and edits details only for members', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const state = yield* workspace.current
      const modelFor = (memberId: string, channelId: string) => {
        const me = state.members.find(member => member.id === memberId)!
        const slice = sliceOf(state, channelId, memberId)
        return clientInit({ me, channelId, channel: slice.channel!, members: slice.members, messages: slice.messages, older: slice.older, pins: slice.pins, saved: slice.saved, nav: slice.nav, now: 0, readMarker: 0, threadId: null }).model
      }
      const visitor = modelFor('mem_avery', 'ch_eng')
      const join = clientUpdate(visitor, { _tag: 'ClickedJoin' })
      assert.isTrue(join.model.isJoining)
      assert.strictEqual(join.commands?.[0]?.name, 'JoinChannel')
      const details = clientUpdate(visitor, { _tag: 'ClickedOpenDetails', tab: 'about', field: 'topic' })
      assert.isTrue(details.model.details.isOpen)
      assert.isNull(details.model.about.field)
      assert.isUndefined(clientUpdate(visitor, { _tag: 'ClickedLeave' }).commands?.find(command => command.name === 'LeaveChannel'))
      const member = modelFor('mem_avery', 'ch_design')
      const editing = clientUpdate(member, { _tag: 'ClickedOpenDetails', tab: 'about', field: 'topic' }).model
      assert.deepInclude(editing.about, { field: 'topic', value: 'Share work in progress, get feedback' })
      const typed = clientUpdate(editing, { _tag: 'ChangedField', text: 'Fridays' }).model
      const saved = clientUpdate(typed, { _tag: 'SubmittedField' })
      assert.deepInclude(saved.commands?.[0]?.args, { channelId: 'ch_design', field: 'topic', value: 'Fridays' })
      const general = modelFor('mem_avery', 'ch_general')
      const rename = clientUpdate(general, { _tag: 'ClickedOpenDetails', tab: 'about', field: 'name' }).model
      assert.isNull(rename.about.field)
      assert.isUndefined(clientUpdate(general, { _tag: 'ClickedArchive', isArchived: true }).commands)
      const people = clientUpdate(member, { _tag: 'ClickedAddPerson', memberId: 'mem_harper' })
      assert.strictEqual(people.commands?.[0]?.name, 'AddToChannel')
      assert.isUndefined(clientUpdate(member, { _tag: 'ClickedAddPerson', memberId: 'mem_nobody' }).commands)
    }).pipe(Effect.provide(workspaceLayer())),
  )
})
