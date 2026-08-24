import type { ModeId } from "@rika/configuration/behavior-mode"
import { Defaults } from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import type { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Schema } from "effect"
import { HostedProviderCredentialError, HostedProviderCredentials } from "./provider-credentials"

export class HostedModelRegistryError extends Schema.TaggedError<HostedModelRegistryError>()(
  "HostedModelRegistryError",
  {
    kind: Schema.Literals(["invalid", "missing", "revoked", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface HostedModelRegistryService {
  readonly modes: ReadonlyArray<string>
  readonly resolve: (ownerId: string, mode?: string) => Effect.Effect<ExecutionRouteSnapshot, HostedModelRegistryError>
}

export class HostedModelRegistry extends Context.Service<HostedModelRegistry, HostedModelRegistryService>()(
  "@rika/api/hosted/environment/model-registry/HostedModelRegistry",
) {}

const invalid = () => HostedModelRegistryError.make({ kind: "invalid", message: "Model route is unavailable" })
const credentialFailure = (error: HostedProviderCredentialError) => {
  if (error.kind === "missing") {
    return HostedModelRegistryError.make({
      kind: "missing",
      message: "OpenAI account is not connected. Run rika provider login codex",
    })
  }
  if (error.kind === "revoked") {
    return HostedModelRegistryError.make({
      kind: "revoked",
      message: "OpenAI account connection is revoked. Run rika provider login codex",
    })
  }
  return HostedModelRegistryError.make({ kind: "unavailable", message: "Model registry is unavailable" })
}

const hostedSettings = Defaults.settingsDefaults

export const layer = Layer.effect(
  HostedModelRegistry,
  Effect.gen(function* () {
    const credentials = yield* HostedProviderCredentials
    const resolve = Effect.fn("HostedModelRegistry.resolve")(function* (ownerId: string, requestedMode?: string) {
      const mode = (requestedMode ?? hostedSettings.defaultMode) as ModeId
      const account = yield* credentials.requireOpenAiAccount(ownerId).pipe(Effect.mapError(credentialFailure))
      return yield* Effect.try({
        try: () =>
          ExecutionRouteResolution.resolve(hostedSettings, mode, undefined, {
            openAiAccount: {
              credentialIdentity: account.credentialIdentity,
              fingerprint: account.fingerprint,
            },
          }),
        catch: invalid,
      })
    })
    return HostedModelRegistry.of({ modes: Object.keys(hostedSettings.modes), resolve })
  }),
)

export const testLayer = Layer.succeed(
  HostedModelRegistry,
  HostedModelRegistry.of({
    modes: Object.keys(hostedSettings.modes),
    resolve: (_ownerId, mode) =>
      Effect.try({
        try: () =>
          ExecutionRouteResolution.resolve(hostedSettings, mode ?? hostedSettings.defaultMode, undefined, {
            openAiAccount: { credentialIdentity: "openai-account-test", fingerprint: "openai-fingerprint-test" },
          }),
        catch: invalid,
      }),
  }),
)
