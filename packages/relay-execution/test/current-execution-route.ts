import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionChildRun from "@rika/product/execution-child-run"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { Effect, Function } from "effect"

const model = (
  role: ExecutionRouteSnapshot.ExecutionModelRoute["role"],
): ExecutionRouteSnapshot.ExecutionModelRoute => ({
  role,
  alias: role,
  model: "test",
  providerConnection: { provider: "test", protocol: "test", baseUrl: "test://model", authentication: "none" },
  registrationIdentity: modelRegistrationIdentity("test"),
  effort: "medium",
  fast: false,
  requestVariant: "test",
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

export const currentExecutionRoute = (): ExecutionRouteSnapshot.ExecutionRoutePin => ({
  version: 1 as const,
  mode: "test",
  main: model("main"),
  oracle: model("oracle"),
})

type StartInput = Omit<ExecutionRequest.StartInput, "executionRoute"> & {
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRoutePin
}

export const start: {
  (
    input: StartInput,
  ): (backend: ExecutionBackend.Interface) => Effect.Effect<ExecutionEvent.Result, ExecutionBackend.BackendError>
  (
    backend: ExecutionBackend.Interface,
    input: StartInput,
  ): Effect.Effect<ExecutionEvent.Result, ExecutionBackend.BackendError>
} = Function.dual(2, (backend: ExecutionBackend.Interface, input: StartInput) =>
  backend.start({ executionRoute: currentExecutionRoute(), ...input }),
)

type FanOutInput = Omit<ExecutionChildRun.FanOutInput, "executionRoute"> & {
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRoutePin
}

export const createFanOut: {
  (
    input: FanOutInput,
  ): (
    backend: ExecutionBackend.Interface,
  ) => Effect.Effect<ExecutionChildRun.FanOutInspection, ExecutionBackend.BackendError>
  (
    backend: ExecutionBackend.Interface,
    input: FanOutInput,
  ): Effect.Effect<ExecutionChildRun.FanOutInspection, ExecutionBackend.BackendError>
} = Function.dual(2, (backend: ExecutionBackend.Interface, input: FanOutInput) =>
  backend.createFanOut({ executionRoute: currentExecutionRoute(), ...input }),
)
