import { Clock, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { BetterAuthUserId, CommandId, IdempotencyKey, JsonObject, ThreadId } from "@rika/product/hosted-model"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { provisionalThreadTitle } from "@rika/product/thread-title-policy"
import { reviewIntent } from "@rika/product/review-policy"
import { TurnId } from "@rika/product/turn-record"
import { layer as postgresLayer } from "@rika/product-store/layer"
import { ProductRepository } from "@rika/product-store/product-repository"
import { RunnerRegistrations } from "@rika/product-store/runner-registrations"
import { HostedModelRegistry, testLayer as hostedModelRegistryTestLayer } from "./environment/model-registry"
import { hostedProductAuthorityOperations } from "./product/authority"
import { hostedProductConnectionOperation } from "./product/connection"
import {
  HostedProduct,
  HostedProductError,
  type HostedProductService,
  modelFailure,
  repositoryFailure,
  storeFailure,
  unavailable,
} from "./product/contract"
import { HostedRepositories, unavailableLayer as hostedRepositoriesUnavailableLayer } from "./repositories"

export * from "./product/contract"

export const layer = (options: {
  readonly orb?: {
    readonly templateBuildId: string
    readonly providerScope: string
  }
  readonly promptAdmissionReadiness: Effect.Effect<boolean>
}) =>
  Layer.effect(
    HostedProduct,
    Effect.gen(function* () {
      const clientAuthority = yield* HostedClientAuthority
      const protocol = yield* ThreadProtocolStore
      const gateway = yield* ExecutionGateway.Service
      const repository = yield* ProductRepository
      const runners = yield* RunnerRegistrations
      const policy = yield* AuthorizationPolicy
      const crypto = yield* Crypto.Crypto
      const modelRegistry = yield* HostedModelRegistry
      const repositories = yield* HostedRepositories
      const {
        activateClient,
        resolveOwner,
        projects,
        createProject,
        authorizeOwner,
        authorizeReadOwner,
        authorizeReadThread,
        authorizeThread,
        activatePrincipal,
      } = hostedProductAuthorityOperations({ clientAuthority, repository, policy, crypto })

      const connectionDependencies = {
        clientAuthority,
        repository,
        repositories,
        policy,
        crypto,
        activateClient,
        resolveOwner,
      }
      if (options.orb !== undefined) Object.assign(connectionDependencies, { orb: options.orb })
      const createConnection = hostedProductConnectionOperation(connectionDependencies)

      const registerRunner: HostedProductService["registerRunner"] = Effect.fn("HostedProduct.registerRunner")(
        function* (input) {
          const userId = BetterAuthUserId.make(input.principal.userId)
          const deviceId = yield* activateClient(input.principal, userId)
          yield* runners
            .upsert({ deviceId, userId, checkoutFingerprint: input.checkoutFingerprint, profile: input.registration })
            .pipe(Effect.mapError(repositoryFailure))
        },
        Effect.mapError(storeFailure),
      )

      const setRemoteThreadCreation: HostedProductService["setRemoteThreadCreation"] = Effect.fn(
        "HostedProduct.setRemoteThreadCreation",
      )(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        const updated = yield* runners
          .setRemoteThreadCreation({
            deviceId: input.principal.deviceId,
            userId: input.principal.userId,
            checkoutFingerprint: input.checkoutFingerprint,
            allowed: input.preference.preference === "allowed",
          })
          .pipe(Effect.mapError(repositoryFailure))
        if (!updated) return yield* HostedProductError.make({ kind: "not-found", message: "Runner is unavailable" })
      }, Effect.mapError(storeFailure))

      const pollRunner: HostedProductService["pollRunner"] = Effect.fn("HostedProduct.pollRunner")(function* (input) {
        yield* activateClient(input.principal, BetterAuthUserId.make(input.principal.userId))
        return yield* runners
          .claimSupervisorAndPoll({
            deviceId: input.principal.deviceId,
            userId: input.principal.userId,
            checkoutFingerprint: input.checkoutFingerprint,
            supervisorId: input.supervisorId,
            activeAssignmentIds: input.activeAssignmentIds,
          })
          .pipe(Effect.mapError(repositoryFailure))
      }, Effect.mapError(storeFailure))

      const threadExecutionContext: HostedProductService["threadExecutionContext"] = Effect.fn(
        "HostedProduct.threadExecutionContext",
      )(function* (ownerId, threadId) {
        const row = yield* repository.threadExecutionContext(ownerId, threadId).pipe(Effect.mapError(repositoryFailure))
        if (row === undefined)
          return yield* HostedProductError.make({ kind: "not-found", message: "Thread executor is unavailable" })
        const repositoryValue = row.checkout ?? row.localRepository
        const decodedRepository =
          repositoryValue === null
            ? null
            : yield* Schema.decodeUnknownEffect(JsonObject)(repositoryValue).pipe(Effect.mapError(unavailable))
        const decodedBranch =
          decodedRepository === null
            ? Option.none()
            : Schema.decodeUnknownOption(Schema.NonEmptyString)(decodedRepository.branch)
        const branch = Option.getOrNull(decodedBranch)
        return {
          workspaceId: row.workspaceId,
          repository: decodedRepository,
          branch,
          executor: {
            assignmentId: row.assignmentId,
            kind: row.executorKind,
            generation: row.generation,
            lifecycle: row.lifecycle,
            executorInstanceId: row.executorInstanceId,
            providerInstanceId: row.providerInstanceId,
          },
        }
      }, Effect.mapError(storeFailure))

      const admitAuthorizedRun: HostedProductService["admitAuthorizedRun"] = Effect.fn(
        "HostedProduct.admitAuthorizedRun",
      )(function* (input) {
        const executionRoute = yield* modelRegistry
          .resolve(input.authority.ownerId, input.mode)
          .pipe(Effect.mapError(modelFailure))
        const commandId = CommandId.make(input.operationKey)
        const turnId = TurnId.make(input.turnId)
        const completedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const readinessProof = yield* options.promptAdmissionReadiness
        const execution = yield* repository
          .threadExecutionContext(input.authority.ownerId, input.threadId)
          .pipe(Effect.mapError(repositoryFailure))
        if (execution === undefined)
          return yield* HostedProductError.make({ kind: "not-found", message: "Thread executor is unavailable" })
        const firstPromptTitle =
          execution.title === "New thread" && !execution.hasTurns ? provisionalThreadTitle(input.prompt) : undefined
        const startInput = {
          threadId: input.threadId,
          turnId: input.turnId,
          workspaceId: execution.workspaceId,
          prompt: input.prompt,
          executionRoute,
        }
        if (input.promptParts !== undefined) Object.assign(startInput, { promptParts: input.promptParts })
        if (input.review === true) Object.assign(startInput, { reviewIntent: reviewIntent(input.prompt) })
        if (firstPromptTitle !== undefined)
          Object.assign(startInput, {
            titleIntent: { _tag: "GenerateThreadTitle" as const, expectedTitle: firstPromptTitle },
          })
        const prepared = yield* gateway.prepareTurn(startInput)
        const promptInput = {
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          commandId,
          turnId,
          actor: input.authority.actor,
          prompt: input.prompt,
          executionRoute,
          prepared,
          submissionId: input.submissionId ?? input.operationKey,
          completedAt,
          queueCapacity: 32,
          readinessProof,
        }
        if (input.promptParts !== undefined) Object.assign(promptInput, { promptParts: input.promptParts })
        if (input.claimToken !== undefined) Object.assign(promptInput, { claimToken: input.claimToken })
        const admitted = yield* protocol.applyPrompt(promptInput, gateway.admitTurn(prepared))
        if (admitted._tag === "Cancelled") return { _tag: "Cancelled" as const, commandId: input.operationKey }
        return {
          _tag: "Admitted" as const,
          commandId: String(admitted.command.commandId),
          turnId: String(admitted.turnId),
          status: admitted.status,
        }
      }, Effect.mapError(storeFailure))

      const admitRun: HostedProductService["admitRun"] = Effect.fn("HostedProduct.admitRun")(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        const turnId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))
        const admittedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const threadId = ThreadId.make(input.threadId)
        const commandId = CommandId.make(input.operationKey)
        yield* protocol
          .initializeThread({ ownerId: authority.ownerId, threadId, actor: authority.actor })
          .pipe(Effect.mapError(storeFailure))
        const attachments = input.promptParts?.flatMap((part) => {
          if (part.type !== "image") return []
          const attachment = { mediaType: part.mediaType, data: part.data }
          return [part.filename === undefined ? attachment : { ...attachment, filename: part.filename }]
        })
        const command = {
          _tag: "SubmitPrompt",
          commandId: input.operationKey,
          threadId: input.threadId,
          text: input.prompt,
        }
        if (input.mode !== undefined) Object.assign(command, { mode: input.mode })
        if (input.review !== undefined) Object.assign(command, { review: input.review })
        if (attachments !== undefined && attachments.length > 0) Object.assign(command, { attachments })
        const admission = yield* protocol
          .admitServerCommand({
            ownerId: authority.ownerId,
            threadId,
            commandId,
            turnId: TurnId.make(turnId),
            idempotencyKey: IdempotencyKey.make(input.operationKey),
            actor: authority.actor,
            command,
            admittedAt,
          })
          .pipe(Effect.mapError(storeFailure))
        if (admission.command.turnId === undefined) return yield* unavailable()
        return yield* admitAuthorizedRun({ ...input, authority, turnId: String(admission.command.turnId) })
      })

      const cancelAuthorizedRunAdmission: HostedProductService["cancelAuthorizedRunAdmission"] = Effect.fn(
        "HostedProduct.cancelAuthorizedRunAdmission",
      )(function* (input) {
        const cancelledAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const cancellationInput = {
          ownerId: input.authority.ownerId,
          threadId: ThreadId.make(input.threadId),
          cancelCommandId: CommandId.make(input.cancelCommandId),
          targetCommandId: CommandId.make(input.targetCommandId),
          actor: input.authority.actor,
          cancelledAt,
        }
        if (input.claimToken !== undefined) Object.assign(cancellationInput, { claimToken: input.claimToken })
        const cancellation = yield* protocol.cancelPrompt(cancellationInput)
        return cancellation._tag === "Turn" ? { turnId: String(cancellation.turnId) } : {}
      }, Effect.mapError(storeFailure))

      const cancelRunAdmission: HostedProductService["cancelRunAdmission"] = Effect.fn(
        "HostedProduct.cancelRunAdmission",
      )(function* (input) {
        const authority = yield* authorizeThread(input.principal, input.threadId, "thread:operate")
        const cancelledAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const threadId = ThreadId.make(input.threadId)
        const commandId = CommandId.make(input.cancelCommandId)
        yield* protocol
          .initializeThread({ ownerId: authority.ownerId, threadId, actor: authority.actor })
          .pipe(Effect.mapError(storeFailure))
        yield* protocol
          .admitServerCommand({
            ownerId: authority.ownerId,
            threadId,
            commandId,
            idempotencyKey: IdempotencyKey.make(input.cancelCommandId),
            actor: authority.actor,
            command: {
              _tag: "Cancel",
              commandId: input.cancelCommandId,
              threadId: input.threadId,
              target: { _tag: "Command", commandId: input.targetCommandId },
            },
            admittedAt: cancelledAt,
          })
          .pipe(Effect.mapError(storeFailure))
        return yield* cancelAuthorizedRunAdmission({ ...input, authority })
      })

      return HostedProduct.of({
        ready: repository.ready.pipe(Effect.mapError(repositoryFailure)),
        projects,
        createProject,
        createConnection,
        registerRunner,
        setRemoteThreadCreation,
        pollRunner,
        admitRun,
        admitAuthorizedRun,
        cancelRunAdmission,
        cancelAuthorizedRunAdmission,
        authorizeOwner,
        authorizeReadOwner,
        authorizeReadThread,
        authorizeThread,
        threadExecutionContext,
        activatePrincipal,
      })
    }),
  )

export const postgresTest = (options: {
  readonly database: Parameters<typeof postgresLayer>[0]
  readonly templateBuildId: string
  readonly providerScope: string
  readonly promptAdmissionReadiness?: Effect.Effect<boolean>
}) =>
  layer({
    orb: {
      templateBuildId: options.templateBuildId,
      providerScope: options.providerScope,
    },
    promptAdmissionReadiness: options.promptAdmissionReadiness ?? Effect.succeed(true),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        postgresLayer(options.database),
        AuthorizationPolicy.layer,
        ExecutionGateway.layerTest(),
        hostedModelRegistryTestLayer,
        hostedRepositoriesUnavailableLayer,
      ),
    ),
  )
