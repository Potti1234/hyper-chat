import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { signedInMemberId } from './auth'
import { canRead, channelSlug } from './domain'
import { Workspace, type WorkspaceState } from './store'

/* Links that resolve on the server, so they work for whoever opens them:

   - `/archives/:channel/:message` is a message's permalink (Copy link in the
     message menu). It opens the conversation scrolled to the message, or the
     thread for a reply. public/keep-scroll.js scrolls to `#message-…`.
   - `/channel/:name` is where a `#channel` in message text points. It opens
     the channel when the reader can see it, and the channel browser
     otherwise, so the link never tells who can read a private channel. */

const redirect = (location: string) => HttpServerResponse.redirect(location, { status: 302 })

const toLogin = (request: HttpServerRequest.HttpServerRequest) =>
  redirect(`/login?next=${encodeURIComponent(request.url)}`)

/** Where a message's permalink leads a member, or undefined if they can't
 *  read it (or it is gone). */
export const permalinkTarget = (state: WorkspaceState, memberId: string, channelId: string, messageId: string): string | undefined => {
  const channel = state.channels.find(candidate => candidate.id === channelId)
  const message = state.messages.find(candidate => candidate.id === messageId && candidate.channelId === channelId)
  if (channel === undefined || message === undefined || !canRead(channel, memberId)) return undefined
  return message.threadId === null
    ? `/client/${channel.id}#message-${message.id}`
    : `/client/${channel.id}/thread/${message.threadId}#thread-message-${message.id}`
}

/** Where a `#name` link leads a member. */
export const channelLinkTarget = (state: WorkspaceState, memberId: string, name: string): string => {
  const slug = channelSlug(name)
  const channel = state.channels.find(candidate => candidate.kind !== 'dm' && candidate.name === slug && canRead(candidate, memberId))
  return channel === undefined ? '/channels' : `/client/${channel.id}`
}

export const routes = Layer.mergeAll(
  HttpRouter.add(
    'GET',
    '/archives/:channelId/:messageId',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const memberId = signedInMemberId(request.cookies)
      if (memberId === undefined) return toLogin(request)
      const { channelId = '', messageId = '' } = yield* HttpRouter.params
      const state = yield* Workspace.use(workspace => workspace.current)
      return redirect(permalinkTarget(state, memberId, channelId, messageId) ?? '/')
    }),
  ),
  HttpRouter.add(
    'GET',
    '/channel/:name',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const memberId = signedInMemberId(request.cookies)
      if (memberId === undefined) return toLogin(request)
      const { name = '' } = yield* HttpRouter.params
      const state = yield* Workspace.use(workspace => workspace.current)
      return redirect(channelLinkTarget(state, memberId, name))
    }),
  ),
)
