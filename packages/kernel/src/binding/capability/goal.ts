import { Effect, Schema } from "effect"
import { ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { Goal } from "@rika/product/goal-record"
import { GoalAlreadyActive, GoalNotActive, GoalService, GoalUnavailable } from "@rika/product/goal-service"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

export const name = "goal"

const Failure = Schema.Union([GoalUnavailable, GoalAlreadyActive, GoalNotActive, NestedOperationFailed])

const Empty = Schema.Struct({})
const Current = Schema.Struct({ goal: Schema.optionalKey(Goal) })
const GoalBudget = Schema.Struct({ tokens: Schema.optionalKey(Schema.Int), wallClockMillis: Schema.optionalKey(Schema.Int) })

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
          Effect.flatMap(threadId, (thread) => {
            let budget: typeof GoalBudget.Type
            if (input.tokenBudget === undefined)
              budget = input.wallClockMillis === undefined ? {} : { wallClockMillis: input.wallClockMillis }
            else
              budget = input.wallClockMillis === undefined
                ? { tokens: input.tokenBudget }
                : { tokens: input.tokenBudget, wallClockMillis: input.wallClockMillis }
            return goals.create({
              threadId: thread,
              objective: input.objective,
              budget,
            })
          }),
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
          Effect.flatMap(threadId, (thread) => {
            const completion: Parameters<typeof goals.complete>[0] = input.summary === undefined
              ? { threadId: thread }
              : { threadId: thread, summary: input.summary }
            return goals.complete(completion)
          }),
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<GoalService | Requirements> = { name, operations }
