import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"

export const boxExecutorInstallPath = "/usr/local/bin/rika-executor"
export const boxExecutorArtifactDirectory = "artifacts/box-executor"

export const boxExecutorTargets = [
  { name: "linux-arm64", architecture: "arm64", bunTarget: "bun-linux-arm64" },
  { name: "linux-x64", architecture: "x64", bunTarget: "bun-linux-x64" },
] as const

type BoxExecutorTarget = (typeof boxExecutorTargets)[number]

export const BoxExecutorArtifact = Schema.Struct({
  target: Schema.Literals(boxExecutorTargets.map((target) => target.name)),
  architecture: Schema.Literals(boxExecutorTargets.map((target) => target.architecture)),
  filename: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})

export const BoxExecutorInventory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  buildId: Schema.String,
  protocolVersion: Schema.Int,
  installPath: Schema.Literal(boxExecutorInstallPath),
  bunVersion: Schema.String,
  artifacts: Schema.Array(BoxExecutorArtifact),
})
export type BoxExecutorInventory = typeof BoxExecutorInventory.Type

export class BoxExecutorPackagingError extends Data.TaggedError("BoxExecutorPackagingError")<{
  readonly operation: "build" | "inventory" | "reproducibility" | "runtime"
  readonly message: string
}> {}

const packagingFailure = (operation: BoxExecutorPackagingError["operation"], message: string) =>
  new BoxExecutorPackagingError({ operation, message })

const RootManifest = Schema.fromJsonString(Schema.Struct({ packageManager: Schema.String }))

const filenameFor = (target: BoxExecutorTarget): string => `rika-executor-${target.name}`

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

const compile = (entrypoint: string, outfile: string, target: BoxExecutorTarget) =>
  Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [entrypoint],
        compile: { target: target.bunTarget, outfile },
        bytecode: false,
        minify: true,
      }),
    catch: () => packagingFailure("build", `Box Executor ${target.name} compilation failed`),
  }).pipe(
    Effect.flatMap((result) =>
      result.success && result.outputs.length === 1
        ? Effect.void
        : Effect.fail(packagingFailure("build", `Box Executor ${target.name} compilation failed`)),
    ),
  )

const compileReproducibly = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  entrypoint: string,
  staging: string,
  target: BoxExecutorTarget,
) =>
  Effect.gen(function* () {
    const first = path.join(staging, "first", filenameFor(target))
    const second = path.join(staging, "second", filenameFor(target))
    yield* fileSystem.makeDirectory(path.dirname(first), { recursive: true })
    yield* fileSystem.makeDirectory(path.dirname(second), { recursive: true })
    yield* compile(entrypoint, first, target)
    yield* compile(entrypoint, second, target)
    const [firstBytes, secondBytes] = yield* Effect.all([fileSystem.readFile(first), fileSystem.readFile(second)], {
      concurrency: 2,
    })
    const firstDigest = sha256(firstBytes)
    if (firstBytes.byteLength !== secondBytes.byteLength || firstDigest !== sha256(secondBytes))
      return yield* packagingFailure(
        "reproducibility",
        `Box Executor ${target.name} differed across identical compilations`,
      )
    return { bytes: firstBytes, digest: firstDigest }
  })

export const buildBoxExecutorArtifacts: Effect.Effect<
  BoxExecutorInventory,
  BoxExecutorPackagingError,
  FileSystem.FileSystem | Path.Path
> = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("../..", import.meta.url))
    const outputDirectory = path.join(root, boxExecutorArtifactDirectory)
    const manifest = yield* fileSystem.readFileString(path.join(root, "package.json")).pipe(
      Effect.flatMap(Schema.decodeEffect(RootManifest)),
      Effect.mapError(() => packagingFailure("runtime", "Root package manager declaration is invalid")),
    )
    const requiredBun = /^bun@(.+)$/.exec(manifest.packageManager)?.[1]
    if (requiredBun === undefined || Bun.version !== requiredBun)
      return yield* packagingFailure("runtime", "Box Executor artifacts require the repository-pinned Bun version")
    const staging = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-executor-package-" })
    const publish = path.join(staging, "publish")
    yield* fileSystem.makeDirectory(publish, { recursive: true })
    const entrypoint = path.join(root, "packages/runner/src/box/process.ts")
    const artifacts = yield* Effect.forEach(
      boxExecutorTargets,
      (target) =>
        compileReproducibly(fileSystem, path, entrypoint, staging, target).pipe(
          Effect.flatMap(({ bytes, digest }) => {
            const filename = filenameFor(target)
            return fileSystem.writeFile(path.join(publish, filename), bytes).pipe(
              Effect.andThen(fileSystem.chmod(path.join(publish, filename), 0o555)),
              Effect.as({
                target: target.name,
                architecture: target.architecture,
                filename,
                bytes: bytes.byteLength,
                sha256: digest,
              }),
            )
          }),
        ),
      { concurrency: 1 },
    )
    const inventory: BoxExecutorInventory = {
      schemaVersion: 1,
      buildId: currentExecutorPolicy.buildId,
      protocolVersion: currentExecutorPolicy.protocolVersion,
      installPath: boxExecutorInstallPath,
      bunVersion: Bun.version,
      artifacts,
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(BoxExecutorInventory))(inventory).pipe(
      Effect.mapError(() => packagingFailure("inventory", "Box Executor inventory could not be encoded")),
    )
    yield* fileSystem.writeFileString(path.join(publish, "inventory.json"), `${encoded}\n`)
    yield* fileSystem.writeFileString(
      path.join(publish, "SHA256SUMS"),
      `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join("\n")}\n`,
    )
    yield* fileSystem.makeDirectory(path.dirname(outputDirectory), { recursive: true })
    yield* fileSystem.remove(outputDirectory, { recursive: true, force: true })
    yield* fileSystem.rename(publish, outputDirectory)
    return inventory
  }).pipe(
    Effect.mapError((error) =>
      error instanceof BoxExecutorPackagingError
        ? error
        : packagingFailure("build", "Box Executor artifact packaging failed"),
    ),
  ),
)

const program = Effect.gen(function* () {
  const inventory = yield* buildBoxExecutorArtifacts
  yield* Effect.log(`built ${inventory.artifacts.length} Box Executor artifacts for ${inventory.buildId}`)
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
