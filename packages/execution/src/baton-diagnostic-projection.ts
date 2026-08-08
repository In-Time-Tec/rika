import type { Unit } from "@rika/product/execution-transcript-contract"
import { modelFailurePresentation } from "@rika/product/failure-policy"
import { classifyFailureMessage, executionFailureDetail, providerFailureMessage } from "@rika/product/failure-message"
import { type Node } from "./baton-projector-model"
import { bounded, toolTextLimit } from "./baton-projector-values"

export interface DiagnosticProjection {
  readonly notice: (
    node: Node,
    family: string,
    titleText: string,
    detail: string,
    discriminator: string | number,
  ) => void
  readonly error: (
    node: Node,
    family: string,
    titleText: string,
    detail: string,
    discriminator: string | number,
    outcome?: Unit["executionOutcome"],
    category?: string,
    retryable?: boolean,
  ) => string | undefined
  readonly modelFailureError: (
    node: Node,
    modelCallId: string,
    category: import("@rika/product/failure-policy").ModelFailureCategory,
    classification: "transient" | "terminal",
  ) => void
  readonly executionFailureError: (node: Node, message: string, outcome?: Unit["executionOutcome"]) => void
}

export interface DiagnosticProjectionInput {
  readonly turnId: string
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly get: (key: string) => Unit | undefined
}

export const makeDiagnosticProjection = (input: DiagnosticProjectionInput): DiagnosticProjection => {
  const { turnId, localId, put, unit, get } = input
  const modelCallFailureKeys = new Map<string, string>()

  const notice = (node: Node, family: string, titleText: string, detail: string, discriminator: string | number) => {
    if (node.hidden) return
    const key = localId(family, node.publicId, discriminator)
    put(
      unit(node, key, {
        _tag: "Block",
        block: { _tag: "Notification", title: titleText, detail: bounded(detail, toolTextLimit) },
      }),
    )
  }

  // The outcome is what the product reads to report why a turn failed. An Error block alone only
  // renders; without `executionOutcome` the dispatch degrades to a bare "Turn <id> failed".
  const error = (
    node: Node,
    family: string,
    titleText: string,
    detail: string,
    discriminator: string | number,
    outcome?: Unit["executionOutcome"],
    category?: string,
    retryable?: boolean,
  ): string | undefined => {
    if (node.hidden) return undefined
    const key = localId(family, node.publicId, discriminator)
    const block = unit(node, key, {
      _tag: "Block",
      block: {
        _tag: "Error",
        title: titleText,
        detail: bounded(detail, toolTextLimit),
        ...(category === undefined ? {} : { category }),
        ...(retryable === undefined ? {} : { retryable }),
        turnId,
      },
    })
    put(outcome === undefined ? block : { ...block, executionOutcome: outcome })
    return key
  }

  const modelFailureError: DiagnosticProjection["modelFailureError"] = (
    node,
    modelCallId,
    category,
    classification,
  ) => {
    const presented = modelFailurePresentation({ category, classification })
    const key = error(
      node,
      "model-call",
      presented.message,
      "",
      modelCallId,
      undefined,
      presented.category,
      presented.retryable,
    )
    if (key !== undefined) modelCallFailureKeys.set(node.publicId, key)
  }

  const executionFailureError: DiagnosticProjection["executionFailureError"] = (node, message, outcome) => {
    // When the run failed because of a provider problem that the model-call error block already
    // explains, settle that block with the run outcome instead of appending a duplicate
    // "Execution failed" block.
    const modelCallKey = modelCallFailureKeys.get(node.publicId)
    if (modelCallKey !== undefined && providerFailureMessage(message) !== undefined) {
      const existing = get(modelCallKey)
      if (existing !== undefined) {
        const settled = unit(node, modelCallKey, existing.content)
        put(outcome === undefined ? settled : { ...settled, executionOutcome: outcome })
        return
      }
    }
    const detail = executionFailureDetail(message)
    const classified = classifyFailureMessage(message)
    error(
      node,
      "execution",
      "Execution failed",
      detail,
      "failed",
      outcome,
      classified?.category ?? "operation",
      classified?.retryable ?? false,
    )
  }

  return { notice, error, modelFailureError, executionFailureError }
}
