import * as Identifier from "./relay-execution-identifier"
import * as Mapping from "./relay-event-mapping"
import * as Recovery from "./relay-execution-recovery"
import * as Tree from "./relay-execution-tree"
import { Client, Ids, type Execution } from "@relayfx/sdk"
import { Cause, Clock, Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { ExecutionCheckpoint, Event } from "@rika/product/execution-event"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import type { EventScope } from "@rika/product/execution-request"
import { BackendError } from "@rika/product/execution-service"
import { Status } from "@rika/product/execution-status"
import * as ExecutionStatus from "@rika/product/execution-status"
export const followExecution = (input: {
  readonly client: Client.Interface
  readonly turnId: string
  readonly afterCursor: string | ExecutionCheckpoint | undefined
  readonly onEvent: ((item: Event) => void) | undefined
  readonly stopAtActionableWait: boolean
  readonly reference: ExecutionReference | undefined
  readonly eventScope: EventScope | undefined
  readonly attemptCost: { readonly amount: number; readonly currency: string } | undefined
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const stopAtActionableWait = input.stopAtActionableWait
      const reference = input.reference
      const eventScope = input.eventScope ?? "tree"
      const client = input.client
      const turnId = input.turnId
      const afterCursor = input.afterCursor
      const onEvent = input.onEvent
      const attemptCost = input.attemptCost
      const followAnnotations = {
        "rika.follow.cursor": Identifier.cursorOf(afterCursor) ?? "start",
        "rika.follow.scope": eventScope,
      }
      yield* Effect.logInfo("execution.follow.started").pipe(Effect.annotateLogs(followAnnotations))
      const rootExecutionId = Identifier.executionId({ turnId, reference })
      const committedSequence = typeof afterCursor === "string" ? undefined : afterCursor?.sequence
      const events: Array<Event> = []
      const followed = new Set<string>()
      const tracedDeltas = new Set<string>()
      const updates = yield* Queue.bounded<
        | {
            readonly _tag: "event"
            readonly event: Event
            readonly actionable: boolean
            readonly terminal?: Status
          }
        | { readonly _tag: "stopped"; readonly status: Status; readonly actionable: boolean }
        | { readonly _tag: "failed"; readonly error: BackendError }
      >(1_024)
      const attributedEvent = (item: Execution.ExecutionEvent, childExecutionId: string | undefined) =>
        Mapping.event(
          childExecutionId === undefined
            ? item
            : {
                ...item,
                data: { ...item.data, execution_id: childExecutionId },
              },
        )
      let launch!: (
        execution: Ids.ExecutionId,
        root: boolean,
        cursor?: string,
      ) => Effect.Effect<void, never, Scope.Scope>
      const followOne = (execution: Ids.ExecutionId, root: boolean, cursor: string | undefined) => {
        let replayingFromBeginning = false
        const consume = (nextCursor: string | undefined) =>
          Stream.runForEachWhile(
            client.executions.follow({
              execution_id: execution,
              ...(nextCursor === undefined ? {} : { after_cursor: nextCursor }),
            }),
            (item) => {
              if (item._tag === "reconnecting")
                return root
                  ? Effect.logWarning("execution.follow.reconnecting").pipe(
                      Effect.annotateLogs({
                        "rika.reconnect.attempt": item.attempt,
                        "rika.reconnect.message": item.message,
                      }),
                      Effect.as(true),
                    )
                  : Effect.succeed(true)
              if (item._tag === "stopped") {
                if (!root || item.reason._tag === "actionable_wait") {
                  if (item.reason._tag !== "actionable_wait") return Effect.succeed(false)
                  return Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true }).pipe(
                    Effect.as(false),
                  )
                }
                return Queue.offer(updates, {
                  _tag: "stopped",
                  status: Status.make(item.reason.status),
                  actionable: false,
                }).pipe(Effect.as(false))
              }
              if (
                root &&
                replayingFromBeginning &&
                committedSequence !== undefined &&
                item.event.sequence <= committedSequence
              )
                return Effect.succeed(true)
              const spawnedChild = Mapping.childExecutionIdFromEvent(item.event)
              const attributed = attributedEvent(item.event, root ? undefined : String(execution))
              const mapped =
                attemptCost !== undefined &&
                attributed.type === "model.attempt.completed" &&
                (attributed.data?.cost === undefined || attributed.data.cost === null)
                  ? { ...attributed, data: { ...attributed.data, cost: attemptCost } }
                  : attributed
              const terminal: Status | undefined = ExecutionStatus.terminalEventStatus(mapped.type)
              const inspectActionable =
                stopAtActionableWait && Mapping.isActionableWait(mapped) && typeof mapped.data?.wait_id === "string"
                  ? client.executions
                      .inspect(execution)
                      .pipe(
                        Effect.map((inspection) =>
                          inspection.waiting_on.some((wait) => wait.wait_id === mapped.data?.wait_id),
                        ),
                      )
                  : Effect.succeed(false)
              return Effect.gen(function* () {
                const actionable = yield* inspectActionable
                yield* Queue.offer(updates, {
                  _tag: "event",
                  event: mapped,
                  actionable: actionable && !root,
                  ...(root && terminal !== undefined ? { terminal } : {}),
                })
                if (eventScope === "tree" && spawnedChild !== undefined)
                  yield* launch(Ids.ExecutionId.make(spawnedChild), false)
                if (actionable && root)
                  yield* Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true })
                return terminal === undefined && !actionable
              })
            },
          )
        return Effect.gen(function* () {
          const inspection = yield* client.executions.inspect(execution).pipe(
            Effect.retry({
              while: Mapping.isExecutionNotFound,
              schedule: Schedule.spaced("10 millis"),
              times: 100,
            }),
          )
          if (root && cursor !== undefined && inspection.last_event_cursor === cursor) {
            if (Recovery.terminalExecutionStatus(inspection.status)) {
              yield* Queue.offer(updates, {
                _tag: "stopped",
                status: Status.make(inspection.status),
                actionable: false,
              })
              return
            }
            if (
              stopAtActionableWait &&
              inspection.waiting_on.some((wait) => wait.mode !== Recovery.childJoinWaitMode)
            ) {
              yield* Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true })
              return
            }
          }
          if (eventScope === "tree")
            yield* Effect.forEach(
              inspection.child_runs,
              (child) => launch(Ids.ExecutionId.make(String(child.child_execution_id)), false),
              { discard: true },
            )
          yield* consume(cursor).pipe(
            Effect.catchTag("EventLogCursorNotFound", () => {
              replayingFromBeginning = true
              return consume(undefined)
            }),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            root
              ? Queue.offer(updates, {
                  _tag: "failed",
                  error: BackendError.make({
                    message: Mapping.isExecutionNotFound(Cause.squash(cause))
                      ? "ExecutionNotFound"
                      : Cause.pretty(cause),
                  }),
                }).pipe(Effect.asVoid)
              : Effect.logWarning("execution.child.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.execution.id": String(execution),
                    "rika.failure.kind": Tree.failureKind(cause),
                  }),
                ),
          ),
        )
      }
      launch = (execution, root, cursor) =>
        Effect.suspend(() => {
          const key = String(execution)
          if (followed.has(key)) return Effect.void
          followed.add(key)
          return followOne(execution, root, cursor).pipe(Effect.forkScoped, Effect.asVoid)
        })
      yield* launch(rootExecutionId, true, Identifier.cursorOf(afterCursor))
      let stoppedAtActionableWait = false
      let stoppedStatus: Status | undefined
      while (stoppedStatus === undefined) {
        const update = yield* Queue.take(updates)
        if (update._tag === "failed") return yield* update.error
        if (update._tag === "stopped") {
          stoppedAtActionableWait = update.actionable
          stoppedStatus = update.status
          continue
        }
        events.push(update.event)
        onEvent?.(update.event)
        const traceDelta =
          update.event.type === "model.reasoning.delta" ||
          update.event.type === "model.output.delta" ||
          update.event.type === "model.toolcall.delta"
        if (!traceDelta || !tracedDeltas.has(update.event.type)) {
          if (traceDelta) tracedDeltas.add(update.event.type)
          if (traceDelta || Mapping.observableEventTypes.has(update.event.type))
            yield* Effect.logInfo("execution.event.received").pipe(
              Effect.annotateLogs({
                "rika.event.cursor": update.event.cursor,
                "rika.event.sequence": update.event.sequence,
                "rika.event.type": update.event.type,
              }),
            )
        }
        if (update.actionable) {
          stoppedAtActionableWait = true
          stoppedStatus = "waiting"
        } else if (update.terminal !== undefined) stoppedStatus = update.terminal
      }
      const status = stoppedStatus ?? Mapping.statusFromEvents(events)
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.completed").pipe(
        Effect.annotateLogs({
          ...followAnnotations,
          "rika.duration.ms": completedAt - startedAt,
          "rika.event.count": events.length,
          "rika.execution.status": status,
        }),
      )
      let finalStatus = status
      if (stoppedAtActionableWait && (status === "running" || status === "queued")) {
        finalStatus = Status.make("waiting")
      }
      if (Recovery.terminalExecutionStatus(finalStatus))
        yield* Tree.cancelOutlivingChildren({ client, root: rootExecutionId })
      const checkpoint = yield* Identifier.checkpointForExecution({ client, id: rootExecutionId })
      return {
        turnId,
        status: finalStatus,
        events,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.suspend(() => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        if (input.reference !== undefined && String(Cause.squash(cause)).includes("ExecutionNotFound"))
          return Effect.logInfo("execution.follow.missing")
        return Effect.logError("execution.follow.failed").pipe(
          Effect.annotateLogs("rika.failure.kind", Tree.failureKind(cause)),
        )
      }),
    ),
    Effect.annotateLogs({
      "rika.execution.id": String(Identifier.executionId({ turnId: input.turnId, reference: input.reference })),
      "rika.turn.id": input.turnId,
    }),
  )
