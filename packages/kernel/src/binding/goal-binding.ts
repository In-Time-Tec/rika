import { Effect, Schema } from "effect"
import { ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { Goal } from "@rika/product/goal-record"
import { GoalAlreadyActive, GoalNotActive, GoalService, GoalUnavailable } from "@rika/product/goal-service"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "goal"

const Failure = Schema.Union([GoalUnavailable, GoalAlreadyActive, GoalNotActive, NestedOperationFailed])

const Empty = Schema.Struct({})
const Current = Schema.Struct({ goal: Schema.optionalKey(Goal) })

const CreateInput = Schema.Struct({
  objective: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  tokenBudget: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  wallClockMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
})
const CompleteInput = Schema.Struct({ summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))) })

/** The Thread a goal belongs to is the ambient session, never a field the cell may supply. */
const threadId = Effect.map(ToolContext.ToolContext, (context) => context.sessionId)

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<GoalService | Requirements>> = [
  operation({
    name: "get",
    input: Empty,
    output: Current,
    failure: Failure,
    handle: () =>
      Effect.flatMap(GoalService, (goals) =>
        Effect.flatMap(threadId, (thread) =>
          Effect.map(goals.get(thread), (goal) => (goal === undefined ? {} : { goal })),
        ),
      ),
  }),
  operation({
    name: "create",
    input: CreateInput,
    output: Goal,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "goal.create", payload: input, replayPolicy: "never" },
        Effect.flatMap(GoalService, (goals) =>
          Effect.flatMap(threadId, (thread) =>
            goals.create({
              threadId: thread,
              objective: input.objective,
              budget: {
                ...(input.tokenBudget === undefined ? {} : { tokens: input.tokenBudget }),
                ...(input.wallClockMillis === undefined ? {} : { wallClockMillis: input.wallClockMillis }),
              },
            }),
          ),
        ),
      ),
  }),
  operation({
    name: "complete",
    input: CompleteInput,
    output: Goal,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "goal.complete", payload: input, replayPolicy: "never" },
        Effect.flatMap(GoalService, (goals) =>
          Effect.flatMap(threadId, (thread) =>
            goals.complete({ threadId: thread, ...(input.summary === undefined ? {} : { summary: input.summary }) }),
          ),
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<GoalService | Requirements> = { name, operations }
