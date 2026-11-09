# hyper-effect API

The source is the authority: `packages/core/src/*.ts` (doc comments on every export) and `packages/island/`. This page is the map.

## `@hyper-effect/core`

| Export | What it is |
|---|---|
| `layer(program, options)` | Serves a program: the page at `options.path` (plain HTML, works without JavaScript), its SSE stream and its event and upload endpoints under `/_hyper/<program.name>/`. A Layer for `HttpRouter.serve`. |
| `Program<Model, Message, ClientMessage, Flags, R>` | The page: see below. |
| `PageRedirect({ location, status? })`, `PageNotFound()` | Fail `flags` with these: redirect (303 by default) or 404. |
| `PageRequest` | What `flags` gets: `url`, `params` (from `/things/:id`), `visitorId`, `cookies`, `headers`. |
| `region(h, { id, deps, render, shared? })` | A part of the page re-rendered and re-sent only when `deps` change (by value). |
| `shared(h, { key, deps, render })` | Markup rendered once per deps for every session and spliced in (Messages only); `region({ shared: true })` is usually what you want. |
| `keyBindings(h, bindings, { id?, sequenceTimeout? })` | Page-wide keyboard shortcuts, matched in the browser with Foldkit's `keyBindings` grammar and rules (`'C'`, `'Mod+K'`, `'Shift+?'`, `['G', 'M']`; `isEnabled`, `whileTyping`, `preventDefault`, `whenRepeated`). `message` is a ClientMessage, or a function of `{ targetId }` (the focused element's id) run in the session. Only matching keys post. Put it in the view, in a region whose deps cover what the table depends on. |
| `memoizeLast(f)` | `f` computed once per distinct input and shared: build a shared feed's Message once for all sessions. |
| `sampleLatest(interval)` | Stream operator: the first element at once, then at most one per interval (presence, counters). |
| `fileStore(directory)` | Session snapshots in files, each replaced whole. Development and one machine. |
| `sqlStore({ table?, ttl?, purgeEvery? })` | Session snapshots in SQL through Effect's `SqlClient` (provide `@effect/sql-pg`'s `PgClient.layer`). Several machines. |
| `metricsRoutes` | `GET /_hyper/metrics` and a CPU profile route. Opt-in, for load tests. |
| `nodeOfPath(path)` | The process named in a session path, for a router in front of several processes. |
| `foldkitUiCommands`, `ClientCommands`, `ClientAction` | Forwarding browser-only Commands. |

### `Program`

| Field | Meaning |
|---|---|
| `name` | Endpoint segment and snapshot key. Unique per app. |
| `Model` | Schema of the Model. It is snapshotted as JSON: plain data only. |
| `ClientMessage` | Schema of the Messages a browser may post as tokens. Views can bind only these. |
| `flags(request)` | Effectful, request-aware Flags: authenticate, authorize, load. Runs on every page load, and when a session is recreated from its URL after a restart without a snapshot. |
| `init`, `update`, `view`, `subscriptions` | Foldkit's. `update` returns `{ model, commands? }`. |
| `onConnectionChange?(isConnected)` | A Message when the page's live connection opens or closes (presence, expensive feeds only while someone looks). |
| `clientCommands?` | `{ CommandName: args => ClientAction \| undefined }`: Commands not run on the server but performed by the browser after the next morph. Actions: `{ focus: selector }` (unless the user moved focus since they acted), `{ scrollIntoView: selector }`, `{ replaceUrl: url }`, `{ load: url }`, `{ click: selector }`. The Command's result Message is dropped. Foldkit UI's `FocusTab`, `FocusInput`, `FocusButton`, `FocusItems`, `ScrollIntoView` and `ClickItem` are forwarded already (`foldkitUiCommands`); an app's own entry of the same name wins. |
| `snapshotDeps?(model)` | The session's own state; snapshots are written when it changes. Leave out shared data that Subscriptions bring back. |

### `Options` of `layer`

| Option | Default | Use |
|---|---|---|
| `path` | `/` | Path pattern, `/things/:id` |
| `stylesheets`, `scripts` | none | Linked from the page head (`scripts`: module scripts, such as an islands bundle) |
| `principal(request)` | none | Who a request acts for (the signed-in user); sessions are bound to it |
| `contentSecurityPolicy` | on | `{ directives: { 'connect-src': [...] } }` to add sources; `false` for none |
| `snapshotSecret` | none | Seals snapshots (AES-GCM); a list rotates |
| `snapshotTtl` | `1 day` | How long a snapshot can restore a session |
| `durableEvents` | `true` | Answer an event only once it is in the snapshot store (lossless failover) |
| `compression` | `false` | gzip per stream; ~30× fewer bytes, ~155 kB per open page |
| `idleTimeout` | `2 minutes` | How long a session without a connection is kept |
| `node` | none | Process name in session ids, for routing between processes |
| `trustProxy` | `0` | Number of proxies whose `X-Forwarded-*` count |
| `allowedOrigins` | `[]` | Extra origins allowed to post events |
| `limits` | see `server.ts` | Body size, event and page rates, sessions, uploads (`maxUploadBytes` 10 MB, `maxUploadFiles` 10) |

The app must provide a `KeyValueStore` (`fileStore`, `sqlStore`, or `KeyValueStore.layerMemory` in tests) and the services its programs need.

## Event bindings (on `h`, Foldkit's builder, rendered by the server)

- `h.OnClick(Message.X())`, `h.OnSubmit(Message.X())` and other Message-valued events: posted as tokens; the Message must be a `ClientMessage`.
- `h.OnInput(value => Message.Changed({ value }))`, `h.OnChange(...)`: function handlers kept in the session; the input becomes client-owned. crease's `input({ onInput })` does this.
- Keyboard handlers (`OnKeyDown` etc.) receive the key and modifiers; `PreventDefault` variants are decided at render time for common keys. `OnPastePreventDefault` and `OnBeforeInputPreventDefault` are not supported.
- `h.OnFileChange(files => ...)`, `h.OnDropFiles(files => ...)`: the files are uploaded (multipart) and reach update as web `File`s (`foldkit/file`'s `File` schema in the Message).
- `OnMount` hooks are dropped (they need a browser): use an island.

## `@hyper-effect/core/testing`

| Helper | Use |
|---|---|
| `serve(program, options?, store?, services?)` | A web handler for the program; `services` is a Layer providing what the program needs. Pass `{ path: '/things/:id' }` in `options` for a page not at `/`. `dispose()` when done. |
| `openPage(handler, path?, cookie?)` | A page GET; returns `html`, `sessionId`, `program`, and `cookie` (yours plus the visitor cookie). |
| `postEvent(handler, page, payload)` | Posts an event: `{ m: token(message), q }` for a ClientMessage, `{ h: handlerId, v: value, q }` for a handler. `q` counts up from 1 per page. |
| `openStream(handler, page)`, `readUntil(response, text)` | The SSE stream as the browser opens it, read until some text appears. Its first event is the whole page: wait for text only your change produces. |
| `token(value)` | The token for a Message (`{ _tag: 'Submitted' }`). |
| `makeStore()`, `waitForSnapshot(store, page)` | An in-memory snapshot store; wait for a session's snapshot. |

Handler ids are in the page: `data-hyper-input="<id>"` on client-owned inputs.

## `@hyper-effect/island`

- `@hyper-effect/island/contract`: `define({ tag, Props, Event })`, shared by server and browser.
- `@hyper-effect/island`: `Island.view(spec, { id, props, onEvent, class? }, h)` in a server view; put it in a region.
- `@hyper-effect/island/client`: `register(spec, make)` in the browser bundle.
- `@hyper-effect/island/vite`: `islandsBuild({ entry, outDir })`; load the bundle with `options.scripts`.

Reference: `examples/dispatch/src/app/dispatch/islands/` and `src/client/islands.ts`.
