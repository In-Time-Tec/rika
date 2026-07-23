import { createHash } from "node:crypto"
import { type Agent, ArtifactStore, type Client, Ids, PromptAssembler } from "@relayfx/sdk"
import { Effect, Layer } from "effect"
import * as DataBlobStore from "./data-blob-store"

const startedWorkPrefixes = ["tool.call.", "tool.result.", "child_run.", "child_fan_out."]

export interface ObservedEvent {
  readonly type: string
}

export const unsafeStartupReplay = (events: ReadonlyArray<ObservedEvent>): boolean =>
  events.filter((event) => event.type === "execution.started").length > 1 &&
  events.some((event) => startedWorkPrefixes.some((prefix) => event.type.startsWith(prefix)))

export const baselineDigest = (system: string): string => createHash("sha256").update(system).digest("hex")

export const deterministicSystem = (agent: Agent.Definition): string =>
  [
    `Agent: ${agent.name}`,
    agent.instructions ?? "",
    `Available tools: ${JSON.stringify([...agent.tool_names].toSorted())}`,
  ]
    .filter((segment) => segment.length > 0)
    .join("\n\n")

const metadataExecutionId = (metadata: Agent.Definition["metadata"]): string | undefined => {
  const value = metadata?.rika_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const executionIdFrom = (agent: Agent.Definition): string | undefined =>
  metadataExecutionId(agent.metadata) ?? metadataExecutionId(agent.model.metadata)

export const assemblerLayer = (client: Effect.Effect<Client.Interface>): Layer.Layer<PromptAssembler.Service> =>
  Layer.effect(
    PromptAssembler.Service,
    Effect.gen(function* () {
      const base = yield* PromptAssembler.Service
      return PromptAssembler.Service.of({
        assemble: (input) =>
          Effect.gen(function* () {
            const resolved = yield* base.assemble(input)
            const assembled = { system: deterministicSystem(input.agent), prompt: resolved.prompt }
            const executionId = executionIdFrom(input.agent)
            const annotations = {
              "rika.context.baseline.sha256": baselineDigest(assembled.system),
              "rika.context.baseline.length": assembled.system.length,
              ...(executionId === undefined ? {} : { "rika.execution.id": executionId }),
            }
            if (executionId === undefined) {
              yield* Effect.logDebug("context.baseline.assembled").pipe(Effect.annotateLogs(annotations))
              return assembled
            }
            const relay = yield* client
            const events = yield* relay.executions.replay({ execution_id: Ids.ExecutionId.make(executionId) }).pipe(
              Effect.map((result): ReadonlyArray<ObservedEvent> => result.events),
              Effect.orElseSucceed((): ReadonlyArray<ObservedEvent> => []),
            )
            if (!unsafeStartupReplay(events)) {
              yield* Effect.logInfo("context.baseline.accepted").pipe(Effect.annotateLogs(annotations))
              return assembled
            }
            yield* Effect.logWarning("execution.recovery.rejected").pipe(Effect.annotateLogs(annotations))
            return yield* PromptAssembler.PromptAssemblerError.make({
              message: `Execution ${executionId} was recovered before its first durable checkpoint after tool or delegation work had started; Rika fails this recovery instead of replaying startup with a fresh model turn`,
            })
          }),
      })
    }),
  ).pipe(
    Layer.provide(PromptAssembler.defaultLayerWithStores),
    Layer.provide(DataBlobStore.layer),
    Layer.provide(ArtifactStore.passthroughLayer),
  )
