import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { PageNotFound, PageRedirect, type PageRequest, type Program, keyBindings, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { anchoredStyle } from '@/lib/anchored'
import { button } from '@/ui/button'
import * as Dialog from '@/ui/dialog'
import { input } from '@/ui/input'
import { textarea } from '@/ui/textarea'

import { requireMember } from '../auth'
import { Channel, MAX_MESSAGE, Member, Message as ChatMessage, canRead, conversationName, dayLabel, dayOf, dmPartners, formatTime, isMemberOf, readAt } from '../domain'
import { EMOJI, QUICK_REACTIONS, emojiName, isEmoji, searchEmoji } from '../emoji'
import { Workspace, type WorkspaceState } from '../store'
import { box, optionRow, pageRoot, slack } from '../view/design'
import { avatar } from '../view/icons'
import { messageText } from '../view/message'
import { Nav, WORKSPACE_NAME, hasUnread, navOf, rail, sameNav, sidebar } from '../view/shell'

/* A conversation (channel or direct message), Slack's main view: the frame
   (rail and sidebar), the conversation header, messages grouped by day and
   by author, and the composer. Live for everyone with it open. Enter sends,
   Shift+Enter starts a new line. Opening it marks it read; a red "New" line
   shows where you stopped. The list is a reversed column, so the newest
   message stays in view without browser code.

   Each message has Slack's hover toolbar: quick reactions, the emoji
   picker, and (for your own) a menu to edit or delete. Up in an empty
   composer edits your last message; Escape closes what is open. */

/** Messages kept on the page (the newest). */
export const SHOWN = 300

// MODEL

export const Model = S.Struct({
  me: Member,
  channelId: S.String,
  channel: S.NullOr(Channel),
  members: S.Array(Member),
  messages: S.Array(ChatMessage),
  older: S.Number,
  nav: Nav,
  now: S.Number,
  /** Read up to here when the page opened: the "New" line. */
  readMarker: S.Number,
  /** Marked read up to here (a MarkRead Command). */
  markedUpTo: S.Number,
  draft: S.String,
  isConnected: S.Boolean,
  isSending: S.Boolean,
  notice: S.NullOr(S.String),
  collapsed: S.Array(S.String),
  /** Your message being edited in place. */
  editing: S.NullOr(S.Struct({ id: S.String, text: S.String, isSaving: S.Boolean })),
  /** The emoji picker or a message's menu, anchored to its button. */
  overlay: S.NullOr(S.Struct({ kind: S.Literals(['emoji', 'actions']), messageId: S.String, anchor: S.String })),
  emojiQuery: S.String,
  /** The message the delete confirmation is for. */
  deleting: S.NullOr(S.String),
  confirm: Dialog.Model,
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
  SubmittedDraft: {},
  PressedEnter: { targetId: S.String },
  ClickedToggleTheme: {},
  ClickedToggleSection: { section: S.String },
  ClickedDismissNotice: {},
  ClickedReaction: { messageId: S.String, emoji: S.String },
  ClickedAddReaction: { messageId: S.String, from: S.Literals(['toolbar', 'reactions']) },
  ChangedEmojiQuery: { text: S.String },
  ClickedEmoji: { emoji: S.String },
  ClickedMore: { messageId: S.String },
  ClickedCloseOverlay: {},
  ClickedEdit: { messageId: S.String },
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
  GotChannel: { channel: S.NullOr(Channel), members: S.Array(Member), messages: S.Array(ChatMessage), older: S.Number, nav: Nav, me: Member, now: S.Number },
  SucceededSend: {},
  FailedChange: { reason: S.String },
  CompletedChange: {},
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

/** What a browser may post (re-checked in update). Typed text arrives
 *  through the composer's handler; Enter through a key binding. */
export const ClientMessage = S.Union([
  Message.SubmittedDraft,
  Message.ClickedToggleTheme,
  Message.ClickedToggleSection,
  Message.ClickedDismissNotice,
  Message.ClickedReaction,
  Message.ClickedAddReaction,
  Message.ClickedEmoji,
  Message.ClickedMore,
  Message.ClickedCloseOverlay,
  Message.ClickedEdit,
  Message.SubmittedEdit,
  Message.ClickedCancelEdit,
  Message.ClickedDelete,
  Message.ClickedConfirmDelete,
  // The dialog's own bindings; its Command results never come from the page.
  S.TaggedStruct('GotConfirmDialog', { message: Dialog.Message.RequestedClose }),
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SendMessage = Command.define('SendMessage', {
  args: { channelId: S.String, text: S.String, actorId: S.String },
  messages: [Message.SucceededSend, Message.FailedChange],
  execute: ({ channelId, text, actorId }) =>
    Workspace.use(workspace => workspace.postMessage(channelId, text, actorId)).pipe(
      Effect.as(Message.SucceededSend()),
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

// INIT

export type Flags = Readonly<{
  me: Member
  channelId: string
  channel: Channel
  members: ReadonlyArray<Member>
  messages: ReadonlyArray<ChatMessage>
  older: number
  nav: Nav
  now: number
  readMarker: number
}>

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => ({
  model: {
    ...flags,
    markedUpTo: flags.readMarker,
    draft: '',
    isConnected: false,
    isSending: false,
    notice: null,
    collapsed: [],
    editing: null,
    overlay: null,
    emojiQuery: '',
    deleting: null,
    confirm: Dialog.init({ id: 'confirm-delete' }),
    focus: null,
    seq: 0,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

const newest = (messages: ReadonlyArray<ChatMessage>) => messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0)

/** While someone has the conversation open, what arrives counts as read. */
const markRead = (result: UpdateReturn): UpdateReturn => {
  const { model } = result
  const latest = newest(model.messages)
  if (!model.isConnected || model.channel === null || !isMemberOf(model.channel, model.me.id) || latest <= model.markedUpTo) return result
  return { model: { ...model, markedUpTo: latest }, commands: [...(result.commands ?? []), MarkRead({ channelId: model.channelId, memberId: model.me.id })] }
}

const send = (model: Model): UpdateReturn => {
  const text = model.draft.trim()
  if (text === '' || model.isSending) return { model }
  if (!canWrite(model)) return { model: { ...model, notice: 'Join this channel to write in it.' } }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, isSending: true }, commands: [SendMessage({ channelId: model.channelId, text, actorId: model.me.id })] }
}

const ownMessage = (model: Model, messageId: string) => model.messages.find(message => message.id === messageId && message.authorId === model.me.id)

/** The CSS anchor of a message's toolbar or reaction-bar button. */
export const anchorOf = (messageId: string, from: 'toolbar' | 'reactions' | 'more') => `--${from}-${messageId.replace(/[^a-zA-Z0-9-]/g, '-')}`

const withFocus = (model: Model, selector: string): Model => ({ ...model, seq: model.seq + 1, focus: { selector, seq: model.seq + 1 } })

const startEdit = (model: Model, messageId: string): UpdateReturn => {
  const message = ownMessage(model, messageId)
  if (message === undefined) return { model: { ...model, overlay: null } }
  return { model: withFocus({ ...model, overlay: null, editing: { id: message.id, text: message.text, isSaving: false } }, '#edit-composer') }
}

const saveEdit = (model: Model): UpdateReturn => {
  const editing = model.editing
  if (editing === null || editing.isSaving) return { model }
  const message = ownMessage(model, editing.id)
  if (message === undefined) return { model: { ...model, editing: null } }
  const text = editing.text.trim()
  // Slack: saving an empty message offers to delete it.
  if (text === '') return askDelete({ ...model, editing: null }, message.id)
  if (text === message.text) return { model: withFocus({ ...model, editing: null }, '#composer') }
  if (text.length > MAX_MESSAGE) return { model: { ...model, notice: `Keep messages under ${MAX_MESSAGE} characters.` } }
  return { model: { ...model, editing: { ...editing, isSaving: true } }, commands: [EditMessage({ messageId: message.id, text, actorId: model.me.id })] }
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
  }
}

const escape = (model: Model): UpdateReturn => {
  if (model.overlay !== null) return { model: { ...model, overlay: null } }
  if (model.editing !== null) return { model: withFocus({ ...model, editing: null }, '#composer') }
  return { model }
}

export const updateModel = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedDraft: ({ text }) => ({ model: { ...model, draft: text.slice(0, MAX_MESSAGE + 100) } }),
      SubmittedDraft: () => send(model),
      PressedEnter: ({ targetId }) => (targetId === 'composer' ? send(model) : targetId === 'edit-composer' ? saveEdit(model) : { model }),
      PressedEscape: () => escape(model),
      // Up in an empty composer edits your last message (Slack).
      PressedUp: ({ targetId }) => {
        if (targetId !== 'composer' || model.draft !== '' || model.editing !== null) return { model }
        const last = [...model.messages].reverse().find(message => message.authorId === model.me.id)
        return last === undefined ? { model } : startEdit(model, last.id)
      },
      ClickedReaction: ({ messageId, emoji }) => react(model, messageId, emoji),
      ClickedAddReaction: ({ messageId, from }) =>
        model.messages.some(message => message.id === messageId)
          ? { model: withFocus({ ...model, emojiQuery: '', overlay: { kind: 'emoji', messageId, anchor: anchorOf(messageId, from) } }, '#emoji-search') }
          : { model },
      ChangedEmojiQuery: ({ text }) => ({ model: { ...model, emojiQuery: text.slice(0, 40) } }),
      ClickedEmoji: ({ emoji }) => (model.overlay?.kind === 'emoji' ? react(model, model.overlay.messageId, emoji) : { model }),
      ClickedMore: ({ messageId }) =>
        ownMessage(model, messageId) === undefined
          ? { model }
          : { model: { ...model, overlay: model.overlay?.kind === 'actions' && model.overlay.messageId === messageId ? null : { kind: 'actions', messageId, anchor: anchorOf(messageId, 'more') } } },
      ClickedCloseOverlay: () => ({ model: { ...model, overlay: null } }),
      ClickedEdit: ({ messageId }) => startEdit(model, messageId),
      ChangedEdit: ({ text }) => (model.editing === null ? { model } : { model: { ...model, editing: { ...model.editing, text: text.slice(0, MAX_MESSAGE + 100) } } }),
      SubmittedEdit: () => saveEdit(model),
      ClickedCancelEdit: () => ({ model: withFocus({ ...model, editing: null }, '#composer') }),
      ClickedDelete: ({ messageId }) => askDelete(model, messageId),
      ClickedConfirmDelete: () => {
        const messageId = model.deleting
        if (messageId === null || ownMessage(model, messageId) === undefined) return withConfirm({ ...model, deleting: null }, Dialog.close(model.confirm))
        const closed = withConfirm(model, Dialog.close(model.confirm))
        return { ...closed, commands: [...(closed.commands ?? []), DeleteMessage({ messageId, actorId: model.me.id })] }
      },
      GotConfirmDialog: ({ message }) => withConfirm(model, Dialog.update(model.confirm, message)),
      SucceededEdit: () => ({ model: withFocus({ ...model, editing: null }, '#composer') }),
      SucceededDelete: () => ({ model: withFocus(model, '#composer') }),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedToggleSection: ({ section }) => ({
        model: { ...model, collapsed: model.collapsed.includes(section) ? model.collapsed.filter(id => id !== section) : [...model.collapsed, section].slice(-8) },
      }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      ChangedConnection: ({ isConnected }) => markRead({ model: { ...model, isConnected } }),
      GotChannel: slice => markRead({ model: withoutGone({ ...model, ...slice }) }),
      // Sent: the composer empties and the "New" line goes (you are up to date).
      SucceededSend: () => ({ model: { ...model, draft: '', isSending: false, readMarker: Number.MAX_SAFE_INTEGER, seq: model.seq + 1, focus: { selector: '#composer', seq: model.seq + 1 } } }),
      FailedChange: ({ reason }) => ({ model: { ...model, isSending: false, editing: model.editing === null ? null : { ...model.editing, isSaving: false }, notice: reason } }),
      CompletedChange: () => ({ model }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

/** Every new focus request becomes a forwarded focus. */
export const update = (model: Model, message: Message): UpdateReturn => {
  const result = updateModel(model, message)
  const focus = result.model.focus
  return focus !== null && focus.seq !== model.focus?.seq ? { ...result, commands: [...(result.commands ?? []), FocusElement({ selector: focus.selector })] } : result
}

// SUBSCRIPTION

type Slice = Readonly<{ channel: Channel | null; members: ReadonlyArray<Member>; messages: ReadonlyArray<ChatMessage>; older: number; nav: Nav; me: Member | null }>

export const sliceOf = (state: WorkspaceState, channelId: string, memberId: string): Slice => {
  const me = state.members.find(member => member.id === memberId) ?? null
  const found = state.channels.find(channel => channel.id === channelId)
  const channel = found !== undefined && canRead(found, memberId) ? found : null
  const all = channel === null ? [] : state.messages.filter(message => message.channelId === channelId)
  return {
    channel,
    members: state.members,
    messages: all.slice(-SHOWN),
    older: Math.max(0, all.length - SHOWN),
    nav: me === null ? { channels: [], dms: [] } : navOf(state, me),
    me,
  }
}

const sameItems = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) => a.length === b.length && a.every((item, index) => item === b[index])

const sameSlice = (a: Slice, b: Slice) => a.channel === b.channel && a.members === b.members && sameItems(a.messages, b.messages) && sameNav(a.nav, b.nav) && a.me === b.me

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
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
export const rowsOf = (messages: ReadonlyArray<ChatMessage>, readMarker: number, meId: string): ReadonlyArray<Row> => {
  const rows: Array<Row> = []
  let previous: ChatMessage | undefined
  let markedNew = false
  for (const message of messages) {
    const day = dayOf(message.createdAt)
    const dayChanged = previous === undefined || dayOf(previous.createdAt) !== day
    if (dayChanged) rows.push({ _tag: 'day', day, at: message.createdAt })
    const isNew = !markedNew && message.createdAt > readMarker && message.authorId !== meId
    if (isNew) {
      rows.push({ _tag: 'new' })
      markedNew = true
    }
    const isFirst = dayChanged || isNew || previous?.authorId !== message.authorId || message.createdAt - (previous?.createdAt ?? 0) > 5 * 60_000
    rows.push({ _tag: 'message', message, isFirst })
    previous = message
  }
  return rows
}

const reactedBy = (model: Model, memberIds: ReadonlyArray<string>) => {
  const names = memberIds.map(id => (id === model.me.id ? 'You' : (model.members.find(member => member.id === id)?.name ?? 'Someone')))
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

const reactionsView = (model: Model, message: ChatMessage, h: HtmlBuilder<Message>): Html =>
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
        onClick: Message.ClickedAddReaction({ messageId: message.id, from: 'reactions' }),
        anchorName: anchorOf(message.id, 'reactions'),
        popup: 'dialog',
        children: [Icon.icon('smile-plus', { class: 'size-3.5' }, h)],
      }, h),
    ] }, h)

const toolbarView = (model: Model, message: ChatMessage, h: HtmlBuilder<Message>): Html => {
  const isMine = message.authorId === model.me.id
  const isMenuOpen = model.overlay?.kind === 'actions' && model.overlay.messageId === message.id
  return box({ class: slack.messageActions, attributes: [h.Role('toolbar'), h.AriaLabel('Message actions')], children: [
      ...(canWrite(model)
        ? [
            ...QUICK_REACTIONS.map(emoji =>
              button({ variant: 'emoji', size: 'icon-sm', ariaLabel: `React with :${emojiName(emoji)}:`, title: `:${emojiName(emoji)}:`, onClick: Message.ClickedReaction({ messageId: message.id, emoji }), children: [box({ as: 'span', class: 'text-[16px] leading-none', children: [emoji] }, h)] }, h),
            ),
            button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Find another reaction', title: 'Find another reaction', onClick: Message.ClickedAddReaction({ messageId: message.id, from: 'toolbar' }), anchorName: anchorOf(message.id, 'toolbar'), popup: 'dialog', children: [Icon.icon('smile-plus', {}, h)] }, h),
          ]
        : []),
      ...(isMine
        ? [
            button({ variant: 'toolbar', size: 'icon-sm', ariaLabel: 'Edit message', title: 'Edit message', onClick: Message.ClickedEdit({ messageId: message.id }), children: [Icon.icon('pencil', {}, h)] }, h),
            button({ id: `more-${message.id}`, variant: 'toolbar', size: 'icon-sm', ariaLabel: 'More actions', title: 'More actions', onClick: Message.ClickedMore({ messageId: message.id }), anchorName: anchorOf(message.id, 'more'), popup: 'menu', isExpanded: isMenuOpen, children: [Icon.icon('ellipsis-vertical', {}, h)] }, h),
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

const messageView = (model: Model, message: ChatMessage, isFirst: boolean, h: HtmlBuilder<Message>): Html => {
  const author = model.members.find(member => member.id === message.authorId)
  const editing = model.editing !== null && model.editing.id === message.id ? model.editing : null
  const isActive = model.overlay !== null && model.overlay.messageId === message.id
  return box({ as: 'li', class: slack.messageRow, attributes: [
      h.Key(message.id),
      h.Id(`message-${message.id}`),
      h.DataAttribute('author', message.authorId),
      ...(isFirst && editing === null ? [] : [h.DataAttribute('continued', '')]),
      ...(isActive ? [h.DataAttribute('active', '')] : []),
      ...(editing === null ? [] : [h.DataAttribute('editing', '')]),
    ], children: [
      box({ class: slack.messageGutter, children: isFirst ? [avatar(author, h, 'md')] : [box({ as: 'span', class: slack.messageHoverTime, children: [formatTime(message.createdAt)] }, h)] }, h),
      box({ class: 'min-w-0 flex-1', children: [
          ...(isFirst
            ? [box({ class: 'flex items-baseline gap-2', children: [box({ as: 'strong', class: 'font-bold', children: [author?.name ?? 'Former member'] }, h), box({ as: 'span', class: 'text-[12px] text-muted-foreground', children: [formatTime(message.createdAt)] }, h)] }, h)]
            : []),
          ...(editing !== null
            ? [editView(editing, h)]
            : [
                box({ class: slack.messageText, attributes: [h.DataAttribute('message-text', '')], children: [
                    ...messageText(message.text, model.members, h),
                    ...(message.editedAt === null ? [] : [box({ as: 'span', class: 'ml-1 text-[12px] text-muted-foreground', attributes: [h.Title(`Edited ${formatTime(message.editedAt)}`)], children: ['(edited)'] }, h)]),
                  ] }, h),
                ...(message.reactions.length === 0 ? [] : [reactionsView(model, message, h)]),
              ]),
        ] }, h),
      ...(editing === null ? [toolbarView(model, message, h)] : []),
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

const actionsMenu = (model: Model, messageId: string, anchor: string, h: HtmlBuilder<Message>): Html =>
  box({ class: 'z-50 flex w-56 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]', style: anchoredStyle(anchor, { side: 'bottom', align: 'end' }), attributes: [h.Id('message-menu'), h.Role('menu'), h.AriaLabel('Message actions')], children: [
      optionRow({ id: 'menu-edit', value: 'edit', isActive: false, onClick: Message.ClickedEdit({ messageId }), children: [Icon.icon('pencil', { class: 'size-4 text-muted-foreground' }, h), box({ as: 'span', class: 'flex-1', children: ['Edit message'] }, h)] }, h),
      optionRow({ id: 'menu-delete', value: 'delete', isActive: false, onClick: Message.ClickedDelete({ messageId }), children: [Icon.icon('trash-2', { class: 'size-4 text-destructive' }, h), box({ as: 'span', class: 'flex-1 text-destructive', children: ['Delete message…'] }, h)] }, h),
    ] }, h)

const overlayView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: 'contents', attributes: [h.Id('overlay')], children: model.overlay === null
      ? []
      : [
          box({ class: 'fixed inset-0 z-40', attributes: [h.AriaHidden(true), h.OnClick(Message.ClickedCloseOverlay())] }, h),
          model.overlay.kind === 'emoji' ? emojiPicker(model, model.overlay.anchor, h) : actionsMenu(model, model.overlay.messageId, model.overlay.anchor, h),
        ] }, h)

const confirmDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Dialog.dialog(
    {
      model: model.confirm,
      toParentMessage: message => Message.GotConfirmDialog({ message }),
      title: 'Delete message',
      description: 'Are you sure you want to delete this message? This cannot be undone.',
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

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const rows = rowsOf(model.messages, model.readMarker, model.me.id)
  // A reversed column keeps the newest message in view: the list goes in as one block.
  return box({ class: 'flex min-h-0 flex-1 flex-col-reverse overflow-y-auto', attributes: [h.Id('message-list'), h.DataAttribute('keep-scroll', `messages-${model.channelId}`)], children: [
      box({ as: 'ol', class: 'flex flex-col pb-2', attributes: [h.AriaLabel('Messages')], children: [
          model.older > 0 ? box({ as: 'li', class: 'py-3 text-center text-[13px] text-muted-foreground', attributes: [h.Key('older')], children: [`${model.older} older messages are not shown`] }, h) : introView(model, h),
          ...rows.map(row =>
            row._tag === 'day'
              ? box({ as: 'li', class: slack.dayDivider, attributes: [h.Key(`day-${row.day}`)], children: [box({ as: 'span', children: [dayLabel(row.at, model.now)] }, h)] }, h)
              : row._tag === 'new'
                ? box({ as: 'li', class: slack.newDivider, attributes: [h.Key('new'), h.Id('new-divider')], children: ['New'] }, h)
                : region(h, {
                    id: `message-${row.message.id}`,
                    deps: [row.message, row.isFirst, model.members, model.editing?.id === row.message.id ? model.editing : null, model.overlay?.messageId === row.message.id ? model.overlay : null, canWrite(model)],
                    render: () => messageView(model, row.message, row.isFirst, h),
                  }),
          ),
        ] }, h),
    ] }, h)
}

const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channel
  const people = channel === null ? [] : channel.memberIds.map(id => model.members.find(member => member.id === id)).filter(member => member !== undefined)
  return box({ as: 'header', class: 'shrink-0 border-b', attributes: [h.Id('conversation-header')], children: [
      box({ class: 'flex min-h-[49px] items-center gap-2 px-4', children: [
          box({ as: 'h1', class: 'flex min-w-0 items-center gap-1 text-[18px] font-black', children: [
              ...(channel === null ? [] : channel.kind === 'dm' ? [] : [Icon.icon(channel.kind === 'private' ? 'lock' : 'hash', { class: 'size-[18px]' }, h)]),
              box({ as: 'span', class: 'min-w-0 truncate', children: [titleOf(model)] }, h),
            ] }, h),
          ...(channel === null || channel.topic === '' ? [] : [box({ as: 'span', class: 'min-w-0 truncate text-[13px] text-muted-foreground', attributes: [h.Title(channel.topic)], children: [channel.topic] }, h)]),
          box({ class: 'flex-1' }, h),
          ...(channel === null || channel.kind === 'dm'
            ? []
            : [box({ class: 'flex items-center gap-1 rounded-md border px-1.5 py-1', attributes: [h.Title(`${people.length} members`)], children: [
                box({ class: 'flex -space-x-1', children: people.slice(0, 3).map(member => avatar(member, h, 'sm', 'ring-2 ring-background')) }, h),
                box({ as: 'span', class: 'px-1 text-[13px] font-semibold text-muted-foreground', children: [String(people.length)] }, h),
              ] }, h)]),
        ] }, h),
      box({ as: 'nav', class: 'flex h-9 items-end gap-4 px-4 text-[13px]', attributes: [h.AriaLabel('Conversation tabs')], children: [
          box({ as: 'span', class: 'flex items-center gap-1.5 border-b-2 border-foreground pb-2 font-semibold', attributes: [h.AriaCurrent('page')], children: [Icon.icon('message-circle', { class: 'size-4' }, h), 'Messages'] }, h),
        ] }, h),
    ] }, h)
}

const composerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  box({ class: 'shrink-0', attributes: [h.Id('composer-area')], children: [
      canWrite(model)
        ? box({ as: 'form', class: slack.composer, attributes: [h.OnSubmit(Message.SubmittedDraft())], children: [
              textarea({ id: 'composer', value: model.draft, rows: 1, placeholder: placeholderOf(model), onInput: text => Message.ChangedDraft({ text }), ariaLabel: placeholderOf(model), resize: 'none', variant: 'slack-composer' }, h),
              box({ class: 'flex items-center gap-1 px-2 pb-1.5', children: [
                  box({ as: 'span', class: 'flex-1 text-[12px] text-muted-foreground', children: [model.draft.includes('\n') ? 'Shift + Return to add a new line' : ''] }, h),
                  button({ id: 'send', variant: 'send', size: 'icon-md', type: 'submit', ariaLabel: 'Send now', title: 'Send now', isDisabled: model.draft.trim() === '' || model.isSending, children: [Icon.icon('send', {}, h)] }, h),
                ] }, h),
            ] }, h)
        : box({ class: 'mx-5 mb-5 rounded-lg border bg-muted px-4 py-5 text-center text-[15px]', attributes: [h.Id('composer-readonly')], children: [
            model.channel === null ? 'This conversation does not exist or is private.' : `You are viewing #${model.channel.name}. Only its members write here.`,
          ] }, h),
    ] }, h)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.channel === null || model.channel.kind === 'dm' ? '' : '#'}${titleOf(model)} - ${WORKSPACE_NAME} - hyper-chat`,
  body: pageRoot({ isDark: model.me.isDark, theme: model.me.theme, children: [
      region(h, { id: 'rail', deps: [model.me, hasUnread(model.nav)], render: () => rail({ me: model.me, active: 'home', onToggleTheme: Message.ClickedToggleTheme(), hasUnread: hasUnread(model.nav) }, h) }),
      box({ class: slack.frame, children: [
          region(h, {
            id: 'sidebar',
            deps: [model.nav, model.members, model.channelId, model.collapsed],
            render: () => sidebar({ nav: model.nav, members: model.members, activeId: model.channelId, collapsed: model.collapsed, onToggleSection: section => Message.ClickedToggleSection({ section }) }, h),
          }),
          box({ as: 'main', class: slack.main, children: [
              region(h, { id: 'conversation-header', deps: [model.channel, model.members, model.me.id], render: () => headerView(model, h) }),
              region(h, { id: 'message-list', deps: [model.messages, model.members, model.readMarker, model.me.id, model.older, model.channel, model.now, model.editing, model.overlay], render: () => listView(model, h) }),
              region(h, { id: 'composer-area', deps: [model.draft, model.isSending, model.channel, model.me.id, model.members], render: () => composerView(model, h) }),
            ] }, h),
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
      region(h, { id: 'overlay', deps: [model.overlay, model.emojiQuery], render: () => overlayView(model, h) }),
      region(h, { id: 'confirm', deps: [model.confirm, model.deleting, model.messages, model.members], render: () => box({ attributes: [h.Id('confirm')], children: [confirmDialog(model, h)] }, h) }),
      region(h, {
        id: 'notice',
        deps: [model.notice],
        render: () =>
          box({ class: 'pointer-events-none fixed right-4 bottom-24 z-50', attributes: [h.Id('notice'), h.AriaLive('polite')], children: model.notice === null
              ? []
              : [box({ class: 'pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3.5 py-2.5 text-[14px] shadow-lg', children: [
                  Icon.icon('circle-alert', { class: 'size-4 text-destructive' }, h),
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

export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
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
      return { me, channelId, channel: slice.channel, members: slice.members, messages: slice.messages, older: slice.older, nav: slice.nav, now, readMarker: readAt(state.reads, me.id, channelId) }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  clientCommands: {
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
  },
  snapshotDeps: model => [model.draft, model.readMarker, model.notice, model.collapsed, model.editing, model.overlay, model.emojiQuery, model.deleting, model.confirm],
}
