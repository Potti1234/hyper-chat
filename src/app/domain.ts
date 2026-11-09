import { Schema as S, SchemaIssue } from 'effect'

/* The workspace's data: members, conversations (channels and direct
   messages), messages and read markers. Plain Schemas, so pages can keep them
   in their Models (which are snapshotted as JSON) and Messages can carry them. */

// MEMBERS

export const Member = S.Struct({
  id: S.String,
  name: S.String,
  /** What they sign in with (lower case). */
  email: S.String,
  /** A Tailwind background class from AVATAR_COLORS. */
  color: S.String,
  /** Their job title, shown on the profile; empty if unknown. */
  title: S.String,
  /** Their theme choice, applied to every page they have open. */
  isDark: S.Boolean,
  /** Their creaseui theme preset (`theme-<slug>` on the page root; '' is the app's own). */
  theme: S.String,
  /** Entered by the demo script (`npm run demo:seed`); `demo:clear` removes it. */
  isDemo: S.Boolean,
})
export type Member = typeof Member.Type

/** Demo addresses use a reserved example domain. */
export const EMAIL_DOMAIN = 'hyperchat.example'

/** A name part as it appears in an address: lower case, umlauts spelled out. */
const plainAscii = (text: string) =>
  text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '')

/** "Avery Finch" signs in as afinch@hyperchat.example. */
export const emailFor = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(part => part !== '')
  const first = plainAscii(parts[0] ?? '').slice(0, 1)
  const last = plainAscii(parts.length > 1 ? (parts.at(-1) ?? '') : '')
  return first === '' && last === '' ? '' : `${first}${last}@${EMAIL_DOMAIN}`
}

/** "afinch" signs in as afinch@hyperchat.example. */
export const normalizeEmail = (input: string): string => {
  const email = input.trim().toLowerCase()
  return email === '' || email.includes('@') ? email : `${email}@${EMAIL_DOMAIN}`
}

export const AVATAR_COLORS: ReadonlyArray<string> = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500',
]

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(part => part !== '')
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('')

export const firstName = (name: string): string => name.split(/\s+/)[0] ?? name

// CONVERSATIONS

/** Public channels anyone can join, private ones by invitation, and direct
 *  messages between two or more people (a DM with yourself is your notes). */
export const ChannelKind = S.Literals(['public', 'private', 'dm'])
export type ChannelKind = typeof ChannelKind.Type

export const Channel = S.Struct({
  id: S.String,
  /** Lower case with dashes (`design-crit`); '' for direct messages. */
  name: S.String,
  kind: ChannelKind,
  topic: S.String,
  description: S.String,
  memberIds: S.Array(S.String),
  createdBy: S.String,
  createdAt: S.Number,
  isArchived: S.Boolean,
  isDemo: S.Boolean,
})
export type Channel = typeof Channel.Type

export const isMemberOf = (channel: Channel, memberId: string): boolean => channel.memberIds.includes(memberId)

/** Who may read a conversation: anyone for a public channel, members otherwise. */
export const canRead = (channel: Channel, memberId: string): boolean => channel.kind === 'public' || isMemberOf(channel, memberId)

/** Slack's limits for a channel's name, topic and description. */
export const MAX_CHANNEL_NAME = 80
export const MAX_TOPIC = 250
export const MAX_DESCRIPTION = 250

/** The channel everyone is in: new accounts join it and nobody leaves it. */
export const DEFAULT_CHANNEL = 'general'

/** A channel name as Slack writes it: lower case, dashes for spaces, no punctuation but `-` and `_`. */
export const channelSlug = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')

export const compareChannels = (a: Channel, b: Channel): number => a.name.localeCompare(b.name)

/** The other people of a direct message (you alone for your own notes). */
export const dmPartners = (channel: Channel, meId: string): ReadonlyArray<string> => {
  const others = channel.memberIds.filter(id => id !== meId)
  return others.length === 0 ? [meId] : others
}

/** A conversation's name as people see it: `general`, or `Avery, Blake` for a DM. */
export const conversationName = (channel: Channel, members: ReadonlyArray<Member>, meId: string): string =>
  channel.kind === 'dm'
    ? dmPartners(channel, meId)
        .map(id => {
          const member = members.find(candidate => candidate.id === id)
          return member === undefined ? 'Someone' : channel.memberIds.length > 2 ? firstName(member.name) : member.name
        })
        .join(', ')
    : channel.name

// MESSAGES

export const Reaction = S.Struct({ emoji: S.String, memberIds: S.Array(S.String) })
export type Reaction = typeof Reaction.Type

export const Message = S.Struct({
  id: S.String,
  channelId: S.String,
  authorId: S.String,
  text: S.String,
  createdAt: S.Number,
  editedAt: S.NullOr(S.Number),
  reactions: S.Array(Reaction),
  /** The message this replies to in a thread; null in the channel itself. */
  threadId: S.NullOr(S.String),
  /** A reply also sent to the channel ("Also send to #channel"). */
  alsoInChannel: S.Boolean,
  isDemo: S.Boolean,
})
export type Message = typeof Message.Type

/** Shown in the channel: messages, and replies also sent there. */
export const inChannel = (message: Message): boolean => message.threadId === null || message.alsoInChannel

export const MAX_MESSAGE = 4000

/** How far someone has read a conversation (the newest message they saw). */
export const Read = S.Struct({ memberId: S.String, channelId: S.String, at: S.Number })
export type Read = typeof Read.Type

export const readAt = (reads: ReadonlyArray<Read>, memberId: string, channelId: string): number =>
  reads.find(read => read.memberId === memberId && read.channelId === channelId)?.at ?? 0

// INPUT

export const MIN_PASSWORD = 8

export const PersonName = S.String.pipe(
  S.check(
    S.isMinLength(1, { message: 'Enter their name.' }),
    S.isMaxLength(60, { message: 'Keep the name under 60 characters.' }),
  ),
)
export const Email = S.String.pipe(
  S.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Enter an email address.' }), S.isMaxLength(120)),
)
export const Password = S.String.pipe(
  S.check(
    S.isMinLength(MIN_PASSWORD, { message: `Use at least ${MIN_PASSWORD} characters.` }),
    S.isMaxLength(200, { message: 'Keep the password under 200 characters.' }),
  ),
)
/** A new account. The demo script bypasses the password rule (demo
 *  passwords are first names). */
export const NewMember = S.Struct({ name: PersonName, email: Email, password: Password })
export type NewMember = typeof NewMember.Type

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** The first message per field of a failed decode, keyed by field name. */
export const fieldErrors = (issue: SchemaIssue.Issue): Readonly<Record<string, string>> => {
  const errors: Record<string, string> = {}
  for (const { path, message } of formatIssue(issue).issues) {
    const first = path?.[0]
    const key = first === undefined ? '' : String(typeof first === 'object' ? first.key : first)
    errors[key] ??= message
  }
  return errors
}

/** Decodes a value, returning it or the first message of each failing field. */
export const validate = <A>(
  schema: S.Codec<A, unknown, never, never>,
  value: unknown,
): Readonly<{ ok: true; value: A } | { ok: false; errors: Readonly<Record<string, string>> }> => {
  const decoded = S.decodeUnknownExit(schema)(value, { errors: 'all' })
  if (decoded._tag === 'Success') return { ok: true, value: decoded.value }
  const error = decoded.cause.reasons.find(reason => reason._tag === 'Fail')?.error
  return {
    ok: false,
    errors: S.isSchemaError(error) ? fieldErrors(error.issue) : { '': 'Check the form.' },
  }
}

// TIME

const TIME_ZONE = 'Europe/Berlin'

/** 3:41 PM, as Slack shows it next to a message. */
export const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })

/** The calendar day of a moment (yyyy-mm-dd), for day dividers. */
export const dayOf = (at: number): string => new Date(at).toLocaleDateString('en-CA', { timeZone: TIME_ZONE })

/** "Today", "Yesterday" or "Monday, November 3rd". */
export const dayLabel = (at: number, now: number): string => {
  const day = dayOf(at)
  if (day === dayOf(now)) return 'Today'
  if (day === dayOf(now - 86_400_000)) return 'Yesterday'
  const date = new Date(at)
  const n = Number(date.toLocaleDateString('en-US', { day: 'numeric', timeZone: TIME_ZONE }))
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIME_ZONE })
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: TIME_ZONE })
  return `${weekday}, ${month} ${n}${suffix}`
}

// MENTIONS

/** The handle people @-mention someone by: the first name in lower case. */
export const handleOf = (member: Member): string => firstName(member.name).toLowerCase()

export const MENTION = /@([a-z][\w.-]*)/gi

/** Whether a message mentions the member by handle, or everyone with @here / @channel. */
export const mentions = (text: string, member: Member): boolean => {
  const handle = handleOf(member)
  return [...text.matchAll(MENTION)].some(([, name]) => {
    const lower = (name ?? '').toLowerCase()
    return lower === handle || lower === 'here' || lower === 'channel' || lower === 'everyone'
  })
}
