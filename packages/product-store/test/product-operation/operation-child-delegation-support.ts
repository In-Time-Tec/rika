import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import { Effect, Layer } from "effect"
import { productLayer as makeProductLayer, provideLayer as provideProduct } from "../support/operation-layer-harness"

export const childDelegationLayer: typeof makeProductLayer = (options) => makeProductLayer(options)

export const runWithChildDelegationLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    provideProduct(layer)(effect)

export function truncatedDelegationReport(
  reason: string,
): (childExecutionId: string) => ReturnType<typeof AgentOutcomes.AgentContract.noReport>
export function truncatedDelegationReport(
  childExecutionId: string,
  reason: string,
): ReturnType<typeof AgentOutcomes.AgentContract.noReport>
export function truncatedDelegationReport(childExecutionIdOrReason: string, reason?: string) {
  if (reason === undefined)
    return (childExecutionId: string) => truncatedDelegationReport(childExecutionId, childExecutionIdOrReason)
  return AgentOutcomes.AgentContract.noReport({ childExecutionId: childExecutionIdOrReason, reason })
}

export const noReportRecovery = AgentOutcomes.AgentContract.noReportRecovery
