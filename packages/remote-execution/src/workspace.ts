import { Clock, Crypto, Effect, Encoding, Exit, Fiber, FileSystem, Option, Redacted, Schema } from "effect"
import type {
  AccessWire,
  EncodedArchive,
  BranchPushOutcome,
  BranchPushRequest,
  RepositoryCheckoutWire,
  WorkspacePreparationEvidenceWire,
  WorkspacePreparationPhase,
} from "./protocol"
import {
  createArchive,
  decodeArchive,
  encodeArchive,
  hookDigest as readHookDigest,
  restoreArchive,
  type SetupCacheKey,
} from "./workspace-archive"

export const RemoteRepositoryRoot = "/home/rika-workspace/workspace/repo"
export const EphemeralCredentialRoot = "/run/rika"

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  phase: Schema.Literals(["checkout", "setup", "resume", "capabilities"]),
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export interface Credential {
  readonly token: Redacted.Redacted<string>
  readonly username: "x-access-token"
  readonly repositoryUrl: string
  readonly expiresAt: number
}

export interface Assignment {
  readonly access: AccessWire
  readonly workspaceId: string
  readonly wakeId: string
  readonly cold: boolean
  readonly attempt: number
  readonly retry: boolean
  readonly templateBuildId: string
  readonly checkout: RepositoryCheckoutWire | null
}

export interface KernelIdentity {
  readonly profileDigest: string
  readonly bindingContractDigest: string
}

export interface Reporter {
  readonly started: (phase: WorkspacePreparationPhase) => Effect.Effect<void, WorkspaceError>
  readonly output: (
    phase: WorkspacePreparationPhase,
    stream: "stdout" | "stderr",
    text: string,
    truncated: boolean,
  ) => Effect.Effect<void, WorkspaceError>
}

export interface Options {
  readonly root?: string
  readonly workspaceCommandPrefix?: ReadonlyArray<string>
  readonly credentialRoot?: string
  readonly setupTimeout?: number
  readonly resumeTimeout?: number
  readonly resumeBlockingWindow?: number
  readonly stateDirectory: string
  readonly kernel: KernelIdentity
  readonly assignment: Assignment
  readonly reporter: Reporter
  readonly credential: (purpose: "git-read" | "github-read") => Effect.Effect<Credential, WorkspaceError>
  readonly revoke: (purpose: "git-read" | "github-read") => Effect.Effect<void, WorkspaceError>
  readonly environment?: Readonly<Record<string, string>>
  readonly environmentDigest?: string
  readonly restore?: { readonly checkpointId: string; readonly archive: EncodedArchive }
  readonly setupCache?: {
    readonly ownerId: string
    readonly load: (key: SetupCacheKey) => Effect.Effect<EncodedArchive | null>
    readonly store: (key: SetupCacheKey, archive: EncodedArchive) => Effect.Effect<void>
  }
  readonly secretValues?: ReadonlySet<string>
}

const HookEvidence = Schema.Struct({
  digest: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  buildDigest: Schema.String,
  environmentDigest: Schema.String,
  startedAt: Schema.Int,
  finishedAt: Schema.Int,
  outcome: Schema.Literals(["missing", "completed", "continued"]),
})

const Marker = Schema.Struct({
  version: Schema.Literal(2),
  assignmentId: Schema.String,
  assignmentGeneration: Schema.Int,
  workspaceId: Schema.String,
  templateBuildId: Schema.String,
  kernelProfileDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bindingContractDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  repositoryId: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  setupState: Schema.Literals(["completed", "failed"]),
  setup: HookEvidence,
  resume: Schema.NullOr(HookEvidence),
  lastWakeId: Schema.NullOr(Schema.String),
})
type Marker = typeof Marker.Type

const encodeMarker = Schema.encodeSync(Schema.fromJsonString(Marker))
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(Marker))
const maximumOutputBytes = 64 * 1024
const ghExecutable =
  Bun.which("gh") ?? Bun.which("gh", { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }) ?? "/usr/bin/gh"

const readOnlyGhWrapper = (executable = ghExecutable, credentialClient?: string) =>
  `#!/bin/sh\nset -eu\nauthenticate() {\n${credentialClient === undefined ? "  :\n" : `  token="$(${credentialClient} github-read)"\n  [ -n "$token" ] || exit 1\n  export GH_TOKEN="$token"\n`}}\ncase "\${1:-}:\${2:-}" in\n  --version:|version:) exec ${executable} "$@" ;;\n  auth:status|repo:view|repo:list|issue:view|issue:list|issue:status|pr:view|pr:list|pr:checks|pr:status|pr:diff|search:*) authenticate; exec ${executable} "$@" ;;\n  api:*)\n    shift\n    for value in "$@"; do\n      case "$value" in graphql|-X*|--method*|-f*|-F*|--field*|--raw-field*|--input*|--hostname*) echo 'write-capable gh api arguments are disabled' >&2; exit 2 ;; esac\n    done\n    authenticate\n    exec ${executable} api --method GET "$@" ;;\n  *) echo 'only read-only gh operations are enabled' >&2; exit 2 ;;\nesac\n`

const credentialClientSource = (socketPath: string) =>
  `#!/usr/bin/env bun
const operation = process.argv[2] ?? ""
if (operation !== "git-read" && operation !== "github-read" && operation !== "branch-push") process.exit(2)
let response = ""
const timeout = setTimeout(() => process.exit(1), 5000)
await Bun.connect({
  unix: ${JSON.stringify(socketPath)},
  socket: {
    open(socket) { socket.write(operation) },
    data(_socket, data) { response += new TextDecoder().decode(data) },
    close() { clearTimeout(timeout); process.stdout.write(response) },
    error() { clearTimeout(timeout); process.exit(1) },
  },
})
`

const credentialBrokerAdapter = (
  socketPath: string,
  credential: (purpose: "git-read" | "github-read" | "branch-push") => Credential | undefined,
) =>
  Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        const operation = new TextDecoder().decode(data).trim()
        if (operation !== "git-read" && operation !== "github-read" && operation !== "branch-push") {
          socket.end()
          return
        }
        const current = credential(operation)
        if (current === undefined) {
          socket.end()
          return
        }
        const token = Redacted.value(current.token)
        socket.end(operation === "github-read" ? token : `username=${current.username}\npassword=${token}\n\n`)
      },
    },
  })

const commandAdapter = (
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Record<string, string>,
  output: (stream: "stdout" | "stderr", text: string) => void,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const process = Bun.spawn([...command], {
        cwd,
        env: { ...Bun.env, ...environment },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      let retained = ""
      let truncated = false
      const consume = (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        const read = (): Promise<void> =>
          reader.read().then((next) => {
            if (next.done) return
            const text = decoder.decode(next.value, { stream: true })
            output(name, text)
            if (retained.length < maximumOutputBytes) retained += text.slice(0, maximumOutputBytes - retained.length)
            if (retained.length >= maximumOutputBytes) truncated = true
            return read()
          })
        return read()
      }
      const completed = Promise.all([
        consume(process.stdout, "stdout"),
        consume(process.stderr, "stderr"),
        process.exited,
      ]).then(([, , code]) => ({ code, output: retained, truncated }))
      return { process, completed }
    }),
    ({ process }) => Effect.sync(() => process.kill()).pipe(Effect.ignore),
  ).pipe(
    Effect.flatMap(({ completed }) =>
      Effect.tryPromise({
        try: () => completed,
        catch: () =>
          WorkspaceError.make({ phase: "capabilities", message: "Workspace command failed", retryable: true }),
      }),
    ),
  )

export interface BranchPushOptions {
  readonly request: BranchPushRequest
  readonly repositoryUrl: string
  readonly credential: Credential
  readonly root?: string
  readonly workspaceCommandPrefix?: ReadonlyArray<string>
  readonly credentialRoot?: string
}

export const pushApprovedBranch = Effect.fn("Workspace.pushApprovedBranch")(function* (options: BranchPushOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const root = options.root ?? RemoteRepositoryRoot
  const prefix = options.workspaceCommandPrefix ?? []
  const credentialRoot = options.credentialRoot ?? EphemeralCredentialRoot
  const request = options.request
  const failed = (kind: "stale" | "local" | "git", message: string): BranchPushOutcome => ({
    _tag: "Failed",
    kind,
    message,
  })
  if (
    request.ref !== `refs/heads/${request.branch}` ||
    !/^rika\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(request.branch) ||
    request.branch.includes("..") ||
    request.branch.includes("//") ||
    request.branch.includes("@{") ||
    request.branch.endsWith(".lock")
  )
    return failed("stale", "Approved branch ref is invalid")
  const now = yield* Clock.currentTimeMillis
  if (
    options.credential.repositoryUrl !== options.repositoryUrl ||
    options.credential.expiresAt <= now ||
    options.credential.expiresAt > now + 60 * 60 * 1_000
  )
    return failed("stale", "Branch push credential scope is invalid")
  const run = (command: ReadonlyArray<string>) =>
    commandAdapter(
      [...prefix, ...command],
      root,
      {
        PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_ASKPASS: "/bin/false",
        SSH_ASKPASS: "/bin/false",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      () => {},
    )
  const head = yield* run(["git", "-C", root, "rev-parse", "HEAD"]).pipe(Effect.option)
  const remote = yield* run(["git", "-C", root, "remote", "get-url", "origin"]).pipe(Effect.option)
  const pushRemote = yield* run(["git", "-C", root, "remote", "get-url", "--push", "origin"]).pipe(Effect.option)
  const localAuthority = yield* run([
    "git",
    "-C",
    root,
    "config",
    "--local",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^(http\\.|remote\\.origin\\.(pushurl|receivepack|proxy|mirror)$|url\\.|credential\\.)",
  ]).pipe(Effect.option)
  const localAuthorityKeys = Option.isSome(localAuthority)
    ? localAuthority.value.output
        .trim()
        .split("\n")
        .filter((name) => name.length > 0 && name !== "credential.helper" && name !== "credential.usehttppath")
    : []
  if (
    Option.isNone(head) ||
    Option.isNone(remote) ||
    Option.isNone(pushRemote) ||
    Option.isNone(localAuthority) ||
    head.value.code !== 0 ||
    remote.value.code !== 0 ||
    pushRemote.value.code !== 0 ||
    (localAuthority.value.code !== 0 && localAuthority.value.code !== 1) ||
    head.value.output.trim() !== request.commitSha ||
    remote.value.output.trim() !== options.repositoryUrl ||
    pushRemote.value.output.trim() !== options.repositoryUrl ||
    localAuthorityKeys.length > 0
  )
    return failed("stale", "Workspace HEAD or repository changed after approval")
  const digest = Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(request.publicationId)).pipe(Effect.orDie),
  )
  const directory = `${credentialRoot}/publication-${digest}`
  const socketPath = `${directory}/credential.sock`
  const clientPath = `${directory}/credential-client.js`
  const helperPath = `${directory}/git-credential-rika-push`
  const snapshot = `${directory}/repository.git`
  let available: Credential | undefined = options.credential
  let broker: ReturnType<typeof credentialBrokerAdapter> | undefined
  return yield* Effect.gen(function* () {
    yield* fileSystem.remove(directory, { recursive: true, force: true })
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const initialized = yield* run(["git", "init", "--bare", snapshot])
    if (initialized.code !== 0) return failed("local", "Approved branch snapshot could not start")
    const fetched = yield* run([
      "git",
      `--git-dir=${snapshot}`,
      "-c",
      `safe.directory=${root}`,
      "fetch",
      "--no-tags",
      root,
      "HEAD",
    ])
    if (fetched.code !== 0) return failed("stale", "Workspace HEAD changed while publication was isolated")
    const snapshotHead = yield* run(["git", `--git-dir=${snapshot}`, "rev-parse", "FETCH_HEAD"])
    if (snapshotHead.code !== 0 || snapshotHead.output.trim() !== request.commitSha)
      return failed("stale", "Workspace HEAD changed while publication was isolated")
    for (const command of [
      ["git", `--git-dir=${snapshot}`, "update-ref", "refs/heads/publication", request.commitSha],
      ["git", `--git-dir=${snapshot}`, "symbolic-ref", "HEAD", "refs/heads/publication"],
      ["git", `--git-dir=${snapshot}`, "remote", "add", "origin", options.repositoryUrl],
    ]) {
      const configured = yield* run(command)
      if (configured.code !== 0) return failed("local", "Approved branch snapshot could not be sealed")
    }
    broker = yield* Effect.try({
      try: () =>
        credentialBrokerAdapter(socketPath, (purpose) => {
          if (purpose !== "branch-push") return undefined
          const current = available
          available = undefined
          return current
        }),
      catch: () => undefined,
    })
    if (broker === undefined) return failed("local", "Branch push credential broker could not start")
    yield* fileSystem.chmod(socketPath, 0o600)
    yield* fileSystem.writeFileString(clientPath, credentialClientSource(socketPath), { mode: 0o700 })
    yield* fileSystem.writeFileString(
      helperPath,
      `#!/bin/sh\nset -eu\ncase "\${1:-}" in get) exec ${clientPath} branch-push ;; *) exit 0 ;; esac\n`,
      { mode: 0o700 },
    )
    const pushed = yield* run([
      "git",
      `--git-dir=${snapshot}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helperPath}`,
      "-c",
      "credential.useHttpPath=true",
      "-c",
      "credential.interactive=false",
      "-c",
      "http.extraHeader=",
      "-c",
      "http.cookieFile=",
      "push",
      "--porcelain",
      "origin",
      `HEAD:${request.ref}`,
    ]).pipe(Effect.timeoutOption("45 seconds"), Effect.orElseSucceed(Option.none))
    if (Option.isNone(pushed) || pushed.value.code !== 0) return failed("git", "Git rejected the approved branch push")
    return { _tag: "Succeeded", branch: request.branch, ref: request.ref, commitSha: request.commitSha } as const
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => broker?.stop(true)).pipe(
        Effect.andThen(fileSystem.remove(directory, { recursive: true, force: true })),
        Effect.ignore,
      ),
    ),
    Effect.orElseSucceed(() => failed("local", "Approved branch push could not run")),
  )
})

const make = (options: Options) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const root = options.root ?? RemoteRepositoryRoot
    const assignment = options.assignment
    const workspaceCommandPrefix = options.workspaceCommandPrefix ?? ["sudo", "-n", "-u", "rika-workspace", "--"]
    const credentialRoot = options.credentialRoot ?? EphemeralCredentialRoot
    const workspaceParent = root.slice(0, root.lastIndexOf("/"))
    const workspaceEnvironment = {
      ...options.environment,
      PATH: `${credentialRoot}/bin:${Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
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
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    const digest = Effect.fn("Workspace.digest")(function* (value: string | Uint8Array) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
      return `sha256:${Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie))}`
    })
    const buildDigest = yield* digest(assignment.templateBuildId)
    const manifest = Bun.env.RIKA_IMAGE_MANIFEST ?? "/opt/rika/tool-manifest.json"
    const environmentDigest = yield* fileSystem.exists(manifest).pipe(
      Effect.flatMap((exists) =>
        exists ? fileSystem.readFile(manifest).pipe(Effect.flatMap(digest)) : digest("missing"),
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
    const report = (phase: WorkspacePreparationPhase) => (stream: "stdout" | "stderr", value: string) => {
      if (outputCount >= 64) return
      outputCount += 1
      const redacted = redact(value)
      const text = redacted.slice(0, 16_384)
      runFork(options.reporter.output(phase, stream, text, redacted.length > text.length))
    }
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
      yield* fileSystem.writeFileString(temporary, encodeMarker(marker), { mode: 0o600 })
      yield* fileSystem.rename(temporary, markerPath)
    })
    const readMarker = Effect.fn("Workspace.readMarker")(function* () {
      if (!(yield* fileSystem.exists(markerPath))) return undefined
      return yield* fileSystem.readFileString(markerPath).pipe(
        Effect.flatMap(decodeMarker),
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
      repositoryRoot = root,
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

    const verify = Effect.fn("Workspace.verify")(function* (marker: Marker) {
      const checkout = assignment.checkout
      if (
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

    const hook = Effect.fn("Workspace.hook")(function* (
      name: "setup" | "resume",
      commitSha: string | null,
      timeout: number,
      blockingWindow?: number,
    ) {
      const phase = name
      yield* options.reporter.started(phase)
      const path = `${root}/.agents/${name}`
      const startedAt = yield* Clock.currentTimeMillis
      if (name === "setup") yield* fileSystem.remove(setupLog, { force: true })
      if (!(yield* fileSystem.exists(path)))
        return {
          digest: null,
          commitSha,
          buildDigest,
          environmentDigest,
          startedAt,
          finishedAt: yield* Clock.currentTimeMillis,
          outcome: "missing" as const,
        }
      const info = yield* fileSystem
        .stat(path)
        .pipe(
          Effect.mapError(() =>
            WorkspaceError.make({ phase, message: `Could not inspect .agents/${name}`, retryable: true }),
          ),
        )
      if (info.type !== "File" || (info.mode & 0o111) === 0)
        return yield* WorkspaceError.make({
          phase,
          message: `.agents/${name} must be executable; run chmod +x .agents/${name} and retry explicitly`,
          retryable: true,
        })
      const hookDigest = yield* fileSystem.readFile(path).pipe(
        Effect.flatMap(digest),
        Effect.mapError(() =>
          WorkspaceError.make({ phase, message: `Could not read .agents/${name}`, retryable: true }),
        ),
      )
      const command = commandAdapter(
        [...workspaceCommandPrefix, "env", ...workspaceEnvironmentArguments, path],
        root,
        workspaceEnvironment,
        report(phase),
      ).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(WorkspaceError.make({ phase, message: `.agents/${name} timed out`, retryable: true })),
            onSome: Effect.succeed,
          }),
        ),
      )
      const fiber = yield* Effect.forkScoped(command)
      if (blockingWindow !== undefined) {
        const early = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(blockingWindow))
        if (Option.isNone(early))
          return {
            digest: hookDigest,
            commitSha,
            buildDigest,
            environmentDigest,
            startedAt,
            finishedAt: yield* Clock.currentTimeMillis,
            outcome: "continued" as const,
          }
        const result = yield* Exit.match(early.value, {
          onFailure: Effect.failCause,
          onSuccess: Effect.succeed,
        })
        if (result.code !== 0)
          return yield* WorkspaceError.make({
            phase,
            message: `.agents/${name} exited unsuccessfully`,
            retryable: true,
          })
      } else {
        const result = yield* Fiber.join(fiber)
        if (name === "setup") yield* fileSystem.writeFileString(setupLog, redact(result.output), { mode: 0o600 })
        if (result.code !== 0)
          return yield* WorkspaceError.make({
            phase,
            message: `.agents/${name} exited unsuccessfully`,
            retryable: true,
          })
      }
      return {
        digest: hookDigest,
        commitSha,
        buildDigest,
        environmentDigest,
        startedAt,
        finishedAt: yield* Clock.currentTimeMillis,
        outcome: "completed" as const,
      }
    })

    const capabilities = Effect.fn("Workspace.capabilities")(function* () {
      yield* options.reporter.started("capabilities")
      const required = assignment.checkout === null ? [["bun", "--version"]] : [["git", "--version"]]
      for (const command of required) {
        const result = yield* run("capabilities", command, 30_000)
        if (result.code !== 0)
          return yield* WorkspaceError.make({
            phase: "capabilities",
            message: `${command[0]} is unavailable`,
            retryable: false,
          })
      }
      if (assignment.checkout !== null) {
        const info = yield* fileSystem
          .stat(ghExecutable)
          .pipe(
            Effect.mapError(() =>
              WorkspaceError.make({ phase: "capabilities", message: "gh is unavailable", retryable: false }),
            ),
          )
        if (info.type !== "File" || (info.mode & 0o111) === 0)
          return yield* WorkspaceError.make({
            phase: "capabilities",
            message: "gh is unavailable",
            retryable: false,
          })
      }
      return assignment.checkout === null ? ["bun"] : ["git", "gh"]
    })

    const archiveFailure = (message: string) => WorkspaceError.make({ phase: "checkout", message, retryable: false })

    const restore = Effect.fn("Workspace.restore")(function* (archive: EncodedArchive) {
      const decoded = yield* decodeArchive(archive).pipe(
        Effect.mapError(() => archiveFailure("Workspace archive verification failed")),
      )
      yield* restoreArchive(root, decoded, workspaceCommandPrefix).pipe(
        Effect.mapError(() => archiveFailure("Workspace archive restoration failed")),
      )
    })

    const resetCheckout = Effect.fn("Workspace.resetCheckout")(function* (checkout: RepositoryCheckoutWire) {
      const result = yield* commandAdapter(
        [
          ...workspaceCommandPrefix,
          "bash",
          "-ceu",
          'find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +; git -C "$1" reset --hard "$2"; git -C "$1" clean -ffdx',
          "rika-cache-reset",
          root,
          checkout.commitSha,
        ],
        root,
        workspaceEnvironment,
        report("checkout"),
      )
      if (result.code !== 0)
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Workspace could not recover from an invalid setup cache",
          retryable: true,
        })
    })

    yield* fileSystem.makeDirectory(markerDirectory, { recursive: true, mode: 0o700 })
    const known = yield* readMarker()
    yield* options.reporter.started("checkout")
    let marker: Marker
    if (assignment.cold) {
      if (known === undefined)
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Cold workspace is missing its preparation marker",
          retryable: false,
        })
      yield* verify(known)
      if (known.setupState === "failed" && !assignment.retry)
        return yield* WorkspaceError.make({
          phase: "setup",
          message: "Workspace setup failed previously; retry it explicitly",
          retryable: true,
        })
      marker = known
    } else {
      if (known !== undefined && known.lastWakeId === assignment.wakeId) {
        yield* verify(known)
        if (known.setupState === "failed" && !assignment.retry)
          return yield* WorkspaceError.make({
            phase: "setup",
            message: "Workspace setup failed previously; retry it explicitly",
            retryable: true,
          })
        marker = known
      } else if (
        known !== undefined ||
        (yield* fileSystem.stat(root).pipe(Effect.as(true), Effect.orElseSucceed(() => false)))
      )
        return yield* WorkspaceError.make({
          phase: "checkout",
          message: "Fresh workspace contains stale or partial checkout state",
          retryable: false,
        })
      else {
        yield* fileSystem.makeDirectory(workspaceParent, { recursive: true, mode: 0o750 })
        if (assignment.checkout !== null) {
          const checkout = assignment.checkout
          const checkoutRoot = `${workspaceParent}/.rika-checkout-${assignmentDigest}-g${assignment.access.fence.assignmentGeneration}`
          yield* fileSystem.remove(checkoutRoot, { recursive: true, force: true })
          yield* Effect.gen(function* () {
            if (checkout.private) yield* acquireCredential("git-read")
            const environment = {
              GIT_CONFIG_COUNT: "2",
              GIT_CONFIG_KEY_0: "credential.helper",
              GIT_CONFIG_VALUE_0: `${credentialRoot}/git-credential-rika`,
              GIT_CONFIG_KEY_1: "credential.useHttpPath",
              GIT_CONFIG_VALUE_1: "true",
            }
            const clone = yield* commandAdapter(
              [
                ...workspaceCommandPrefix,
                "env",
                ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                `https://github.com/${checkout.owner}/${checkout.name}.git`,
                checkoutRoot,
              ],
              workspaceParent,
              workspaceEnvironment,
              report("checkout"),
            ).pipe(Effect.timeoutOption("5 minutes"))
            if (Option.isNone(clone) || clone.value.code !== 0)
              return yield* WorkspaceError.make({
                phase: "checkout",
                message: "Repository clone failed",
                retryable: true,
              })
            const checkoutResult = yield* runAsWorkspace(
              "checkout",
              ["git", "-C", checkoutRoot, "checkout", "--detach", checkout.commitSha],
              5 * 60 * 1_000,
              checkoutRoot,
            )
            if (checkoutResult.code !== 0)
              return yield* WorkspaceError.make({
                phase: "checkout",
                message: "Repository commit checkout failed",
                retryable: true,
              })
            yield* configureRepository(checkout, checkoutRoot)
            const verified = yield* Effect.all([
              runAsWorkspace("checkout", ["git", "-C", checkoutRoot, "rev-parse", "HEAD"], 30_000, checkoutRoot),
              runAsWorkspace(
                "checkout",
                ["git", "-C", checkoutRoot, "remote", "get-url", "origin"],
                30_000,
                checkoutRoot,
              ),
            ])
            if (
              verified[0].code !== 0 ||
              verified[0].output.trim() !== checkout.commitSha ||
              verified[1].code !== 0 ||
              verified[1].output.trim() !== `https://github.com/${checkout.owner}/${checkout.name}.git`
            )
              return yield* WorkspaceError.make({
                phase: "checkout",
                message: "Repository checkout verification failed",
                retryable: false,
              })
            if (checkout.private) {
              yield* options.revoke("git-read")
              yield* clearCredential()
            }
            yield* fileSystem.rename(checkoutRoot, root)
          }).pipe(
            Effect.tapError(() =>
              Effect.all(
                [
                  fileSystem.remove(checkoutRoot, { recursive: true, force: true }),
                  options.revoke("git-read").pipe(Effect.ignore),
                  clearCredential().pipe(Effect.ignore),
                ],
                { discard: true },
              ),
            ),
          )
        } else {
          const created = yield* runAsWorkspace(
            "checkout",
            ["install", "-d", "-m", "0750", root],
            30_000,
            workspaceParent,
          )
          if (created.code !== 0)
            return yield* WorkspaceError.make({
              phase: "checkout",
              message: "Workspace directory creation failed",
              retryable: true,
            })
        }
        const setupCommit = assignment.checkout?.commitSha ?? null
        const pendingSetup = {
          digest: null,
          commitSha: setupCommit,
          buildDigest,
          environmentDigest,
          startedAt: yield* Clock.currentTimeMillis,
          finishedAt: yield* Clock.currentTimeMillis,
          outcome: "missing" as const,
        }
        marker = {
          version: 2,
          assignmentId: assignment.access.fence.assignmentId,
          assignmentGeneration: assignment.access.fence.assignmentGeneration,
          workspaceId: assignment.workspaceId,
          templateBuildId: assignment.templateBuildId,
          kernelProfileDigest: options.kernel.profileDigest,
          bindingContractDigest: options.kernel.bindingContractDigest,
          repositoryId: assignment.checkout?.repositoryId ?? null,
          commitSha: setupCommit,
          setupState: "failed",
          setup: pendingSetup,
          resume: null,
          lastWakeId: assignment.wakeId,
        }
        yield* writeMarker(marker)
      }
    }

    if (assignment.checkout !== null) {
      if (assignment.checkout.private) {
        const credential = yield* acquireCredential("git-read")
        yield* startRefresh("git-read", credential)
      }
      const credential = yield* acquireCredential("github-read")
      yield* startRefresh("github-read", credential)
    }

    let setupHookDigest = yield* readHookDigest(root, "setup").pipe(
      Effect.mapError(() => archiveFailure("Workspace setup hook could not be verified")),
    )
    const cacheKey: SetupCacheKey | undefined =
      options.setupCache === undefined || assignment.checkout === null
        ? undefined
        : {
            ownerId: options.setupCache.ownerId,
            repository: {
              repositoryId: assignment.checkout.repositoryId,
              owner: assignment.checkout.owner,
              name: assignment.checkout.name,
              commitSha: assignment.checkout.commitSha,
            },
            setupHookDigest,
            templateBuildId: assignment.templateBuildId,
            environmentDigest: authorizedEnvironmentDigest,
          }
    let restoredCheckpointId: string | null = null
    let restoredCache = false
    if (options.restore !== undefined) {
      yield* restore(options.restore.archive)
      yield* verify(marker)
      restoredCheckpointId = options.restore.checkpointId
    } else if (cacheKey !== undefined && marker.setupState !== "completed" && !assignment.retry) {
      const cached = yield* options.setupCache!.load(cacheKey).pipe(Effect.catchCause(() => Effect.succeed(null)))
      if (cached !== null) {
        restoredCache = yield* restore(cached).pipe(
          Effect.andThen(verify(marker)),
          Effect.as(true),
          Effect.catch(() => resetCheckout(assignment.checkout!).pipe(Effect.as(false))),
        )
      }
    }

    if (restoredCheckpointId !== null || restoredCache) {
      setupHookDigest = yield* readHookDigest(root, "setup").pipe(
        Effect.mapError(() => archiveFailure("Restored setup hook could not be verified")),
      )
      const restoredAt = yield* Clock.currentTimeMillis
      marker = {
        ...marker,
        setupState: "completed",
        setup: {
          digest: setupHookDigest,
          commitSha: assignment.checkout?.commitSha ?? null,
          buildDigest,
          environmentDigest,
          startedAt: restoredAt,
          finishedAt: restoredAt,
          outcome: "completed",
        },
      }
      yield* writeMarker(marker)
    }

    if (marker.setupState !== "completed" || assignment.retry) {
      const setup = yield* hook(
        "setup",
        assignment.checkout?.commitSha ?? null,
        options.setupTimeout ?? 20 * 60 * 1_000,
      ).pipe(Effect.tapError(() => writeMarker({ ...marker, setupState: "failed" })))
      marker = { ...marker, setupState: "completed", setup }
      yield* writeMarker(marker)
      if (cacheKey !== undefined) {
        const archiveSecrets = new Set(options.secretValues ?? [])
        for (const secret of secrets) archiveSecrets.add(secret)
        yield* createArchive(root, archiveSecrets).pipe(
          Effect.map(encodeArchive),
          Effect.flatMap((archive) => options.setupCache!.store(cacheKey, archive)),
          Effect.ignoreCause,
        )
      }
    }

    if (
      restoredCheckpointId !== null ||
      restoredCache ||
      (assignment.cold && marker.lastWakeId !== assignment.wakeId)
    ) {
      const resume = yield* hook(
        "resume",
        assignment.checkout?.commitSha ?? null,
        options.resumeTimeout ?? 24 * 60 * 60 * 1_000,
        options.resumeBlockingWindow ?? 10_000,
      )
      marker = { ...marker, resume, lastWakeId: assignment.wakeId }
      yield* writeMarker(marker)
    }

    const available = yield* capabilities()
    const evidence: WorkspacePreparationEvidenceWire = {
      workspaceId: assignment.workspaceId,
      repositoryId: assignment.checkout?.repositoryId ?? null,
      commitSha: assignment.checkout?.commitSha ?? null,
      kernelProfileDigest: options.kernel.profileDigest,
      bindingContractDigest: options.kernel.bindingContractDigest,
      setup: marker.setup,
      resume: marker.resume,
      capabilities: available,
      lifecycle: {
        environmentDigest: authorizedEnvironmentDigest,
        templateBuildId: assignment.templateBuildId,
        setupHookDigest,
        restoredCheckpointId,
      },
    }
    return evidence
  })

export const prepare = Effect.fn("Workspace.prepare")(function* (options: Options) {
  return yield* make(options).pipe(
    Effect.mapError((error) =>
      Schema.is(WorkspaceError)(error)
        ? error
        : WorkspaceError.make({
            phase: "capabilities",
            message: "Workspace filesystem preparation failed",
            retryable: true,
          }),
    ),
  )
})

export const testing = { readOnlyGhWrapper } as const
