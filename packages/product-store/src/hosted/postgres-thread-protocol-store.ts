import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import {
  ActorAttribution,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { StoreError } from "@rika/product/hosted-store"
import { InteractiveEventSchema } from "@rika/product/interactive-event"
import { HostedThreadSnapshot } from "@rika/product/client-protocol"
import {
  ThreadProtocolStore,
  type ThreadProtocolCommand,
  type ThreadProtocolEvent,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import { requireThreadAccess } from "./postgres-authority"

const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Thread protocol PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: StoreError["reason"], message: string) => StoreError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, StoreError>) =>
  sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", databaseError))
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))
const jsonEquivalent = Schema.toEquivalence(JsonObject)
const actorEquivalent = Schema.toEquivalence(ActorAttribution)
const timestampSql = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

interface CommandRow {
  readonly ownerId: string
  readonly threadId: string
  readonly commandId: string
  readonly idempotencyKey: string
  readonly expectedThreadVersion: string
  readonly threadVersion: string
  readonly actor: unknown
  readonly command: unknown
  readonly state: "admitted" | "completed"
  readonly result: unknown | null
  readonly cursor: string | null
  readonly admittedAt: string
  readonly completedAt: string | null
}

interface CommandClaimRow extends CommandRow {
  readonly claimToken: string | null
  readonly claimActive: boolean | null
}

const commandRow = Effect.fn("PostgresThreadProtocolStore.commandRow")(function* (row: CommandRow) {
  return {
    ownerId: OwnerId.make(row.ownerId),
    threadId: ThreadId.make(row.threadId),
    commandId: CommandId.make(row.commandId),
    idempotencyKey: IdempotencyKey.make(row.idempotencyKey),
    expectedThreadVersion: ThreadVersion.make(row.expectedThreadVersion),
    threadVersion: ThreadVersion.make(row.threadVersion),
    actor: yield* decode(ActorAttribution, row.actor),
    command: yield* decode(JsonObject, row.command),
    state: row.state,
    ...(row.result === null ? {} : { result: yield* decode(JsonObject, row.result) }),
    ...(row.cursor === null ? {} : { cursor: ThreadEventCursor.make(row.cursor) }),
    admittedAt: Timestamp.make(row.admittedAt),
    ...(row.completedAt === null ? {} : { completedAt: Timestamp.make(row.completedAt) }),
  } satisfies ThreadProtocolCommand
})

const make = Effect.gen(function* (): Effect.fn.Return<ThreadProtocolStoreService, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient

  const initializeThread: ThreadProtocolStoreService["initializeThread"] = Effect.fn(
    "PostgresThreadProtocolStore.initializeThread",
  )(function* (input) {
    yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "thread:view")
        const rows = yield* query(sql`INSERT INTO rika_hosted_thread_protocol_state (owner_id, thread_id)
          SELECT owner_id, id FROM rika_hosted_threads WHERE owner_id = ${input.ownerId} AND id = ${input.threadId}
          ON CONFLICT (thread_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
          WHERE rika_hosted_thread_protocol_state.owner_id = EXCLUDED.owner_id
          RETURNING thread_id`)
        if (rows[0] === undefined) return yield* failure("not-found", "Thread is unavailable")
      }),
    )
  })

  const admitCommand: ThreadProtocolStoreService["admitCommand"] = Effect.fn(
    "PostgresThreadProtocolStore.admitCommand",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "thread:control", input.admittedAt)
        const stateRows = yield* query(sql<{ readonly version: string }>`SELECT version::text AS version
          FROM rika_hosted_thread_protocol_state
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
          FOR UPDATE`)
        const state = stateRows[0]
        if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
        const existingRows = yield* query(sql<CommandRow>`SELECT owner_id AS "ownerId", thread_id AS "threadId",
            command_id AS "commandId", idempotency_key AS "idempotencyKey",
            expected_version::text AS "expectedThreadVersion", thread_version::text AS "threadVersion",
            actor, command, state, result, event_cursor::text AS cursor,
            ${sql.unsafe(timestampSql.replace("%s", "admitted_at"))} AS "admittedAt",
            CASE WHEN completed_at IS NULL THEN NULL ELSE ${sql.unsafe(timestampSql.replace("%s", "completed_at"))} END AS "completedAt"
          FROM rika_hosted_thread_protocol_commands
          WHERE thread_id = ${input.threadId}
            AND (command_id = ${input.commandId} OR idempotency_key = ${input.idempotencyKey})
          FOR UPDATE`)
        if (existingRows.length > 0) {
          if (existingRows.length !== 1)
            return yield* failure("conflict", "Command identities refer to different commands")
          const existing = yield* commandRow(existingRows[0]!)
          if (
            existing.commandId !== input.commandId ||
            existing.idempotencyKey !== input.idempotencyKey ||
            existing.expectedThreadVersion !== input.expectedThreadVersion ||
            !actorEquivalent(existing.actor, input.actor) ||
            !jsonEquivalent(existing.command, input.command)
          ) {
            return yield* failure("conflict", "Command identity was reused with incompatible input")
          }
          return { _tag: "Duplicate" as const, command: existing }
        }
        if (state.version !== input.expectedThreadVersion)
          return yield* failure(
            "stale-version",
            `Expected Thread version ${input.expectedThreadVersion}; current is ${state.version}`,
          )
        const nextVersion = (BigInt(state.version) + 1n).toString()
        const inserted = yield* query(sql<CommandRow>`INSERT INTO rika_hosted_thread_protocol_commands
          (owner_id, thread_id, command_id, idempotency_key, expected_version, thread_version,
            actor, command, state, admitted_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${input.commandId}, ${input.idempotencyKey},
            ${input.expectedThreadVersion}, ${nextVersion}, ${sql.json(input.actor)}, ${sql.json(input.command)},
            'admitted', ${input.admittedAt})
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", command_id AS "commandId",
            idempotency_key AS "idempotencyKey", expected_version::text AS "expectedThreadVersion",
            thread_version::text AS "threadVersion", actor, command, state, result,
            event_cursor::text AS cursor, ${sql.unsafe(timestampSql.replace("%s", "admitted_at"))} AS "admittedAt",
            NULL::text AS "completedAt"`)
        yield* query(sql`UPDATE rika_hosted_thread_protocol_state SET version = ${nextVersion}
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}`)
        return { _tag: "Admitted" as const, command: yield* commandRow(inserted[0]!) }
      }),
    )
  })

  const writeEvents = Effect.fn("PostgresThreadProtocolStore.writeEvents")(function* (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly threadVersion: ThreadVersion
    readonly firstCursor: bigint
    readonly events: Parameters<ThreadProtocolStoreService["appendEvents"]>[0]["events"]
    readonly createdAt: Timestamp
  }) {
    const written: Array<ThreadProtocolEvent> = []
    for (let index = 0; index < input.events.length; index += 1) {
      const sequence = (input.firstCursor + BigInt(index)).toString()
      const event = input.events[index]!
      yield* query(sql`INSERT INTO rika_hosted_thread_protocol_events
        (owner_id, thread_id, sequence, cursor, thread_version, event, created_at)
        VALUES (${input.ownerId}, ${input.threadId}, ${sequence}, ${sequence}, ${input.threadVersion},
          ${sql.json(event)}, ${input.createdAt})`)
      written.push({
        ownerId: input.ownerId,
        threadId: input.threadId,
        sequence,
        cursor: ThreadEventCursor.make(sequence),
        threadVersion: input.threadVersion,
        event,
        createdAt: input.createdAt,
      })
    }
    return written
  })

  const claimNextCommand: ThreadProtocolStoreService["claimNextCommand"] = Effect.fn(
    "PostgresThreadProtocolStore.claimNextCommand",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql<CommandRow>`WITH candidate AS (
            SELECT command_candidate.thread_id, command_candidate.command_id
            FROM rika_hosted_thread_protocol_state protocol_state
            JOIN LATERAL (
              SELECT command_record.thread_id, command_record.command_id, command_record.admitted_at,
                command_record.thread_version
              FROM rika_hosted_thread_protocol_commands command_record
              WHERE command_record.thread_id = protocol_state.thread_id
                AND command_record.state = 'admitted'
                AND (command_record.claim_token IS NULL OR command_record.claim_expires_at <= transaction_timestamp())
                AND NOT EXISTS (
                  SELECT 1
                  FROM rika_hosted_thread_protocol_commands predecessor
                  WHERE predecessor.thread_id = command_record.thread_id
                    AND predecessor.thread_version < command_record.thread_version
                    AND predecessor.state = 'admitted'
                    AND NOT (
                      command_record.command ->> '_tag' = 'Cancel'
                      AND command_record.command -> 'target' ->> '_tag' = 'Command'
                      AND predecessor.command_id = command_record.command -> 'target' ->> 'commandId'
                      AND predecessor.command ->> '_tag' = 'SubmitPrompt'
                    )
                )
              ORDER BY command_record.thread_version
              LIMIT 1
            ) command_candidate ON TRUE
            ORDER BY command_candidate.admitted_at, command_candidate.thread_id, command_candidate.thread_version
            FOR UPDATE OF protocol_state SKIP LOCKED
            LIMIT 1
          )
          UPDATE rika_hosted_thread_protocol_commands command_record
          SET claim_token = ${input.claimToken},
            claim_expires_at = transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'
          FROM candidate
          WHERE command_record.thread_id = candidate.thread_id
            AND command_record.command_id = candidate.command_id
          RETURNING command_record.owner_id AS "ownerId", command_record.thread_id AS "threadId",
            command_record.command_id AS "commandId", command_record.idempotency_key AS "idempotencyKey",
            command_record.expected_version::text AS "expectedThreadVersion",
            command_record.thread_version::text AS "threadVersion", command_record.actor, command_record.command,
            command_record.state, command_record.result, command_record.event_cursor::text AS cursor,
            ${sql.unsafe(timestampSql.replace("%s", "command_record.admitted_at"))} AS "admittedAt",
            NULL::text AS "completedAt"`)
        return rows[0] === undefined ? undefined : yield* commandRow(rows[0])
      }),
    )
  })

  const renewCommandClaim: ThreadProtocolStoreService["renewCommandClaim"] = Effect.fn(
    "PostgresThreadProtocolStore.renewCommandClaim",
  )(function* (input) {
    const rows = yield* query(sql`UPDATE rika_hosted_thread_protocol_commands
      SET claim_expires_at = transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'
      WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND command_id = ${input.commandId}
        AND state = 'admitted' AND claim_token = ${input.claimToken}
        AND claim_expires_at > transaction_timestamp()
      RETURNING command_id`)
    return rows[0] !== undefined
  })

  const releaseCommandClaim: ThreadProtocolStoreService["releaseCommandClaim"] = Effect.fn(
    "PostgresThreadProtocolStore.releaseCommandClaim",
  )(function* (input) {
    yield* query(sql`UPDATE rika_hosted_thread_protocol_commands SET claim_token = NULL, claim_expires_at = NULL
      WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND command_id = ${input.commandId}
        AND state = 'admitted' AND claim_token = ${input.claimToken}`).pipe(Effect.asVoid)
  })

  const completeCommand: ThreadProtocolStoreService["completeCommand"] = Effect.fn(
    "PostgresThreadProtocolStore.completeCommand",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const stateRows = yield* query(sql<{ readonly version: string; readonly cursor: string }>`
          SELECT version::text AS version, event_cursor::text AS cursor
          FROM rika_hosted_thread_protocol_state
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
          FOR UPDATE`)
        const state = stateRows[0]
        if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
        const rows = yield* query(sql<CommandClaimRow>`SELECT owner_id AS "ownerId", thread_id AS "threadId",
            command_id AS "commandId", idempotency_key AS "idempotencyKey",
            expected_version::text AS "expectedThreadVersion", thread_version::text AS "threadVersion",
            actor, command, state, result, event_cursor::text AS cursor,
            ${sql.unsafe(timestampSql.replace("%s", "admitted_at"))} AS "admittedAt",
            CASE WHEN completed_at IS NULL THEN NULL ELSE ${sql.unsafe(timestampSql.replace("%s", "completed_at"))} END AS "completedAt",
            claim_token AS "claimToken",
            claim_expires_at > transaction_timestamp() AS "claimActive"
          FROM rika_hosted_thread_protocol_commands
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND command_id = ${input.commandId}
          FOR UPDATE`)
        const current = rows[0]
        if (current === undefined) return yield* failure("not-found", "Command is unavailable")
        const currentCommand = yield* commandRow(current)
        if (current.state === "completed") return { _tag: "Duplicate" as const, command: currentCommand }
        if (current.claimToken !== input.claimToken || current.claimActive !== true)
          return yield* failure("stale-fence", "Command application claim is expired or fenced")
        const threadVersion = ThreadVersion.make(state.version)
        const events = yield* writeEvents({
          ownerId: input.ownerId,
          threadId: input.threadId,
          threadVersion,
          firstCursor: BigInt(state.cursor) + 1n,
          events: input.events,
          createdAt: input.completedAt,
        })
        const cursor = events.at(-1)?.cursor ?? ThreadEventCursor.make(state.cursor)
        if (input.events.length > 0)
          yield* query(sql`UPDATE rika_hosted_thread_protocol_state SET event_cursor = ${cursor}
            WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}`)
        if (input.events.length > 0) yield* query(sql`SELECT pg_notify('rika_thread_protocol', ${input.threadId})`)
        if (input.snapshot !== undefined)
          yield* query(sql`INSERT INTO rika_hosted_thread_protocol_snapshots
            (owner_id, thread_id, thread_version, cursor, snapshot, created_at)
            VALUES (${input.ownerId}, ${input.threadId}, ${threadVersion}, ${cursor}, ${sql.json(input.snapshot)},
              ${input.completedAt})
            ON CONFLICT (thread_id, thread_version) DO UPDATE
              SET cursor = EXCLUDED.cursor, snapshot = EXCLUDED.snapshot, created_at = EXCLUDED.created_at
              WHERE rika_hosted_thread_protocol_snapshots.cursor <= EXCLUDED.cursor`)
        const completed = yield* query(sql<CommandRow>`UPDATE rika_hosted_thread_protocol_commands
          SET state = 'completed', result = ${sql.json(input.result)}, event_cursor = ${cursor},
            completed_at = ${input.completedAt}, claim_token = NULL, claim_expires_at = NULL
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND command_id = ${input.commandId}
          RETURNING owner_id AS "ownerId", thread_id AS "threadId", command_id AS "commandId",
            idempotency_key AS "idempotencyKey", expected_version::text AS "expectedThreadVersion",
            thread_version::text AS "threadVersion", actor, command, state, result, event_cursor::text AS cursor,
            ${sql.unsafe(timestampSql.replace("%s", "admitted_at"))} AS "admittedAt",
            ${sql.unsafe(timestampSql.replace("%s", "completed_at"))} AS "completedAt"`)
        return { _tag: "Completed" as const, command: yield* commandRow(completed[0]!) }
      }),
    )
  })

  const appendEvents: ThreadProtocolStoreService["appendEvents"] = Effect.fn(
    "PostgresThreadProtocolStore.appendEvents",
  )(function* (input) {
    if (input.events.length === 0) return []
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql<{ readonly version: string; readonly cursor: string }>`
          SELECT version::text AS version, event_cursor::text AS cursor
          FROM rika_hosted_thread_protocol_state
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
          FOR UPDATE`)
        const state = rows[0]
        if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
        const events = yield* writeEvents({
          ...input,
          threadVersion: ThreadVersion.make(state.version),
          firstCursor: BigInt(state.cursor) + 1n,
        })
        yield* query(sql`UPDATE rika_hosted_thread_protocol_state SET event_cursor = ${events.at(-1)!.cursor}
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}`)
        yield* query(sql`SELECT pg_notify('rika_thread_protocol', ${input.threadId})`)
        yield* query(sql`INSERT INTO rika_hosted_thread_protocol_snapshots
          (owner_id, thread_id, thread_version, cursor, snapshot, created_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${state.version}, ${events.at(-1)!.cursor},
            ${sql.json(input.snapshot)}, ${input.createdAt})
          ON CONFLICT (thread_id, thread_version) DO UPDATE
            SET cursor = EXCLUDED.cursor, snapshot = EXCLUDED.snapshot, created_at = EXCLUDED.created_at
            WHERE rika_hosted_thread_protocol_snapshots.cursor <= EXCLUDED.cursor`)
        return events
      }),
    )
  })

  const saveSnapshot: ThreadProtocolStoreService["saveSnapshot"] = Effect.fn(
    "PostgresThreadProtocolStore.saveSnapshot",
  )(function* (input) {
    yield* transaction(
      sql,
      Effect.gen(function* () {
        const rows = yield* query(sql`SELECT 1
          FROM rika_hosted_thread_protocol_state
          WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
            AND version = ${input.threadVersion} AND event_cursor = ${input.cursor}
          FOR UPDATE`)
        if (rows[0] === undefined)
          return yield* failure("conflict", "Thread protocol state advanced before its snapshot was persisted")
        yield* query(sql`INSERT INTO rika_hosted_thread_protocol_snapshots
          (owner_id, thread_id, thread_version, cursor, snapshot, created_at)
          VALUES (${input.ownerId}, ${input.threadId}, ${input.threadVersion}, ${input.cursor},
            ${sql.json(input.snapshot)}, ${input.createdAt})
          ON CONFLICT (thread_id, thread_version) DO UPDATE
            SET cursor = EXCLUDED.cursor, snapshot = EXCLUDED.snapshot, created_at = EXCLUDED.created_at
            WHERE rika_hosted_thread_protocol_snapshots.cursor <= EXCLUDED.cursor`)
      }),
    )
  })

  const replay: ThreadProtocolStoreService["replay"] = Effect.fn("PostgresThreadProtocolStore.replay")(
    function* (input) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          yield* requireThreadAccess(sql, input, "thread:view")
          const stateRows = yield* query(sql<{ readonly version: string; readonly cursor: string }>`
        SELECT version::text AS version, event_cursor::text AS cursor
        FROM rika_hosted_thread_protocol_state
        WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}`)
          const state = stateRows[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          const stateCursor = BigInt(state.cursor)
          const throughCursor = input.throughCursor === undefined ? stateCursor : BigInt(input.throughCursor)
          const targetCursor = ThreadEventCursor.make(
            (throughCursor < stateCursor ? throughCursor : stateCursor).toString(),
          )
          const snapshotRows = yield* query(sql<{
            readonly threadVersion: string
            readonly cursor: string
            readonly snapshot: unknown
            readonly createdAt: string
          }>`SELECT thread_version::text AS "threadVersion", cursor::text AS cursor, snapshot,
          ${sql.unsafe(timestampSql.replace("%s", "created_at"))} AS "createdAt"
        FROM rika_hosted_thread_protocol_snapshots
        WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
          AND ${input.includeSnapshot === false ? sql`FALSE` : sql`TRUE`}
          AND cursor <= ${targetCursor}
          AND thread_version <= ${state.version}
        ORDER BY rika_hosted_thread_protocol_snapshots.thread_version DESC,
          rika_hosted_thread_protocol_snapshots.cursor DESC LIMIT 1`)
          const snapshotRow = snapshotRows[0]
          const replayCursor = snapshotRow?.cursor ?? input.afterCursor
          const eventRows = yield* query(sql<{
            readonly sequence: string
            readonly cursor: string
            readonly threadVersion: string
            readonly event: unknown
            readonly createdAt: string
          }>`SELECT sequence::text AS sequence, cursor::text AS cursor,
          thread_version::text AS "threadVersion", event,
          ${sql.unsafe(timestampSql.replace("%s", "created_at"))} AS "createdAt"
        FROM rika_hosted_thread_protocol_events
        WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId}
          AND cursor > ${replayCursor} AND cursor <= ${targetCursor}
        ORDER BY rika_hosted_thread_protocol_events.sequence
        LIMIT ${Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)}`)
          const events: Array<ThreadProtocolEvent> = []
          for (const row of eventRows)
            events.push({
              ownerId: input.ownerId,
              threadId: input.threadId,
              sequence: row.sequence,
              cursor: ThreadEventCursor.make(row.cursor),
              threadVersion: ThreadVersion.make(row.threadVersion),
              event: yield* decode(InteractiveEventSchema, row.event),
              createdAt: Timestamp.make(row.createdAt),
            })
          return {
            threadVersion: ThreadVersion.make(state.version),
            cursor: ThreadEventCursor.make(state.cursor),
            ...(snapshotRow === undefined
              ? {}
              : {
                  snapshot: {
                    ownerId: input.ownerId,
                    threadId: input.threadId,
                    threadVersion: ThreadVersion.make(snapshotRow.threadVersion),
                    cursor: ThreadEventCursor.make(snapshotRow.cursor),
                    snapshot: yield* decode(HostedThreadSnapshot, snapshotRow.snapshot),
                    createdAt: Timestamp.make(snapshotRow.createdAt),
                  },
                }),
            events,
          }
        }),
      )
    },
  )

  const acknowledgeCursor: ThreadProtocolStoreService["acknowledgeCursor"] = Effect.fn(
    "PostgresThreadProtocolStore.acknowledgeCursor",
  )(function* (input) {
    return yield* transaction(
      sql,
      Effect.gen(function* () {
        yield* requireThreadAccess(sql, input, "thread:view", input.acknowledgedAt)
        const rows = yield* query(sql<{ readonly cursor: string }>`INSERT INTO rika_hosted_thread_protocol_cursors
          (owner_id, thread_id, client_id, cursor, acknowledged_at)
          SELECT state.owner_id, state.thread_id, ${input.actor.clientId}, ${input.cursor}, ${input.acknowledgedAt}
          FROM rika_hosted_thread_protocol_state state
          WHERE state.owner_id = ${input.ownerId} AND state.thread_id = ${input.threadId}
            AND state.event_cursor >= ${input.cursor}
          ON CONFLICT (thread_id, client_id) DO UPDATE
            SET cursor = GREATEST(rika_hosted_thread_protocol_cursors.cursor, EXCLUDED.cursor),
              acknowledged_at = EXCLUDED.acknowledged_at
          RETURNING cursor::text AS cursor`)
        if (rows[0] === undefined) return yield* failure("conflict", "Cursor is ahead of the committed Thread log")
        const compactRows = yield* query(sql<{ readonly cursor: string }>`SELECT max(snapshot.cursor)::text AS cursor
          FROM rika_hosted_thread_protocol_snapshots snapshot
          WHERE snapshot.owner_id = ${input.ownerId} AND snapshot.thread_id = ${input.threadId}
            AND snapshot.cursor <= (SELECT min(cursor) FROM rika_hosted_thread_protocol_cursors
              WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId})`)
        const compactCursor = compactRows[0]?.cursor
        if (compactCursor !== null && compactCursor !== undefined) {
          yield* query(sql`DELETE FROM rika_hosted_thread_protocol_events
            WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND cursor <= ${compactCursor}`)
          yield* query(sql`DELETE FROM rika_hosted_thread_protocol_snapshots
            WHERE owner_id = ${input.ownerId} AND thread_id = ${input.threadId} AND cursor < ${compactCursor}`)
        }
        return ThreadEventCursor.make(rows[0].cursor)
      }),
    )
  })

  const issueTicket: ThreadProtocolStoreService["issueTicket"] = Effect.fn("PostgresThreadProtocolStore.issueTicket")(
    function* (input) {
      yield* query(sql`INSERT INTO rika_hosted_thread_socket_tickets
      (id, ticket_digest, user_id, client_id, device_id, audience, expires_at, issued_at)
      VALUES (${input.ticketId}, ${input.ticketDigest}, ${input.userId}, ${input.clientId}, ${input.deviceId},
        ${input.audience}, ${input.expiresAt}, ${input.issuedAt})`)
    },
  )

  const redeemTicket: ThreadProtocolStoreService["redeemTicket"] = Effect.fn(
    "PostgresThreadProtocolStore.redeemTicket",
  )(function* (input) {
    const rows = yield* transaction(
      sql,
      query(sql<{
        readonly ticketId: string
        readonly userId: string
        readonly clientId: string
        readonly deviceId: string
        readonly audience: string
        readonly expiresAt: string
      }>`UPDATE rika_hosted_thread_socket_tickets ticket
        SET consumed_at = ${input.redeemedAt}
        FROM rika_hosted_clients client_record, rika_hosted_devices device
        WHERE ticket.ticket_digest = ${input.ticketDigest} AND ticket.audience = ${input.audience}
          AND ticket.consumed_at IS NULL AND ticket.revoked_at IS NULL AND ticket.expires_at > ${input.redeemedAt}
          AND client_record.id = ticket.client_id AND client_record.user_id = ticket.user_id
          AND client_record.device_id = ticket.device_id AND client_record.revoked_at IS NULL
          AND client_record.expires_at > ${input.redeemedAt}
          AND device.id = ticket.device_id AND device.user_id = ticket.user_id AND device.revoked_at IS NULL
        RETURNING ticket.id AS "ticketId", ticket.user_id AS "userId", ticket.client_id AS "clientId",
          ticket.device_id AS "deviceId", ticket.audience,
          ${sql.unsafe(timestampSql.replace("%s", "ticket.expires_at"))} AS "expiresAt"`),
    )
    const row = rows[0]
    if (row === undefined) return yield* failure("invalid-authority", "WebSocket ticket is invalid or expired")
    return {
      ticketId: row.ticketId,
      userId: BetterAuthUserId.make(row.userId),
      clientId: ClientId.make(row.clientId),
      deviceId: DeviceId.make(row.deviceId),
      audience: row.audience,
      expiresAt: Timestamp.make(row.expiresAt),
    }
  })

  const revokeTicket: ThreadProtocolStoreService["revokeTicket"] = Effect.fn(
    "PostgresThreadProtocolStore.revokeTicket",
  )(function* (ticketId) {
    yield* query(sql`UPDATE rika_hosted_thread_socket_tickets
      SET revoked_at = transaction_timestamp()
      WHERE id = ${ticketId} AND consumed_at IS NULL AND revoked_at IS NULL`)
  })

  return ThreadProtocolStore.of({
    initializeThread,
    admitCommand,
    claimNextCommand,
    renewCommandClaim,
    releaseCommandClaim,
    completeCommand,
    appendEvents,
    saveSnapshot,
    replay,
    acknowledgeCursor,
    issueTicket,
    redeemTicket,
    revokeTicket,
  })
})

export const layer = Layer.effect(ThreadProtocolStore, make)
