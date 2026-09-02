import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Schema, Stream } from "effect"
import { Errors, Run, RunTree, Runtime } from "generalist/runtime"
import { resolveSemanticTreeEvent, type SemanticTreeEvent } from "../projection/semantic/event"
import { TreeProjector } from "../projection/tree/projector"
import { token } from "../projection/decoding"
import * as RuntimeTelemetry from "./runtime-telemetry"

type WatchInput = Parameters<ExecutionGateway.Interface["watchTurn"]>[1]
type Projector = ReturnType<typeof TreeProjector.make>
type Projection = { readonly change?: ExecutionGateway.WatchEvent; readonly childRunId?: string }
type RootProjectionEvent = {
  readonly _tag: "root"
  readonly event: SemanticTreeEvent
  readonly checkpoint: RunTree.Checkpoint
}
type TitleProjectionEvent = { readonly _tag: "title"; readonly snapshot: Run.RunSnapshot | undefined }
type ProjectionEvent = RootProjectionEvent | TitleProjectionEvent

const message = (cause: unknown) => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  const encoded = JSON.stringify(cause)
  return encoded === undefined || encoded === "{}" ? String(cause) : encoded
}

const watchFailureMessage = (cause: unknown) => {
  if (Schema.is(Errors.TreeCursorInvalid)(cause)) return `Run-tree checkpoint cursor is invalid: ${cause.message}`
  if (Schema.is(Errors.TreeCursorRootMismatch)(cause)) return "Run-tree checkpoint belongs to a different root Run"
  if (Schema.is(Errors.TreeCursorExpired)(cause)) return "Run-tree checkpoint expired before projection resumed"
  if (Schema.is(Errors.TreeCursorFuture)(cause)) return "Run-tree checkpoint is ahead of committed execution"
  if (Schema.is(Errors.TreeReplayLimitInvalid)(cause))
    return `Run-tree replay limit ${cause.received} is outside ${cause.minimum}..${cause.maximum}`
  if (Schema.is(Errors.RunNotFound)(cause)) return `Root Run ${cause.runId} is unavailable`
  if (Schema.is(Errors.RuntimeUnavailable)(cause)) return cause.message
  return message(cause)
}

const rootEvents = (
  runtime: Runtime.Service,
  link: ExecutionGateway.ExecutionLink,
  input: WatchInput,
  hosted: boolean,
) =>
  Stream.unwrap(
    runtime.treeCheckpoint(link.runId).pipe(
      Effect.map((checkpoint) => {
        const observeModel = hosted ? RuntimeTelemetry.makeHostedModelObserver(link) : () => Effect.void
        let observeLive = input?.checkpoint === undefined
        return RunTree.watch({ rootRunId: link.runId, settlement: "root-blocked" }).pipe(
          Stream.provideService(Runtime.Runtime, runtime),
          Stream.mapEffect((event) => resolveSemanticTreeEvent(event, runtime.resolveModelResponse)),
          Stream.tap((event) => {
            if (observeLive) return observeModel(event)
            if (event.cursor === input?.checkpoint?.cursor) observeLive = true
            return Effect.void
          }),
          Stream.map((event): RootProjectionEvent => ({ _tag: "root", event, checkpoint })),
        )
      }),
    ),
  )

const titleEvents = (runtime: Runtime.Service, titleId: string | undefined) =>
  titleId === undefined
    ? Stream.empty
    : runtime.events({ runId: titleId }).pipe(
        Stream.filter(
          (event) => event._tag === "RunCompleted" || event._tag === "RunFailed" || event._tag === "RunCancelled",
        ),
        Stream.take(1),
        Stream.mapEffect(() => runtime.snapshot(titleId)),
        Stream.map((snapshot): TitleProjectionEvent => ({ _tag: "title", snapshot })),
        Stream.catchTag("generalist/runtime/RunNotFound", () =>
          Stream.succeed<TitleProjectionEvent>({ _tag: "title", snapshot: undefined }),
        ),
      )

const titleText = (snapshot: Run.RunSnapshot) => {
  const outcome = snapshot.outcome
  return outcome?._tag === "Succeeded" && "text" in outcome.result ? outcome.result.text : undefined
}

const applyTitle = (projector: Projector, snapshot: Run.RunSnapshot | null | undefined): Array<Projection> => {
  const change =
    snapshot === undefined || snapshot === null
      ? projector.applyTitle(undefined, [])
      : projector.applyTitle(titleText(snapshot), snapshot.usage)
  return change === undefined ? [] : [{ change }]
}

const modelPreviewUsage = (
  projector: Projector,
  treeEvent: SemanticTreeEvent,
): ExecutionGateway.ModelPreviewUsage | undefined => {
  const event = treeEvent.event
  if (event._tag !== "ModelAttemptCompleted") return undefined
  const total = token(event.usage.outputTokens.total)
  const text = token(event.usage.outputTokens.text)
  const reasoning = token(event.usage.outputTokens.reasoning)
  if (total === undefined && text === undefined && reasoning === undefined) return undefined
  const outputTokens: ExecutionGateway.ModelPreviewUsage["outputTokens"] = {}
  if (total !== undefined) Object.assign(outputTokens, { total })
  if (text !== undefined) Object.assign(outputTokens, { text })
  if (reasoning !== undefined) Object.assign(outputTokens, { reasoning })
  const usage: ExecutionGateway.ModelPreviewUsage = {
    _tag: "ModelPreviewUsage",
    runId: treeEvent.runId,
    turn: event.turn,
    modelCallId: event.modelCallId,
    modelAttemptId: event.modelAttemptId,
    attempt: event.attempt,
    completedAt: event.completedAt,
    outputTokens,
  }
  const parentId = projector.previewParentId(treeEvent.runId)
  return parentId === undefined ? usage : { ...usage, parentId }
}

const refreshUsage = (
  runtime: Runtime.Service,
  projector: Projector,
  event: RootProjectionEvent,
  pending: RunTree.Checkpoint | undefined,
) =>
  Effect.gen(function* () {
    if (pending?.cursor === event.event.cursor) {
      projector.replaceUsage(event.event.rootRunId, pending.inspection.usage)
      return undefined
    }
    if (pending !== undefined) return pending
    const runEvent = event.event.event
    if (runEvent._tag !== "ModelAttemptCompleted" && runEvent._tag !== "ModelAttemptFailed") return undefined
    const checkpoint = yield* runtime.treeCheckpoint(event.event.rootRunId)
    if (checkpoint.cursor !== event.event.cursor) return checkpoint
    projector.replaceUsage(event.event.rootRunId, checkpoint.inspection.usage)
    return undefined
  })

const projectEvents = (runtime: Runtime.Service, projector: Projector) => {
  let pendingTitle: Run.RunSnapshot | null | undefined
  let pendingUsage: RunTree.Checkpoint | undefined
  let rootProjected = false
  return (event: ProjectionEvent) => {
    if (event._tag === "title") {
      if (!rootProjected && pendingTitle === undefined) {
        pendingTitle = event.snapshot ?? null
        return Effect.succeed([])
      }
      return Effect.succeed(applyTitle(projector, event.snapshot))
    }
    return Effect.gen(function* () {
      if (rootProjected) pendingUsage = yield* refreshUsage(runtime, projector, event, pendingUsage)
      const change = projector.apply(event.event)
      if (!rootProjected) {
        if (event.event.cursor !== event.checkpoint.cursor) return []
        rootProjected = true
        projector.replaceUsage(event.event.rootRunId, event.checkpoint.inspection.usage)
        const changes: Array<Projection> = [{ change: projector.snapshot() }]
        changes.push(...projector.previewRunIds().map((childRunId) => ({ childRunId })))
        if (pendingTitle !== undefined) {
          changes.push(...applyTitle(projector, pendingTitle))
          pendingTitle = undefined
        }
        return changes
      }
      const projected: Projection =
        event.event.event._tag === "ChildLinked" ? { change, childRunId: event.event.event.childRunId } : { change }
      const usage = modelPreviewUsage(projector, event.event)
      const changes: Array<Projection> = usage === undefined ? [projected] : [{ change: usage }, projected]
      if (pendingTitle !== undefined) {
        changes.push(...applyTitle(projector, pendingTitle))
        pendingTitle = undefined
      }
      return changes
    })
  }
}

const output = (
  runtime: Runtime.Service,
  projector: Projector,
  link: ExecutionGateway.ExecutionLink,
  projected: Stream.Stream<Projection, ExecutionGateway.WatchTurnFailure>,
) =>
  Stream.unwrap(
    Stream.broadcastN(projected, { n: 2, capacity: 64 }).pipe(
      Effect.map(([projectionEvents, childEvents]) => {
        const durable = projectionEvents.pipe(
          Stream.flatMap(({ change }) => (change === undefined ? Stream.empty : Stream.succeed(change))),
        )
        const previewRunIds = Stream.concat(
          Stream.succeed(link.runId),
          childEvents.pipe(
            Stream.flatMap(({ childRunId }) => (childRunId === undefined ? Stream.empty : Stream.succeed(childRunId))),
          ),
        )
        const previews = previewRunIds.pipe(
          Stream.flatMap(
            (runId) => {
              const parentId = projector.previewParentId(runId)
              return runtime
                .previews({ runId })
                .pipe(Stream.map((event) => (parentId === undefined ? event : { ...event, parentId })))
            },
            { concurrency: "unbounded" },
          ),
        )
        return Stream.merge(durable, previews, { haltStrategy: "left" })
      }),
    ),
  )

const watchTurn = (
  runtime: Runtime.Service,
  hosted: boolean,
  link: ExecutionGateway.ExecutionLink,
  input: WatchInput,
) => {
  let projector: Projector
  try {
    const options: Parameters<typeof TreeProjector.make>[2] = {
      titleExpected: link.titleRunId !== undefined,
    }
    if (input?.pricing !== undefined) Object.assign(options, { pricing: input.pricing })
    projector = TreeProjector.make(link.turnId, input?.prompt ?? "", options)
  } catch (cause) {
    return Stream.fail(ExecutionGateway.WatchTurnFailure.make({ message: message(cause) }))
  }
  const projected = Stream.merge(rootEvents(runtime, link, input, hosted), titleEvents(runtime, link.titleRunId)).pipe(
    Stream.mapEffect(projectEvents(runtime, projector)),
    Stream.flatMap(Stream.fromIterable),
    Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: watchFailureMessage(cause) })),
  )
  return output(runtime, projector, link, projected)
}

export const RuntimeProjection = { watchTurn }
