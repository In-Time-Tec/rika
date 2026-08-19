import { Crypto, Effect, Layer, Redacted } from "effect"
import { AssignmentStore, AssignmentStoreError, type AssignmentRecord } from "../../src/assignment-store"
import { CheckpointObjectInspector } from "../../src/checkpoint"
import {
  CheckoutCredentialBroker,
  GitHubAppTokenSource,
  layer as checkoutLayer,
  type GitHubAppTokenSourceInterface,
} from "../../src/checkout"
import * as Controller from "../../src/controller"
import { E2BSandboxProvider, type SandboxCreateRequest, type SandboxInventoryEntry } from "../../src/provider"

const digest = (_algorithm: string, data: Uint8Array) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data).then((value) => new Uint8Array(value)))

export interface FakeProviderState {
  readonly creates: Array<SandboxCreateRequest>
  readonly connects: Array<{ readonly sandboxId: string; readonly timeoutMillis: number }>
  readonly pauses: Array<string>
  readonly kills: Array<string>
  readonly touches: Array<{ readonly sandboxId: string; readonly timeoutMillis: number }>
  inventory: Array<SandboxInventoryEntry>
}

export interface Harness {
  readonly records: Map<string, AssignmentRecord>
  readonly provider: FakeProviderState
  readonly checkpointInspections: Array<string>
  checkpointInspection: { readonly contentDigest: string; readonly sizeBytes: number }
  readonly checkoutRequests: Array<{
    readonly installationId: string
    readonly owner: string
    readonly repository: string
  }>
  layer: Layer.Layer<Controller.E2BExecutionController, import("../../src/contract").E2BExecutionError>
}

const storeLayer = (records: Map<string, AssignmentRecord>) =>
  Layer.succeed(
    AssignmentStore,
    AssignmentStore.of({
      get: (assignmentId) => Effect.succeed(records.get(assignmentId)),
      insert: (record) => {
        if (records.has(record.assignmentId))
          return Effect.fail(AssignmentStoreError.make({ kind: "conflict", message: "already exists" }))
        records.set(record.assignmentId, record)
        return Effect.succeed(record)
      },
      update: (record, expectedRevision) => {
        const current = records.get(record.assignmentId)
        if (current === undefined)
          return Effect.fail(AssignmentStoreError.make({ kind: "missing", message: "missing" }))
        if (current.revision !== expectedRevision)
          return Effect.fail(AssignmentStoreError.make({ kind: "conflict", message: "stale revision" }))
        const next = { ...record, revision: expectedRevision + 1 }
        records.set(record.assignmentId, next)
        return Effect.succeed(next)
      },
      list: Effect.sync(() => [...records.values()]),
    }),
  )

const providerLayer = (state: FakeProviderState) =>
  Layer.succeed(
    E2BSandboxProvider,
    E2BSandboxProvider.of({
      create: (request) => {
        state.creates.push(request)
        return Effect.succeed({ sandboxId: `sandbox-${state.creates.length}`, state: "running" })
      },
      connect: (sandboxId, timeoutMillis) => {
        state.connects.push({ sandboxId, timeoutMillis })
        return Effect.succeed({ sandboxId, state: "running" })
      },
      pauseFilesystem: (sandboxId) => {
        state.pauses.push(sandboxId)
        return Effect.succeed(true)
      },
      kill: (sandboxId) => {
        state.kills.push(sandboxId)
        return Effect.succeed(true)
      },
      touch: (sandboxId, timeoutMillis) => {
        state.touches.push({ sandboxId, timeoutMillis })
        return Effect.void
      },
      inventory: Effect.sync(() => state.inventory),
    }),
  )

const cryptoLayer = () => {
  let next = 1
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ & 255),
      digest,
    }),
  )
}

export const makeHarness = (overrides: Partial<Controller.Options> = {}): Harness => {
  const records = new Map<string, AssignmentRecord>()
  const provider: FakeProviderState = {
    creates: [],
    connects: [],
    pauses: [],
    kills: [],
    touches: [],
    inventory: [],
  }
  const checkpointInspections: Array<string> = []
  const harness: Harness = {
    records,
    provider,
    checkpointInspections,
    checkpointInspection: { contentDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 42 },
    checkoutRequests: [],
    layer: undefined as never,
  }
  const source: GitHubAppTokenSourceInterface = {
    issue: (request) => {
      harness.checkoutRequests.push(request)
      return Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (now) => ({
          token: Redacted.make("ghs_actual_secret", { label: "github-installation-token" }),
          expiresAt: now + 30 * 60 * 1_000,
        }),
      )
    },
  }
  const broker: Layer.Layer<CheckoutCredentialBroker> = checkoutLayer.pipe(
    Layer.provide(Layer.succeed(GitHubAppTokenSource, GitHubAppTokenSource.of(source))),
  )
  const inspector = Layer.succeed(
    CheckpointObjectInspector,
    CheckpointObjectInspector.of({
      inspect: (objectKey) => {
        checkpointInspections.push(objectKey)
        return Effect.succeed(harness.checkpointInspection)
      },
    }),
  )
  const dependencies = Layer.mergeAll(storeLayer(records), providerLayer(provider), cryptoLayer(), broker, inspector)
  harness.layer = Controller.layer({
    templateBuildId: "template-build-v1-immutable",
    controllerUrl: "wss://controller.example.test/executors",
    allowedEgress: ["controller.example.test", "github.com", "api.github.com"],
    ...overrides,
  }).pipe(Layer.provide(dependencies))
  return harness
}

export const assignmentRequest = {
  assignmentId: "assignment-1",
  workspaceId: "workspace-1",
  repository: {
    owner: "In-Time-Tec",
    name: "rika",
    installationId: "installation-1",
    ref: "refs/heads/main",
  },
} as const

export const controller = Effect.map(Controller.E2BExecutionController, (service) => service)
