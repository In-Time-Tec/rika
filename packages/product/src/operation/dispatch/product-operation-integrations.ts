import * as ConfigurationService from "@rika/config/configuration-service"
import * as ConfigOperations from "./../contract/configuration-operation"
import * as ExtensionOperations from "./../contract/extension-operation"
import type { Effect, Layer } from "effect"
import type { OperationError } from "../operation-error"

export interface ProductConfigOperations {
  readonly layer: Layer.Layer<
    | ConfigOperations.Adapter
    | ConfigurationService.ConfigurationService
    | import("effect").FileSystem.FileSystem
    | import("effect").Path.Path,
    OperationError
  >
  readonly options: ConfigOperations.Options
  readonly forWorkspace?: (workspace: string) => Effect.Effect<
    {
      readonly layer: Layer.Layer<
        | ConfigOperations.Adapter
        | ConfigurationService.ConfigurationService
        | import("effect").FileSystem.FileSystem
        | import("effect").Path.Path,
        OperationError
      >
      readonly options: ConfigOperations.Options
    },
    OperationError
  >
}

export interface ProductExtensionOperations {
  readonly layer: Layer.Layer<
    | ExtensionOperations.Service
    | import("@rika/extensions/mcp-oauth-service").McpOAuthService
    | import("effect").FileSystem.FileSystem
    | import("effect").Path.Path
    | import("effect").Crypto.Crypto,
    OperationError
  >
}
