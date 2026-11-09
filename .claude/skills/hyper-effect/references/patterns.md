# Patterns, with working references

Every pattern here runs in the repository and is covered by a browser check. Read the referenced file before writing your own; copy its shape.

## Pages and data

| Need | Reference | Notes |
|---|---|---|
| The smallest complete page | `apps/starter/src/app/tasks/page.ts` | Model, Messages, ClientMessage, Commands, Subscription, regions, snapshotDeps |
| Shared state, live for everyone | `apps/starter/src/app/tasks/store.ts`, `examples/dispatch/src/app/dispatch/store.ts` | A service with a `SubscriptionRef` and `changes` (current value first, then each new one). Pages subscribe; `memoizeLast` builds the Message once for all sessions |
| The same on Postgres, several processes | `examples/admin/src/app/catalog/postgres.ts` | Writes in a transaction with `pg_notify`; one `LISTEN` per process feeding a version the pages watch |
| A list with search, filters, sorting, pagination | `examples/admin/src/app/products/list.ts`, `catalog/domain.ts` | The query lives in the Model; `LoadPage` Command; ignore answers to older queries (`sameQuery`); a change feed only signals, each page re-queries |
| In-page state in the address bar | same, `ReplaceUrl` + `clientCommands` | Flags read the URL back (`queryFromUrl`); the Command is forwarded as `{ replaceUrl }` |
| A detail page from the URL | `examples/admin/src/app/products/edit.ts` (`/products/:id`), `examples/dispatch/src/app/dispatch/incident.ts` | `request.params.id` in flags; `PageNotFound` for unknown ids |
| Navigate after an action | `examples/admin/src/app/products/edit.ts`, `LoadUrl` | Forwarded as `{ load: url }` |

## Forms

| Need | Reference | Notes |
|---|---|---|
| Typed fields | starter `newTaskForm`, admin `edit.ts` (`ChangedField`) | `input({ onInput })`: client-owned; the draft lives in the Model as strings |
| Validation with Schema | starter `validateTitle`, admin `domain.ts` `validateDraft` / `fieldErrors` | Validate in update on submit; errors keyed by field name, shown next to the field |
| Clear the form after saving | starter `SucceededAdd` | Set the draft to `''`: the server patches the client-owned input because the Model now differs from what the browser sent |
| Server-side errors (taken name, deleted row) | admin `SaveProduct` | The Command catches the error and returns a Message (`FailedSave`); never let a Command fail silently |
| Edit conflicts | admin `edit.ts`, `StaleRevision` | Save names the revision it started from; the store refuses stale writes; the user can take the other version |
| Submit right after typing | built in | Unsent typed values travel with every event and are applied first |

## Users

| Need | Reference | Notes |
|---|---|---|
| Sign-in | `apps/starter/src/app/auth.ts` | Signed cookie; `requireUser` in flags, `principal` in options |
| Roles | `examples/admin/src/app/auth.ts`, `edit.ts` `editing(...)` | Hide controls in the view and refuse in update: the browser can post any ClientMessage |
| Presence (who is here) | `examples/dispatch/src/app/dispatch/board.ts`, `presence` subscription | `onConnectionChange` puts `isConnected` in the Model; the Subscription depends on it and joins only while connected; `sampleLatest` |

## Rendering

| Need | Reference | Notes |
|---|---|---|
| Lists that change one row at a time | starter `taskList`, admin `results`, dispatch board rows | A region for the list, a region per row with `deps: [row]` |
| Rows every user sees alike | dispatch board, `region({ shared: true })` | Rendered once per change for all sessions; Messages only, no user data |
| crease/ui components | `src/ui/*` + `src/lib/*` in each app | Copy more from `examples/*/src/ui`; they take `(props, h)` |
| Stateful widgets (tabs, toggle group, menus) | dispatch board `ToggleGroup` (`src/ui/toggle-group.ts`) | Foldkit UI Submodels run on the server unchanged; their focus Commands are forwarded (`foldkitUiCommands`) |
| Browser-only widgets (maps, canvas, rich editors, drag previews) | `examples/dispatch/src/app/dispatch/islands/`, `src/client/islands.ts`, `vite.islands.config.ts` | An island: a Foldkit program in the browser; Props in, Events out as Messages; put `Island.view` in a region; the bundle via `options.scripts` and a CSP `connect-src` for its sources. Check `browser.md` first: shortcuts, focus and drag and drop need no island |

## Keyboard, focus, menus

| Need | Reference | Notes |
|---|---|---|
| Page-wide shortcuts | `apps/starter` (`N`), `apps/linear-clone/src/app/shortcuts/contract.ts` | `keyBindings(h, [...])`; the clone's table has single keys, sequences (`G` `M`), Mod+K and Mod+Enter while typing, and turns list keys off while an overlay is open |
| Focus after an action | template `FocusNewTask`, clone `FocusElement` (and its `update` wrapper) | A Command forwarded as `{ focus }` |
| A filterable picker (Linear's status/assignee menus) | `apps/linear-clone/src/app/view/picker.ts` | State in the page Model, items filtered in update, anchored with CSS, keys on its input |
| A command palette | the same picker in `command` mode; crease `command` rendered inline also works now (Enter is forwarded) | Not inside crease's modal dialog yet |
| Menus | crease `dropdownMenu` as a Submodel, with `activateOnHover: false` | clone issue page, the menu next to presence |
| Drag and drop on a board | `apps/linear-clone/src/app/issues/page.ts` (board) | Native drag events with Messages; no island |
| Inline editing saved on blur | clone issue page description | crease `textarea` with `attributes: [h.OnBlur(...)]` |

## Files

| Need | Reference | Notes |
|---|---|---|
| Upload | admin `edit.ts` (`ChoseImage`, `StoreImage`), `catalog/images.ts` | `h.OnFileChange` / `h.OnDropFiles`; the Message carries `File`s; a Command stores them; the Model keeps a reference only. Check the bytes, not the claimed type; serve with `nosniff` |

## Running it

| Need | Reference |
|---|---|
| Behind nginx, HTTP/2, compression, several processes, Postgres | `docs/deployment.md` |
| Load and soak tests | `docs/performance.md`, `tools/perf/` |
