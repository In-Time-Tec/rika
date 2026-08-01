import { awaitExecutionAvailable } from "./relay-execution-wait"
import { startSessionId } from "./relay-execution-id-codec"
import { error, executionInput } from "./relay-event-payload"
import { traceWithoutResult } from "./relay-event-trace"
import { Clock, Effect, Fiber, Schema } from "effect"
import { Client, Ids } from "@relayfx/sdk"
import type { StartInput } from "@rika/product/execution-request"
import type { Result } from "@rika/product/execution-event"
import { BackendError } from "@rika/product/execution-service"
import type { Tool } from "effect/unstable/ai"
import type { LayerOptions } from "./relay-execution-adapter"
import * as IdentifierCodec from "./relay-execution-id-codec"
import * as Follow from "./relay-execution-follow"
import * as ToolRuntime from "./relay-tool-runtime"
import { rootPermissions } from "../../agent/definition/agent-permissions"
import { childPresets, rootInstructions, rootModel, rootTools } from "./relay-start-routing"
import { relayModelSelection } from "../../model/routing/relay-model-selection"
const addressId = Ids.AddressId.make("address:rika")
const agentId = Ids.AgentId.make("agent:rika")
const rootAgentName = "rika"

export type StartOptions<AdditionalTools extends Record<string, Tool.Any>> = Pick<
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

export const makeStartMethod = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly client: Client.Interface
  readonly options: StartOptions<AdditionalTools>
}): ((start: StartInput) => Effect.Effect<Result, BackendError>) =>
  Effect.fn(
    function* (start: StartInput) {
      const startedAt = yield* Clock.currentTimeMillis
      const id = IdentifierCodec.executionId({ turnId: start.turnId, reference: undefined })
      const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(start.executionRoute)
      const metadata = {
        steering_enabled: true,
        rika_execution_id: String(id),
        rika_thread_id: start.threadId,
        rika_agent_depth: 0,
        rika_reasoning_effort: start.reasoningEffort ?? start.executionRoute.main.effort,
        rika_execution_route: durableRoute,
      }
      const { rootCompaction, selection, oracleSelection } = rootModel({ options: input.options, start })
      const registered = yield* input.client.agents.register({
        id: agentId,
        address: addressId,
        name: rootAgentName,
        instructions: rootInstructions,
        model: relayModelSelection(selection),
        tools: rootTools(input.options),
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
        session_id: startSessionId(start),
        agent_id: agentId,
        agent_revision: registered.record.current_revision,
        input: executionInput(start),
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
      else yield* Effect.raceFirst(awaitExecutionAvailable({ client: input.client, id }), Fiber.join(starter))
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
    (effect) => traceWithoutResult({ name: "ExecutionBackend.start", effect: effect.pipe(Effect.mapError(error)) }),
  )
