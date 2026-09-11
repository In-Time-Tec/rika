/* oxlint-disable effecttsgo/strict-effect-provide -- focused fixtures supply deterministic platform services at the boundary. */
import * as BunServices from "@effect/platform-bun/BunServices"
import { ProductClientError } from "@rika/client/product"
import { makeRunnerClient } from "@rika/client/runner"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import type { RunnerDaemonOptions } from "@rika/runner/daemon"
import type { PreparedInstallation } from "@rika/tui-v2/src/client/installation"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import { superviseRunnerAssignments } from "../../src/client/headless"

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

const bindingWire = {
  workspaceId: installation.workspaceIdentity,
  assignmentId: "as-1",
  generation: 1,
  placement: {
    _tag: "Runner",
    workspaceId: installation.workspaceIdentity,
    checkoutFingerprint: installation.checkoutFingerprint,
  },
  buildId: currentExecutorPolicy.buildId,
  protocolVersion: currentExecutorPolicy.protocolVersion,
}

const PollBody = Schema.Struct({
  supervisorId: Schema.String,
  activeAssignmentIds: Schema.Array(Schema.String),
})
type PollBody = typeof PollBody.Type

type PollResponseWire = {
  readonly claimed: boolean
  readonly assignment: {
    readonly assignmentId: string
    readonly threadId: string
    readonly workspaceId: string
    readonly resume: boolean
    readonly leaseExpiresAt: number | null
  } | null
}

const assignmentWire = (assignmentId: string, threadId: string) => ({
  assignmentId,
  threadId,
  workspaceId: installation.workspaceIdentity,
  resume: false,
  leaseExpiresAt: null,
})

const yieldUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (condition()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die("condition did not become true")
  })

const settle = Effect.gen(function* () {
  for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const jsonResponse = (body: PollResponseWire | typeof bindingWire) =>
  new Response(encodeJson(body), { headers: { "content-type": "application/json" } })

const readJson = (request: Request) => Effect.tryPromise(() => request.json())

const scriptedRunner = (respond: (poll: PollBody) => Effect.Effect<Response, ProductClientError>) => {
  const polls: Array<PollBody> = []
  const runner = makeRunnerClient({
    baseUrl: "https://rika.test",
    requestHeaders: () => Effect.succeed({}),
    transport: {
      request: (request) => {
        if (request.method !== "POST") return Effect.succeed(jsonResponse(bindingWire))
        return readJson(request).pipe(
          Effect.orDie,
          Effect.flatMap((body) =>
            Effect.gen(function* () {
              const poll = yield* Schema.decodeUnknownEffect(PollBody)(body).pipe(Effect.orDie)
              polls.push(poll)
              return yield* respond(poll)
            }),
          ),
        )
      },
    },
  })
  return { runner, polls }
}

it.effect("serves a claimed assignment and reports it active on the next poll", () =>
  Effect.gen(function* () {
    const serving = yield* Deferred.make<void>()
    const daemonOptions: Array<RunnerDaemonOptions> = []
    const { runner, polls } = scriptedRunner((poll) =>
      Effect.succeed(
        jsonResponse(
          poll.activeAssignmentIds.includes("as-1")
            ? { claimed: true, assignment: null }
            : { claimed: true, assignment: assignmentWire("as-1", "thread-1") },
        ),
      ),
    )
    const fiber = yield* Effect.scoped(
      superviseRunnerAssignments({
        runner,
        installation,
        supervisorId: "supervisor-1",
        startDaemon: (options) =>
          Effect.sync(() => {
            daemonOptions.push(options)
          }).pipe(
            Effect.andThen(options.onReady ?? Effect.void),
            Effect.andThen(Deferred.succeed(serving, undefined)),
            Effect.andThen(Effect.never),
          ),
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(serving)
    yield* yieldUntil(() => polls.length === 2)
    yield* Fiber.interrupt(fiber)

    expect(polls[0]?.activeAssignmentIds).toEqual([])
    expect(polls[0]?.supervisorId).toBe("supervisor-1")
    expect(polls[1]?.activeAssignmentIds).toEqual(["as-1"])
    expect(daemonOptions).toHaveLength(1)
    expect(daemonOptions[0]?.threadId).toBe("thread-1")
    expect(daemonOptions[0]?.checkout).toBe(installation.workspacePath)
    expect(daemonOptions[0]?.expected).toEqual({
      workspaceId: installation.workspaceIdentity,
      checkoutFingerprint: installation.checkoutFingerprint,
      buildId: currentExecutorPolicy.buildId,
      protocolVersion: currentExecutorPolicy.protocolVersion,
    })
    expect(yield* TestConsole.logLines).toContain("Serving Thread thread-1")
  }).pipe(Effect.provide(BunServices.layer)),
)

it.effect("drops a failed daemon so a later poll can readmit its assignment", () =>
  Effect.gen(function* () {
    const reserved = yield* Deferred.make<void>()
    let attempts = 0
    const { runner, polls } = scriptedRunner((poll) =>
      Effect.succeed(
        jsonResponse(
          poll.activeAssignmentIds.includes("as-1") || attempts >= 2
            ? { claimed: true, assignment: null }
            : { claimed: true, assignment: assignmentWire("as-1", "thread-1") },
        ),
      ),
    )
    const fiber = yield* Effect.scoped(
      superviseRunnerAssignments({
        runner,
        installation,
        supervisorId: "supervisor-1",
        startDaemon: (options) =>
          Effect.suspend(() => {
            attempts += 1
            if (attempts === 1)
              return Effect.fail(
                ProductClientError.make({ kind: "protocol", message: "assignment superseded", status: 409 }),
              )
            return (options.onReady ?? Effect.void).pipe(
              Effect.andThen(Deferred.succeed(reserved, undefined)),
              Effect.andThen(Effect.never),
            )
          }),
      }),
    ).pipe(Effect.forkChild)
    yield* yieldUntil(() => polls.length === 2)
    yield* settle
    yield* TestClock.adjust("3 seconds")
    yield* Deferred.await(reserved)
    yield* Fiber.interrupt(fiber)

    expect(attempts).toBe(2)
    expect(polls.some((poll, index) => index > 0 && poll.activeAssignmentIds.length === 0)).toBe(true)
    const lines = yield* TestConsole.logLines
    expect(lines).toContain("Stopped serving Thread thread-1: assignment superseded")
    expect(lines).toContain("Serving Thread thread-1")
  }).pipe(Effect.provide(BunServices.layer)),
)

it.effect("fails the run when the poll reports an unauthorized credential", () =>
  Effect.gen(function* () {
    const { runner } = scriptedRunner(() => Effect.succeed(new Response(null, { status: 401 })))
    const error = yield* Effect.flip(
      Effect.scoped(superviseRunnerAssignments({ runner, installation, supervisorId: "supervisor-1" })),
    )
    expect(error.operation).toBe("Runner")
    expect(error.message).toBe("Runner request was not authorized")
  }).pipe(Effect.provide(BunServices.layer)),
)
