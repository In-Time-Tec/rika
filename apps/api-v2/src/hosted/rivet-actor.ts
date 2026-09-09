import { Effect, Layer, Schema } from "effect"
import { setup } from "rivetkit"
import {
  makeRuntimeActor,
  type RuntimeActorDefinition,
  type RuntimeActorOptions as GeneralistRuntimeActorOptions,
} from "generalist/unstable/rivet"
import { ExecutableResolver } from "generalist/runtime"
import type { LanguageModel } from "effect/unstable/ai"
import type { RunnerWorkspaceError, RunnerWorkspaceService } from "./host"
import { serverOptionsEffect } from "./server"
import { threadPartition, type ThreadExecutionBinding } from "./partition"
import { ProductAuthorizationError, type ProductAuthorityService } from "./product-authority"
import type { RuntimeStorage } from "./storage"

export interface RuntimeRegistry {
  readonly config: {
    readonly use: { readonly rikaRuntime: RuntimeActorDefinition }
  }
}

export interface RuntimeActorOptions {
  readonly authority: ProductAuthorityService
  readonly storage: RuntimeStorage
  readonly model: Layer.Layer<LanguageModel.LanguageModel>
  readonly revision: string
  readonly workspace: (binding: ThreadExecutionBinding) => Effect.Effect<RunnerWorkspaceService, RunnerWorkspaceError>
  readonly actorOptions?: GeneralistRuntimeActorOptions["actorOptions"]
}

const keyParts = Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString])

const decodeKey = (key: ReadonlyArray<string>) => Schema.decodeUnknownSync(keyParts)(key)

export const namespaceForKey = (key: ReadonlyArray<string>) => {
  const [environment, ownerId, threadId] = decodeKey(key)
  const partition = threadPartition({ environment, ownerId, threadId, target: "runner" })
  return {
    environment: partition.environment,
    tenant: partition.ownerId,
    partition: partition.partition,
  }
}

export const makeRuntimeActorDefinition = (options: RuntimeActorOptions): RuntimeActorDefinition => {
  const resolver = ExecutableResolver.layerStatic([]).pipe(Layer.orDie)
  const actorOptions: GeneralistRuntimeActorOptions = {
    storage: options.storage,
    resolver,
    addresses: [],
    namespace: ({ key }) => namespaceForKey(key),
    server: {
      make: ({ key, namespace }) =>
        Effect.gen(function* () {
          const [, ownerId, threadId] = decodeKey(key)
          const binding = yield* options.authority.threadBinding(threadId, ownerId)
          if (binding === undefined)
            return yield* ProductAuthorizationError.make({
              kind: "invalid",
              message: `Rika Thread ${threadId} has no execution binding`,
            })
          const partition = threadPartition({
            environment: namespace.environment,
            ownerId,
            threadId,
            target: binding.partition.target,
          })
          const workspace = yield* options.workspace(binding)
          return yield* serverOptionsEffect({
            authority: options.authority,
            partition,
            host: {
              revision: options.revision,
              model: options.model,
              workspace,
            },
          })
        }).pipe(Effect.orDie),
    },
  }
  if (options.actorOptions !== undefined) Object.assign(actorOptions, { actorOptions: options.actorOptions })
  return makeRuntimeActor(actorOptions)
}

export const rivetRegistry = (options: RuntimeActorOptions): RuntimeRegistry =>
  setup({ use: { rikaRuntime: makeRuntimeActorDefinition(options) } })
