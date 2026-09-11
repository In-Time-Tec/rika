/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this temporary application root explicitly wires the repository authority. */
import { Context, Effect } from "effect"
import type { RuntimeActorDefinition } from "generalist/unstable/rivet"
import { handleApiV2Request } from "./transport/http"
import type { ProductRouteService } from "./product/routes"
import {
  makeRepositoryProductAuthority,
  type ProductAuthorityService,
  type RepositoryProductAuthorityOptions,
  ProductAuthorizationError,
} from "./product/authority"
import { rivetRegistry, type RuntimeActorOptions, type RuntimeRegistry } from "./runtime/rivet-actor"
import { authorizedRuntimeRequest, type RuntimeGateway } from "./transport/runtime-gateway"
import { threadPartition, type ExecutionTarget, type ThreadPartition } from "./runtime/partition"
import type { RuntimeStorage } from "./runtime/storage"
import { makeRawRivetGateway } from "./transport/raw-rivet-gateway"
import { makeIdentityRequestHandler } from "./identity/http"
import { makeProductRequestHandler, type ProductHttpOptions } from "./product/http"
import { makeRunnerRequestHandler } from "./executor/http"
import type { RunnerGateway } from "./executor/runner-gateway"
import { makeWorkspaceSeedsRequestHandler, type WorkspaceSeedsHttpOptions } from "./product/workspace-seeds-http"

export interface ApiV2ApplicationOptions {
  readonly authority: ProductAuthorityService
  readonly productControl?: ProductHttpOptions
  readonly workspaceSeeds?: WorkspaceSeedsHttpOptions
  readonly runnerGateway?: RunnerGateway
  readonly boxGateway?: RunnerGateway
  /** Product metadata reads remain outside the execution Host and are optional for transport-only compositions. */
  readonly product?: ProductRouteService
  readonly environment: string
  readonly storage: RuntimeStorage
  readonly revision: string
  readonly workspace: RuntimeActorOptions["workspace"]
  /** Resolve one complete context-v2 composition for each actor partition. */
  readonly context: RuntimeActorOptions["context"]
  readonly actorOptions?: RuntimeActorOptions["actorOptions"]
  readonly registry?: RuntimeActorOptions["registry"]
  readonly rivetEndpoint?: string
  readonly rivetToken?: string
  readonly rivetNamespace?: string
  readonly gateway?: RuntimeGateway
}

export interface ApiV2RepositoryApplicationOptions extends Omit<ApiV2ApplicationOptions, "authority"> {
  readonly productAuthority: RepositoryProductAuthorityOptions
}

export interface ApiV2ApplicationService {
  readonly authority: ProductAuthorityService
  readonly environment: string
  readonly gateway: RuntimeGateway
  readonly runtimeActor: RuntimeActorDefinition
  readonly registry: RuntimeRegistry
  readonly partitionForThread: (input: {
    readonly ownerId: string
    readonly threadId: string
    readonly environment: string
    readonly target: ExecutionTarget
  }) => Effect.Effect<ThreadPartition, ProductAuthorizationError>
  readonly forward: typeof authorizedRuntimeRequest
  readonly handle: typeof handleApiV2Request
}

export class ApiV2Application extends Context.Service<ApiV2Application, ApiV2ApplicationService>()(
  "@rika/api/application/ApiV2Application",
) {}

/**
 * Compose one process-scoped API. Storage/model/Runner clients are passed in once and reused by each actor
 * incarnation; the actor itself only owns a scoped Runtime and never becomes a second persistence authority.
 */
export const makeApiV2Application = (options: ApiV2ApplicationOptions) =>
  Effect.sync(() => {
    const actorOptions: RuntimeActorOptions = {
      authority: options.authority,
      storage: options.storage,
      revision: options.revision,
      workspace: options.workspace,
      context: options.context,
    }
    if (options.actorOptions !== undefined) Object.assign(actorOptions, { actorOptions: options.actorOptions })
    if (options.registry !== undefined) Object.assign(actorOptions, { registry: options.registry })
    const registry = rivetRegistry(actorOptions)
    const gatewayOptions = {
      endpoint: options.rivetEndpoint ?? options.registry?.endpoint ?? "http://127.0.0.1:6420",
    }
    if (options.rivetToken !== undefined) Object.assign(gatewayOptions, { token: options.rivetToken })
    if (options.rivetNamespace !== undefined) Object.assign(gatewayOptions, { namespace: options.rivetNamespace })
    const gateway = options.gateway ?? makeRawRivetGateway(gatewayOptions)
    const runtimeActor = registry.config.use.rikaRuntime
    const identityHandler =
      options.productControl === undefined ? undefined : makeIdentityRequestHandler(options.productControl)
    const productHandler =
      options.productControl === undefined ? undefined : makeProductRequestHandler(options.productControl)
    const workspaceSeedsHandler = options.workspaceSeeds === undefined
      ? undefined
      : makeWorkspaceSeedsRequestHandler(options.workspaceSeeds)
    const runnerHandler =
      options.runnerGateway === undefined ? undefined : makeRunnerRequestHandler(options.runnerGateway)
    const partitionForThread = (input: {
      readonly ownerId: string
      readonly threadId: string
      readonly environment: string
      readonly target: ExecutionTarget
    }) => Effect.succeed(threadPartition(input))
    return ApiV2Application.of({
      authority: options.authority,
      environment: options.environment,
      gateway,
      runtimeActor,
      registry,
      partitionForThread,
      forward: authorizedRuntimeRequest,
      handle: (input) =>
        Effect.gen(function* () {
          if (identityHandler !== undefined) {
            const response = yield* identityHandler(input.request)
            if (response !== undefined) return response
          }
          if (productHandler !== undefined) {
            const response = yield* productHandler(input.request)
            if (response !== undefined) return response
          }
          if (workspaceSeedsHandler !== undefined) {
            const response = yield* workspaceSeedsHandler(input.request)
            if (response !== undefined) return response
          }
          if (runnerHandler !== undefined) {
            const response = yield* runnerHandler(input.request)
            if (response !== undefined) return response
          }
          const request = {
            authority: options.authority,
            gateway,
            environment: options.environment,
            request: input.request,
          }
          if (options.product !== undefined) Object.assign(request, { product: options.product })
          if (input.websocket !== undefined) Object.assign(request, { websocket: input.websocket })
          return yield* handleApiV2Request(request)
        }),
    })
  })

/** Compose the temporary API directly from Rika's published identity/product repository services. */
export const makeApiV2RepositoryApplication = (options: ApiV2RepositoryApplicationOptions) => {
  const { productAuthority, ...application } = options
  const authority = makeRepositoryProductAuthority(productAuthority)
  return makeApiV2Application({
    ...application,
    authority,
    product: authority.product,
  })
}
