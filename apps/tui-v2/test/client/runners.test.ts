import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { makeRunnerClient } from "@rika/client/runner"
import type { ThreadMetadata } from "@rika/client/product"
import { ProductClientError } from "@rika/client/product"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import { Deferred, Effect, Fiber } from "effect"
import type { PreparedInstallation } from "../../src/client/installation"
import { runnerSupervisor, type RunnerSupervisorOptions } from "../../src/client/runners"

const installation: PreparedInstallation = {
  deviceId: "device",
  workspacePath: "/workspace",
  checkoutFingerprint: "checkout",
  workspaceIdentity: "runner:workspace",
  profile: {
    protocolVersion: 2,
    workspaceIdentity: "runner:workspace",
    repository: { identity: "repository" },
    nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0", trustMode: "trusted-local" },
    capabilities: { nativeTools: true, checkpoints: false, pty: false },
  },
}

interface RunnerBindingWire {
  readonly workspaceId: string
  readonly assignmentId: string
  readonly generation: number
  readonly placement: {
    readonly _tag: "Runner"
    readonly workspaceId: string
    readonly checkoutFingerprint: string
  }
  readonly buildId: string
  readonly protocolVersion: number
}

const binding = (overrides: Partial<RunnerBindingWire> = {}): RunnerBindingWire => ({
  workspaceId: installation.workspaceIdentity,
  assignmentId: "assignment",
  generation: 1,
  placement: {
    _tag: "Runner",
    workspaceId: installation.workspaceIdentity,
    checkoutFingerprint: installation.checkoutFingerprint,
  },
  buildId: currentExecutorPolicy.buildId,
  protocolVersion: currentExecutorPolicy.protocolVersion,
  ...overrides,
})

const runnerClient = (read: () => RunnerBindingWire) =>
  makeRunnerClient({
    baseUrl: "https://rika.test",
    transport: {
      request: () =>
        Effect.succeed(new Response(JSON.stringify(read()), { headers: { "content-type": "application/json" } })),
    },
    requestHeaders: () => Effect.succeed({}),
  })

const runnerThread = (id: string): ThreadMetadata => ({ id, title: id, target: "runner" })
const boxThread = (id: string): ThreadMetadata => ({ id, title: id, target: "orb" })

const unexpectedConnect = (): globalThis.WebSocket => {
  throw new Error("The scripted Runner daemon must not open a WebSocket")
}

const awaitCondition = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die("condition did not become true")
  })

type StartDaemon = NonNullable<RunnerSupervisorOptions["startDaemon"]>

const daemonFixture = (threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const readiness = new Map<string, Deferred.Deferred<void>>()
    for (const threadId of threadIds) readiness.set(threadId, yield* Deferred.make<void>())
    const started: string[] = []
    const active = new Set<string>()
    const stopped: string[] = []
    const gateFor = (threadId: string) => {
      const gate = readiness.get(threadId)
      return gate === undefined ? Effect.die(`No readiness gate exists for ${threadId}`) : Effect.succeed(gate)
    }
    const startDaemon: StartDaemon = (options) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            started.push(options.threadId)
          })
          yield* Deferred.await(yield* gateFor(options.threadId))
          if (options.onReady !== undefined) yield* options.onReady
          yield* Effect.sync(() => {
            active.add(options.threadId)
          })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              active.delete(options.threadId)
              stopped.push(options.threadId)
            }),
          )
          return yield* Effect.never
        }),
      )
    const release = Effect.fn("TuiV2.RunnersTest.release")(function* (threadId: string) {
      yield* Deferred.succeed(yield* gateFor(threadId), undefined)
    })
    return { active, release, startDaemon, started, stopped }
  })

it.layer(BunServices.layer)((test) => {
  test.effect("waits for authenticated Runner readiness before initial and subsequent selections continue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* daemonFixture(["first", "second"])
        const supervisor = yield* runnerSupervisor({
          installation,
          client: runnerClient(() => binding()),
          connect: unexpectedConnect,
          startDaemon: daemon.startDaemon,
        })
        let firstSelected = false
        const first = yield* supervisor.ensure(runnerThread("first")).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              firstSelected = true
            }),
          ),
          Effect.forkChild,
        )
        yield* awaitCondition(() => daemon.started.includes("first"))
        expect(firstSelected).toBe(false)
        yield* daemon.release("first")
        yield* Fiber.join(first)
        expect(firstSelected).toBe(true)

        let secondSelected = false
        const second = yield* supervisor.ensure(runnerThread("second")).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              secondSelected = true
            }),
          ),
          Effect.forkChild,
        )
        yield* awaitCondition(() => daemon.started.includes("second"))
        expect(secondSelected).toBe(false)
        yield* daemon.release("second")
        yield* Fiber.join(second)
        expect(secondSelected).toBe(true)
      }),
    ),
  )

  test.effect(
    "does not start a daemon for Box Threads and shares one live Runner daemon across duplicate selection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* daemonFixture(["runner"])
          const supervisor = yield* runnerSupervisor({
            installation,
            client: runnerClient(() => binding()),
            connect: unexpectedConnect,
            startDaemon: daemon.startDaemon,
          })
          yield* supervisor.ensure(boxThread("box"))
          expect(daemon.started).toEqual([])

          const first = yield* supervisor.ensure(runnerThread("runner")).pipe(Effect.forkChild)
          const second = yield* supervisor.ensure(runnerThread("runner")).pipe(Effect.forkChild)
          yield* awaitCondition(() => daemon.started.length === 1)
          expect(daemon.started).toEqual(["runner"])
          yield* daemon.release("runner")
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(daemon.started).toEqual(["runner"])
        }),
      ),
  )

  test.effect(
    "keeps prior Runner work alive after switching Threads and closes every owned scope at application shutdown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* daemonFixture(["first", "second"])
          const supervisor = yield* runnerSupervisor({
            installation,
            client: runnerClient(() => binding()),
            connect: unexpectedConnect,
            startDaemon: daemon.startDaemon,
          })
          const first = yield* supervisor.ensure(runnerThread("first")).pipe(Effect.forkChild)
          yield* awaitCondition(() => daemon.started.includes("first"))
          yield* daemon.release("first")
          yield* Fiber.join(first)
          expect(daemon.active.has("first")).toBe(true)

          const second = yield* supervisor.ensure(runnerThread("second")).pipe(Effect.forkChild)
          yield* awaitCondition(() => daemon.started.includes("second"))
          yield* daemon.release("second")
          yield* Fiber.join(second)
          expect(daemon.active.has("first")).toBe(true)
          expect(daemon.stopped).toEqual([])

          yield* supervisor.dispose
          yield* awaitCondition(() => daemon.stopped.length === 2)
          expect(new Set(daemon.stopped)).toEqual(new Set(["first", "second"]))
          const closed = yield* Effect.flip(supervisor.ensure(runnerThread("third")))
          expect(closed).toMatchObject({ kind: "closed", operation: "runner.ensure" })
        }),
      ),
  )

  test.effect("bounds retained Runner daemons before starting an overflow Thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* daemonFixture(["first"])
        const supervisor = yield* runnerSupervisor({
          installation,
          client: runnerClient(() => binding()),
          connect: unexpectedConnect,
          maxThreads: 1,
          startDaemon: daemon.startDaemon,
        })
        const first = yield* supervisor.ensure(runnerThread("first")).pipe(Effect.forkChild)
        yield* awaitCondition(() => daemon.started.includes("first"))
        yield* daemon.release("first")
        yield* Fiber.join(first)
        const overflow = yield* Effect.flip(supervisor.ensure(runnerThread("second")))
        expect(overflow).toMatchObject({ kind: "conflict", operation: "runner.ensure" })
        expect(daemon.started).toEqual(["first"])
      }),
    ),
  )

  test.effect("fails changed bindings before daemon startup and retains terminal daemon failure on reselection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* daemonFixture(["changed"])
        const mismatched = yield* runnerSupervisor({
          installation,
          client: runnerClient(() => binding({ workspaceId: "other-workspace" })),
          connect: unexpectedConnect,
          startDaemon: changed.startDaemon,
        })
        const bindingFailure = yield* Effect.flip(mismatched.ensure(runnerThread("changed")))
        expect(bindingFailure).toMatchObject({ operation: "runner.binding", kind: "protocol" })
        expect(changed.started).toEqual([])
        const repeatedBindingFailure = yield* Effect.flip(mismatched.ensure(runnerThread("changed")))
        expect(repeatedBindingFailure).toEqual(bindingFailure)
        expect(changed.started).toEqual([])

        const failureGate = yield* Deferred.make<void>()
        const failedStarts: string[] = []
        const terminalDaemon: StartDaemon = (options) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              failedStarts.push(options.threadId)
            })
            if (options.onReady !== undefined) yield* options.onReady
            yield* Deferred.await(failureGate)
            return yield* ProductClientError.make({ kind: "forbidden", message: "Runner enrollment was revoked" })
          })
        const retained = yield* runnerSupervisor({
          installation,
          client: runnerClient(() => binding()),
          connect: unexpectedConnect,
          startDaemon: terminalDaemon,
        })
        yield* retained.ensure(runnerThread("retained"))
        yield* Deferred.succeed(failureGate, undefined)
        yield* awaitCondition(() => failedStarts.length === 1)
        let retainedFailed = false
        for (let attempt = 0; attempt < 1_000; attempt += 1) {
          const result = yield* Effect.result(retained.ensure(runnerThread("retained")))
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({ kind: "forbidden", operation: "runner.daemon" })
            retainedFailed = true
            break
          }
          yield* Effect.yieldNow
        }
        if (!retainedFailed) return yield* Effect.die("retained daemon did not report its terminal failure")
        expect(failedStarts).toEqual(["retained"])
      }),
    ),
  )
})
