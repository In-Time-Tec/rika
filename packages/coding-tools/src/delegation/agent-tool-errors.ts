import { Schema } from "effect"

export class AgentToolError extends Schema.TaggedErrorClass<AgentToolError>()("AgentToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}
