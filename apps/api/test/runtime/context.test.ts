/* oxlint-disable max-lines -- context construction, live revocation, and deferred workspace qualification stay mirrored in one focused suite. */
import type { ProviderCredentialCipher } from "@rika/credential-vault/provider"
import {
  WorkspaceBinding,
  evidenceFor,
  toEvidence,
  type NativeOperationIntent,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { tools } from "@rika/execution/tools"
import {
  WorkspaceContextDispatch,
  WorkspaceContextResponse,
  handleWorkspaceContextRequest,
} from "@rika/context/remote"
import { WorkspaceReaderError, modelPin, type ModelConfiguration } from "@rika/context"
import type { CredentialRecord, ProviderCredentialOperations } from "@rika/product-store/provider-credentials"
import {
  ProductRepositoryError,
  type ProductRepositoryService,
  type ThreadExecutionProjection,
} from "@rika/product-store/product-repository"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelRegistry, NestedOperation, Pins, ToolContext } from "generalist"
import { expect, it } from "@effect/vitest"
import { makeApiV2RuntimeContextFactory } from "../../src/runtime/context"
import type { ApiV2ContextComposition } from "../../src/runtime/host"
import { threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"

const partition = threadPartition({
  environment: "test",
  ownerId: "owner-1",
  threadId: "thread-1",
  target: "runner",
})

const workspaceBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-1",
  assignmentId: "assignment-1",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "workspace-1", checkoutFingerprint: "checkout-1" },
  buildId: "build-1",
  protocolVersion: 2,
})

const binding: ThreadExecutionBinding = {
  partition,
  placement: workspaceBinding.placement,
  workspaceBinding,
}

const projection = (overrides: Partial<ThreadExecutionProjection> = {}): ThreadExecutionProjection => ({
  assignmentId: "assignment-1",
  workspaceId: "workspace-1",
  title: "Thread",
  hasTurns: false,
  executorKind: "runner",
  generation: "1",
  lifecycle: "ready",
  executorInstanceId: "runner-1",
  providerInstanceId: null,
  checkout: null,
  localRepository: null,
  placement: {
    _tag: "RunnerPlacement",
    deviceId: "device-1",
    requestingDeviceId: "device-1",
    checkoutFingerprint: "checkout-1",
    executorPolicy: { buildId: "build-1", protocolVersion: 2 },
  },
  ...overrides,
})

const credential = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
  credentialIdentity: "credential-openai-1",
  ownerId: "owner-1",
  provider: "openai",
  status: "active",
  revision: "1",
  keyVersion: 1,
  nonce: new Uint8Array(12).fill(1),
  ciphertext: Uint8Array.of(2),
  authenticationTag: new Uint8Array(16).fill(3),
  ...overrides,
})

const selectedModel = {
  selection: { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
  settings: {
    temperature: 0.2,
    maxOutputTokens: 512,
    reasoningEffort: "high",
    options: { store: false },
  },
} as const satisfies Omit<ModelConfiguration, "credentialRefs">

interface FixtureState {
  projection: ThreadExecutionProjection | undefined
  credential: CredentialRecord | undefined
  assignmentReads: number
  ownerCredentialReads: Array<readonly [string, string]>
  identityCredentialReads: number
  decryptions: number
  handshakes: number
  dispatches: number
  receipts: number
  cancellations: number
  events: string[]
}

const fixture = () => {
  const state: FixtureState = {
    projection: projection(),
    credential: credential(),
    assignmentReads: 0,
    ownerCredentialReads: [],
    identityCredentialReads: 0,
    decryptions: 0,
    handshakes: 0,
    dispatches: 0,
    receipts: 0,
    cancellations: 0,
    events: [],
  }
  const product: Pick<ProductRepositoryService, "threadExecutionContext"> = {
    threadExecutionContext: (ownerId, threadId) =>
      Effect.sync(() => {
        state.assignmentReads += 1
        state.events.push("assignment")
        return ownerId === partition.ownerId && threadId === partition.threadId ? state.projection : undefined
      }),
  }
  const credentials: Pick<ProviderCredentialOperations, "credentialByOwner" | "credentialByIdentity"> = {
    credentialByOwner: (ownerId, provider) =>
      Effect.sync(() => {
        state.ownerCredentialReads.push([ownerId, provider])
        state.events.push("credential")
        return state.credential
      }),
    credentialByIdentity: () =>
      Effect.sync(() => {
        state.identityCredentialReads += 1
        state.events.push("credential-reference")
        return state.credential
      }),
  }
  const cipher: ProviderCredentialCipher = {
    decrypt: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.decryptions += 1
          return Redacted.make("fixture-secret")
        }),
        (value) => Effect.sync(() => Redacted.wipeUnsafe(value)),
      ),
  }
  const reader = {
    readGuidance: () => Effect.succeed([{ path: "AGENTS.md", content: "Prepared workspace guidance" }]),
    listSkills: () =>
      Effect.succeed([
        {
          name: "review",
          description: "Review the assigned workspace",
          instructions: Effect.succeed("Review the prepared workspace."),
          tools: [],
        },
      ]),
  }
  const workspace: WorkspaceExecutorService = {
    binding: workspaceBinding,
    handshake: (request) =>
      Effect.sync(() => {
        state.handshakes += 1
        state.events.push("handshake")
        return toEvidence(request.binding)
      }),
    dispatch: (intent: NativeOperationIntent, input) =>
      Effect.sync(() => {
        state.dispatches += 1
        state.events.push("dispatch")
      }).pipe(
        Effect.andThen(handleWorkspaceContextRequest({ reader, binding: workspaceBinding }, input)),
        Effect.map((result) => evidenceFor(intent, { _tag: "Completed", result })),
        Effect.catch((error) =>
          Schema.is(WorkspaceReaderError)(error)
            ? Effect.succeed(
                evidenceFor(intent, {
                  _tag: "DomainFailure",
                  failure: Schema.encodeSync(WorkspaceReaderError)(error),
                }),
              )
            : Effect.die(error),
        ),
      ),
    receipt: () =>
      Effect.sync(() => {
        state.receipts += 1
        return undefined
      }),
    cancel: () =>
      Effect.sync(() => {
        state.cancellations += 1
        return { _tag: "Cancelled" as const }
      }),
  }
  return {
    state,
    workspace,
    factory: makeApiV2RuntimeContextFactory({
      product,
      credentials,
      cipher,
      model: selectedModel,
      httpClientLayer: FetchHttpClient.layer,
      prepareWorkspace: (input) => Effect.succeed(input.binding.workspaceBinding),
    }),
  }
}

const durableLayer = Layer.merge(
  NestedOperation.layerDirect,
  ToolContext.layerTest({
    signal: new AbortController().signal,
    emit: () => Effect.succeed(true),
    sessionId: partition.rootSessionId,
    runId: "run-1",
    operationKey: "prepare-1",
  }),
)

const withDurable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(durableLayer).pipe(Effect.flatMap((services) => Effect.provide(effect, services))))

const prepare = (context: ApiV2ContextComposition) =>
  context.prepare?.({
    sessionId: partition.rootSessionId,
    runId: "run-1",
    acceptedInputId: "input-1",
    admittedAt: "2026-09-10T12:00:00.000Z",
    operationKey: "prepare-1",
    beforeRecovery: Effect.void,
  }) ?? Effect.die("Expected deferred context preparation")

it.effect("constructs deterministic policy without eagerly touching the workspace, model provider, or cipher", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const context = yield* test.factory({ partition, binding, workspace: test.workspace, rebindWorkspace: () => Effect.void })
      expect(test.state.assignmentReads).toBe(1)
      expect(test.state.ownerCredentialReads).toEqual([["owner-1", "openai"]])
      expect(test.state.identityCredentialReads).toBe(0)
      expect(test.state.decryptions).toBe(0)
      expect(test.state.handshakes).toBe(0)
      expect(test.state.dispatches).toBe(0)
      expect(test.state.receipts).toBe(0)
      expect(test.state.cancellations).toBe(0)
      expect(context.materialization.sessionId).toBe(partition.rootSessionId)
      expect(context.materialization.guidanceScope).toBe(`${partition.rootSessionId}-workspace`)
      expect(context.materialization.guidance.payload.entries).toEqual([])
      expect(context.materialization.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
      expect(
        context.materialization.tools.every(
          (tool) =>
            tool.pin ===
            Pins.makeCapability({
              name: tool.name,
              buildId: workspaceBinding.buildId,
              protocolVersion: workspaceBinding.protocolVersion,
            }),
        ),
      ).toBe(true)
      expect(context.materialization.model).toEqual({
        ...selectedModel,
        credentialRefs: [{ provider: "openai", reference: "credential://credential-openai-1" }],
      })
      expect(context.materialization.modelPin).toBe(modelPin(context.materialization.model))
      const registry = Context.get(yield* Layer.build(context.modelRegistry), ModelRegistry.ModelRegistry)
      expect(yield* registry.registrations).toMatchObject([
        { provider: "openai", model: "gpt-6-astra", registrationKey: "owner-route" },
      ])
      expect(test.state.identityCredentialReads).toBe(0)
      expect(test.state.decryptions).toBe(0)
      expect(test.state.handshakes).toBe(0)

      const second = yield* test.factory({ partition, binding, workspace: test.workspace, rebindWorkspace: () => Effect.void })
      expect(Pins.digest(second.materialization)).toBe(Pins.digest(context.materialization))
    }),
  ),
)

it.effect("rechecks assignment and credential authority before remotely materializing the prepared workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const context = yield* test.factory({ partition, binding, workspace: test.workspace, rebindWorkspace: () => Effect.void })
      test.state.events.length = 0
      const prepared = yield* withDurable(prepare(context))
      expect(test.state.events).toEqual([
        "assignment",
        "credential-reference",
        "handshake",
        "dispatch",
        "handshake",
        "dispatch",
      ])
      expect(prepared.guidance.payload.entries.map((entry) => entry.title)).toEqual(["AGENTS.md", "review"])
      expect(prepared.model).toEqual(context.materialization.model)
      expect(prepared.modelPin).toBe(context.materialization.modelPin)
      expect(prepared.settingsRevision).toBe(context.materialization.settingsRevision)
      expect(prepared.tools).toEqual(context.materialization.tools)
      expect(test.state.identityCredentialReads).toBe(1)
      expect(test.state.decryptions).toBe(0)
      expect(test.state.receipts).toBe(0)
      expect(test.state.cancellations).toBe(0)
    }),
  ),
)

it.effect("allocates an Orb only after admission and before reading its remote workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orbPartition = threadPartition({
        environment: "test",
        ownerId: "owner-1",
        threadId: "thread-1",
        target: "orb",
      })
      const orbWorkspaceBinding = yield* Schema.decodeEffect(WorkspaceBinding)({
        ...workspaceBinding,
        placement: { _tag: "Orb", workspaceId: "workspace-1", lineageId: "lineage-1" },
      }).pipe(Effect.orDie)
      const orbBinding: ThreadExecutionBinding = {
        partition: orbPartition,
        placement: orbWorkspaceBinding.placement,
        workspaceBinding: orbWorkspaceBinding,
      }
      const events: string[] = []
      const product: Pick<ProductRepositoryService, "threadExecutionContext"> = {
        threadExecutionContext: () =>
          Effect.sync(() => {
            events.push("assignment")
            return projection({
              executorKind: "orb",
              placement: {
                _tag: "OrbPlacement",
                templateBuildId: "template-1",
                providerScope: "provider-1",
                lineageId: "lineage-1",
                executorPolicy: { buildId: "build-1", protocolVersion: 2 },
              },
            })
          }),
      }
      const credentials: Pick<ProviderCredentialOperations, "credentialByOwner" | "credentialByIdentity"> = {
        credentialByOwner: () =>
          Effect.sync(() => {
            events.push("credential")
            return credential()
          }),
        credentialByIdentity: () =>
          Effect.sync(() => {
            events.push("credential-reference")
            return credential()
          }),
      }
      let prepared = false
      let handshakes = 0
      let dispatches = 0
      const workspace: WorkspaceExecutorService = {
        binding: orbWorkspaceBinding,
        handshake: (request) =>
          Effect.sync(() => {
            expect(prepared).toBe(true)
            events.push("handshake")
            handshakes += 1
            return toEvidence(request.binding)
          }),
        dispatch: (intent, input) =>
          Effect.gen(function* () {
            expect(prepared).toBe(true)
            events.push("dispatch")
            dispatches += 1
            const request = (yield* Schema.decodeUnknownEffect(WorkspaceContextDispatch)(input)).request
            const response =
              request._tag === "ReadGuidance"
                ? WorkspaceContextResponse.make({ _tag: "Guidance", files: [] })
                : WorkspaceContextResponse.make({ _tag: "Skills", skills: [] })
            return evidenceFor(intent, {
              _tag: "Completed" as const,
              result: yield* Schema.encodeEffect(WorkspaceContextResponse)(response),
            })
          }).pipe(Effect.orDie),
        receipt: () => Effect.void.pipe(Effect.as(undefined)),
        cancel: () => Effect.succeed({ _tag: "Cancelled" }),
      }
      const context = yield* makeApiV2RuntimeContextFactory({
        product,
        credentials,
        cipher: { decrypt: () => Effect.die("Cipher must remain lazy") },
        model: selectedModel,
        httpClientLayer: FetchHttpClient.layer,
        prepareWorkspace: (input) =>
          Effect.sync(() => {
            expect(input.partition).toBe(orbPartition)
            expect(input.binding).toEqual(orbBinding)
            expect(input.sessionId).toBe(orbPartition.rootSessionId)
            expect(input.acceptedInputId).toBe("input-1")
            events.push("box")
            prepared = true
            return input.binding.workspaceBinding
          }),
      })({ partition: orbPartition, binding: orbBinding, workspace, rebindWorkspace: () => Effect.void })
      expect(prepared).toBe(false)
      expect(handshakes).toBe(0)
      expect(dispatches).toBe(0)
      events.length = 0
      yield* withDurable(context.ensureWorkspace?.({
        sessionId: orbPartition.rootSessionId,
        runId: "run-1",
        acceptedInputId: "input-1",
        admittedAt: "2026-09-10T12:00:00.000Z",
        operationKey: "prepare-1",
        beforeRecovery: Effect.void,
      }) ?? Effect.die("Expected admitted workspace preparation"))
      yield* withDurable(prepare(context))
      expect(events).toEqual([
        "assignment",
        "credential-reference",
        "assignment",
        "box",
        "assignment",
        "credential-reference",
        "handshake",
        "dispatch",
        "handshake",
        "dispatch",
      ])
      expect(handshakes).toBe(2)
      expect(dispatches).toBe(2)
    }),
  ),
)

it.effect("denies live assignment and credential revocation before any workspace handshake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = fixture()
      const context = yield* test.factory({ partition, binding, workspace: test.workspace, rebindWorkspace: () => Effect.void })
      const initial = yield* context.authorization.current(partition.rootSessionId)
      expect(initial).toEqual({
        allowedTools: tools.map((tool) => tool.name),
        allowedModels: [context.materialization.modelPin],
        allowedCredentials: [{ provider: "openai", reference: "credential://credential-openai-1" }],
      })

      test.state.projection = projection({ assignmentId: "assignment-2", generation: "2" })
      expect(yield* context.authorization.current(partition.rootSessionId)).toEqual({
        allowedTools: [],
        allowedModels: [],
        allowedCredentials: [],
      })
      expect((yield* Effect.result(withDurable(prepare(context))))._tag).toBe("Failure")
      expect(test.state.handshakes).toBe(0)

      test.state.projection = projection()
      test.state.credential = credential({
        status: "revoked",
        revision: "2",
        keyVersion: null,
        nonce: null,
        ciphertext: null,
        authenticationTag: null,
      })
      expect(yield* context.authorization.current(partition.rootSessionId)).toEqual({
        allowedTools: [],
        allowedModels: [],
        allowedCredentials: [],
      })
      expect((yield* Effect.result(withDurable(prepare(context))))._tag).toBe("Failure")
      expect(test.state.handshakes).toBe(0)
      expect(test.state.identityCredentialReads).toBeGreaterThan(0)
      expect(test.state.decryptions).toBe(0)

      const reads = test.state.assignmentReads
      expect(yield* context.authorization.current("another-session")).toEqual({
        allowedTools: [],
        allowedModels: [],
        allowedCredentials: [],
      })
      expect(test.state.assignmentReads).toBe(reads)
    }),
  ),
)

it.effect("maps missing, substituted, and unavailable owner credentials to safe product authorization failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const missing = fixture()
      missing.state.credential = undefined
      const missingResult = yield* Effect.result(missing.factory({ partition, binding, workspace: missing.workspace, rebindWorkspace: () => Effect.void }))
      expect(missingResult).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RikaApiV2ProductAuthorizationError", kind: "invalid" },
      })
      expect(missing.state.handshakes).toBe(0)

      const substituted = fixture()
      substituted.state.credential = credential({ ownerId: "owner-2", provider: "anthropic" })
      const substitutedResult = yield* Effect.result(
        substituted.factory({ partition, binding, workspace: substituted.workspace, rebindWorkspace: () => Effect.void }),
      )
      expect(substitutedResult).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RikaApiV2ProductAuthorizationError", kind: "invalid" },
      })
      expect(substituted.state.ownerCredentialReads).toEqual([["owner-1", "openai"]])

      const unavailable = fixture()
      const product: Pick<ProductRepositoryService, "threadExecutionContext"> = {
        threadExecutionContext: () =>
          Effect.fail(ProductRepositoryError.make({ kind: "unavailable", message: "database-secret" })),
      }
      const result = yield* Effect.result(
        makeApiV2RuntimeContextFactory({
          product,
          credentials: {
            credentialByOwner: () => Effect.succeed(unavailable.state.credential),
            credentialByIdentity: () => Effect.succeed(unavailable.state.credential),
          },
          cipher: { decrypt: () => Effect.die("Cipher must remain lazy") },
          model: selectedModel,
          httpClientLayer: FetchHttpClient.layer,
          prepareWorkspace: (input) => Effect.succeed(input.binding.workspaceBinding),
        })({ partition, binding, workspace: unavailable.workspace, rebindWorkspace: () => Effect.void }),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "RikaApiV2ProductAuthorizationError",
          kind: "unavailable",
          message: "Thread execution context is unavailable",
        },
      })
    }),
  ),
)
