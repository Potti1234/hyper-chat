/* eslint-disable crease/no-native-glyphs -- emoji here are message text the demo people wrote, not interface icons */
import { Effect } from 'effect'

import { AVATAR_COLORS, type Channel, type ChannelKind, type Member, type Message, type Read, type Saved, emailFor, firstName } from './domain'
import { hashPassword } from './password'
import type { WorkspaceData } from './workspace'

/* The demo workspace "Northwind": fictional people, channels, direct messages
   and a few days of conversation. Everything is marked `isDemo`, so
   `npm run demo:clear` removes it. Demo passwords are first names. */

const PEOPLE: ReadonlyArray<readonly [key: string, name: string, title: string]> = [
  ['avery', 'Avery Finch', 'Product Manager'],
  ['blake', 'Blake Okafor', 'Engineering Lead'],
  ['casey', 'Casey Lindqvist', 'Product Designer'],
  ['devon', 'Devon Marsh', 'Frontend Engineer'],
  ['emery', 'Emery Castillo', 'Backend Engineer'],
  ['frankie', 'Frankie Novak', 'Marketing'],
  ['gray', 'Gray Whitaker', 'Customer Success'],
  ['harper', 'Harper Ishikawa', 'Data Analyst'],
]

export const DEMO_MEMBERS: ReadonlyArray<Member> = PEOPLE.map(([key, name, title], index) => ({
  id: `mem_${key}`,
  name,
  email: emailFor(name),
  color: AVATAR_COLORS[index % AVATAR_COLORS.length] ?? 'bg-indigo-500',
  title,
  isDark: false,
  theme: '',
  isDemo: true,
}))

export const demoPassword = (member: Member): string => firstName(member.name).toLowerCase()

export const demoPasswords: Effect.Effect<Readonly<Record<string, string>>> = Effect.map(
  Effect.forEach(DEMO_MEMBERS, member => Effect.map(hashPassword(demoPassword(member)), hash => [member.id, hash] as const), { concurrency: 4 }),
  Object.fromEntries,
)

const everyone = DEMO_MEMBERS.map(member => member.id)
const ids = (...keys: ReadonlyArray<string>) => keys.map(key => `mem_${key}`)

const CHANNELS: ReadonlyArray<readonly [id: string, name: string, kind: ChannelKind, topic: string, description: string, memberIds: ReadonlyArray<string>]> = [
  ['ch_general', 'general', 'public', 'Company-wide announcements and work-based matters', 'This is the one channel that will always include everyone.', everyone],
  ['ch_random', 'random', 'public', 'Non-work banter and water cooler conversation', 'A place for things that do not fit anywhere else.', everyone],
  ['ch_launch', 'product-launch', 'public', 'Northwind 2.0 ships November 20th 🚀', 'Coordination for the 2.0 launch: release notes, QA, marketing.', ids('avery', 'blake', 'casey', 'devon', 'emery', 'frankie')],
  ['ch_design', 'design-crit', 'public', 'Share work in progress, get feedback', 'Weekly crit on Thursdays at 2 PM.', ids('avery', 'casey', 'devon')],
  ['ch_eng', 'engineering', 'public', 'Deploys, incidents and code review', '', ids('blake', 'devon', 'emery', 'harper')],
  ['ch_support', 'customer-support', 'public', 'Escalations from the help desk', '', ids('gray', 'emery', 'avery')],
  ['ch_leads', 'leadership', 'private', 'Planning and hiring', 'Private: leads only.', ids('avery', 'blake', 'gray')],
  ['dm_avery_blake', '', 'dm', '', '', ids('avery', 'blake')],
  ['dm_avery_casey', '', 'dm', '', '', ids('avery', 'casey')],
  ['dm_avery_devon_emery', '', 'dm', '', '', ids('avery', 'devon', 'emery')],
]

/** Reactions on SCRIPT messages, by their 1-based position. */
const REACTIONS: Readonly<Record<number, ReadonlyArray<readonly [string, ReadonlyArray<string>]>>> = {
  4: [['🎉', ['avery', 'blake', 'casey', 'harper']], ['🙌', ['devon']]],
  6: [['📈', ['avery', 'blake']]],
  8: [['👀', ['devon', 'emery', 'frankie']]],
  15: [['🎲', ['casey', 'devon']]],
  17: [['🚀', ['blake', 'casey', 'devon', 'emery', 'frankie']]],
  32: [['✅', ['devon']]],
}

/** Thread replies: [SCRIPT position of the parent, author, minutes ago, text, also sent to the channel]. */
const REPLIES: ReadonlyArray<readonly [number, string, number, string, boolean?]> = [
  [8, 'emery', 92, 'Does the freeze include docs changes?'],
  [8, 'blake', 90, 'Docs are fine, code only.'],
  [8, 'frankie', 85, 'Good to know, the changelog PR can still go in then.'],
  [20, 'emery', 1440 + 370, 'Thanks! I will rerun the blocked cases once it is there.'],
  [20, 'blake', 600, 'It is on staging now.', true],
  [21, 'avery', 280, 'These look great. Can we keep the illustration on the last step?'],
  [21, 'casey', 270, 'Yes, I will keep it and tighten the copy.'],
  [33, 'devon', 1440 + 220, 'Could it be the same bug as the duplicate emails last month?'],
  [33, 'emery', 1440 + 215, 'Same root cause, yes.'],
]

/** [channel, author, minutes ago, text] */
/** Pinned messages (by their number in SCRIPT) and who pinned them. */
const PINNED: Readonly<Record<number, string>> = { 8: 'blake' }

const SCRIPT: ReadonlyArray<readonly [string, string, number, string]> = [
  ['ch_general', 'avery', 4 * 1440 + 600, 'Good morning everyone! Reminder that the all-hands is moved to Thursday this week.'],
  ['ch_general', 'gray', 4 * 1440 + 590, 'Thanks Avery! Will there be a recording for the folks in other time zones?'],
  ['ch_general', 'avery', 4 * 1440 + 585, 'Yes, it will be posted here afterwards.'],
  ['ch_general', 'frankie', 2 * 1440 + 300, 'The new website copy is live 🎉 Huge thanks to everyone who reviewed it.'],
  ['ch_general', 'blake', 2 * 1440 + 290, 'Looks great! The pricing page reads so much better now.'],
  ['ch_general', 'harper', 1440 + 200, 'Weekly metrics: active teams up 12%, median response time down to 3h.'],
  ['ch_general', 'avery', 1440 + 190, 'Amazing numbers, thanks for pulling these together Harper.'],
  ['ch_general', 'blake', 95, 'Heads up: we are freezing main for the 2.0 release on Friday.'],
  ['ch_general', 'devon', 80, 'Noted. I will get my last PRs in before Thursday.'],
  ['ch_random', 'devon', 3 * 1440 + 420, 'Anyone tried the new ramen place across the street?'],
  ['ch_random', 'emery', 3 * 1440 + 415, 'Yes! Get the spicy miso, it is excellent.'],
  ['ch_random', 'casey', 3 * 1440 + 400, 'Adding it to the list for Friday lunch.'],
  ['ch_random', 'frankie', 1440 + 60, 'Office plant update: the fiddle leaf fig has a new leaf 🌱'],
  ['ch_random', 'gray', 1440 + 55, 'A true Northwind success story.'],
  ['ch_random', 'harper', 30, 'Who is up for board games after work tomorrow?'],
  ['ch_launch', 'avery', 2 * 1440 + 500, 'Kicking off launch coordination here. Target date: November 20th.'],
  ['ch_launch', 'avery', 2 * 1440 + 498, 'Owners: release notes (Frankie), QA (Emery), onboarding flow (Casey + Devon).'],
  ['ch_launch', 'frankie', 2 * 1440 + 450, 'First draft of the release notes is in the launch folder.'],
  ['ch_launch', 'emery', 1440 + 400, 'QA status: 42 of 50 test cases pass. The remaining ones are blocked on the migration.'],
  ['ch_launch', 'blake', 1440 + 380, 'Migration lands today, I will ping you when it is on staging.'],
  ['ch_launch', 'casey', 300, 'Updated onboarding mockups are ready for review.'],
  ['ch_launch', 'devon', 240, 'I can start building the new empty states tomorrow.'],
  ['ch_launch', 'avery', 45, 'Great progress team. Let us do a go/no-go check on Wednesday.'],
  ['ch_design', 'casey', 1440 + 600, 'Sharing the new sidebar exploration. Two directions: compact and comfortable.'],
  ['ch_design', 'devon', 1440 + 580, 'Comfortable reads better, but compact fits more channels on small screens.'],
  ['ch_design', 'avery', 1440 + 560, 'Could we offer both as a preference?'],
  ['ch_design', 'casey', 1440 + 550, 'Good idea, I will mock up the setting.'],
  ['ch_eng', 'blake', 2 * 1440 + 100, 'Deploy 1.9.4 is out. Rollback plan is in the runbook.'],
  ['ch_eng', 'emery', 2 * 1440 + 90, 'Error rates look normal after the deploy.'],
  ['ch_eng', 'harper', 1440 + 300, 'The analytics job ran 3x faster with the new index 👏'],
  ['ch_eng', 'devon', 120, 'Can someone review the virtualized list PR? It is small, I promise.'],
  ['ch_eng', 'blake', 110, 'On it after standup.'],
  ['ch_support', 'gray', 1440 + 240, 'Customer reports notifications arriving twice on mobile. Anyone seen this?'],
  ['ch_support', 'emery', 1440 + 230, 'Looking into it. Probably the retry logic in the push worker.'],
  ['ch_support', 'emery', 1440 + 100, 'Fix is deployed. It was the retry logic.'],
  ['ch_support', 'gray', 1440 + 95, 'Thank you! I let the customer know.'],
  ['ch_leads', 'blake', 1440 + 700, 'We have two strong candidates for the senior backend role.'],
  ['ch_leads', 'gray', 1440 + 690, 'Happy to join the final interviews.'],
  ['ch_leads', 'avery', 600, 'Q1 planning doc is ready for comments.'],
  ['dm_avery_blake', 'blake', 1440 + 120, 'Do you have 15 minutes today to talk about the roadmap?'],
  ['dm_avery_blake', 'avery', 1440 + 110, 'Sure, 3 PM works for me.'],
  ['dm_avery_blake', 'blake', 50, 'Thanks for the chat yesterday, the plan makes sense.'],
  ['dm_avery_casey', 'casey', 200, 'Could you look at the onboarding mockups before the review?'],
  ['dm_avery_devon_emery', 'devon', 400, 'Quick sync about the API for the empty states?'],
  ['dm_avery_devon_emery', 'emery', 395, 'The endpoint is ready on staging.'],
  ['dm_avery_devon_emery', 'avery', 390, 'Perfect, thanks both!'],
]

export const demoData = (now: number): WorkspaceData => {
  const minute = 60_000
  const channels: ReadonlyArray<Channel> = CHANNELS.map(([id, name, kind, topic, description, memberIds]) => ({
    id,
    name,
    kind,
    topic,
    description,
    memberIds,
    createdBy: 'mem_avery',
    createdAt: now - 30 * 1440 * minute,
    isArchived: false,
    isDemo: true,
  }))
  const roots: ReadonlyArray<Message> = SCRIPT.map(([channelId, author, minutesAgo, text], index) => ({
    id: `msg_demo_${index + 1}`,
    channelId,
    authorId: `mem_${author}`,
    text,
    createdAt: now - minutesAgo * minute,
    editedAt: null,
    reactions: (REACTIONS[index + 1] ?? []).map(([emoji, people]) => ({ emoji, memberIds: people.map(key => `mem_${key}`) })),
    threadId: null,
    alsoInChannel: false,
    ...(PINNED[index + 1] === undefined ? {} : { pinnedBy: `mem_${PINNED[index + 1]}` }),
    isDemo: true,
  }))
  const replies: ReadonlyArray<Message> = REPLIES.map(([parent, author, minutesAgo, text, alsoInChannel], index) => ({
    id: `msg_demo_reply_${index + 1}`,
    channelId: SCRIPT[parent - 1]?.[0] ?? 'ch_general',
    authorId: `mem_${author}`,
    text,
    createdAt: now - minutesAgo * minute,
    editedAt: null,
    reactions: [],
    threadId: `msg_demo_${parent}`,
    alsoInChannel: alsoInChannel === true,
    isDemo: true,
  }))
  const messages = [...roots, ...replies].sort((a, b) => a.createdAt - b.createdAt)
  // Everyone has read up to two hours ago, so the newest messages are unread.
  const reads: ReadonlyArray<Read> = channels.flatMap(channel =>
    channel.memberIds.map(memberId => ({ memberId, channelId: channel.id, at: now - 120 * minute })),
  )
  const saves: ReadonlyArray<Saved> = [{ memberId: 'mem_avery', messageId: 'msg_demo_6', state: 'saved', at: now - 60 * minute }]
  return { members: DEMO_MEMBERS, channels, messages, reads, saves, scheduled: [], passwords: {} }
}
