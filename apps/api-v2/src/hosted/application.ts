/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this temporary application root explicitly wires the repository authority. */
import { Context, Effect, type Layer } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { RuntimeActorDefinition } from "generalist/unstable/rivet"
import { handleApiV2Request } from "./http"
import {
  makeRepositoryProductAuthority,
  type ProductAuthorityService,
  type RepositoryProductAuthorityOptions,
  ProductAuthorizationError,
} from "./product-authority"
import { rivetRegistry, type RuntimeActorOptions, type RuntimeRegistry } from "./rivet-actor"
import { authorizedRuntimeRequest, type RuntimeGateway } from "./runtime-gateway"
import { threadPartition, type ExecutionTarget, type ThreadPartition } from "./partition"
import type { RuntimeStorage } from "./storage"
import { makeRawRivetGateway } from "./raw-rivet-gateway"

export interface ApiV2ApplicationOptions {
  readonly authority: ProductAuthorityService
  readonly environment: string
  readonly storage: RuntimeStorage
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  readonly revision: string
  readonly workspace: RuntimeActorOptions["workspace"]
  readonly actorOptions?: RuntimeActorOptions["actorOptions"]
  readonly registry?: RuntimeActorOptions["registry"]
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
  "@rika/api-v2/hosted/application/ApiV2Application",
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
      model: options.model,
      revision: options.revision,
      workspace: options.workspace,
    }
    if (options.actorOptions !== undefined) Object.assign(actorOptions, { actorOptions: options.actorOptions })
    if (options.registry !== undefined) Object.assign(actorOptions, { registry: options.registry })
    const registry = rivetRegistry(actorOptions)
    const gateway = options.gateway ?? makeRawRivetGateway({ registry })
    const runtimeActor = registry.config.use.rikaRuntime
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
      handle: (input) => {
        const request = {
          authority: options.authority,
          gateway,
          environment: options.environment,
          request: input.request,
        }
        if (input.websocket !== undefined) Object.assign(request, { websocket: input.websocket })
        return handleApiV2Request(request)
      },
    })
  })

/** Compose the temporary API directly from Rika's published identity/product repository services. */
export const makeApiV2RepositoryApplication = (options: ApiV2RepositoryApplicationOptions) => {
  const { productAuthority, ...application } = options
  return makeApiV2Application({
    ...application,
    authority: makeRepositoryProductAuthority(productAuthority),
  })
}
