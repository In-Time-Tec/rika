import { BunCrypto } from "@effect/platform-bun"
import { it } from "@effect/vitest"
import { Effect, Layer, Ref, Schedule } from "effect"
import { activate, layer as durabilityLayer } from "generalist/durability"
import { ExecutableResolver, LocalScheduler, RunStore } from "generalist/runtime"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { modelPin, type Authorization } from "@rika/context"
import {
  evidenceFor,
  ExecutorTransportError,
  toEvidence,
  validateHandshake,
  type ExecutorEvidence,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { expect } from "vitest"
import { hostEffect, rikaAgent } from "../../src/runtime/host"
import { threadContext, workspaceBinding } from "../fixtures/context"
import { assertWorkspaceRecoverable } from "../../src/runtime/workspace-recovery"

const makeFixture = (uncertain = false) =>
  Effect.gen(function* () {
    const fixture = yield* TestModel.make([
      TestModel.turn([TestModel.toolCall("bash", { command: "fixture-command" }, { id: "native-call" })]),
      TestModel.turn([TestModel.text("done")]),
    ])
    const sessionId = "rika-v2:owner:authorization"
    const context = yield* threadContext(workspaceBinding, sessionId, fixture.layer)
    const credential = { provider: "test", reference: "credential://test/hosted-fixture" }
    const model = { ...context.materialization.model, credentialRefs: [credential] }
    const materialization = { ...context.materialization, model, modelPin: modelPin(model) }
    const authorization = yield* Ref.make<Authorization>({
      allowedTools: materialization.tools.map((tool) => tool.name),
      allowedModels: [materialization.modelPin],
      allowedCredentials: [credential],
    })
    const dispatched: string[] = []
    const receipts = new Map<string, ExecutorEvidence>()
    const workspace: WorkspaceExecutorService = {
      binding: workspaceBinding,
      handshake: (request) =>
        validateHandshake(workspaceBinding, request.binding).pipe(Effect.as(toEvidence(workspaceBinding))),
      dispatch: (intent, _input, handshake) =>
        validateHandshake(workspaceBinding, handshake).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              dispatched.push(intent.operationId)
              if (uncertain)
                return yield* ExecutorTransportError.make({ phase: "after-dispatch", message: "Outcome is unknown" })
              const evidence = evidenceFor(intent, {
                _tag: "Completed",
                result: { text: "executed", truncated: false, exitCode: 0 },
              })
              receipts.set(intent.operationId, evidence)
              return evidence
            }),
          ),
        ),
      receipt: (id) => Effect.sync(() => receipts.get(id)),
      cancel: () => Effect.succeed({ _tag: "Cancelled" }),
    }
    const bucket = yield* DurabilityTesting.make()
    const runtime = yield* Layer.build(
      durabilityLayer({
        environment: "host-authorization-test",
        tenant: "owner",
        partition: "thread-authorization",
        addresses: [],
        schedulerMode: "external",
      }).pipe(
        Layer.provide(ExecutableResolver.layerStatic([])),
        Layer.provide(DurabilityTesting.layer(bucket)),
        Layer.provide(BunCrypto.layer),
      ),
    )
    return yield* Effect.gen(function* () {
      const host = yield* hostEffect({
        revision: "authorization-test",
        workspace,
        context: {
          ...context,
          materialization,
          authorization: {
            current: (requestedSession) =>
              requestedSession === sessionId
                ? Ref.get(authorization)
                : Effect.succeed({ allowedTools: [], allowedModels: [], allowedCredentials: [] }),
          },
        },
      })
      yield* activate
      const session = yield* host.sessions.create({ id: sessionId, agent: rikaAgent.name })
      const scheduler = yield* LocalScheduler.LocalScheduler
      const drain = (fuel: number) => scheduler.drain({ fuel }).pipe(Effect.provide(runtime))
      const store = yield* RunStore.RunStore
      const recoverable = assertWorkspaceRecoverable({ store, sessionId, runId: "next-root-run" })
      return { fixture, host, session, drain, authorization, dispatched, recoverable }
    }).pipe(Effect.provide(runtime))
  })

it.live("authorizes background native Tools through the canonical root Run's Thread Session", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const run = yield* fixture.host.runs.startByName(fixture.session.id, rikaAgent.name, "run the native tool")
    yield* fixture.drain(64)
    expect(yield* run.await.pipe(Effect.timeout("10 seconds"))).toBe("done")
    const children = yield* fixture.drain(64).pipe(
      Effect.andThen(fixture.host.runs.children(run.id)),
      Effect.repeat({
        until: (entries) =>
          entries.length === 1 && entries.every((entry) => ["succeeded", "failed", "cancelled"].includes(entry.status)),
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("10 seconds"),
    )
    expect(children).toHaveLength(1)
    const child = yield* fixture.host.tools.getByName("bash", children[0]!.childRunId)
    expect((yield* Effect.result(child.await.pipe(Effect.timeout("10 seconds"))))._tag).toBe("Success")
    expect((yield* fixture.host.runs.children(run.id))[0]?.status).toBe("succeeded")
    expect(fixture.dispatched).toHaveLength(1)
  }),
)

for (const uncertain of [false, true]) {
  it.live(`checks background Tool outcomes in their canonical tree before recovery (uncertain=${uncertain})`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(uncertain)
      const run = yield* fixture.host.runs.startByName(fixture.session.id, rikaAgent.name, "run the native tool")
      yield* fixture.drain(64)
      yield* run.await.pipe(Effect.timeout("10 seconds"))
      const children = yield* fixture.drain(64).pipe(
        Effect.andThen(fixture.host.runs.children(run.id)),
        Effect.repeat({
          until: (entries) => entries.length === 1 && entries.every((entry) => entry.status === "succeeded"),
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("10 seconds"),
      )
      expect(children).toHaveLength(1)
      expect(fixture.dispatched).toHaveLength(1)
      expect((yield* fixture.session.snapshot).runs.some((entry) => entry.rootRunId === run.id)).toBe(true)
      expect((yield* Effect.result(fixture.recoverable))._tag).toBe(uncertain ? "Failure" : "Success")
    }),
  )
}

it.live("denies native Tools rooted in another Session even when the Thread's credentials remain active", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const foreign = yield* fixture.host.sessions.create({ id: "another-session", agent: rikaAgent.name })
    const run = yield* fixture.host.runs.startByName(foreign.id, rikaAgent.name, "run the native tool")
    yield* fixture.drain(64)
    expect((yield* Effect.result(run.await.pipe(Effect.timeout("10 seconds"))))._tag).toBe("Failure")
    expect(fixture.dispatched).toEqual([])
    expect(yield* fixture.host.runs.children(run.id)).toEqual([])
  }),
)

it.live("denies revoked native tools before child admission", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    yield* Ref.update(fixture.authorization, (current) => ({ ...current, allowedTools: [] }))
    const run = yield* fixture.host.runs.startByName(fixture.session.id, rikaAgent.name, "run the native tool")
    yield* fixture.drain(64)
    expect(yield* Effect.result(run.await.pipe(Effect.timeout("10 seconds")))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RunFailed", error: { failure: { _tag: "generalist/core/PermissionDenied" } } },
    })
    expect(yield* fixture.host.runs.children(run.id)).toEqual([])
    expect(fixture.dispatched).toEqual([])
  }),
)

it.live("rechecks revoked native tool authorization after canonical admission and before dispatch", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture()
    const run = yield* fixture.host.runs.startByName(fixture.session.id, rikaAgent.name, "run the native tool")
    for (let attempt = 0; attempt < 4; attempt++) {
      yield* fixture.drain(1)
      if ((yield* fixture.host.runs.children(run.id)).length > 0) break
    }
    const children = yield* fixture.host.runs.children(run.id)
    expect(children).toHaveLength(1)
    expect(fixture.dispatched).toEqual([])
    yield* Ref.update(fixture.authorization, (current) => ({ ...current, allowedTools: [] }))
    yield* fixture.drain(64)
    const child = yield* fixture.host.tools.getByName("bash", children[0]!.childRunId)
    expect((yield* Effect.result(child.await.pipe(Effect.timeout("10 seconds"))))._tag).toBe("Failure")
    expect(fixture.dispatched).toEqual([])
  }),
)

for (const revoked of ["model", "credentials"] as const) {
  it.live(`blocks provider invocation when the ${revoked} authorization is revoked`, () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Ref.update(fixture.authorization, (current) =>
        revoked === "model" ? { ...current, allowedModels: [] } : { ...current, allowedCredentials: [] },
      )
      const run = yield* fixture.host.runs.startByName(fixture.session.id, rikaAgent.name, "run the native tool")
      yield* fixture.drain(64)
      expect((yield* Effect.result(run.await.pipe(Effect.timeout("10 seconds"))))._tag).toBe("Failure")
      expect(yield* fixture.fixture.requests).toEqual([])
      expect(fixture.dispatched).toEqual([])
    }),
  )
}
