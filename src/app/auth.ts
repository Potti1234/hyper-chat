import { createHmac, timingSafeEqual } from 'node:crypto'

import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { PageRedirect, type PageRequest, type RequestContext, secretFromEnvironment } from '@hyper-effect/core'

import { EMAIL_DOMAIN, type Member, normalizeEmail } from './domain'
import { Workspace } from './store'

/* Sign-in with email and password. The member id travels in an HMAC-signed,
   HttpOnly cookie:
   - Flags read it (`requireMember`), so a signed-out visit goes to /login;
   - `principal` binds every session to it, so signing out ends the page.
   Passwords are checked by the workspace (scrypt hashes, `password.ts`). */

const USER_COOKIE = 'hyperchat-user'
const SECRET = secretFromEnvironment('APP_SECRET', 'dev-secret, set APP_SECRET')
const MAX_AGE = 60 * 60 * 12

const signature = (memberId: string) => createHmac('sha256', SECRET).update(memberId).digest()

/** The cookie value for a signed-in member (exported for tests). */
export const cookieValue = (memberId: string) =>
  `${Buffer.from(memberId, 'utf8').toString('base64url')}.${signature(memberId).toString('base64url')}`

/** The signed-in member's id, if the cookie is valid. */
export const signedInMemberId = (cookies: RequestContext['cookies']): string | undefined => {
  const [encodedId, encodedSignature] = (cookies[USER_COOKIE] ?? '').split('.')
  if (encodedId === undefined || encodedSignature === undefined) return undefined
  const memberId = Buffer.from(encodedId, 'base64url').toString('utf8')
  const expected = signature(memberId)
  const actual = Buffer.from(encodedSignature, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? memberId : undefined
}

/** For `Hyper.layer`: sessions belong to the signed-in member. */
export const principal = ({ cookies }: RequestContext) => Effect.succeed(signedInMemberId(cookies))

const toLogin = (url: URL) => new PageRedirect({ location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` })

/** For Flags: the signed-in member, or a redirect to /login and back (also
 *  when their account was removed). */
export const requireMember = ({ cookies, url }: PageRequest): Effect.Effect<Member, PageRedirect, Workspace> =>
  Effect.gen(function* () {
    const memberId = signedInMemberId(cookies)
    if (memberId === undefined) return yield* toLogin(url)
    const member = yield* Workspace.use(workspace => workspace.member(memberId))
    return member ?? (yield* toLogin(url))
  })

/** For `onUrlChange`: only that someone is signed in. */
export const requireSignedIn = ({ cookies, url }: PageRequest): Effect.Effect<string, PageRedirect> => {
  const memberId = signedInMemberId(cookies)
  return memberId === undefined ? Effect.fail(toLogin(url)) : Effect.succeed(memberId)
}

export const USER_COOKIE_NAME = USER_COOKIE

const safeNext = (next: string | null): string =>
  next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FIELD =
  'h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

const loginPage = (next: string, email: string, error: string | undefined) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · hyper-chat</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="flex min-h-screen text-[13px] items-center justify-center bg-muted/40 p-4">
<form method="post" action="/login" class="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
<div class="flex items-center gap-2">
<span class="flex size-7 items-center justify-center rounded-md bg-[#4a154b] text-[13px] font-bold text-white">h</span>
<h1 class="text-lg font-semibold">hyper-chat</h1>
</div>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<div class="flex flex-col gap-1.5">
<label for="email" class="text-sm font-medium">Email</label>
<input id="email" name="email" type="text" inputmode="email" required maxlength="120" autocomplete="username" ${email === '' ? 'autofocus' : ''} value="${escapeHtml(email)}" placeholder="afinch@${EMAIL_DOMAIN}" class="${FIELD}">
</div>
<div class="flex flex-col gap-1.5">
<label for="password" class="text-sm font-medium">Password</label>
<input id="password" name="password" type="password" required maxlength="200" autocomplete="current-password" ${email === '' ? '' : 'autofocus'} class="${FIELD}">
</div>
${error === undefined ? '' : `<p id="login-error" class="text-sm text-destructive">${escapeHtml(error)}</p>`}
<button type="submit" class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Sign in</button>
</form>
</body>
</html>`

const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: 'text/html',
    headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'" },
  })

/** Sign-in and sign-out posts must come from this site. */
const isSameOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = request.headers['origin']
  if (origin === undefined) return request.headers['sec-fetch-site'] !== 'cross-site'
  try {
    return new URL(origin).host === request.headers['host']
  } catch {
    return false
  }
}

const cookie = (request: HttpServerRequest.HttpServerRequest, value: string, maxAge: number) =>
  `${USER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${
    request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  }`

export const routes = Layer.mergeAll(
  HttpRouter.add(
    'GET',
    '/login',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return html(loginPage(safeNext(new URL(request.url, 'http://localhost').searchParams.get('next')), '', undefined))
    }),
  ),
  HttpRouter.add(
    'POST',
    '/login',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isSameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
      const form = new URLSearchParams(yield* request.text)
      const email = normalizeEmail((form.get('email') ?? '').slice(0, 120))
      const password = (form.get('password') ?? '').slice(0, 200)
      const next = safeNext(form.get('next'))
      if (email === '' || password === '') return html(loginPage(next, email, 'Enter your email and password.'), 400)
      const member = yield* Workspace.use(workspace => workspace.authenticate(email, password))
      if (member === undefined) return html(loginPage(next, email, 'That email and password do not match.'), 401)
      return HttpServerResponse.redirect(next, { status: 303 }).pipe(
        HttpServerResponse.setHeader('set-cookie', cookie(request, cookieValue(member.id), MAX_AGE)),
      )
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
  ),
  HttpRouter.add(
    'POST',
    '/logout',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isSameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
      return HttpServerResponse.redirect('/login', { status: 303 }).pipe(
        HttpServerResponse.setHeader('set-cookie', cookie(request, '', 0)),
      )
    }),
  ),
)
