import { Schema } from "effect"
export const TaskInput = Schema.Struct({
  prompt: Schema.String,
})
export type TaskInput = typeof TaskInput.Type

export const ReadThreadInput = Schema.Struct({
  prompt: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
})
export type ReadThreadInput = typeof ReadThreadInput.Type

export const Spawned = Schema.Struct({
  _tag: Schema.tag("Spawned"),
  childExecutionId: Schema.String,
  status: Schema.Literal("running"),
  next: Schema.String,
})
export type Spawned = typeof Spawned.Type

export const spawnedNext =
  "The subagent is running in the background. Start any other independent work now, then call await_subagents to collect its report. Never answer the user before every subagent you started has been collected."

export const spawned = ({ childExecutionId }: Pick<Spawned, "childExecutionId">): Spawned => ({
  _tag: "Spawned",
  childExecutionId,
  status: "running",
  next: spawnedNext,
})
