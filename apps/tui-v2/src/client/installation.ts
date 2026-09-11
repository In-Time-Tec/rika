import { createHash } from "node:crypto"
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { DeviceId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint, RunnerProfile, runnerProtocolVersion } from "@rika/product/runner-registration"

const InstallationDisk = Schema.Struct({
  formatVersion: Schema.Literal(1),
  checkouts: Schema.Record(
    Schema.String,
    Schema.Struct({
      workspaceIdentity: WorkspaceId,
    }),
  ),
})

export type GitOutput = (workspace: string, arguments_: ReadonlyArray<string>) => Effect.Effect<string | undefined>

export interface InstallationRequest {
  readonly deviceId: string
  readonly workspace: string
  readonly projectId?: string
}

export interface PreparedInstallation {
  readonly deviceId: string
  readonly workspacePath: string
  readonly checkoutFingerprint: string
  readonly workspaceIdentity: string
  readonly profile: typeof RunnerProfile.Encoded
}

export class InstallationError extends Schema.TaggedError<InstallationError>()("RikaTuiV2InstallationError", {
  kind: Schema.Literals(["workspace", "storage", "profile"]),
  message: Schema.String,
}) {}

export interface InstallationService {
  readonly prepare: (request: InstallationRequest) => Effect.Effect<PreparedInstallation, InstallationError>
}

export class Installation extends Context.Service<Installation, InstallationService>()(
  "@rika/tui-v2/client/installation",
) {}

export interface InstallationLayerOptions {
  readonly home: string
  readonly filename?: string
  readonly runtimeVersion?: string
  readonly gitOutput?: GitOutput
}

const failure = (kind: InstallationError["kind"], message: string) => InstallationError.make({ kind, message })
const digest = (parts: ReadonlyArray<string>) => createHash("sha256").update(parts.join("\0")).digest("base64url")

const safeRemote = (value: string | undefined) => {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return value.replace(/^[^@\s]+@([^:]+):/, "ssh://$1/")
  }
}

export const liveGitOutput =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): GitOutput =>
  (workspace, arguments_) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(ChildProcess.make("git", ["-C", workspace, ...arguments_], { stdout: "pipe", stderr: "ignore" }))
          .pipe(Effect.option)
        if (child._tag === "None") return undefined
        const result = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(child.value.stdout)), child.value.exitCode],
          {
            concurrency: 2,
          },
        ).pipe(Effect.option)
        if (result._tag === "None") return undefined
        const [output, exitCode] = result.value
        if (Number(exitCode) !== 0) return undefined
        const trimmed = output.trim()
        return trimmed.length === 0 ? undefined : trimmed
      }),
    )

let writeSequence = 0

const writePrivateFile = Effect.fn("TuiV2.Installation.writePrivateFile")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  content: string,
) {
  const parent = path.dirname(target)
  writeSequence += 1
  const temporary = `${target}.tmp-${process.pid}-${writeSequence}`
  yield* fileSystem
    .makeDirectory(parent, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(temporary, content, { flag: "wx", mode: 0o600 })),
      Effect.andThen(fileSystem.chmod(temporary, 0o600)),
      Effect.andThen(fileSystem.rename(temporary, target)),
      Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
    )
})

export const layer = (
  options: InstallationLayerOptions,
): Layer.Layer<Installation, never, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    Installation,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const gitOutput = options.gitOutput ?? liveGitOutput(spawner)
      const filename = options.filename ?? path.join(options.home, ".config", "rika", "installation-v2.json")
      const emptyState: typeof InstallationDisk.Type = { formatVersion: 1, checkouts: {} }
      const load = Effect.gen(function* () {
        const exists = yield* fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => failure("storage", "Installation state could not be inspected")))
        if (!exists) return emptyState
        const linked = yield* Effect.result(fileSystem.readLink(filename))
        if (linked._tag === "Success") return yield* failure("storage", "Installation state cannot be a symbolic link")
        return yield* fileSystem.readFileString(filename).pipe(
          Effect.mapError(() => failure("storage", "Installation state could not be read")),
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InstallationDisk))),
          Effect.mapError(() => failure("storage", "Installation state is corrupt")),
        )
      })
      const save = (state: typeof InstallationDisk.Type) =>
        Schema.encodeEffect(Schema.fromJsonString(InstallationDisk))(state).pipe(
          Effect.mapError(() => failure("storage", "Installation state could not be encoded")),
          Effect.flatMap((content) =>
            writePrivateFile(fileSystem, path, filename, content).pipe(
              Effect.mapError(() => failure("storage", "Installation state could not be saved")),
            ),
          ),
        )
      const prepare = Effect.fn("TuiV2.Installation.prepare")(function* (request: InstallationRequest) {
        const deviceId = yield* Schema.decodeEffect(DeviceId)(request.deviceId).pipe(
          Effect.mapError(() => failure("profile", "The authenticated device identity is invalid")),
        )
        const workspacePath = yield* fileSystem
          .realPath(request.workspace)
          .pipe(Effect.mapError(() => failure("workspace", "Could not inspect the local checkout")))
        const root = (yield* gitOutput(workspacePath, ["rev-parse", "--show-toplevel"])) ?? workspacePath
        const checkoutPath = yield* fileSystem
          .realPath(root)
          .pipe(Effect.mapError(() => failure("workspace", "Could not inspect the local checkout")))
        const [commonDirectoryValue, remoteUrlValue, headRevision, branch] = yield* Effect.all(
          [
            gitOutput(checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            gitOutput(checkoutPath, ["remote", "get-url", "origin"]),
            gitOutput(checkoutPath, ["rev-parse", "HEAD"]),
            gitOutput(checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          ],
          { concurrency: 4 },
        )
        const commonDirectory = commonDirectoryValue ?? checkoutPath
        const repositoryPath = yield* fileSystem
          .realPath(commonDirectory)
          .pipe(Effect.orElseSucceed(() => commonDirectory))
        const remoteUrl = safeRemote(remoteUrlValue)
        const repositoryIdentity = digest([remoteUrl ?? repositoryPath])
        const checkoutFingerprintValue = digest([deviceId, checkoutPath, repositoryIdentity])
        const checkoutFingerprint = yield* Schema.decodeEffect(CheckoutFingerprint)(checkoutFingerprintValue).pipe(
          Effect.mapError(() => failure("profile", "The checkout fingerprint is invalid")),
        )
        const state = yield* load
        const retained = state.checkouts[checkoutFingerprint]
        const workspaceIdentityValue =
          retained?.workspaceIdentity ?? `runner:${digest([deviceId, checkoutFingerprint])}`
        const workspaceIdentity = yield* Schema.decodeEffect(WorkspaceId)(workspaceIdentityValue).pipe(
          Effect.mapError(() => failure("profile", "The workspace identity is invalid")),
        )
        if (retained === undefined)
          yield* save({
            formatVersion: 1,
            checkouts: { ...state.checkouts, [checkoutFingerprint]: { workspaceIdentity } },
          })
        const repository: (typeof RunnerProfile.Encoded)["repository"] = { identity: repositoryIdentity }
        if (remoteUrl !== undefined) Object.assign(repository, { remoteUrl })
        if (headRevision !== undefined) Object.assign(repository, { headRevision })
        if (branch !== undefined) Object.assign(repository, { branch })
        const profileInput: typeof RunnerProfile.Encoded = {
          protocolVersion: runnerProtocolVersion,
          workspaceIdentity,
          repository,
          nativeToolRuntime: {
            runtime: "bun",
            runtimeVersion: options.runtimeVersion ?? process.versions.bun ?? "unknown",
            trustMode: "trusted-local",
          },
          capabilities: { nativeTools: true, checkpoints: false, pty: false },
        }
        if (request.projectId !== undefined) Object.assign(profileInput, { projectId: request.projectId })
        const profile = yield* Schema.decodeEffect(RunnerProfile)(profileInput).pipe(
          Effect.flatMap(Schema.encodeEffect(RunnerProfile)),
          Effect.mapError(() => failure("profile", "The Runner profile is invalid")),
        )
        return {
          deviceId,
          workspacePath: checkoutPath,
          checkoutFingerprint,
          workspaceIdentity,
          profile,
        }
      })
      return Installation.of({ prepare })
    }),
  )
