import { Schema } from "effect"

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type
