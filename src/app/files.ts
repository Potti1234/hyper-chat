import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Option } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { SqlClient } from 'effect/sql'

import { signedInMemberId } from './auth'
import { type Attachment, canRead } from './domain'
import { Workspace, type WorkspaceState } from './store'

/* Files shared in messages. Uploads arrive as web `File`s (hyper-effect's
   uploads, `h.OnFileChange`/`h.OnDropFiles`); the bytes are kept here and a
   message holds only an `Attachment` (id, name, type, size).

   - PNG, JPEG, GIF and WebP are recognised by their bytes, never by the name
     or the type the browser claims, and shown inline. Everything else is
     stored as `application/octet-stream` and only ever downloaded. SVG is not
     an image here: it can carry script.
   - `/files/:id` serves a file to whoever may read the conversation it was
     shared in, or to its uploader before it is sent; anyone else gets a 404.
     Responses carry `nosniff` and a policy that runs nothing.
   - In memory for tests, in Postgres (`files` table) for the app; a larger
     deployment would use object storage. */

export const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_NAME = 120

export class FileRejected extends Data.TaggedError('FileRejected')<{ readonly reason: string }> {}

export type Stored = Readonly<{ uploaderId: string; name: string; type: string; bytes: Uint8Array }>

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

/** The image type the bytes are, if they are one shown inline. */
export const sniffImageType = (bytes: Uint8Array): string | undefined =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? 'image/png'
    : startsWith(bytes, [0xff, 0xd8, 0xff])
      ? 'image/jpeg'
      : startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
        ? 'image/gif'
        : startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
          ? 'image/webp'
          : undefined

/** A file name safe to show and to send back in a header. */
export const cleanName = (name: string): string => {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const clean = [...base].filter(char => char >= ' ' && char !== '\u007f' && char !== '"').join('').trim().slice(0, MAX_NAME)
  return clean === '' ? 'file' : clean
}

/** The bytes, name and type kept for an upload, or why it is refused. */
export const accept = (file: File, uploaderId: string): Effect.Effect<Stored, FileRejected> =>
  Effect.gen(function* () {
    if (file.size === 0) return yield* new FileRejected({ reason: `${cleanName(file.name)} is empty.` })
    if (file.size > MAX_FILE_BYTES) return yield* new FileRejected({ reason: 'Files can be at most 10 MB.' })
    const bytes = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))
    return { uploaderId, name: cleanName(file.name), type: sniffImageType(bytes) ?? 'application/octet-stream', bytes }
  })

export class Files extends Context.Service<
  Files,
  {
    readonly put: (file: File, uploaderId: string) => Effect.Effect<Attachment, FileRejected>
    readonly get: (id: string) => Effect.Effect<Option.Option<Stored>>
  }
>()('hyperchat/Files') {}

const attachmentOf = (id: string, stored: Stored): Attachment => ({ id, name: stored.name, type: stored.type, size: stored.bytes.length })

const fileId = () => `file_${crypto.randomUUID().replaceAll('-', '')}`

export const memoryLayer = Layer.sync(Files, () => {
  const files = new Map<string, Stored>()
  return {
    put: (file, uploaderId) =>
      Effect.map(accept(file, uploaderId), stored => {
        const id = fileId()
        files.set(id, stored)
        return attachmentOf(id, stored)
      }),
    get: id => Effect.sync(() => Option.fromNullishOr(files.get(id))),
  }
})

/** Files in Postgres (needs the app's `clientLayer`). */
export const postgresLayer = Layer.effect(
  Files,
  Effect.gen(function* () {
    yield* PgClient.PgClient
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    yield* sql`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, uploader_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, bytes BYTEA NOT NULL, created_at BIGINT NOT NULL)`.pipe(Effect.orDie)
    return {
      put: (file, uploaderId) =>
        Effect.gen(function* () {
          const stored = yield* accept(file, uploaderId)
          const id = fileId()
          yield* sql`INSERT INTO files (id, uploader_id, name, type, bytes, created_at) VALUES (${id}, ${uploaderId}, ${stored.name}, ${stored.type}, ${stored.bytes}, ${Date.now()})`.pipe(Effect.orDie)
          return attachmentOf(id, stored)
        }),
      get: id =>
        Effect.map(
          sql<{ uploader_id: string; name: string; type: string; bytes: Uint8Array }>`SELECT uploader_id, name, type, bytes FROM files WHERE id = ${id}`.pipe(Effect.orDie),
          ([row]) => Option.fromNullishOr(row === undefined ? undefined : { uploaderId: row.uploader_id, name: row.name, type: row.type, bytes: new Uint8Array(row.bytes) }),
        ),
    }
  }),
)

/** Whether a member may fetch a file: they can read a conversation it was
 *  shared in, or they uploaded it and have not sent it yet. */
export const mayRead = (state: WorkspaceState, fileId: string, memberId: string, stored: Stored): boolean => {
  const shared = state.messages.filter(message => message.files?.some(file => file.id === fileId) === true)
  if (shared.length === 0) return stored.uploaderId === memberId
  return shared.some(message => {
    const channel = state.channels.find(candidate => candidate.id === message.channelId)
    return channel !== undefined && canRead(channel, memberId)
  })
}

const notFound = HttpServerResponse.empty({ status: 404 })

export const routes = HttpRouter.add(
  'GET',
  '/files/:id',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const memberId = signedInMemberId(request.cookies)
    if (memberId === undefined) return HttpServerResponse.empty({ status: 403 })
    const { id = '' } = yield* HttpRouter.params
    const found = yield* Files.use(files => files.get(id))
    if (Option.isNone(found)) return notFound
    const stored = found.value
    const state = yield* Workspace.use(workspace => workspace.current)
    if (!mayRead(state, id, memberId, stored)) return notFound
    const isInline = stored.type.startsWith('image/')
    return HttpServerResponse.uint8Array(stored.bytes, {
      contentType: stored.type,
      headers: {
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `${isInline ? 'inline' : 'attachment'}; filename="${stored.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(stored.name)}`,
      },
    })
  }),
)
