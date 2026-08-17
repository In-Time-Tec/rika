import { defaultWorkerModules } from "@rika/kernel/kernel-composition"
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

const WorkspaceCatalogJson = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.Struct({ catalog: Schema.Record(Schema.String, Schema.String) }) }),
)

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

  /**
   * A compiled binary embeds whatever is installed in node_modules, not what the catalog pins. A
   * stale install therefore ships a product built against dependency versions the repository never
   * resolved, and nothing downstream can detect it: the source, the lockfile, and the version
   * string all look correct. Compare the installed manifest of every catalog-pinned dependency
   * against the version the catalog names, and refuse to build on any mismatch.
   */
  const assertInstalledDependencies = Effect.fn("Package.assertInstalledDependencies")(() =>
    Effect.gen(function* () {
      const catalog = yield* fileSystem
        .readFileString(path.join(root, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceCatalogJson)))
      const pinned = Object.entries(catalog.workspaces.catalog).filter(([name]) => name.startsWith("@batonfx/"))
      const drift = yield* Effect.forEach(pinned, ([name, expected]) =>
        Effect.try({
          try: () => Bun.resolveSync(`${name}/package.json`, path.join(root, "apps/rika")),
          catch: () => packageError("install", `${name} is not installed`),
        }).pipe(
          Effect.flatMap((manifestPath) => fileSystem.readFileString(manifestPath)),
          Effect.flatMap(Schema.decodeUnknownEffect(PackageManifestJson)),
          Effect.map(({ version }) =>
            version === expected ? [] : [`${name} installed ${version}, catalog pins ${expected}`],
          ),
          Effect.catch(() => Effect.succeed([`${name} could not be resolved from the workspace root`])),
        ),
      )
      const mismatches = drift.flat()
      if (mismatches.length === 0) return
      return yield* Effect.fail(
        packageError(
          "install",
          `node_modules does not match the catalog; run bun install before packaging so the binary embeds the pinned dependencies:\n${mismatches.join("\n")}`,
        ),
      )
    }),
  )

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
            yield* assertInstalledDependencies()
            const { identity } = yield* buildIdentity()
            yield* checkedBuild("client-main.ts", path.join(bin, "rika"), target, identity)
            yield* checkedBuild("interactive-main.ts", path.join(bin, ".rika-interactive"), target, identity)
            yield* checkedBuild("server-main.ts", path.join(bin, ".rika-server"), target, identity)
            yield* checkedBuild("performance-main.ts", path.join(bin, ".rika-performance"), target, identity)
            /**
             * A kernel is spawned as a file, and a compiled executable has no file for the module it
             * was built from, so the worker ships beside the binaries that spawn it.
             */
            yield* fileSystem.copyFile(defaultWorkerModules.worker, path.join(bin, ".rika-kernel-worker.js"))
            yield* Effect.forEach(
              defaultWorkerModules.support,
              (module) => fileSystem.copyFile(module, path.join(bin, path.basename(module))),
              { concurrency: "unbounded", discard: true },
            )
            /**
             * The worker is a script, so something has to run it. A compiled binary cannot execute
             * another module, and a user who installed Rika has not necessarily installed Bun, so the
             * runtime that spawns kernels ships with the product rather than being looked up on PATH.
             */
            const runtime = path.join(bin, ".rika-kernel-runtime")
            yield* fileSystem.copyFile(process.execPath, runtime)
            yield* fileSystem.chmod(runtime, 0o755)
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
