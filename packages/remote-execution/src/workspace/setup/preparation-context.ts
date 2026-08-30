import { Clock, Config, Crypto, Effect, Encoding, FileSystem, Option, Redacted, Schema } from "effect"
import type { RepositoryCheckoutWire, WorkspacePreparationPhase } from "../../protocol/messages"
import { EphemeralCredentialRoot, RemoteRepositoryRoot } from "../branch-publication"
import { WorkspaceCommand } from "../command-adapter"
import { CredentialBroker, ghExecutable, type Credential } from "../credential-broker"
import { WorkspaceError } from "../error"
import { MarkerCodec, type Marker, type Options } from "./preparation-contracts"

const commandAdapter = WorkspaceCommand.run
const credentialBrokerAdapter = CredentialBroker.listen
const credentialClientSource = CredentialBroker.clientSource
const readOnlyGhWrapper = CredentialBroker.readOnlyGhWrapper

export const preparationContext = (options: Options) =>
  Effect.gen(function* () {
    const executablePath = yield* Config.string("PATH").pipe(Config.withDefault("/usr/local/bin:/usr/bin:/bin"))
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const root = options.root ?? RemoteRepositoryRoot
    const assignment = options.assignment
    const workspaceCommandPrefix = options.workspaceCommandPrefix ?? ["sudo", "-n", "-u", "rika-workspace", "--"]
    const credentialRoot = options.credentialRoot ?? EphemeralCredentialRoot
    const workspaceParent = root.slice(0, root.lastIndexOf("/"))
    const workspaceEnvironment = {
      ...options.environment,
      PATH: `${credentialRoot}/bin:${executablePath}`,
      GH_CONFIG_DIR: `${credentialRoot}/gh`,
    }
    const workspaceEnvironmentArguments = Object.entries(workspaceEnvironment).map(([key, value]) => `${key}=${value}`)
    const markerDirectory = `${options.stateDirectory}/workspace`
    const assignmentDigest = Encoding.encodeHex(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(assignment.access.fence.assignmentId))
        .pipe(Effect.orDie),
    )
    const markerPath = `${markerDirectory}/assignment-${assignmentDigest}-g${assignment.access.fence.assignmentGeneration}.json`
    const setupLog = `${markerDirectory}/setup.log`
    const credentialSocket = `${credentialRoot}/credential.sock`
    const credentialClient = `${credentialRoot}/credential-client.js`
    const credentialHelper = `${credentialRoot}/git-credential-rika`
    const secrets = new Set<string>()
    const activeCredentials = new Map<"git-read" | "github-read", Credential>()
    let credentialBroker: ReturnType<typeof credentialBrokerAdapter> | undefined
    let outputCount = 0
    const digestBytes = Effect.fn("Workspace.digestBytes")(function* (bytes: Uint8Array) {
      return `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie))}`
    })
    const digest = (value: string) => digestBytes(new TextEncoder().encode(value))
    const buildDigest = yield* digest(assignment.templateBuildId)
    const manifest = yield* Config.string("RIKA_IMAGE_MANIFEST").pipe(
      Config.withDefault("/opt/rika/tool-manifest.json"),
    )
    const environmentDigest = yield* fileSystem.exists(manifest).pipe(
      Effect.flatMap((exists) =>
        exists ? fileSystem.readFile(manifest).pipe(Effect.flatMap(digestBytes)) : digest("missing"),
      ),
      Effect.mapError(() =>
        WorkspaceError.make({
          phase: "capabilities",
          message: "Could not identify the executor environment",
          retryable: false,
        }),
      ),
    )
    const authorizedEnvironmentDigest = options.environmentDigest ?? environmentDigest
    const redact = (value: string) => {
      let text = value
        .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["']?[^\s"']+/gi, "$1=REDACTED")
        .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
      for (const secret of secrets) if (secret.length > 0) text = text.replaceAll(secret, "REDACTED")
      return text
    }
    const report = (phase: WorkspacePreparationPhase) => (stream: "stdout" | "stderr", value: string) =>
      Effect.gen(function* () {
        if (outputCount >= 64) return
        outputCount += 1
        const redacted = redact(value)
        const text = redacted.slice(0, 16_384)
        yield* options.reporter.output(phase, stream, text, redacted.length > text.length)
      })
    const run = (phase: WorkspacePreparationPhase, command: ReadonlyArray<string>, timeout: number, cwd = root) =>
      commandAdapter(command, cwd, workspaceEnvironment, report(phase)).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(WorkspaceError.make({ phase, message: `${phase} command timed out`, retryable: true })),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((error) =>
          Schema.is(WorkspaceError)(error)
            ? error
            : WorkspaceError.make({ phase, message: `${phase} command failed`, retryable: true }),
        ),
      )
    const runAsWorkspace = (
      phase: WorkspacePreparationPhase,
      command: ReadonlyArray<string>,
      timeout: number,
      cwd = root,
    ) => run(phase, [...workspaceCommandPrefix, "env", ...workspaceEnvironmentArguments, ...command], timeout, cwd)

    const writeMarker = Effect.fn("Workspace.writeMarker")(function* (marker: Marker) {
      yield* fileSystem.makeDirectory(markerDirectory, { recursive: true, mode: 0o700 })
      const temporary = `${markerPath}.tmp-${process.pid}`
      yield* fileSystem.writeFileString(temporary, MarkerCodec.encode(marker), { mode: 0o600 })
      yield* fileSystem.rename(temporary, markerPath)
    })
    const readMarker = Effect.fn("Workspace.readMarker")(function* () {
      if (!(yield* fileSystem.exists(markerPath))) return undefined
      return yield* fileSystem.readFileString(markerPath).pipe(
        Effect.flatMap(MarkerCodec.decode),
        Effect.mapError(() =>
          WorkspaceError.make({
            phase: "checkout",
            message: "Workspace preparation marker is invalid",
            retryable: false,
          }),
        ),
      )
    })

    const startCredentialBroker = Effect.fn("Workspace.startCredentialBroker")(function* () {
      if (credentialBroker !== undefined) return
      yield* fileSystem.makeDirectory(credentialRoot, { recursive: true, mode: 0o2750 })
      yield* fileSystem.makeDirectory(`${credentialRoot}/bin`, { recursive: true, mode: 0o2750 })
      yield* fileSystem.makeDirectory(`${credentialRoot}/gh`, { recursive: true, mode: 0o2750 })
      yield* fileSystem.remove(credentialSocket, { force: true })
      credentialBroker = yield* Effect.try({
        try: () =>
          credentialBrokerAdapter(credentialSocket, (purpose) =>
            purpose === "branch-push" ? undefined : activeCredentials.get(purpose),
          ),
        catch: () =>
          WorkspaceError.make({ phase: "checkout", message: "Credential broker failed to start", retryable: true }),
      })
      yield* fileSystem.chmod(credentialSocket, 0o660)
      yield* fileSystem.writeFileString(credentialClient, credentialClientSource(credentialSocket), { mode: 0o750 })
      yield* fileSystem.writeFileString(
        credentialHelper,
        `#!/bin/sh\nset -eu\ncase "\${1:-}" in get) exec ${credentialClient} git-read ;; *) exit 0 ;; esac\n`,
        { mode: 0o750 },
      )
      yield* fileSystem.writeFileString(`${credentialRoot}/bin/gh`, readOnlyGhWrapper(ghExecutable, credentialClient), {
        mode: 0o750,
      })
    })

    const installCredential = Effect.fn("Workspace.installCredential")(function* (
      purpose: "git-read" | "github-read",
      credential: Credential,
    ) {
      const token = Redacted.value(credential.token)
      secrets.add(token)
      activeCredentials.set(purpose, credential)
      yield* startCredentialBroker()
    })

    const clearCredential = Effect.fn("Workspace.clearCredential")(function* () {
      activeCredentials.clear()
      if (credentialBroker !== undefined) {
        credentialBroker.stop(true)
        credentialBroker = undefined
      }
      yield* fileSystem.remove(credentialSocket, { force: true })
      yield* fileSystem.remove(credentialClient, { force: true })
      yield* fileSystem.remove(credentialHelper, { force: true })
      yield* fileSystem.remove(`${credentialRoot}/bin/gh`, { force: true })
      yield* fileSystem.remove(`${credentialRoot}/bin`, { recursive: true, force: true })
      yield* fileSystem.remove(`${credentialRoot}/gh`, { recursive: true, force: true })
    })
    yield* clearCredential()
    yield* Effect.addFinalizer(() =>
      Effect.all([options.revoke("git-read").pipe(Effect.ignore), options.revoke("github-read").pipe(Effect.ignore)], {
        discard: true,
      }).pipe(Effect.andThen(clearCredential), Effect.ignore),
    )

    const acquireCredential = Effect.fn("Workspace.acquireCredential")(function* (purpose: "git-read" | "github-read") {
      const credential = yield* options.credential(purpose)
      const now = yield* Clock.currentTimeMillis
      if (credential.expiresAt <= now || credential.expiresAt > now + 60 * 60 * 1_000)
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Repository credential lifetime is invalid",
          retryable: true,
        })
      const checkout = assignment.checkout
      if (checkout === null || credential.repositoryUrl !== `https://github.com/${checkout.owner}/${checkout.name}.git`)
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Repository credential does not match the assigned checkout",
          retryable: false,
        })
      yield* installCredential(purpose, credential)
      return credential
    })

    function refresh(
      purpose: "git-read" | "github-read",
      credential: Credential,
    ): Effect.Effect<void, WorkspaceError, import("effect").Scope.Scope> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sleep(Math.max(1_000, credential.expiresAt - now - 5 * 60 * 1_000))
        const next = yield* acquireCredential(purpose)
        return yield* refresh(purpose, next)
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(WorkspaceError)(error)
            ? error
            : WorkspaceError.make({ phase: "checkout", message: "Credential refresh failed", retryable: true }),
        ),
      )
    }
    const startRefresh = Effect.fn("Workspace.startRefresh")(function* (
      purpose: "git-read" | "github-read",
      credential: Credential,
    ) {
      yield* Effect.forkScoped(
        refresh(purpose, credential).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              activeCredentials.delete(purpose)
            }).pipe(Effect.andThen(options.revoke(purpose)), Effect.ignore),
          ),
        ),
      )
    })

    const configureRepository = Effect.fn("Workspace.configureRepository")(function* (
      checkout: RepositoryCheckoutWire,
      repositoryRoot: string = root,
    ) {
      const commands = [
        [
          "git",
          "-C",
          repositoryRoot,
          "remote",
          "set-url",
          "origin",
          `https://github.com/${checkout.owner}/${checkout.name}.git`,
        ],
        [
          "git",
          "-C",
          repositoryRoot,
          "config",
          "--local",
          "credential.helper",
          `${credentialRoot}/git-credential-rika`,
        ],
        ["git", "-C", repositoryRoot, "config", "--local", "credential.useHttpPath", "true"],
        ["git", "-C", repositoryRoot, "config", "--local", "user.name", checkout.gitIdentity.name],
        ["git", "-C", repositoryRoot, "config", "--local", "user.email", checkout.gitIdentity.email],
      ]
      for (const command of commands) {
        const result = yield* runAsWorkspace("checkout", command, 30_000, repositoryRoot)
        if (result.code !== 0)
          return yield* WorkspaceError.make({
            phase: "checkout",
            message: "Could not apply repository-local Git configuration",
            retryable: true,
          })
      }
    })

    const markerMatches = (marker: Marker) => {
      const checkout = assignment.checkout
      return (
        marker.assignmentId !== assignment.access.fence.assignmentId ||
        marker.assignmentGeneration !== assignment.access.fence.assignmentGeneration ||
        marker.workspaceId !== assignment.workspaceId ||
        marker.templateBuildId !== assignment.templateBuildId ||
        marker.kernelProfileDigest !== options.kernel.profileDigest ||
        marker.bindingContractDigest !== options.kernel.bindingContractDigest ||
        marker.repositoryId !== (checkout?.repositoryId ?? null) ||
        marker.commitSha !== (checkout?.commitSha ?? null) ||
        marker.setup.buildDigest !== buildDigest ||
        marker.setup.environmentDigest !== environmentDigest
      )
    }
    const verify = Effect.fn("Workspace.verify")(function* (marker: Marker) {
      const checkout = assignment.checkout
      if (markerMatches(marker))
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Cold workspace identity does not match its persisted assignment",
          retryable: false,
        })
      if (checkout === null) return
      const results = yield* Effect.all([
        runAsWorkspace(
          "checkout",
          ["git", "-C", root, "merge-base", "--is-ancestor", checkout.commitSha, "HEAD"],
          30_000,
        ),
        runAsWorkspace("checkout", ["git", "-C", root, "remote", "get-url", "origin"], 30_000),
      ])
      if (
        results[0].code !== 0 ||
        results[1].code !== 0 ||
        results[1].output.trim() !== `https://github.com/${checkout.owner}/${checkout.name}.git`
      )
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Cold workspace checkout does not match the persisted repository commit",
          retryable: false,
        })
      yield* configureRepository(checkout)
    })

    return {
      options,
      command: commandAdapter,
      fileSystem,
      root,
      assignment,
      workspaceCommandPrefix,
      credentialRoot,
      workspaceParent,
      workspaceEnvironment,
      workspaceEnvironmentArguments,
      markerDirectory,
      assignmentDigest,
      setupLog,
      secrets,
      digestBytes,
      buildDigest,
      environmentDigest,
      authorizedEnvironmentDigest,
      report,
      run,
      runAsWorkspace,
      writeMarker,
      readMarker,
      acquireCredential,
      startRefresh,
      configureRepository,
      verify,
      clearCredential,
      redact,
    }
  })

export type PreparationContext = Effect.Success<ReturnType<typeof preparationContext>>
