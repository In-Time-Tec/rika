import * as ExecutionBackend from "@rika/product/execution-service"
import { modelRegistrationIdentity } from "@rika/product/execution-route-snapshot"
import { Effect, Function } from "effect"

const model = (role: ExecutionBackend.ExecutionModelRoute["role"]): ExecutionBackend.ExecutionModelRoute => ({
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

export const currentExecutionRoute = (): ExecutionBackend.ExecutionRoutePin => ({
  version: 1 as const,
  mode: "test",
  main: model("main"),
  oracle: model("oracle"),
})

type StartInput = Omit<ExecutionBackend.StartInput, "executionRoute"> & {
  readonly executionRoute?: ExecutionBackend.ExecutionRoutePin
}

export const start: {
  (
    input: StartInput,
  ): (backend: ExecutionBackend.Interface) => Effect.Effect<ExecutionBackend.Result, ExecutionBackend.BackendError>
  (
    backend: ExecutionBackend.Interface,
    input: StartInput,
  ): Effect.Effect<ExecutionBackend.Result, ExecutionBackend.BackendError>
} = Function.dual(2, (backend: ExecutionBackend.Interface, input: StartInput) =>
  backend.start({ executionRoute: currentExecutionRoute(), ...input }),
)

type FanOutInput = Omit<ExecutionBackend.FanOutInput, "executionRoute"> & {
  readonly executionRoute?: ExecutionBackend.ExecutionRoutePin
}

export const createFanOut: {
  (
    input: FanOutInput,
  ): (
    backend: ExecutionBackend.Interface,
  ) => Effect.Effect<ExecutionBackend.FanOutInspection, ExecutionBackend.BackendError>
  (
    backend: ExecutionBackend.Interface,
    input: FanOutInput,
  ): Effect.Effect<ExecutionBackend.FanOutInspection, ExecutionBackend.BackendError>
} = Function.dual(2, (backend: ExecutionBackend.Interface, input: FanOutInput) =>
  backend.createFanOut({ executionRoute: currentExecutionRoute(), ...input }),
)
