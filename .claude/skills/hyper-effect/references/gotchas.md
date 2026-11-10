# Pitfalls

Each of these broke something during hyper-effect's development or experiments. Symptom first, then the fix.

## Views and regions

- **"region … renders differently with the same deps"** (development). The region's view reads something its `deps` miss. Add every Model value it reads, including values used only for classes or labels. The time (`Date.now()`) and randomness are never allowed in a view: put the time in the Model (a tick Subscription) and add it to deps.
- **"region … keeps its deps while its nested region … changes".** A parent region's deps must cover everything its nested regions read, because an unchanged parent keeps its children without rendering them. Usually: put the list itself in the parent's deps.
- **"region … must render one element with h.Id(…)".** `render` returns exactly one element, and its id equals the region id.
- **"placed twice in one render".** Region ids are unique per page. Rows: `task-${task.id}`.
- **"a view bound a Message that is not a ClientMessage".** Add it to `ClientMessage` if a browser may really send it; otherwise the view must not bind it. Never add Command results or Subscription Messages: anyone could post them.
- **Shared region "renders differently … for another session".** A `shared: true` region read the user or other session state. Drop `shared`, or take that data out of the region.
- **Tailwind classes missing.** `src/styles.css` scans `src/` for class names: classes built at runtime (`` `text-${color}` ``) are not found. Write full class names, or map values to complete strings.
- **A Message returning the same Model** (`{ model }`) renders nothing. That is intended; mutate nothing in place, or the change goes unseen.

## Events and inputs

- **Typed text lost, or overwritten while typing.** Bind inputs with `onInput`/`onChange` handlers (client-owned), never by posting their value in a ClientMessage, and never render a typed field's value from anything but the Model field the handler sets.
- **The field does not clear after saving.** Set the Model's draft to `''`; the server patches a client-owned input once the Model differs from what the browser sent. A view-only reset does nothing.
- **Double clicks post twice.** Requests are never cancelled (a cancelled click would be lost). Guard in update: ignore a submit while `isSaving`, and make actions idempotent where they matter.
- **Not supported:** `OnPastePreventDefault`, `OnBeforeInputPreventDefault`, `OnMount`. Use an island for anything that needs the DOM.
- **A key with modifiers on an element does nothing** (`OnKeyDownPreventDefault` returning Some only for Ctrl+Enter). Those handlers are probed at render time without modifiers. Use `keyBindings` with `whileTyping: 'Allow'`.
- **Shortcuts on `<body>` never fire.** Element key handlers only see keys while the element (or a child) has focus, and the view renders inside `<body>`. Use `keyBindings`.
- **Menus feel slow over a network.** Every hover or arrow key in a server-side Submodel is a round trip. Use `activateOnHover: false` on crease menus; `docs/design-latency.md` has what comes next.

## Commands

- **"Command … needs a browser … skipped on the server".** It touched `window`, `document` or similar. Forward it with `clientCommands` (focus, scrollIntoView, replaceUrl, load) if its result Message is only an acknowledgement, or move the behaviour into an island.
- **A forwarded Command's result Message never arrives.** By design: forwarded Commands are performed by the browser after the morph, and their result is dropped. Do not forward Commands whose result drives the page (that is why crease's modal dialogs do not open on a server yet).
- **A forwarded focus does not happen.** It is skipped when the user has moved focus elsewhere since they acted, so it never steals focus. If it never happens, check that the selector exists after the morph and that the Command is in `clientCommands`.
- **A Command fails and nothing happens.** A failing Command is logged and produces no Message. Catch expected errors inside the Command and turn them into Messages (`FailedSave`, `FailedChange`).
- **Effects running twice.** Events are applied exactly once, even across retries and process failures; Commands are not re-run on failover, but one in flight when a process dies is lost. Make external effects idempotent (an idempotency key), or record the intent in the Model.

## State and sessions

- **The Model must be plain data,** encodable with `Schema.toCodecJson(Model)`: it is snapshotted for restarts and failover. No `File`s (store them, keep an id), functions, class instances or Effects.
- **flags run more than once.** On every page load, and when a session is recreated from its URL after a restart without a snapshot (with the stream request's cookies). Keep them free of side effects that must happen once.
- **Shared data in snapshots.** Leave it out of `snapshotDeps`; the Subscription delivers it again after a restore. Otherwise every shared change rewrites every session's snapshot.
- **Two layers with the same `program.name`** share endpoints and snapshots. Every page needs its own name, also when one program serves several paths (export a `makeProgram(name)`, as the clone's `issues/page.ts` does).
- **Sessions end.** A tab that is closed (or loses its connection) for longer than `idleTimeout` (2 minutes) loses its session; reopening loads the page anew from flags. Keep durable state in stores, not in a page's Model.

## Running and measuring

- **Development is 3–10× slower.** Markup validation and the region checks run on every render outside production. Measure with `NODE_ENV=production`.
- **Inline scripts or styles do not run.** The Content-Security-Policy allows only nonce'd hyper-effect scripts and your `scripts`/`stylesheets`. Add other origins with `contentSecurityPolicy.directives`.
- **Behind a proxy, live updates stall or posts get 403.** See `docs/deployment.md`: pass the `Host` header (or set `trustProxy` and `X-Forwarded-Host`), and never answer a dead upstream with an error status for session requests.
