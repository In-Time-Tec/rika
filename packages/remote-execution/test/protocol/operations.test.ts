import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Ref, Scope } from "effect"
import type { CellResponse, CellRequest, MachineOutcome, Target } from "../../src/protocol/messages"
import * as Operations from "../../src/protocol/operations"

type AdapterTarget = Target

interface HarnessOptions {
  readonly access?: Ref.Ref<CellRequest["access"]>
  readonly receipts?: Ref.Ref<Operations.ReceiptMap>
  readonly executeCount?: Ref.Ref<number>
  readonly execute?: (
    output: Parameters<Operations.PreparedCell["execute"]>[0],
  ) => Effect.Effect<CellResponse, Operations.OperationError>
  readonly machine?: Effect.Effect<MachineOutcome, Operations.OperationError>
  readonly emit?: (event: Operations.Event) => Effect.Effect<void, Operations.OperationError>
}

const currentAccess = (target: AdapterTarget, leaseEpoch = 1): CellRequest["access"] => ({
  version: 1,
  fence: {
    target,
    assignmentId: `assignment-${target}`,
    assignmentGeneration: 1,
    instanceId: `instance-${target}`,
    executorId: `executor-${target}`,
    processIncarnation: `process-${target}`,
  },
  leaseEpoch,
  sessionToken: `session-${target}`,
})

const cellRequest = (access: CellRequest["access"], operationKey = "operation-1", attempt = 0): CellRequest => ({
  access,
  operationKey,
  workspaceId: "workspace-1",
  sessionId: "session-1",
  threadId: "thread-1",
  turnId: "turn-1",
  runId: "run-1",
  rootRunId: "run-1",
  toolCallId: `call-${operationKey}`,
  code: "run()",
  attempt,
  replayPolicy: "never",
  admittedAt: null,
  deadlineAt: "2999-01-01T00:00:00.000Z",
  bindings: {
    digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    descriptors: [],
  },
})

const cancelled: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "cancelled", message: "Cell operation cancelled" },
}

const completed: CellResponse = { _tag: "Success", result: { value: "done" } }

const eventually = <A>(read: Effect.Effect<A | undefined>) => {
  const loop: Effect.Effect<A> = Effect.suspend(() =>
    read.pipe(
      Effect.flatMap((value) =>
        value === undefined ? Effect.yieldNow.pipe(Effect.andThen(loop)) : Effect.succeed(value),
      ),
    ),
  )
  return loop.pipe(
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die("operation conformance timed out") }),
  )
}

const makeHarness = (target: AdapterTarget, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const access = options.access ?? (yield* Ref.make(currentAccess(target)))
    const receipts = options.receipts ?? (yield* Ref.make<Operations.ReceiptMap>(new Map()))
    const executeCount = options.executeCount ?? (yield* Ref.make(0))
    const machineCount = yield* Ref.make(0)
    const replayCount = yield* Ref.make(0)
    const emitted = yield* Ref.make<ReadonlyArray<Operations.Event>>([])
    const grants = yield* Ref.make(new Set(["operation-1"]))
    const cancellation = yield* Deferred.make<void>()
    const grant = (operationKey: string) => Ref.update(grants, (current) => new Set(current).add(operationKey))
    const lifecycle = yield* Operations.make({
      access: Ref.get(access),
      receipts: {
        current: Ref.get(receipts),
        commit: (next) => Ref.set(receipts, next),
      },
      emit: (event) =>
        (options.emit?.(event) ?? Effect.void).pipe(
          Effect.andThen(Ref.update(emitted, (events) => [...events, event])),
        ),
      cell: {
        prepare: (request) =>
          Effect.gen(function* () {
            if (target === "orb") {
              const authorized = yield* Ref.modify(grants, (current) => {
                if (!current.has(request.operationKey)) return [false, current] as const
                const next = new Set(current)
                next.delete(request.operationKey)
                return [true, next] as const
              })
              if (!authorized)
                return yield* Operations.OperationError.make({
                  kind: "authorization",
                  message: "Cell request has no runtime authorization",
                })
            }
            return {
              secrets: target === "orb" ? ["exact-secret-value"] : [],
              execute: (output: Parameters<Operations.PreparedCell["execute"]>[0]) =>
                Ref.update(executeCount, (count) => count + 1).pipe(
                  Effect.andThen(options.execute?.(output) ?? Deferred.await(cancellation).pipe(Effect.as(cancelled))),
                ),
            }
          }),
        admit: () => Effect.void,
        cancel: () => Deferred.succeed(cancellation, undefined).pipe(Effect.as(cancelled)),
        replayBindings: () => Ref.update(replayCount, (count) => count + 1),
      },
      machine: {
        execute: () =>
          Ref.update(machineCount, (count) => count + 1).pipe(Effect.andThen(options.machine ?? Effect.never)),
      },
    })
    return { access, emitted, executeCount, grant, lifecycle, machineCount, receipts, replayCount }
  })

const terminalFor = (harness: Effect.Success<ReturnType<typeof makeHarness>>, operationKey = "operation-1") =>
  eventually(
    Ref.get(harness.receipts).pipe(
      Effect.map((receipts) =>
        receipts.get(Operations.executionKey(operationKey, 0))?.find((frame) => frame._tag === "Terminal"),
      ),
    ),
  )

for (const target of ["runner", "orb"] as const) {
  describe(`${target} operation adapter conformance`, () => {
    it.effect("deduplicates duplicate execute while replaying the durable lifecycle", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const harness = yield* makeHarness(target, {
            execute: () => Deferred.await(release).pipe(Effect.as(completed)),
          })
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* harness.grant(request.operationKey)
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          expect(yield* Ref.get(harness.executeCount)).toBe(1)
          expect(
            (yield* Ref.get(harness.emitted)).filter(
              (event) =>
                event._tag === "CellLifecycle" && event.frame.attribution.operationKey === request.operationKey,
            ).length,
          ).toBeGreaterThan(2)
          yield* Deferred.succeed(release, undefined)
          expect((yield* terminalFor(harness)).response).toEqual(completed)
        }),
      ),
    )

    it.effect("rejects stale access before admitting or persisting work", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(target)
          const current = currentAccess(target)
          const stale = [currentAccess(target, 2), { ...current, fence: { ...current.fence, assignmentGeneration: 2 } }]
          const results = yield* Effect.forEach(stale, (access, index) =>
            Effect.result(
              harness.lifecycle.dispatch({
                _tag: "CellExecute",
                request: cellRequest(access, `stale-operation-${index}`),
              }),
            ),
          )
          expect(results.map((result) => result._tag)).toEqual(["Failure", "Failure"])
          expect(results.map((result) => (result._tag === "Failure" ? result.failure.kind : undefined))).toEqual([
            "fenced",
            "fenced",
          ])
          expect(yield* Ref.get(harness.receipts)).toEqual(new Map())
          expect(yield* Ref.get(harness.executeCount)).toBe(0)
        }),
      ),
    )

    it.effect("replays with renewed access after reconnect and recovers the terminal result", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(target, { execute: () => Effect.succeed(completed) })
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          const terminal = yield* terminalFor(harness)
          const renewed = currentAccess(target, 2)
          yield* Ref.set(harness.access, renewed)
          yield* Ref.set(harness.emitted, [])
          yield* harness.lifecycle.dispatch({
            _tag: "CellReplay",
            access: renewed,
            operationKey: request.operationKey,
            attempt: request.attempt,
            afterCursor: 1,
          })
          const replayed = yield* Ref.get(harness.emitted)
          expect(replayed.map((event) => event.access)).toEqual(replayed.map(() => renewed))
          expect(replayed.filter((event) => event._tag === "CellLifecycle").map((event) => event.frame._tag)).toEqual([
            "Started",
            "Terminal",
          ])
          expect(yield* Ref.get(harness.replayCount)).toBe(1)
          yield* harness.lifecycle.dispatch({
            _tag: "CellTerminalReceipt",
            access: renewed,
            operationKey: request.operationKey,
            attempt: request.attempt,
            cursor: terminal.cursor,
          })
          expect((yield* Ref.get(harness.emitted)).at(-1)).toEqual({
            _tag: "CellResult",
            access: renewed,
            operationKey: request.operationKey,
            attempt: request.attempt,
            response: completed,
          })
        }),
      ),
    )

    it.effect("cancels an executing cell and persists one terminal response", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(target)
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* harness.lifecycle.dispatch({
            _tag: "CellCancel",
            access: request.access,
            operationKey: request.operationKey,
            attempt: request.attempt,
          })
          const terminal = yield* terminalFor(harness)
          expect(terminal.outcome).toBe("cancelled")
          expect(terminal.response).toEqual(cancelled)
          expect(
            (yield* Ref.get(harness.receipts))
              .get(Operations.executionKey(request.operationKey, request.attempt))
              ?.filter((frame) => frame._tag === "Terminal"),
          ).toHaveLength(1)
        }),
      ),
    )

    it.effect("deduplicates and interrupts child machines before cancellation terminal emission", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const machineInterrupted = yield* Deferred.make<void>()
          const cellInterrupted = yield* Deferred.make<void>()
          const harness = yield* makeHarness(target, {
            execute: () => Effect.never.pipe(Effect.ensuring(Deferred.succeed(cellInterrupted, undefined))),
            machine: Effect.never.pipe(Effect.ensuring(Deferred.succeed(machineInterrupted, undefined))),
            emit: (event) =>
              event._tag === "CellLifecycle" && event.frame._tag === "Terminal"
                ? Deferred.await(machineInterrupted)
                : Effect.void,
          })
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          const machine = {
            _tag: "MachineExecute" as const,
            access: request.access,
            operationKey: request.operationKey,
            attempt: request.attempt,
            machineId: "machine-1",
            requestDigest: "a".repeat(64),
            request: { _tag: "ProcessStop" as const, processId: "process-1" },
          }
          yield* harness.lifecycle.dispatch(machine)
          yield* eventually(
            Ref.get(harness.machineCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* harness.lifecycle.dispatch(machine)
          expect(yield* Ref.get(harness.machineCount)).toBe(1)
          yield* harness.lifecycle.dispatch({
            _tag: "CellCancel",
            access: request.access,
            operationKey: request.operationKey,
            attempt: request.attempt,
          })
          yield* Deferred.await(cellInterrupted)
          yield* Deferred.await(machineInterrupted)
          expect((yield* terminalFor(harness)).outcome).toBe("cancelled")
          yield* Ref.set(harness.emitted, [])
          yield* harness.lifecycle.dispatch({ ...machine, machineId: "machine-2" })
          expect((yield* Ref.get(harness.emitted)).at(-1)).toMatchObject({
            _tag: "MachineResult",
            machineId: "machine-2",
            outcome: { _tag: "Fenced", message: "Parent Cell is no longer running" },
          })
          expect(yield* Ref.get(harness.machineCount)).toBe(1)
        }),
      ),
    )

    it.effect("bounds and redacts durable output", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const secret = "exact-secret-value"
          const harness = yield* makeHarness(target, {
            execute: (output) =>
              Effect.forEach(
                Array.from({ length: 20 }),
                () => output({ stream: "stdout", text: `token='top-secret' ${secret} ${"x".repeat(20_000)}` }),
                { discard: true },
              ).pipe(Effect.as({ _tag: "Success", result: { secret } } as const)),
          })
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          const terminal = yield* terminalFor(harness)
          const frames = (yield* Ref.get(harness.receipts)).get(
            Operations.executionKey(request.operationKey, request.attempt),
          )
          const output = frames?.filter((frame) => frame._tag === "Output") ?? []
          expect(output).toHaveLength(16)
          expect(output.every((frame) => frame.text.length <= 16_384)).toBe(true)
          expect(output.every((frame) => frame.truncated && !frame.text.includes("top-secret"))).toBe(true)
          expect(output.every((frame) => frame.text.includes(secret))).toBe(target === "runner")
          expect(terminal.response).toEqual({
            _tag: "Success",
            result: { secret: target === "runner" ? secret : "REDACTED" },
          })
        }),
      ),
    )

    it.effect("recovers an interruption after terminal persistence but before emit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const terminalEmitStarted = yield* Deferred.make<void>()
          const operationScope = yield* Scope.make()
          const harness = yield* makeHarness(target, {
            execute: () => Effect.succeed(completed),
            emit: (event) =>
              event._tag === "CellLifecycle" && event.frame._tag === "Terminal"
                ? Deferred.succeed(terminalEmitStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          }).pipe(Effect.provideService(Scope.Scope, operationScope))
          const request = cellRequest(yield* Ref.get(harness.access))
          yield* harness.lifecycle.dispatch({ _tag: "CellExecute", request })
          yield* Deferred.await(terminalEmitStarted)
          yield* Scope.close(operationScope, Exit.void)
          const retained = (yield* Ref.get(harness.receipts)).get(
            Operations.executionKey(request.operationKey, request.attempt),
          )
          expect(retained?.at(-1)?._tag).toBe("Terminal")
          const recovered = yield* makeHarness(target, {
            access: harness.access,
            receipts: harness.receipts,
            executeCount: harness.executeCount,
          })
          yield* recovered.lifecycle.dispatch({ _tag: "CellExecute", request })
          yield* eventually(
            Ref.get(recovered.emitted).pipe(
              Effect.map((events) =>
                events.find((event) => event._tag === "CellLifecycle" && event.frame._tag === "Terminal"),
              ),
            ),
          )
          expect(yield* Ref.get(recovered.executeCount)).toBe(1)
        }),
      ),
    )
  })
}
