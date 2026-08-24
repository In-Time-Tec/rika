import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { CellResponse, type CellRequest, type CellResponse as CellResponseValue } from "./protocol"

export class CellError extends Schema.TaggedError<CellError>()("CellError", {
  kind: Schema.Literals(["execution", "fenced", "workspace"]),
  message: Schema.String,
}) {}

export interface OutputChunk {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

export interface Options {
  readonly workspaceId: string
  readonly read: (operationKey: string) => Effect.Effect<State | undefined, CellError>
  readonly write: (operationKey: string, state: State) => Effect.Effect<void, CellError>
  readonly execute: (
    request: CellRequest,
    output: (chunk: OutputChunk) => Effect.Effect<void>,
  ) => Effect.Effect<CellResponse, CellError>
}

export interface Interface {
  readonly admit: (request: CellRequest) => Effect.Effect<void, CellError>
  readonly execute: (
    request: CellRequest,
    output?: (chunk: OutputChunk) => Effect.Effect<void>,
  ) => Effect.Effect<CellResponse, CellError>
  readonly cancel: (operationKey: string, attempt: number) => Effect.Effect<CellResponse, CellError>
}

export class Cells extends Context.Service<Cells, Interface>()("@rika/remote-execution/cells") {}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const State = Schema.Union([
  Schema.TaggedStruct("Running", { attempt: NonNegativeInt }),
  Schema.TaggedStruct("Completed", { attempt: NonNegativeInt, response: CellResponse }),
])
export type State = typeof State.Type

interface Entry {
  readonly operationKey: string
  readonly attempt: number
  readonly executionKey: string
  readonly initialization: Ref.Ref<"fresh" | "retained" | "completed" | undefined>
  readonly result: Deferred.Deferred<CellResponseValue, CellError>
  readonly winner: Ref.Ref<Exit.Exit<CellResponseValue, CellError> | undefined>
  readonly execution: Ref.Ref<Fiber.Fiber<CellResponseValue, CellError> | undefined>
  readonly executionStarted: Ref.Ref<boolean>
  readonly settlement: Semaphore.Semaphore
}

interface Registry {
  readonly entries: Map<string, Entry>
  readonly attempts: Map<string, number>
}

const unknown: CellResponseValue = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Cell operation outcome is unknown" },
}

const deadlineExceeded: CellResponseValue = {
  _tag: "DomainFailure",
  failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
}

const cancelled: CellResponseValue = {
  _tag: "DomainFailure",
  failure: { kind: "cancelled", message: "Cell operation cancelled" },
}

export const terminalOutcome = (response: CellResponseValue): "completed" | "cancelled" | "failed" => {
  if (response._tag === "Success") return "completed"
  if (
    response._tag === "DomainFailure" &&
    typeof response.failure === "object" &&
    response.failure !== null &&
    "kind" in response.failure &&
    response.failure.kind === "cancelled"
  )
    return "cancelled"
  return "failed"
}

export const layer = (options: Options): Layer.Layer<Cells> =>
  Layer.effect(
    Cells,
    Effect.gen(function* () {
      const registry = yield* Ref.make<Registry>({ entries: new Map(), attempts: new Map() })
      const executions = yield* FiberSet.make<CellResponseValue, CellError>()
      const interruptions = yield* FiberSet.make<void, never>()
      const commits = yield* FiberSet.make<void, never>()
      const interrupt = (fiber: Fiber.Fiber<CellResponseValue, CellError>) =>
        FiberSet.run(interruptions, Fiber.interrupt(fiber).pipe(Effect.asVoid)).pipe(Effect.asVoid)
      const entryFor = Effect.fn("Cells.entry")(function* (operationKey: string, attempt: number) {
        const initialization = yield* Ref.make<"fresh" | "retained" | "completed" | undefined>(undefined)
        const result = yield* Deferred.make<CellResponseValue, CellError>()
        const winner = yield* Ref.make<Exit.Exit<CellResponseValue, CellError> | undefined>(undefined)
        const execution = yield* Ref.make<Fiber.Fiber<CellResponseValue, CellError> | undefined>(undefined)
        const executionStarted = yield* Ref.make(false)
        const settlement = yield* Semaphore.make(1)
        const candidate: Entry = {
          operationKey,
          attempt,
          executionKey: `${operationKey}\u0000${attempt}`,
          initialization,
          result,
          winner,
          execution,
          executionStarted,
          settlement,
        }
        const entry = yield* Ref.modify(registry, (current) => {
          const successfulAttempt = current.attempts.get(operationKey)
          if (successfulAttempt !== undefined && attempt < successfulAttempt) return [undefined, current] as const
          const known = current.entries.get(candidate.executionKey)
          if (known !== undefined) return [known, current] as const
          return [
            candidate,
            { ...current, entries: new Map(current.entries).set(candidate.executionKey, candidate) },
          ] as const
        })
        if (entry === undefined)
          return yield* CellError.make({ kind: "fenced", message: "Cell operation attempt is stale" })
        return entry
      })
      const promote = (entry: Entry) =>
        Ref.update(registry, (current) => {
          const known = current.attempts.get(entry.operationKey)
          if (known !== undefined && known >= entry.attempt) return current
          return { ...current, attempts: new Map(current.attempts).set(entry.operationKey, entry.attempt) }
        })
      const initialize = (entry: Entry, create: boolean) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(entry.settlement.take(1))
            return yield* Effect.gen(function* () {
              const known = yield* Ref.get(entry.initialization)
              if (known !== undefined) return known
              const stored = yield* restore(options.read(entry.executionKey))
              if (stored !== undefined && stored.attempt !== entry.attempt)
                return yield* CellError.make({ kind: "fenced", message: "Cell operation attempt is stale" })
              if (stored?._tag === "Completed") {
                const completed = Exit.succeed(stored.response)
                yield* Ref.set(entry.winner, completed)
                yield* Deferred.done(entry.result, completed)
                yield* Ref.set(entry.initialization, "completed")
                yield* promote(entry)
                return "completed" as const
              }
              if (stored?._tag === "Running") {
                yield* Ref.set(entry.initialization, "retained")
                yield* promote(entry)
                return "retained" as const
              }
              if (!create)
                return yield* CellError.make({ kind: "fenced", message: "Cell cancellation has no durable operation" })
              yield* restore(options.write(entry.executionKey, { _tag: "Running", attempt: entry.attempt }))
              yield* Ref.set(entry.initialization, "fresh")
              yield* promote(entry)
              return "fresh" as const
            }).pipe(Effect.ensuring(entry.settlement.release(1).pipe(Effect.asVoid)))
          }),
        )
      const prepare = Effect.fn("Cells.prepare")(function* (request: CellRequest) {
        if (request.workspaceId !== options.workspaceId)
          return yield* CellError.make({ kind: "workspace", message: "Cell workspace does not match this executor" })
        const attempt = request.attempt ?? 0
        const entry = yield* entryFor(request.operationKey, attempt)
        const initialization = yield* initialize(entry, true)
        return { entry, initialization } as const
      })
      const choose = (entry: Entry, proposed: Exit.Exit<CellResponseValue, CellError>) =>
        Effect.uninterruptible(
          entry.settlement.withPermits(1)(
            Effect.gen(function* () {
              const selected = yield* Ref.modify(entry.winner, (current) =>
                current === undefined ? ([true, proposed] as const) : ([false, current] as const),
              )
              if (!selected) return false
              if (proposed._tag === "Failure") yield* Deferred.done(entry.result, proposed)
              else
                yield* FiberSet.run(
                  commits,
                  options
                    .write(entry.executionKey, {
                      _tag: "Completed",
                      attempt: entry.attempt,
                      response: proposed.value,
                    })
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: "5 seconds",
                        orElse: () =>
                          CellError.make({ kind: "execution", message: "Cell terminal persistence deadline exceeded" }),
                      }),
                      Effect.as(proposed.value),
                      Effect.exit,
                      Effect.flatMap((committed) => Deferred.done(entry.result, committed)),
                      Effect.onInterrupt(() =>
                        Deferred.fail(
                          entry.result,
                          CellError.make({ kind: "execution", message: "Cell terminal persistence was interrupted" }),
                        ).pipe(Effect.asVoid),
                      ),
                      Effect.asVoid,
                    ),
                )
              return true
            }),
          ),
        )
      const admit: Interface["admit"] = Effect.fn("Cells.admit")(function* (request) {
        yield* prepare(request)
      })
      const execute: Interface["execute"] = Effect.fn("Cells.execute")(function* (request, output = () => Effect.void) {
        const { entry, initialization } = yield* prepare(request)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const starts = yield* Ref.modify(entry.executionStarted, (current) => [!current, true] as const)
            if (!starts || initialization === "completed" || (yield* Ref.get(entry.winner)) !== undefined)
              return yield* restore(Deferred.await(entry.result))
            const resolved = yield* Effect.exit(
              restore(
                initialization === "retained"
                  ? Effect.succeed(unknown)
                  : Effect.gen(function* () {
                      const remaining = Math.max(
                        0,
                        DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt)) -
                          (yield* Clock.currentTimeMillis),
                      )
                      if (remaining === 0) return deadlineExceeded
                      const execution = yield* FiberSet.run(
                        executions,
                        options.execute(request, output).pipe(
                          Effect.catchCause((cause) =>
                            Cause.hasInterruptsOnly(cause)
                              ? Effect.failCause(cause)
                              : Effect.succeed<CellResponseValue>({
                                  _tag: "DomainFailure",
                                  failure: { kind: "execution", message: "Cell execution failed" },
                                }),
                          ),
                        ),
                      )
                      yield* Ref.set(entry.execution, execution)
                      if ((yield* Ref.get(entry.winner)) !== undefined) yield* interrupt(execution)
                      return yield* Fiber.join(execution).pipe(
                        Effect.timeoutOption(remaining),
                        Effect.flatMap((completed) =>
                          completed._tag === "Some"
                            ? Effect.succeed(completed.value)
                            : interrupt(execution).pipe(Effect.as(deadlineExceeded)),
                        ),
                        Effect.onInterrupt(() => interrupt(execution)),
                      )
                    }),
              ),
            )
            yield* choose(entry, resolved)
            return yield* restore(Deferred.await(entry.result))
          }),
        )
      })
      const cancel: Interface["cancel"] = Effect.fn("Cells.cancel")(function* (operationKey, attempt) {
        const entry = yield* entryFor(operationKey, attempt)
        yield* initialize(entry, false)
        const won = yield* choose(entry, Exit.succeed(cancelled))
        if (won) {
          const execution = yield* Ref.get(entry.execution)
          if (execution !== undefined) yield* interrupt(execution)
        }
        return yield* Deferred.await(entry.result)
      })
      return Cells.of({ admit, execute, cancel })
    }),
  )
