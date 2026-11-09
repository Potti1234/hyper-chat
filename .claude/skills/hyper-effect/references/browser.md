# Browser-only behaviour, and how to get it

A page's update and view run on the server; the browser applies morphs and posts events. Most of what an app needs works that way unchanged. This table lists what does not, or needs a specific tool, with the way that works. Check it before reaching for an island.

| Behaviour | How | Reference |
|---|---|---|
| **Keyboard shortcuts for the whole page** (`c`, `/`, Mod+K, `G` then `M`) | `keyBindings(h, [...])` from `@hyper-effect/core`: Foldkit's key grammar, matched in the browser, only a matching key posts. `isEnabled` from the Model; `whileTyping: 'Allow'` for keys that must work in fields (Escape, Mod+K, Mod+Enter). `message` may be a function of `{ targetId }` (the focused element's id) when the field matters (Mod+Enter submits the form you are in). | `apps/starter` (`N`), `apps/linear-clone/src/app/shortcuts/contract.ts` |
| **Keys with modifiers on one element** (Ctrl+Enter in a textarea) | Not with `OnKeyDownPreventDefault` (probed without modifiers). Use a key binding with `whileTyping: 'Allow'` and a function `message` that checks `targetId`. | clone, `submit` shortcut |
| **Move focus** (open a panel and focus its input, focus a field after a shortcut) | A Command forwarded with `clientCommands: { FocusX: () => ({ focus: '#id' }) }`. It runs after the next morph, unless the user has moved focus since they acted (then it would steal it). Focus after a click or a key works. | template `FocusNewTask`, clone `FocusElement` |
| **Scroll an element into view** | `clientCommands: { ScrollX: … => ({ scrollIntoView: '#id' }) }` | clone `ScrollIntoView` |
| **Address bar** (filters, page number) | `{ replaceUrl }` forwarded; Flags read the URL back | admin `ReplaceUrl` |
| **Go to another page** | `{ load: url }` forwarded, or a plain link. Every page is a new session; there is no push-history yet (see `docs/design-latency.md`). | admin `LoadUrl` |
| **Drag and drop between server-rendered targets** (a board) | Works without an island: `OnDragStart`, `OnDragEnter`, `OnDrop` with Messages, and `AllowDrop` on targets. Drag previews, sorting animations and touch dragging need an island. | clone board |
| **Popover/menu positioning** | CSS anchor positioning (`anchor-name` / `position-anchor`), as crease's menus do. No measuring needed. | crease dropdown-menu |
| **Foldkit UI Submodels** (tabs, menus, combobox, listbox, select, command) | Run on the server unchanged. Their focus, scroll and click Commands are forwarded automatically (`foldkitUiCommands`), so arrow keys and Enter work. | `docs/compatibility.md` |
| **Menus with hover highlight** | crease `dropdownMenu({ activateOnHover: false })`: hover in CSS, no request per item. | clone ⋯ menu |
| **Modal dialogs** (crease dialog, sheet, drawer, alert-dialog, command in a dialog) | Do not open on a server yet (`ShowDialog` needs a browser and reports back). Render an overlay from the Model instead: a fixed panel plus backdrop, shown when the Model says so. | clone create-issue dialog |
| **`OnMount` hooks, measuring, canvas, maps, rich editors** | An island: a Foldkit program in the browser, with Props in and Events out. | `examples/dispatch` map |
| **Clipboard copy** | `h.OnCopyText(text)` is bound | — |
| **File uploads** | `h.OnFileChange` / `h.OnDropFiles`: uploaded, arrive as `File`s | admin images |
| **Typing, IME, autofill** | Client-owned inputs (`onInput`): handled, including change-only fills | `check:inputs` |
