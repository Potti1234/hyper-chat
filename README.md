# hyper-chat

A Slack-style team chat: channels, direct messages, threads, reactions, files, search and live presence. Built with hyper-effect like [hypertasks](https://github.com/Potti1234/hyper-tasks): Foldkit programs run on the server with Effect, Datastar updates the browser, and Postgres stores the workspace.

All bundled people, channels and messages are fictional demo content. Demo addresses use the reserved `hyperchat.example` domain.

## Start locally

Requires Node.js 22.19 or later and Docker with Compose.

```sh
npm install
npm run db:up
npm run demo:seed
npm run dev
```

Open [localhost:4300](http://localhost:4300). The database runs on `localhost:5435` in its own `hyperchat` Compose project. `npm run db:up` creates `.env` with random application secrets if it does not exist. `PORT` changes the application port and `DATABASE_URL` the database (default `postgres://hyperchat:hyperchat-dev@localhost:5435/hyperchat`). `npm run dev` restarts the server when source files change; `npm start` runs it without watching.

| Name | Email | Password |
| --- | --- | --- |
| Avery Finch | afinch@hyperchat.example | avery |
| Blake Okafor | bokafor@hyperchat.example | blake |
| Casey Lindqvist | clindqvist@hyperchat.example | casey |

Eight demo people in all; each password is that person's first name in lower case. Passwords are stored as scrypt hashes. Sign in as two people in two browsers to see messages, typing and presence arrive live.

## Demo workspace

The seed adds the Northwind workspace: public channels (#general, #random, #design-crit, #engineering, #product-launch, #customer-support), a private #leadership channel, direct and group messages, threads, reactions and unread history. Times are relative to the moment of seeding. Everything it adds is marked `isDemo`: `npm run demo:clear` removes it and keeps accounts and channels you created, and `npm run demo:reset` clears and seeds again. The seed is idempotent.

To create an account from the command line (it joins #general):

```sh
npm run user:create -- --name "Harper Willow" --email hwillow@hyperchat.example --password "demo-password"
```

## Features

[docs/slack-features.md](docs/slack-features.md) is the full inventory of Slack's features, with what is done here and what is out of scope and why. In short:

- **Layout:** Slack's workspace rail, sidebar with Starred / Channels / Direct messages sections, conversation header with tabs, message list with day dividers, composer, and a thread pane.
- **Conversations:** public and private channels (browse, create, join, leave, topic, description, archive), DMs and group DMs, starring, muting, and per-conversation notification levels (all messages, mentions, nothing).
- **Messages:** mrkdwn formatting with a formatting bar and Slack's shortcuts, @mentions, `#channel` links, emoji, reactions, editing, deleting, threads with "Also send to #channel", pins, Save for later, Copy link (`/archives/:channel/:message` permalinks), Mark unread, file uploads with image previews and a Files tab, typing indicators, scheduled messages and "Remind me about this".
- **Finding things:** Activity (mentions, thread replies, reactions, reminders), Threads, Later, search with `in:` and `from:`, the Ctrl+K switcher, the People directory, and keyboard shortcuts (Ctrl+/ lists them).
- **You:** profiles, custom status with "clear after", pausing notifications, presence, light/dark, Slack's sidebar themes, the twelve creaseui presets, compact display and a 24-hour clock, all saved per account.

## Run the full stack in Docker

```sh
npm run setup
docker compose up -d --build
docker compose exec app npm run demo:seed
```

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run db:up
npm run test:pg
npm run check:fresh
```

`npm run lint` runs ESLint with the `@creaseui/lint` strict preset, `creaseui-lint doctor` (manifest and component coverage), `creaseui-lint css` and the native-control and overlay tests. `npm run test:pg` runs the Postgres tests (two processes sharing a database, restarts) against a throwaway `hyperchat_test` database. `npm run check:fresh` builds the assets, seeds a throwaway `hyperchat_check` database, starts a server on port 4200, drives two signed-in browsers through the features, and opens every menu and popover at two window sizes to check that none lands off screen.

## Architecture

Each page is a server-side Foldkit program with a pure update and view; Commands carry out effects. Shared changes are pure operations in `src/app/workspace.ts` run by the `Workspace` service (`src/app/store.ts`); Postgres (`src/app/postgres.ts`) writes the rows that changed and notifies the other processes, and every open page re-renders the regions whose data changed. Presence and typing travel over Postgres NOTIFY without being stored. Uploaded files live in Postgres and are served only to people who can read a conversation they were shared in. A scheduler (`src/app/scheduler.ts`) posts scheduled messages and sets off reminders when they come due.

The UI is composed from creaseui components copied into `src/ui` (see `crease.lock.json`). Only the owned adapters (`src/app/view/design.ts` and the icons) render raw elements. Theme presets are `.theme-<slug>` blocks in `src/themes.css`, applied on the page root. [AGENTS.md](AGENTS.md) lists the rules for changing the app.

hyper-effect comes from npm: `@hyper-effect/core` (0.1.1), on Foldkit 0.170 and Effect 4.1.
