/* oxlint-disable anti-slop-effect/no-service-constructor-imports -- this production composition root binds the credential adapter without adding process-global services. */
import type { ProviderCredentialCipher } from "@rika/credential-vault/provider"
import { sameBinding, sameWorkspacePolicy, type WorkspaceBinding, type WorkspaceExecutorService } from "@rika/execution"
import { tools } from "@rika/execution/tools"
import {
  ContextMaterializationError,
  SecureCredentialReference,
  effectiveAuthorization,
  makeContextMaterializer,
  type Authorization,
  type ModelConfiguration,
  type SessionAuthorizationService,
} from "@rika/context"
import { remoteWorkspaceReader } from "@rika/context/remote"
import {
  Provider,
  type CredentialRecord,
  type ProviderCredentialOperations,
} from "@rika/product-store/provider-credentials"
import type { ProductRepositoryService } from "@rika/product-store/product-repository"
import { Effect, Layer, Schema, type Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { NestedOperation, Pins, ToolContext } from "generalist"
import { decodeThreadBinding } from "../executor/binding"
import { ProductAuthorizationError } from "../product/authority"
import { makeModelCredentialAccess } from "./credentials"
import type { ApiV2ContextComposition } from "./host"
import { ModelCredentialResolutionError, modelRegistryLayer } from "./models"
import type { PrepareSessionContext } from "./preparation"
import type { RuntimeWorkspace } from "./workspace"
import {
  samePartition,
  threadPartition,
  ThreadExecutionBinding,
  type ThreadPartition,
  type WorkspacePlacement,
} from "./partition"

export interface ApiV2RuntimeContextFactoryOptions {
  readonly product: Pick<ProductRepositoryService, "threadExecutionContext">
  readonly credentials: Pick<ProviderCredentialOperations, "credentialByOwner" | "credentialByIdentity">
  readonly cipher: ProviderCredentialCipher
  readonly model: Omit<ModelConfiguration, "credentialRefs">
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>
  readonly prepareWorkspace: ApiV2WorkspacePreparation
}

export interface ApiV2RuntimeContextInput {
  readonly partition: ThreadPartition
  readonly binding: ThreadExecutionBinding
  readonly workspace: WorkspaceExecutorService
  readonly rebindWorkspace: RuntimeWorkspace["rebind"]
}

export type ApiV2RuntimeContextFactory = (
  input: ApiV2RuntimeContextInput,
) => Effect.Effect<ApiV2ContextComposition, ProductAuthorizationError, Scope.Scope>

export type ApiV2WorkspacePreparation = (
  input: Parameters<PrepareSessionContext>[0] & Pick<ApiV2RuntimeContextInput, "partition" | "binding">,
) => Effect.Effect<
  WorkspaceBinding,
  ContextMaterializationError | NestedOperation.Failure,
  NestedOperation.Operations | ToolContext.ToolContext
>

const toolGrants = (binding: ThreadExecutionBinding) =>
  tools.map((tool) => ({
    name: tool.name,
    pin: Pins.makeCapability({
      name: tool.name,
      buildId: binding.workspaceBinding.buildId,
      protocolVersion: binding.workspaceBinding.protocolVersion,
    }),
  }))

const noWorkspaceContext = {
  readGuidance: () => Effect.succeed([]),
  listSkills: () => Effect.succeed([]),
}

const denied: Authorization = {
  allowedTools: [],
  allowedModels: [],
  allowedCredentials: [],
}

const productFailure = (kind: ProductAuthorizationError["kind"], message: string) =>
  ProductAuthorizationError.make({ kind, message })

const contextUnavailable = () =>
  ContextMaterializationError.make({
    reason: "revoked",
    message: "Current Session authorization is unavailable",
  })

const modelAuthorizationUnavailable = () =>
  ModelCredentialResolutionError.make({
    reason: "unavailable",
    message: "Current model authorization is unavailable",
  })

const samePlacement = (left: WorkspacePlacement, right: WorkspacePlacement) =>
  left._tag === right._tag &&
  (left._tag === "Runner"
    ? right._tag === "Runner" &&
      left.workspaceId === right.workspaceId &&
      left.checkoutFingerprint === right.checkoutFingerprint
    : right._tag === "Orb" && left.workspaceId === right.workspaceId && left.lineageId === right.lineageId)

const sameActorKey = (left: ThreadPartition, right: ThreadPartition) =>
  left.actorKey[0] === right.actorKey[0] &&
  left.actorKey[1] === right.actorKey[1] &&
  left.actorKey[2] === right.actorKey[2]

const sameThreadBinding = (left: ThreadExecutionBinding, right: ThreadExecutionBinding) =>
  samePartition(left.partition, right.partition) &&
  sameActorKey(left.partition, right.partition) &&
  samePlacement(left.placement, right.placement) &&
  sameBinding(left.workspaceBinding, right.workspaceBinding)

const bindingRemainsAuthorized = (left: ThreadExecutionBinding, right: ThreadExecutionBinding) =>
  sameThreadBinding(left, right) ||
  (left.partition.target === "orb" &&
    samePartition(left.partition, right.partition) &&
    sameActorKey(left.partition, right.partition) &&
    samePlacement(left.placement, right.placement) &&
    sameWorkspacePolicy(left.workspaceBinding, right.workspaceBinding) &&
    right.workspaceBinding.generation > left.workspaceBinding.generation)

const sameSelection = (
  left: { readonly provider: string; readonly model: string; readonly registrationKey?: string | undefined },
  right: { readonly provider: string; readonly model: string; readonly registrationKey?: string | undefined },
) => left.provider === right.provider && left.model === right.model && left.registrationKey === right.registrationKey

const isSelectedCredential = (
  credential: CredentialRecord | undefined,
  input: { readonly ownerId: string; readonly provider: Provider; readonly identity: string },
) =>
  credential !== undefined &&
  credential.status === "active" &&
  credential.ownerId === input.ownerId &&
  credential.provider === input.provider &&
  credential.credentialIdentity === input.identity

export const makeApiV2RuntimeContextFactory = (
  options: ApiV2RuntimeContextFactoryOptions,
): ApiV2RuntimeContextFactory =>
  Effect.fn("Rika.ApiV2RuntimeContext.make")(function* (input) {
    const binding = yield* Schema.decodeEffect(ThreadExecutionBinding)(input.binding).pipe(
      Effect.mapError(() => productFailure("invalid", "Thread execution context is invalid")),
    )
    const expectedPartition = threadPartition({
      environment: input.partition.environment,
      ownerId: input.partition.ownerId,
      threadId: input.partition.threadId,
      target: input.partition.target,
    })
    if (
      !samePartition(input.partition, expectedPartition) ||
      !sameActorKey(input.partition, expectedPartition) ||
      !samePartition(input.partition, binding.partition) ||
      !sameActorKey(input.partition, binding.partition) ||
      !samePlacement(binding.placement, binding.workspaceBinding.placement) ||
      !sameBinding(binding.workspaceBinding, input.workspace.binding)
    )
      return yield* productFailure("invalid", "Thread execution context does not match its workspace assignment")

    const readCurrentBinding = Effect.fn("Rika.ApiV2RuntimeContext.readBinding")(function* () {
      const row = yield* options.product
        .threadExecutionContext(input.partition.ownerId, input.partition.threadId)
        .pipe(Effect.mapError(() => productFailure("unavailable", "Thread execution context is unavailable")))
      if (row === undefined || row.lifecycle === "terminated")
        return yield* productFailure("invalid", "Thread execution context is unavailable")
      return yield* decodeThreadBinding(row, {
        environment: input.partition.environment,
        ownerId: input.partition.ownerId,
        threadId: input.partition.threadId,
      })
    })

    const currentBinding = yield* readCurrentBinding()
    if (!sameThreadBinding(binding, currentBinding))
      return yield* productFailure("invalid", "Thread workspace assignment is no longer current")

    const provider = yield* Schema.decodeUnknownEffect(Provider)(options.model.selection.provider).pipe(
      Effect.mapError(() => productFailure("invalid", "The selected model provider is unavailable")),
    )
    const credential = yield* options.credentials
      .credentialByOwner(input.partition.ownerId, provider)
      .pipe(Effect.mapError(() => productFailure("unavailable", "Owner model credential is unavailable")))
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.ownerId !== input.partition.ownerId ||
      credential.provider !== provider
    )
      return yield* productFailure("invalid", "Owner model credential is unavailable")
    const reference = yield* Schema.decodeEffect(SecureCredentialReference)({
      provider,
      reference: `credential://${credential.credentialIdentity}`,
    }).pipe(Effect.mapError(() => productFailure("invalid", "Owner model credential reference is invalid")))
    const model: ModelConfiguration = { ...options.model, credentialRefs: [reference] }
    const policy = yield* makeContextMaterializer(noWorkspaceContext)
      .discover({
        sessionId: input.partition.rootSessionId,
        guidanceScope: `${input.partition.rootSessionId}-workspace`,
        binding: binding.workspaceBinding,
        capturedAt: "1970-01-01T00:00:00.000Z",
        model,
        tools: toolGrants(binding),
      })
      .pipe(Effect.mapError(() => productFailure("invalid", "Session context policy is invalid")))

    const credentialIdentity = credential.credentialIdentity
    const authorization: SessionAuthorizationService = {
      current: (sessionId) => {
        if (sessionId !== policy.sessionId) return Effect.succeed(denied)
        return Effect.gen(function* () {
          const current = yield* readCurrentBinding()
          if (!bindingRemainsAuthorized(binding, current)) return denied
          const currentCredential = yield* options.credentials.credentialByIdentity(credentialIdentity)
          if (
            !isSelectedCredential(currentCredential, {
              ownerId: input.partition.ownerId,
              provider,
              identity: credentialIdentity,
            })
          )
            return denied
          return {
            allowedTools: policy.tools.map((tool) => tool.name),
            allowedModels: [policy.modelPin],
            allowedCredentials: [reference],
          }
        }).pipe(Effect.mapError(contextUnavailable))
      },
    }

    const authorizePreparation = (sessionId: string) =>
      authorization.current(sessionId).pipe(
        Effect.flatMap((current) => effectiveAuthorization(policy, current)),
        Effect.flatMap((current) =>
          current.canResume
            ? Effect.void
            : Effect.fail(
                ContextMaterializationError.make({
                  reason: "revoked",
                  message: "Workspace preparation is not authorized",
                }),
              ),
        ),
      )

    const credentialAccess = makeModelCredentialAccess({
      credentials: options.credentials,
      cipher: options.cipher,
      authorize: (selection) =>
        authorization.current(policy.sessionId).pipe(
          Effect.flatMap((current) => effectiveAuthorization(policy, current)),
          Effect.map(
            (current) =>
              current.canResume &&
              current.allowedModels.includes(policy.modelPin) &&
              sameSelection(selection, policy.model.selection),
          ),
          Effect.mapError(modelAuthorizationUnavailable),
        ),
    })

    return {
      materialization: policy,
      authorization,
      rebindWorkspace: input.rebindWorkspace,
      ensureWorkspace: (preparation) =>
        authorizePreparation(preparation.sessionId).pipe(
          Effect.andThen(readCurrentBinding().pipe(Effect.mapError(contextUnavailable))),
          Effect.flatMap((current) => {
            if (!bindingRemainsAuthorized(binding, current))
              return ContextMaterializationError.make({
                reason: "binding",
                message: "Workspace assignment is no longer authorized",
              })
            return input.partition.target === "orb"
              ? options.prepareWorkspace({ ...preparation, partition: input.partition, binding: current })
              : Effect.succeed(current.workspaceBinding)
          }),
        ),
      prepare: (preparation) =>
        authorizePreparation(preparation.sessionId).pipe(
          Effect.andThen(() =>
            makeContextMaterializer(
              remoteWorkspaceReader({ binding: input.workspace.binding, workspace: input.workspace }),
            ).discover({
              sessionId: policy.sessionId,
              guidanceScope: policy.guidanceScope,
              binding: input.workspace.binding,
              capturedAt: preparation.admittedAt,
              model: policy.model,
              tools: policy.tools,
            }),
          ),
        ),
      modelRegistry: modelRegistryLayer({
        ownerId: input.partition.ownerId,
        model: policy.model,
        credentials: credentialAccess,
        httpClientLayer: options.httpClientLayer,
      }).pipe(Layer.orDie),
    }
  })
