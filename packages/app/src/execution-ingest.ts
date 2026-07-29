import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionId, ExecutionStatus } from "@rika/tools"
import * as Transcript from "@rika/transcript"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Latch,
  Queue,
  Schema,
  Scope,
  Semaphore,
} from "effect"

export const projectionVersion = 2

export const defaultCommitWindow = Duration.millis(250)
export const defaultCommitEvents = 64

export class IngestFailure extends Schema.TaggedErrorClass<IngestFailure>()("ExecutionIngestFailure", {
  message: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  executionId: Schema.String,
  reason: Schema.Literals(["cursor-rejected", "backend"]),
}) {}

export interface Root {
  readonly threadId: Thread.ThreadId
  readonly turnId: Turn.TurnId
}

export interface Discovery {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly executionId: string
}

export interface Delivery extends Discovery {
  readonly event: ExecutionBackend.Event
}

export interface Commit {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly revision: number
  readonly reconciled: boolean
}

export interface Refold {
  readonly threadId: Thread.ThreadId
  readonly rootTurnId: Turn.TurnId
  readonly phase: "started" | "finished"
}

export interface Options {
  readonly backend: ExecutionBackend.Interface
  readonly transcripts: TranscriptRepository.Interface
  readonly turns: TurnRepository.Interface
  readonly commitWindow?: Duration.Input
  readonly commitEvents?: number
  readonly onDiscovered?: (discovery: Discovery) => void
  readonly onDelivered?: (delivery: Delivery) => void
  readonly onCommitted?: (commit: Commit) => void
  readonly onRefold?: (refold: Refold) => void
  readonly onFailure?: (failure: IngestFailure) => void
}

export interface Interface {
  readonly ensure: (root: Root) => Effect.Effect<void>
  readonly deliver: (turnId: Turn.TurnId, event: ExecutionBackend.Event) => void
  readonly consumed: (turnId: Turn.TurnId) => Effect.Effect<void>
  readonly settled: (turnId: Turn.TurnId) => Effect.Effect<void>
}

type Settled = NonNullable<TranscriptRepository.ConsumedExecution["status"]>

interface Node {
  readonly executionId: string
  readonly key: string
  readonly parentKey: string | undefined
  readonly base: () => Transcript.Projection
  projection: Transcript.Projection
  cursor: string | undefined
  sequence: number
  status: Settled | undefined
  rebuild: boolean
  resumed: boolean
  caught: boolean
}

interface Pipeline {
  readonly threadId: Thread.ThreadId
  readonly turnId: Turn.TurnId
  readonly rootKey: string
  readonly nodes: Map<string, Node>
  readonly order: Array<string>
  readonly finished: Deferred.Deferred<void>
  readonly rootSettled: Latch.Latch
  readonly rootCommitted: Latch.Latch
  readonly abandoned: Latch.Latch
  readonly wake: Queue.Queue<void>
  readonly committing: Semaphore.Semaphore
  readonly catchUp: boolean
  readonly refolding: boolean
  readonly failures: Array<IngestFailure>
  fork: (effect: Effect.Effect<void>) => void
  revision: number
  turn: Turn.Turn
  active: number
  pending: number
  dirty: boolean
  reconciled: boolean
  stopped: boolean
  reading: number
  delivered: Array<ExecutionBackend.Event> | undefined
}

const isTerminalStatus = ExecutionStatus.isTerminalStatus

const settledStatus = (status: ExecutionBackend.Status): Settled | undefined =>
  status === "completed" || status === "failed" || status === "cancelled" ? status : undefined

const childStatus = (status: Settled) => (status === "completed" ? ("complete" as const) : status)

const toolForChild = (projection: Transcript.Projection, childExecutionId: string) =>
  Transcript.childParentMatch(
    projection.units.flatMap((unit) =>
      unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"
        ? [
            {
              id: unit.content.block.id,
              scope: unit.turnId,
              childId: unit.content.block.childId,
              family: unit.content.block.presentation.family,
              tool: unit.content.block,
            },
          ]
        : [],
    ),
    childExecutionId,
  )?.tool

const spawnedChildIds = (event: ExecutionBackend.Event): ReadonlyArray<string> => {
  const ids = new Set<string>()
  const addAliases = (value: Readonly<Record<string, unknown>> | undefined) => {
    if (value === undefined) return
    for (const alias of ["child_execution_id", "child_run_id", "childId", "child_id"] as const) {
      const id = value[alias]
      if (typeof id === "string" && id.length > 0) ids.add(id)
    }
  }
  if (event.childExecutionId !== undefined && event.childExecutionId.length > 0) ids.add(event.childExecutionId)
  addAliases(event.data)
  const member = event.data?.member
  if (member !== null && typeof member === "object") addAliases(member as Readonly<Record<string, unknown>>)
  if (event.type === "child_fan_out.created" && Array.isArray(event.data?.children))
    for (const child of event.data.children)
      if (child !== null && typeof child === "object") addAliases(child as Readonly<Record<string, unknown>>)
  return [...ids]
}

const withoutSynthesizedTwins = (
  projection: Transcript.Projection,
  parents: ReadonlyMap<string, string>,
): Transcript.Projection => {
  const units = projection.units.filter((unit) => {
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return true
    const block = unit.content.block
    if (block.childId === undefined) return true
    const childKey = Transcript.executionKey(block.childId)
    const parent = parents.get(childKey)
    return block.id !== childKey || parent === undefined || parent === block.id
  })
  return units.length === projection.units.length ? projection : { ...projection, units }
}

const childProjectionOf = (
  key: string,
  units: ReadonlyArray<Transcript.Unit>,
  revision: number,
): Transcript.Projection =>
  units.length === 0 ? { ...Transcript.empty(key, ""), revision } : { units, revision, modelPhase: 0 }

const rootProjectionOf = (
  turn: Turn.Turn,
  stored: TranscriptRepository.Projection | undefined,
  revision: number,
): Transcript.Projection => {
  const stale = stored?.units.filter((unit) => unit.parentId === undefined) ?? []
  if (stored === undefined || stale.length === 0) return Transcript.empty(String(turn.id), turn.prompt)
  const promptKey = `turn:${String(turn.id)}:user`
  const prompt = Transcript.empty(String(turn.id), turn.prompt).units[0]!
  const units = stale.some((unit) => unit.key === promptKey)
    ? stale.map((unit) => (unit.key === promptKey ? { ...unit, content: prompt.content } : unit))
    : [prompt, ...stale]
  return {
    units,
    revision,
    modelPhase: stored.modelPhase,
    ...(stored.oldestCursor === undefined ? {} : { oldestCursor: stored.oldestCursor }),
    ...(stored.checkpointCursor === undefined ? {} : { checkpointCursor: stored.checkpointCursor }),
    ...(stored.costUsd === undefined ? {} : { costUsd: stored.costUsd }),
    ...(stored.usageCursors === undefined ? {} : { usageCursors: stored.usageCursors }),
    ...(stored.pricingVersion === undefined ? {} : { pricingVersion: stored.pricingVersion }),
  }
}

const restore = (
  turn: Turn.Turn,
  stored: TranscriptRepository.Projection | undefined,
): { readonly nodes: Map<string, Node>; readonly order: Array<string> } => {
  const rootKey = Transcript.executionKey(String(turn.id))
  const consumed = stored?.consumed ?? {}
  const rootConsumed = consumed[rootKey]
  const rootRevision = rootConsumed?.sequence ?? -1
  const rootCursor = rootConsumed === undefined || rootConsumed.cursor.length === 0 ? undefined : rootConsumed.cursor
  const root: Node = {
    executionId: String(turn.id),
    key: rootKey,
    parentKey: undefined,
    base: () => Transcript.empty(String(turn.id), turn.prompt),
    projection: rootProjectionOf(turn, stored, rootRevision),
    cursor: rootCursor,
    sequence: rootConsumed?.sequence ?? -1,
    status: rootConsumed?.status,
    rebuild: rootCursor === undefined,
    resumed: false,
    caught: false,
  }
  const nodes = new Map<string, Node>([[rootKey, root]])
  const order = [rootKey]
  const groups = new Map<string, Array<Transcript.Unit>>()
  for (const unit of stored?.units ?? []) {
    if (unit.parentId === undefined) continue
    const key = Transcript.executionKey(unit.turnId)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [unit])
    else group.push(unit)
  }
  const candidates = new Set<string>([...groups.keys(), ...Object.keys(consumed)])
  candidates.delete(rootKey)
  let remaining = [...candidates]
  while (remaining.length > 0) {
    const unresolved: Array<string> = []
    for (const key of remaining) {
      const parentKey = order.find((candidate) => toolForChild(nodes.get(candidate)!.projection, key) !== undefined)
      if (parentKey === undefined) {
        unresolved.push(key)
        continue
      }
      const units = groups.get(key) ?? []
      const entry = consumed[key]
      const revision = entry?.sequence ?? -1
      const cursor = entry === undefined || entry.cursor.length === 0 ? undefined : entry.cursor
      nodes.set(key, {
        executionId: key,
        key,
        parentKey,
        base: () => childProjectionOf(key, [], -1),
        projection: childProjectionOf(key, units, revision),
        cursor,
        sequence: entry?.sequence ?? -1,
        status: entry?.status,
        rebuild: cursor === undefined,
        resumed: false,
        caught: false,
      })
      order.push(key)
    }
    if (unresolved.length === remaining.length) break
    remaining = unresolved
  }
  return { nodes, order }
}

const bySequence = (left: ExecutionBackend.Event, right: ExecutionBackend.Event) => left.sequence - right.sequence

const fullyConsumed = (nodes: ReadonlyMap<string, Node>): boolean =>
  [...nodes.values()].every((node) => node.status !== undefined)

export const make = Effect.fn("ExecutionIngest.make")(function* (options: Options) {
  const ownerScope = yield* Effect.scope
  const commitWindow = Duration.fromInputUnsafe(options.commitWindow ?? defaultCommitWindow)
  const commitEvents = Math.max(1, Math.floor(options.commitEvents ?? defaultCommitEvents))
  const admission = yield* Semaphore.make(1)
  const pipelines = new Map<string, Pipeline>()

  const commit = (pipeline: Pipeline) =>
    pipeline.committing.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!pipeline.dirty && (pipeline.reconciled || !fullyConsumed(pipeline.nodes))) {
            if (pipeline.reading <= 0) pipeline.rootCommitted.openUnsafe()
            return
          }
          pipeline.dirty = false
          pipeline.pending = 0
          const turn = yield* options.turns.get(pipeline.turnId).pipe(Effect.orElseSucceed(() => pipeline.turn))
          if (turn === undefined) {
            pipeline.stopped = true
            return
          }
          pipeline.turn = turn
          const ready = pipeline.reading <= 0
          const parents = new Map<string, string>()
          for (const key of pipeline.order) {
            const node = pipeline.nodes.get(key)!
            if (node.parentKey === undefined) continue
            const parent = pipeline.nodes.get(node.parentKey)!
            let tool = toolForChild(parent.projection, node.executionId)
            if (tool === undefined) {
              const ensured = Transcript.ensureChildTool(parent.projection, node.executionId, "task")
              parent.projection = ensured.projection
              tool = ensured.tool
            }
            if (node.status !== undefined)
              parent.projection = Transcript.reconcileChild(
                parent.projection,
                node.executionId,
                childStatus(node.status),
                parent.projection.revision,
              )
            parents.set(key, tool.id)
          }
          const nested = pipeline.order.flatMap((key) => {
            const parentId = parents.get(key)
            return parentId === undefined
              ? []
              : [{ parentId, projection: withoutSynthesizedTwins(pipeline.nodes.get(key)!.projection, parents) }]
          })
          const root = pipeline.nodes.get(pipeline.rootKey)!
          const folded =
            nested.length === 0
              ? root.projection
              : Transcript.withNestedProjections(withoutSynthesizedTwins(root.projection, parents), nested)
          pipeline.revision = Math.max(folded.revision, pipeline.revision + 1)
          const projection = { ...folded, revision: pipeline.revision }
          const consumed: Record<string, TranscriptRepository.ConsumedExecution> = {}
          for (const [key, node] of pipeline.nodes)
            consumed[key] = {
              cursor: node.cursor ?? "",
              sequence: node.sequence,
              ...(node.status === undefined ? {} : { status: node.status }),
            }
          const reconciled = fullyConsumed(pipeline.nodes)
          pipeline.reconciled = reconciled
          const written = yield* options.transcripts
            .replace(turn, projection, { consumed, projectionVersion, childTreeReconciled: reconciled })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("execution.ingest.commit.failed").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(pipeline.threadId),
                    "rika.turn.id": String(pipeline.turnId),
                    "rika.failure.cause": Cause.pretty(cause),
                  }),
                  Effect.as(false),
                ),
              ),
            )
          if (written)
            options.onCommitted?.({
              threadId: pipeline.threadId,
              rootTurnId: pipeline.turnId,
              revision: projection.revision,
              reconciled,
            })
          if (ready) pipeline.rootCommitted.openUnsafe()
          yield* Effect.logDebug("execution.ingest.committed").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(pipeline.threadId),
              "rika.turn.id": String(pipeline.turnId),
              "rika.ingest.revision": projection.revision,
              "rika.ingest.executions": pipeline.nodes.size,
              "rika.ingest.reconciled": reconciled,
            }),
          )
        }),
      ),
    )

  const wake = (pipeline: Pipeline) => {
    Queue.offerUnsafe(pipeline.wake, undefined)
  }

  const fail = (pipeline: Pipeline, node: Node, reason: IngestFailure["reason"], message: string) => {
    pipeline.stopped = true
    const failure = IngestFailure.make({
      message,
      threadId: String(pipeline.threadId),
      turnId: String(pipeline.turnId),
      executionId: node.executionId,
      reason,
    })
    pipeline.failures.push(failure)
    options.onFailure?.(failure)
  }

  let startNode: (pipeline: Pipeline, node: Node) => void
  let release: (pipeline: Pipeline, root: Node) => void

  const caught = (pipeline: Pipeline, node: Node) => {
    if (node.caught) return
    node.caught = true
    pipeline.reading -= 1
    if (pipeline.reading <= 0) wake(pipeline)
  }

  const discover = (pipeline: Pipeline, parent: Node, childExecutionId: string) => {
    const key = Transcript.executionKey(childExecutionId)
    if (key.length === 0 || key === parent.key || pipeline.nodes.has(key)) return
    const node: Node = {
      executionId: childExecutionId,
      key,
      parentKey: parent.key,
      base: () => childProjectionOf(key, [], -1),
      projection: childProjectionOf(key, [], -1),
      cursor: undefined,
      sequence: -1,
      status: undefined,
      rebuild: false,
      resumed: false,
      caught: false,
    }
    pipeline.nodes.set(key, node)
    pipeline.order.push(key)
    pipeline.dirty = true
    options.onDiscovered?.({ threadId: pipeline.threadId, rootTurnId: pipeline.turnId, executionId: childExecutionId })
    wake(pipeline)
    startNode(pipeline, node)
  }

  const accept = (pipeline: Pipeline, node: Node, event: ExecutionBackend.Event) => {
    if (pipeline.stopped) return
    if (node.parentKey !== undefined || pipeline.catchUp)
      options.onDelivered?.({
        threadId: pipeline.threadId,
        rootTurnId: pipeline.turnId,
        executionId: node.executionId,
        event,
      })
    if (Transcript.isTransientEvent(event)) return
    if (event.executionId.length > 0 && !ExecutionId.ownsExecution(node.key, event.executionId)) return
    if (event.sequence <= node.sequence) {
      if (node.resumed)
        fail(
          pipeline,
          node,
          "cursor-rejected",
          `Execution ${node.executionId} replayed sequence ${event.sequence} at or before consumed sequence ${node.sequence}`,
        )
      return
    }
    node.resumed = false
    if (node.rebuild) {
      node.rebuild = false
      node.projection = node.base()
    }
    node.projection = Transcript.applyEvent(node.projection, event)
    node.cursor = event.cursor
    node.sequence = event.sequence
    pipeline.dirty = true
    pipeline.pending += 1
    const terminal = ExecutionStatus.terminalEventStatus(event.type)
    if (terminal !== undefined) {
      node.status = settledStatus(terminal)
      wake(pipeline)
      if (node.parentKey === undefined) pipeline.rootSettled.openUnsafe()
    } else if (pipeline.pending >= commitEvents) wake(pipeline)
    for (const childExecutionId of spawnedChildIds(event)) discover(pipeline, node, childExecutionId)
  }

  const pageNode = (pipeline: Pipeline, node: Node, reference: ExecutionBackend.ExecutionReference | undefined) =>
    Effect.gen(function* () {
      if (options.backend.pageEvents === undefined) {
        const result = yield* options.backend.replay(node.executionId, node.cursor, reference)
        for (const event of result.events.toSorted(bySequence)) accept(pipeline, node, event)
        return
      }
      const cursors = new Set<string>()
      let after = node.cursor
      while (!pipeline.stopped) {
        const page = yield* options.backend.pageEvents(node.executionId, "forward", after, 200, reference)
        for (const event of page.events.toSorted(bySequence)) accept(pipeline, node, event)
        if (!page.hasMore) return
        const next = page.newestCursor
        if (page.events.length === 0 || next === undefined || next === after || cursors.has(next))
          return fail(
            pipeline,
            node,
            "backend",
            `Execution ${node.executionId} reported more events after cursor ${after ?? "start"} but its page cursor did not advance`,
          )
        cursors.add(next)
        after = next
      }
    })

  const followNode = (pipeline: Pipeline, node: Node) =>
    Effect.gen(function* () {
      const reference = node.parentKey === undefined ? undefined : ExecutionBackend.executionReference
      const inspection = yield* options.backend
        .inspect(node.executionId, reference)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (inspection !== undefined) for (const child of inspection.children) discover(pipeline, node, child.executionId)
      if (node.status !== undefined) return
      const follow = options.backend.follow
      const owned = node.parentKey === undefined && !pipeline.catchUp
      if (owned) {
        if (inspection !== undefined) yield* pageNode(pipeline, node, reference)
        release(pipeline, node)
        caught(pipeline, node)
        if (pipeline.stopped || node.status !== undefined) return
        return yield* pipeline.rootSettled.await
      }
      if (follow === undefined) {
        yield* pageNode(pipeline, node, reference)
        if (pipeline.stopped || inspection === undefined || !isTerminalStatus(inspection.status)) return
        node.status = settledStatus(inspection.status)
        pipeline.dirty = true
        wake(pipeline)
        return
      }
      if (inspection === undefined || !isTerminalStatus(inspection.status)) caught(pipeline, node)
      while (!pipeline.stopped) {
        const before = node.cursor
        const delivered = new Set<string>()
        node.resumed = node.cursor !== undefined
        const result = yield* follow(
          node.executionId,
          node.cursor,
          (event) => {
            delivered.add(event.cursor)
            accept(pipeline, node, event)
          },
          reference,
          "execution",
        )
        for (const event of result.events) if (!delivered.has(event.cursor)) accept(pipeline, node, event)
        if (pipeline.stopped) return
        if (isTerminalStatus(result.status)) {
          node.status = settledStatus(result.status)
          pipeline.dirty = true
          wake(pipeline)
          return
        }
        if (node.cursor === before) return
      }
    })

  release = (pipeline, root) => {
    const held = pipeline.delivered
    if (held === undefined) return
    pipeline.delivered = undefined
    for (const event of held.toSorted((left, right) => left.sequence - right.sequence)) accept(pipeline, root, event)
  }

  startNode = (pipeline, node) => {
    pipeline.active += 1
    pipeline.reading += 1
    pipeline.fork(
      followNode(pipeline, node).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.suspend(() => {
                const message = String(Cause.squash(cause))
                if (!message.includes("ExecutionNotFound")) fail(pipeline, node, "backend", message)
                return Effect.logWarning("execution.ingest.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": String(pipeline.threadId),
                    "rika.turn.id": String(pipeline.turnId),
                    "rika.execution.id": node.executionId,
                    "rika.failure.cause": message,
                  }),
                )
              }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (node.parentKey === undefined) release(pipeline, node)
            caught(pipeline, node)
            return commit(pipeline)
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            pipeline.active -= 1
            return pipeline.active > 0
              ? Effect.void
              : Deferred.succeed(pipeline.finished, undefined).pipe(Effect.asVoid)
          }),
        ),
      ),
    )
  }

  const drive = (pipeline: Pipeline, pipelineScope: Scope.Closeable) =>
    Effect.gen(function* () {
      const committing = yield* Effect.forkChild(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.raceFirst(Effect.sleep(commitWindow), Queue.take(pipeline.wake))
            yield* commit(pipeline)
          }
        }),
      )
      pipeline.active += 1
      pipeline.reading += 1
      const restored = pipeline.order.slice()
      for (const key of restored) {
        const node = pipeline.nodes.get(key)
        if (node !== undefined && (key === pipeline.rootKey || node.status === undefined)) startNode(pipeline, node)
      }
      pipeline.reading -= 1
      if (pipeline.reading <= 0) wake(pipeline)
      pipeline.active -= 1
      if (pipeline.active <= 0) yield* Deferred.succeed(pipeline.finished, undefined)
      yield* Effect.raceFirst(Deferred.await(pipeline.finished), pipeline.abandoned.await)
      yield* Fiber.interrupt(committing)
      yield* commit(pipeline)
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (pipelines.get(String(pipeline.turnId)) === pipeline) pipelines.delete(String(pipeline.turnId))
          pipeline.rootCommitted.openUnsafe()
          if (pipeline.refolding)
            options.onRefold?.({ threadId: pipeline.threadId, rootTurnId: pipeline.turnId, phase: "finished" })
          return Effect.forEach(
            pipeline.failures,
            (failure) =>
              Effect.logWarning("execution.ingest.stopped").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": failure.threadId,
                  "rika.turn.id": failure.turnId,
                  "rika.execution.id": failure.executionId,
                  "rika.ingest.reason": failure.reason,
                  "rika.failure.cause": failure.message,
                }),
              ),
            { discard: true },
          ).pipe(Effect.andThen(Scope.close(pipelineScope, Exit.void)))
        }),
      ),
    )

  const ensure = Effect.fn("ExecutionIngest.ensure")(function* (root: Root) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const live = pipelines.get(String(root.turnId))
        const turn = yield* options.turns.get(root.turnId).pipe(Effect.orElseSucceed(() => undefined))
        if (live !== undefined) {
          if (!live.catchUp && turn !== undefined && isTerminalStatus(turn.status)) live.rootSettled.openUnsafe()
          if (turn?.status === "cancelled") live.abandoned.openUnsafe()
          return
        }
        if (turn === undefined || turn.status === "queued") return
        const stored = yield* options.transcripts.get(root.turnId).pipe(Effect.orElseSucceed(() => undefined))
        const restored = restore(turn, stored)
        if (isTerminalStatus(turn.status) && fullyConsumed(restored.nodes)) return
        const pipelineScope = yield* Scope.make()
        const pipeline: Pipeline = {
          threadId: root.threadId,
          turnId: root.turnId,
          rootKey: Transcript.executionKey(String(root.turnId)),
          nodes: restored.nodes,
          order: restored.order,
          finished: yield* Deferred.make<void>(),
          rootSettled: Latch.makeUnsafe(false),
          rootCommitted: Latch.makeUnsafe(false),
          abandoned: Latch.makeUnsafe(false),
          wake: yield* Queue.bounded<void>(1),
          committing: yield* Semaphore.make(1),
          catchUp: isTerminalStatus(turn.status),
          refolding: stored !== undefined && stored.projectionVersion < projectionVersion,
          failures: [],
          fork: () => undefined,
          turn,
          revision: stored?.revision ?? -1,
          active: 0,
          pending: 0,
          dirty: stored === undefined,
          reconciled: stored?.childTreeReconciled === true,
          stopped: false,
          reading: 0,
          delivered: isTerminalStatus(turn.status) ? undefined : [],
        }
        pipeline.fork = yield* FiberSet.makeRuntime<never, void, never>().pipe(
          Effect.provideService(Scope.Scope, pipelineScope),
        )
        pipelines.set(String(root.turnId), pipeline)
        if (pipeline.refolding)
          options.onRefold?.({ threadId: root.threadId, rootTurnId: root.turnId, phase: "started" })
        yield* Effect.forkIn(
          drive(pipeline, pipelineScope).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("execution.ingest.failed").pipe(
                    Effect.annotateLogs({
                      "rika.thread.id": String(root.threadId),
                      "rika.turn.id": String(root.turnId),
                      "rika.failure.cause": Cause.pretty(cause),
                    }),
                  ),
            ),
          ),
          ownerScope,
        )
      }),
    )
  })

  return {
    ensure,
    deliver: (turnId, event) => {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline === undefined) return
      if (pipeline.delivered !== undefined) {
        pipeline.delivered.push(event)
        return
      }
      accept(pipeline, pipeline.nodes.get(pipeline.rootKey)!, event)
    },
    consumed: Effect.fn("ExecutionIngest.consumed")(function* (turnId: Turn.TurnId) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) yield* pipeline.rootCommitted.await
    }),
    settled: Effect.fn("ExecutionIngest.settled")(function* (turnId: Turn.TurnId) {
      const pipeline = pipelines.get(String(turnId))
      if (pipeline !== undefined) yield* Deferred.await(pipeline.finished)
    }),
  } satisfies Interface
})
