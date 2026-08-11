import type { RunEvent, RunTree } from "@batonfx/runtime"
import type { Response, Tool } from "effect/unstable/ai"

type SemanticContentPart = Response.Part<Record<string, Tool.Any>> | Response.ErrorPart

export type ModelResponseCommitted = Omit<RunEvent.RunEvent, "_tag"> & {
  readonly _tag: "ModelResponseCommitted"
  readonly turn: number
  readonly operationKey: string
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
  readonly response: {
    readonly content: ReadonlyArray<SemanticContentPart>
    readonly usage?: Response.Usage
    readonly finishReason?: Response.FinishReason
  }
  readonly digest: string
}

type SemanticRunEvent = Exclude<RunEvent.RunEvent, { readonly part: unknown }> | ModelResponseCommitted

export type SemanticTreeEvent = Omit<RunTree.TreeEvent, "event"> & {
  readonly event: SemanticRunEvent
}

export const semanticTreeEvent = (event: RunTree.TreeEvent): SemanticTreeEvent => event as SemanticTreeEvent
