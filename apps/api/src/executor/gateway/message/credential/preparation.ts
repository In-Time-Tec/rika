import * as HostedObservability from "@rika/product/hosted-observability"
import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewayCredentialMessageDependencies } from "./core"

type Message = Extract<ExecutorMessage, { readonly _tag: `WorkspacePreparation${string}` }>

export const gatewayCredentialPreparationHandler = (dependencies: GatewayCredentialMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleCredentialPreparation")(function* (socket: Socket, message: Message) {
    switch (message._tag) {
      case "WorkspacePreparationRequested": {
        const assignment = yield* dependencies.controller.workspace(redactAccess(message.access))
        if (assignment.workspaceId !== message.workspaceId)
          return yield* GatewayError.make({ kind: "fenced", message: "Workspace preparation identity is stale" })
        const templateBuildId =
          assignment.placement._tag === "OrbPlacement" ? assignment.placement.templateBuildId : undefined
        if (templateBuildId === undefined)
          return yield* GatewayError.make({ kind: "fenced", message: "Workspace preparation is not remote" })
        dependencies.send(socket, {
          _tag: "WorkspacePreparationAssigned",
          access: message.access,
          workspaceId: message.workspaceId,
          wakeId: message.wakeId,
          cold: message.cold,
          attempt: message.attempt,
          retry: message.retry,
          templateBuildId,
          checkout: assignment.checkout,
        })
        return true
      }
      case "WorkspacePreparationStarted":
        yield* dependencies.preparation.start(message)
        return true
      case "WorkspacePreparationOutput":
        yield* dependencies.preparation.output(message)
        return true
      case "WorkspacePreparationReady":
        yield* dependencies.preparation.complete(message)
        return true
      case "WorkspacePreparationFailed":
        yield* HostedObservability.health("setup_failure", {
          assignmentId: message.access.fence.assignmentId,
          sandboxId: message.access.fence.instanceId,
        })
        yield* dependencies.preparation.fail(message)
        return true
    }
  })
