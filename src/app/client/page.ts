import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import * as FoldkitFile from 'foldkit/file'
import { defineMessageUnion } from 'foldkit/message'

import { PageNotFound, PageRedirect, type PageRequest, type Program, keyBindings, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { text } from '@/ui/text'
import { anchoredStyle } from '@/lib/anchored'
import { button } from '@/ui/button'
import { checkbox } from '@/ui/checkbox'
import { fileButton } from '@/ui/file-button'
import * as Dialog from '@/ui/dialog'
import { input } from '@/ui/input'
import { textarea } from '@/ui/textarea'

import { requireMember } from '../auth'
import { Files, MAX_FILE_BYTES } from '../files'
import { Attachment, Channel, DEFAULT_CHANNEL, MAX_FILES, MAX_CHANNEL_NAME, MAX_DESCRIPTION, MAX_MESSAGE, MAX_TOPIC, channelSlug, Member, Message as ChatMessage, canRead, conversationName, dayLabel, dayOf, type Viewer, dmPartners, formatTime, inChannel, isMemberOf, isImage, isMuted, isStarred, NotifyLevel, notifyLevel, preferencesOf, readAt, Scheduled } from '../domain'
import { EMOJI, QUICK_REACTIONS, emojiName, isEmoji, searchEmoji } from '../emoji'
import { InvalidChange, Workspace, type WorkspaceState, presenceWhile } from '../store'
import { timeZoneOf } from '../profile'
import { REMIND_CHOICES, RemindChoice, SCHEDULE_CHOICES, ScheduleChoice, type WhenChoice, choiceLabel, inSentence, whenAt, whenLabel } from '../when'
import { sameIds } from '../presence'
import { threadTypingKey, typingIn } from '../typing'
import { Switcher, SwitcherClientEvent, SwitcherEvent, initSwitcher, switcherClientCommands, switcherRegion, updateHost } from '../view/switcher'
import { formatBar } from '../view/composer'
import { choice } from '../view/choice'
import { box, optionRow, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { attachmentList, authorName, fileUrl, formatSize, messageText, uploadChips } from '../view/message'
import { emptyNav, hasUnread, Nav, navOf, rail, sameNav, sidebar, topBar, WORKSPACE_NAME } from '../view/shell'

/* A conversation (channel or direct message), Slack's main view: the frame
   (rail and sidebar), the conversation header, messages grouped by day and
   by author, and the composer. Live for everyone with it open. Enter sends,
   Shift+Enter starts a new line. Opening it marks it read; a red "New" line
   shows where you stopped. The list is a reversed column, so the newest
   message stays in view without browser code.

   Each message has Slack's hover toolbar: quick reactions, the emoji
   picker, and (for your own) a menu to edit or delete. Up in an empty
   composer edits your last message; Escape closes what is open.

   Threads open in a pane beside the conversation: the message, its
   replies and a composer that can also send the reply to the channel.
   A message with replies shows who replied and when, Slack's reply bar. */

/** Messages kept on the page (the newest). */
export const SHOWN = 300

/** Where a message is shown: in the conversation or the thread pane. */
export const Where = S.Literals(['channel', 'thread'])
export type Where = typeof Where.Type

// MODEL

export const DetailsTab = S.Literals(['about', 'members', 'settings', 'pins', 'files', 'scheduled'])
export type DetailsTab = typeof DetailsTab.Type
export const DetailsField = S.Literals(['name', 'topic', 'description'])
export type DetailsField = typeof DetailsField.Type

export const Model = S.Struct({
  me: Member,
  channelId: S.String,
  channel: S.NullOr(Channel),
  members: S.Array(Member),
  messages: S.Array(ChatMessage),
  older: S.Number,
  /** Messages pinned to the conversation, newest first. */
  pins: S.Array(ChatMessage),
  /** Messages and replies with files, newest first: the Files tab. */
  shared: S.Array(ChatMessage),
  /** Your messages scheduled here, soonest first. */
  scheduled: S.Array(Scheduled),
  /** Your messages saved for later (in progress) here. */
  saved: S.Array(S.String),
  nav: Nav,
  switcher: Switcher,
  now: S.Number,
  /** Read up to here when the page opened: the "New" line. */
  readMarker: S.Number,
  /** Marked read up to here (a MarkRead Command). */
  markedUpTo: S.Number,
  draft: S.String,
  /** Files stored for the next message (from StoreFile, never the browser). */
  uploads: S.Array(Attachment),
  /** Files still being stored. */
  uploading: S.Number,
  /** Who else is typing here, by id. */
  typing: S.Array(S.String),
  /** Who else is typing a reply in the open thread. */
  threadTyping: S.Array(S.String),
  isConnected: S.Boolean,
  isSending: S.Boolean,
  notice: S.NullOr(S.String),
  collapsed: S.Array(S.String),
  /** Your message being edited in place. */
  editing: S.NullOr(S.Struct({ id: S.String, where: Where, text: S.String, isSaving: S.Boolean })),
  /** The emoji picker or a message's menu, anchored to its button. */
  overlay: S.NullOr(S.Struct({ kind: S.Literals(['emoji', 'actions', 'schedule', 'remind']), messageId: S.String, where: Where, anchor: S.String })),
  /** The open thread pane and its composer. */
  thread: S.NullOr(S.Struct({ id: S.String, draft: S.String, alsoSend: S.Boolean, isSending: S.Boolean, uploads: S.Array(Attachment), uploading: S.Number })),
  emojiQuery: S.String,
  /** The message the delete confirmation is for. */
  deleting: S.NullOr(S.String),
  confirm: Dialog.Model,
  /** Channel details (Slack's About / Members / Settings dialog). */
  details: Dialog.Model,
  about: S.Struct({ tab: DetailsTab, field: S.NullOr(DetailsField), value: S.String, query: S.String, isSaving: S.Boolean }),
  isJoining: S.Boolean,
  /** Bumped to move focus (a forwarded focus Command). */
  focus: S.NullOr(S.Struct({ selector: S.String, seq: S.Number })),
  seq: S.Number,
})
export type Model = typeof Model.Type

const canWrite = (model: Pick<Model, 'channel' | 'me'>) => model.channel !== null && !model.channel.isArchived && isMemberOf(model.channel, model.me.id)

const titleOf = (model: Pick<Model, 'channel' | 'members' | 'me'>) => (model.channel === null ? 'Not found' : conversationName(model.channel, model.members, model.me.id))

const placeholderOf = (model: Model) =>
  model.channel === null ? '' : model.channel.kind === 'dm' ? `Message ${titleOf(model)}` : `Message #${model.channel.name}`

// MESSAGE

export const Message = defineMessageUnion({
  ChangedDraft: { text: S.String },
  ChoseFiles: { files: S.Array(FoldkitFile.File) },
  ChoseReplyFiles: { files: S.Array(FoldkitFile.File) },
  StoredFile: { file: Attachment, threadId: S.NullOr(S.String) },
  RejectedFile: { reason: S.String, threadId: S.NullOr(S.String) },
  ClickedRemoveUpload: { id: S.String },
  ClickedRemoveReplyUpload: { id: S.String },
  GotTyping: { memberIds: S.Array(S.String) },
  GotThreadTyping: { memberIds: S.Array(S.String) },
  SubmittedDraft: {},
  PressedEnter: { targetId: S.String },
  GotSwitcher: { event: SwitcherEvent },
  ClickedToggleTheme: {},
  ClickedToggleSection: { section: S.String },
  ClickedDismissNotice: {},
  ClickedReaction: { messageId: S.String, emoji: S.String },
  ClickedAddReaction: { messageId: S.String, from: S.Literals(['toolbar', 'reactions']), where: Where },
  ChangedEmojiQuery: { text: S.String },
  ClickedEmoji: { emoji: S.String },
  ClickedMore: { messageId: S.String, where: Where },
  ClickedMarkUnread: { messageId: S.String },
  ClickedCopyLink: { messageId: S.String },
  ClickedSave: { messageId: S.String },
  ClickedPin: { messageId: S.String },
  ClickedScheduleMenu: {},
  ClickedSchedule: { choice: ScheduleChoice },
  SucceededSchedule: { label: S.String },
  SetReminderFor: { notice: S.String },
  ClickedRemindMenu: { messageId: S.String, where: Where },
  ClickedRemind: { messageId: S.String, choice: RemindChoice },
  ClickedSendScheduled: { id: S.String },
  ClickedCancelScheduled: { id: S.String },
  ClickedCloseOverlay: {},
  ClickedEdit: { messageId: S.String, where: Where },
  ClickedReplyInThread: { messageId: S.String },
  ClickedCloseThread: {},
  ChangedThreadDraft: { text: S.String },
  SubmittedThreadDraft: {},
  ToggledAlsoSend: { isChecked: S.Boolean },
  SucceededReply: {},
  ChangedEdit: { text: S.String },
  SubmittedEdit: {},
  ClickedCancelEdit: {},
  ClickedDelete: { messageId: S.String },
  ClickedConfirmDelete: {},
  GotConfirmDialog: { message: Dialog.Message },
  PressedEscape: {},
  PressedUp: { targetId: S.String },
  SucceededEdit: {},
  SucceededDelete: {},
  ChangedConnection: { isConnected: S.Boolean },
  GotChannel: { channel: S.NullOr(Channel), members: S.Array(Member), messages: S.Array(ChatMessage), older: S.Number, pins: S.Array(ChatMessage), shared: S.Array(ChatMessage), scheduled: S.Array(Scheduled), saved: S.Array(S.String), nav: Nav, me: Member, now: S.Number },
  SucceededSend: {},
  ClickedJoin: {},
  ClickedOpenDetails: { tab: DetailsTab, field: S.NullOr(DetailsField) },
  GotDetailsDialog: { message: Dialog.Message },
  ClickedDetailsTab: { tab: DetailsTab },
  ClickedEditField: { field: DetailsField },
  ChangedField: { text: S.String },
  SubmittedField: {},
  ClickedCancelField: {},
  ChangedPeopleQuery: { text: S.String },
  ClickedAddPerson: { memberId: S.String },
  ClickedLeave: {},
  ClickedArchive: { isArchived: S.Boolean },
  ClickedMute: { isMuted: S.Boolean },
  ClickedStar: { isStarred: S.Boolean },
  ClickedNotify: { level: NotifyLevel },
  SucceededJoin: {},
  SucceededField: {},
  LeftChannel: {},
  FailedChange: { reason: S.String },
  CompletedChange: {},
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). Typed text arrives
 *  through the composer's handler; Enter through a key binding. */
export const ClientMessage = S.Union([
  Message.SubmittedDraft,
  Message.ClickedRemoveUpload,
  Message.ClickedRemoveReplyUpload,
  S.TaggedStruct('GotSwitcher', { event: SwitcherClientEvent }), Message.ClickedToggleTheme,
  Message.ClickedToggleSection,
  Message.ClickedDismissNotice,
  Message.ClickedReaction,
  Message.ClickedAddReaction,
  Message.ClickedEmoji,
  Message.ClickedMore,
  Message.ClickedMarkUnread,
  Message.ClickedCopyLink,
  Message.ClickedSave,
  Message.ClickedPin,
  Message.ClickedScheduleMenu,
  Message.ClickedSchedule,
  Message.ClickedRemindMenu,
  Message.ClickedRemind,
  Message.ClickedSendScheduled,
  Message.ClickedCancelScheduled,
  Message.ClickedCloseOverlay,
  Message.ClickedEdit,
  Message.SubmittedEdit,
  Message.ClickedCancelEdit,
  Message.ClickedDelete,
  Message.ClickedConfirmDelete,
  Message.ClickedReplyInThread,
  Message.ClickedCloseThread,
  Message.SubmittedThreadDraft,
  Message.ToggledAlsoSend,
  Message.ClickedJoin,
  Message.ClickedOpenDetails,
  Message.ClickedDetailsTab,
  Message.ClickedEditField,
  Message.SubmittedField,
  Message.ClickedCancelField,
  Message.ClickedAddPerson,
  Message.ClickedLeave,
  Message.ClickedArchive,
  Message.ClickedMute,
  Message.ClickedStar,
  Message.ClickedNotify,
  S.TaggedStruct('GotDetailsDialog', { message: Dialog.Message.RequestedClose }),
  // The dialog's own bindings; its Command results never come from the page.
  S.TaggedStruct('GotConfirmDialog', { message: Dialog.Message.RequestedClose }),
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const StoreFile = Command.define('StoreFile', {
  args: { file: FoldkitFile.File, uploaderId: S.String, threadId: S.NullOr(S.String) },
  messages: [Message.StoredFile, Message.RejectedFile],
  execute: ({ file, uploaderId, threadId }) =>
    Files.use(files => files.put(file, uploaderId)).pipe(
      Effect.map(stored => Message.StoredFile({ file: stored, threadId })),
      Effect.catchTag('FileRejected', ({ reason }) => Effect.succeed(Message.RejectedFile({ reason, threadId }))),
    ),
})

export const SignalTyping = Command.define('SignalTyping', {
  args: { channelId: S.String, memberId: S.String, isTyping: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ channelId, memberId, isTyping }) => Workspace.use(workspace => workspace.setTyping(memberId, channelId, isTyping)).pipe(Effect.as(Message.CompletedChange())),
})

export const SendMessage = Command.define('SendMessage', {
  args: { channelId: S.String, text: S.String, files: S.Array(Attachment), actorId: S.String },
  messages: [Message.SucceededSend, Message.FailedChange],
  execute: ({ channelId, text, files, actorId }) =>
    Workspace.use(workspace => Effect.tap(workspace.postMessage(channelId, text, actorId, { files }), () => workspace.setTyping(actorId, channelId, false))).pipe(
      Effect.as(Message.SucceededSend()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const ScheduleMessage = Command.define('ScheduleMessage', {
  args: { channelId: S.String, text: S.String, files: S.Array(Attachment), actorId: S.String, choice: ScheduleChoice },
  messages: [Message.SucceededSchedule, Message.FailedChange],
  execute: ({ channelId, text, files, actorId, choice }) =>
    Workspace.use(workspace =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const me = yield* workspace.member(actorId)
        if (me === undefined) return yield* Effect.fail(new InvalidChange({ reason: 'Unknown member.' }))
        const item = yield* workspace.scheduleMessage(channelId, text, actorId, whenAt(choice, now, timeZoneOf(me)), files)
        yield* workspace.setTyping(actorId, channelId, false)
        return Message.SucceededSchedule({ label: whenLabel(item.sendAt, now, me) })
      }),
    ).pipe(Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason })))),
})

export const SetReminder = Command.define('SetReminder', {
  args: { messageId: S.String, memberId: S.String, choice: RemindChoice },
  messages: [Message.SetReminderFor, Message.FailedChange],
  execute: ({ messageId, memberId, choice }) =>
    Workspace.use(workspace =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const me = yield* workspace.member(memberId)
        if (me === undefined) return yield* Effect.fail(new InvalidChange({ reason: 'Unknown member.' }))
        const remindAt = whenAt(choice, now, timeZoneOf(me))
        yield* workspace.setReminder(messageId, memberId, remindAt)
        return Message.SetReminderFor({ notice: `I’ll remind you about this ${inSentence(whenLabel(remindAt, now, me))}.` })
      }),
    ).pipe(Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason })))),
})

export const SendScheduled = Command.define('SendScheduled', {
  args: { id: S.String, actorId: S.String, isNow: S.Boolean },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ id, actorId, isNow }) =>
    Workspace.use(workspace => (isNow ? Effect.asVoid(workspace.sendScheduledNow(id, actorId)) : workspace.cancelScheduled(id, actorId))).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SendReply = Command.define('SendReply', {
  args: { channelId: S.String, threadId: S.String, text: S.String, files: S.Array(Attachment), alsoInChannel: S.Boolean, actorId: S.String },
  messages: [Message.SucceededReply, Message.FailedChange],
  execute: ({ channelId, threadId, text, files, alsoInChannel, actorId }) =>
    Workspace.use(workspace => Effect.tap(workspace.postMessage(channelId, text, actorId, { threadId, alsoInChannel, files }), () => workspace.setTyping(actorId, threadTypingKey(channelId, threadId), false))).pipe(
      Effect.as(Message.SucceededReply()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const EditMessage = Command.define('EditMessage', {
  args: { messageId: S.String, text: S.String, actorId: S.String },
  messages: [Message.SucceededEdit, Message.FailedChange],
  execute: ({ messageId, text, actorId }) =>
    Workspace.use(workspace => workspace.editMessage(messageId, text, actorId)).pipe(
      Effect.as(Message.SucceededEdit()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const DeleteMessage = Command.define('DeleteMessage', {
  args: { messageId: S.String, actorId: S.String },
  messages: [Message.SucceededDelete, Message.FailedChange],
  execute: ({ messageId, actorId }) =>
    Workspace.use(workspace => workspace.deleteMessage(messageId, actorId)).pipe(
      Effect.as(Message.SucceededDelete()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const ToggleReaction = Command.define('ToggleReaction', {
  args: { messageId: S.String, emoji: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, emoji, actorId }) =>
    Workspace.use(workspace => workspace.toggleReaction(messageId, emoji, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const ToggleSaved = Command.define('ToggleSaved', {
  args: { messageId: S.String, memberId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, memberId }) =>
    Workspace.use(workspace => workspace.toggleSaved(messageId, memberId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const TogglePin = Command.define('TogglePin', {
  args: { messageId: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, actorId }) =>
    Workspace.use(workspace => workspace.togglePin(messageId, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const MarkUnread = Command.define('MarkUnread', {
  args: { messageId: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ messageId, actorId }) =>
    Workspace.use(workspace => workspace.markUnread(messageId, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const MarkRead = Command.define('MarkRead', {
  args: { channelId: S.String, memberId: S.String },
  messages: [Message.CompletedChange],
  execute: ({ channelId, memberId }) => Workspace.use(workspace => workspace.markRead(channelId, memberId)).pipe(Effect.as(Message.CompletedChange())),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) => Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

/** Moves focus in the browser (a forwarded client command). */
export const FocusElement = Command.define('FocusElement', {
  args: { selector: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

/** Replaces the address without a load (a forwarded client command). */
export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

export const JoinChannel = Command.define('JoinChannel', {
  args: { channelId: S.String, actorId: S.String },
  messages: [Message.SucceededJoin, Message.FailedChange],
  execute: ({ channelId, actorId }) =>
    Workspace.use(workspace => workspace.joinChannel(channelId, actorId)).pipe(
      Effect.as(Message.SucceededJoin()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const LeaveChannel = Command.define('LeaveChannel', {
  args: { channelId: S.String, actorId: S.String },
  messages: [Message.LeftChannel, Message.FailedChange],
  execute: ({ channelId, actorId }) =>
    Workspace.use(workspace => workspace.leaveChannel(channelId, actorId)).pipe(
      Effect.as(Message.LeftChannel()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const UpdateChannel = Command.define('UpdateChannel', {
  args: { channelId: S.String, field: DetailsField, value: S.String, actorId: S.String },
  messages: [Message.SucceededField, Message.FailedChange],
  execute: ({ channelId, field, value, actorId }) =>
    Workspace.use(workspace => workspace.updateChannel(channelId, { [field]: value }, actorId)).pipe(
      Effect.as(Message.SucceededField()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const AddToChannel = Command.define('AddToChannel', {
  args: { channelId: S.String, memberId: S.String, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, memberId, actorId }) =>
    Workspace.use(workspace => workspace.addToChannel(channelId, [memberId], actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SetMuted = Command.define('SetMuted', {
  args: { channelId: S.String, isMuted: S.Boolean, memberId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, isMuted, memberId }) =>
    Workspace.use(workspace => workspace.setMuted(memberId, channelId, isMuted)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SetNotify = Command.define('SetNotify', {
  args: { channelId: S.String, level: NotifyLevel, memberId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, level, memberId }) =>
    Workspace.use(workspace => workspace.setNotify(memberId, channelId, level)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SetStarred = Command.define('SetStarred', {
  args: { channelId: S.String, isStarred: S.Boolean, memberId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, isStarred, memberId }) =>
    Workspace.use(workspace => workspace.setStarred(memberId, channelId, isStarred)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

export const SetArchived = Command.define('SetArchived', {
  args: { channelId: S.String, isArchived: S.Boolean, actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ channelId, isArchived, actorId }) =>
    Workspace.use(workspace => workspace.setArchived(channelId, isArchived, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedChange({ reason }))),
    ),
})

/** Opens another page (a forwarded client command). */
export const LoadUrl = Command.define('LoadUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

/** The address of a conversation, with its open thread. */
export const urlOf = (channelId: string, threadId: string | null) => `/client/${channelId}${threadId === null ? '' : `/thread/${threadId}`}`

// INIT

export type Flags = Readonly<{
  me: Member
  channelId: string
  channel: Channel
  members: ReadonlyArray<Member>
  messages: ReadonlyArray<ChatMessage>
  older: number
  pins: ReadonlyArray<ChatMessage>
  shared: ReadonlyArray<ChatMessage>
  scheduled: ReadonlyArray<Scheduled>
  saved: ReadonlyArray<string>
  nav: Nav
  now: number
  readMarker: number
  threadId: string | null
}>

const closedAbout = { tab: 'about', field: null, value: '', query: '', isSaving: false } as const

export const init = ({ threadId, ...flags }: Flags): Update.Return<Model, Message, Workspace | Files> => ({
  model: {
    ...flags,
    switcher: initSwitcher(),
    thread: threadId === null ? null : { id: threadId, draft: '', alsoSend: false, isSending: false, uploads: [], uploading: 0 },
    markedUpTo: flags.readMarker,
    draft: '',
    uploads: [],
    uploading: 0,
    typing: [],
    threadTyping: [],
    isConnected: false,
    isSending: false,
    notice: null,
    collapsed: [],
    editing: null,
    overlay: null,
    emojiQuery: '',
    deleting: null,
    confirm: Dialog.init({ id: 'confirm-delete' }),
    details: Dialog.init({ id: 'channel-details' }),
    about: closedAbout,
    isJoining: false,
    focus: null,
    seq: 0,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace | Files>

const newest = (messages: ReadonlyArray<ChatMessage>) => messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0)

/** While someone has the conversation open, what arrives counts as read. */
const markRead = (result: UpdateReturn): UpdateReturn => {
  const { model } = result
  const latest = newest(model.messages)
  if (!model.isConnected || model.channel === null || !isMemberOf(model.channel, model.me.id) || latest <= model.markedUpTo) return result
  return { model: { ...model, markedUpTo: latest }, commands: [...(result.commands ?? []), MarkRead({ channelId: model.channelId, memberId: model.me.id })] }
}

const SCHEDULE_ANCHOR = '--schedule-send'

/** The draft's text when it can be sent (or scheduled) as it is. */
const sendable = (model: Model): string | null => {
  const text = model.draft.trim()
  return (text === '' && model.uploads.length === 0) || model.isSending || model.uploading > 0 || !canWrite(model) || text.length > MAX_MESSAGE ? null : text
}

const send = (model: Model): UpdateReturn => {
  const text = model.draft.trim()
  if ((text === '' && model.uploads.length === 0) || model.isSending || model.uploading > 0) return { model }
  if (!canWrite(model)) return { model: { ...model, notice: 'Join this channel to write in it.' } }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, isSending: true }, commands: [SendMessage({ channelId: model.channelId, text, files: model.uploads, actorId: model.me.id })] }
}

/** The draft, and telling the others whether you are typing. */
const changeDraft = (model: Model, text: string): UpdateReturn => {
  const next = { ...model, draft: text.slice(0, MAX_MESSAGE + 100) }
  const isTyping = next.draft.trim() !== ''
  if (!canWrite(model) || (!isTyping && model.draft.trim() === '')) return { model: next }
  return { model: next, commands: [SignalTyping({ channelId: model.channelId, memberId: model.me.id, isTyping })] }
}

/** The reply draft, and telling the thread's readers whether you are typing. */
const changeReplyDraft = (model: Model, text: string): UpdateReturn => {
  const thread = model.thread
  if (thread === null) return { model }
  const draft = text.slice(0, MAX_MESSAGE + 100)
  const next = { ...model, thread: { ...thread, draft } }
  const isTyping = draft.trim() !== ''
  if (!canWrite(model) || (!isTyping && thread.draft.trim() === '')) return { model: next }
  return { model: next, commands: [SignalTyping({ channelId: threadTypingKey(model.channelId, thread.id), memberId: model.me.id, isTyping })] }
}

/** Why these files can't join the pending ones, if they can't. */
const fileProblem = (model: Model, pending: number, files: ReadonlyArray<File>): string | null => {
  if (!canWrite(model)) return 'Join this channel to share files in it.'
  if (pending + files.length > MAX_FILES) return `Share at most ${MAX_FILES} files at once.`
  const tooLarge = files.find(file => file.size > MAX_FILE_BYTES)
  return tooLarge === undefined ? null : `${tooLarge.name} is larger than 10 MB.`
}

/** Stores chosen or dropped files for the next message, one Command each. */
const chooseFiles = (model: Model, files: ReadonlyArray<File>): UpdateReturn => {
  if (files.length === 0) return { model }
  const problem = fileProblem(model, model.uploads.length + model.uploading, files)
  if (problem !== null) return { model: { ...model, notice: problem } }
  return { model: { ...model, uploading: model.uploading + files.length, notice: null }, commands: files.map(file => StoreFile({ file, uploaderId: model.me.id, threadId: null })) }
}

/** The same for the open thread's reply. */
const chooseReplyFiles = (model: Model, files: ReadonlyArray<File>): UpdateReturn => {
  const thread = model.thread
  if (files.length === 0 || thread === null) return { model }
  const problem = fileProblem(model, thread.uploads.length + thread.uploading, files)
  if (problem !== null) return { model: { ...model, notice: problem } }
  return { model: { ...model, thread: { ...thread, uploading: thread.uploading + files.length }, notice: null }, commands: files.map(file => StoreFile({ file, uploaderId: model.me.id, threadId: thread.id })) }
}

/** A stored (or refused) file lands in the composer it was chosen for. */
const landFile = (model: Model, threadId: string | null, file: Attachment | null, reason: string | null): Model => {
  const notice = reason ?? model.notice
  if (threadId === null) return { ...model, notice, uploading: Math.max(0, model.uploading - 1), uploads: file === null ? model.uploads : [...model.uploads, file] }
  const thread = model.thread
  if (thread === null || thread.id !== threadId) return { ...model, notice }
  return { ...model, notice, thread: { ...thread, uploading: Math.max(0, thread.uploading - 1), uploads: file === null ? thread.uploads : [...thread.uploads, file] } }
}

/** A message with its thread: replies are kept to the thread they belong to. */
const threadRoot = (model: Model, messageId: string) => {
  const message = model.messages.find(candidate => candidate.id === messageId)
  const rootId = message?.threadId ?? message?.id
  return model.messages.find(candidate => candidate.id === rootId && candidate.threadId === null)
}

export const repliesOf = (messages: ReadonlyArray<ChatMessage>, threadId: string) => messages.filter(message => message.threadId === threadId)

const openThread = (model: Model, messageId: string): UpdateReturn => {
  const root = threadRoot(model, messageId)
  if (root === undefined) return { model }
  const thread = model.thread?.id === root.id ? model.thread : { id: root.id, draft: '', alsoSend: false, isSending: false, uploads: [], uploading: 0 }
  return { model: withFocus({ ...model, overlay: null, thread }, '#thread-composer') }
}

const sendReply = (model: Model): UpdateReturn => {
  const thread = model.thread
  if (thread === null || thread.isSending) return { model }
  const text = thread.draft.trim()
  if ((text === '' && thread.uploads.length === 0) || thread.uploading > 0) return { model }
  if (!canWrite(model)) return { model: { ...model, notice: 'Join this channel to reply.' } }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  if (threadRoot(model, thread.id) === undefined) return { model: { ...model, thread: null, notice: 'That thread was deleted.' } }
  return { model: { ...model, thread: { ...thread, isSending: true } }, commands: [SendReply({ channelId: model.channelId, threadId: thread.id, text, files: thread.uploads, alsoInChannel: thread.alsoSend, actorId: model.me.id })] }
}

const composerOf = (where: Where) => (where === 'thread' ? '#thread-composer' : '#composer')

const ownMessage = (model: Model, messageId: string) => model.messages.find(message => message.id === messageId && message.authorId === model.me.id)

/** A message shown in the conversation that you can pin. */
const pinnable = (model: Model, messageId: string) => (canWrite(model) ? model.messages.find(message => message.id === messageId && inChannel(message)) : undefined)

/** A message of the conversation you can mark unread from. */
const unreadable = (model: Model, messageId: string) =>
  model.channel !== null && isMemberOf(model.channel, model.me.id) ? model.messages.find(message => message.id === messageId && inChannel(message)) : undefined

/** The CSS anchor of a message's toolbar or reaction-bar button. */
export const anchorOf = (messageId: string, from: 'toolbar' | 'reactions' | 'more', where: Where) => `--${where}-${from}-${messageId.replace(/[^a-zA-Z0-9-]/g, '-')}`

const withFocus = (model: Model, selector: string): Model => ({ ...model, seq: model.seq + 1, focus: { selector, seq: model.seq + 1 } })

const startEdit = (model: Model, messageId: string, where: Where): UpdateReturn => {
  const message = ownMessage(model, messageId)
  if (message === undefined || (where === 'thread' && model.thread === null)) return { model: { ...model, overlay: null } }
  return { model: withFocus({ ...model, overlay: null, editing: { id: message.id, where, text: message.text, isSaving: false } }, '#edit-composer') }
}

const saveEdit = (model: Model): UpdateReturn => {
  const editing = model.editing
  if (editing === null || editing.isSaving) return { model }
  const message = ownMessage(model, editing.id)
  if (message === undefined) return { model: { ...model, editing: null } }
  const text = editing.text.trim()
  // Slack: saving an empty message offers to delete it.
  if (text === '') return askDelete({ ...model, editing: null }, message.id)
  if (text === message.text) return { model: withFocus({ ...model, editing: null }, composerOf(editing.where)) }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, editing: { ...editing, isSaving: true } }, commands: [EditMessage({ messageId: message.id, text, actorId: model.me.id })] }
}

const withDetails = (model: Model, dialogUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, details: dialogUpdate.model, about: dialogUpdate.model.isOpen ? model.about : closedAbout },
  commands: Command.mapMessages(dialogUpdate.commands, message => Message.GotDetailsDialog({ message })),
})

/** The channel you may change from its details: a channel (not a DM) you are in. */
const ownChannel = (model: Model) =>
  model.channel !== null && model.channel.kind !== 'dm' && isMemberOf(model.channel, model.me.id) ? model.channel : null

const fieldValue = (channel: Channel, field: DetailsField) => (field === 'name' ? channel.name : field === 'topic' ? channel.topic : channel.description)

const fieldMax: Record<DetailsField, number> = { name: MAX_CHANNEL_NAME, topic: MAX_TOPIC, description: MAX_DESCRIPTION }

const editField = (model: Model, field: DetailsField): Model => {
  const channel = ownChannel(model)
  if (channel === null || channel.isArchived || (field === 'name' && channel.name === DEFAULT_CHANNEL)) return model
  return { ...model, about: { ...model.about, tab: 'about', field, value: fieldValue(channel, field), isSaving: false }, seq: model.seq + 1, focus: { selector: '#detail-field', seq: model.seq + 1 } }
}

const saveField = (model: Model): UpdateReturn => {
  const channel = ownChannel(model)
  const { field, value, isSaving } = model.about
  if (channel === null || field === null || isSaving || !model.details.isOpen) return { model }
  if (field === 'name' && channelSlug(value) === '') return { model: { ...model, notice: 'Give the channel a name.' } }
  if (value.trim() === fieldValue(channel, field) || (field === 'name' && channelSlug(value) === channel.name)) return { model: { ...model, about: { ...model.about, field: null } } }
  return { model: { ...model, about: { ...model.about, isSaving: true } }, commands: [UpdateChannel({ channelId: channel.id, field, value, actorId: model.me.id })] }
}

const withConfirm = (model: Model, dialogUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, confirm: dialogUpdate.model, deleting: dialogUpdate.model.isOpen ? model.deleting : null },
  commands: Command.mapMessages(dialogUpdate.commands, message => Message.GotConfirmDialog({ message })),
})

const askDelete = (model: Model, messageId: string): UpdateReturn =>
  ownMessage(model, messageId) === undefined ? { model: { ...model, overlay: null } } : withConfirm({ ...model, overlay: null, deleting: messageId }, Dialog.open(model.confirm))

const react = (model: Model, messageId: string, emoji: string): UpdateReturn => {
  if (!isEmoji(emoji) || !model.messages.some(message => message.id === messageId)) return { model: { ...model, overlay: null } }
  if (!canWrite(model)) return { model: { ...model, overlay: null, notice: 'Join this channel to react.' } }
  return { model: { ...model, overlay: null }, commands: [ToggleReaction({ messageId, emoji, actorId: model.me.id })] }
}

/** What was open on a message someone else just deleted closes. */
const withoutGone = (model: Model): Model => {
  const has = (id: string) => model.messages.some(message => message.id === id)
  return {
    ...model,
    editing: model.editing !== null && !has(model.editing.id) ? null : model.editing,
    overlay: model.overlay !== null && !has(model.overlay.messageId) ? null : model.overlay,
    thread: model.thread !== null && !has(model.thread.id) ? null : model.thread,
  }
}

const escape = (model: Model): UpdateReturn => {
  if (model.overlay !== null) return { model: { ...model, overlay: null } }
  if (model.editing !== null) return { model: withFocus({ ...model, editing: null }, composerOf(model.editing.where)) }
  // Slack: Esc marks the conversation read, the "New" line included.
  return markRead({ model: { ...model, readMarker: Number.MAX_SAFE_INTEGER, markedUpTo: model.markedUpTo === Number.MAX_SAFE_INTEGER ? 0 : model.markedUpTo } })
}

export const updateModel = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedDraft: ({ text }) => changeDraft(model, text),
      GotTyping: ({ memberIds }) => ({ model: sameIds(memberIds, model.typing) ? model : { ...model, typing: memberIds } }),
      GotThreadTyping: ({ memberIds }) => ({ model: sameIds(memberIds, model.threadTyping) ? model : { ...model, threadTyping: memberIds } }),
      ChoseFiles: ({ files }) => chooseFiles(model, files),
      ChoseReplyFiles: ({ files }) => chooseReplyFiles(model, files),
      StoredFile: ({ file, threadId }) => ({ model: landFile(model, threadId, file, null) }),
      RejectedFile: ({ reason, threadId }) => ({ model: landFile(model, threadId, null, reason) }),
      ClickedRemoveUpload: ({ id }) => ({ model: { ...model, uploads: model.uploads.filter(file => file.id !== id) } }),
      ClickedRemoveReplyUpload: ({ id }) => (model.thread === null ? { model } : { model: { ...model, thread: { ...model.thread, uploads: model.thread.uploads.filter(file => file.id !== id) } } }),
      SubmittedDraft: () => send(model),
      PressedEnter: ({ targetId }) =>
        targetId === 'detail-field' ? saveField(model) : targetId === 'composer' ? send(model) : targetId === 'thread-composer' ? sendReply(model) : targetId === 'edit-composer' ? saveEdit(model) : { model },
      PressedEscape: () => (model.switcher.dialog.isOpen || model.switcher.shortcuts.isOpen ? { model } : escape(model)),
      // Up in an empty composer edits your last message (Slack).
      PressedUp: ({ targetId }) => {
        if (model.editing !== null) return { model }
        if (targetId === 'composer' && model.draft === '') {
          const last = [...model.messages].reverse().find(message => message.authorId === model.me.id && inChannel(message))
          return last === undefined ? { model } : startEdit(model, last.id, 'channel')
        }
        if (targetId === 'thread-composer' && model.thread !== null && model.thread.draft === '') {
          const threadId = model.thread.id
          const last = [...model.messages].reverse().find(message => message.authorId === model.me.id && (message.threadId === threadId || message.id === threadId))
          return last === undefined ? { model } : startEdit(model, last.id, 'thread')
        }
        return { model }
      },
      ClickedReaction: ({ messageId, emoji }) => react(model, messageId, emoji),
      ClickedAddReaction: ({ messageId, from, where }) =>
        model.messages.some(message => message.id === messageId)
          ? { model: withFocus({ ...model, emojiQuery: '', overlay: { kind: 'emoji', messageId, where, anchor: anchorOf(messageId, from, where) } }, '#emoji-search') }
          : { model },
      ChangedEmojiQuery: ({ text }) => ({ model: { ...model, emojiQuery: text.slice(0, 40) } }),
      ClickedEmoji: ({ emoji }) => (model.overlay?.kind === 'emoji' ? react(model, model.overlay.messageId, emoji) : { model }),
      ClickedMore: ({ messageId, where }) =>
        ownMessage(model, messageId) === undefined && !(where === 'channel' && unreadable(model, messageId) !== undefined)
          ? { model }
          : {
              model: {
                ...model,
                overlay: model.overlay?.kind === 'actions' && model.overlay.messageId === messageId && model.overlay.where === where ? null : { kind: 'actions', messageId, where, anchor: anchorOf(messageId, 'more', where) },
              },
            },
      ClickedMarkUnread: ({ messageId }) => {
        const found = unreadable(model, messageId)
        if (found === undefined) return { model }
        // Stays unread while you look at it, until you open the conversation again.
        return { model: { ...model, overlay: null, readMarker: found.createdAt - 1, markedUpTo: Number.MAX_SAFE_INTEGER }, commands: [MarkUnread({ messageId, actorId: model.me.id })] }
      },
      // public/composer.js copies the link in the browser; this only says so.
      ClickedCopyLink: ({ messageId }) => ({ model: { ...model, overlay: null, notice: model.messages.some(message => message.id === messageId) ? 'Link copied to clipboard' : model.notice } }),
      ClickedSave: ({ messageId }) => {
        if (model.channel === null || !model.messages.some(message => message.id === messageId)) return { model }
        const saved = model.saved.includes(messageId) ? model.saved.filter(id => id !== messageId) : [...model.saved, messageId]
        return { model: { ...model, saved }, commands: [ToggleSaved({ messageId, memberId: model.me.id })] }
      },
      ClickedPin: ({ messageId }) =>
        pinnable(model, messageId) === undefined && !model.pins.some(pin => pin.id === messageId)
          ? { model }
          : canWrite(model) ? { model: { ...model, overlay: null }, commands: [TogglePin({ messageId, actorId: model.me.id })] } : { model },
      ClickedCloseOverlay: () => ({ model: { ...model, overlay: null } }),
      ClickedScheduleMenu: () =>
        sendable(model) === null
          ? { model }
          : { model: { ...model, notice: null, overlay: model.overlay?.kind === 'schedule' ? null : { kind: 'schedule', messageId: '', where: 'channel', anchor: SCHEDULE_ANCHOR } } },
      ClickedSchedule: ({ choice }) => {
        const text = sendable(model)
        if (text === null) return { model: { ...model, overlay: null } }
        return { model: { ...model, overlay: null, isSending: true }, commands: [ScheduleMessage({ channelId: model.channelId, text, files: model.uploads, actorId: model.me.id, choice })] }
      },
      SucceededSchedule: ({ label }) => ({ model: withFocus({ ...model, draft: '', uploads: [], isSending: false, notice: `Your message will be sent ${inSentence(label)}.` }, '#composer') }),
      ClickedRemindMenu: ({ messageId, where }) =>
        model.messages.some(message => message.id === messageId) ? { model: { ...model, overlay: { kind: 'remind', messageId, where, anchor: anchorOf(messageId, 'more', where) } } } : { model },
      ClickedRemind: ({ messageId, choice }) =>
        model.channel === null || !model.messages.some(message => message.id === messageId)
          ? { model: { ...model, overlay: null } }
          : { model: { ...model, overlay: null, saved: model.saved.includes(messageId) ? model.saved : [...model.saved, messageId] }, commands: [SetReminder({ messageId, memberId: model.me.id, choice })] },
      SetReminderFor: ({ notice }) => ({ model: { ...model, notice } }),
      ClickedSendScheduled: ({ id }) => (model.scheduled.some(item => item.id === id) && canWrite(model) ? { model, commands: [SendScheduled({ id, actorId: model.me.id, isNow: true })] } : { model }),
      ClickedCancelScheduled: ({ id }) => (model.scheduled.some(item => item.id === id) ? { model, commands: [SendScheduled({ id, actorId: model.me.id, isNow: false })] } : { model }),
      ClickedEdit: ({ messageId, where }) => startEdit(model, messageId, where),
      ClickedReplyInThread: ({ messageId }) => openThread(model, messageId),
      ClickedCloseThread: () => ({ model: withFocus({ ...model, thread: null, editing: model.editing?.where === 'thread' ? null : model.editing, overlay: model.overlay?.where === 'thread' ? null : model.overlay }, '#composer') }),
      ChangedThreadDraft: ({ text }) => changeReplyDraft(model, text),
      SubmittedThreadDraft: () => sendReply(model),
      ToggledAlsoSend: ({ isChecked }) => (model.thread === null ? { model } : { model: { ...model, thread: { ...model.thread, alsoSend: isChecked } } }),
      SucceededReply: () => ({ model: withFocus({ ...model, thread: model.thread === null ? null : { ...model.thread, draft: '', alsoSend: false, isSending: false, uploads: [] } }, '#thread-composer') }),
      ChangedEdit: ({ text }) => (model.editing === null ? { model } : { model: { ...model, editing: { ...model.editing, text: text.slice(0, MAX_MESSAGE + 100) } } }),
      SubmittedEdit: () => saveEdit(model),
      ClickedCancelEdit: () => ({ model: withFocus({ ...model, editing: null }, composerOf(model.editing?.where ?? 'channel')) }),
      ClickedDelete: ({ messageId }) => askDelete(model, messageId),
      ClickedConfirmDelete: () => {
        const messageId = model.deleting
        if (messageId === null || ownMessage(model, messageId) === undefined) return withConfirm({ ...model, deleting: null }, Dialog.close(model.confirm))
        const closed = withConfirm(model, Dialog.close(model.confirm))
        return { ...closed, commands: [...(closed.commands ?? []), DeleteMessage({ messageId, actorId: model.me.id })] }
      },
      GotConfirmDialog: ({ message }) => withConfirm(model, Dialog.update(model.confirm, message)),
      SucceededEdit: () => ({ model: withFocus({ ...model, editing: null }, composerOf(model.editing?.where ?? 'channel')) }),
      SucceededDelete: () => ({ model: withFocus(model, '#composer') }),
      GotSwitcher: ({ event }) => updateHost(model, event, event => Message.GotSwitcher({ event })),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedToggleSection: ({ section }) => ({
        model: { ...model, collapsed: model.collapsed.includes(section) ? model.collapsed.filter(id => id !== section) : [...model.collapsed, section].slice(-8) },
      }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      ChangedConnection: ({ isConnected }) => markRead({ model: { ...model, isConnected } }),
      GotChannel: slice => markRead({ model: withoutGone({ ...model, ...slice }) }),
      // Sent: the composer empties and the "New" line goes (you are up to date).
      SucceededSend: () => ({ model: { ...model, draft: '', uploads: [], isSending: false, readMarker: Number.MAX_SAFE_INTEGER, seq: model.seq + 1, focus: { selector: '#composer', seq: model.seq + 1 } } }),
      ClickedJoin: () => {
        const channel = model.channel
        if (channel === null || channel.kind !== 'public' || channel.isArchived || isMemberOf(channel, model.me.id) || model.isJoining) return { model }
        return { model: { ...model, isJoining: true }, commands: [JoinChannel({ channelId: channel.id, actorId: model.me.id })] }
      },
      SucceededJoin: () => ({ model: withFocus({ ...model, isJoining: false }, '#composer') }),
      ClickedOpenDetails: ({ tab, field }) => {
        if (model.channel === null || (model.channel.kind === 'dm' && (tab === 'about' || tab === 'members'))) return { model }
        const opened = withDetails({ ...model, overlay: null, about: { ...closedAbout, tab } }, Dialog.open(model.details))
        return field === null ? opened : { ...opened, model: editField(opened.model, field) }
      },
      GotDetailsDialog: ({ message }) => withDetails(model, Dialog.update(model.details, message)),
      ClickedDetailsTab: ({ tab }) => (model.channel?.kind === 'dm' && (tab === 'about' || tab === 'members') ? { model } : { model: { ...model, about: { ...model.about, tab, field: null, query: '' } } }),
      ClickedEditField: ({ field }) => ({ model: editField(model, field) }),
      ChangedField: ({ text }) => (model.about.field === null ? { model } : { model: { ...model, about: { ...model.about, value: text.slice(0, fieldMax[model.about.field] + 20) } } }),
      SubmittedField: () => saveField(model),
      ClickedCancelField: () => ({ model: { ...model, about: { ...model.about, field: null } } }),
      SucceededField: () => ({ model: { ...model, about: { ...model.about, field: null, isSaving: false } } }),
      ChangedPeopleQuery: ({ text }) => ({ model: { ...model, about: { ...model.about, query: text.slice(0, 80) } } }),
      ClickedAddPerson: ({ memberId }) => {
        const channel = ownChannel(model)
        if (channel === null || channel.isArchived || isMemberOf(channel, memberId) || !model.members.some(member => member.id === memberId)) return { model }
        return { model, commands: [AddToChannel({ channelId: channel.id, memberId, actorId: model.me.id })] }
      },
      ClickedLeave: () => {
        const channel = ownChannel(model)
        if (channel === null) return { model }
        if (channel.name === DEFAULT_CHANNEL) return { model: { ...model, notice: `Everyone stays in #${DEFAULT_CHANNEL}.` } }
        const closed = withDetails(model, Dialog.close(model.details))
        return { ...closed, commands: [...(closed.commands ?? []), LeaveChannel({ channelId: channel.id, actorId: model.me.id })] }
      },
      LeftChannel: () => ({ model, commands: [LoadUrl({ url: '/' })] }),
      ClickedMute: ({ isMuted: mute }) => {
        const channel = model.channel
        if (channel === null || !isMemberOf(channel, model.me.id) || isMuted(model.me, channel.id) === mute) return { model }
        return { model, commands: [SetMuted({ channelId: channel.id, isMuted: mute, memberId: model.me.id })] }
      },
      ClickedNotify: ({ level }) => {
        const channel = model.channel
        if (channel === null || !isMemberOf(channel, model.me.id) || notifyLevel(model.me, channel) === level) return { model }
        return { model, commands: [SetNotify({ channelId: channel.id, level, memberId: model.me.id })] }
      },
      ClickedStar: ({ isStarred: star }) => {
        const channel = model.channel
        if (channel === null || !isMemberOf(channel, model.me.id) || isStarred(model.me, channel.id) === star) return { model }
        return { model, commands: [SetStarred({ channelId: channel.id, isStarred: star, memberId: model.me.id })] }
      },
      ClickedArchive: ({ isArchived }) => {
        const channel = ownChannel(model)
        if (channel === null || channel.name === DEFAULT_CHANNEL || channel.isArchived === isArchived) return { model }
        const closed = withDetails(model, Dialog.close(model.details))
        return { ...closed, commands: [...(closed.commands ?? []), SetArchived({ channelId: channel.id, isArchived, actorId: model.me.id })] }
      },
      FailedChange: ({ reason }) => ({
        model: { ...model, isJoining: false, about: { ...model.about, isSaving: false }, isSending: false, editing: model.editing === null ? null : { ...model.editing, isSaving: false }, thread: model.thread === null ? null : { ...model.thread, isSending: false }, notice: reason },
      }),
      CompletedChange: () => ({ model }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

/** Every new focus request becomes a forwarded focus, and opening or closing a thread updates the address. */
export const update = (model: Model, message: Message): UpdateReturn => {
  const result = updateModel(model, message)
  const focus = result.model.focus
  const threadId = result.model.thread?.id ?? null
  const commands = [
    ...(result.commands ?? []),
    ...(focus !== null && focus.seq !== model.focus?.seq ? [FocusElement({ selector: focus.selector })] : []),
    ...(threadId !== (model.thread?.id ?? null) ? [ReplaceUrl({ url: urlOf(model.channelId, threadId) })] : []),
  ]
  return commands.length === (result.commands ?? []).length ? result : { ...result, commands }
}

// SUBSCRIPTION

type Slice = Readonly<{ channel: Channel | null; members: ReadonlyArray<Member>; messages: ReadonlyArray<ChatMessage>; older: number; pins: ReadonlyArray<ChatMessage>; shared: ReadonlyArray<ChatMessage>; scheduled: ReadonlyArray<Scheduled>; saved: ReadonlyArray<string>; nav: Nav; me: Member | null }>

const savedIn = (state: WorkspaceState, messages: ReadonlyArray<ChatMessage>, memberId: string): ReadonlyArray<string> => {
  const ids = new Set(messages.map(message => message.id))
  return state.saves.filter(saved => saved.memberId === memberId && saved.state === 'saved' && ids.has(saved.messageId)).map(saved => saved.messageId)
}

export const sliceOf = (state: WorkspaceState, channelId: string, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  const found = state.channels.find(channel => channel.id === channelId)
  const channel = found !== undefined && canRead(found, memberId) ? found : null
  const all = channel === null ? [] : state.messages.filter(message => message.channelId === channelId)
  const listed = all.filter(inChannel)
  // The newest messages, and the threads of those that started one.
  const shown = new Set(listed.slice(-SHOWN).map(message => message.id))
  return {
    channel,
    members: state.members,
    messages: all.filter(message => shown.has(message.id) || (message.threadId !== null && shown.has(message.threadId))),
    older: Math.max(0, listed.length - SHOWN),
    pins: listed.filter(message => message.pinnedBy !== undefined).reverse(),
    shared: all.filter(message => (message.files?.length ?? 0) > 0).reverse(),
    scheduled: channel === null ? [] : state.scheduled.filter(item => item.authorId === memberId && item.channelId === channelId).sort((a, b) => a.sendAt - b.sendAt),
    saved: channel === null ? [] : savedIn(state, all, memberId),
    nav: me === null ? emptyNav : navOf(state, me),
    me,
  }
}

const sameItems = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) => a.length === b.length && a.every((item, index) => item === b[index])

const sameSlice = (a: Slice, b: Slice) => a.channel === b.channel && a.members === b.members && sameItems(a.messages, b.messages) && sameItems(a.pins, b.pins) && sameItems(a.shared, b.shared) && sameItems(a.scheduled, b.scheduled) && a.saved.join() === b.saved.join() && sameNav(a.nav, b.nav) && a.me === b.me

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  presence: entry(
    { memberId: S.String, isConnected: S.Boolean },
    { modelToDependencies: model => ({ memberId: model.me.id, isConnected: model.isConnected }), dependenciesToStream: ({ memberId, isConnected }) => presenceWhile(memberId, isConnected) },
  ),
  typing: entry(
    { channelId: S.String, memberId: S.String },
    {
      modelToDependencies: model => ({ channelId: model.channelId, memberId: model.me.id }),
      dependenciesToStream: ({ channelId, memberId }) =>
        Stream.unwrap(Workspace.use(workspace => Effect.succeed(workspace.typing.pipe(
          Stream.map(typists => typingIn(typists, channelId, memberId)),
          Stream.changesWith(sameIds),
          Stream.map(memberIds => Message.GotTyping({ memberIds })),
        )))),
    },
  ),
  threadTyping: entry(
    { key: S.String, memberId: S.String },
    {
      modelToDependencies: model => ({ key: model.thread === null ? '' : threadTypingKey(model.channelId, model.thread.id), memberId: model.me.id }),
      dependenciesToStream: ({ key, memberId }) =>
        key === ''
          ? Stream.make(Message.GotThreadTyping({ memberIds: [] }))
          : Stream.unwrap(Workspace.use(workspace => Effect.succeed(workspace.typing.pipe(
              Stream.map(typists => typingIn(typists, key, memberId)),
              Stream.changesWith(sameIds),
              Stream.map(memberIds => Message.GotThreadTyping({ memberIds })),
            )))),
    },
  ),
  channel: entry(
    { channelId: S.String, memberId: S.String },
    {
      modelToDependencies: model => ({ channelId: model.channelId, memberId: model.me.id }),
      dependenciesToStream: ({ channelId, memberId }) =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => sliceOf(state, channelId, memberId)),
                Stream.changesWith(sameSlice),
                Stream.filter((slice): slice is Slice & { me: Member } => slice.me !== null),
                Stream.mapEffect(slice => Effect.map(Clock.currentTimeMillis, now => Message.GotChannel({ ...slice, now }))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

type Row =
  | Readonly<{ _tag: 'day'; day: string; at: number }>
  | Readonly<{ _tag: 'new' }>
  | Readonly<{ _tag: 'message'; message: ChatMessage; isFirst: boolean }>

/** Messages in order with day dividers, the "New" line, and whether each
 *  starts a run by its author (Slack groups within 5 minutes). */
export const rowsOf = (messages: ReadonlyArray<ChatMessage>, readMarker: number, meId: string, viewer?: Viewer): ReadonlyArray<Row> => {
  const rows: Array<Row> = []
  let previous: ChatMessage | undefined
  let markedNew = false
  for (const message of messages) {
    const day = dayOf(message.createdAt, viewer)
    const dayChanged = previous === undefined || dayOf(previous.createdAt, viewer) !== day
    if (dayChanged) rows.push({ _tag: 'day', day, at: message.createdAt })
    const isNew = !markedNew && message.createdAt > readMarker && message.authorId !== meId
    if (isNew) {
      rows.push({ _tag: 'new' })
      markedNew = true
    }
    const isFirst = dayChanged || isNew || previous?.authorId !== message.authorId || previous.threadId !== message.threadId || message.createdAt - (previous?.createdAt ?? 0) > 5 * 60_000
    rows.push({ _tag: 'message', message, isFirst })
    previous = message
  }
  return rows
}

const reactedBy = (model: Model, memberIds: ReadonlyArray<string>) => {
  const names = memberIds.map(id => (id === model.me.id ? 'You' : (model.members.find(member => member.id === id)?.name ?? 'Someone')))
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

const reactionsView = (model: Model, message: ChatMessage, where: Where, h: HtmlBuilder<Message>): Html =>
  box({ class: 'mt-1 flex flex-wrap items-center gap-1', attributes: [h.AriaLabel('Reactions')], children: [
      ...message.reactions.map(reaction => {
        const isMine = reaction.memberIds.includes(model.me.id)
        return button({
          variant: isMine ? 'reaction-mine' : 'reaction',
          size: 'xs',
          title: `${reactedBy(model, reaction.memberIds)} reacted with :${emojiName(reaction.emoji)}:`,
          ariaLabel: `${reaction.memberIds.length} ${reaction.memberIds.length === 1 ? 'reaction' : 'reactions'}, react with :${emojiName(reaction.emoji)}:${isMine ? ' (yours)' : ''}`,
          onClick: Message.ClickedReaction({ messageId: message.id, emoji: reaction.emoji }),
          isPressed: isMine,
          marker: ['reaction', reaction.emoji],
          children: [box({ as: 'span', class: 'text-[15px] leading-none', children: [reaction.emoji] }, h), String(reaction.memberIds.length)],
        }, h)
      }),
      button({
        variant: 'reaction',
        size: 'xs',
        ariaLabel: 'Add reaction',
        title: 'Add reaction',
        onClick: Message.ClickedAddReaction({ messageId: message.id, from: 'reactions', where }),
        anchorName: anchorOf(message.id, 'reactions', where),
        popup: 'dialog',
        children: [Icon.icon('smile-plus', { class: 'size-3.5' }, h)],
      }, h),
    ] }, h)

const toolbarView = (model: Model, message: ChatMessage, where: Where, h: HtmlBuilder<Message>): Html => {
  const isMine = message.authorId === model.me.id
  const isMenuOpen = model.overlay?.kind === 'actions' && model.overlay.messageId === message.id && model.overlay.where === where
  return box({ class: slack.messageActions, attributes: [h.Role('toolbar'), h.AriaLabel('Message actions')], children: [
      ...(canWrite(model)
        ? [
            ...QUICK_REACTIONS.map(emoji =>
              button({ variant: 'emoji', size: 'icon-sm', ariaLabel: `React with :${emojiName(emoji)}:`, title: `:${emojiName(emoji)}:`, onClick: Message.ClickedReaction({ messageId: message.id, emoji }), children: [box({ as: 'span', class: 'text-[16px] leading-none', children: [emoji] }, h)] }, h),
            ),
            button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Find another reaction', title: 'Find another reaction', onClick: Message.ClickedAddReaction({ messageId: message.id, from: 'toolbar', where }), anchorName: anchorOf(message.id, 'toolbar', where), popup: 'dialog', children: [Icon.icon('smile-plus', {}, h)] }, h),
            ...(where === 'channel'
              ? [button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Reply in thread', title: 'Reply in thread', onClick: Message.ClickedReplyInThread({ messageId: message.id }), children: [Icon.icon('message-square-text', {}, h)] }, h)]
              : []),
          ]
        : []),
      button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: model.saved.includes(message.id) ? 'Remove from saved items' : 'Save for later', title: model.saved.includes(message.id) ? 'Remove from saved items' : 'Save for later', isPressed: model.saved.includes(message.id), onClick: Message.ClickedSave({ messageId: message.id }), children: [Icon.bookmark({ class: model.saved.includes(message.id) ? 'fill-current' : '' }, h)] }, h),
      ...(isMine ? [button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Edit message', title: 'Edit message', onClick: Message.ClickedEdit({ messageId: message.id, where }), children: [Icon.icon('pencil', {}, h)] }, h)] : []),
      ...(isMine || (where === 'channel' && unreadable(model, message.id) !== undefined)
        ? [
            button({ id: `${where}-more-${message.id}`, variant: 'toolbar', size: 'icon-sm', ariaLabel: 'More actions', title: 'More actions', onClick: Message.ClickedMore({ messageId: message.id, where }), anchorName: anchorOf(message.id, 'more', where), popup: 'menu', isExpanded: isMenuOpen, children: [Icon.icon('ellipsis-vertical', {}, h)] }, h),
          ]
        : []),
    ] }, h)
}

const editView = (editing: NonNullable<Model['editing']>, h: HtmlBuilder<Message>): Html =>
  box({ as: 'form', class: slack.composer, attributes: [h.DataAttribute('inline', ''), h.OnSubmit(Message.SubmittedEdit())], children: [
      textarea({ id: 'edit-composer', value: editing.text, rows: 1, onInput: text => Message.ChangedEdit({ text }), ariaLabel: 'Edit message', resize: 'none', variant: 'slack-composer' }, h),
      box({ class: 'flex items-center justify-end gap-2 px-2 pb-2', children: [
          button({ variant: 'outline', size: 'sm', onClick: Message.ClickedCancelEdit(), children: ['Cancel'] }, h),
          button({ variant: 'send', size: 'sm', type: 'submit', isDisabled: editing.isSaving, children: ['Save'] }, h),
        ] }, h),
    ] }, h)

/** Who replied in a thread and when last: Slack's reply bar. */
export type ThreadSummary = Readonly<{ count: number; lastAt: number; replierIds: ReadonlyArray<string> }>

export const summaryOf = (replies: ReadonlyArray<ChatMessage>): ThreadSummary | null => {
  const last = replies.at(-1)
  if (last === undefined) return null
  return { count: replies.length, lastAt: last.createdAt, replierIds: [...new Set(replies.map(reply => reply.authorId))].slice(0, 5) }
}

const summaryView = (model: Model, message: ChatMessage, summary: ThreadSummary, h: HtmlBuilder<Message>): Html =>
  button({
    variant: 'thread-summary',
    size: 'sm',
    ariaLabel: `${summary.count} ${summary.count === 1 ? 'reply' : 'replies'}, open thread`,
    onClick: Message.ClickedReplyInThread({ messageId: message.id }),
    isPressed: model.thread?.id === message.id,
    children: [
      box({ class: 'flex gap-1', children: summary.replierIds.map(id => avatar(model.members.find(member => member.id === id), h, 'sm')) }, h),
      box({ as: 'span', class: 'font-bold text-link', children: [`${summary.count} ${summary.count === 1 ? 'reply' : 'replies'}`] }, h),
      box({ as: 'span', children: [`Last reply ${dayLabel(summary.lastAt, model.now, model.me).toLowerCase()} at ${formatTime(summary.lastAt, model.me)}`] }, h),
    ],
  }, h)

/** A reply also sent to the channel says which thread it answers. */
const repliedToView = (model: Model, message: ChatMessage, h: HtmlBuilder<Message>): Html => {
  const parent = model.messages.find(candidate => candidate.id === message.threadId)
  return button({
    variant: 'replied-to',
    size: 'xs',
    onClick: Message.ClickedReplyInThread({ messageId: message.id }),
    children: [
      box({ as: 'span', class: 'text-muted-foreground', children: ['replied to a thread: '] }, h),
      box({ as: 'span', class: 'min-w-0 truncate', children: [parent === undefined ? 'a deleted message' : parent.text] }, h),
    ],
  }, h)
}

const messageView = (model: Model, message: ChatMessage, isFirst: boolean, where: Where, summary: ThreadSummary | null, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === message.authorId)
  const editing = model.editing !== null && model.editing.id === message.id && model.editing.where === where ? model.editing : null
  const isActive = model.overlay !== null && model.overlay.messageId === message.id && model.overlay.where === where
  const isSaved = model.saved.includes(message.id)
  const pinner = message.pinnedBy === undefined || where === 'thread' ? undefined : (model.members.find(member => member.id === message.pinnedBy)?.name ?? 'Someone')
  return box({ as: 'li', class: slack.messageRow, attributes: [
      h.Key(message.id),
      h.Id(`${where === 'thread' ? 'thread-' : ''}message-${message.id}`),
      h.DataAttribute('author', message.authorId),
      ...(isFirst && editing === null ? [] : [h.DataAttribute('continued', '')]),
      ...(isActive ? [h.DataAttribute('active', '')] : []),
      ...(editing === null ? [] : [h.DataAttribute('editing', '')]),
      ...(isSaved || pinner !== undefined ? [h.DataAttribute('highlight', '')] : []),
    ], children: [
      ...(isSaved || pinner !== undefined
        ? [box({ class: slack.messageLabels, children: [
            ...(pinner === undefined ? [] : [box({ as: 'span', class: 'flex items-center gap-1', attributes: [h.DataAttribute('pinned-label', '')], children: [Icon.icon('pin', { class: 'size-3' }, h), `Pinned by ${pinner}`] }, h)]),
            ...(isSaved ? [box({ as: 'span', class: 'flex items-center gap-1 text-link', attributes: [h.DataAttribute('saved-label', '')], children: [Icon.bookmark({ class: 'size-3 fill-current' }, h), 'Saved for later'] }, h)] : []),
          ] }, h)]
        : []),
      // Compact display (Preferences) drops the pictures; the time shows on hover instead.
      box({ class: slack.messageGutter, children: isFirst && !preferencesOf(model.me).isCompact ? [avatar(author, h, 'md')] : isFirst ? [] : [box({ as: 'span', class: slack.messageHoverTime, children: [formatTime(message.createdAt, model.me)] }, h)] }, h),
      box({ class: 'min-w-0 flex-1', children: [
          ...(where === 'channel' && message.threadId !== null ? [repliedToView(model, message, h)] : []),
          ...(isFirst
            ? [box({ class: 'flex items-baseline gap-2', children: [authorName(author, model.now, h), box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [formatTime(message.createdAt, model.me)] }, h)] }, h)]
            : []),
          ...(editing !== null
            ? [editView(editing, h)]
            : [
                box({ class: slack.messageText, attributes: [h.DataAttribute('message-text', '')], children: [
                    ...messageText(message.text, model.members, h),
                    ...(message.editedAt === null ? [] : [box({ as: 'span', class: 'ml-1 text-[12px] text-muted-foreground', attributes: [h.Title(`Edited ${formatTime(message.editedAt, model.me)}`)], children: ['(edited)'] }, h)]),
                  ] }, h),
                ...attachmentList(message.files, h),
                ...(message.reactions.length === 0 ? [] : [reactionsView(model, message, where, h)]),
                ...(summary === null ? [] : [summaryView(model, message, summary, h)]),
              ]),
        ] }, h),
      ...(editing === null ? [toolbarView(model, message, where, h)] : []),
    ] }, h)
}

const emojiPicker = (model: Model, anchor: string, h: HtmlBuilder<Message>): Html => {
  const found = searchEmoji(model.emojiQuery)
  const groups = [...new Set(found.map(emoji => emoji.group))]
  return box({ class: 'z-50 flex min-w-[340px] max-w-[340px] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]', style: anchoredStyle(anchor, { side: 'top', align: 'end' }), attributes: [h.Id('emoji-picker'), h.Role('dialog'), h.AriaLabel('Emoji picker')], children: [
      box({ class: 'border-b p-2', children: [
          input({ id: 'emoji-search', value: model.emojiQuery, placeholder: 'Search all emoji', ariaLabel: 'Search all emoji', autocomplete: 'off', onInput: text => Message.ChangedEmojiQuery({ text }), variant: 'dense' }, h),
        ] }, h),
      box({ class: 'max-h-[280px] min-h-0 overflow-y-auto p-2', children: found.length === 0
          ? [box({ class: 'py-6 text-center text-[13px] text-muted-foreground', children: ['No emoji match'] }, h)]
          : groups.map(group =>
              box({ as: 'section', attributes: [h.AriaLabel(group)], children: [
                  box({ class: 'px-1 pt-1 pb-1 text-[12px] font-semibold text-muted-foreground', children: [group] }, h),
                  box({ class: 'grid grid-cols-9 gap-0.5', children: found.filter(emoji => emoji.group === group).map(emoji =>
                      button({ variant: 'emoji', size: 'icon-md', ariaLabel: `:${emoji.name}:`, title: `:${emoji.name}:`, onClick: Message.ClickedEmoji({ emoji: emoji.glyph }), marker: ['emoji', emoji.name], children: [emoji.glyph] }, h),
                    ) }, h),
                ] }, h),
            ) }, h),
    ] }, h)
}

const actionsMenu = (model: Model, messageId: string, where: Where, anchor: string, h: HtmlBuilder<Message>): Html => {
  const isMine = ownMessage(model, messageId) !== undefined
  return box({ class: 'z-50 flex w-56 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]', style: anchoredStyle(anchor, { side: 'bottom', align: 'end' }), attributes: [h.Id('message-menu'), h.Role('menu'), h.AriaLabel('Message actions')], children: [
      ...(where === 'channel' && unreadable(model, messageId) !== undefined
        ? [optionRow({ id: 'menu-unread', value: 'unread', isActive: false, onClick: Message.ClickedMarkUnread({ messageId }), children: [Icon.icon('mail', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: ['Mark unread'] }, h)] }, h)]
        : []),
      ...(where === 'channel' && pinnable(model, messageId) !== undefined
        ? [optionRow({ id: 'menu-pin', value: 'pin', isActive: false, onClick: Message.ClickedPin({ messageId }), children: [Icon.icon(model.pins.some(pin => pin.id === messageId) ? 'x' : 'pin', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: [model.pins.some(pin => pin.id === messageId) ? 'Un-pin from this conversation' : 'Pin to this conversation'] }, h)] }, h)]
        : []),
      optionRow({ id: 'menu-remind', value: 'remind', isActive: false, onClick: Message.ClickedRemindMenu({ messageId, where }), children: [Icon.icon('alarm-clock', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: ['Remind me about this'] }, h), Icon.icon('chevron-right', { class: 'size-4 text-muted-foreground' }, h)] }, h),
      optionRow({ id: 'menu-copy-link', value: 'copy-link', isActive: false, onClick: Message.ClickedCopyLink({ messageId }), copyPath: `/archives/${model.channelId}/${messageId}`, children: [Icon.icon('link', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: ['Copy link'] }, h)] }, h),
      ...(isMine ? [optionRow({ id: 'menu-edit', value: 'edit', isActive: false, onClick: Message.ClickedEdit({ messageId, where }), children: [Icon.icon('pencil', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: ['Edit message'] }, h)] }, h),
      optionRow({ id: 'menu-delete', value: 'delete', isActive: false, onClick: Message.ClickedDelete({ messageId }), children: [Icon.icon('trash-2', { class: 'size-4 text-destructive' }, h), box({ as: 'span', class: 'flex-1 text-destructive', children: ['Delete message…'] }, h)] }, h)] : []),
    ] }, h)
}

const whenRow = (model: Model, id: string, when: WhenChoice, onClick: Message, h: HtmlBuilder<Message>): Html =>
  optionRow({ id, value: when, isActive: false, onClick, children: [box({ as: 'span', class: 'flex-1', children: [choiceLabel(when, model.now, model.me)] }, h)] }, h)

/** Slack's "Schedule for later" and "Remind me about this" menus. */
const whenMenu = (model: Model, kind: 'schedule' | 'remind', messageId: string, anchor: string, h: HtmlBuilder<Message>): Html =>
  box({ class: 'z-50 flex w-64 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]', style: anchoredStyle(anchor, { side: kind === 'schedule' ? 'top' : 'bottom', align: 'end' }), attributes: [h.Id(kind === 'schedule' ? 'schedule-menu' : 'remind-menu'), h.Role('menu'), h.AriaLabel(kind === 'schedule' ? 'Schedule message' : 'Remind me about this')], children: [
      box({ class: 'px-2 pt-1.5 pb-1 text-[13px] font-semibold text-muted-foreground', children: [kind === 'schedule' ? 'Schedule message' : 'Remind me about this'] }, h),
      ...(kind === 'schedule'
        ? SCHEDULE_CHOICES.map(when => whenRow(model, `schedule-${when}`, when, Message.ClickedSchedule({ choice: when }), h))
        : REMIND_CHOICES.map(when => whenRow(model, `remind-${when}`, when, Message.ClickedRemind({ messageId, choice: when }), h))),
    ] }, h)

const overlayView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: 'contents', attributes: [h.Id('overlay')], children: model.overlay === null
      ? []
      : [
          box({ class: 'fixed inset-0 z-40', attributes: [h.AriaHidden(true), h.OnClick(Message.ClickedCloseOverlay())] }, h),
          model.overlay.kind === 'emoji'
            ? emojiPicker(model, model.overlay.anchor, h)
            : model.overlay.kind === 'schedule' || model.overlay.kind === 'remind'
              ? whenMenu(model, model.overlay.kind, model.overlay.messageId, model.overlay.anchor, h)
              : actionsMenu(model, model.overlay.messageId, model.overlay.where, model.overlay.anchor, h),
        ] }, h)

const fieldLabel: Record<DetailsField, string> = { name: 'Channel name', topic: 'Topic', description: 'Description' }

const aboutField = (model: Model, channel: Channel, field: DetailsField, slots: Dialog.DialogSlots, h: HtmlBuilder<Message>): Html => {
  const value = fieldValue(channel, field)
  const canEdit = isMemberOf(channel, model.me.id) && !channel.isArchived && !(field === 'name' && channel.name === DEFAULT_CHANNEL)
  return box({ class: 'flex flex-col gap-1 border-b px-4 py-3 last:border-b-0', attributes: [h.DataAttribute('detail', field)], children: model.about.field === field
      ? [box({ as: 'form', class: 'flex flex-col gap-2', attributes: [h.OnSubmit(Message.SubmittedField())], children: [
          box({ as: 'label', class: 'text-[14px] font-bold', attributes: [h.For('detail-field')], children: [fieldLabel[field]] }, h),
          input({ id: 'detail-field', value: model.about.value, autocomplete: 'off', initialFocus: slots.initialFocusAttributes(), ariaLabel: fieldLabel[field], onInput: text => Message.ChangedField({ text }) }, h),
          box({ class: 'flex justify-end gap-2', children: [
              button({ variant: 'outline', size: 'sm', onClick: Message.ClickedCancelField(), children: ['Cancel'] }, h),
              button({ id: 'save-detail', variant: 'join', size: 'sm', type: 'submit', isDisabled: model.about.isSaving, children: ['Save'] }, h),
            ] }, h),
        ] }, h)]
      : [box({ class: 'flex items-center gap-2', children: [
            box({ as: 'span', class: 'flex-1 text-[14px] font-bold', children: [fieldLabel[field]] }, h),
            ...(canEdit ? [button({ variant: 'link', size: 'xs', ariaLabel: `Edit ${fieldLabel[field].toLowerCase()}`, onClick: Message.ClickedEditField({ field }), children: ['Edit'] }, h)] : []),
          ] }, h),
        box({ as: 'p', class: value === '' ? 'text-[14px] text-muted-foreground' : 'min-w-0 text-[14px] break-words', children: [value === '' ? (field === 'topic' ? 'Add a topic' : field === 'description' ? 'Add a description' : '') : field === 'name' ? `#${value}` : value] }, h)] }, h)
}

const memberRow = (member: Member, trailing: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  box({ as: 'li', class: 'flex items-center gap-2.5 rounded-md px-2 py-1.5', attributes: [h.Key(member.id), h.DataAttribute('person', member.id)], children: [
      avatar(member, h, 'md'),
      box({ class: 'flex min-w-0 flex-1 flex-col', children: [box({ as: 'span', class: 'min-w-0 truncate text-[15px] font-bold', children: [member.name] }, h), box({ as: 'span', class: 'min-w-0 truncate text-[13px] text-muted-foreground', children: [member.title] }, h)] }, h),
      ...trailing,
    ] }, h)

const membersTab = (model: Model, channel: Channel, h: HtmlBuilder<Message>): Html => {
  const query = model.about.query.trim().toLowerCase()
  const matches = (member: Member) => query === '' || member.name.toLowerCase().includes(query) || member.email.toLowerCase().includes(query)
  const canAdd = isMemberOf(channel, model.me.id) && !channel.isArchived
  const inside = model.members.filter(member => isMemberOf(channel, member.id) && matches(member))
  const outside = canAdd && query !== '' ? model.members.filter(member => !isMemberOf(channel, member.id) && matches(member)) : []
  return box({ class: 'flex flex-col gap-3', children: [
      input({ id: 'people-query', type: 'search', value: model.about.query, placeholder: canAdd ? 'Find or add people' : 'Find members', ariaLabel: canAdd ? 'Find or add people' : 'Find members', autocomplete: 'off', onInput: text => Message.ChangedPeopleQuery({ text }) }, h),
      box({ as: 'ul', class: 'flex max-h-[320px] flex-col overflow-y-auto', attributes: [h.Id('channel-people'), h.AriaLabel('Members')], children: [
          ...inside.map(member => memberRow(member, member.id === model.me.id ? [box({ as: 'span', class: 'text-[13px] text-muted-foreground', children: ['you'] }, h)] : [], h)),
          ...outside.map(member => memberRow(member, [button({ variant: 'outline', size: 'xs', ariaLabel: `Add ${member.name}`, onClick: Message.ClickedAddPerson({ memberId: member.id }), children: ['Add'] }, h)], h)),
          ...(inside.length === 0 && outside.length === 0 ? [box({ as: 'li', class: 'py-6 text-center text-[14px] text-muted-foreground', children: ['No one matches.'] }, h)] : []),
        ] }, h),
    ] }, h)
}

const pinsTab = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ as: 'ul', class: 'flex max-h-[360px] flex-col gap-2 overflow-y-auto', attributes: [h.Id('pinned-messages'), h.AriaLabel('Pinned messages')], children: model.pins.length === 0
      ? [box({ as: 'li', class: 'py-6 text-center text-[14px] text-muted-foreground', children: ['Nothing is pinned yet. Pin a message from its ⋮ menu.'] }, h)]
      : model.pins.map(pin => {
          const author = model.members.find(member => member.id === pin.authorId)
          return box({ as: 'li', class: 'flex gap-2 rounded-lg border p-3', attributes: [h.DataAttribute('pin', pin.id)], children: [
              avatar(author, h, 'md'),
              box({ class: 'min-w-0 flex-1', children: [
                  box({ class: 'flex items-baseline gap-2', children: [authorName(author, model.now, h, 'text-[14px]'), box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [`${dayLabel(pin.createdAt, model.now, model.me)} at ${formatTime(pin.createdAt, model.me)}`] }, h)] }, h),
                  box({ class: slack.messageText, children: messageText(pin.text, model.members, h) }, h),
                ] }, h),
              ...(canWrite(model) ? [button({ variant: 'ghost', size: 'icon-sm', ariaLabel: 'Un-pin', title: 'Un-pin', onClick: Message.ClickedPin({ messageId: pin.id }), children: [Icon.icon('x', {}, h)] }, h)] : []),
            ] }, h)
        }) }, h)

const fileCount = (model: Model): number => model.shared.reduce((count, message) => count + (message.files?.length ?? 0), 0)

/** Slack's Files tab: every file shared in the conversation, newest first. */
const filesTab = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ as: 'ul', class: 'flex max-h-[360px] flex-col gap-2 overflow-y-auto', attributes: [h.Id('shared-files'), h.AriaLabel('Files in this conversation'), h.DataAttribute('keep-scroll', 'shared-files')], children: model.shared.length === 0
      ? [box({ as: 'li', class: 'py-6 text-center text-[14px] text-muted-foreground', children: ['No files have been shared here yet.'] }, h)]
      : model.shared.flatMap(message => {
          const author = model.members.find(member => member.id === message.authorId)
          return (message.files ?? []).map(file =>
            box({ as: 'li', class: 'flex items-center gap-3 rounded-lg border p-2', attributes: [h.Key(`${message.id}-${file.id}`), h.DataAttribute('shared-file', file.id)], children: [
                isImage(file)
                  ? box({ as: 'img', class: 'size-10 shrink-0 rounded-md object-cover', attributes: [h.Src(fileUrl(file)), h.Alt('')] }, h)
                  : box({ as: 'span', class: 'flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground', children: [Icon.icon('file', { class: 'size-5' }, h)] }, h),
                box({ class: 'min-w-0 flex-1', children: [
                    box({ as: 'a', class: 'block min-w-0 truncate text-[15px] font-bold hover:underline', attributes: isImage(file) ? [h.Href(fileUrl(file)), h.Target('_blank'), h.Rel('noopener noreferrer')] : [h.Href(fileUrl(file)), h.Attribute('download', file.name)], children: [file.name] }, h),
                    box({ class: 'min-w-0 truncate text-[13px] text-muted-foreground', children: [`${author?.name ?? 'Someone'} · ${dayLabel(message.createdAt, model.now, model.me)} · ${formatSize(file.size)}`] }, h),
                  ] }, h),
                box({ as: 'a', class: 'shrink-0 text-[13px] font-semibold text-primary hover:underline', attributes: [h.Href(`/archives/${message.channelId}/${message.id}`), h.DataAttribute('file-message', message.id)], children: ['View message'] }, h),
              ] }, h))
        }) }, h)

/** Your messages scheduled here: send now or cancel (Slack's Scheduled list). */
const scheduledTab = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ as: 'ul', class: 'flex max-h-[360px] flex-col gap-2 overflow-y-auto', attributes: [h.Id('scheduled-list'), h.AriaLabel('Scheduled messages'), h.DataAttribute('keep-scroll', 'scheduled-list')], children: model.scheduled.length === 0
      ? [box({ as: 'li', class: 'py-6 text-center text-[14px] text-muted-foreground', children: ['Nothing is scheduled here.'] }, h)]
      : model.scheduled.map(item =>
          box({ as: 'li', class: 'flex flex-col gap-1 rounded-lg border p-3', attributes: [h.Key(item.id), h.DataAttribute('scheduled', item.id)], children: [
              box({ class: 'flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground', children: [Icon.icon('clock', { class: 'size-4' }, h), `Sends ${inSentence(whenLabel(item.sendAt, model.now, model.me))}`] }, h),
              box({ class: 'min-w-0 break-words text-[15px]', children: [item.text === '' ? `${item.files?.length ?? 0} file${(item.files?.length ?? 0) === 1 ? '' : 's'}` : item.text] }, h),
              ...((item.files?.length ?? 0) > 0 && item.text !== '' ? [box({ class: 'text-[13px] text-muted-foreground', children: [`${item.files?.length ?? 0} file${(item.files?.length ?? 0) === 1 ? '' : 's'} attached`] }, h)] : []),
              box({ class: 'flex justify-end gap-2', children: [
                  button({ id: `cancel-scheduled-${item.id}`, variant: 'outline', size: 'sm', onClick: Message.ClickedCancelScheduled({ id: item.id }), children: ['Cancel'] }, h),
                  button({ id: `send-scheduled-${item.id}`, variant: 'default', size: 'sm', isDisabled: !canWrite(model), onClick: Message.ClickedSendScheduled({ id: item.id }), children: ['Send now'] }, h),
                ] }, h),
            ] }, h),
        ) }, h)

const NOTIFY_CHOICES: ReadonlyArray<Readonly<{ level: NotifyLevel; label: string; description: string; icon: Icon.IconName }>> = [
  { level: 'all', label: 'All new messages', description: 'Every unread message counts on the badge', icon: 'bell' },
  { level: 'mentions', label: 'Mentions', description: 'Only @mentions of you, @here and @channel', icon: 'at-sign' },
  { level: 'nothing', label: 'Nothing', description: 'No badge and nothing in Activity', icon: 'bell-off' },
]

const notifySettings = (model: Model, channel: Channel, h: HtmlBuilder<Message>): Html => {
  const level = notifyLevel(model.me, channel)
  return box({ as: 'section', class: 'grid gap-2', attributes: [h.Id('notify-settings'), h.AriaLabel('Notifications')], children: [
      text({ children: ['Notify me about'], type: 'body', weight: 'semibold' }, h),
      box({ class: 'grid grid-cols-1 gap-2', attributes: [h.Role('group'), h.AriaLabel('Notify me about')], children: NOTIFY_CHOICES.map(option =>
          choice({ id: `notify-${option.level}`, isActive: option.level === level, onPick: Message.ClickedNotify({ level: option.level }), label: option.label, description: option.description, media: [Icon.icon(option.icon, {}, h)] }, h)) }, h),
    ] }, h)
}

const detailsDialog = (model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channel
  if (channel === null) return box({}, h)
  const creator = model.members.find(member => member.id === channel.createdBy)
  const isMember = isMemberOf(channel, model.me.id)
  const tab = (id: DetailsTab, label: string) =>
    button({ variant: model.about.tab === id ? 'tab-active' : 'tab', size: 'tab', isPressed: model.about.tab === id, onClick: Message.ClickedDetailsTab({ tab: id }), children: [label] }, h)
  const filesTabs = [...(model.shared.length === 0 ? [] : [tab('files', `Files ${fileCount(model)}`)]), ...(model.scheduled.length === 0 ? [] : [tab('scheduled', `Scheduled ${model.scheduled.length}`)])]
  return Dialog.dialog({
    model: model.details,
    toParentMessage: message => Message.GotDetailsDialog({ message }),
    title: channel.kind === 'dm' ? titleOf(model) : `${channel.kind === 'private' ? '' : '#'}${channel.name}`,
    content: slots => [
      box({ class: 'flex flex-col gap-4', attributes: [h.Id('details-body')], children: [
          box({ class: 'flex items-center gap-1', attributes: [h.AriaLabel('Details tabs')], children: channel.kind === 'dm' ? [tab('pins', `Pins ${model.pins.length}`), ...filesTabs, tab('settings', 'Settings')] : [tab('about', 'About'), tab('members', `Members ${channel.memberIds.length}`), ...(model.pins.length === 0 ? [] : [tab('pins', `Pins ${model.pins.length}`)]), ...filesTabs, ...(isMember ? [tab('settings', 'Settings')] : [])] }, h),
          model.about.tab === 'scheduled'
            ? scheduledTab(model, h)
            : model.about.tab === 'files'
            ? filesTab(model, h)
            : model.about.tab === 'settings' && isMember
            ? box({ class: 'flex flex-col gap-4', children: [
                notifySettings(model, channel, h),
                ...(channel.kind === 'dm' ? [] : channel.name === DEFAULT_CHANNEL
                  ? [box({ as: 'p', class: 'text-[14px] text-muted-foreground', children: [`#${DEFAULT_CHANNEL} includes everyone and cannot be archived.`] }, h)]
                  : [button({ id: 'archive-channel', variant: 'danger-text', onClick: Message.ClickedArchive({ isArchived: !channel.isArchived }), leadingIcon: Icon.icon('archive', {}, h), children: [channel.isArchived ? 'Unarchive channel' : 'Archive channel for everyone'] }, h)]),
              ] }, h)
            : model.about.tab === 'pins' || channel.kind === 'dm'
            ? pinsTab(model, h)
            : model.about.tab === 'members'
              ? membersTab(model, channel, h)
              : box({ class: 'flex flex-col gap-3', children: [
                  box({ class: 'rounded-lg border', children: [aboutField(model, channel, 'name', slots, h), aboutField(model, channel, 'topic', slots, h), aboutField(model, channel, 'description', slots, h),
                      box({ class: 'px-4 py-3', children: [box({ as: 'p', class: 'text-[14px] font-bold', children: ['Created by'] }, h), box({ as: 'p', class: 'text-[14px]', children: [`${creator?.name ?? 'Someone'} on ${dayLabel(channel.createdAt, model.now, model.me)}`] }, h)] }, h)] }, h),
                  ...(isMember && channel.name !== DEFAULT_CHANNEL ? [button({ id: 'leave-channel', variant: 'danger-text', onClick: Message.ClickedLeave(), leadingIcon: Icon.icon('log-out', {}, h), children: [`Leave ${channel.kind === 'private' ? '' : '#'}${channel.name}`] }, h)] : []),
                ] }, h),
        ] }, h),
    ],
  }, h)
}

const confirmDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Dialog.dialog(
    {
      model: model.confirm,
      toParentMessage: message => Message.GotConfirmDialog({ message }),
      title: 'Delete message',
      description:
        model.messages.some(message => message.threadId !== null && message.threadId === model.deleting)
          ? 'Are you sure you want to delete this message and its thread? This cannot be undone.'
          : 'Are you sure you want to delete this message? This cannot be undone.',
      content: () => {
        const message = model.messages.find(candidate => candidate.id === model.deleting)
        return message === undefined ? [] : [box({ class: 'max-h-40 overflow-hidden rounded-md border px-3 py-2 text-[15px]', children: messageText(message.text, model.members, h) }, h)]
      },
      footer: () => [
        button({ variant: 'outline', onClick: Message.GotConfirmDialog({ message: Dialog.Message.RequestedClose() }), children: ['Cancel'] }, h),
        button({ id: 'confirm-delete-button', variant: 'danger', onClick: Message.ClickedConfirmDelete(), children: ['Delete'] }, h),
      ],
    },
    h,
  )

/** The top of a conversation's history: Slack's channel or DM introduction. */
const introView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channel
  if (channel === null) return box({}, h)
  if (channel.kind === 'dm') {
    const partners = dmPartners(channel, model.me.id).map(id => model.members.find(member => member.id === id))
    return box({ as: 'li', class: 'px-5 pt-16 pb-6', attributes: [h.Key('intro')], children: [
        box({ class: 'mb-3 flex gap-2', children: partners.map(partner => avatar(partner, h, 'lg')) }, h),
        box({ as: 'h2', class: 'text-[22px] font-black', children: [titleOf(model)] }, h),
        box({ as: 'p', class: 'mt-1 text-[15px] text-muted-foreground', children: [`This conversation is just between ${partners.length > 1 ? 'you and these people' : 'the two of you'}. Here you can send messages and share files.`] }, h),
      ] }, h)
  }
  return box({ as: 'li', class: 'px-5 pt-16 pb-6', attributes: [h.Key('intro')], children: [
      box({ as: 'h2', class: 'flex items-center gap-1 text-[22px] font-black', children: [Icon.icon(channel.kind === 'private' ? 'lock' : 'hash', { class: 'size-6' }, h), channel.name] }, h),
      box({ as: 'p', class: 'mt-1 text-[15px] text-muted-foreground', children: [
          `This is the very beginning of the ${channel.kind === 'private' ? '' : '#'}${channel.name} channel. `,
          channel.description,
        ] }, h),
    ] }, h)
}

/** One message in a list, its own region: it redraws only when it changes. */
const messageRegion = (model: Model, message: ChatMessage, isFirst: boolean, where: Where, summary: ThreadSummary | null, h: HtmlBuilder<Message>): Html =>
  region(h, {
    id: `${where === 'thread' ? 'thread-' : ''}message-${message.id}`,
    deps: [
      message,
      isFirst,
      model.members,
      model.editing?.id === message.id && model.editing.where === where ? model.editing : null,
      model.overlay?.messageId === message.id && model.overlay.where === where ? model.overlay : null,
      canWrite(model),
      summary?.count ?? 0,
      summary?.lastAt ?? 0,
      summary?.replierIds.join() ?? '',
      model.thread?.id === message.id,
      message.threadId === null ? null : model.messages.find(candidate => candidate.id === message.threadId)?.text,
      model.now,
      model.saved.includes(message.id),
    ],
    render: () => messageView(model, message, isFirst, where, summary, h),
  })

const summariesOf = (messages: ReadonlyArray<ChatMessage>): ReadonlyMap<string, ThreadSummary> => {
  const byThread = new Map<string, Array<ChatMessage>>()
  for (const message of messages) if (message.threadId !== null) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message])
  return new Map([...byThread].flatMap(([id, replies]) => {
    const summary = summaryOf(replies)
    return summary === null ? [] : [[id, summary] as const]
  }))
}

type DayRows = Readonly<{ day: string; at: number; rows: ReadonlyArray<Exclude<Row, { _tag: 'day' }>> }>

const daysOf = (rows: ReadonlyArray<Row>): ReadonlyArray<DayRows> => {
  const days: Array<{ day: string; at: number; rows: Array<Exclude<Row, { _tag: 'day' }>> }> = []
  for (const row of rows) {
    if (row._tag === 'day') days.push({ day: row.day, at: row.at, rows: [] })
    else days.at(-1)?.rows.push(row)
  }
  return days
}

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const rows = rowsOf(model.messages.filter(inChannel), model.readMarker, model.me.id, model.me)
  const summaries = summariesOf(model.messages)
  // A reversed column keeps the newest message in view: the list goes in as one block.
  return box({ class: 'flex min-h-0 flex-1 flex-col-reverse overflow-y-auto', attributes: [h.Id('message-list'), h.DataAttribute('keep-scroll', `messages-${model.channelId}`)], children: [
      box({ as: 'ol', class: 'flex flex-col pb-2', attributes: [h.AriaLabel('Messages')], children: [
          model.older > 0 ? box({ as: 'li', class: 'py-3 text-center text-[13px] text-muted-foreground', attributes: [h.Key('older')], children: [`${model.older} older messages are not shown`] }, h) : introView(model, h),
          // Each day is its own item, so its sticky divider gives way to the next day's.
          ...daysOf(rows).map(({ day, at, rows: dayRows }) =>
            box({ as: 'li', attributes: [h.Key(`day-${day}`)], children: [
                box({ class: slack.dayDivider, children: [box({ as: 'span', children: [dayLabel(at, model.now, model.me)] }, h)] }, h),
                box({ as: 'ol', class: 'flex flex-col', children: dayRows.map(row =>
                    row._tag === 'new'
                      ? box({ as: 'li', class: slack.newDivider, attributes: [h.Key('new'), h.Id('new-divider')], children: ['New'] }, h)
                      : messageRegion(model, row.message, row.isFirst, 'channel', row.message.threadId === null ? (summaries.get(row.message.id) ?? null) : null, h),
                  ) }, h),
              ] }, h),
          ),
        ] }, h),
    ] }, h)
}

const threadView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const thread = model.thread
  const root = thread === null ? undefined : model.messages.find(message => message.id === thread.id)
  if (thread === null || root === undefined || model.channel === null) return box({ attributes: [h.Id('thread')] }, h)
  const replies = repliesOf(model.messages, root.id)
  const rows = rowsOf(replies, Number.MAX_SAFE_INTEGER, model.me.id, model.me)
  const where = model.channel.kind === 'dm' ? 'direct message' : `#${model.channel.name}`
  return box({ as: 'aside', class: slack.thread, attributes: [h.Id('thread'), h.AriaLabel('Thread')], children: [
      box({ as: 'header', class: 'flex min-h-[49px] shrink-0 items-center gap-2 border-b px-4', children: [
          box({ as: 'h2', class: 'text-[18px] font-black', children: ['Thread'] }, h),
          box({ as: 'span', class: 'min-w-0 flex-1 truncate text-[13px] text-muted-foreground', children: [model.channel.kind === 'dm' ? titleOf(model) : `#${model.channel.name}`] }, h),
          button({ id: 'close-thread', variant: 'ghost', size: 'icon-sm', ariaLabel: 'Close thread', title: 'Close', onClick: Message.ClickedCloseThread(), children: [Icon.x({}, h)] }, h),
        ] }, h),
      box({ class: 'min-h-0 flex-1 overflow-y-auto', attributes: [h.Id('thread-list')], children: [
          box({ as: 'ol', class: 'flex flex-col py-2', attributes: [h.AriaLabel('Thread messages')], children: [
              messageRegion(model, root, true, 'thread', null, h),
              ...(replies.length === 0
                ? []
                : [box({ as: 'li', class: slack.replyDivider, attributes: [h.Key('replies')], children: [box({ as: 'span', children: [`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`] }, h)] }, h)]),
              ...rows.flatMap(row => (row._tag === 'message' ? [messageRegion(model, row.message, row.isFirst, 'thread', null, h)] : [])),
            ] }, h),
          canWrite(model)
            ? box({ as: 'form', class: slack.composer, attributes: [h.OnSubmit(Message.SubmittedThreadDraft()), h.AllowDrop(), h.OnDropFiles(files => Message.ChoseReplyFiles({ files }))], children: [
                formatBar(h),
                ...uploadChips({ uploads: thread.uploads, uploading: thread.uploading, onRemove: id => Message.ClickedRemoveReplyUpload({ id }) }, h),
                textarea({ id: 'thread-composer', value: thread.draft, rows: 1, placeholder: 'Reply…', onInput: text => Message.ChangedThreadDraft({ text }), ariaLabel: 'Reply in thread', resize: 'none', variant: 'slack-composer' }, h),
                box({ class: 'flex items-center gap-1 px-2 pb-1.5', children: [
                    fileButton({ id: 'attach-reply', ariaLabel: 'Attach files to the reply', title: 'Upload from your computer', isMultiple: true, size: 'icon-md', isDisabled: thread.isSending, onFiles: files => Message.ChoseReplyFiles({ files }), children: [Icon.icon('plus', {}, h)] }, h),
                    box({ class: 'flex-1 text-[13px]', children: [
                        checkbox({ id: 'also-send', isChecked: thread.alsoSend, onToggle: isChecked => Message.ToggledAlsoSend({ isChecked }), label: `Also send ${model.channel.kind === 'dm' ? 'as direct message' : `to ${where}`}` }, h),
                      ] }, h),
                    button({ id: 'send-reply', variant: 'send', size: 'icon-md', type: 'submit', ariaLabel: 'Send reply', title: 'Send reply', isDisabled: (thread.draft.trim() === '' && thread.uploads.length === 0) || thread.uploading > 0 || thread.isSending, children: [Icon.icon('send', {}, h)] }, h),
                  ] }, h),
              ] }, h)
            : box({}, h),
          ...(canWrite(model) ? [typingView(model, h, 'thread')] : []),
        ] }, h),
    ] }, h)
}

/** Slack's star next to the conversation name. */
const starButton = (model: Model, channel: Channel, h: HtmlBuilder<Message>): Html => {
  const starred = isStarred(model.me, channel.id)
  const what = channel.kind === 'dm' ? 'conversation' : 'channel'
  return button({ id: 'star-channel', variant: starred ? 'star-on' : 'ghost', size: 'icon-sm', isPressed: starred, ariaLabel: starred ? `Unstar ${what}` : `Star ${what}`, title: starred ? `Starred: remove from Starred` : `Star this ${what}`, onClick: Message.ClickedStar({ isStarred: !starred }), children: [Icon.icon('star', {}, h)] }, h)
}

/** Slack's "Mute channel" / "Mute conversation", from the header. */
const muteButton = (model: Model, channel: Channel, h: HtmlBuilder<Message>): Html => {
  const muted = isMuted(model.me, channel.id)
  const what = channel.kind === 'dm' ? 'conversation' : 'channel'
  return button({ id: 'mute-channel', variant: 'ghost', size: 'icon-md', isPressed: muted, ariaLabel: muted ? `Unmute ${what}` : `Mute ${what}`, title: muted ? `Muted: unmute this ${what}` : `Mute this ${what}`, onClick: Message.ClickedMute({ isMuted: !muted }), children: [Icon.icon(muted ? 'bell-off' : 'bell', {}, h)] }, h)
}

const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channel
  const people = channel === null ? [] : channel.memberIds.map(id => model.members.find(member => member.id === id)).filter(member => member !== undefined)
  return box({ as: 'header', class: 'shrink-0 border-b', attributes: [h.Id('conversation-header')], children: [
      box({ class: 'flex min-h-[49px] items-center gap-2 px-4', children: [
          box({ as: 'h1', class: 'flex min-w-20 items-center gap-1 text-[18px] font-black', children: channel === null
              ? [box({ as: 'span', class: 'min-w-0 truncate', children: [titleOf(model)] }, h)]
              : channel.kind === 'dm'
              ? [button({ id: 'channel-title', variant: 'channel-title', size: 'sm', ariaLabel: `Conversation details for ${titleOf(model)}`, onClick: Message.ClickedOpenDetails({ tab: 'settings', field: null }), trailingIcon: Icon.icon('chevron-down', { class: 'size-4' }, h), children: [box({ as: 'span', class: 'min-w-0 truncate', children: [titleOf(model)] }, h)] }, h)]
              : [button({ id: 'channel-title', variant: 'channel-title', size: 'sm', ariaLabel: `Channel details for #${channel.name}`, onClick: Message.ClickedOpenDetails({ tab: 'about', field: null }), leadingIcon: Icon.icon(channel.kind === 'private' ? 'lock' : 'hash', { class: 'size-[18px]' }, h), trailingIcon: Icon.icon('chevron-down', { class: 'size-4' }, h), children: [box({ as: 'span', class: 'min-w-0 truncate', children: [titleOf(model)] }, h)] }, h)] }, h),
          ...(channel === null || !isMemberOf(channel, model.me.id) ? [] : [starButton(model, channel, h)]),
          ...(channel === null || channel.kind === 'dm'
            ? []
            : channel.topic === ''
              ? isMemberOf(channel, model.me.id) && !channel.isArchived ? [button({ id: 'add-topic', variant: 'topic', size: 'xs', onClick: Message.ClickedOpenDetails({ tab: 'about', field: 'topic' }), children: ['Add a topic'] }, h)] : []
              : [button({ id: 'channel-topic', variant: 'topic', size: 'xs', title: channel.topic, onClick: Message.ClickedOpenDetails({ tab: 'about', field: isMemberOf(channel, model.me.id) && !channel.isArchived ? 'topic' : null }), children: [box({ as: 'span', class: 'min-w-0 truncate', children: [channel.topic] }, h)] }, h)]),
          box({ class: 'flex-1' }, h),
          ...(channel === null || !isMemberOf(channel, model.me.id) ? [] : [muteButton(model, channel, h)]),
          ...(channel === null || channel.kind === 'dm'
            ? []
            : [button({ id: 'channel-members', variant: 'outline', size: 'sm', ariaLabel: `View all ${people.length} members`, title: `${people.length} members`, onClick: Message.ClickedOpenDetails({ tab: 'members', field: null }), children: [
                box({ class: 'flex -space-x-1 max-md:hidden', children: people.slice(0, 3).map(member => avatar(member, h, 'sm', 'ring-2 ring-background')) }, h),
                box({ as: 'span', class: 'px-0.5 text-[13px] font-semibold text-muted-foreground', children: [String(people.length)] }, h),
              ] }, h)]),
        ] }, h),
      box({ as: 'nav', class: 'flex h-9 items-end gap-4 px-4 text-[13px]', attributes: [h.AriaLabel('Conversation tabs')], children: [
          box({ as: 'span', class: 'flex items-center gap-1.5 border-b-2 border-foreground pb-2 font-semibold', attributes: [h.AriaCurrent('page')], children: [Icon.icon('message-circle', { class: 'size-4' }, h), 'Messages'] }, h),
          ...(channel === null || model.pins.length === 0
            ? []
            : [button({ id: 'open-pins', variant: 'conversation-tab', size: 'xs', onClick: Message.ClickedOpenDetails({ tab: 'pins', field: null }), leadingIcon: Icon.icon('pin', { class: 'size-4' }, h), children: [`Pins ${model.pins.length}`] }, h)]),
          ...(channel === null || model.shared.length === 0
            ? []
            : [button({ id: 'open-files', variant: 'conversation-tab', size: 'xs', onClick: Message.ClickedOpenDetails({ tab: 'files', field: null }), leadingIcon: Icon.icon('file', { class: 'size-4' }, h), children: [`Files ${fileCount(model)}`] }, h)]),
        ] }, h),
    ] }, h)
}

const composerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: 'shrink-0', attributes: [h.Id('composer-area')], children: [
      ...(model.scheduled.length === 0 || !canWrite(model)
        ? []
        : [box({ class: 'mx-5 mb-1 flex items-center gap-1.5 text-[13px] text-muted-foreground', attributes: [h.Id('scheduled-banner')], children: [
            Icon.icon('clock', { class: 'size-4' }, h),
            box({ as: 'span', children: [model.scheduled.length === 1 ? '1 scheduled message' : `${model.scheduled.length} scheduled messages`] }, h),
            button({ id: 'open-scheduled', variant: 'link', size: 'xs', onClick: Message.ClickedOpenDetails({ tab: 'scheduled', field: null }), children: ['See all'] }, h),
          ] }, h)]),
      canWrite(model)
        ? box({ as: 'form', class: slack.composer, attributes: [h.OnSubmit(Message.SubmittedDraft()), h.AllowDrop(), h.OnDropFiles(files => Message.ChoseFiles({ files }))], children: [
              formatBar(h),
              textarea({ id: 'composer', value: model.draft, rows: 1, placeholder: placeholderOf(model), onInput: text => Message.ChangedDraft({ text }), ariaLabel: placeholderOf(model), resize: 'none', variant: 'slack-composer' }, h),
              ...uploadChips({ uploads: model.uploads, uploading: model.uploading, onRemove: id => Message.ClickedRemoveUpload({ id }) }, h),
              box({ class: 'flex items-center gap-1 px-2 pb-1.5', children: [
                  fileButton({ id: 'attach', ariaLabel: 'Attach files', title: 'Upload from your computer', isMultiple: true, size: 'icon-md', isDisabled: model.isSending, onFiles: files => Message.ChoseFiles({ files }), children: [Icon.icon('plus', {}, h)] }, h),
                  box({ as: 'span', class: 'flex-1 text-[12px] text-muted-foreground', children: [model.draft.includes('\n') ? 'Shift + Return to add a new line' : ''] }, h),
                  button({ id: 'send', variant: 'send', size: 'icon-md', type: 'submit', ariaLabel: 'Send now', title: 'Send now', isDisabled: (model.draft.trim() === '' && model.uploads.length === 0) || model.uploading > 0 || model.isSending, children: [Icon.icon('send', {}, h)] }, h),
                  button({ id: 'schedule-send', variant: 'send', size: 'icon-sm', ariaLabel: 'Schedule for later', title: 'Schedule for later', isDisabled: sendable(model) === null, onClick: Message.ClickedScheduleMenu(), anchorName: SCHEDULE_ANCHOR, popup: 'menu', isExpanded: model.overlay?.kind === 'schedule', children: [Icon.icon('chevron-down', {}, h)] }, h),
                ] }, h),
            ] }, h)
        : box({ class: 'mx-5 mb-5 flex flex-col items-center gap-3 rounded-lg border bg-muted px-4 py-5 text-center text-[15px]', attributes: [h.Id('composer-readonly')], children: [
            box({ as: 'p', children: [model.channel === null ? 'This conversation does not exist or is private.' : model.channel.isArchived ? `You are viewing #${model.channel.name}, an archived channel.` : `You are viewing #${model.channel.name}.`] }, h),
            ...(model.channel === null || model.channel.kind === 'dm'
              ? []
              : [box({ class: 'flex items-center gap-2', children: [
                  button({ variant: 'outline', size: 'sm', onClick: Message.ClickedOpenDetails({ tab: 'about', field: null }), children: ['Details'] }, h),
                  ...(model.channel.isArchived
                    ? isMemberOf(model.channel, model.me.id) ? [button({ id: 'unarchive', variant: 'outline', size: 'sm', onClick: Message.ClickedArchive({ isArchived: false }), children: ['Unarchive channel'] }, h)] : []
                    : model.channel.kind === 'public' ? [button({ id: 'join-channel', variant: 'join', size: 'sm', isDisabled: model.isJoining, onClick: Message.ClickedJoin(), children: ['Join channel'] }, h)] : []),
                ] }, h)]),
          ] }, h),
    ] }, h)

/** "Blake is typing…", as Slack words it. */
export const typingText = (names: ReadonlyArray<string>): string => {
  const [first, second] = names
  if (first === undefined) return ''
  if (second === undefined) return `${first} is typing…`
  return names.length === 2 ? `${first} and ${second} are typing…` : 'Several people are typing…'
}

const typingView = (model: Model, h: HtmlBuilder<Message>, where: Where = 'channel'): Html => {
  const names = (where === 'thread' ? model.threadTyping : model.typing).map(id => model.members.find(member => member.id === id)?.name ?? 'Someone')
  return box({ class: '-mt-[19px] min-h-[19px] shrink-0 truncate px-5 text-[12px] leading-[18px] text-muted-foreground', attributes: [h.Id(where === 'thread' ? 'thread-typing' : 'typing'), h.AriaLive('polite')], children: names.length === 0 ? [] : [box({ as: 'strong', class: 'font-bold', attributes: [h.DataAttribute('typing-names', '')], children: [typingText(names)] }, h)] }, h)
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.channel === null || model.channel.kind === 'dm' ? '' : '#'}${titleOf(model)} - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, preferences: model.me.preferences, children: [
      switcherRegion(model, event => Message.GotSwitcher({ event }), h),
      region(h, { id: 'rail', deps: [model.me, model.now, hasUnread(model.nav), model.nav.activity], render: () => rail({ me: model.me, now: model.now, active: 'home', onToggleTheme: Message.ClickedToggleTheme(), nav: model.nav }, h) }),
      box({ class: slack.frame, children: [
          topBar({}, h),
          region(h, {
            id: 'sidebar',
            deps: [model.nav, model.members, model.channelId, model.collapsed],
            render: () => sidebar({ nav: model.nav, members: model.members, activeId: model.channelId, collapsed: model.collapsed, onToggleSection: section => Message.ClickedToggleSection({ section }) }, h),
          }),
          box({ as: 'main', class: slack.main, attributes: model.thread === null ? [] : [h.DataAttribute('split', '')], children: [
              region(h, { id: 'conversation-header', deps: [model.channel, model.members, model.me.id, model.me.muted, model.me.starred, model.pins.length, model.shared], render: () => headerView(model, h) }),
              region(h, { id: 'message-list', deps: [model.messages, model.members, model.readMarker, model.me.id, model.older, model.channel, model.now, model.editing, model.overlay, model.thread?.id, model.saved, model.pins, model.me.timeZone, model.me.preferences], render: () => listView(model, h) }),
              region(h, { id: 'composer-area', deps: [model.draft, model.uploads, model.uploading, model.isSending, model.isJoining, model.channel, model.me.id, model.members, model.scheduled, model.overlay?.kind], render: () => composerView(model, h) }),
              region(h, { id: 'typing', deps: [model.typing, model.members], render: () => typingView(model, h) }),
            ] }, h),
          region(h, { id: 'thread', deps: [model.thread, model.threadTyping, model.messages, model.members, model.channel, model.me.id, model.editing, model.overlay, model.now, model.saved, model.me.timeZone, model.me.preferences], render: () => threadView(model, h) }),
        ] }, h),
      region(h, {
        id: 'keys',
        deps: [],
        render: () =>
          box({ attributes: [h.Id('keys')], children: [
              // Enter sends (Shift+Enter is another key: a new line).
              keyBindings(h, [
                { keys: 'Enter', whileTyping: 'Allow', message: ({ targetId }) => Message.PressedEnter({ targetId }) },
                { keys: 'Escape', whileTyping: 'Allow', message: () => Message.PressedEscape() },
                { keys: 'ArrowUp', whileTyping: 'Allow', message: ({ targetId }) => Message.PressedUp({ targetId }) },
              ]),
            ] }, h),
      }),
      region(h, { id: 'overlay', deps: [model.overlay, model.emojiQuery, model.now, model.me], render: () => overlayView(model, h) }),
      region(h, { id: 'details', deps: [model.details, model.about, model.channel, model.members, model.me.id, model.pins, model.shared, model.scheduled, model.now, model.me.timeZone, model.me.preferences], render: () => box({ attributes: [h.Id('details')], children: [detailsDialog(model, h)] }, h) }),
      region(h, { id: 'confirm', deps: [model.confirm, model.deleting, model.messages, model.members], render: () => box({ attributes: [h.Id('confirm')], children: [confirmDialog(model, h)] }, h) }),
      region(h, {
        id: 'notice',
        deps: [model.notice],
        render: () =>
          box({ class: 'pointer-events-none fixed right-4 bottom-24 z-50', attributes: [h.Id('notice'), h.AriaLive('polite')], children: model.notice === null
              ? []
              : [box({ class: 'pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3.5 py-2.5 text-[14px] shadow-lg', children: [
                  Icon.icon('info', { class: 'size-4 text-muted-foreground' }, h),
                  box({ as: 'span', children: [model.notice] }, h),
                  button({ variant: 'ghost', size: 'icon-xs', ariaLabel: 'Dismiss', onClick: Message.ClickedDismissNotice(), children: [Icon.x({}, h)] }, h),
                ] }, h)] }, h),
      }),
    ] }, h),
})

// PROGRAM

/** Where "/" goes: #general, or the first conversation you are in. */
export const homeChannel = (state: WorkspaceState, me: Member): string | undefined => {
  const nav = navOf(state, me)
  return (nav.channels.find(row => row.label === 'general') ?? nav.channels[0] ?? nav.dms[0])?.id
}

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Files> = {
  name: 'client',
  Model,
  ClientMessage,
  flags: (request: PageRequest) =>
    Effect.gen(function* () {
      const me = yield* requireMember(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const channelId = request.params['channel'] ?? ''
      if (channelId === '') {
        const home = homeChannel(state, me)
        if (home === undefined) return yield* new PageNotFound()
        return yield* new PageRedirect({ location: `/client/${home}` })
      }
      const slice = sliceOf(state, channelId, me.id)
      if (slice.channel === null) return yield* new PageNotFound()
      const now = yield* Clock.currentTimeMillis
      const asked = request.params['thread']
      const threadId = slice.messages.some(message => message.id === asked && message.threadId === null) ? (asked ?? null) : null
      return { me, channelId, channel: slice.channel, members: slice.members, messages: slice.messages, older: slice.older, pins: slice.pins, shared: slice.shared, scheduled: slice.scheduled, saved: slice.saved, nav: slice.nav, now, readMarker: readAt(state.reads, me.id, channelId), threadId }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  clientCommands: {
    ...switcherClientCommands,
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
    ReplaceUrl: ({ url }) => (typeof url === 'string' ? { replaceUrl: url } : undefined),
    LoadUrl: ({ url }) => (typeof url === 'string' && url.startsWith('/') ? { load: url } : undefined),
  },
  snapshotDeps: model => [model.draft, model.thread, model.readMarker, model.notice, model.collapsed, model.editing, model.overlay, model.emojiQuery, model.deleting, model.confirm, model.details, model.about],
}
