import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Option, Schema, Stream } from "effect"
import { Errors, Run, RunTree, Runtime } from "generalist/runtime"
import { resolveSemanticTreeEvent, type SemanticTreeEvent } from "../projection/semantic/event"
import { TreeProjector } from "../projection/tree/projector"
import * as RuntimeTelemetry from "./runtime-telemetry"

type WatchInput = Parameters<ExecutionGateway.Interface["watchTurn"]>[1]
type Projector = ReturnType<typeof TreeProjector.make>
type Projection = { readonly change: ReturnType<Projector["apply"]>; readonly childRunId?: string }
type RootProjectionEvent = { readonly _tag: "root"; readonly event: SemanticTreeEvent }
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

const replayThenWatch = (
  runtime: Runtime.Service,
  rootRunId: string,
  cursor: RunTree.TreeCursor,
): Stream.Stream<RunTree.TreeEvent, Runtime.TreeReplayError> =>
  Stream.unwrap(
    RunTree.replay({ rootRunId, cursor, limit: 1_000 }).pipe(
      Effect.provideService(Runtime.Runtime, runtime),
      Effect.map((page) =>
        Stream.concat(
          Stream.fromIterable(page.events),
          page.hasMore
            ? replayThenWatch(runtime, rootRunId, page.cursor)
            : RunTree.watch({ rootRunId, cursor: page.cursor, settlement: "root-blocked" }).pipe(
                Stream.provideService(Runtime.Runtime, runtime),
              ),
        ),
      ),
    ),
  )

const rootEvents = (
  runtime: Runtime.Service,
  link: ExecutionGateway.ExecutionLink,
  input: WatchInput,
  hosted: boolean,
) => {
  const cursor = input?.checkpoint?.cursor
  const events =
    cursor === undefined
      ? RunTree.watch({ rootRunId: link.runId, settlement: "root-blocked" }).pipe(
          Stream.provideService(Runtime.Runtime, runtime),
        )
      : replayThenWatch(runtime, link.runId, RunTree.TreeCursor.make(cursor))
  const observeModel = hosted ? RuntimeTelemetry.makeHostedModelObserver(link) : () => Effect.void
  return events.pipe(
    Stream.mapEffect((event) => resolveSemanticTreeEvent(event, runtime.resolveModelResponse)),
    Stream.tap(observeModel),
    Stream.map((event): RootProjectionEvent => ({ _tag: "root", event })),
  )
}

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

const formatCell = (projector: Projector, event: SemanticTreeEvent) => {
  if (event.event._tag !== "ToolExecutionCompleted" || event.event.call.name !== "typescript") return Effect.void
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(event.event.call.params)
  return Option.isNone(decoded)
    ? Effect.void
    : projector.formatCellSource(event.runId, event.event.call.id, decoded.value.code)
}

const projectEvents = (projector: Projector, input: WatchInput) => {
  let pendingTitle: Run.RunSnapshot | null | undefined
  let rootProjected = input?.checkpoint !== undefined
  return (event: ProjectionEvent): Effect.Effect<Array<Projection>> => {
    if (event._tag === "title") {
      if (!rootProjected && pendingTitle === undefined) {
        pendingTitle = event.snapshot ?? null
        return Effect.succeed([])
      }
      return Effect.succeed(applyTitle(projector, event.snapshot))
    }
    return Effect.gen(function* () {
      rootProjected = true
      yield* formatCell(projector, event.event)
      const change = projector.apply(event.event)
      const projected: Projection =
        event.event.event._tag === "ChildLinked" ? { change, childRunId: event.event.event.childRunId } : { change }
      const changes = [projected]
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
  input: WatchInput,
  projected: Stream.Stream<Projection, ExecutionGateway.WatchTurnFailure>,
) =>
  Stream.unwrap(
    Stream.broadcastN(projected, { n: 2, capacity: 64 }).pipe(
      Effect.map(([projectionEvents, childEvents]) => {
        const projections = Stream.map(projectionEvents, ({ change }) => change)
        const durable =
          input?.checkpoint === undefined
            ? Stream.concat(Stream.succeed(projector.snapshot()), projections)
            : projections
        const previewRunIds = Stream.concat(
          Stream.fromIterable([link.runId, ...projector.previewRunIds()]),
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
    projector = TreeProjector.make(
      link.turnId,
      input?.prompt ?? "",
      input?.checkpoint,
      input?.units ?? [],
      link.titleRunId !== undefined,
      input?.pricing,
    )
  } catch (cause) {
    return Stream.fail(ExecutionGateway.WatchTurnFailure.make({ message: message(cause) }))
  }
  const projected = Stream.merge(rootEvents(runtime, link, input, hosted), titleEvents(runtime, link.titleRunId)).pipe(
    Stream.mapEffect(projectEvents(projector, input)),
    Stream.flatMap(Stream.fromIterable),
    Stream.mapError((cause) => ExecutionGateway.WatchTurnFailure.make({ message: watchFailureMessage(cause) })),
  )
  return output(runtime, projector, link, input, projected)
}

export const RuntimeProjection = { watchTurn }
