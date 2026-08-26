import { Function, Schema } from "effect"
import { Idempotency } from "./idempotency"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  failedLabel: Schema.optionalKey(Schema.String),
  rowDisplay: Schema.optionalKey(Schema.Literal("continuation")),
  outputDisplay: Schema.optionalKey(Schema.Literals(["hidden", "expandable", "inline"])),
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const Policy = Schema.Struct({
  idempotency: Idempotency,
  timeoutMillis: PositiveInt,
  outputLimit: PositiveInt,
  presentation: Presentation,
})
export type Policy = typeof Policy.Type

export interface RegisteredTool {
  readonly name: string
  readonly description?: string | undefined
}

export interface Registration {
  readonly tool: RegisteredTool
  readonly policy: Policy
}

export const allow: {
  (idempotency: Idempotency, timeoutMillis: number, outputLimit: number, presentation: Presentation): Policy
  (timeoutMillis: number, outputLimit: number, presentation: Presentation): (idempotency: Idempotency) => Policy
} = Function.dual(
  (args) => args.length >= 4,
  (idempotency: Idempotency, timeoutMillis: number, outputLimit: number, presentation: Presentation): Policy => ({
    idempotency,
    timeoutMillis,
    outputLimit,
    presentation,
  }),
)

export const register: {
  (tool: RegisteredTool, policy: Policy): Registration
  (policy: Policy): (tool: RegisteredTool) => Registration
} = Function.dual(2, (tool: RegisteredTool, policy: Policy): Registration => ({ tool, policy }))
