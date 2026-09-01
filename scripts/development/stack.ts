import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess } from "effect/unstable/process"
import { spawnOwned } from "./owned-child-process"

export const remoteStageIdentity = ".alchemy/rika-dev-stage"
const personalStage = /^dev-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const protectedStage = /^(?:prod(?:uction)?|staging|pr-.+)$/

class DevelopmentStackError extends Schema.TaggedError<DevelopmentStackError>()("DevelopmentStackError", {
  message: Schema.String,
}) {}

const failure = (message: string) => DevelopmentStackError.make({ message })

const AttestedProjectState = Schema.Struct({
  resourceType: Schema.Literal("Railway.Project"),
  props: Schema.Struct({ name: Schema.String }),
  attr: Schema.Struct({ projectId: Schema.String }),
})
const decodeAttestedProjectState = Schema.decodeEffect(Schema.fromJsonString(AttestedProjectState))

export const parseRemoteStage = (value: string) => {
  const stage = value.trim()
  if (protectedStage.test(stage)) throw new Error(`Refusing to use protected Railway stage: ${stage}`)
  if (!personalStage.test(stage)) throw new Error("Personal Railway stages must match dev-<lowercase UUIDv4>")
  return stage
}

export const readRemoteStage = Effect.fn("DevelopmentStack.readRemoteStage")(function* (root: string = process.cwd()) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const identity = path.resolve(root, remoteStageIdentity)
  const [metadata, realRoot, realDirectory, realIdentity] = yield* Effect.all([
    fileSystem.stat(identity),
    fileSystem.realPath(root),
    fileSystem.realPath(path.dirname(identity)),
    fileSystem.realPath(identity),
  ])
  if (
    metadata.type !== "File" ||
    realDirectory !== path.join(realRoot, ".alchemy") ||
    realIdentity !== path.join(realDirectory, path.basename(identity))
  )
    return yield* failure(`${remoteStageIdentity} and its parent must not be symbolic links`)
  yield* fileSystem.chmod(identity, 0o600)
  const value = yield* fileSystem.readFileString(identity)
  return yield* Effect.try({
    try: () => parseRemoteStage(value),
    catch: (cause) => failure(cause instanceof Error ? cause.message : "Personal Railway stage is invalid"),
  })
})

export const ensureRemoteStage = Effect.fn("DevelopmentStack.ensureRemoteStage")(function* (
  root: string = process.cwd(),
) {
  const crypto = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve(root, ".alchemy")
  const identity = path.resolve(root, remoteStageIdentity)
  if (yield* fileSystem.exists(directory)) {
    const [realRoot, realDirectory] = yield* Effect.all([fileSystem.realPath(root), fileSystem.realPath(directory)])
    if (realDirectory !== path.join(realRoot, ".alchemy"))
      return yield* failure(".alchemy must be a real private directory, not a symbolic link")
  } else yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fileSystem.chmod(directory, 0o700)
  if (yield* fileSystem.exists(identity)) return yield* readRemoteStage(root)

  const stage = `dev-${yield* crypto.randomUUIDv4}`
  const temporary = `${identity}.${yield* crypto.randomUUIDv4}.tmp`
  yield* fileSystem.writeFileString(
    temporary,
    `${stage}
`,
    { flag: "wx", mode: 0o600 },
  )
  const installed = yield* fileSystem.link(temporary, identity).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
    ),
    Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
  )
  return installed ? stage : yield* readRemoteStage(root)
})

const preserveRemoteState = Effect.fn("DevelopmentStack.preserveRemoteState")(function* (stage: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let parent = path.resolve(process.cwd(), ".alchemy")
  let realParent = yield* fileSystem.realPath(parent)
  for (const segment of ["state", "Rika", stage]) {
    const directory = path.join(parent, segment)
    if (yield* fileSystem.exists(directory)) {
      const realDirectory = yield* fileSystem.realPath(directory)
      if (realDirectory !== path.join(realParent, segment))
        return yield* failure(`${directory} must be a real private directory, not a symbolic link`)
    } else yield* fileSystem.makeDirectory(directory, { mode: 0o700 })
    yield* fileSystem.chmod(directory, 0o700)
    parent = directory
    realParent = path.join(realParent, segment)
  }
})

const assertDestroyableRemoteState = Effect.fn("DevelopmentStack.assertDestroyableRemoteState")(function* (
  stage: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const statePath = path.resolve(process.cwd(), ".alchemy", "state", "Rika", stage, "Project.json")
  const missingState = () =>
    failure(`No attested Alchemy project state exists for ${stage}; retry dev:remote before destroy`)
  const [metadata, realDirectory, realState] = yield* Effect.all([
    fileSystem.stat(statePath),
    fileSystem.realPath(path.dirname(statePath)),
    fileSystem.realPath(statePath),
  ]).pipe(Effect.mapError(missingState))
  if (metadata.type !== "File" || realState !== path.join(realDirectory, "Project.json"))
    return yield* failure(`Alchemy project state for ${stage} must not be a symbolic link`)
  const encoded = yield* fileSystem.readFileString(statePath).pipe(Effect.mapError(missingState))
  const state = yield* decodeAttestedProjectState(encoded).pipe(
    Effect.mapError(() => failure(`Alchemy project state for ${stage} is malformed; refusing destroy`)),
  )
  if (state.props.name !== `rika-${stage}` || state.attr.projectId.length === 0)
    return yield* failure(`Alchemy project state does not attest the personal ${stage} project; refusing destroy`)
})

type Operation = "local" | "remote" | "destroy"

const alchemyCommand = (operation: Operation, stage?: string) => {
  if (operation === "local") return ["dev"]
  if (stage === undefined) throw new Error("A personal Railway stage is required")
  if (operation === "remote")
    return ["deploy", "--config", "alchemy.run.ts", "--stage", stage, "--adopt", "--force", "--yes"]
  return ["destroy", "--config", "alchemy.run.ts", "--stage", stage, "--yes"]
}

const runAlchemy = Effect.fn("DevelopmentStack.runAlchemy")(function* (operation: Operation, stage?: string) {
  const args = yield* Effect.try({
    try: () => alchemyCommand(operation, stage),
    catch: (cause) => failure(cause instanceof Error ? cause.message : "Alchemy command is invalid"),
  })
  const target = operation === "local" ? "local" : "railway"
  const child = yield* spawnOwned(
    ChildProcess.make("alchemy", args, {
      cwd: process.cwd(),
      env: { RIKA_ALCHEMY_TARGET: target, RIKA_ALCHEMY_OPERATION: operation },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  return Number(yield* child.exitCode)
})

const execute = (operation: Operation) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.sync(() => process.umask(0o077))
      let stage: string | undefined
      if (operation === "remote") stage = yield* ensureRemoteStage()
      else if (operation === "destroy") stage = yield* readRemoteStage()
      if (stage !== undefined) {
        yield* Effect.log(`Rika personal Railway stage: ${stage}`)
        yield* preserveRemoteState(stage)
        if (operation === "destroy") yield* assertDestroyableRemoteState(stage)
      }
      const exitCode =
        stage === undefined
          ? yield* runAlchemy(operation)
          : yield* runAlchemy(operation, stage).pipe(Effect.onExit(() => preserveRemoteState(stage)))
      yield* Effect.sync(() => {
        process.exitCode = exitCode
      })
    }),
  )

const command = Command.make("rika-development-stack").pipe(
  Command.withSubcommands([
    Command.make("local", {}, () => execute("local")),
    Command.make("remote", {}, () => execute("remote")),
    Command.make("destroy", {}, () => execute("destroy")),
  ]),
)
const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
