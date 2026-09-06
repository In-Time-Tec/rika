import { expect, it } from "@effect/vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { HostedThreadSnapshot } from "@rika/product/client-protocol"
import { ThreadEventCursor, Timestamp } from "@rika/product/hosted-model"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import { eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import * as schema from "../../../src/database/schema/product"
import { operationsStore } from "../../../src/hosted/execution/process-observation"
import { eventOperations } from "../../../src/hosted/thread-protocol/events"
import { transcriptSqlWrites } from "../../../src/transcript/sql-writes"
import { migrations } from "../../../src/hosted/migrations"
import { identityMigrations } from "../../../../identity/src/database/migrations"
import { apply, capabilities, ids, isolated, live, seedIdentity, seedRecoveryAggregate } from "../assignments.support"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const encodeUnit = Schema.encodeSync(UnitJson)
const decodeUnit = Schema.decodeSync(UnitJson)
const productThreadId = Thread.ThreadId.make(String(ids.thread))
const productTurnId = Turn.TurnId.make("turn-process")
const executionRoute = ExecutionRouteSnapshot.testExecutionRoute()
const executionRouteJson = Schema.encodeSync(Schema.fromJsonString(ExecutionRouteSnapshot.ExecutionRouteSnapshot))(
  executionRoute,
)
const projectionState = {
  status: "running" as const,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
}
const projectionStateJson = Schema.encodeSync(Schema.fromJsonString(ExecutionProjection.ProjectionState))(
  projectionState,
)

const runningUnit: TranscriptUnit.Unit = {
  key: "tool:process",
  turnId: "turn-process",
  order: UnitOrder.unitOrder("tool:process", 0),
  revision: 0,
  content: {
    _tag: "Block",
    block: {
      _tag: "ToolCall",
      id: "tool:process",
      name: "bash",
      input: "sleep 1",
      status: "running",
      presentation: {
        family: "shell",
        action: "run",
        activeLabel: "Running",
        completeLabel: "Ran",
      },
      detail: "sleep 1",
      operationId: "operation-process",
      toolCallId: "call-process",
      process: { processId: "process-1", running: true, elapsedMillis: 1, truncated: false },
      files: [],
    },
  },
}

for (const early of [false, true])
  it.effect.skipIf(!live)(
    `persists process observations under current authority (before original receipt: ${early})`,
    () =>
      isolated(({ pool, database, effectDatabase }) =>
        Effect.gen(function* () {
          yield* apply(pool, [...identityMigrations, ...migrations])
          yield* seedIdentity(database)
          yield* seedRecoveryAggregate(effectDatabase)
          yield* effectDatabase.insert(schema.rikaTurns).values({
            id: "turn-process",
            threadId: ids.thread,
            prompt: "run",
            status: "running",
            createdAt: 2,
            updatedAt: 2,
            executionRouteJson,
          })
          yield* effectDatabase.insert(schema.rikaTranscriptCheckpoints).values({
            turnId: "turn-process",
            threadId: ids.thread,
            revision: 0,
            projectionVersion: ExecutionProjection.projectionVersion,
            stateJson: projectionStateJson,
            updatedAt: 2,
          })
          yield* effectDatabase.insert(schema.rikaTranscriptUnits).values({
            turnId: "turn-process",
            unitKey: runningUnit.key,
            threadId: ids.thread,
            unitOrderKey: UnitOrder.encodeUnitOrder(runningUnit.order),
            revision: 0,
            unitJson: encodeUnit(runningUnit),
            createdAt: 2,
            updatedAt: 2,
          })
          yield* effectDatabase.insert(schema.rikaHostedExecutorAssignments).values({
            id: ids.assignment,
            ownerId: ids.owner,
            threadId: ids.thread,
            workspaceId: ids.workspace,
            executorKind: "runner",
            placement: { _tag: "RunnerPlacement", deviceId: ids.device },
            generation: 1,
            lastLeaseEpoch: 2,
            lifecycle: "active",
            providerInstanceId: ids.device,
            executorInstanceId: ids.executor,
            processIncarnation: "incarnation-1",
            sessionDigest: "session",
            leaseEpoch: 2,
            leaseExpiresAt: sql`transaction_timestamp() + interval '5 minutes'`,
            capabilityGeneration: 1,
            capabilitySnapshot: capabilities,
          })
          const originalResponse = {
            _tag: "Success" as const,
            result: { text: "still running", truncated: false, running: true, processId: "process-1" },
          }
          yield* effectDatabase.insert(schema.rikaHostedExecutorOperations).values({
            assignmentId: ids.assignment,
            ownerId: ids.owner,
            operationKey: "operation-process",
            requestDigest: "request-digest",
            workspaceId: ids.workspace,
            sessionId: "session-process",
            threadId: ids.thread,
            turnId: "turn-process",
            runId: "run-process",
            rootRunId: "run-process",
            toolCallId: "call-process",
            code: "sleep 1",
            attempt: 0,
            deadlineAt: sql`transaction_timestamp() + interval '5 minutes'`,
            state: early ? "dispatched" : "completed",
            dispatchedGeneration: 1,
            dispatchedLeaseEpoch: 1,
            dispatchedExecutorInstanceId: ids.executor,
            dispatchedProcessIncarnation: "incarnation-1",
            response: early ? null : originalResponse,
            terminalOutcome: early ? null : "completed",
          })

          const observation = { processId: "process-1", exitCode: 0, elapsedMillis: 1000, truncated: false }
          const input = {
            assignmentId: ids.assignment,
            operationKey: "operation-process",
            attempt: 0,
            machineId: String(ids.device),
            requestDigest: "request-digest",
            assignmentGeneration: 1,
            leaseEpoch: 2,
            executorInstanceId: String(ids.executor),
            processIncarnation: "incarnation-1",
            observation,
          }
          const store = operationsStore(effectDatabase)
          expect(yield* store.recordProcessObservation(input)).toBe("recorded")
          expect(yield* store.recordProcessObservation({ ...input, observation: { ...observation } })).toBe("duplicate")

          const operation = (yield* effectDatabase
            .select({ response: schema.rikaHostedExecutorOperations.response })
            .from(schema.rikaHostedExecutorOperations))[0]
          expect(operation?.response).toEqual(early ? null : originalResponse)
          if (early) {
            yield* effectDatabase
              .update(schema.rikaHostedExecutorOperations)
              .set({ state: "completed", response: originalResponse, terminalOutcome: "completed" })
            expect(yield* store.recordProcessObservation(input)).toBe("duplicate")
          }
          const projected = decodeUnit(
            (yield* effectDatabase
              .select({ unitJson: schema.rikaTranscriptUnits.unitJson })
              .from(schema.rikaTranscriptUnits))[0]!.unitJson,
          )
          expect(projected).toMatchObject({
            content: { block: { status: "complete", process: { running: false, exitCode: 0, elapsedMillis: 1000 } } },
          })

          yield* effectDatabase
            .update(schema.rikaHostedExecutorAssignments)
            .set({ processIncarnation: "incarnation-2" })
            .where(eq(schema.rikaHostedExecutorAssignments.id, ids.assignment))
          expect(yield* store.recordProcessObservation(input)).toBe("fenced")
          yield* effectDatabase
            .update(schema.rikaHostedExecutorAssignments)
            .set({ processIncarnation: "incarnation-1" })
            .where(eq(schema.rikaHostedExecutorAssignments.id, ids.assignment))

          const writes = transcriptSqlWrites.make(effectDatabase, () => Effect.die("commitProjection does not read"))
          expect(
            yield* writes.commitProjection(
              {
                _tag: "AgentExecution",
                id: productTurnId,
                threadId: productThreadId,
                prompt: "run",
                status: "running",
                createdAt: 2,
                updatedAt: 2,
                author: { _tag: "Human" },
                lineage: { _tag: "Original" },
                executionRoute,
              },
              {
                _tag: "ProjectionPatch",
                baseRevision: 0,
                revision: 1,
                checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "replay", state: "{}" },
                upsert: [{ ...runningUnit, revision: 1 }],
                remove: [],
                state: projectionState,
              },
            ),
          ).toBe("committed")
          const replayed = decodeUnit(
            (yield* effectDatabase
              .select({ unitJson: schema.rikaTranscriptUnits.unitJson })
              .from(schema.rikaTranscriptUnits))[0]!.unitJson,
          )
          expect(replayed).toMatchObject({ content: { block: { status: "complete", process: { running: false } } } })

          const staleSnapshot = HostedThreadSnapshot.make({
            executorKind: "runner",
            pendingAuthorizations: [],
            view: {
              thread: {
                id: productThreadId,
                workspace: String(ids.workspace),
                title: "Recovery",
                labels: [],
                pinned: false,
                archived: false,
                lineage: { _tag: "Original" },
                createdAt: 1,
                updatedAt: 1,
              },
              source: { projectionVersion: ExecutionProjection.projectionVersion },
              revision: 0,
              pending: [],
              hasOlder: false,
              hasNewer: false,
              usage: { state: projectionState.usage },
              turns: [
                {
                  turn: {
                    kind: "agent",
                    id: productTurnId,
                    threadId: productThreadId,
                    prompt: "run",
                    status: "running",
                    author: { _tag: "Human" },
                    lineage: { _tag: "Original" },
                    createdAt: 2,
                    updatedAt: 2,
                  },
                  projectionRevision: 1,
                  usage: projectionState.usage,
                  units: [runningUnit],
                },
              ],
            },
          })
          yield* effectDatabase
            .insert(schema.rikaHostedThreadProtocolState)
            .values({ ownerId: ids.owner, threadId: ids.thread })
          const protocol = eventOperations(effectDatabase)
          const events = yield* protocol.appendEvents({
            ownerId: ids.owner,
            threadId: ids.thread,
            createdAt: Timestamp.make("2026-09-06T00:00:00.000Z"),
            snapshot: staleSnapshot,
            events: [
              { _tag: "ThreadViewSnapshot", snapshot: staleSnapshot.view },
              {
                _tag: "ThreadViewPatch",
                patch: {
                  threadId: productThreadId,
                  baseRevision: 0,
                  revision: 1,
                  upsert: [runningUnit],
                  remove: [],
                  turnChanges: [],
                },
              },
            ],
          })
          expect(events[0]?.event).toMatchObject({ snapshot: { turns: [{ units: [projected] }] } })
          expect(events[1]?.event).toMatchObject({ patch: { upsert: [projected] } })
          const replay = yield* protocol.replay({
            ownerId: ids.owner,
            threadId: ids.thread,
            actor: { _tag: "BrowserRead", userId: String(ids.user) },
            afterCursor: ThreadEventCursor.make("0"),
            limit: 100,
          })
          expect(replay.snapshot?.snapshot.view.turns[0]?.units).toEqual([projected])
          expect(staleSnapshot.view.turns[0]?.units).toEqual([runningUnit])
        }),
      ),
  )
