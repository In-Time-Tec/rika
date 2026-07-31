import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import { ModelRegistry, ModelResilience } from "@batonfx/core"
import { EventHistory } from "@relayfx/sdk"
import { Effect, Function, Layer, Ref, Schedule, Semaphore, Stream } from "effect"
import { LanguageModel, Tool, Toolkit, type Toolkit as AiToolkit } from "effect/unstable/ai"
import { executionEventHistoryFor } from "@rika/configuration/profile-data-paths"
import { AgentProfile } from "@rika/product/execution-child-run"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import {
  agentKeyForName,
  names as agentProfileNames,
  presets,
  resolve,
  resolveTitle,
} from "../../agent/definition/baton-agent-definition"

const modelSelectionKey = (selection: ModelRegistry.ModelSelection) =>
  JSON.stringify([selection.provider, selection.model, selection.registrationKey ?? null])

export const lazyModelRegistryLayer = (
  registrations: ReadonlyArray<ModelRegistry.Registration>,
): Layer.Layer<ModelRegistry.ModelRegistry> =>
  Layer.effect(
    ModelRegistry.ModelRegistry,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const memoMap = yield* Layer.makeMemoMap
      const admission = yield* Semaphore.make(1)
      type Entry = {
        readonly registration: ModelRegistry.Registration
        readonly context: Effect.Effect<import("effect").Context.Context<ModelRegistry.ModelEnvironment>>
      }
      const makeEntry = (registration: ModelRegistry.Registration) =>
        Effect.cached(
          Layer.buildWithMemoMap(registration.layer, memoMap, scope).pipe(
            Effect.map((context) => context as import("effect").Context.Context<ModelRegistry.ModelEnvironment>),
          ),
        ).pipe(Effect.map((context) => ({ registration, context }) satisfies Entry))
      const initialEntries = yield* Effect.forEach(registrations, makeEntry)
      const entries = yield* Ref.make(
        new Map(initialEntries.map((entry) => [modelSelectionKey(entry.registration), entry] as const)),
      )
      const find = (selection: ModelRegistry.ModelSelection) =>
        Ref.get(entries).pipe(
          Effect.map((current) => current.get(modelSelectionKey(selection))),
          Effect.flatMap((entry) =>
            entry === undefined
              ? Effect.fail(
                  ModelRegistry.LanguageModelNotRegistered.make({
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
                  }),
                )
              : Effect.succeed(entry),
          ),
        )
      const operate: ModelRegistry.Interface["operate"] = (selection, operation) =>
        find(selection).pipe(
          Effect.flatMap((entry) => entry.context),
          Effect.flatMap((context) => operation.pipe(Effect.provide(context))),
        )
      const stream = ((selection: ModelRegistry.ModelSelection, operation: Stream.Stream<unknown, unknown, unknown>) =>
        Stream.unwrap(
          find(selection).pipe(
            Effect.flatMap((entry) => entry.context),
            Effect.map((context) => operation.pipe(Stream.provideContext(context))),
          ),
        )) as ModelRegistry.Interface["stream"]
      return ModelRegistry.ModelRegistry.of({
        register: ({ registration }) =>
          admission.withPermits(1)(
            makeEntry(registration).pipe(
              Effect.flatMap((entry) =>
                Ref.update(entries, (current) => new Map(current).set(modelSelectionKey(registration), entry)),
              ),
            ),
          ),
        registrations: Ref.get(entries).pipe(
          Effect.map((current) => Array.from(current.values(), (entry) => entry.registration)),
        ),
        operate,
        stream,
      })
    }),
  )

export const defaultModelResilience: ModelResilience.Interface = ModelResilience.make({
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
})

export const withResilience = (input: {
  readonly registration: ModelRegistry.Registration
  readonly resilience: ModelResilience.Interface | undefined
}): ModelRegistry.Registration => {
  const resilience = input.resilience
  if (resilience === undefined) return input.registration
  const modelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map((model) => ModelResilience.apply(model, resilience))),
  ).pipe(Layer.provideMerge(input.registration.layer))
  return { ...input.registration, layer: modelLayer }
}

export const eventHistoryOption = (filename: string): { readonly eventHistory?: EventHistory.FileSystemConfig } =>
  filename === ":memory:"
    ? {}
    : { eventHistory: EventHistory.fileSystem({ directory: executionEventHistoryFor(filename) }) }

export const relayModelSelection = (selection: ModelRegistry.ModelSelection) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

export const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(options: {
  readonly additionalToolkit?: AiToolkit.Toolkit<AdditionalTools>
}) =>
  Toolkit.make(
    ...(Object.values(RikaToolRuntime.toolkit.tools) as Array<Tool.Any>),
    ...(Object.values(AgentToolkits.AgentContract.modelToolkit.tools) as Array<Tool.Any>),
    ...(Object.values(AgentToolkits.AgentContract.joinToolkit.tools) as Array<Tool.Any>),
    ...(Object.values(options.additionalToolkit?.tools ?? {}) as Array<Tool.Any>),
  )

export const availableTools = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly options: { readonly additionalToolkit?: AiToolkit.Toolkit<AdditionalTools> }
  readonly names: ReadonlyArray<string>
}) => {
  const available = toolkitFor(input.options).tools
  return input.names.filter((name) => name in available)
}

export const webSearchFactories: typeof WebSearchProvider.configuredProviderFactories =
  WebSearchProvider.configuredProviderFactories
export const modelVariantKey: { (fast: boolean): (effort: string) => string; (effort: string, fast: boolean): string } =
  Function.dual(2, (effort: string, fast: boolean) => `effort:${effort}${fast ? ":fast" : ""}`)
export const variantSelection = (input: {
  readonly selection: ModelRegistry.ModelSelection
  readonly effort: string | undefined
  readonly fast: boolean
  readonly policy: "registration-key" | "fixed-selection"
}) =>
  input.policy === "fixed-selection" || (input.effort === undefined && !input.fast)
    ? input.selection
    : { ...input.selection, registrationKey: modelVariantKey(input.effort ?? "medium", input.fast) }
export const pinnedSelection = (route: ExecutionRoutePin["main"]): ModelRegistry.ModelSelection => ({
  provider: route.providerConnection.provider,
  model: route.model,
  registrationKey: route.registrationIdentity,
})
export const routeForProfile = (input: { readonly pin: ExecutionRoutePin; readonly profile: AgentProfile }) => {
  const key = agentKeyForName(input.profile)
  const configured = key === undefined ? undefined : input.pin.agents?.[key]
  return configured ?? (input.profile === "Task" || input.profile === "Surgeon" ? input.pin.main : input.pin.oracle)
}
export const usesMainRoute = (profile: AgentProfile) => profile === "Task" || profile === "Surgeon"
export const agentSelections = (pin: ExecutionRoutePin) =>
  pin.agents === undefined
    ? undefined
    : (Object.fromEntries(
        agentProfileNames.map((name) => [name, pinnedSelection(routeForProfile({ pin, profile: name }))]),
      ) as Partial<Readonly<Record<AgentProfile, ModelRegistry.ModelSelection>>>)
export const resolvePreset: typeof resolve = resolve
export const resolveTitlePreset: typeof resolveTitle = resolveTitle
export const configuredPresets = presets
export const pinnedCompactionPolicy = (input: {
  readonly route: ExecutionRoutePin["main"]
  readonly summaryModel: ExecutionRoutePin["compactionSummary"] | undefined
}) => ({
  context_window: input.route.compaction.contextWindow,
  reserve_tokens: input.route.compaction.reserveTokens,
  keep_recent_tokens: input.route.compaction.keepRecentTokens,
  ...(input.summaryModel === undefined
    ? {}
    : { summary_model: relayModelSelection(pinnedSelection(input.summaryModel)) }),
})
export const compactionPolicy = (input: {
  readonly compaction:
    | { readonly contextWindow?: number; readonly reserveTokens?: number; readonly keepRecentTokens?: number }
    | undefined
  readonly summaryModel: ModelRegistry.ModelSelection | undefined
}) =>
  input.compaction?.contextWindow === undefined ||
  input.compaction.reserveTokens === undefined ||
  input.compaction.keepRecentTokens === undefined
    ? undefined
    : {
        context_window: input.compaction.contextWindow,
        reserve_tokens: input.compaction.reserveTokens,
        keep_recent_tokens: input.compaction.keepRecentTokens,
        ...(input.summaryModel === undefined ? {} : { summary_model: relayModelSelection(input.summaryModel) }),
      }
