import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Goal, exhausted } from "@rika/product/goal-record"
import * as GoalRepository from "@rika/product/goal-repository"

export class GoalUnavailable extends Schema.TaggedError<GoalUnavailable>()("GoalUnavailable", {
  threadId: Schema.String,
  message: Schema.String,
}) {}

export class GoalAlreadyActive extends Schema.TaggedError<GoalAlreadyActive>()("GoalAlreadyActive", {
  threadId: Schema.String,
}) {}

export class GoalNotActive extends Schema.TaggedError<GoalNotActive>()("GoalNotActive", {
  threadId: Schema.String,
}) {}

export interface Interface {
  readonly get: (threadId: string) => Effect.Effect<Goal | undefined, GoalUnavailable>
  readonly create: (input: {
    readonly threadId: string
    readonly objective: string
    readonly budget: Goal["budget"]
  }) => Effect.Effect<Goal, GoalUnavailable | GoalAlreadyActive>
  readonly complete: (input: {
    readonly threadId: string
    readonly summary?: string | undefined
  }) => Effect.Effect<Goal, GoalUnavailable | GoalNotActive>
  readonly recordTurn: (input: {
    readonly threadId: string
    readonly tokens: number
    readonly elapsedMillis: number
  }) => Effect.Effect<Goal | undefined, GoalUnavailable>
  readonly continuation: (threadId: string) => Effect.Effect<string | undefined, GoalUnavailable>
}

export class GoalService extends Context.Service<GoalService, Interface>()(
  "@rika/product/thread/goal/goal-service/GoalService",
) {}

const continuationFor = (goal: Goal): string =>
  `Continue working toward the active goal: ${goal.objective}. Complete it explicitly with rika.goal.complete when it is done.`

const unavailable = (threadId: string) => (error: GoalRepository.RepositoryError) =>
  GoalUnavailable.make({ threadId, message: error.message })

/**
 * The Goal state machine over a durable one-row-per-Thread repository. Only `complete` can reach
 * `complete`, so a goal ends when the agent says it ends. Budget exhaustion pauses instead.
 */
const make = Effect.gen(function* () {
  const goals = yield* GoalRepository.Service
  const get = (threadId: string) => goals.get(threadId).pipe(Effect.mapError(unavailable(threadId)))
  return GoalService.of({
    get,
    create: Effect.fn("GoalService.create")(function* (input) {
      const now = yield* Clock.currentTimeMillis
      const claimed = yield* goals
        .claim({
          threadId: input.threadId,
          objective: input.objective,
          status: "active",
          budget: input.budget,
          usage: { tokens: 0, elapsedMillis: 0, turns: 0 },
          startedAtMillis: now,
          updatedAtMillis: now,
        })
        .pipe(Effect.mapError(unavailable(input.threadId)))
      if (claimed === undefined) return yield* GoalAlreadyActive.make({ threadId: input.threadId })
      return claimed
    }),
    complete: Effect.fn("GoalService.complete")(function* (input) {
      const existing = yield* get(input.threadId)
      if (existing === undefined || existing.status === "complete")
        return yield* GoalNotActive.make({ threadId: input.threadId })
      const now = yield* Clock.currentTimeMillis
      const goal: Goal = {
        ...existing,
        status: "complete",
        updatedAtMillis: now,
        completedAtMillis: now,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }
      yield* goals.replace(goal).pipe(Effect.mapError(unavailable(input.threadId)))
      return goal
    }),
    recordTurn: Effect.fn("GoalService.recordTurn")(function* (input) {
      const existing = yield* get(input.threadId)
      if (existing === undefined || existing.status !== "active") return undefined
      const now = yield* Clock.currentTimeMillis
      const spent: Goal = {
        ...existing,
        usage: {
          tokens: existing.usage.tokens + input.tokens,
          elapsedMillis: existing.usage.elapsedMillis + input.elapsedMillis,
          turns: existing.usage.turns + 1,
        },
        updatedAtMillis: now,
      }
      const goal: Goal = exhausted(spent) ? { ...spent, status: "paused" } : spent
      yield* goals.replace(goal).pipe(Effect.mapError(unavailable(input.threadId)))
      return goal
    }),
    continuation: (threadId) =>
      Effect.map(get(threadId), (goal) =>
        goal === undefined || goal.status !== "active" ? undefined : continuationFor(goal),
      ),
  })
})

export const layer: Layer.Layer<GoalService, never, GoalRepository.Service> = Layer.effect(GoalService, make)

/** The same state machine over an in-memory row, so goal behaviour is testable without a store. */
export const layerMemory: Layer.Layer<GoalService> = layer.pipe(Layer.provide(GoalRepository.memoryLayer))

/** The same state machine over an in-memory row, so goal behaviour is testable without a store. */
export const makeMemory: Effect.Effect<Interface> = Effect.flatMap(GoalRepository.makeMemory, (repository) =>
  Effect.provideService(make, GoalRepository.Service, repository),
)
