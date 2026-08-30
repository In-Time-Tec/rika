import {
  type CheckpointRestore,
  type ExecutorBootstrapIdentity,
  type Fence,
  type SessionWire,
  Target,
  type WorkspaceSeedRestore,
} from "../protocol/messages"
import { Config as EffectConfig, Crypto, Effect, FileSystem, Option, Redacted, Schema } from "effect"
import { RemoteRepositoryRoot } from "../workspace/service"
import { HostError } from "./error"

export interface Config {
  readonly fence: Fence
  readonly templateBuildId: string | null
  readonly apiUrl: string
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly workspaceId: string
  readonly stateDirectory: string
  readonly wakeId: string
  readonly restoredSession?: SessionWire
}

export interface Identity extends ExecutorBootstrapIdentity {
  readonly stateDirectory: string
}

export interface Bootstrap {
  readonly credential: Redacted.Redacted<string>
  readonly identity: Identity
  readonly seed: WorkspaceSeedRestore | null
  readonly restore: CheckpointRestore | null
}

const executorStateDirectory = "/var/lib/rika-executor"
const sandboxIdPath = "/run/e2b/.E2B_SANDBOX_ID"
const workspaceRootConfig = EffectConfig.string("RIKA_EXECUTOR_WORKSPACE_ROOT").pipe(
  EffectConfig.withDefault(RemoteRepositoryRoot),
)
const workspaceRoot = workspaceRootConfig.pipe(
  Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_WORKSPACE_ROOT is invalid" })),
)
const workspaceUser = "rika-workspace"

const sandboxInstanceId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.readFileString(sandboxIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.catch(() => EffectConfig.string("E2B_SANDBOX_ID").pipe(EffectConfig.withDefault(""))),
  )
})

const required = (name: string) =>
  EffectConfig.nonEmptyString(name).pipe(Effect.mapError(() => HostError.make({ message: `${name} is required` })))

const executorIdentity = Effect.gen(function* () {
  const target = yield* Effect.flatMap(required("RIKA_EXECUTOR_TARGET"), (value) =>
    Schema.decodeUnknownEffect(Target)(value).pipe(
      Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_TARGET is invalid" })),
    ),
  )
  if (target !== "orb") return yield* HostError.make({ message: "Hosted executor target must be e2b" })
  const assignmentId = yield* required("RIKA_EXECUTOR_ASSIGNMENT_ID")
  const generationText = yield* required("RIKA_EXECUTOR_GENERATION")
  const assignmentGeneration = Number(generationText)
  if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 1)
    return yield* HostError.make({ message: "RIKA_EXECUTOR_GENERATION is invalid" })
  const repositoryId = yield* EffectConfig.option(EffectConfig.string("RIKA_EXECUTOR_REPOSITORY_ID"))
  const repository = Option.isNone(repositoryId)
    ? null
    : {
        repositoryId: repositoryId.value,
        owner: yield* required("RIKA_EXECUTOR_REPOSITORY_OWNER"),
        name: yield* required("RIKA_EXECUTOR_REPOSITORY_NAME"),
        commitSha: yield* required("RIKA_EXECUTOR_COMMIT_SHA"),
      }
  return {
    target,
    ownerId: yield* required("RIKA_EXECUTOR_OWNER_ID"),
    threadId: yield* required("RIKA_EXECUTOR_THREAD_ID"),
    assignmentId,
    assignmentGeneration,
    instanceId: target === "orb" ? yield* required("E2B_SANDBOX_ID") : yield* required("RIKA_EXECUTOR_INSTANCE_ID"),
    executorId: yield* required("RIKA_EXECUTOR_ID"),
    templateBuildId: yield* required("RIKA_EXECUTOR_TEMPLATE_BUILD_ID"),
    apiUrl: yield* required("RIKA_EXECUTOR_API_URL"),
    workspaceId: yield* required("RIKA_EXECUTOR_WORKSPACE_ID"),
    repository,
    lifecycle: "resume",
    environmentDigest: yield* required("RIKA_EXECUTOR_ENVIRONMENT_DIGEST"),
    setupCache: (yield* EffectConfig.string("RIKA_EXECUTOR_SETUP_CACHE").pipe(EffectConfig.withDefault("0"))) === "1",
    stateDirectory: yield* EffectConfig.string("RIKA_EXECUTOR_STATE_DIRECTORY").pipe(
      EffectConfig.withDefault(executorStateDirectory),
    ),
  } satisfies Identity
})

const restores = (identity: Identity, session: SessionWire) =>
  session.fence.target === identity.target &&
  session.fence.assignmentId === identity.assignmentId &&
  session.fence.assignmentGeneration === identity.assignmentGeneration &&
  session.fence.instanceId === identity.instanceId &&
  session.fence.executorId === `${identity.executorId}:${session.fence.processIncarnation}`

const configuration = (identity: Identity, bootstrapToken: Redacted.Redacted<string>, restoredSession?: SessionWire) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const processIncarnation =
      restoredSession === undefined
        ? yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => HostError.make({ message: "Could not create the process incarnation" })),
          )
        : restoredSession.fence.processIncarnation
    const wakeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => HostError.make({ message: "Could not create the workspace wake identity" })),
    )
    const config = {
      fence: {
        target: identity.target,
        assignmentId: identity.assignmentId,
        assignmentGeneration: identity.assignmentGeneration,
        instanceId: identity.instanceId,
        executorId: `${identity.executorId}:${processIncarnation}`,
        processIncarnation,
      },
      templateBuildId: identity.templateBuildId,
      apiUrl: identity.apiUrl,
      bootstrapToken,
      workspaceId: identity.workspaceId,
      stateDirectory: identity.stateDirectory,
      wakeId,
    }
    const result: Config = restoredSession === undefined ? config : { ...config, restoredSession }
    return result
  })

export const hostIdentity = {
  configuration,
  executorIdentity,
  executorStateDirectory,
  restores,
  sandboxInstanceId,
  workspaceRoot,
  workspaceUser,
}
