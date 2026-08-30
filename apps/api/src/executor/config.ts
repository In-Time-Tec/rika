import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Controller, ControllerError, layer as controllerLayer } from "@rika/e2b-executor/controller"
import { s3ObjectStoreLayer, vaultLayer } from "@rika/e2b-executor/checkpoint"
import { CredentialError, Credentials } from "@rika/e2b-executor/checkout"
import { layer as providerLayer } from "@rika/e2b-executor/provider"
import { HostedRepositories } from "../hosted/repositories"
import { Effect, Layer, Redacted, Schema } from "effect"

export class ExecutorConfigError extends Schema.TaggedError<ExecutorConfigError>()("ExecutorConfigError", {
  message: Schema.String,
}) {}

const orbUnavailable = () => ControllerError.make({ kind: "provider", message: "Orb execution is not configured" })

export const runnerOnlyControllerLayer = Layer.succeed(
  Controller,
  Controller.of({
    provision: () => Effect.fail(orbUnavailable()),
    replace: () => Effect.fail(orbUnavailable()),
    resume: () => Effect.fail(orbUnavailable()),
    pause: () => Effect.fail(orbUnavailable()),
    kill: () => Effect.fail(orbUnavailable()),
    portal: () => Effect.fail(orbUnavailable()),
    hello: () => Effect.fail(orbUnavailable()),
    reconnect: () => Effect.fail(orbUnavailable()),
    validateAccess: () => Effect.fail(orbUnavailable()),
    heartbeat: () => Effect.fail(orbUnavailable()),
    checkpoint: () => Effect.fail(orbUnavailable()),
    credential: () => Effect.fail(orbUnavailable()),
    revokeCredential: () => Effect.fail(orbUnavailable()),
    workspace: () => Effect.fail(orbUnavailable()),
    ready: () => Effect.fail(orbUnavailable()),
    loadSetupCache: () => Effect.fail(orbUnavailable()),
    storeSetupCache: () => Effect.fail(orbUnavailable()),
    activatePhase: () => Effect.fail(orbUnavailable()),
    cleanupOrphans: Effect.succeed([]),
  }),
)

const required = (environment: Record<string, string | undefined>, name: string) => {
  const value = environment[name]?.trim()
  return value === undefined || value.length === 0
    ? Effect.fail(ExecutorConfigError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

export const loadConfig = Effect.fn("ExecutorConfig.load")(function* (environment: Record<string, string | undefined>) {
  const apiUrl = yield* required(environment, "RIKA_EXECUTOR_API_URL")
  return {
    appId: yield* required(environment, "E2B_APP_ID"),
    deploymentId: yield* required(environment, "E2B_DEPLOYMENT_ID"),
    templateId: yield* required(environment, "E2B_TEMPLATE_ID"),
    templateBuildId: yield* required(environment, "E2B_TEMPLATE_BUILD_ID"),
    apiUrl,
    controlEgress: [new URL(apiUrl).hostname],
    apiKey: Redacted.make(yield* required(environment, "E2B_API_KEY"), { label: "e2b-api-key" }),
    checkpointBucket: yield* required(environment, "RIKA_WORKSPACE_CHECKPOINT_BUCKET"),
    checkpointRegion: yield* required(environment, "RIKA_WORKSPACE_CHECKPOINT_REGION"),
    checkpointEndpoint: environment.RIKA_WORKSPACE_CHECKPOINT_ENDPOINT?.trim() || undefined,
    checkpointKey: Redacted.make(yield* required(environment, "RIKA_WORKSPACE_ENCRYPTION_KEY"), {
      label: "workspace-encryption-key",
    }),
    setupCache: environment.RIKA_WORKSPACE_SETUP_CACHE === "true",
  }
})

export type ExecutorConfig = Effect.Success<ReturnType<typeof loadConfig>>

export const workspaceArchiveVaultLayer = (options: ExecutorConfig) =>
  vaultLayer(options.checkpointKey).pipe(
    Layer.provide(
      s3ObjectStoreLayer(
        Object.assign(
          {
            bucket: options.checkpointBucket,
            region: options.checkpointRegion,
          },
          options.checkpointEndpoint === undefined ? undefined : { endpoint: options.checkpointEndpoint },
        ),
      ),
    ),
    Layer.provide(BunFileSystem.layer),
  )

export const layer = (options: ExecutorConfig) =>
  controllerLayer(options).pipe(
    Layer.provide(providerLayer({ apiKey: options.apiKey })),
    Layer.provide(workspaceArchiveVaultLayer(options)),
    Layer.provide(
      Layer.effect(
        Credentials,
        Effect.gen(function* () {
          const repositories = yield* HostedRepositories
          return Credentials.of({
            issue: (request) =>
              repositories
                .credential(
                  request.purpose === "branch-push"
                    ? {
                        access: request.access,
                        ownerId: request.ownerId,
                        workspaceId: request.workspaceId,
                        repositoryId: request.repositoryId,
                        purpose: "branch-push",
                        publicationId: request.publicationId,
                        branch: request.branch,
                        ref: request.ref,
                        commitSha: request.commitSha,
                      }
                    : {
                        access: request.access,
                        ownerId: request.ownerId,
                        workspaceId: request.workspaceId,
                        repositoryId: request.repositoryId,
                        purpose: request.purpose,
                      },
                )
                .pipe(Effect.mapError((error) => CredentialError.make({ message: error.message }))),
            revoke: (access, purpose, publicationId) =>
              repositories
                .revoke(access, purpose, publicationId)
                .pipe(Effect.mapError((error) => CredentialError.make({ message: error.message }))),
          })
        }),
      ),
    ),
  )
