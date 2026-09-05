import { expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { Errors, ExecutableManifest, Run, Runtime, TreePolicy } from "generalist/runtime"
import type { AuthenticatedPrincipal } from "../../../src/hosted/product"
import { HostedRecoveryError, makeService } from "../../../src/hosted/execution/recovery"

const principal: AuthenticatedPrincipal = {
  userId: "recovery-user",
  clientId: "recovery-client",
  deviceId: "recovery-device",
}

const executable = ExecutableManifest.makeTest("hosted-recovery", "1")
const inspection = (status: Run.RunStatus): Run.RunInspection =>
  Run.RunInspection.make({
    runId: "run-1",
    status,
    executableRef: executable.ref,
    executableManifest: executable.manifest,
    depth: 0,
    treePolicy: TreePolicy.defaultTreePolicy,
    waits: [],
    lastSequence: 0,
    durability: "durable",
  })

const authorize = () => Effect.void

it.effect("rejects unauthorized inspection and resolution before accessing Generalist", () =>
  Effect.gen(function* () {
    const rejected = HostedRecoveryError.make({ kind: "forbidden", message: "Recovery operation was rejected" })
    const service = makeService({
      runtime: {
        inspect: () => Effect.die("unauthorized inspection"),
        resolveOperation: () => Effect.die("unauthorized resolution"),
      },
      authorizeRun: () => Effect.fail(rejected),
    })
    const input = { principal, threadId: "thread-1", runId: "run-1" }
    expect(yield* service.inspect(input).pipe(Effect.flip)).toEqual(rejected)
    for (const resolution of [
      { _tag: "Retry" },
      { _tag: "Accept", value: {} },
      { _tag: "Abort", reason: "stop" },
    ] as const)
      expect(
        yield* service
          .resolve({ ...input, operationId: "op-1", idempotencyKey: "key-1", resolution })
          .pipe(Effect.flip),
      ).toEqual(rejected)
  }),
)

it.effect("reports a missing Run rather than a recovery state", () =>
  Effect.gen(function* () {
    const service = makeService({
      runtime: {
        inspect: () => Effect.fail(Errors.RunNotFound.make({ runId: "missing" })),
        resolveOperation: () => Effect.die("unused"),
      },
      authorizeRun: authorize,
    })
    expect(yield* service.inspect({ principal, threadId: "thread-1", runId: "missing" }).pipe(Effect.flip)).toEqual(
      HostedRecoveryError.make({ kind: "not-found", message: "Run is unavailable" }),
    )
  }),
)

it.effect("authorizes and delegates Run inspection to Generalist", () =>
  Effect.gen(function* () {
    const inspected = yield* Ref.make<Array<string>>([])
    const runtime = {
      inspect: (runId: string) =>
        Ref.update(inspected, (values) => [...values, runId]).pipe(Effect.as(inspection("running"))),
      resolveOperation: () => Effect.die("unused"),
    } satisfies Pick<Runtime.Service, "inspect" | "resolveOperation">
    const authorized = yield* Ref.make<Array<readonly [string, string]>>([])
    const service = makeService({
      runtime,
      authorizeRun: (_principal, threadId, runId) =>
        Ref.update(authorized, (values) => [...values, [threadId, runId] as const]),
    })

    expect(yield* service.inspect({ principal, threadId: "thread-1", runId: "run-1" })).toEqual({
      runId: "run-1",
      status: "running",
    })
    expect(yield* Ref.get(inspected)).toEqual(["run-1"])
    expect(yield* Ref.get(authorized)).toEqual([["thread-1", "run-1"]])
  }),
)

it.effect("reports unresolved status and missing details without resolving on repeated inspection", () =>
  Effect.gen(function* () {
    const runtime = {
      inspect: () => Effect.succeed(inspection("needs-resolution")),
      resolveOperation: () => Effect.die("unused"),
    } satisfies Pick<Runtime.Service, "inspect" | "resolveOperation">
    const service = makeService({ runtime, authorizeRun: authorize })
    for (let attempt = 0; attempt < 2; attempt++)
      expect(yield* service.inspect({ principal, threadId: "thread-1", runId: "run-1" })).toEqual({
        runId: "run-1",
        status: "needs-resolution",
        operationDetails: {
          _tag: "Unavailable",
          reason: "Generalist does not expose unresolved operation details, replay policy, or result schema",
        },
      })
  }),
)

it.effect("submits exact retry, success, and failure resolutions to Generalist", () =>
  Effect.gen(function* () {
    const submitted = yield* Ref.make<Array<Parameters<Runtime.Service["resolveOperation"]>[0]>>([])
    const runtime = {
      inspect: () => Effect.die("unused"),
      resolveOperation: (input: Parameters<Runtime.Service["resolveOperation"]>[0]) =>
        Ref.update(submitted, (values) => [...values, input]),
    } satisfies Pick<Runtime.Service, "inspect" | "resolveOperation">
    const service = makeService({ runtime, authorizeRun: authorize })
    const base = {
      principal,
      threadId: "thread-1",
      runId: "run-1",
      operationId: "operation-1",
    } as const

    expect(yield* service.resolve({ ...base, idempotencyKey: "retry-1", resolution: { _tag: "Retry" } })).toEqual({
      runId: "run-1",
      operationId: "operation-1",
      idempotencyKey: "retry-1",
    })
    expect(
      yield* service.resolve({
        ...base,
        idempotencyKey: "accept-1",
        resolution: { _tag: "Accept", value: { result: 42 } },
      }),
    ).toMatchObject({ idempotencyKey: "accept-1" })
    expect(
      yield* service.resolve({
        ...base,
        idempotencyKey: "abort-1",
        resolution: { _tag: "Abort", reason: "operator rejected the outcome" },
      }),
    ).toMatchObject({ idempotencyKey: "abort-1" })
    expect(yield* Ref.get(submitted)).toEqual([
      { runId: "run-1", operationId: "operation-1", idempotencyKey: "retry-1", resolution: { _tag: "Retry" } },
      {
        runId: "run-1",
        operationId: "operation-1",
        idempotencyKey: "accept-1",
        resolution: { _tag: "Succeeded", value: { result: 42 } },
      },
      {
        runId: "run-1",
        operationId: "operation-1",
        idempotencyKey: "abort-1",
        resolution: {
          _tag: "Failed",
          error: { _tag: "UserAbortedUnknownOperation", message: "operator rejected the outcome" },
        },
      },
    ])
  }),
)

it.effect("maps Generalist resolution conflicts without inspecting private state", () =>
  Effect.gen(function* () {
    const runtime = {
      inspect: () => Effect.die("unused"),
      resolveOperation: () =>
        Effect.fail(
          Errors.OperationResolutionConflict.make({
            runId: "run-1",
            operationId: "operation-1",
            idempotencyKey: "resolution-1",
          }),
        ),
    } satisfies Pick<Runtime.Service, "inspect" | "resolveOperation">
    const failure = yield* makeService({ runtime, authorizeRun: authorize })
      .resolve({
        principal,
        threadId: "thread-1",
        runId: "run-1",
        operationId: "operation-1",
        idempotencyKey: "resolution-1",
        resolution: { _tag: "Retry" },
      })
      .pipe(Effect.flip)

    expect(failure).toEqual(HostedRecoveryError.make({ kind: "conflict", message: "Recovery resolution conflicts" }))
  }),
)
