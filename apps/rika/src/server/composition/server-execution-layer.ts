#!/usr/bin/env bun
import * as BatonExecution from "@rika/baton-execution/baton-execution"
import * as ScriptedModel from "@rika/baton-execution/scripted-model"
import * as JavaScriptSandbox from "@rika/javascript-sandbox/javascript-sandbox"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Layer } from "effect"
import { validateWebSearchProviders } from "./server-configuration-adapter"

export const configuredBackendLayer = (options: {
  readonly filename: string
  readonly agentServices?: (workspace: string) => Layer.Layer<BatonExecution.AgentToolServices, never, never>
  readonly testModel?: { readonly script?: string; readonly response?: string }
}) => {
  const backendLayer: Layer.Layer<
    ExecutionGateway.Service,
    ExecutionGateway.StartTurnFailure,
    BatonExecution.SandboxService
  > = BatonExecution.layer({
    filename: options.filename,
    ...(options.agentServices === undefined ? {} : { agentServices: options.agentServices }),
    ...(options.testModel === undefined ? {} : { modelServices: ScriptedModel.layer(options.testModel) }),
  })
  return Layer.provide(backendLayer, JavaScriptSandbox.layer())
}

export { validateWebSearchProviders }
