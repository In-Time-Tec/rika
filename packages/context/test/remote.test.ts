import { expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import {
  WorkspaceBinding,
  evidenceFor,
  toEvidence,
  type NativeOperationIntent,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { NestedOperation, ToolContext } from "generalist"
import { WorkspaceReaderError, type WorkspaceReaderService } from "../src/workspace"
import {
  WorkspaceContextDispatch,
  WorkspaceContextResponse,
  handleWorkspaceContextRequest,
  remoteWorkspaceReader,
  workspaceContextToolName,
} from "../src/remote"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-remote",
  assignmentId: "assignment-remote",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-remote", checkoutFingerprint: "checkout-remote" },
  buildId: "build-remote",
  protocolVersion: 1,
})

const staleBinding = Schema.decodeSync(WorkspaceBinding)({
  ...binding,
  assignmentId: "assignment-stale",
})

const durableLayer = (operationKey: string) =>
  Layer.merge(
    NestedOperation.layerDirect,
    ToolContext.layerTest({
      signal: new AbortController().signal,
      emit: () => Effect.succeed(true),
      sessionId: "session-remote",
      runId: `run-${operationKey}`,
      operationKey,
    }),
  )

const withDurable = <A, E, R>(operationKey: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(durableLayer(operationKey)).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
  )

const encodeDispatch = Schema.encodeSync(WorkspaceContextDispatch)

const dispatchInput = (
  request: { readonly _tag: "ReadGuidance" | "ListSkills" } | { readonly _tag: "ReadSkill"; name: string },
) => encodeDispatch({ binding, request })

const encodeResponse = Schema.encodeSync(WorkspaceContextResponse)

const reader = (instructions: Effect.Effect<string, never> = Effect.succeed("skill body")): WorkspaceReaderService => ({
  readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "guidance" }]),
  listSkills: () =>
    Effect.succeed([
      {
        name: "review",
        description: "Review changes",
        instructions,
        tools: [],
      },
    ]),
})

const workspace = (
  execute: (intent: NativeOperationIntent, input: Schema.Json) => Effect.Effect<Schema.Json, WorkspaceReaderError>,
  current: typeof binding = binding,
) => {
  let handshakes = 0
  let dispatches = 0
  const service: WorkspaceExecutorService = {
    binding: current,
    handshake: (request) =>
      Effect.sync(() => {
        handshakes += 1
        return toEvidence(request.binding)
      }),
    dispatch: (intent, input) =>
      Effect.sync(() => {
        dispatches += 1
      }).pipe(
        Effect.andThen(execute(intent, input)),
        Effect.map((result) => evidenceFor(intent, { _tag: "Completed", result })),
        Effect.catch((error) =>
          Schema.is(WorkspaceReaderError)(error)
            ? Effect.succeed(
                evidenceFor(intent, { _tag: "DomainFailure", failure: Schema.encodeSync(WorkspaceReaderError)(error) }),
              )
            : Effect.die(error),
        ),
      ),
    receipt: () => Effect.void.pipe(Effect.as(undefined)),
    cancel: () => Effect.succeed({ _tag: "Cancelled" }),
  }
  return { service, handshakes: () => handshakes, dispatches: () => dispatches }
}

it.effect("fails closed without durable operation authority before the handshake", () =>
  Effect.gen(function* () {
    const fake = workspace(() => Effect.succeed(encodeResponse({ _tag: "Guidance", files: [] })))
    const remote = remoteWorkspaceReader({ binding, workspace: fake.service })
    const error = yield* Effect.flip(remote.readGuidance(binding))
    expect(error.reason).toBe("unavailable")
    expect(fake.handshakes()).toBe(0)
    expect(fake.dispatches()).toBe(0)
  }),
)

it.effect("fences a stale current executor binding before the handshake", () =>
  Effect.gen(function* () {
    const fake = workspace(() => Effect.succeed(encodeResponse({ _tag: "Guidance", files: [] })), staleBinding)
    const remote = remoteWorkspaceReader({ binding, workspace: fake.service })
    const error = yield* Effect.flip(withDurable("stale", remote.readGuidance(binding)))
    expect(error.reason).toBe("binding")
    expect(fake.handshakes()).toBe(0)
  }),
)

it.effect("rejects stale handshake evidence before dispatching a context request", () =>
  Effect.gen(function* () {
    let dispatches = 0
    const service: WorkspaceExecutorService = {
      binding,
      handshake: () => Effect.succeed(toEvidence(staleBinding)),
      dispatch: () =>
        Effect.sync(() => {
          dispatches += 1
        }).pipe(Effect.andThen(Effect.die("Dispatch must not run after a stale handshake"))),
      receipt: () => Effect.void.pipe(Effect.as(undefined)),
      cancel: () => Effect.succeed({ _tag: "Cancelled" }),
    }
    const remote = remoteWorkspaceReader({ binding, workspace: service })
    const error = yield* Effect.flip(withDurable("handshake", remote.readGuidance(binding)))
    expect(error.reason).toBe("binding")
    expect(dispatches).toBe(0)
  }),
)

it.effect("keeps remote skill bodies lazy across the typed executor response", () =>
  Effect.gen(function* () {
    let reads = 0
    const local = reader(
      Effect.sync(() => {
        reads += 1
        return "lazy body"
      }),
    )
    const fake = workspace((intent, input) => handleWorkspaceContextRequest({ reader: local, binding }, input))
    const remote = remoteWorkspaceReader({ binding, workspace: fake.service })
    const skills = yield* withDurable("lazy", remote.listSkills(binding))
    expect(skills.map((skill) => skill.name)).toEqual(["review"])
    expect(reads).toBe(0)
    const skill = skills[0]
    expect(skill).toBeDefined()
    if (skill === undefined) return
    expect(yield* withDurable("lazy-body", skill.instructions)).toBe("lazy body")
    expect(reads).toBe(1)
    expect(fake.dispatches()).toBe(2)
  }),
)

it.effect("rejects a completed response whose evidence does not match the request", () =>
  Effect.gen(function* () {
    const service: WorkspaceExecutorService = {
      binding,
      handshake: () => Effect.succeed(toEvidence(binding)),
      dispatch: (intent) =>
        Effect.succeed({
          ...evidenceFor(intent, { _tag: "Completed", result: encodeResponse({ _tag: "Guidance", files: [] }) }),
          inputDigest: "different-input",
        }),
      receipt: () => Effect.void.pipe(Effect.as(undefined)),
      cancel: () => Effect.succeed({ _tag: "Cancelled" }),
    }
    const remote = remoteWorkspaceReader({ binding, workspace: service })
    const error = yield* Effect.flip(withDurable("evidence", remote.readGuidance(binding)))
    expect(error.reason).toBe("binding")
  }),
)

it.effect("returns typed handler errors for malformed requests and binding fences", () =>
  Effect.gen(function* () {
    const malformed = yield* Effect.flip(
      handleWorkspaceContextRequest({ reader: reader(), binding }, { invalid: true }),
    )
    const fenced = yield* Effect.flip(
      handleWorkspaceContextRequest(
        { reader: reader(), binding },
        encodeDispatch({ binding: staleBinding, request: { _tag: "ReadGuidance" } }),
      ),
    )
    expect(malformed).toBeInstanceOf(WorkspaceReaderError)
    expect(malformed.reason).toBe("malformed")
    expect(fenced.reason).toBe("binding")
    expect(workspaceContextToolName).toBe("rika_workspace_context")
    expect(dispatchInput({ _tag: "ListSkills" }).request).toEqual({ _tag: "ListSkills" })
  }),
)
