import { ModelRegistry, SandboxExecutor } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { expect, it } from "@effect/vitest"
import * as RoleToolkits from "@rika/tools/agent-role-toolkits"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import type { Change, Checkpoint } from "@rika/product/execution-projection"
import type { Unit } from "@rika/transcript/transcript-unit"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"
import { layer } from "../src/baton-execution"

const registryLayer = (fixture: TestModel.Fixture) =>
  ModelRegistry.layer([Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })])

const stubHandlers = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  toolkit.toLayer(
    Object.fromEntries(
      Object.keys(toolkit.tools).map((name) => [name, () => Effect.succeed({ text: name, truncated: false })]),
    ) as never,
  )

const sandbox = SandboxExecutor.makeTest(() => Effect.die(new Error("unexpected Program execution")), {
  language: "javascript",
  implementation: "rika-approval-test-sandbox",
  version: "1",
  memoryBytes: 1024,
  stackBytes: 1024,
})

const routeWithIdentity = (identity: string) => {
  const route = testExecutionRoute()
  return {
    ...route,
    main: {
      ...route.main,
      registrationIdentity: identity as typeof route.main.registrationIdentity,
      candidates: route.main.candidates.map((candidate) =>
        Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
      ),
    },
  }
}

const materialize = (changes: ReadonlyArray<Change>) => {
  const units = new Map<string, Unit>()
  let checkpoint: Checkpoint | undefined
  for (const change of changes) {
    if (change._tag === "ProjectionSnapshot") {
      if (!change.hasOlder) units.clear()
      for (const unit of change.units) units.set(unit.key, unit)
      checkpoint = change.checkpoint
    } else {
      for (const key of change.remove) units.delete(key)
      for (const unit of change.upsert) units.set(unit.key, unit)
      checkpoint = change.checkpoint
    }
  }
  const authorization = [...units.values()].find(
    (unit) =>
      unit.content._tag === "Block" &&
      unit.content.block._tag === "AuthorizationCard" &&
      unit.content.block.status === "pending",
  )
  if (
    checkpoint === undefined ||
    authorization?.content._tag !== "Block" ||
    authorization.content.block._tag !== "AuthorizationCard"
  )
    throw new Error("approval fixture did not reach a persisted authorization checkpoint")
  return { checkpoint, units: [...units.values()], authorizationId: authorization.content.block.id }
}

const gatewayLayer = (filename: string, fixture: TestModel.Fixture, writeCount: Ref.Ref<number>) => {
  const handlers = Object.fromEntries(
    Object.keys(RoleToolkits.root.tools).map((name) => [
      name,
      name === "write"
        ? () => Ref.update(writeCount, (count) => count + 1).pipe(Effect.as({ text: "written", truncated: false }))
        : () => Effect.succeed({ text: name, truncated: false }),
    ]),
  )
  const services = Layer.mergeAll(RoleToolkits.root.toLayer(handlers as never), stubHandlers(RoleToolkits.readThread))
  return layer({
    filename,
    modelServices: registryLayer(fixture),
    agentServices: () => services,
  }).pipe(Layer.provide(Layer.succeed(SandboxExecutor.SandboxExecutor, sandbox)))
}

const startAndSuspend = (filename: string, fixture: TestModel.Fixture, writeCount: Ref.Ref<number>, suffix: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(gatewayLayer(filename, fixture, writeCount))
      const gateway = Context.get(context, ExecutionGateway.Service)
      const link = yield* gateway.startTurn({
        threadId: `thread-${suffix}`,
        turnId: `turn-${suffix}`,
        workspace: "/workspace",
        prompt: "write the file",
        executionRoute: routeWithIdentity(`approval-${suffix}`),
      })
      const changes = [...(yield* gateway.watchTurn(link).pipe(Stream.runCollect))]
      return { link, ...materialize(changes) }
    }),
  )

const resume = (
  filename: string,
  fixture: TestModel.Fixture,
  writeCount: Ref.Ref<number>,
  blocked: Effect.Success<ReturnType<typeof startAndSuspend>>,
  decision: "approve" | "deny",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(gatewayLayer(filename, fixture, writeCount))
      const gateway = Context.get(context, ExecutionGateway.Service)
      const input = { authorizationId: blocked.authorizationId, checkpoint: blocked.checkpoint }
      const stale = yield* gateway
        .approveTurn(blocked.link, {
          authorizationId: "authorization-that-does-not-exist",
          checkpoint: blocked.checkpoint,
        })
        .pipe(Effect.flip)
      const unavailable = yield* gateway
        .approveTurn({ ...blocked.link, runId: "run-that-does-not-exist" }, input)
        .pipe(Effect.flip)
      yield* decision === "approve" ? gateway.approveTurn(blocked.link, input) : gateway.denyTurn(blocked.link, input)
      const changes = [
        ...(yield* gateway
          .watchTurn(blocked.link, { checkpoint: blocked.checkpoint, units: blocked.units })
          .pipe(Stream.runCollect)),
      ]
      yield* decision === "approve" ? gateway.approveTurn(blocked.link, input) : gateway.denyTurn(blocked.link, input)
      const opposite = yield* (
        decision === "approve" ? gateway.denyTurn(blocked.link, input) : gateway.approveTurn(blocked.link, input)
      ).pipe(Effect.flip)
      return { changes, stale, unavailable, opposite }
    }),
  )

const settledStatus = (changes: ReadonlyArray<Change>) =>
  changes
    .flatMap((change) => (change._tag === "ProjectionSnapshot" ? change.units : change.upsert))
    .findLast((unit) => unit.content._tag === "Block" && unit.content.block._tag === "AuthorizationCard")

it.live(
  "resumes SQLite approvals through stable product identities with idempotent retry semantics",
  () =>
    Effect.gen(function* () {
      const approveFile = `/tmp/rika-baton-approval-${randomUUID()}.db`
      const approveFixture = yield* TestModel.make(
        [
          TestModel.turn([
            TestModel.toolCall("write", { path: "approved.txt", content: "yes" }, { id: "write-approved" }),
          ]),
          TestModel.turn([TestModel.text("approved")]),
        ],
        { provider: "test", model: "test", registrationKey: "approval-approve" },
      )
      const approveWrites = yield* Ref.make(0)
      const approved = yield* startAndSuspend(approveFile, approveFixture, approveWrites, "approve")
      expect(yield* Ref.get(approveWrites)).toBe(0)
      const approveResult = yield* resume(approveFile, approveFixture, approveWrites, approved, "approve")
      expect(yield* Ref.get(approveWrites)).toBe(1)
      expect(approveResult.stale).toMatchObject({
        kind: "stale",
        message: "Authorization is no longer pending",
      })
      expect(approveResult.unavailable).toMatchObject({
        kind: "unavailable",
        message: "Approval service is unavailable",
      })
      expect(approveResult.opposite).toMatchObject({
        kind: "mismatch",
        message: "Authorization response conflicts with its current state",
      })
      expect(settledStatus(approveResult.changes)).toMatchObject({
        content: { block: { status: "approved" } },
      })

      const denyFile = `/tmp/rika-baton-denial-${randomUUID()}.db`
      const denyFixture = yield* TestModel.make(
        [
          TestModel.turn([TestModel.toolCall("write", { path: "denied.txt", content: "no" }, { id: "write-denied" })]),
          TestModel.turn([TestModel.text("denied")]),
        ],
        { provider: "test", model: "test", registrationKey: "approval-deny" },
      )
      const denyWrites = yield* Ref.make(0)
      const denied = yield* startAndSuspend(denyFile, denyFixture, denyWrites, "deny")
      const denyResult = yield* resume(denyFile, denyFixture, denyWrites, denied, "deny")
      expect(yield* Ref.get(denyWrites)).toBe(0)
      expect(denyResult.opposite).toMatchObject({
        kind: "mismatch",
        message: "Authorization response conflicts with its current state",
      })
      expect(settledStatus(denyResult.changes)).toMatchObject({
        content: { block: { status: "denied" } },
      })
    }),
  60_000,
)
