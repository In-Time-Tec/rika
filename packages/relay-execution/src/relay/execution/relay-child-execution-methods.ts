import { Client, Content, Ids } from "@relayfx/sdk"
import type { Tool } from "effect/unstable/ai"
import { BackendError } from "@rika/product/execution-service"
import { Effect, Schema } from "effect"
import type { LayerOptions } from "./relay-execution-adapter"
import type { FanOutInput, InvokeChildInput } from "@rika/product/execution-child-run"
import * as Mapping from "./relay-event-mapping"
import * as Identifier from "./relay-execution-identifier"
const ExecutionMapping = Mapping
const ExecutionIdentifier = Identifier
import * as ModelRouting from "../../model/routing/relay-model-registry"
import { definitions, idFor } from "../relay-workflow-compiler"
import { childExecutionDepth } from "../../agent-depth"
import { resolve, resolveTitle } from "../../agent/definition/baton-agent-definition"
const executionRouteFromMetadata = Identifier.decodeExecutionRouteMetadata

export const childExecutionMethods = <AdditionalTools extends Record<string, Tool.Any>>(optionsInput: {
  readonly client: Client.Interface
  readonly options: Pick<
    LayerOptions<AdditionalTools>,
    | "additionalToolkit"
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "modelVariantPolicy"
    | "compaction"
    | "oracleCompaction"
  >
  readonly context: {
    readonly addressId: Ids.AddressId
    readonly childExecutionDepth: typeof childExecutionDepth
    readonly toolsAtDepth: (tools: ReadonlyArray<string>, depth: number) => ReadonlyArray<string>
  }
}) => {
  const { client, options, context } = optionsInput
  return {
    createFanOut: Effect.fn("ExecutionBackend.createFanOut")((input: FanOutInput) =>
      Effect.gen(function* () {
        const routePin = input.executionRoute
        const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin)
        const summaryModel = routePin?.compactionSummary
        const parentExecutionId = ExecutionIdentifier.executionId({ turnId: input.parentTurnId, reference: undefined })
        const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(ExecutionMapping.error))
        const threadId = ExecutionIdentifier.threadIdFromMetadata(parent?.metadata)
        const depth = context.childExecutionDepth(String(parentExecutionId)) + 1
        const children = yield* Effect.forEach(input.children, (child) => {
          const profile = child.profile ?? "Task"
          const profileRoute = ModelRouting.routeForProfile({ pin: routePin, profile })
          const mainRoute = ModelRouting.usesMainRoute(profile)
          let selected = ModelRouting.pinnedSelection(profileRoute)
          if (options.modelVariantPolicy === "fixed-selection")
            selected = mainRoute ? options.selection : (options.oracleSelection ?? options.selection)
          const preset = resolve(profile, selected).preset
          const policy =
            options.modelVariantPolicy === "fixed-selection"
              ? ModelRouting.compactionPolicy({
                  compaction: mainRoute ? options.compaction : (options.oracleCompaction ?? options.compaction),
                  summaryModel: options.compactionSummarySelection,
                })
              : ModelRouting.pinnedCompactionPolicy({ route: profileRoute, summaryModel })
          const effort = profileRoute.effort
          return Effect.succeed({
            child_execution_id: ExecutionIdentifier.makeChildExecutionId({
              parentTurnId: input.parentTurnId,
              childId: child.childId,
            }),
            address_id: context.addressId,
            input: [Content.text(child.prompt)],
            override: {
              ...preset,
              model: {
                ...preset.model,
                metadata: {
                  rika_execution_route: durableRoute,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: effort,
                },
              },
              tool_names: ModelRouting.availableTools({
                options,
                names: context.toolsAtDepth(preset.tool_names, depth),
              }),
              ...(policy === undefined ? {} : { compaction_policy: policy }),
            },
            metadata: {
              product_profile: profile,
              steering_enabled: true,
              rika_agent_depth: depth,
              rika_reasoning_effort: effort,
              ...(input.workspace === undefined ? {} : { rika_workspace: input.workspace }),
              ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
              rika_execution_route: durableRoute,
            },
          })
        })
        const state = yield* client.childRuns.createFanOut({
          fan_out_id: Ids.ChildFanOutId.make(input.fanOutId),
          parent_execution_id: parentExecutionId,
          children,
          max_concurrency: input.maxConcurrency,
          join:
            input.join === "quorum"
              ? { _tag: "quorum", count: input.quorum ?? input.children.length }
              : { _tag: input.join },
          created_at: input.createdAt,
        })
        return ExecutionMapping.mapFanOut(state)
      }).pipe(Effect.mapError(ExecutionMapping.error)),
    ),
    inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId: string) {
      const result = yield* client.childRuns
        .inspectFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
        .pipe(Effect.mapError(ExecutionMapping.error))
      return result.fan_out === null ? undefined : ExecutionMapping.mapFanOut(result.fan_out)
    }),
    cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (
      fanOutId: string,
      cancelledAt: number,
      reason: string | undefined,
    ) {
      const result = yield* client.childRuns
        .cancelFanOut({
          fan_out_id: Ids.ChildFanOutId.make(fanOutId),
          cancelled_at: cancelledAt,
          ...(reason === undefined ? {} : { reason }),
        })
        .pipe(Effect.mapError(ExecutionMapping.error))
      return ExecutionMapping.mapFanOut(result.fan_out)
    }),
    registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
      return yield* Effect.forEach(definitions, (definition) => client.workflows.registerDefinition(definition), {
        concurrency: 1,
      }).pipe(
        Effect.map((records) =>
          records.map(({ record }) => ({
            name: record.definition.name,
            revision: record.revision,
            digest: record.digest,
          })),
        ),
        Effect.mapError(ExecutionMapping.error),
      )
    }),
    startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(function* (
      name: string,
      runId: string,
      revision: number | undefined,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .startRun({
          execution_id: ExecutionIdentifier.workflowExecutionId({ runId, ownerTurnId, workspace }),
          workflow_definition_id: idFor(name),
          ...(revision === undefined ? {} : { revision }),
        })
        .pipe(Effect.mapError(ExecutionMapping.error))
      return ExecutionMapping.workflow(result)
    }),
    inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .inspectRun(ExecutionIdentifier.workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(ExecutionMapping.error))
      return result === undefined ? undefined : ExecutionMapping.workflow(result)
    }),
    cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (
      runId: string,
      ownerTurnId: string | undefined,
      workspace: string | undefined,
    ) {
      const result = yield* client.workflows
        .cancelRun(ExecutionIdentifier.workflowExecutionId({ runId, ownerTurnId, workspace }))
        .pipe(Effect.mapError(ExecutionMapping.error))
      return result === undefined ? undefined : ExecutionMapping.workflow(result)
    }),
    invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input: InvokeChildInput) {
      const parentExecutionId = ExecutionIdentifier.executionId({ turnId: input.parentTurnId, reference: undefined })
      const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(ExecutionMapping.error))
      const routePin = parent === undefined ? undefined : executionRouteFromMetadata(parent.metadata)
      if (parent === undefined || routePin === undefined)
        return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned model route` })
      const route =
        input.profile === "Title"
          ? routePin.title
          : ModelRouting.routeForProfile({ pin: routePin, profile: input.profile })
      if (route === undefined)
        return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned title route` })
      const preset =
        input.profile === "Title"
          ? resolveTitle(ModelRouting.pinnedSelection(route))
          : resolve(input.profile, ModelRouting.pinnedSelection(route)).preset
      const depth = context.childExecutionDepth(String(parentExecutionId)) + 1
      const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
        Effect.mapError(ExecutionMapping.error),
      )
      const threadId = ExecutionIdentifier.threadIdFromMetadata(parent.metadata)
      yield* client.childRuns
        .spawn({
          execution_id: parentExecutionId,
          child_execution_id: ExecutionIdentifier.makeChildExecutionId({
            parentTurnId: input.parentTurnId,
            childId: input.childId,
          }),
          address_id: context.addressId,
          input: [Content.text(input.prompt)],
          instructions: preset.instructions,
          model: {
            ...preset.model,
            metadata: {
              rika_execution_route: durableRoute,
              rika_agent_depth: depth,
              rika_reasoning_effort: route.effort,
              ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
            },
          },
          tool_names:
            input.profile === "Title"
              ? []
              : ModelRouting.availableTools({
                  options,
                  names: context.toolsAtDepth(preset.tool_names, depth),
                }),
          permissions: preset.permissions,
          ...(input.profile === "Title"
            ? {}
            : {
                compaction_policy: ModelRouting.pinnedCompactionPolicy({
                  route,
                  summaryModel: routePin.compactionSummary,
                }),
              }),
          metadata: {
            product_profile: input.profile,
            steering_enabled: true,
            rika_agent_depth: depth,
            rika_permissions: [...preset.permissions],
            rika_reasoning_effort: route.effort,
            ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
            rika_execution_route: durableRoute,
          },
          wait: false,
        })
        .pipe(Effect.mapError(ExecutionMapping.error))
      return {
        parentTurnId: input.parentTurnId,
        childId: input.childId,
        profile: input.profile,
        type: "accepted" as const,
      }
    }),
  }
}
