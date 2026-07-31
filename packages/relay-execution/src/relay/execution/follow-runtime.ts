import * as Backend from "./execution-backend"
import { Client, Ids, type Execution } from "@relayfx/sdk"
import { Cause, Clock, Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { ExecutionCheckpoint, Event } from "@rika/product/execution-event"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import type { EventScope } from "@rika/product/execution-request"
import { BackendError } from "@rika/product/execution-service"
import { Status } from "@rika/product/execution-status"
import * as ExecutionStatus from "@rika/product/execution-status"
export const followExecution = (
  client: Client.Interface,
  turnId: string,
  afterCursor: string | ExecutionCheckpoint | undefined,
  onEvent: ((item: Event) => void) | undefined,
  stopAtActionableWait = true,
  reference?: ExecutionReference,
  eventScope: EventScope = "tree",
  attemptCost?: { readonly amount: number; readonly currency: string },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const followAnnotations = {
        "rika.follow.cursor": Backend.RelayInternals.cursorOf(afterCursor) ?? "start",
        "rika.follow.scope": eventScope,
      }
      yield* Effect.logInfo("execution.follow.started").pipe(Effect.annotateLogs(followAnnotations))
      const rootExecutionId = Backend.RelayInternals.executionId(turnId, reference)
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
        Backend.RelayInternals.event(
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
              const spawnedChild = Backend.RelayInternals.childExecutionIdFromEvent(item.event)
              const attributed = attributedEvent(item.event, root ? undefined : String(execution))
              const mapped =
                attemptCost !== undefined &&
                attributed.type === "model.attempt.completed" &&
                (attributed.data?.cost === undefined || attributed.data.cost === null)
                  ? { ...attributed, data: { ...attributed.data, cost: attemptCost } }
                  : attributed
              const terminal: Status | undefined = ExecutionStatus.terminalEventStatus(mapped.type)
              const inspectActionable =
                stopAtActionableWait && Backend.RelayInternals.isActionableWait(mapped) && typeof mapped.data?.wait_id === "string"
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
              while: Backend.RelayInternals.isExecutionNotFound,
              schedule: Schedule.spaced("10 millis"),
              times: 100,
            }),
          )
          if (root && cursor !== undefined && inspection.last_event_cursor === cursor) {
            if (Backend.RelayInternals.terminalExecutionStatus(inspection.status)) {
              yield* Queue.offer(updates, {
                _tag: "stopped",
                status: Status.make(inspection.status),
                actionable: false,
              })
              return
            }
            if (stopAtActionableWait && inspection.waiting_on.some((wait) => wait.mode !== Backend.RelayInternals.childJoinWaitMode)) {
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
                    message: Backend.RelayInternals.isExecutionNotFound(Cause.squash(cause)) ? "ExecutionNotFound" : Cause.pretty(cause),
                  }),
                }).pipe(Effect.asVoid)
              : Effect.logWarning("execution.child.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.execution.id": String(execution),
                    "rika.failure.kind": Backend.RelayInternals.failureKind(cause),
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
      yield* launch(rootExecutionId, true, Backend.RelayInternals.cursorOf(afterCursor))
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
          if (traceDelta || Backend.RelayInternals.observableEventTypes.has(update.event.type))
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
      const status = stoppedStatus ?? Backend.RelayInternals.statusFromEvents(events)
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
      if (Backend.RelayInternals.terminalExecutionStatus(finalStatus)) yield* Backend.RelayInternals.cancelOutlivingChildren(client, rootExecutionId)
      const checkpoint = yield* Backend.RelayInternals.checkpointForExecution(client, rootExecutionId)
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
        if (reference !== undefined && String(Cause.squash(cause)).includes("ExecutionNotFound"))
          return Effect.logInfo("execution.follow.missing")
        return Effect.logError("execution.follow.failed").pipe(
          Effect.annotateLogs("rika.failure.kind", Backend.RelayInternals.failureKind(cause)),
        )
      }),
    ),
    Effect.annotateLogs({
      "rika.execution.id": String(Backend.RelayInternals.executionId(turnId, reference)),
      "rika.turn.id": turnId,
    }),
  )
