import { Effect, Layer, Option, Semaphore } from "effect"
import { Tool } from "effect/unstable/ai"
import { Client, Ids } from "@relayfx/sdk"
import { ModelRegistry } from "@batonfx/core"
import { Service } from "@rika/product/execution-service"
import type { Resident } from "@relayfx/sdk"
import * as ThreadHost from "./host/relay-thread-host"
import * as ExecutionMapping from "./relay-event-mapping"
import { failureKind } from "./relay-execution-tree"
import * as Follow from "./relay-execution-follow"
import { childExecutionMethods } from "./relay-child-execution-methods"
import { controlMethods } from "./relay-execution-control-methods"
import { makeThreadHostLifecycle } from "./relay-execution-host-lifecycle"
import { makeStartMethod } from "./relay-execution-start-method"
import type { LayerOptions } from "./relay-execution-adapter"
import { childExecutionDepth, toolsAtDepth } from "../../agent-depth"

const addressId = Ids.AddressId.make("address:rika")

export const layerFromClient = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  options: Pick<
    LayerOptions<AdditionalTools>,
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "additionalToolkit"
    | "compaction"
    | "oracleCompaction"
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  > & {
    readonly workspace?: string
    readonly resolveWorkspace?: LayerOptions["resolveWorkspace"]
    readonly webSearchCredentials?: LayerOptions["webSearchCredentials"]
    readonly registerModels?: (registrations: ReadonlyArray<ModelRegistry.Registration>) => Effect.Effect<void>
    readonly onClientReady?: (client: Client.Interface) => Effect.Effect<void>
    readonly attemptCost?: { readonly amount: number; readonly currency: string } | undefined
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Client.Service
      if (options.onClientReady !== undefined) yield* options.onClientReady(client)
      const registry =
        Option.getOrUndefined(yield* Effect.serviceOption(ThreadHost.Registry)) ?? (yield* ThreadHost.makeRegistry)
      const hostInstances = new Map<string, Resident.Instance>()
      const hostReady = yield* Effect.cached(
        Effect.gen(function* () {
          yield* client.agents.register({
            id: ThreadHost.hostAgentId,
            name: "rika-thread-host",
            instructions: "Promote pending Rika turns delivered to this thread host.",
            model: ThreadHost.hostSelection,
            tools: Object.values(ThreadHost.toolkit.tools).map((tool) => ({ name: tool.name })),
            permissions: [
              { name: "relay.inbox.wait", value: true },
              { name: "relay.inbox.send", value: true },
            ],
            max_wait_turns: ThreadHost.hostMaxWaitTurns,
            metadata: { steering_enabled: false, inbox_enabled: true },
          })
          yield* client.residents.registerKind({
            kind: ThreadHost.entityKind,
            agent_id: ThreadHost.hostAgentId,
            inbox: { drain: "all" },
            state_enabled: false,
            continue_as_new_after_turns: ThreadHost.continueAsNewAfterTurns,
            metadata: { product: "rika" },
          })
        }),
      )
      const hostGate = yield* Semaphore.make(1)
      const { hostInstance, awaitParkedHost } = makeThreadHostLifecycle({ client, hostReady, hostInstances })
      return Service.of({
        ...(options.registerModels === undefined ? {} : { registerModels: options.registerModels }),
        wakeThreadHost: ThreadHost.wakeThreadHost({
          client,
          addressId,
          hostGate,
          hostInstance,
          awaitParkedHost,
          failureKind,
        }),
        registerTurnPromoter: (promoter) => registry.register(promoter),
        ...childExecutionMethods({
          client,
          options,
          context: { addressId, childExecutionDepth, toolsAtDepth },
        }),
        start: makeStartMethod({ client, options: { ...options, attemptCost: options.attemptCost } }),
        follow: Effect.fn(
          function* (turnId, afterCursor, onEvent, reference, eventScope) {
            return yield* Follow.followExecution({
              client,
              turnId,
              afterCursor,
              onEvent,
              stopAtActionableWait: true,
              reference,
              eventScope: eventScope ?? "tree",
              attemptCost: options.attemptCost,
            }).pipe(Effect.mapError(ExecutionMapping.error))
          },
          (effect) => ExecutionMapping.traceWithoutResult({ name: "ExecutionBackend.follow", effect }),
        ),
        ...controlMethods(client),
      })
    }),
  )
