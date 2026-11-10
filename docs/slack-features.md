# Slack: features, layout and how hyper-chat covers them

This is the reference for hyper-chat, a Slack clone built the way hypertasks
clones Linear: hyper-effect pages (server-side Foldkit on Effect, Datastar in the
browser), Postgres, and creaseui components under the strict lint preset.
Each section lists what Slack does, how its UI is laid out, and the status in
hyper-chat (**done**, **planned**, or **out of scope** with the reason).

## 1. Layout

Slack's desktop client (2023+ redesign) is a fixed frame of four columns:

| Column | Width | Content |
| --- | --- | --- |
| Workspace rail | ~70 px | Workspace icon (switcher), then tabs with icon + label: **Home**, **DMs**, **Activity**, **Later**, **More** (Files, People, Channels…). At the bottom: **+ (create)** and the user's avatar with presence dot (opens the profile/status menu). |
| Sidebar | 260 px, resizable | Header: workspace name ▾ (menu: preferences, sign out) and a compose (new message) button. Sections (collapsible ▸/▾): **Threads**, **Activity**-style shortcuts, **Channels** (`# name`), **Direct messages** (avatar + presence + name), **Apps**. Unread rows are bold white; mention counts are red pills. "+ Add channels" / "+ Add coworkers" at the end of each section. |
| Main view | flexible | Channel header: `# name ▾` (opens details), member avatars stack with count, huddle button, ⋮. Under it a tab bar: **Messages**, **Canvas**, **Pins**, **Files**, **Bookmarks**. Then the message list and the composer. |
| Secondary pane | ~400 px, optional | Thread replies, a profile, channel details, or search results. Opens beside the main view; closable with ×. |

The top bar holds ← → history and a centred **Search** field (Ctrl/Cmd+K opens
the quick switcher, Ctrl/Cmd+G search). Colours: an aubergine rail/sidebar
(`#3f0e40` / `#4a154b` in the classic theme, "Aubergine" in the new one),
white main view, 15 px Lato message text, bold 15 px author names, 12 px grey
timestamps.

hyper-chat: same four columns built from `box` adapters and creaseui
components; the colours are theme tokens (`--sidebar`, `--sidebar-foreground`,
…) so the twelve creaseui presets and dark mode restyle the whole app.

## 2. Workspace, accounts, presence

| Feature | Slack | hyper-chat |
| --- | --- | --- |
| Sign in | Email + password / magic link / SSO | Email + password (scrypt), signed cookie, like hypertasks — **done** |
| Workspace switcher | Several workspaces in the rail | One demo workspace ("Northwind"), shown in the rail — **done** (single workspace) |
| Presence | Active (green dot) / away (hollow) | Active while a page of yours is connected, away otherwise — **done** (green dot or hollow ring on DM rows, People cards and profiles; shared across app processes through Postgres with a heartbeat) |
| Custom status | Emoji + text + "clear after" | Emoji + text, shown next to names — **done** (emoji picker, Slack's presets, clear after 30 min / 1 h / 4 h / today / this week / never) |
| Pause notifications (DND) | Snooze for a period | A flag with a moon icon on the avatar — **done** (30 min to 24 h from your profile; Resume) |
| Profile | Name, display name, title, pronouns, local time, status, "Message" button | Profile pane with name, title, local time, status, Message button — **done** (`/people/:id`; names in messages link to it; you edit your name, title, pronouns and time zone) |
| People directory | Searchable list of members | People view — **done** (`/people`, cards filtered by name, handle or title) |
| Invite people | Email invites | `npm run user:create`, admins add accounts — **planned** (CLI) |
| SSO, SCIM, Enterprise Grid, billing | — | **out of scope** (no external accounts) |

## 3. Conversations

| Feature | Slack | hyper-chat |
| --- | --- | --- |
| Public channels | `#name`, anyone can browse and join | **done** |
| Private channels | 🔒 lock icon, invite only | Lock icon, visible to members only — **done** |
| Direct messages | 1:1, including a DM with yourself | **done** |
| Group DMs | Up to 9 people | **done** |
| Create channel | Dialog: name (lower case, dashes), visibility, description | `/channels?new` — **done** |
| Browse channels | List with search, member counts, Join | `/channels` (all / joined / archived) — **done** |
| Join / leave | Button in the channel; "joined #x" system message | Join button for visitors, Leave in details (`#general` can't be left) — **done** (no system message) |
| Topic / description | Edited in channel details; shown in the header | **done** |
| Channel details | Dialog with tabs: About, Members, Settings (rename, archive, leave) | **done** |
| Add people to channel | From details → Members | **done** |
| Archive channel | Read-only, hidden from sidebar | Any member can archive (no admin roles yet) — **done** |
| Star / favourite | Starred section at the top of the sidebar | **planned** |
| Mute | Muted channels are greyed and never bold | **planned** |
| Custom sidebar sections | Drag channels into own sections | **out of scope** (fixed sections) |
| Slack Connect (other companies) | — | **out of scope** |

## 4. Messages

| Feature | Slack | hyper-chat |
| --- | --- | --- |
| Send | Enter sends, Shift+Enter new line | **done** |
| Grouping | Same author within a few minutes collapses avatar and name; hover shows the time in the gutter | **done** |
| Day dividers | Sticky "Today", "Yesterday", "Monday, November 3rd" pills | **done** |
| New-messages line | Red "New" line where you stopped reading | **done** |
| Edit / delete own | Hover toolbar ⋮ menu; "(edited)" marker; delete confirmation | **done** |
| Reactions | Emoji picker, reaction pills with counts, hover lists who reacted | **done** |
| Hover toolbar | ✅ 👀 🙌 quick reactions, add reaction, reply in thread, forward, save for later, ⋮ | **done** (no forward) |
| Threads | "Reply in thread" opens the thread pane; "N replies" row with avatars and last reply time; "Also send to #channel" checkbox | **done** |
| Threads view | All threads you are part of, unread first | **done** |
| Mentions | `@person`, `@channel`, `@here`; highlighted, yellow background when it mentions you | **done** |
| Channel links | `#channel` links | **planned** |
| Formatting | Bold `*x*`, italic `_x_`, strike `~x~`, `code`, code blocks, quotes `>`, lists, links; a formatting toolbar | **done**: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ``` ```` blocks, `>` quotes, `-` and `1.` lists, `[text](url)` and bare links, `:emoji:` names; a formatting bar above every composer with Slack's shortcuts (Ctrl+B, Ctrl+I, Ctrl+Shift+X/U/C/7/8/9) |
| Pins | Pin to channel, Pins tab | **done** (Pins tab in the header and details, "Pinned by" label) |
| Save for later | Bookmark a message, Later view (in progress / done) | **done** (Later page with In progress / Completed) |
| Copy link | Link to a message | **planned** |
| Mark unread | From the ⋮ menu: unread from here | **done** (also from the hover menu on others’ messages) |
| Files | Upload in the composer (📎 / drop), image previews, Files tab | **done**: the + button or a drop on the channel/DM composer uploads up to 10 files of up to 10 MB; they wait as removable cards and a message may be only files. PNG, JPEG, GIF and WebP (recognised by their bytes) show inline and open full size; anything else is a download card. Served only to people who can read the conversation. Not yet: uploads in thread replies and the Files tab |
| Typing indicator | "Alex is typing…" under the composer | **planned** |
| Scheduled messages, reminders | Send later, "Remind me about this" | **planned** (later) |
| Link unfurls | Preview cards for URLs | **out of scope** (no outbound fetching) |
| Huddles, calls, clips | Audio/video | **out of scope** (needs WebRTC media servers) |
| Canvases, lists | Collaborative docs | **out of scope** (hypertasks has docs) |
| Workflows, apps, bots | Workflow Builder, app directory | **out of scope** |

## 5. Navigation and finding things

| Feature | Slack | hyper-chat |
| --- | --- | --- |
| Unreads | Bold rows, red mention pills, "All unreads" view | **done** (bold rows, mention pills, Activity badge; no separate "All unreads" view yet) |
| Activity | Mentions, reactions to your messages, thread replies | **done** (filters: all, mentions, threads, reactions; unreads only) |
| Search | Messages, channels, people; modifiers `in:#x`, `from:@y`, `has:link`, before/after | **done** (top bar field, `/search` with Messages / Channels / People, `in:` and `from:` with chips, live results; no `has:` or dates yet) |
| Quick switcher | Ctrl/Cmd+K: jump to a channel or person | **done** (on every page: your channels and DMs, people, and a "Search for …" row; arrows + Enter) |
| Keyboard shortcuts | Alt+↑/↓ previous/next channel, Esc marks read, ↑ edits your last message, Ctrl+/ shortcut list | **planned** |
| History ← → | Browser-like back/forward | Browser back/forward (each view is a URL) — **done** by design |

## 6. Preferences

| Feature | Slack | hyper-chat |
| --- | --- | --- |
| Themes | Light/dark and colour themes | Light/dark, Slack's sidebar colour themes (Aubergine, Clementine, Banana, Jade, Lagoon, Barbra, Gray, Mood Indigo) and the twelve creaseui presets, per account, on `/preferences` (the gear on the rail) — **done** |
| Message display | Clean or compact | Clean (pictures, roomy rows) or compact (no pictures, tighter rows) — **done** |
| Clock | 12- or 24-hour times | 12- or 24-hour, in your own time zone — **done** |
| Sidebar options | Show/hide sections, sort | **out of scope** |
| Notification preferences | All / mentions / nothing, per channel | Per channel: all / mentions / nothing (affects badges) — **planned** |
| Language and region | — | **out of scope** |

## 7. Implementation order

Each line is its own commit in hyper-chat:

1. Scaffold from hypertasks: packages, lint, creaseui copies, design layer, auth, Postgres store.
2. Channel view with the Slack frame, live messages, demo seed.
3. Message actions: edit, delete, reactions with an emoji picker.
4. Threads and the Threads view.
5. DMs and group DMs.
6. Channel management: create, browse, join/leave, topic, details, private channels.
7. Unreads, mentions, Activity, mark unread.
8. Save for later and pins.
9. Search and the quick switcher.
10. Profiles, status, presence, people.
11. Preferences and themes.
12. Formatting and the composer toolbar.
13. File attachments.
14. Typing indicators and muting.
