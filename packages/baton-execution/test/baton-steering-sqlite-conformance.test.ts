import { expect, it } from "@effect/vitest"
import { Errors, RunStore, RunTree, Runtime } from "tenetkit/runtime"
import { Context, Effect, Layer, Random, Stream } from "effect"
import { configure, makeResolver } from "../src/baton-route"
import { laneExecutionRoute, makeLaneModels } from "../src/baton-test-harness"

const kernel = (dataRoot: string) => ({ runtimeVersion: Bun.version, dataRoot })

const runtimeLayer = (filename: string, models: Effect.Success<ReturnType<typeof makeLaneModels>>) =>
  Runtime.layerSqlite({
    filename,
    resolver: makeResolver({ kernel: kernel("/tmp"), modelServices: models.registryLayer }),
    addresses: [],
    scheduler: { concurrency: 0 },
  })

const start = (runtime: Runtime.Interface, configured: Effect.Success<ReturnType<typeof configure>>, key: string) =>
  runtime.start({
    executable: configured.executable,
    registrations: configured.registrations,
    sessionId: `session:${key}`,
    idempotencyKey: `run:${key}`,
    prompt: `start ${key}`,
  })

const terminalTag = {
  completed: "RunCompleted",
  failed: "RunFailed",
  cancelled: "RunCancelled",
} as const

it.live(
  "proves SQLite steering admission, consumption, terminal disposition, replay, and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const models = yield* makeLaneModels([])
        const configured = yield* configure({
          executionRoute: laneExecutionRoute(),
          workspace: "/tmp",
          kernel: kernel("/tmp"),
          modelServices: models.registryLayer,
        })
        const filename = `/tmp/rika-baton-steering-conformance-${yield* Random.nextInt}.db`

        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(runtimeLayer(filename, models))
            const runtime = Context.get(context, Runtime.Runtime)
            const store = Context.get(context, RunStore.RunStore)

            for (const reason of ["completed", "failed", "cancelled"] as const) {
              const run = yield* start(runtime, configured, `discard:${reason}`)
              const checkpoint = (yield* runtime.inspectTree(run.runId)).cursor
              const first = yield* runtime.steer({
                runId: run.runId,
                idempotencyKey: `steer:${reason}:first`,
                prompt: "duplicate",
              })
              const second = yield* runtime.steer({
                runId: run.runId,
                idempotencyKey: `steer:${reason}:second`,
                prompt: "duplicate",
              })
              expect(second.entryId).not.toBe(first.entryId)
              expect(
                yield* runtime.steer({
                  runId: run.runId,
                  idempotencyKey: `steer:${reason}:first`,
                  prompt: "duplicate",
                }),
              ).toEqual(first)
              expect(
                yield* Effect.result(
                  runtime.steer({
                    runId: run.runId,
                    idempotencyKey: `steer:${reason}:first`,
                    prompt: "conflicting",
                  }),
                ),
              ).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "tenetkit/runtime/SteeringConflict" },
              })

              if (reason === "cancelled") {
                yield* runtime.cancel({ runId: run.runId, reason: "cancelled by conformance test" })
              } else {
                const claim = yield* store.claimExecution({ runId: run.runId, ownerId: `owner:${reason}` })
                if (reason === "completed") {
                  yield* store.complete({ ...claim, result: { _tag: "Program", value: "done" } })
                } else {
                  yield* store.fail({
                    ...claim,
                    error: Errors.AgentExecutionFailure.make({ message: "expected failure" }),
                  })
                }
              }

              const history = yield* runtime.history({ runId: run.runId, limit: 100 })
              const discardedIndex = history.findIndex((event) => event._tag === "SteeringDiscarded")
              const terminalIndex = history.findIndex((event) => event._tag === terminalTag[reason])
              expect(discardedIndex).toBeGreaterThan(-1)
              expect(discardedIndex).toBeLessThan(terminalIndex)
              expect(history[discardedIndex]).toMatchObject({
                _tag: "SteeringDiscarded",
                entryIds: [first.entryId, second.entryId],
                reason,
              })
              expect(
                yield* Effect.result(
                  runtime.steer({
                    runId: run.runId,
                    idempotencyKey: `steer:${reason}:terminal`,
                    prompt: "too late",
                  }),
                ),
              ).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "tenetkit/runtime/RunTerminal" },
              })

              for (const settlement of ["root-blocked", "tree-terminal"] as const) {
                const replay = yield* RunTree.watch({
                  rootRunId: run.runId,
                  cursor: checkpoint,
                  settlement,
                }).pipe(Stream.provideService(Runtime.Runtime, runtime), Stream.runCollect)
                expect(Array.from(replay, ({ event }) => event._tag)).toEqual([
                  "SteeringAccepted",
                  "SteeringAccepted",
                  ...(reason === "cancelled" ? ["RunCancellationRequested"] : []),
                  "SteeringDiscarded",
                  terminalTag[reason],
                ])
              }
            }
          }),
        )

        let runId = ""
        let checkpoint: RunTree.TreeCursor | undefined
        let accepted: Runtime.SteeringReceipt | undefined
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(runtimeLayer(filename, models))
            const runtime = Context.get(context, Runtime.Runtime)
            const run = yield* start(runtime, configured, "restart-consume")
            runId = run.runId
            checkpoint = (yield* runtime.inspectTree(run.runId)).cursor
            accepted = yield* runtime.steer({
              runId,
              idempotencyKey: "steer:restart-consume",
              prompt: "survive restart",
            })
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(runtimeLayer(filename, models))
            const runtime = Context.get(context, Runtime.Runtime)
            const store = Context.get(context, RunStore.RunStore)
            expect(
              yield* runtime.steer({
                runId,
                idempotencyKey: "steer:restart-consume",
                prompt: "survive restart",
              }),
            ).toEqual(accepted)
            const claim = yield* store.claimExecution({ runId, ownerId: "owner:restart" })
            const entries = yield* store.readSteering(claim)
            expect(entries).toHaveLength(1)
            expect(entries[0]).toMatchObject(accepted!)
            const operation = yield* store.recordOperation({
              ...claim,
              operationKey: "model:restart-consume",
              kind: "model",
              inputDigest: "model:restart-consume",
              input: { prompt: "survive restart" },
              replayPolicy: "provider-idempotent",
              attempt: claim.attemptFence,
              steeringEntryIds: entries.map((entry) => entry.entryId),
            })
            expect(yield* store.readSteering(claim)).toEqual([])
            yield* store.completeOperation({
              ...claim,
              operationId: operation.operationId,
              outcome: { _tag: "Succeeded", value: "continued" },
            })
            yield* store.complete({ ...claim, result: { _tag: "Program", value: "done" } })

            const replay = yield* RunTree.watch({
              rootRunId: runId,
              cursor: checkpoint!,
            }).pipe(Stream.provideService(Runtime.Runtime, runtime), Stream.runCollect)
            expect(Array.from(replay, ({ event }) => event._tag)).toEqual([
              "SteeringAccepted",
              "SteeringConsumed",
              "RunCompleted",
            ])
            expect(
              Array.from(replay, ({ event }) => event).find((event) => event._tag === "SteeringConsumed"),
            ).toMatchObject({ entryIds: [accepted!.entryId], operationId: operation.operationId })
          }),
        )
      }),
    ),
  30_000,
)
