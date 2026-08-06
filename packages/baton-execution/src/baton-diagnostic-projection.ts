import type { Unit } from "@rika/product/execution-transcript-contract"
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
  ) => void
}

export interface DiagnosticProjectionInput {
  readonly turnId: string
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
}

export const makeDiagnosticProjection = (input: DiagnosticProjectionInput): DiagnosticProjection => {
  const { turnId, localId, put, unit } = input

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
  ) => {
    if (node.hidden) return
    const key = localId(family, node.publicId, discriminator)
    const block = unit(node, key, {
      _tag: "Block",
      block: { _tag: "Error", title: titleText, detail: bounded(detail, toolTextLimit), turnId },
    })
    put(outcome === undefined ? block : { ...block, executionOutcome: outcome })
  }

  return { notice, error }
}
