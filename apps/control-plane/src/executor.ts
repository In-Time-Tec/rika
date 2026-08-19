import {
  Controller,
  ControllerError,
  layer as controllerLayer,
  type Interface as ControllerService,
} from "@rika/e2b-executor/controller"
import { Inspector, InspectionError } from "@rika/e2b-executor/checkpoint"
import { CredentialError, Credentials } from "@rika/e2b-executor/checkout"
import { layer as providerLayer } from "@rika/e2b-executor/provider"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import { Context, Effect, Layer, Redacted } from "effect"
import { makeGateway, type Gateway, type GatewayError } from "./executor-gateway"

const required = (environment: Record<string, string | undefined>, name: string) => {
  const value = environment[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

export const config = (environment: Record<string, string | undefined>) => {
  const controllerUrl = required(environment, "RIKA_EXECUTOR_CONTROLLER_URL")
  return {
    appId: required(environment, "E2B_APP_ID"),
    deploymentId: required(environment, "E2B_DEPLOYMENT_ID"),
    templateId: required(environment, "E2B_TEMPLATE_ID"),
    templateBuildId: required(environment, "E2B_TEMPLATE_BUILD_ID"),
    controllerUrl,
    allowedEgress: [new URL(controllerUrl).hostname, "github.com", "api.github.com"],
    apiKey: Redacted.make(required(environment, "E2B_API_KEY"), { label: "e2b-api-key" }),
  }
}

export const layer = (options: ReturnType<typeof config>) =>
  controllerLayer(options).pipe(
    Layer.provide(providerLayer({ apiKey: options.apiKey })),
    Layer.provide(
      Layer.succeed(
        Inspector,
        Inspector.of({ inspect: () => Effect.fail(InspectionError.make({ message: "Checkpoints are unavailable" })) }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Credentials,
        Credentials.of({ issue: () => Effect.fail(CredentialError.make({ message: "Checkout is unavailable" })) }),
      ),
    ),
  )

export interface Runtime {
  readonly controller: ControllerService
  readonly gateway: Gateway
  readonly run: (input: {
    readonly threadId: string
    readonly operationKey: string
    readonly code: string
  }) => Effect.Effect<
    {
      readonly access: import("@rika/remote-execution/protocol").AccessWire
      readonly response: import("@rika/remote-execution/protocol").CellResponse
    },
    ControllerError | GatewayError
  >
  readonly ready: Effect.Effect<void, ControllerError>
}

export class Executor extends Context.Service<Executor, Runtime>()("@rika/control-plane/executor") {}

export const service = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const controller = yield* Controller
    const assignments = yield* ExecutorAssignments
    const gateway = yield* makeGateway(controller)
    return {
      controller,
      gateway,
      run: Effect.fn("Executor.run")(function* (input) {
        yield* controller.provision(input.threadId)
        return yield* gateway.execute({
          assignmentId: input.threadId,
          operationKey: input.operationKey,
          workspace: "/workspace",
          sessionId: input.threadId,
          code: input.code,
        })
      }),
      ready: assignments.listManaged.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })),
      ),
    }
  }),
)
