import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { defaultBuildLogger, Template } from "e2b"
import { Config, Console, Crypto, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import {
  DevelopmentTemplateIdentity,
  developmentTemplate,
  developmentTemplateSourceDigest,
  isReadyDevelopmentTemplate,
} from "../src/development-template"

const IdentityJson = Schema.fromJsonString(DevelopmentTemplateIdentity)
const decodeIdentity = Schema.decodeUnknownEffect(IdentityJson)
const encodeIdentity = Schema.encodeEffect(IdentityJson)

class DevelopmentTemplateError extends Schema.TaggedError<DevelopmentTemplateError>()("DevelopmentTemplateError", {
  message: Schema.String,
}) {}

const failure = (cause: unknown, fallback: string) =>
  DevelopmentTemplateError.make({ message: cause instanceof Error ? cause.message : fallback })

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const apiKey = yield* Config.redacted("E2B_API_KEY")
  const expectedDigest = yield* Config.string("RIKA_DEV_E2B_SOURCE_DIGEST")
  const repositoryRoot = yield* Config.string("RIKA_DEV_REPOSITORY_ROOT").pipe(Config.withDefault(process.cwd()))
  const identityPath = yield* Config.string("RIKA_DEV_E2B_IDENTITY_PATH").pipe(
    Config.withDefault(path.join(repositoryRoot, ".alchemy/e2b-development-template.json")),
  )
  const sourceDigest = yield* Effect.tryPromise({
    try: () => developmentTemplateSourceDigest(repositoryRoot),
    catch: (cause) => failure(cause, "Could not hash the development E2B template"),
  })
  if (sourceDigest !== expectedDigest)
    return yield* DevelopmentTemplateError.make({ message: "Development E2B source changed before template admission" })

  const cached = yield* fileSystem.readFileString(identityPath).pipe(
    Effect.flatMap(decodeIdentity),
    Effect.orElseSucceed(() => undefined),
  )
  if (cached?.sourceDigest === sourceDigest) {
    const status = yield* Effect.tryPromise({
      try: () =>
        Template.getBuildStatus(
          { templateId: cached.templateId, buildId: cached.buildId },
          { apiKey: Redacted.value(apiKey) },
        ),
      catch: (cause) => failure(cause, "Could not attest the cached development E2B template"),
    })
    if (!isReadyDevelopmentTemplate(cached, sourceDigest, status))
      return yield* DevelopmentTemplateError.make({
        message: "Cached development E2B template is not the exact ready build",
      })
    yield* Console.log(`E2B executor template ready: ${cached.templateId}:${cached.buildId}`)
    return
  }

  const alias = `rika-executor-dev-${sourceDigest.slice("sha256:".length, "sha256:".length + 20)}`
  const built = yield* Effect.tryPromise({
    try: () =>
      Template.build(developmentTemplate(repositoryRoot), alias, {
        apiKey: Redacted.value(apiKey),
        onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
      }),
    catch: (cause) => failure(cause, "Development E2B template build failed"),
  })
  const status = yield* Effect.tryPromise({
    try: () =>
      Template.getBuildStatus(
        { templateId: built.templateId, buildId: built.buildId },
        { apiKey: Redacted.value(apiKey) },
      ),
    catch: (cause) => failure(cause, "Could not attest the new development E2B template"),
  })
  const identity = DevelopmentTemplateIdentity.make({
    sourceDigest,
    templateId: built.templateId,
    buildId: built.buildId,
  })
  if (!isReadyDevelopmentTemplate(identity, sourceDigest, status))
    return yield* DevelopmentTemplateError.make({ message: "New development E2B template is not ready" })

  const currentDigest = yield* Effect.tryPromise({
    try: () => developmentTemplateSourceDigest(repositoryRoot),
    catch: (cause) => failure(cause, "Could not recheck the development E2B template source"),
  })
  if (currentDigest !== sourceDigest)
    return yield* DevelopmentTemplateError.make({ message: "Development E2B source changed during template build" })

  const encoded = yield* encodeIdentity(identity)
  const temporary = `${identityPath}.${yield* crypto.randomUUIDv4}.tmp`
  yield* fileSystem.makeDirectory(path.dirname(identityPath), { recursive: true, mode: 0o700 })
  yield* fileSystem
    .writeFileString(temporary, `${encoded}\n`, { mode: 0o600 })
    .pipe(
      Effect.andThen(fileSystem.rename(temporary, identityPath)),
      Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
    )
  yield* Console.log(`E2B executor template ready: ${identity.templateId}:${identity.buildId}`)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
