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
import { ExecutorAssignmentId } from "@rika/product/hosted-model"
import { Context, Effect, Layer, Redacted } from "effect"
import { makeGateway, type Gateway, type GatewayError } from "./executor-gateway"
import { LocalExecutor, type LocalActor } from "./local-executor"
import { makeLocalGateway, type LocalGateway } from "./local-executor-gateway"

const required = (environment: Record<string, string | undefined>, name: string) => {
  const value = environment[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

export const config = (environment: Record<string, string | undefined>) => {
  const apiUrl = required(environment, "RIKA_EXECUTOR_API_URL")
  return {
    appId: required(environment, "E2B_APP_ID"),
    deploymentId: required(environment, "E2B_DEPLOYMENT_ID"),
    templateId: required(environment, "E2B_TEMPLATE_ID"),
    templateBuildId: required(environment, "E2B_TEMPLATE_BUILD_ID"),
    apiUrl,
    allowedEgress: [new URL(apiUrl).hostname, "github.com", "api.github.com"],
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
  readonly localGateway: LocalGateway
  readonly admitLocal: (input: {
    readonly threadId: string
    readonly organizationId: string
    readonly workspaceFingerprint: string
    readonly actor: LocalActor
    readonly executorUrl: string
  }) => Effect.Effect<import("./local-executor").LocalAdmission, ControllerError>
  readonly run: (input: {
    readonly threadId: string
    readonly operationKey: string
    readonly code: string
  }) => Effect.Effect<
    {
      readonly access?: import("@rika/remote-execution/protocol").AccessWire
      readonly response: import("@rika/remote-execution/protocol").CellResponse
      readonly eventPersisted: boolean
    },
    ControllerError | GatewayError
  >
  readonly ready: Effect.Effect<void, ControllerError>
}

export class Executor extends Context.Service<Executor, Runtime>()("@rika/api/executor") {}

export const service = Layer.effect(
  Executor,
  Effect.gen(function* () {
    const controller = yield* Controller
    const assignments = yield* ExecutorAssignments
    const gateway = yield* makeGateway(controller)
    const local = yield* LocalExecutor
    const localGateway = yield* makeLocalGateway(local)
    return {
      controller,
      gateway,
      localGateway,
      admitLocal: (input) => local.admit(input),
      run: Effect.fn("Executor.run")(function* (input) {
        const assignment = yield* assignments
          .get(ExecutorAssignmentId.make(input.threadId))
          .pipe(Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })))
        if (assignment?.placement._tag === "LocalDevicePlacement")
          return yield* localGateway.execute({
            assignmentId: input.threadId,
            operationKey: input.operationKey,
            code: input.code,
          })
        yield* controller.provision(input.threadId)
        const result = yield* gateway.execute({
          assignmentId: input.threadId,
          operationKey: input.operationKey,
          workspace: "/workspace",
          sessionId: input.threadId,
          code: input.code,
        })
        return { ...result, eventPersisted: false as const }
      }),
      ready: assignments.listManaged.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => ControllerError.make({ kind: "repository", message: cause.message })),
      ),
    }
  }),
)
