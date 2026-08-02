import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"

import { vi } from "vitest"

import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { ModelResilience } from "@batonfx/core"
import { Effect, Layer, Ref, Stream } from "effect"

import { Tool } from "effect/unstable/ai"
import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { defaultModelResilience, layer } from "../src/relay/execution/relay-execution-layer"
import { layerFromClient } from "../src/relay/execution/relay-execution-client-layer"
import { buildChildRunInput } from "../src/relay/execution/relay-execution-input"
import { toolkitFor, webSearchFactories } from "../src/model/routing/relay-model-tools"
import { modelVariantKey } from "../src/model/routing/relay-model-selection"
import { eventHistoryOption } from "../src/model/routing/relay-model-registry"
import { turnIdFromExecutionId, workspaceFromExecutionId } from "../src/relay/execution/relay-execution-identifier"

const RelayExecutionBackend = {
  layer,
  layerFromClient,
  buildChildRunInput,
  defaultModelResilience: defaultModelResilience as ModelResilience.Interface,
  toolkitFor,
  webSearchFactories,
  modelVariantKey,
  eventHistoryOption,
  turnIdFromExecutionId,
  workspaceFromExecutionId,
}

const MockEffect = vi.hoisted(() => (require("effect") as typeof import("effect")).Effect)

const native = vi.hoisted(() => ({
  client: undefined as Client.Interface | undefined,
  databaseAcquisitions: 0,
  databaseOptions: [] as Array<Record<string, unknown>>,
  runtimeGraphs: 0,
}))

const routeFor = (
  role: "main" | "oracle" | "compaction" | "librarian" | "painter" | "review" | "readThread" | "surgeon" | "task",
  model: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  compaction: { readonly contextWindow: number; readonly reserveTokens: number; readonly keepRecentTokens: number },
) => ({
  role,
  alias: role,
  model: model.model,
  providerConnection: {
    provider: model.provider,
    protocol: "test" as const,
    baseUrl: "test://model",
    authentication: "none" as const,
  },
  registrationIdentity: modelRegistrationIdentity(model.registrationKey ?? "default"),
  effort: "medium",
  fast: false,
  requestVariant: "test",
  compaction,
})

vi.mock("@relayfx/sdk", (importOriginal) =>
  MockEffect.runPromise(
    MockEffect.gen(function* () {
      const actual = yield* MockEffect.tryPromise(() => importOriginal<typeof import("@relayfx/sdk")>())
      const { Layer: EffectLayer } = yield* MockEffect.tryPromise(() => import("effect"))
      return {
        ...actual,
        Client: {
          ...actual.Client,
          layerFromRuntime: EffectLayer.suspend(() => EffectLayer.succeed(actual.Client.Service, native.client!)),
        },
        Runtime: {
          ...actual.Runtime,
          layerEmbedded: (options: {
            readonly childFanOutHostLayer: Layer.Layer<ChildFanOutHost.Service>
            readonly workflowDefinitionHostLayer: Layer.Layer<WorkflowDefinitionHost.Service>
          }) => {
            native.runtimeGraphs += 1
            return EffectLayer.merge(options.childFanOutHostLayer, options.workflowDefinitionHostLayer).pipe(
              EffectLayer.provideMerge(EffectLayer.succeed(actual.Client.Service, native.client!)),
            )
          },
        },
      }
    }),
  ),
)

vi.mock("@relayfx/sdk/sqlite", () => ({
  SQLite: {
    database: (options: Record<string, unknown>) => {
      native.databaseAcquisitions += 1
      native.databaseOptions.push(options)
      return {}
    },
  },
}))

const selection = { provider: "test", model: "model" }
const unused = () => Effect.die("unused client method")
const clientFailure = (message: string) => Client.ClientError.make({ message })
const relayEvent = (
  type: Execution.ExecutionEvent["type"],
  sequence: number,
  content?: Execution.ExecutionEvent["content"],
  data?: Execution.ExecutionEvent["data"],
): Execution.ExecutionEvent => ({
  execution_id: Ids.ExecutionId.make("execution:turn-a"),
  type,
  sequence,
  cursor: `cursor-${sequence}`,
  ...(content === undefined ? {} : { content }),
  ...(data === undefined ? {} : { data }),
  created_at: sequence * 10,
})

type MakeClientOptions = {
  readonly startStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly existingStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly streamEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly streamFailure?: string
  readonly replayEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly pageEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly openWaitIds?: ReadonlyArray<string>
  readonly cancelStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly unavailableLookups?: number
  readonly fail?: "register" | "start" | "lookup" | "replay" | "cancel"
}

type ClientFixture = {
  readonly implementation: Client.Interface
  readonly registrations: Ref.Ref<ReadonlyArray<any>>
  readonly starts: Ref.Ref<ReadonlyArray<any>>
  readonly lookups: Ref.Ref<ReadonlyArray<any>>
  readonly replays: Ref.Ref<ReadonlyArray<any>>
  readonly pages: Ref.Ref<ReadonlyArray<any>>
  readonly cancellations: Ref.Ref<ReadonlyArray<any>>
}

const makeClientImpl: (options?: MakeClientOptions) => Effect.Effect<ClientFixture, never, never> = Effect.fn(
  "ExecutionBackendTest.makeClient",
)(function* (options?: MakeClientOptions) {
  const registrations = yield* Ref.make<
    ReadonlyArray<{
      readonly id?: unknown
      readonly address?: unknown
      readonly agent?: unknown
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly permissions?: unknown
      readonly handoff_targets?: unknown
      readonly max_wait_turns?: unknown
    }>
  >([])
  const starts = yield* Ref.make<
    ReadonlyArray<Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]>
  >([])
  const lookups = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["get"]>[0]>>([])
  const replays = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["replay"]>[0]>>([])
  const pages = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["pageEvents"]>[0]>>([])
  const cancellations = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["cancel"]>[0]>>([])
  const nextRevision = yield* Ref.make(40)
  const flat = {
    registerAgent: <Tools extends Record<string, import("effect/unstable/ai").Tool.Any>, Requirements>(
      input: Client.RegisterAgentInput<Tools, Requirements>,
    ) =>
      Ref.update(registrations, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.getAndUpdate(nextRevision, (revision) => revision + 1)),
        Effect.flatMap((revision) =>
          options?.fail === "register"
            ? Effect.fail(clientFailure("register failed"))
            : Effect.succeed({
                record: {
                  id: input.id,
                  current_revision: revision,
                  definition: { name: "rika", model: selection, tool_names: [], permissions: [] },
                  created_at: 0,
                  updated_at: 0,
                },
              }),
        ),
      ),
    registerAgentDefinition: unused,
    getAgentDefinition: unused,
    listAgentDefinitions: unused,
    listAgentDefinitionRevisions: unused,
    getSkillDefinition: unused,
    listSkillDefinitions: unused,
    listSkillDefinitionRevisions: unused,
    registerAddressBookRoute: unused,
    getAddressBookRoute: unused,
    listAddressBookRoutes: unused,
    startExecution: unused,
    startExecutionByAddress: unused,
    startExecutionByAgentDefinition: (input: Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]) =>
      Ref.update(starts, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "start"
            ? Effect.fail(clientFailure("start failed"))
            : Effect.succeed({
                execution_id: input.execution_id ?? Ids.ExecutionId.make("execution:fallback"),
                status: options?.startStatus ?? "running",
              }),
        ),
      ),
    cancelExecution: (input: Parameters<Client.Interface["executions"]["cancel"]>[0]) =>
      Ref.update(cancellations, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "cancel"
            ? Effect.fail(clientFailure("cancel failed"))
            : Effect.succeed({ execution_id: input.execution_id, status: options?.cancelStatus ?? "running" }),
        ),
      ),
    steer: unused,
    getExecution: (input: Parameters<Client.Interface["executions"]["get"]>[0]) =>
      Ref.update(lookups, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.get(lookups)),
        Effect.flatMap((values) =>
          options?.fail === "lookup"
            ? Effect.fail(clientFailure("lookup failed"))
            : Effect.succeed(
                options?.existingStatus === undefined || values.length <= (options.unavailableLookups ?? 0)
                  ? undefined
                  : {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: options.existingStatus,
                      created_at: 1,
                      updated_at: 1,
                    },
              ),
        ),
      ),
    inspectExecution: () =>
      Effect.succeed({
        execution_id: Ids.ExecutionId.make("execution:turn-a"),
        status: options?.openWaitIds === undefined || options.openWaitIds.length === 0 ? "running" : "waiting",
        waiting_on: (options?.openWaitIds ?? []).map((waitId) => ({
          wait_id: Ids.WaitId.make(waitId),
          execution_id: Ids.ExecutionId.make("execution:turn-a"),
          mode: "reply" as const,
          state: "open" as const,
          metadata: {},
          created_at: 1,
        })),
        pending_tool_calls: [],
        child_runs: [],
      }),
    listExecutions: unused,
    listSessions: unused,
    getSession: unused,
    listWaits: unused,
    replayExecution: (input: Parameters<Client.Interface["executions"]["replay"]>[0]) =>
      Ref.update(replays, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "replay"
            ? Effect.fail(clientFailure("replay failed"))
            : Effect.succeed({ events: options?.replayEvents ?? [] }),
        ),
      ),
    pageExecutionEvents: (input: Parameters<Client.Interface["executions"]["pageEvents"]>[0]) =>
      Ref.update(pages, (values) => [...values, input]).pipe(
        Effect.as({
          events: options?.pageEvents ?? [],
          has_more: true,
          oldest_cursor: "oldest",
          newest_cursor: "newest",
        }),
      ),
    listRunners: unused,
    routeExecution: unused,
    send: unused,
    streamExecution: () =>
      options?.streamFailure === undefined
        ? Stream.fromIterable(options?.streamEvents ?? [])
        : Stream.concat(
            Stream.fromIterable(options.streamEvents ?? []),
            Stream.fail(clientFailure(options.streamFailure)),
          ),
    followExecution: () =>
      Stream.fromIterable(
        (options?.streamFailure === undefined
          ? options?.streamEvents
          : (options?.replayEvents ?? options?.streamEvents ?? [])
        )?.map((event) => ({ _tag: "event" as const, event })) ?? [],
      ),
    wake: unused,
    listPendingApprovals: unused,
    resolveToolApproval: unused,
    resolvePermission: unused,
    listPendingToolCalls: unused,
    fulfillToolCall: unused,
    claimToolWork: unused,
    completeToolWork: unused,
    releaseToolWork: unused,
    listToolAttempts: unused,
    submitInboundEnvelope: unused,
    spawnChildRun: unused,
    createChildFanOut: unused,
    inspectChildFanOut: unused,
    cancelChildFanOut: unused,
    registerWorkflowDefinition: unused,
    getWorkflowDefinitionRevision: unused,
    listWorkflowDefinitionRevisions: unused,
    startWorkflowRun: unused,
    inspectWorkflowRun: unused,
    replayWorkflowRun: unused,
    cancelWorkflowRun: unused,
    claimEnvelopeReady: unused,
    ackEnvelopeReady: unused,
    releaseEnvelopeReady: unused,
    createSchedule: unused,
    cancelSchedule: unused,
    listSchedules: unused,
    registerEntityKind: unused,
    getOrCreateEntity: unused,
    getEntity: unused,
    destroyEntity: unused,
    listEntities: unused,
    getEntityState: unused,
    putEntityState: unused,
    deleteEntityState: unused,
    listEntityState: unused,
    listInboxMessages: unused,
    askEntity: unused,
    awaitWait: unused,
    subscribeTopic: unused,
    unsubscribeTopic: unused,
    publishTopic: unused,
    listTopicSubscriptions: unused,
    getPresence: unused,
    streamSession: () => Stream.empty,
    watchExecutions: () => Stream.empty,
    watchPresence: () => Stream.empty,
  }
  const implementation = {
    agents: { register: flat.registerAgent },
    executions: {
      startByAgentDefinition: flat.startExecutionByAgentDefinition,
      cancel: flat.cancelExecution,
      steer: flat.steer,
      get: flat.getExecution,
      inspect: flat.inspectExecution,
      replay: flat.replayExecution,
      pageEvents: flat.pageExecutionEvents,
      stream: flat.streamExecution,
      follow: flat.followExecution,
    },
    tools: {
      listPendingApprovals: flat.listPendingApprovals,
      resolveApproval: flat.resolveToolApproval,
      resolvePermission: flat.resolvePermission,
    },
    childRuns: {
      spawn: flat.spawnChildRun,
      createFanOut: flat.createChildFanOut,
      inspectFanOut: flat.inspectChildFanOut,
      cancelFanOut: flat.cancelChildFanOut,
    },
    workflows: {
      registerDefinition: flat.registerWorkflowDefinition,
      startRun: flat.startWorkflowRun,
      inspectRun: flat.inspectWorkflowRun,
      cancelRun: flat.cancelWorkflowRun,
    },
    residents: {
      registerKind: flat.registerEntityKind,
      spawn: flat.getOrCreateEntity,
      get: flat.getEntity,
      destroy: flat.destroyEntity,
    },
    envelopes: { send: flat.send },
  } as unknown as Client.Interface
  return { implementation, registrations, starts, lookups, replays, pages, cancellations }
})

const provideConfiguredBackend = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  implementation: Client.Interface,
  options: Parameters<typeof layerFromClient<AdditionalTools>>[0],
  additionalLayer: Layer.Layer<never> = Layer.empty,
) => {
  const contextLayer = Layer.merge(
    layerFromClient(options).pipe(Layer.provide(Layer.succeed(Client.Service, implementation))),
    additionalLayer,
  )
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

const provideBackend = (implementation: Client.Interface) => provideConfiguredBackend(implementation, { selection })

const provideBackendWithThreadTools = (implementation: Client.Interface) => {
  const contextLayer = layerFromClient({
    selection,
    additionalToolkit: ThreadToolkits.ThreadContract.toolkit,
  }).pipe(Layer.provide(Layer.succeed(Client.Service, implementation)))
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

const makeClient = (options?: Record<string, unknown>): Effect.Effect<ClientFixture, never, never> =>
  makeClientImpl(options as Parameters<typeof makeClientImpl>[0]) as Effect.Effect<ClientFixture, never, never>

const makeClientForFixture: (...args: Parameters<typeof makeClient>) => ReturnType<typeof makeClient> = (...args) =>
  makeClient(...args)

export const fixture: {
  readonly native: typeof native
  readonly routeFor: typeof routeFor
  readonly selection: typeof selection
  readonly unused: typeof unused
  readonly clientFailure: typeof clientFailure
  readonly relayEvent: typeof relayEvent
  readonly makeClient: typeof makeClientForFixture
  readonly provideConfiguredBackend: typeof provideConfiguredBackend
  readonly provideBackend: typeof provideBackend
  readonly provideBackendWithThreadTools: typeof provideBackendWithThreadTools
  readonly RelayExecutionBackend: typeof RelayExecutionBackend
} = {
  native,
  routeFor,
  selection,
  unused,
  clientFailure,
  relayEvent,
  makeClient: makeClientForFixture,
  provideConfiguredBackend,
  provideBackend,
  provideBackendWithThreadTools,
  RelayExecutionBackend,
}
