import { Context, Function, Schema } from "effect"

export const ValueSchema = Schema.Struct({
  executionId: Schema.String,
  callId: Schema.String,
  toolName: Schema.String,
  eventSequence: Schema.Int,
  createdAt: Schema.Finite,
  idempotencyKeyDigest: Schema.String,
})
export type Value = typeof ValueSchema.Type

export const absoluteDeadline: {
  (timeoutMillis: number): (createdAt: number) => number
  (createdAt: number, timeoutMillis: number): number
} = Function.dual(2, (createdAt: number, timeoutMillis: number): number => {
  const deadline = createdAt + timeoutMillis
  if (!Number.isFinite(deadline) || timeoutMillis < 0) throw new RangeError("Invalid tool deadline")
  return deadline
})

export class ToolInvocation extends Context.Service<ToolInvocation, Value>()(
  "@rika/coding-tools/catalog/tool-invocation/ToolInvocation",
) {}
