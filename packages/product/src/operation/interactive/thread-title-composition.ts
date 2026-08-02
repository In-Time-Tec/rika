import { OperationError } from "../operation-error"
import { Cause, Clock, Effect } from "effect"
import * as UsageSnapshot from "@rika/product/usage-snapshot"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as UsageRepository from "@rika/product/usage-repository"
import { AgentDepth } from "../../execution/contract/execution-identifier"
import * as ThreadRepository from "@rika/product/thread-repository"
import { failureKind } from "../operation-error"
import { isTerminalStatus } from "../../execution/contract/execution-status"
import { threadTitleLimit, clampThreadTitle } from "../../thread/query/thread-title-policy"
import type { InteractiveEvent } from "./interactive-event"

const titleExecutionId = (turnId: Turn.TurnId) => AgentDepth.childExecutionId(String(turnId), "title")
const sanitize = (text: string) =>
  text
    .split(/\r?\n/, 1)[0]
    ?.replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'#\s]+/, "")
    .replace(/["'\s]+$/, "")
    .slice(0, threadTitleLimit)
    .trimEnd() ?? ""

export const titleInteractiveThread = (input: {
  readonly thread: Thread.Thread
  readonly turn: Turn.AgentExecutionTurn
  readonly backend: ExecutionBackend.Interface
  readonly threads: ThreadRepository.Interface
  readonly usage: UsageRepository.Interface
  readonly commitUsage: (
    id: string,
    threadId: string,
    turnId: string,
    events: ReadonlyArray<ExecutionEvent.Event>,
    terminal: boolean,
  ) => Effect.Effect<any, OperationError, never>
  readonly announce: (event: InteractiveEvent) => void
  readonly notify: Effect.Effect<any, OperationError, never>
  readonly publishUsage: (usage: UsageSnapshot.TurnUsage | undefined) => Effect.Effect<any, OperationError, never>
  readonly attempts: Map<string, number>
  readonly settled: Set<string>
}) =>
  Effect.gen(function* () {
    if (input.turn.executionRoute.title === undefined) return
    const current = yield* input.threads.get(input.thread.id)
    if (current === undefined || current.title !== clampThreadTitle(input.turn.prompt)) return
    const id = titleExecutionId(input.turn.id)
    if (input.settled.has(id)) return
    const inspection = yield* input.backend.inspect(id, ExecutionIdentifier.executionReference)
    if (inspection?.status === "failed" || inspection?.status === "cancelled") {
      input.settled.add(id)
      return
    }
    let result: ExecutionEvent.Result | undefined
    if (inspection === undefined) {
      yield* input.backend.invokeChild({
        parentTurnId: String(input.turn.id),
        childId: "title",
        profile: "Title",
        prompt: input.turn.prompt.slice(0, 2000),
      })
      const spawned = yield* input.backend.inspect(id, ExecutionIdentifier.executionReference)
      if (spawned !== undefined && isTerminalStatus(spawned.status))
        result = yield* input.backend.replay(id, undefined, ExecutionIdentifier.executionReference)
      else if (input.backend.follow !== undefined)
        result = yield* input.backend.follow(id, undefined, undefined, ExecutionIdentifier.executionReference)
    } else if (isTerminalStatus(inspection.status))
      result = yield* input.backend.replay(id, undefined, ExecutionIdentifier.executionReference)
    else if (input.backend.follow !== undefined)
      result = yield* input.backend.follow(id, undefined, undefined, ExecutionIdentifier.executionReference)
    if (result === undefined) return
    yield* input.commitUsage(
      id,
      String(input.thread.id),
      String(input.turn.id),
      result.events,
      isTerminalStatus(result.status),
    )
    yield* input.usage.readTurn(String(input.turn.id)).pipe(Effect.flatMap(input.publishUsage))
    if (!isTerminalStatus(result.status)) return
    input.settled.add(id)
    if (result.status !== "completed") return
    const title = sanitize(
      result.events
        .filter((event) => event.type === "model.output.completed")
        .map((event) => event.text ?? "")
        .join(""),
    )
    if (title.length === 0) return
    const renamed = yield* input.threads.renameIfTitle(
      input.thread.id,
      clampThreadTitle(input.turn.prompt),
      title,
      yield* Clock.currentTimeMillis,
    )
    if (renamed === undefined) return
    input.announce({ _tag: "ThreadTitled", threadId: String(input.thread.id), title })
    yield* input.notify
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread-title.failed").pipe(
        Effect.annotateLogs({ "rika.failure.kind": failureKind(cause), "rika.failure.cause": Cause.pretty(cause) }),
      ),
    ),
  )
