import { AiError, ModelRegistry, Response as AiResponse } from "@batonfx/core"
import { CellTool } from "@batonfx/repl"
import { TestModel } from "@batonfx/test"
import type * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"

export type Profile =
  | "Root"
  | "Title"
  | "Compaction"
  | "Oracle"
  | "Librarian"
  | "Painter"
  | "ReadThread"
  | "Review"
  | "Surgeon"
  | "Task"

export type Step = TestModel.Step
export type Part = TestModel.Part

export interface Lane {
  readonly profile?: Profile
  readonly steps: ReadonlyArray<Step>
}

const profiles: ReadonlyArray<Profile> = [
  "Root",
  "Title",
  "Compaction",
  "Oracle",
  "Librarian",
  "Painter",
  "ReadThread",
  "Review",
  "Surgeon",
  "Task",
]

const usage = (input: { readonly inputTokens?: number; readonly outputTokens?: number }) =>
  AiResponse.Usage.make({
    inputTokens: {
      uncached: input.inputTokens,
      total: input.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: input.outputTokens, text: input.outputTokens, reasoning: undefined },
  })

/** One `rika.<module>.<operation>(input)` call a scripted cell makes. */
export interface BindingCall {
  readonly module: string
  readonly operation: string
  readonly input?: unknown
}

export interface SpawnRequest {
  readonly profile: Profile
  readonly prompt: string
  readonly name?: string
}

/**
 * A cell that awaits one binding and returns its value. The model can only act through the cell, so
 * a scripted tool call is scripted cell source, and the source is what the transcript projects.
 */
const bindingSource = (call: BindingCall): string =>
  `await rika.${call.module}.${call.operation}(${JSON.stringify(call.input ?? {})})`

const spawnCall = (child: SpawnRequest): BindingCall => ({
  module: "agents",
  operation: "spawn",
  input: {
    profile: child.profile,
    prompt: child.prompt,
    ...(child.name === undefined ? {} : { name: child.name }),
  },
})

export const step = {
  text: (value: string, delayMillis?: number): Step =>
    TestModel.turn([TestModel.text(value)], delayMillis === undefined ? {} : { delay: `${delayMillis} millis` }),
  turn: (
    parts: ReadonlyArray<Part>,
    options: { readonly delayMillis?: number; readonly inputTokens?: number; readonly outputTokens?: number } = {},
  ): Step =>
    TestModel.turn(parts, {
      ...(options.delayMillis === undefined ? {} : { delay: `${options.delayMillis} millis` }),
      ...(options.inputTokens === undefined && options.outputTokens === undefined ? {} : { usage: usage(options) }),
    }),
  part: (value: string): Part => TestModel.text(value),
  reasoning: (value: string): Part => TestModel.reasoning(value),
  cell: (code: string, id: string): Part => TestModel.toolCall(CellTool.name, { code }, { id }),
  binding: (call: BindingCall, id: string): Part => step.cell(bindingSource(call), id),
  bindings: (calls: ReadonlyArray<BindingCall>, id: string): Part => step.cell(calls.map(bindingSource).join("\n"), id),
  spawn: (children: ReadonlyArray<SpawnRequest>, id: string): Part =>
    step.cell(
      children.length === 1
        ? bindingSource(spawnCall(children[0]!))
        : `await Promise.all([${children.map((child) => bindingSource(spawnCall(child))).join(", ")}])`,
      id,
    ),
  failure: (description: string, delayMillis?: number): Step =>
    TestModel.failure(
      AiError.make({
        module: "rika/baton-test-harness",
        method: "streamText",
        reason: AiError.UnknownError.make({ description }),
      }),
      delayMillis === undefined ? {} : { delay: `${delayMillis} millis` },
    ),
}

const identityFor = (profile: Profile) => `test-lane-${profile.toLowerCase()}`

const withLaneIdentity = (
  snapshot: ExecutionRouteSnapshot.ExecutionRouteModelSnapshot,
  profile: Profile,
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => {
  const identity = identityFor(profile)
  return {
    ...snapshot,
    registrationIdentity: identity as typeof snapshot.registrationIdentity,
    candidates: snapshot.candidates.map((candidate) => ({
      ...candidate,
      registrationIdentity: identity as typeof candidate.registrationIdentity,
    })),
  }
}

export const laneExecutionRoute = (mode = "test"): ExecutionRouteSnapshot.ExecutionRouteSnapshot => {
  const route = testExecutionRoute(mode)
  return {
    ...route,
    title: withLaneIdentity(route.title, "Title"),
    compactionSummary: withLaneIdentity(route.compactionSummary, "Compaction"),
    main: withLaneIdentity(route.main, "Root"),
    oracle: withLaneIdentity(route.oracle, "Oracle"),
    agents: {
      librarian: withLaneIdentity(route.agents.librarian, "Librarian"),
      painter: withLaneIdentity(route.agents.painter, "Painter"),
      readThread: withLaneIdentity(route.agents.readThread, "ReadThread"),
      review: withLaneIdentity(route.agents.review, "Review"),
      surgeon: withLaneIdentity(route.agents.surgeon, "Surgeon"),
      task: withLaneIdentity(route.agents.task, "Task"),
    },
  }
}

const idleSteps = Array.from({ length: 16 }, () => TestModel.turn([TestModel.text("idle")]))

export interface LaneModels {
  readonly registryLayer: Layer.Layer<ModelRegistry.ModelRegistry>
  readonly requestCount: Effect.Effect<number>
  readonly requestCountFor: (profile: Profile) => Effect.Effect<number>
}

export const makeLaneModels = Effect.fn("BatonTestHarness.makeLaneModels")(function* (
  lanes: ReadonlyArray<Lane>,
): Effect.gen.Return<LaneModels, never, Scope.Scope> {
  const declared = new Map(lanes.map((lane) => [lane.profile ?? "Root", lane.steps] as const))
  const fixtures = yield* Effect.forEach(profiles, (profile) =>
    TestModel.make(declared.get(profile) ?? idleSteps, {
      provider: "test",
      model: "test",
      registrationKey: identityFor(profile),
    }),
  )
  const registrations = yield* Effect.forEach(fixtures, (fixture, index) =>
    Layer.build(fixture.layer).pipe(
      Effect.flatMap((context) =>
        ModelRegistry.registration({
          provider: "test",
          model: "test",
          registrationKey: identityFor(profiles[index]!),
          layer: Layer.succeed(LanguageModel.LanguageModel, Context.get(context, LanguageModel.LanguageModel)),
        }),
      ),
    ),
  )
  return {
    registryLayer: ModelRegistry.layer(
      registrations.map((registration) => Effect.succeed({ ...registration, isAvailabilityFailure: () => false })),
    ),
    requestCount: Effect.forEach(fixtures, (fixture) => fixture.requests).pipe(
      Effect.map((batches) => batches.reduce((total, requests) => total + requests.length, 0)),
    ),
    requestCountFor: (profile) =>
      fixtures[profiles.indexOf(profile)]!.requests.pipe(Effect.map((requests) => requests.length)),
  } satisfies LaneModels
})
