import { expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { HostedWorkerListener } from "../../src/hosted/worker-listener"
import {
  HostedWorkerRuntime,
  layer as hostedWorkerRuntimeLayer,
  type HostedWorkerControl,
  type WorkerDomain,
} from "../../src/hosted/worker-runtime"

const eventually = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.yieldNow
    }
    return yield* Effect.die("Expected hosted worker state was not observed")
  })

const listenerHarness = () => {
  let onNotify: (payload: string) => void = () => undefined
  let onListen: () => void = () => undefined
  let committed = false
  let closed = false
  const listener = HostedWorkerListener.of({
    listen: (_channel, notify, listening) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          onNotify = notify
          onListen = listening
          committed = true
          onListen()
        }),
        () =>
          Effect.sync(() => {
            closed = true
          }),
      ),
  })
  return {
    layer: Layer.succeed(HostedWorkerListener, listener),
    notify: (domain: WorkerDomain) => onNotify(domain),
    reconnect: () => onListen(),
    committed: () => committed,
    closed: () => closed,
  }
}

const increment = (ref: Ref.Ref<number>) => Ref.modify(ref, (value) => [value + 1, value + 1])

it.effect("starts after LISTEN, coalesces targeted wakeups, reconnects, and falls back to a durable scan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const listener = listenerHarness()
      const context = yield* Layer.build(hostedWorkerRuntimeLayer.pipe(Layer.provide(listener.layer)))
      const runtime = Context.get(context, HostedWorkerRuntime)
      const commandScans = yield* Ref.make(0)
      const turnScans = yield* Ref.make(0)
      const register = (domain: WorkerDomain, scans: Ref.Ref<number>) =>
        runtime.register({
          domain,
          concurrency: 1,
          fallbackIntervalMillis: 100,
          scanFailureMessage: `${domain} scan failed`,
          executionFailureMessage: `${domain} execution failed`,
          scan: () =>
            Effect.gen(function* () {
              expect(listener.committed()).toBe(true)
              yield* increment(scans)
              return { oldestRunnableAt: undefined }
            }),
        })
      const command = yield* register("command", commandScans)
      const turn = yield* register("turn", turnScans)

      yield* eventually(Ref.get(commandScans), (count) => count === 1)
      yield* eventually(Ref.get(turnScans), (count) => count === 1)
      yield* command.ready
      yield* turn.ready

      yield* Effect.sync(() => {
        for (let duplicate = 0; duplicate < 100; duplicate += 1) listener.notify("command")
      })
      yield* eventually(Ref.get(commandScans), (count) => count === 2)
      expect(yield* Ref.get(turnScans)).toBe(1)

      yield* Effect.sync(listener.reconnect)
      yield* eventually(Ref.get(commandScans), (count) => count === 3)
      yield* eventually(Ref.get(turnScans), (count) => count === 2)
      expect((yield* command.status).wakeup).toMatchObject({ _tag: "Ready", connections: 2 })

      yield* Effect.yieldNow
      yield* TestClock.adjust(100)
      yield* eventually(Ref.get(commandScans), (count) => count === 4)
      yield* eventually(Ref.get(turnScans), (count) => count === 3)
      expect((yield* command.status).lastFallbackAt).toBeDefined()
    }),
  ),
)

it.effect("bounds saturation and interrupts active work on scoped shutdown", () =>
  Effect.gen(function* () {
    const listener = listenerHarness()
    const ownerScope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(
      hostedWorkerRuntimeLayer.pipe(Layer.provide(listener.layer)),
      ownerScope,
    )
    const runtime = Context.get(context, HostedWorkerRuntime)
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const interrupted = yield* Ref.make<ReadonlyArray<string>>([])
    const work = (key: string) =>
      Ref.update(started, (keys) => [...keys, key]).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Ref.update(interrupted, (keys) => [...keys, key])),
      )
    const scan = (control: HostedWorkerControl) =>
      Effect.gen(function* () {
        let oldestRunnableAt: number | undefined
        for (const candidate of [
          { key: "first", runnableAt: 1 },
          { key: "second", runnableAt: 2 },
          { key: "third", runnableAt: 3 },
        ]) {
          if (yield* control.isActive(candidate.key)) continue
          if (!(yield* control.start({ ...candidate, effect: work(candidate.key) })))
            oldestRunnableAt ??= candidate.runnableAt
        }
        return { oldestRunnableAt }
      })
    const worker = yield* runtime.register({
      domain: "projection",
      concurrency: 2,
      fallbackIntervalMillis: 30_000,
      scanFailureMessage: "scan failed",
      executionFailureMessage: "execution failed",
      scan,
    })

    yield* eventually(Ref.get(started), (keys) => keys.length === 2)
    expect(yield* worker.status).toMatchObject({
      active: 2,
      capacity: 2,
      availableCapacity: 0,
      oldestActiveAt: 1,
      oldestRunnableAt: 3,
    })
    expect(yield* Ref.get(started)).toEqual(["first", "second"])

    yield* Scope.close(ownerScope, Exit.void)
    expect((yield* Ref.get(interrupted)).toSorted()).toEqual(["first", "second"])
    expect(listener.closed()).toBe(true)
  }),
)
