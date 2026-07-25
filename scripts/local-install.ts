import { Config, Console, Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { validatePackageArchive } from "./archive-contract"
import { binDirEnv, binDirSegments, commandName, installRootEnv, installRootSegments } from "./install-contract"

export class LocalInstallError extends Data.TaggedError("LocalInstallError")<{
  readonly operation: string
  readonly message: string
}> {}

const installFailure = (operation: string, message: string) => new LocalInstallError({ operation, message })

const mapInstallError = (operation: string) =>
  Effect.mapError((error: { readonly message: string }) => installFailure(operation, error.message))

const PackageManifestJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

export const installPaths = Effect.fn("LocalInstall.installPaths")(() =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = yield* Config.string("HOME")
    const configuredInstallRoot = yield* Config.option(Config.string(installRootEnv))
    const configuredBinDir = yield* Config.option(Config.string(binDirEnv))
    const installRoot = path.resolve(
      Option.getOrElse(configuredInstallRoot, () => path.join(home, ...installRootSegments)),
    )
    const binDir = path.resolve(Option.getOrElse(configuredBinDir, () => path.join(home, ...binDirSegments)))
    return {
      installRoot,
      command: path.join(binDir, commandName),
      binary: path.join(installRoot, "bin", commandName),
    }
  }),
)

const ownsCommand = Effect.fn("LocalInstall.ownsCommand")((command: string, binary: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = yield* Effect.option(fileSystem.readLink(command))
    return Option.isSome(target) && path.resolve(path.dirname(command), target.value) === binary
  }),
)

const isLegacyRikaCommand = Effect.fn("LocalInstall.isLegacyRikaCommand")((command: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    if (!(yield* fileSystem.exists(command).pipe(mapInstallError("check legacy command")))) return false
    if (Option.isSome(yield* Effect.option(fileSystem.readLink(command)))) return false
    const entry = yield* fileSystem.stat(command).pipe(mapInstallError("inspect legacy command"))
    if (entry.type !== "File") return false
    const contents = yield* fileSystem.readFileString(command).pipe(mapInstallError("read legacy command"))
    return contents.includes('SHARE_DIR="$SCRIPT_DIR/../share/rika"') && contents.includes('exec "$SCRIPT_DIR/rika-')
  }),
)

const normalizeOperatingSystem = (value: string) => {
  switch (value.trim().toLowerCase()) {
    case "darwin":
      return "darwin"
    case "linux":
      return "linux"
    case "windows_nt":
      return "win32"
    default:
      return value.trim().toLowerCase()
  }
}

const normalizeArchitecture = (value: string) => {
  switch (value.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
      return "x64"
    case "aarch64":
    case "arm64":
      return "arm64"
    default:
      return value.trim().toLowerCase()
  }
}

const hostPackageTarget = Effect.fn("LocalInstall.hostPackageTarget")(() =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [operatingSystem, architecture] = yield* Effect.all(
      [spawner.string(ChildProcess.make("uname", ["-s"])), spawner.string(ChildProcess.make("uname", ["-m"]))],
      { concurrency: 2 },
    ).pipe(mapInstallError("detect host package target"))
    return `${normalizeOperatingSystem(operatingSystem)}-${normalizeArchitecture(architecture)}`
  }),
)

export const packageTarget = Effect.fn("LocalInstall.packageTarget")(() =>
  Config.option(Config.string("RIKA_PACKAGE_TARGET")).pipe(
    Effect.flatMap(Option.match({ onNone: hostPackageTarget, onSome: Effect.succeed })),
    Effect.mapError((error) =>
      error instanceof LocalInstallError ? error : installFailure("read package target", error.message),
    ),
  ),
)

export const installLocal = Effect.fn("LocalInstall.installLocal")(() =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const { installRoot, command, binary } = yield* installPaths()
      const commandExists = yield* fileSystem.exists(command).pipe(mapInstallError("check command"))
      if (commandExists && !(yield* ownsCommand(command, binary)) && !(yield* isLegacyRikaCommand(command))) {
        return yield* installFailure("validate command", `Refusing to overwrite existing command: ${command}`)
      }
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(mapInstallError("resolve project root"))
      const platform = yield* packageTarget()
      const manifest = yield* fileSystem
        .readFileString(path.join(root, "apps", "rika", "package.json"))
        .pipe(mapInstallError("read package version"))
      const parsed = yield* Schema.decodeUnknownEffect(PackageManifestJson)(manifest).pipe(
        mapInstallError("read package version"),
      )
      const archive = path.join(root, "artifacts", `rika-${parsed.version}-${platform}.tar.gz`)
      if (!(yield* fileSystem.exists(archive).pipe(mapInstallError("check host archive")))) {
        return yield* installFailure(
          "check host archive",
          `Host archive not found: ${archive}. Run bun run package first.`,
        )
      }
      const parent = path.dirname(installRoot)
      yield* fileSystem.makeDirectory(parent, { recursive: true }).pipe(mapInstallError("create install parent"))
      const staging = yield* fileSystem
        .makeTempDirectoryScoped({ directory: parent, prefix: ".rika-install-" })
        .pipe(mapInstallError("create staging directory"))
      const archiveRoot = `rika-${parsed.version}-${platform}`
      const [inventory, headers] = yield* Effect.all(
        [
          spawner.string(ChildProcess.make("tar", ["-tzf", archive])),
          spawner.string(ChildProcess.make("tar", ["-tvzf", archive])),
        ],
        { concurrency: 2 },
      ).pipe(mapInstallError("inspect host archive"))
      yield* Effect.try({
        try: () => validatePackageArchive(archiveRoot, inventory, headers),
        catch: (cause) => installFailure("validate package payload", String(cause)),
      })
      const exitCode = yield* spawner
        .exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", staging]))
        .pipe(mapInstallError("extract host archive"))
      if (Number(exitCode) !== 0) {
        return yield* installFailure("extract host archive", `tar exited with code ${exitCode}`)
      }
      const payload = path.join(staging, archiveRoot)
      yield* fileSystem
        .makeDirectory(path.dirname(command), { recursive: true })
        .pipe(mapInstallError("create bin directory"))
      const commandStaging = yield* fileSystem
        .makeTempDirectoryScoped({ directory: path.dirname(command), prefix: ".rika-link-" })
        .pipe(mapInstallError("create command staging directory"))
      const stagedCommand = path.join(commandStaging, "rika")
      yield* fileSystem.symlink(binary, stagedCommand).pipe(mapInstallError("stage command"))
      const priorInstall = path.join(staging, ".prior-install")
      const installExists = yield* fileSystem.exists(installRoot).pipe(mapInstallError("check prior install"))
      if (installExists)
        yield* fileSystem.rename(installRoot, priorInstall).pipe(mapInstallError("stage prior install"))
      yield* fileSystem.rename(payload, installRoot).pipe(
        mapInstallError("publish install"),
        Effect.tapError(() =>
          installExists
            ? fileSystem.rename(priorInstall, installRoot).pipe(mapInstallError("restore prior install"))
            : Effect.void,
        ),
      )
      yield* fileSystem.rename(stagedCommand, command).pipe(
        mapInstallError("link command"),
        Effect.tapError(() =>
          fileSystem
            .remove(installRoot, { recursive: true, force: true })
            .pipe(
              Effect.andThen(
                installExists
                  ? fileSystem.rename(priorInstall, installRoot).pipe(mapInstallError("restore prior install"))
                  : Effect.void,
              ),
            ),
        ),
      )
      yield* Console.log(`Installed rika at ${binary}\nLinked ${command}`)
    }),
  ),
)

export const uninstallLocal = Effect.fn("LocalInstall.uninstallLocal")(() =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const { installRoot, command, binary } = yield* installPaths()
    if (yield* ownsCommand(command, binary)) {
      yield* fileSystem.remove(command).pipe(mapInstallError("remove command"))
    }
    yield* fileSystem.remove(installRoot, { recursive: true, force: true }).pipe(mapInstallError("remove install"))
    yield* Console.log(`Uninstalled rika from ${installRoot}`)
  }),
)
