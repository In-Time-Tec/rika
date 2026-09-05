import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { failWith } from "./download"

const packageName = "@rikafx/cli"
const LauncherManifest = Schema.fromJsonString(
  Schema.Struct({ name: Schema.Literal(packageName), version: Schema.String }),
)

export interface PackageInstall {
  readonly manager: "npm" | "bun"
  readonly directory: string
  readonly manifest: string
  readonly global: boolean
}

export const packageInstall = Effect.fn("ReleaseUpdate.packageInstall")(
  function* (executable: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const resolved = yield* fileSystem
      .realPath(executable)
      .pipe(
        Effect.mapError(() =>
          failWith(
            "unmanaged-install",
            `Cannot locate the running Rika at ${executable}. Install a release with install.sh or a package manager.`,
          ),
        ),
      )
    if (!resolved.split(path.sep).includes("node_modules")) return undefined

    // npm nests optional packages; Bun may hoist or isolate them. Find the launcher
    // through its enclosing node_modules directories, not through the caller's cwd.
    let directory = path.dirname(resolved)
    while (path.dirname(directory) !== directory) {
      if (path.basename(directory) === "node_modules") {
        const root = path.dirname(directory)
        const manifest = path.join(directory, "@rikafx", "cli", "package.json")
        if (yield* fileSystem.exists(manifest)) {
          yield* fileSystem.readFileString(manifest).pipe(
            Effect.flatMap(Schema.decodeEffect(LauncherManifest)),
            Effect.mapError(() => failWith("unmanaged-install", `Invalid Rika package at ${manifest}.`)),
          )
          const bun =
            (yield* fileSystem.exists(path.join(root, "bun.lock"))) ||
            (yield* fileSystem.exists(path.join(root, "bun.lockb")))
          if (!bun && path.basename(root) === "lib")
            return { manager: "npm", directory: path.dirname(root), manifest, global: true } satisfies PackageInstall
          // Without this boundary a package manager can walk up into another project.
          if (!(yield* fileSystem.exists(path.join(root, "package.json"))))
            return yield* failWith(
              "unmanaged-install",
              `Missing package.json in ${root}; refusing to update a parent project.`,
            )
          if (bun) return { manager: "bun", directory: root, manifest, global: false } satisfies PackageInstall
          if (yield* fileSystem.exists(path.join(root, "package-lock.json")))
            return { manager: "npm", directory: root, manifest, global: false } satisfies PackageInstall
          return yield* failWith(
            "unmanaged-install",
            `Cannot identify the package manager for ${root}. Reinstall ${packageName} with npm or Bun.`,
          )
        }
      }
      directory = path.dirname(directory)
    }
    return yield* failWith(
      "unmanaged-install",
      `No ${packageName} launcher owns ${resolved}. Reinstall Rika with npm or Bun.`,
    )
  },
  Effect.catchTag("PlatformError", () =>
    Effect.fail(
      failWith("install-failed", "Cannot inspect Rika's package installation. Check directory permissions and retry."),
    ),
  ),
)

export const updatePackage = Effect.fn("ReleaseUpdate.updatePackage")(function* (install: PackageInstall) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Updating Bun's actual package directory also preserves an existing global
  // command link, without guessing globalDir/globalBinDir from today's config.
  const args =
    install.manager === "bun"
      ? ["add", "--cwd", install.directory, `${packageName}@latest`]
      : ["install", ...(install.global ? ["--global"] : []), "--prefix", install.directory, `${packageName}@latest`]
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(install.manager, args, {
        cwd: install.directory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.mapError(() =>
        failWith(
          "install-failed",
          `Could not start ${install.manager}. Make sure it is on PATH; the Rika install is at ${install.directory}.`,
        ),
      ),
    )
  if (Number(exitCode) !== 0)
    return yield* failWith(
      "install-failed",
      `${install.manager} could not update Rika in ${install.directory} (exit ${exitCode}). Check its output above and retry rika update.`,
    )
  const manifest = yield* fileSystem.readFileString(install.manifest).pipe(
    Effect.flatMap(Schema.decodeEffect(LauncherManifest)),
    Effect.mapError(() =>
      failWith("install-failed", `${install.manager} finished, but the installed Rika package could not be verified.`),
    ),
  )
  return manifest.version
})
