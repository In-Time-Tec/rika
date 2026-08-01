import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import { Effect, Layer } from "effect"
import { productLayer as makeProductLayer, provideLayer as provideProduct } from "../support/operation-layer-harness"

export const childDelegationLayer: typeof makeProductLayer = (options) => makeProductLayer(options)

export const runWithChildDelegationLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    provideProduct(layer)(effect)

export const truncatedDelegationReport = (childExecutionId: string, reason: string) =>
  AgentOutcomes.AgentContract.noReport({ childExecutionId, reason })

export const noReportRecovery = AgentOutcomes.AgentContract.noReportRecovery
