import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { archiveName, archiveRoot, ownedTargetEntries, validateArchiveSet } from "./release-archive"
import { isPackageTarget, targetNames, targets, type PackageTarget } from "./package-target-contract"
import type { ReleaseEvidence } from "./release-evidence"

const buildFailure = (cause: unknown): string => {
  const errors = cause instanceof AggregateError ? cause.errors : []
  return errors.length === 0 ? String(cause) : `${String(cause)}\n${errors.map(String).join("\n")}`
}

const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

class PackageError extends Data.TaggedError("PackageError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

const packageError = (operation: string, message: string, cause?: unknown) =>
  new PackageError({ operation, message, cause })

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url))
  const artifacts = path.join(root, "artifacts")
  const manifest = yield* fileSystem
    .readFileString(path.join(root, "apps/rika/package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageManifestJson)))

  const buildIdentity = Effect.fn("Package.buildIdentity")(() =>
    Effect.gen(function* () {
      const [revision, changes] = yield* Effect.all(
        [
          spawner.string(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: root })),
          spawner.string(
            ChildProcess.make(
              "git",
              ["diff", "--binary", "HEAD", "--", "apps", "packages", "scripts", "package.json", "bun.lock"],
              { cwd: root },
            ),
          ),
        ],
        { concurrency: 2 },
      )
      const normalizedRevision = revision.trim()
      return {
        revision: normalizedRevision,
        identity: new Bun.CryptoHasher("sha256").update(`${normalizedRevision}\0${changes}`).digest("hex"),
      }
    }),
  )

  const checkedBuild = Effect.fn("Package.checkedBuild")(
    (entrypoint: string, outfile: string, target: PackageTarget, identity: string) =>
      Effect.tryPromise({
        try: () => {
          const metadata = targets[target]
          return Bun.build({
            entrypoints: [path.join(root, "apps/rika/src", entrypoint)],
            compile: { target: metadata.bun, outfile },
            minify: true,
            external: ["msgpackr-extract"],
            loader: { ".txt": "text" },
            define: {
              RIKA_VERSION: `"${manifest.version}"`,
              RIKA_BUILD_IDENTITY: `"${identity}"`,
              "process.env.OPENTUI_LIBC": `"${metadata.opentuiLibc}"`,
            },
          })
        },
        catch: (cause) =>
          packageError("build", `build ${target} ${path.basename(outfile)} failed: ${buildFailure(cause)}`, cause),
      }).pipe(
        Effect.flatMap((result) => {
          if (!result.success)
            return Effect.fail(
              packageError(
                "build",
                `build ${target} ${path.basename(outfile)} failed:\n${result.logs.map(String).join("\n")}`,
              ),
            )
          if (result.outputs.length !== 1)
            return Effect.fail(
              packageError("build", `build ${target} ${path.basename(outfile)} emitted unexpected assets`),
            )
          return Effect.void
        }),
      ),
  )

  const buildTarget = Effect.fn("Package.buildTarget")((target: PackageTarget) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(artifacts, { recursive: true })
      yield* Effect.forEach(
        ownedTargetEntries(manifest.version, target),
        (entry) => fileSystem.remove(path.join(artifacts, entry), { recursive: true, force: true }),
        { concurrency: "unbounded", discard: true },
      )
      const stageName = archiveRoot(manifest.version, target)
      const stage = path.join(artifacts, stageName)
      const bin = path.join(stage, "bin")
      yield* fileSystem.makeDirectory(bin, { recursive: true })
      yield* Effect.acquireUseRelease(
        Effect.succeed(stage),
        () =>
          Effect.gen(function* () {
            const { identity } = yield* buildIdentity()
            yield* checkedBuild("client-main.ts", path.join(bin, "rika"), target, identity)
            yield* checkedBuild("interactive-main.ts", path.join(bin, ".rika-interactive"), target, identity)
            yield* checkedBuild("resident-main.ts", path.join(bin, ".rika-resident"), target, identity)
            yield* checkedBuild("performance-main.ts", path.join(bin, ".rika-performance"), target, identity)
            yield* fileSystem.writeFileString(
              path.join(stage, "INSTALL"),
              "Install bin/rika on PATH. Keep the private executables in bin beside it.\n",
            )
            const exitCode = yield* spawner.exitCode(
              ChildProcess.make(
                "tar",
                ["-czf", path.join(artifacts, archiveName(manifest.version, target)), stageName],
                { cwd: artifacts },
              ),
            )
            if (Number(exitCode) !== 0)
              return yield* packageError("archive", `archive ${target}: tar exited with code ${exitCode}`)
          }),
        () => fileSystem.remove(stage, { recursive: true, force: true }),
      )
    }),
  )

  const aggregate = Effect.fn("Package.aggregate")(() =>
    Effect.gen(function* () {
      validateArchiveSet(manifest.version, yield* fileSystem.readDirectory(artifacts))
      const { revision } = yield* buildIdentity()
      const releaseArtifacts = yield* Effect.forEach(
        targetNames,
        (target) =>
          Effect.gen(function* () {
            const archive = archiveName(manifest.version, target)
            const archivePath = path.join(artifacts, archive)
            const contents = yield* fileSystem.readFile(archivePath)
            const info = yield* fileSystem.stat(archivePath)
            return {
              target,
              archive,
              sha256: new Bun.CryptoHasher("sha256").update(contents).digest("hex"),
              bytes: Number(info.size),
            }
          }),
        { concurrency: "unbounded" },
      )
      const evidence: ReleaseEvidence = {
        schemaVersion: 1,
        version: manifest.version,
        revision,
        bun: Bun.version,
        artifacts: releaseArtifacts,
      }
      yield* fileSystem.writeFileString(
        path.join(artifacts, "SHA256SUMS"),
        releaseArtifacts.map((item) => `${item.sha256}  ${item.archive}`).join("\n") + "\n",
      )
      const encodedEvidence = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(evidence)
      yield* fileSystem.writeFileString(path.join(artifacts, "release-evidence.json"), encodedEvidence + "\n")
    }),
  )

  const targetIndex = Bun.argv.indexOf("--target")
  const aggregateRequested = Bun.argv.includes("--aggregate")
  if (aggregateRequested && targetIndex >= 0)
    return yield* packageError("select mode", "Use either --target or --aggregate")
  if (aggregateRequested) yield* aggregate()
  else {
    const selected = targetIndex < 0 ? undefined : Bun.argv[targetIndex + 1]
    if (selected === undefined) return yield* packageError("select target", "Explicit --target <target> is required")
    if (!isPackageTarget(selected)) return yield* packageError("select target", `Unsupported target: ${selected}`)
    yield* buildTarget(selected)
  }
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
