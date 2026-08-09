import { Schema } from "effect"

export const GoalStatus = Schema.Literals(["active", "paused", "complete", "errored"])

const GoalBudget = Schema.Struct({
  tokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  wallClockMillis: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
})
const GoalUsage = Schema.Struct({
  tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  elapsedMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export const Goal = Schema.Struct({
  threadId: Schema.String,
  objective: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  status: GoalStatus,
  budget: GoalBudget,
  usage: GoalUsage,
  startedAtMillis: Schema.Int,
  updatedAtMillis: Schema.Int,
  completedAtMillis: Schema.optionalKey(Schema.Int),
  summary: Schema.optionalKey(Schema.String),
})
export type Goal = typeof Goal.Type

/** Whether a goal has spent everything its budget allows. A goal with no budget never exhausts. */
export const exhausted = (goal: Goal): boolean =>
  (goal.budget.tokens !== undefined && goal.usage.tokens >= goal.budget.tokens) ||
  (goal.budget.wallClockMillis !== undefined && goal.usage.elapsedMillis >= goal.budget.wallClockMillis)
