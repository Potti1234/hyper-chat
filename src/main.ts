import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Layer } from 'effect'
import { HttpRouter, HttpServerResponse, HttpStaticServer } from 'effect/http'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import * as Hyper from '@hyper-effect/core'

import * as Auth from '@/app/auth'
import * as ClientPage from '@/app/client/page'
import * as ChannelsPage from '@/app/channels/page'
import * as DmsPage from '@/app/dms/page'
import * as ThreadsPage from '@/app/threads/page'
import * as Postgres from '@/app/postgres'

/* The server: one hyper-effect layer per page, plain routes for sign-in and
   static files, the workspace in Postgres, and session snapshots there too
   (open pages carry on across restarts).

   Environment:
   - PORT (default 4300)
   - DATABASE_URL (default: the development database of `npm run db:up`,
     postgres://hyperchat:hyperchat-dev@localhost:5435/hyperchat)
   - APP_SECRET signs the sign-in cookie; HYPER_SNAPSHOT_SECRET seals session
     snapshots. Both have development values in the source: set them
     everywhere else.
 */

const port = Number(process.env['PORT'] ?? 4300)
const publicFile = (path: string) => fileURLToPath(new URL(`../public/${path}`, import.meta.url))

export const page: Hyper.Options = {
  stylesheets: ['/styles.css'],
  // Keeps the sidebar and the message list where they were scrolled to.
  scripts: ['/keep-scroll.js'],
  // Sessions belong to the signed-in member; signing out ends them.
  principal: Auth.principal,
  snapshotSecret: Hyper.secretFromEnvironment('HYPER_SNAPSHOT_SECRET', 'dev-snapshot-secret, set HYPER_SNAPSHOT_SECRET'),
}

const Routes = Layer.mergeAll(
  // "/" opens your home conversation (#general).
  Hyper.layer(ThreadsPage.program, { ...page, path: '/threads' }),
  Hyper.layer(ChannelsPage.program, { ...page, path: '/channels' }),
  Hyper.layer(DmsPage.program, { ...page, path: '/dms' }),
  Hyper.layer(ClientPage.program, { ...page, path: '/client/:channel', paths: ['/', '/client/:channel/thread/:thread'], prefetch: ['/client/*'] }),
  Auth.routes,
  HttpRouter.add('GET', '/favicon.ico', HttpServerResponse.file(publicFile('favicon.svg'), { contentType: 'image/svg+xml' })),
  HttpRouter.add('GET', '/favicon.svg', HttpServerResponse.file(publicFile('favicon.svg'), { contentType: 'image/svg+xml' })),
  HttpRouter.add('GET', '/styles.css', HttpServerResponse.file(publicFile('styles.css'), { contentType: 'text/css' })),
  HttpRouter.add('GET', '/keep-scroll.js', HttpServerResponse.file(publicFile('keep-scroll.js'), { contentType: 'text/javascript' })),
  HttpStaticServer.layer({ root: publicFile('fonts'), prefix: '/fonts' }),
)

HttpRouter.serve(Routes).pipe(
  Layer.provide(Hyper.sqlStore()),
  Layer.provideMerge(Postgres.layer),
  Layer.provide(Postgres.clientLayer),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
)
