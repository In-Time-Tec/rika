import { Config, Effect, FileSystem, Option, Path, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { failWith } from "./download"

export const releaseRepository = "In-Time-Tec/rika"
export const installRootEnv = "RIKA_INSTALL_ROOT"

export interface InstallLayout {
  readonly installRoot: string
  readonly binary: string
}

const platformFailure = (operation: string) => (error: PlatformError.PlatformError) => {
  const tag = error.reason._tag
  if (tag === "PermissionDenied")
    return failWith(
      "permission-denied",
      `Cannot ${operation}: permission denied. Re-run with write access to the install directory.`,
    )
  if (tag === "Busy")
    return failWith(
      "install-in-use",
      `Cannot ${operation}: the installed files are in use. Stop running Rika and retry.`,
    )
  return failWith("install-failed", `Cannot ${operation}: ${error.message}`)
}

export const installLayout = Effect.fn("ReleaseInstall.layout")(function* (executable: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configuredRoot = yield* Config.option(Config.string(installRootEnv)).pipe(
    Effect.mapError((error) => failWith("install-failed", `Cannot read ${installRootEnv}: ${error.message}`)),
  )
  const realExecutable = yield* fileSystem
    .realPath(executable)
    .pipe(Effect.mapError(platformFailure("locate the running Rika")))
  const binDirectory = path.dirname(realExecutable)
  const derivedRoot = path.dirname(binDirectory)
  const installRoot = Option.isSome(configuredRoot) ? path.resolve(configuredRoot.value) : derivedRoot
  if (Option.isNone(configuredRoot) && path.basename(binDirectory) !== "bin")
    return yield* failWith(
      "unmanaged-install",
      `This Rika is running from ${executable}, which is not a released install. Install a release with: curl -fsSL https://raw.githubusercontent.com/${releaseRepository}/main/install.sh | sh`,
    )
  if (installRoot.split(path.sep).includes("node_modules"))
    return yield* failWith(
      "unmanaged-install",
      `${installRoot} belongs to a package manager and cannot be replaced with a release archive.`,
    )
  const layout: InstallLayout = {
    installRoot,
    binary: path.join(installRoot, "bin", "rika"),
  }
  const present = yield* fileSystem
    .exists(layout.binary)
    .pipe(Effect.mapError(platformFailure("inspect the current install")))
  if (!present)
    return yield* failWith(
      "unmanaged-install",
      `${installRoot} does not contain the released Rika executable, so it is not a released install. Install a release with: curl -fsSL https://raw.githubusercontent.com/${releaseRepository}/main/install.sh | sh`,
    )
  const realBinary = yield* fileSystem
    .realPath(layout.binary)
    .pipe(Effect.mapError(platformFailure("locate the installed Rika")))
  if (realBinary !== realExecutable)
    return yield* failWith(
      "unmanaged-install",
      `${installRoot} does not own the running Rika; unset ${installRootEnv} and retry.`,
    )
  return layout
})

export const publishInstall = Effect.fn("ReleaseInstall.publish")(function* (options: {
  readonly layout: InstallLayout
  readonly archive: Uint8Array
  readonly archiveFile: string
  readonly archiveRoot: string
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const parent = path.dirname(options.layout.installRoot)
  yield* fileSystem
    .makeDirectory(parent, { recursive: true })
    .pipe(Effect.mapError(platformFailure(`create ${parent}`)))
  const staging = yield* fileSystem
    .makeTempDirectoryScoped({ directory: parent, prefix: ".rika-update-" })
    .pipe(Effect.mapError(platformFailure(`stage the download beside ${options.layout.installRoot}`)))
  const stagedArchive = path.join(staging, options.archiveFile)
  yield* fileSystem
    .writeFile(stagedArchive, options.archive)
    .pipe(Effect.mapError(platformFailure(`write ${stagedArchive}`)))
  const exitCode = yield* spawner
    .exitCode(ChildProcess.make("tar", ["-xzf", stagedArchive, "-C", staging]))
    .pipe(Effect.mapError(platformFailure(`extract ${options.archiveFile}`)))
  if (Number(exitCode) !== 0)
    return yield* failWith("install-failed", `Cannot extract ${options.archiveFile}: tar exited with ${exitCode}.`)
  const payload = path.join(staging, options.archiveRoot)
  const payloadPresent = yield* fileSystem
    .exists(path.join(payload, "bin", "rika"))
    .pipe(Effect.mapError(platformFailure(`inspect ${options.archiveFile}`)))
  if (!payloadPresent)
    return yield* failWith(
      "install-failed",
      `${options.archiveFile} does not contain the released Rika executable; the install was left unchanged.`,
    )
  const previous = path.join(parent, `${path.basename(options.layout.installRoot)}.previous-${process.pid}`)
  const installExists = yield* fileSystem
    .exists(options.layout.installRoot)
    .pipe(Effect.mapError(platformFailure(`inspect ${options.layout.installRoot}`)))
  if (installExists)
    yield* fileSystem
      .rename(options.layout.installRoot, previous)
      .pipe(Effect.mapError(platformFailure("move the current install aside")))
  yield* fileSystem.rename(payload, options.layout.installRoot).pipe(
    Effect.mapError(platformFailure(`publish the new install to ${options.layout.installRoot}`)),
    Effect.tapError(() =>
      installExists ? fileSystem.rename(previous, options.layout.installRoot).pipe(Effect.ignore) : Effect.void,
    ),
  )
  yield* fileSystem.remove(previous, { recursive: true, force: true }).pipe(Effect.ignore)
})
