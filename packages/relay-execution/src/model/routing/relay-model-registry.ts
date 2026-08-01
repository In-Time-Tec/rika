import { ModelRegistry, ModelResilience } from "@batonfx/core"
import { EventHistory } from "@relayfx/sdk"
import { executionEventHistoryFor } from "@rika/configuration/profile-data-paths"
import { Effect, Layer, Ref, Schedule, Semaphore, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

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

export const eventHistoryOption = (filename: string): { readonly eventHistory?: EventHistory.FileSystemConfig } =>
  filename === ":memory:"
    ? {}
    : { eventHistory: EventHistory.fileSystem({ directory: executionEventHistoryFor(filename) }) }

export const defaultModelResilience: ModelResilience.Interface = ModelResilience.make({
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
})

export const withResilience = (input: {
  readonly registration: ModelRegistry.Registration
  readonly resilience: ModelResilience.Interface | undefined
}): ModelRegistry.Registration => {
  if (input.resilience === undefined) return input.registration
  const modelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map((model) => ModelResilience.apply(model, input.resilience!))),
  ).pipe(Layer.provideMerge(input.registration.layer))
  return { ...input.registration, layer: modelLayer }
}
