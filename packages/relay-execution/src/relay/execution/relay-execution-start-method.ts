import { Clock, Effect, Fiber, Schema } from "effect"
import { Client, Ids } from "@relayfx/sdk"
import { ModelRegistry } from "@batonfx/core"
import type { StartInput } from "@rika/product/execution-request"
import type { Result } from "@rika/product/execution-event"
import { BackendError } from "@rika/product/execution-service"
import type { Tool } from "effect/unstable/ai"
import { AgentProfile } from "@rika/product/execution-child-run"
import type { LayerOptions } from "./relay-execution-adapter"
import * as Identifier from "./relay-execution-identifier"
import * as Mapping from "./relay-event-mapping"
import * as Follow from "./relay-execution-follow"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import * as ToolRuntime from "./relay-tool-runtime"
import { toolsAtDepth } from "../../agent-depth"
import { mainInstructions, presets, rootPermissions } from "../../agent/definition/baton-agent-definition"
const addressId = Ids.AddressId.make("address:rika")
const agentId = Ids.AgentId.make("agent:rika")
const rootAgentName = "rika"

type StartOptions<AdditionalTools extends Record<string, Tool.Any>> = Pick<
  LayerOptions<AdditionalTools>,
  | "selection"
  | "oracleSelection"
  | "compactionSummarySelection"
  | "defaultReasoningEffort"
  | "modelVariantPolicy"
  | "compaction"
  | "oracleCompaction"
  | "additionalToolkit"
> & { readonly attemptCost: { readonly amount: number; readonly currency: string } | undefined }

const childPresets = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly options: StartOptions<AdditionalTools>
  readonly start: StartInput
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection: ModelRegistry.ModelSelection | undefined
  readonly durableRoute: Schema.Json
}) =>
  Object.fromEntries(
    [1, 2].flatMap((childDepth) =>
      Object.entries(
        presets({
          model: input.selection,
          oracleModel: input.oracleSelection,
          ...(input.options.modelVariantPolicy === "fixed-selection"
            ? {}
            : { agentModels: ModelRouting.agentSelections(input.start.executionRoute) }),
        }),
      ).map(([name, preset]) => {
        const profile = name as AgentProfile
        const mainRoute = ModelRouting.usesMainRoute(profile)
        const profileRoute = ModelRouting.routeForProfile({ pin: input.start.executionRoute, profile })
        const effort = mainRoute
          ? (input.start.reasoningEffort ?? input.start.executionRoute.main.effort)
          : profileRoute.effort
        const policy =
          input.options.modelVariantPolicy === "fixed-selection"
            ? ModelRouting.compactionPolicy({
                compaction: mainRoute
                  ? input.options.compaction
                  : (input.options.oracleCompaction ?? input.options.compaction),
                summaryModel: input.options.compactionSummarySelection,
              })
            : ModelRouting.pinnedCompactionPolicy({
                route: profileRoute,
                summaryModel: input.start.executionRoute.compactionSummary,
              })
        return [
          `${name}:${childDepth}`,
          {
            ...preset,
            model: {
              ...preset.model,
              metadata: {
                rika_execution_route: input.durableRoute,
                rika_thread_id: input.start.threadId,
                rika_agent_depth: childDepth,
                rika_reasoning_effort: effort,
              },
            },
            tool_names: ModelRouting.availableTools({
              options: input.options,
              names: toolsAtDepth(preset.tool_names, childDepth),
            }),
            ...(policy === undefined ? {} : { compaction_policy: policy }),
            metadata: {
              ...preset.metadata,
              steering_enabled: true,
              rika_thread_id: input.start.threadId,
              rika_agent_depth: childDepth,
              rika_reasoning_effort: effort,
              rika_execution_route: input.durableRoute,
            },
          },
        ]
      }),
    ),
  )

export const makeStartMethod = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly client: Client.Interface
  readonly options: StartOptions<AdditionalTools>
}): ((start: StartInput) => Effect.Effect<Result, BackendError>) =>
  Effect.fn(
    function* (start: StartInput) {
      const startedAt = yield* Clock.currentTimeMillis
        const id = Identifier.executionId({ turnId: start.turnId, reference: undefined })
        const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(start.executionRoute)
        const metadata = {
          steering_enabled: true,
          rika_execution_id: String(id),
          rika_thread_id: start.threadId,
          rika_agent_depth: 0,
          rika_reasoning_effort: start.reasoningEffort ?? start.executionRoute.main.effort,
          rika_execution_route: durableRoute,
        }
        const rootCompaction =
          input.options.modelVariantPolicy === "fixed-selection"
            ? ModelRouting.compactionPolicy({
                compaction: input.options.compaction,
                summaryModel: input.options.compactionSummarySelection,
              })
            : ModelRouting.pinnedCompactionPolicy({
                route: start.executionRoute.main,
                summaryModel: start.executionRoute.compactionSummary,
              })
        const selection =
          input.options.modelVariantPolicy === "fixed-selection"
            ? ModelRouting.variantSelection({
                selection: input.options.selection,
                effort: start.reasoningEffort ?? input.options.defaultReasoningEffort,
                fast: start.fastMode === true,
                policy: input.options.modelVariantPolicy ?? "registration-key",
              })
            : ModelRouting.pinnedSelection(start.executionRoute.main)
        const oracleSelection =
          input.options.modelVariantPolicy === "fixed-selection"
            ? input.options.oracleSelection
            : ModelRouting.pinnedSelection(start.executionRoute.oracle)
        const registered = yield* input.client.agents.register({
          id: agentId,
          address: addressId,
          name: rootAgentName,
          instructions: mainInstructions,
          model: ModelRouting.relayModelSelection(selection),
          tools: Object.values(ModelRouting.toolkitFor(input.options).tools)
            .filter((tool) => tool.name !== "search_threads" && tool.name !== "read_thread_transcript")
            .map((tool) => ({ name: tool.name })),
          tool_execution: ToolRuntime.toolExecutionPolicy,
          permissions: rootPermissions,
          permission_rules: ToolRuntime.allowAllPermissionRules,
          metadata,
          ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
          child_run_presets: childPresets({
            options: input.options,
            start,
            selection,
            oracleSelection,
            durableRoute,
          }),
        })
        yield* Effect.logInfo("execution.starting").pipe(
          Effect.annotateLogs({ "rika.model.name": selection.model, "rika.model.provider": selection.provider }),
        )
        const startInput = {
          root_address_id: addressId,
          session_id: Identifier.startSessionId(start),
          agent_id: agentId,
          agent_revision: registered.record.current_revision,
          input: Mapping.executionInput(start),
          idempotency_key: start.turnId,
          execution_id: id,
          metadata,
        } as const
        const starter = yield* Effect.forkChild(
          input.client.executions.startByAgentDefinition(startInput).pipe(
            Effect.asVoid,
            Effect.catchTag("ClientError", (startError) =>
              input.client.executions.get(id).pipe(
                Effect.matchEffect({
                  onFailure: () => Effect.fail(startError),
                  onSuccess: (existing) => (existing === undefined ? Effect.fail(startError) : Effect.void),
                }),
              ),
            ),
          ),
        )
        yield* Effect.yieldNow
        const started = starter.pollUnsafe()
        if (started !== undefined) yield* Fiber.join(starter)
        else
          yield* Effect.raceFirst(Identifier.awaitExecutionAvailable({ client: input.client, id }), Fiber.join(starter))
        yield* Clock.currentTimeMillis.pipe(
          Effect.flatMap((acceptedAt) =>
            Effect.logInfo("execution.accepted").pipe(Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt)),
          ),
        )
      return yield* Follow.followExecution({
        client: input.client,
        turnId: start.turnId,
        afterCursor: undefined,
        onEvent: start.onEvent,
        stopAtActionableWait: true,
        reference: undefined,
        eventScope: start.eventScope ?? "tree",
        attemptCost: input.options.attemptCost,
      }).pipe(Effect.ensuring(Fiber.interrupt(starter)))
    },
    (effect) => Mapping.traceWithoutResult({ name: "ExecutionBackend.start", effect: effect.pipe(Effect.mapError(Mapping.error)) })
  )
