import { identityMigrations, runMigration } from "@rika/identity"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"
import { TerminalUnknownInput } from "@rika/execution/terminal-unknown"
import { rikaHostedExecutorOperations } from "@rika/product-store/database-schema"
import { FileSystem, Config, Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Pool } from "pg"
import { Address, ExecutableManifest, Message } from "generalist/runtime"
import { runOperations as generalistRunOperations } from "../../../src/hosted/execution/generalist-schema"

const databaseUrl = Effect.runSync(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")))
const principal = { userId: "recovery-user", deviceId: "recovery-device", clientId: "recovery-client" }
const executable: ReturnType<typeof ExecutableManifest.makeTest> = ExecutableManifest.makeTest("recovery", "test")
const executableRef = Schema.encodeSync(Schema.fromJsonString(ExecutableManifest.ExecutableRef))(executable.ref)
const executableManifest = Schema.encodeSync(Schema.fromJsonString(ExecutableManifest.ExecutableManifest))(
  executable.manifest,
)
const storedMessage = (suffix: string) =>
  Schema.encodeSync(Schema.fromJsonString(Message.Message))(
    Message.make({
      id: `message-${suffix}`,
      to: Address.make("agent:recovery"),
      sessionId: `session-${suffix}`,
      prompt: Prompt.make("recover"),
      idempotencyKey: `run-${suffix}`,
      correlationId: `run-${suffix}`,
    }),
  )

const migrate = (url: string, pool: Pool) =>
  Effect.gen(function* () {
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(migration.url.pathname),
      )
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "hosted-recovery-live" })
  })

const terminalUnknownInput = (input: {
  readonly ordinal: number
  readonly sourceOperationKey: string
  readonly toolCallId: string
}) =>
  Schema.encodeSync(Schema.fromJsonString(TerminalUnknownInput))({
    kind: "rika-native-tool-terminal-unknown",
    ordinal: input.ordinal,
    payload: {
      sourceOperationKey: input.sourceOperationKey,
      toolCallId: input.toolCallId,
      toolName: "bash",
    },
  })

const generalistOperationRows = (now: Date): Array<typeof generalistRunOperations.$inferInsert> => [
  {
    runId: "run-retry",
    operationId: "generalist-retry",
    operationKey: "operation-retry",
    kind: "tool",
    status: "unknown",
    inputDigest: "retry-digest",
    inputJson: "{}",
    replayPolicy: "pure",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-accept",
    operationId: "generalist-accept-outer",
    operationKey: "operation-accept",
    kind: "tool",
    status: "failed",
    inputDigest: "accept-outer-digest",
    inputJson: "{}",
    errorJson: '{"message":"outer tool failed after terminal unknown"}',
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-accept",
    operationId: "generalist-accept",
    operationKey: "operation-accept#7",
    kind: "nested",
    status: "unknown",
    inputDigest: "accept-marker-digest",
    inputJson: terminalUnknownInput({
      ordinal: 7,
      sourceOperationKey: "operation-accept",
      toolCallId: "call-accept",
    }),
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-abort",
    operationId: "generalist-abort-outer",
    operationKey: "operation-abort",
    kind: "tool",
    status: "failed",
    inputDigest: "abort-outer-digest",
    inputJson: "{}",
    errorJson: '{"message":"outer tool failed after terminal unknown"}',
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-abort",
    operationId: "generalist-abort",
    operationKey: "operation-abort#11",
    kind: "nested",
    status: "unknown",
    inputDigest: "abort-marker-digest",
    inputJson: terminalUnknownInput({
      ordinal: 11,
      sourceOperationKey: "operation-abort",
      toolCallId: "call-abort",
    }),
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-auto",
    operationId: "generalist-auto-outer",
    operationKey: "operation-auto",
    kind: "tool",
    status: "failed",
    inputDigest: "auto-outer-digest",
    inputJson: "{}",
    errorJson: '{"message":"outer tool failed after terminal unknown"}',
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-auto",
    operationId: "generalist-auto",
    operationKey: "operation-auto#13",
    kind: "nested",
    status: "unknown",
    inputDigest: "auto-marker-digest",
    inputJson: terminalUnknownInput({
      ordinal: 13,
      sourceOperationKey: "operation-auto",
      toolCallId: "call-auto",
    }),
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
  {
    runId: "run-false",
    operationId: "generalist-false-outer",
    operationKey: "operation-false",
    kind: "tool",
    status: "failed",
    inputDigest: "false-outer-digest",
    inputJson: "{}",
    errorJson: '{"message":"outer tool failed without a marker"}',
    replayPolicy: "never",
    attempt: 0,
    startedAt: now,
    finishedAt: now,
  },
]

const executorOperationRows = (
  now: Date,
  deadlineAt: Date,
): Array<typeof rikaHostedExecutorOperations.$inferInsert> => [
  {
    assignmentId: "recovery-assignment",
    ownerId: "recovery-owner",
    operationKey: "operation-retry",
    requestDigest: "retry-digest",
    code: "retry()",
    attempt: 0,
    state: "dispatched",
    dispatchedGeneration: 1,
    dispatchedLeaseEpoch: 1,
    dispatchedExecutorInstanceId: "executor-recovery",
    dispatchedProcessIncarnation: "process-recovery",
    workspaceId: "recovery-workspace",
    sessionId: "session-recovery",
    threadId: "recovery-thread",
    turnId: "turn-retry",
    runId: "run-retry",
    rootRunId: "run-retry",
    toolCallId: "call-retry",
    replayPolicy: "pure",
    startedAt: now,
    deadlineAt,
  },
  {
    assignmentId: "recovery-assignment",
    ownerId: "recovery-owner",
    operationKey: "operation-accept",
    requestDigest: "accept-digest",
    code: "accept()",
    attempt: 0,
    state: "unknown",
    dispatchedGeneration: 1,
    dispatchedLeaseEpoch: 1,
    dispatchedExecutorInstanceId: "executor-recovery",
    dispatchedProcessIncarnation: "process-recovery",
    response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "unknown" } },
    workspaceId: "recovery-workspace",
    sessionId: "session-recovery",
    threadId: "recovery-thread",
    turnId: "turn-accept",
    runId: "run-accept",
    rootRunId: "run-accept",
    toolCallId: "call-accept",
    replayPolicy: "never",
    startedAt: now,
    deadlineAt,
    terminalOutcome: "unknown",
  },
  {
    assignmentId: "recovery-assignment",
    ownerId: "recovery-owner",
    operationKey: "operation-abort",
    requestDigest: "abort-digest",
    code: "abort()",
    attempt: 0,
    state: "unknown",
    dispatchedGeneration: 1,
    dispatchedLeaseEpoch: 1,
    dispatchedExecutorInstanceId: "executor-recovery",
    dispatchedProcessIncarnation: "process-recovery",
    response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "unknown" } },
    workspaceId: "recovery-workspace",
    sessionId: "session-recovery",
    threadId: "recovery-thread",
    turnId: "turn-abort",
    runId: "run-abort",
    rootRunId: "run-abort",
    toolCallId: "call-abort",
    replayPolicy: "never",
    startedAt: now,
    deadlineAt,
    terminalOutcome: "unknown",
  },
  {
    assignmentId: "recovery-assignment",
    ownerId: "recovery-owner",
    operationKey: "operation-auto",
    requestDigest: "auto-digest",
    code: "6 * 7",
    attempt: 0,
    state: "completed",
    dispatchedGeneration: 1,
    dispatchedLeaseEpoch: 1,
    dispatchedExecutorInstanceId: "executor-recovery",
    dispatchedProcessIncarnation: "process-recovery",
    response: {
      _tag: "Success",
      result: { text: "42", truncated: false },
    },
    workspaceId: "recovery-workspace",
    sessionId: "session-auto",
    threadId: "recovery-thread",
    turnId: "turn-auto",
    runId: "run-auto",
    rootRunId: "run-auto",
    toolCallId: "call-auto",
    replayPolicy: "never",
    startedAt: now,
    deadlineAt,
    terminalOutcome: "completed",
  },
  {
    assignmentId: "recovery-assignment",
    ownerId: "recovery-owner",
    operationKey: "operation-false",
    requestDigest: "false-digest",
    code: "falseUnknown()",
    attempt: 0,
    state: "unknown",
    dispatchedGeneration: 1,
    dispatchedLeaseEpoch: 1,
    dispatchedExecutorInstanceId: "executor-recovery",
    dispatchedProcessIncarnation: "process-recovery",
    response: { _tag: "DomainFailure", failure: { kind: "unknown", message: "unknown" } },
    workspaceId: "recovery-workspace",
    sessionId: "session-false",
    threadId: "recovery-thread",
    turnId: "turn-false",
    runId: "run-false",
    rootRunId: "run-false",
    toolCallId: "call-false",
    replayPolicy: "never",
    startedAt: now,
    deadlineAt,
    terminalOutcome: "unknown",
  },
]

export const recoveryFixture = {
  databaseUrl,
  principal,
  executableRef,
  executableManifest,
  storedMessage,
  migrate,
  generalistOperationRows,
  executorOperationRows,
}
