import type { Unit } from "@rika/product/execution-transcript-contract"
import type { RunEvent } from "tenetkit/runtime"
import { Schema } from "effect"
import { type Node } from "./model"
import { type AuthorizationState, type ProjectorCore } from "./persistence"
import { bounded } from "./values"

export interface AuthorizationProjection {
  readonly putAuthorization: (
    node: Node,
    waitId: string,
    request: Extract<RunEvent.RunEvent, { readonly _tag: "ApprovalRequested" }>["request"],
  ) => void
  readonly resolveAuthorization: (
    node: Node,
    waitId: string,
    status: "approved" | "denied" | "cancelled" | "expired",
  ) => void
  readonly settleAuthorizations: (node: Node, status: "cancelled" | "expired") => void
}

export interface AuthorizationProjectionInput {
  readonly core: ProjectorCore
  readonly units: Map<string, Unit>
  readonly authorizations: Map<string, AuthorizationState>
  readonly localId: (family: string, ...parts: ReadonlyArray<string | number>) => string
  readonly put: (unit: Unit) => void
  readonly unit: (node: Node, key: string, content: Unit["content"], part?: number) => Unit
  readonly recover: (key: string, unitKey: string | undefined) => void
}

export const makeAuthorizationProjection = (input: AuthorizationProjectionInput): AuthorizationProjection => {
  const { core, units, authorizations, localId, put, unit, recover } = input

  const putAuthorization = (
    node: Node,
    waitId: string,
    request: Extract<RunEvent.RunEvent, { readonly _tag: "ApprovalRequested" }>["request"],
  ) => {
    if (node.hidden) return
    const authorizationId = localId("authorization", node.publicId, request.approvalId)
    const key = localId("authorization-unit", node.publicId, request.approvalId)
    const authorizationKey = `${node.rawRunId}\u0000${waitId}`
    authorizations.set(authorizationKey, {
      unitKey: key,
      rawRunId: node.rawRunId,
      authorizationId,
      approvalId: request.approvalId,
    })
    recover(authorizationKey, key)
    const fullInput = (() => {
      try {
        return Schema.is(Schema.String)(request.input) ? request.input : (JSON.stringify(request.input) ?? "")
      } catch {
        return String(request.input)
      }
    })()
    put(
      unit(node, key, {
        _tag: "Block",
        block: {
          _tag: "AuthorizationCard",
          id: authorizationId,
          operation: request.operation,
          capability: request.capability,
          input: bounded(fullInput, 16_384),
          inputTruncated: fullInput.length > 16_384,
          status: "pending",
        },
      }),
    )
  }

  const resolveAuthorization = (
    node: Node,
    waitId: string,
    status: "approved" | "denied" | "cancelled" | "expired",
  ) => {
    const authorizationKey = `${node.rawRunId}\u0000${waitId}`
    const pendingAuthorization = authorizations.get(authorizationKey)
    const candidate = pendingAuthorization === undefined ? undefined : units.get(pendingAuthorization.unitKey)
    if (candidate?.content._tag !== "Block" || candidate.content.block._tag !== "AuthorizationCard") return
    put({
      ...candidate,
      revision: core.revision,
      content: { _tag: "Block", block: { ...candidate.content.block, status } },
    })
    authorizations.delete(authorizationKey)
    recover(authorizationKey, undefined)
  }

  const settleAuthorizations = (node: Node, status: "cancelled" | "expired") => {
    for (const [waitId, pendingAuthorization] of authorizations)
      if (pendingAuthorization.rawRunId === node.rawRunId) {
        const separator = waitId.indexOf("\u0000")
        resolveAuthorization(node, waitId.slice(separator + 1), status)
      }
  }

  return { putAuthorization, resolveAuthorization, settleAuthorizations }
}
