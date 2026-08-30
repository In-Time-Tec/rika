import * as ExecutionGateway from "@rika/product/execution-gateway"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import {
  ActorAttribution,
  CommitCursor,
  CommandId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { PendingAuthorization } from "@rika/product/client-protocol"
import type { ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { TurnId } from "@rika/product/turn-record"
import { sql, type SQLWrapper } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { rikaHostedThreadProtocolCommands } from "../../database/schema/product"

export const every = (...conditions: ReadonlyArray<boolean>) => conditions.every(Boolean)

export const databaseError = (cause: unknown) =>
  HostedPersistenceError.make({
    reason: "database",
    message: `Thread protocol PostgreSQL operation failed: ${String(cause)}`,
  })

export const persistenceErrors = {
  failure: (reason: HostedPersistenceError["reason"], message: string) =>
    HostedPersistenceError.make({ reason, message }),
}

export const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))

export const decode =
  <S extends Schema.Top>(schema: S) =>
  <Value>(value: Value) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))

export const protocolEquivalence = {
  json: Schema.toEquivalence(JsonObject),
  actor: Schema.toEquivalence(ActorAttribution),
  pendingAuthorizations: Schema.toEquivalence(Schema.Array(PendingAuthorization)),
}
export const SubmitPromptIdentity = Schema.TaggedStruct("SubmitPrompt", {})
export const CommandCancellationIdentity = Schema.TaggedStruct("Cancel", {
  target: Schema.TaggedStruct("Command", { commandId: Schema.String }),
})
export const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
export const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
export const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)
export const PreparedTurnJson = Schema.fromJsonString(ExecutionGateway.PreparedTurn)

export const bigintText = (column: SQLWrapper) => sql<string>`${column}::text`
export const bigintValue = (value: string) => sql<number>`${value}::bigint`
export const timestampValue = (value: string) => sql<Date>`${value}::timestamptz`
export const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export const commandFields = {
  ownerId: rikaHostedThreadProtocolCommands.ownerId,
  threadId: rikaHostedThreadProtocolCommands.threadId,
  commandId: rikaHostedThreadProtocolCommands.commandId,
  turnId: rikaHostedThreadProtocolCommands.turnId,
  idempotencyKey: rikaHostedThreadProtocolCommands.idempotencyKey,
  expectedThreadVersion: bigintText(rikaHostedThreadProtocolCommands.expectedVersion),
  threadVersion: bigintText(rikaHostedThreadProtocolCommands.threadVersion),
  commitCursor: bigintText(rikaHostedThreadProtocolCommands.commitCursor),
  actor: rikaHostedThreadProtocolCommands.actor,
  command: rikaHostedThreadProtocolCommands.command,
  state: rikaHostedThreadProtocolCommands.state,
  workState: rikaHostedThreadProtocolCommands.workState,
  admissionStatus: rikaHostedThreadProtocolCommands.admissionStatus,
  cancelledByCommandId: rikaHostedThreadProtocolCommands.cancelledByCommandId,
  result: rikaHostedThreadProtocolCommands.result,
  cursor: bigintText(rikaHostedThreadProtocolCommands.eventCursor),
  admittedAt: timestampText(rikaHostedThreadProtocolCommands.admittedAt),
  completedAt: timestampText(rikaHostedThreadProtocolCommands.completedAt),
}

export interface CommandRow {
  readonly ownerId: string
  readonly threadId: string
  readonly commandId: string
  readonly turnId: string | null
  readonly idempotencyKey: string
  readonly expectedThreadVersion: string
  readonly threadVersion: string
  readonly commitCursor: string
  readonly actor: unknown
  readonly command: unknown
  readonly state: string
  readonly workState: string | null
  readonly admissionStatus: string | null
  readonly cancelledByCommandId: string | null
  readonly result: unknown
  readonly cursor: string | null
  readonly admittedAt: string
  readonly completedAt: string | null
}

export const commandRow = Effect.fn("ThreadProtocolStore.commandRow")(function* (row: CommandRow) {
  const command: ThreadProtocolCommand = {
    ownerId: OwnerId.make(row.ownerId),
    threadId: ThreadId.make(row.threadId),
    commandId: CommandId.make(row.commandId),
    idempotencyKey: IdempotencyKey.make(row.idempotencyKey),
    expectedThreadVersion: ThreadVersion.make(row.expectedThreadVersion),
    threadVersion: ThreadVersion.make(row.threadVersion),
    sequence: Sequence.make(row.threadVersion),
    commitCursor: CommitCursor.make(row.commitCursor),
    actor: yield* decode(ActorAttribution)(row.actor),
    command: yield* decode(JsonObject)(row.command),
    state: yield* decode(Schema.Literals(["admitted", "completed"]))(row.state),
    admittedAt: Timestamp.make(row.admittedAt),
  }
  if (row.turnId !== null) Object.assign(command, { turnId: TurnId.make(row.turnId) })
  if (row.workState !== null)
    Object.assign(command, {
      workState: yield* decode(Schema.Literals(["turn-activation-pending", "turn-activation-requested"]))(
        row.workState,
      ),
    })
  if (row.admissionStatus !== null)
    Object.assign(command, {
      admissionStatus: yield* decode(Schema.Literals(["accepted", "queued"]))(row.admissionStatus),
    })
  if (row.cancelledByCommandId !== null)
    Object.assign(command, { cancelledByCommandId: CommandId.make(row.cancelledByCommandId) })
  if (row.result !== null) Object.assign(command, { result: yield* decode(JsonObject)(row.result) })
  if (row.cursor !== null) Object.assign(command, { cursor: ThreadEventCursor.make(row.cursor) })
  if (row.completedAt !== null) Object.assign(command, { completedAt: Timestamp.make(row.completedAt) })
  return command
})
