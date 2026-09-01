import { Function, Schema } from "effect"
import {
  Presentation as TranscriptPresentation,
  type Presentation as TranscriptPresentationModel,
} from "@rika/transcript/transcript-presentation-model"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/** Transcript-owned metadata used to present a tool call consistently across clients. */
export const Presentation = TranscriptPresentation
export type Presentation = TranscriptPresentationModel

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type

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
