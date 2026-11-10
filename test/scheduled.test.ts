import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import { activityOf } from '@/app/activity'
import { init as clientInit, sliceOf, update as clientUpdate } from '@/app/client/page'
import { laterOf } from '@/app/later/page'
import * as Scheduler from '@/app/scheduler'
import { Workspace } from '@/app/store'
import { whenAt, whenLabel } from '@/app/when'
import { isDue } from '@/app/workspace'

import { workspaceLayer } from './support'

const minute = 60_000

describe('scheduled messages', () => {
  it.effect('wait for their time, then post as their author', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const before = (yield* workspace.current).messages.length
      const item = yield* workspace.scheduleMessage('ch_general', '  Standup in 5  ', 'mem_avery', 30 * minute)
      assert.strictEqual(item.text, 'Standup in 5')
      assert.isFalse(isDue(yield* workspace.current, 29 * minute))
      assert.strictEqual(yield* workspace.deliverDue, 0)
      yield* TestClock.adjust('30 minutes')
      assert.isTrue(isDue(yield* workspace.current, 30 * minute))
      assert.strictEqual(yield* workspace.deliverDue, 1)
      const state = yield* workspace.current
      assert.strictEqual(state.scheduled.length, 0)
      assert.strictEqual(state.messages.length, before + 1)
      assert.deepInclude(state.messages.at(-1), { text: 'Standup in 5', authorId: 'mem_avery', channelId: 'ch_general', createdAt: 30 * minute })
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('can be sent now or cancelled, only by their author', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const one = yield* workspace.scheduleMessage('ch_general', 'one', 'mem_avery', minute)
      const two = yield* workspace.scheduleMessage('ch_general', 'two', 'mem_avery', minute)
      assert.strictEqual((yield* Effect.flip(workspace.cancelScheduled(one.id, 'mem_blake'))).reason, 'That message was sent or cancelled already.')
      const sent = yield* workspace.sendScheduledNow(one.id, 'mem_avery')
      assert.strictEqual(sent.text, 'one')
      yield* workspace.cancelScheduled(two.id, 'mem_avery')
      assert.strictEqual((yield* workspace.current).scheduled.length, 0)
      assert.strictEqual((yield* Effect.flip(workspace.sendScheduledNow(two.id, 'mem_avery'))).reason, 'That message was sent or cancelled already.')
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('are refused in the past or where you cannot write, and dropped if that changes', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* TestClock.adjust('1 minute')
      assert.strictEqual((yield* Effect.flip(workspace.scheduleMessage('ch_general', 'late', 'mem_avery', 0))).reason, 'Pick a time in the future.')
      assert.strictEqual((yield* Effect.flip(workspace.scheduleMessage('ch_general', '   ', 'mem_avery', 2 * minute))).reason.length > 0, true)
      const item = yield* workspace.scheduleMessage('ch_random', 'bye', 'mem_avery', 2 * minute)
      yield* workspace.leaveChannel('ch_random', 'mem_avery')
      yield* TestClock.adjust('1 minute')
      assert.strictEqual(yield* workspace.deliverDue, 0)
      const state = yield* workspace.current
      assert.isFalse(state.scheduled.some(candidate => candidate.id === item.id))
      assert.isFalse(state.messages.some(message => message.text === 'bye'))
    }).pipe(Effect.provide(workspaceLayer())))
})

describe('reminders', () => {
  it.effect('save the message and show in Activity once due', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Review the deck', 'mem_blake')
      yield* workspace.setReminder(message.id, 'mem_avery', 20 * minute)
      const avery = () => Effect.map(workspace.current, state => [state, state.members.find(member => member.id === 'mem_avery')!] as const)
      const reminders = () => Effect.map(avery(), ([state, me]) => activityOf(state, me).filter(item => item.kind === 'reminder'))
      let [state] = yield* avery()
      assert.deepInclude(state.saves.find(saved => saved.messageId === message.id), { state: 'saved', remindAt: 20 * minute })
      assert.strictEqual((yield* reminders()).length, 0)
      yield* TestClock.adjust('20 minutes')
      yield* workspace.deliverDue
      ;[state] = yield* avery()
      assert.isTrue(state.saves.find(saved => saved.messageId === message.id)?.reminded)
      const [item] = yield* reminders()
      assert.strictEqual(item?.message.id, message.id)
      assert.strictEqual(item?.at, 20 * minute)
      yield* workspace.setSavedState(message.id, 'mem_avery', 'done')
      assert.strictEqual((yield* reminders()).length, 0)
      ;[state] = yield* avery()
      assert.isUndefined(state.saves.find(saved => saved.messageId === message.id)?.remindAt)
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('can be removed, keeping the message saved', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const message = yield* workspace.postMessage('ch_general', 'Later', 'mem_blake')
      yield* workspace.setReminder(message.id, 'mem_avery', minute)
      yield* workspace.setReminder(message.id, 'mem_avery', null)
      const saved = (yield* workspace.current).saves.find(item => item.messageId === message.id)
      assert.strictEqual(saved?.state, 'saved')
      assert.isUndefined(saved?.remindAt)
      assert.strictEqual((yield* Effect.flip(workspace.setReminder(message.id, 'mem_avery', 0))).reason, 'Pick a time in the future.')
    }).pipe(Effect.provide(workspaceLayer())))
})

describe('when', () => {
  const me = { id: 'm', name: 'M', email: 'm@x', color: '', title: '', isDark: false, theme: '', isDemo: false, timeZone: 'Europe/Berlin' } as const
  // Monday 2026-11-09 23:00 in Berlin (22:00 UTC).
  const now = Date.UTC(2026, 10, 9, 22, 0)
  it('picks 9:00 AM tomorrow and next Monday in the member’s zone', () => {
    assert.strictEqual(whenAt('tomorrow', now, 'Europe/Berlin'), Date.UTC(2026, 10, 10, 8, 0))
    assert.strictEqual(whenAt('monday', now, 'Europe/Berlin'), Date.UTC(2026, 10, 16, 8, 0))
    assert.strictEqual(whenAt('30m', now, 'Europe/Berlin'), now + 30 * minute)
    assert.strictEqual(whenLabel(Date.UTC(2026, 10, 10, 8, 0), now, me), 'Tomorrow at 9:00 AM')
    assert.strictEqual(whenLabel(now + 30 * minute - 60 * minute, now, me), 'Today at 10:30 PM')
    assert.strictEqual(whenLabel(Date.UTC(2026, 10, 16, 8, 0), now, me), 'Monday, November 16th at 9:00 AM')
  })

  it.effect('the conversation page schedules drafts and sets reminders through commands', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* workspace.scheduleMessage('ch_general', 'later', 'mem_avery', 10 * minute)
      const state = yield* workspace.current
      const me = state.members.find(member => member.id === 'mem_avery')!
      const slice = sliceOf(state, 'ch_general', 'mem_avery')
      assert.deepStrictEqual(slice.scheduled.map(item => item.text), ['later'])
      assert.deepStrictEqual(sliceOf(state, 'ch_general', 'mem_blake').scheduled, [])
      const model = clientInit({ me, channelId: 'ch_general', channel: slice.channel!, members: slice.members, messages: slice.messages, older: slice.older, pins: slice.pins, shared: slice.shared, scheduled: slice.scheduled, saved: slice.saved, nav: slice.nav, now: 0, readMarker: 0, threadId: null }).model
      assert.isNull(clientUpdate(model, { _tag: 'ClickedScheduleMenu' }).model.overlay)
      const drafted = clientUpdate(model, { _tag: 'ChangedDraft', text: 'Ship it' }).model
      const menu = clientUpdate(drafted, { _tag: 'ClickedScheduleMenu' }).model
      assert.strictEqual(menu.overlay?.kind, 'schedule')
      const scheduled = clientUpdate(menu, { _tag: 'ClickedSchedule', choice: '1h' })
      assert.isNull(scheduled.model.overlay)
      assert.strictEqual(scheduled.commands?.[0]?.name, 'ScheduleMessage')
      assert.deepInclude(scheduled.commands?.[0]?.args, { channelId: 'ch_general', text: 'Ship it', choice: '1h' })
      const done = clientUpdate(scheduled.model, { _tag: 'SucceededSchedule', label: 'Today at 1:00 AM' }).model
      assert.strictEqual(done.draft, '')
      assert.strictEqual(done.notice, 'Your message will be sent today at 1:00 AM.')
      const messageId = slice.messages.at(-1)!.id
      const remind = clientUpdate(model, { _tag: 'ClickedRemind', messageId, choice: '20m' })
      assert.include(remind.model.saved, messageId)
      assert.strictEqual(remind.commands?.[0]?.name, 'SetReminder')
      assert.isUndefined(clientUpdate(model, { _tag: 'ClickedRemind', messageId: 'msg_nope', choice: '20m' }).commands)
      const itemId = slice.scheduled[0]!.id
      assert.deepInclude(clientUpdate(model, { _tag: 'ClickedSendScheduled', id: itemId }).commands?.[0]?.args, { id: itemId, isNow: true })
      assert.isUndefined(clientUpdate(model, { _tag: 'ClickedCancelScheduled', id: 'sch_other' }).commands)
      yield* workspace.setReminder(messageId, 'mem_avery', 20 * minute)
      assert.deepInclude(laterOf(yield* workspace.current, me).find(item => item.message.id === messageId), { remindAt: 20 * minute, reminded: false })
    }).pipe(Effect.provide(workspaceLayer())))

  it.effect('the server scheduler delivers them when they come due', () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace
      yield* workspace.scheduleMessage('ch_general', 'On the dot', 'mem_avery', minute)
      yield* TestClock.adjust('70 seconds')
      const state = yield* workspace.current
      assert.strictEqual(state.scheduled.length, 0)
      assert.strictEqual(state.messages.at(-1)?.text, 'On the dot')
    }).pipe(Effect.provide(Scheduler.layer.pipe(Layer.provideMerge(workspaceLayer())))))
})
