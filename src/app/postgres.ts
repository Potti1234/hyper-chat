import { randomUUID } from 'node:crypto'

import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Queue, Redacted, Schedule, Schema as S, type Scope, Semaphore, SubscriptionRef } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'

import { Channel, Member, Message, Read, Saved, Scheduled } from './domain'
import { type Presence, localConnections, sameIds } from './presence'
import { type Typing, decodeEvent, localTyping } from './typing'
import { type Backend, type Snapshot, Workspace, fromBackend, newId, snapshotOf } from './store'
import type { WorkspaceData } from './workspace'

/* The workspace in Postgres.

   - Each process keeps the whole workspace in memory (pages read it there)
     and runs every change as one of `workspace.ts`'s operations inside a
     transaction that holds an advisory lock: it catches up with commits of
     other processes, applies the operation, writes the rows that changed
     (found by reference) and announces the new version with `pg_notify`.
   - Members, channels, messages, reads, saves and scheduled messages are one JSONB document per row,
     decoded with their Schema on load. A field added later gets its default
     in `DEFAULTS`, so older rows still load.
   - Startup begins LISTEN before it reads, so no commit falls into a gap.
   - Presence is a `presence` table of (process, member, heartbeat) rows,
     announced on its own channel; rows whose process stopped beating for
     `STALE_MS` no longer count.
   - Database failures are defects: the pages cannot recover from a lost
     database, and the errors stay in the log. */

const CHANNEL = 'hyperchat_changes'
const LOCK = 7411
const PRESENCE_CHANNEL = 'hyperchat_presence'
const TYPING_CHANNEL = 'hyperchat_typing'
const HEARTBEAT = '20 seconds'
const STALE_MS = 60_000

const DEFAULT_URL = 'postgres://hyperchat:hyperchat-dev@localhost:5435/hyperchat'

/** The connection: DATABASE_URL, or the development database from
 *  `npm run db:up`. */
export const clientLayerFor = (url: string) => PgClient.layer({ url: Redacted.make(url) })
export const clientLayer = clientLayerFor(process.env['DATABASE_URL'] ?? DEFAULT_URL)

type Sql = SqlClient.SqlClient

type Collection = 'members' | 'channels' | 'messages' | 'reads' | 'saves' | 'scheduled'

const TABLES: ReadonlyArray<Collection> = ['members', 'channels', 'messages', 'reads', 'saves', 'scheduled']

const SCHEMAS = {
  members: S.Array(Member),
  channels: S.Array(Channel),
  messages: S.Array(Message),
  reads: S.Array(Read),
  saves: S.Array(Saved),
  scheduled: S.Array(Scheduled),
} as const

/** Defaults for fields added after the first release (older rows lack them). */
const DEFAULTS: Readonly<Record<Collection, Readonly<Record<string, unknown>>>> = {
  members: {},
  channels: {},
  messages: { threadId: null, alsoInChannel: false },
  reads: {},
  saves: {},
  scheduled: {},
}

const keyOf = (collection: Collection, row: unknown): string => {
  const item = row as { id?: string; memberId?: string; channelId?: string; messageId?: string }
  return collection === 'reads' ? `${item.memberId}:${item.channelId}` : collection === 'saves' ? `${item.memberId}:${item.messageId}` : (item.id ?? '')
}

const migrate = (sql: Sql) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(${LOCK})`
      yield* sql`CREATE TABLE IF NOT EXISTS workspace_meta (id INTEGER PRIMARY KEY, version BIGINT NOT NULL)`
      yield* sql`INSERT INTO workspace_meta (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`
      for (const table of TABLES) {
        yield* sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (id TEXT PRIMARY KEY, data JSONB NOT NULL, seq BIGSERIAL)`
      }
      yield* sql`CREATE TABLE IF NOT EXISTS presence (instance TEXT NOT NULL, member_id TEXT NOT NULL, seen_at BIGINT NOT NULL, PRIMARY KEY (instance, member_id))`
      yield* sql`CREATE TABLE IF NOT EXISTS passwords (member_id TEXT PRIMARY KEY, hash TEXT NOT NULL)`
    }),
  )

const load = (sql: Sql): Effect.Effect<Snapshot, SqlError.SqlError | S.SchemaError> =>
  Effect.gen(function* () {
    const [meta] = yield* sql<{ version: string }>`SELECT version FROM workspace_meta WHERE id = 1`
    const rowsOf = (table: Collection) =>
      Effect.map(sql<{ data: Record<string, unknown> }>`SELECT data FROM ${sql(table)} ORDER BY seq`, rows => rows.map(row => ({ ...DEFAULTS[table], ...row.data })))
    const members = yield* Effect.flatMap(rowsOf('members'), S.decodeUnknownEffect(SCHEMAS.members))
    const channels = yield* Effect.flatMap(rowsOf('channels'), S.decodeUnknownEffect(SCHEMAS.channels))
    const messages = yield* Effect.flatMap(rowsOf('messages'), S.decodeUnknownEffect(SCHEMAS.messages))
    const reads = yield* Effect.flatMap(rowsOf('reads'), S.decodeUnknownEffect(SCHEMAS.reads))
    const saves = yield* Effect.flatMap(rowsOf('saves'), S.decodeUnknownEffect(SCHEMAS.saves))
    const scheduled = yield* Effect.flatMap(rowsOf('scheduled'), S.decodeUnknownEffect(SCHEMAS.scheduled))
    const passwordRows = yield* sql<{ member_id: string; hash: string }>`SELECT member_id, hash FROM passwords`
    const data: WorkspaceData = {
      members,
      channels,
      messages: [...messages].sort((a, b) => a.createdAt - b.createdAt),
      reads,
      saves,
      scheduled,
      passwords: Object.fromEntries(passwordRows.map(row => [row.member_id, row.hash])),
    }
    return snapshotOf(Number(meta?.version ?? 1), data)
  })

const CHUNK = 500

/** Writes the rows that differ (by reference) between two versions. */
const persist = (sql: Sql, before: WorkspaceData, after: WorkspaceData) =>
  Effect.gen(function* () {
    for (const table of TABLES) {
      const previous: ReadonlyArray<unknown> = before[table]
      const next: ReadonlyArray<unknown> = after[table]
      if (previous === next) continue
      const old = new Map(previous.map(row => [keyOf(table, row), row]))
      const changed = next.filter(row => old.get(keyOf(table, row)) !== row)
      const kept = new Set(next.map(row => keyOf(table, row)))
      const removed = [...old.keys()].filter(key => !kept.has(key))
      for (let start = 0; start < changed.length; start += CHUNK) {
        const rows = changed.slice(start, start + CHUNK).map(row => ({ id: keyOf(table, row), data: JSON.stringify(row) }))
        yield* sql`INSERT INTO ${sql(table)} (id, data) SELECT id, data::jsonb FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(id TEXT, data TEXT)
          ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`
      }
      for (let start = 0; start < removed.length; start += CHUNK) {
        yield* sql`DELETE FROM ${sql(table)} WHERE id IN ${sql.in(removed.slice(start, start + CHUNK))}`
      }
    }
    if (before.passwords !== after.passwords) {
      for (const [memberId, hash] of Object.entries(after.passwords)) {
        if (before.passwords[memberId] === hash) continue
        yield* sql`INSERT INTO passwords (member_id, hash) VALUES (${memberId}, ${hash}) ON CONFLICT (member_id) DO UPDATE SET hash = EXCLUDED.hash`
      }
      const removed = Object.keys(before.passwords).filter(memberId => after.passwords[memberId] === undefined)
      if (removed.length > 0) yield* sql`DELETE FROM passwords WHERE member_id IN ${sql.in(removed)}`
    }
  })

/** The committed state: ours if nobody else committed since, else a fresh load. */
const catchUp = (sql: Sql, local: Snapshot) =>
  Effect.gen(function* () {
    const [meta] = yield* sql<{ version: string }>`SELECT version FROM workspace_meta WHERE id = 1`
    return Number(meta?.version ?? 1) === local.version ? local : yield* load(sql)
  })

/** Who is online across every process, kept fresh by LISTEN and a heartbeat. */
const postgresPresence = (sql: Sql, pg: PgClient.PgClient, instance: string): Effect.Effect<Presence, never, Scope.Scope> =>
  Effect.gen(function* () {
    const notifications = yield* pg.listen(PRESENCE_CHANNEL).pipe(Effect.orDie)
    const ref = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
    const lock = yield* Semaphore.make(1)
    const quietly = <A, E>(effect: Effect.Effect<A, E>) => Effect.ignore(effect, { log: 'Warn', message: 'presence' })
    const refresh = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* sql<{ member_id: string }>`SELECT DISTINCT member_id FROM presence WHERE seen_at > ${now - STALE_MS} ORDER BY member_id`
      const ids = rows.map(row => row.member_id)
      if (!sameIds(ids, yield* SubscriptionRef.get(ref))) yield* SubscriptionRef.set(ref, ids)
    })
    const publish = (memberIds: ReadonlyArray<string>) =>
      lock.withPermits(1)(quietly(Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`DELETE FROM presence WHERE instance = ${instance}`
          for (const memberId of memberIds) yield* sql`INSERT INTO presence (instance, member_id, seen_at) VALUES (${instance}, ${memberId}, ${now})`
        }))
        yield* sql`SELECT pg_notify(${PRESENCE_CHANNEL}, ${instance})`
        yield* refresh
      })))
    const connect = yield* localConnections(publish)
    yield* refresh.pipe(Effect.orDie)
    yield* Queue.takeAll(notifications).pipe(Effect.orDie, Effect.flatMap(() => quietly(refresh)), Effect.forever, Effect.forkScoped)
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* sql`UPDATE presence SET seen_at = ${now} WHERE instance = ${instance}`
      yield* sql`DELETE FROM presence WHERE seen_at <= ${now - STALE_MS}`
      yield* refresh
    }).pipe(quietly, Effect.repeat(Schedule.spaced(HEARTBEAT)), Effect.forkScoped)
    yield* Effect.addFinalizer(() => quietly(Effect.gen(function* () {
      yield* sql`DELETE FROM presence WHERE instance = ${instance}`
      yield* sql`SELECT pg_notify(${PRESENCE_CHANNEL}, ${instance})`
    })))
    return { online: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref), connect }
  })

/** Typing across every process: events go out by NOTIFY and come back to
 *  each listener, this one included. */
const postgresTyping = (sql: Sql, pg: PgClient.PgClient): Effect.Effect<Typing, never, Scope.Scope> =>
  Effect.gen(function* () {
    const notifications = yield* pg.listen(TYPING_CHANNEL).pipe(Effect.orDie)
    const typing = yield* localTyping(event => Effect.ignore(sql`SELECT pg_notify(${TYPING_CHANNEL}, ${JSON.stringify(event)})`, { log: 'Warn', message: 'typing' }))
    yield* Queue.take(notifications).pipe(
      Effect.orDie,
      Effect.flatMap(notification => {
        const event = decodeEvent(notification.payload)
        return event === undefined ? Effect.void : typing.receive(event)
      }),
      Effect.forever,
      Effect.forkScoped,
    )
    return typing
  })

export const postgresBackend: Effect.Effect<Backend, never, SqlClient.SqlClient | PgClient.PgClient | Scope.Scope> =
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const pg = yield* PgClient.PgClient
    yield* migrate(sql).pipe(Effect.orDie)
    // Listen before reading so commits during startup cannot fall into a gap.
    const notifications = yield* pg.listen(CHANNEL).pipe(Effect.orDie)
    const initial = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
      yield* sql`SET TRANSACTION READ ONLY`
      return yield* load(sql)
    })).pipe(Effect.orDie)
    const ref = yield* SubscriptionRef.make(initial)
    const lock = yield* Semaphore.make(1)
    // Tells this process's own notifications from the others'.
    const instance = randomUUID()
    const presence = yield* postgresPresence(sql, pg, instance)
    const typing = yield* postgresTyping(sql, pg)

    yield* Queue.takeAll(notifications).pipe(
      Effect.orDie,
      Effect.flatMap(batch =>
        batch.every(notification => notification.payload === instance)
          ? Effect.void
          : lock.withPermits(1)(
              Effect.gen(function* () {
                const local = yield* SubscriptionRef.get(ref)
                const fresh = yield* catchUp(sql, local).pipe(Effect.orDie)
                if (fresh.version > local.version) yield* SubscriptionRef.set(ref, fresh)
              }),
            ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    return {
      presence,
      typing,
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      run: op =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const local = yield* SubscriptionRef.get(ref)
            const outcome = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT pg_advisory_xact_lock(${LOCK})`.pipe(Effect.orDie)
                const base = yield* catchUp(sql, local).pipe(Effect.orDie)
                const at = yield* Clock.currentTimeMillis
                const [result, next] = yield* op(base.data, { at, id: newId })
                if (next === base.data) return { result, snapshot: base }
                yield* persist(sql, base.data, next).pipe(Effect.orDie)
                yield* sql`UPDATE workspace_meta SET version = ${base.version + 1} WHERE id = 1`.pipe(Effect.orDie)
                yield* sql`SELECT pg_notify(${CHANNEL}, ${instance})`.pipe(Effect.orDie)
                return { result, snapshot: snapshotOf(base.version + 1, next) }
              }),
            ).pipe(Effect.catchIf(SqlError.isSqlError, Effect.die))
            if (outcome.snapshot !== local) yield* SubscriptionRef.set(ref, outcome.snapshot)
            return outcome.result
          }),
        ),
    }
  })

/** The Workspace service on Postgres (needs `clientLayer`). */
export const layer = Layer.effect(Workspace, Effect.map(postgresBackend, fromBackend))
