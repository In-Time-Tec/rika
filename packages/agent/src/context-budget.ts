import { Config } from "@rika/core"
import { ModelInfo, Modes, Tokens } from "@rika/llm"
import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as ModelContext from "./model-context"

export interface StateInput extends Schema.Schema.Type<typeof StateInput> {}
export const StateInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  mode: Config.Mode,
  reserved: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.ContextBudget.StateInput" })

export interface BudgetState extends Schema.Schema.Type<typeof BudgetState> {}
export const BudgetState = Schema.Struct({
  used: Schema.Int,
  usable: Schema.Int,
  fraction: Schema.Number,
}).annotate({ identifier: "Rika.Agent.ContextBudget.BudgetState" })

export class ContextBudgetError extends Schema.TaggedErrorClass<ContextBudgetError>()("ContextBudgetError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export type Error =
  | ContextBudgetError
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError

export interface Interface {
  readonly state: (input: StateInput) => Effect.Effect<BudgetState, Error>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ContextBudget") {}

interface Dependencies {
  readonly database: Database.Interface
  readonly eventLog: ThreadEventLog.Interface
  readonly projection: ThreadProjection.Interface
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const dependencies: Dependencies = { database, eventLog, projection }

    return Service.of({
      state: Effect.fn("ContextBudget.state")(function* (input: StateInput) {
        return yield* stateForThread(dependencies, input)
      }),
    })
  }),
)

export const state = Effect.fn("ContextBudget.state.call")(function* (input: StateInput) {
  const service = yield* Service
  return yield* service.state(input)
})

const stateForThread = (dependencies: Dependencies, input: StateInput) =>
  Effect.gen(function* () {
    const summary = yield* dependencies.projection
      .getThread(input.thread_id)
      .pipe(Effect.provideService(Database.Service, dependencies.database))
    if (summary === undefined) {
      return yield* new ContextBudgetError({
        message: `Thread ${input.thread_id} does not exist`,
        operation: "state",
        thread_id: input.thread_id,
      })
    }

    const events = yield* readThread(dependencies, input.thread_id)
    const used =
      summary.context_tokens !== undefined && !hasNewerContextReductionThanUsage(events)
        ? summary.context_tokens
        : estimateFromEvents(events)
    const model = Modes.primaryModel(Modes.get(input.mode))
    const usable = Math.max(1, ModelInfo.usableBudget(ModelInfo.modelInfo(model), input.reserved))
    return { used, usable, fraction: used / usable }
  })

const readThread = (dependencies: Dependencies, threadId: Ids.ThreadId) =>
  dependencies.eventLog
    .readThread({ thread_id: threadId })
    .pipe(Effect.provideService(Database.Service, dependencies.database))

const estimateFromEvents = (events: ReadonlyArray<Event.Event>) =>
  Tokens.estimateMessages(ModelContext.messagesFromEvents(events))

const hasNewerContextReductionThanUsage = (events: ReadonlyArray<Event.Event>) => {
  const latestReduction = events.findLast(
    (event) => event.type === "context.compacted" || event.type === "context.pruned",
  )
  if (latestReduction === undefined) return false
  const latestUsage = events.findLast(
    (event): event is Event.TurnCompleted => event.type === "turn.completed" && event.data.usage !== undefined,
  )
  return latestUsage === undefined || latestReduction.sequence > latestUsage.sequence
}
