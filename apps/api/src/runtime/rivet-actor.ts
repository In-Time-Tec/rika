/* oxlint-disable typescript/no-unsafe-type-assertion -- the released raw-client factory hides its driver surface. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- the released raw-client factory hides its driver surface. */
/* oxlint-disable anti-slop/no-unknown-returns -- the released client WebSocket type is intentionally platform-specific. */
/* oxlint-disable effecttsgo/prefer-effect-signatures -- released Rivet client actions are Promise-based foreign boundaries. */
import { Effect, Layer, Schema, type Scope } from "effect"
import {
  sameBinding,
  type ExecutorFenceError,
  type ExecutorTransportError,
  type WorkspaceExecutorService,
} from "@rika/execution"
import { setup, type RegistryConfigInput } from "rivetkit"
import { createClient, type ClientConfigInput } from "rivetkit/client"
import {
  makeRuntimeActor,
  type RuntimeActorDefinition,
  type RuntimeActorOptions as GeneralistRuntimeActorOptions,
} from "generalist/unstable/rivet"
import { ExecutableResolver } from "generalist/runtime"
import type { ApiV2ContextComposition, HostOptions } from "./host"
import { serverOptionsEffect } from "./server"
import { threadPartition, type ThreadExecutionBinding, type ThreadPartition } from "./partition"
import { ProductAuthorizationError, type ProductAuthorityService } from "../product/authority"
import type { RuntimeStorage } from "./storage"
import * as WorkspaceHandle from "./workspace"

type RivetRegistry = ReturnType<typeof setup>

export interface RuntimeRegistry {
  readonly config: {
    readonly use: { readonly rikaRuntime: RuntimeActorDefinition }
  }
  readonly handler: RivetRegistry["handler"]
  readonly shutdown: RivetRegistry["shutdown"]
  readonly startAndWait: RivetRegistry["startAndWait"]
}

export interface RawRivetActorHandle {
  readonly fetch: (request: Request) => ReturnType<typeof fetch>
  // ast-grep-ignore: effect-prefer-effect-signatures -- released Rivet client URL resolution is a Promise-based foreign boundary.
  readonly getGatewayUrl: () => Promise<string>
  // ast-grep-ignore: effect-prefer-effect-signatures -- released Rivet client actions are Promise-based foreign boundaries.
  readonly action: (input: { readonly name: string; readonly args: unknown[] }) => Promise<unknown>
}

export interface RawRivetClient {
  readonly get: (name: string, key?: string | string[]) => RawRivetActorHandle
  readonly getOrCreate: (name: string, key?: string | string[]) => RawRivetActorHandle
}

/** Keep the released public client factory behind the only Rivet import seam. */
export const createRawRivetClient = (config: string | ClientConfigInput): RawRivetClient =>
  // SAFETY: createClient returns the released ClientRaw surface; the adapter narrows only the raw get/fetch/webSocket methods.
  createClient(config)

export interface RuntimeActorOptions {
  readonly authority: ProductAuthorityService
  readonly storage: RuntimeStorage
  readonly revision: string
  readonly workspace: (
    binding: ThreadExecutionBinding,
  ) => Effect.Effect<WorkspaceExecutorService, ExecutorTransportError | ExecutorFenceError, Scope.Scope>
  /** Resolve all Session context providers from the validated partition binding; never reuse another Thread's values. */
  readonly context: (input: {
    readonly partition: ThreadPartition
    readonly binding: ThreadExecutionBinding
    readonly workspace: WorkspaceExecutorService
    readonly rebindWorkspace: WorkspaceHandle.RuntimeWorkspace["rebind"]
  }) => Effect.Effect<ApiV2ContextComposition, ProductAuthorizationError, Scope.Scope>
  readonly actorOptions?: GeneralistRuntimeActorOptions["actorOptions"]
  readonly registry?: Omit<RegistryConfigInput<{ readonly rikaRuntime: RuntimeActorDefinition }>, "use">
}

const keyParts = Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString])

const decodeKey = (key: ReadonlyArray<string>) => Schema.decodeUnknownSync(keyParts)(key)

const samePlacement = (left: ThreadExecutionBinding["placement"], right: ThreadExecutionBinding["placement"]) =>
  left._tag === right._tag &&
  (left._tag === "Runner"
    ? right._tag === "Runner" &&
      left.workspaceId === right.workspaceId &&
      left.checkoutFingerprint === right.checkoutFingerprint
    : right._tag === "Orb" && left.workspaceId === right.workspaceId && left.lineageId === right.lineageId)

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
          const executionBinding = binding.workspaceBinding
          if (executionBinding === undefined)
            return yield* ProductAuthorizationError.make({
              kind: "invalid",
              message: `Rika Thread ${threadId} has no canonical execution workspace binding`,
            })
          if (!samePlacement(binding.placement, executionBinding.placement))
            return yield* ProductAuthorizationError.make({
              kind: "invalid",
              message: `Rika Thread ${threadId} has mismatched execution placement evidence`,
            })
          if (!sameBinding(workspace.binding, executionBinding))
            return yield* ProductAuthorizationError.make({
              kind: "invalid",
              message: `Rika Thread ${threadId} has a mismatched Executor binding`,
            })
          const handle = yield* WorkspaceHandle.makeRuntimeWorkspace({
            initial: workspace,
            resolve: (workspaceBinding) =>
              options.workspace({ ...binding, placement: workspaceBinding.placement, workspaceBinding }),
          })
          const composition = yield* options.context({
            partition,
            binding,
            workspace: handle.executor,
            rebindWorkspace: handle.rebind,
          })
          if (composition.materialization.sessionId !== partition.rootSessionId)
            return yield* ProductAuthorizationError.make({
              kind: "invalid",
              message: `Rika Thread ${threadId} has context for a different root Session`,
            })
          const host: HostOptions = {
            revision: options.revision,
            workspace: handle.executor,
            context: composition,
          }
          return yield* serverOptionsEffect({
            authority: options.authority,
            partition,
            host,
          })
        }).pipe(Effect.orDie),
    },
  }
  if (options.actorOptions !== undefined) Object.assign(actorOptions, { actorOptions: options.actorOptions })
  return makeRuntimeActor(actorOptions)
}

export const rivetRegistry = (options: RuntimeActorOptions): RuntimeRegistry => {
  const config = {
    ...options.registry,
    use: { rikaRuntime: makeRuntimeActorDefinition(options) },
  }
  return setup(config)
}
