import {
  Context,
  Effect,
  Encoding,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  type Duration,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createArchive, restoreArchive } from "./archive"
import { MaximumArchiveBytes, MaximumArchiveEntries, MaximumArchiveUncompressedBytes } from "./contract"
import { run } from "./internal/process"
import { inspectLinks } from "./internal/publication"
import { inspectRepositoryArchive, writeRepositorySnapshot } from "./internal/repository-snapshot"
import {
  RepositoryInput,
  RepositoryInputError,
  RepositoryInputFormat,
  RepositoryInputMetadata,
  type GitHubRepositorySource as GitHubRepositorySourceType,
  type RepositoryInputMetadata as RepositoryInputMetadataType,
} from "./repository-model"

export {
  GitHubRepositorySource,
  RepositoryCommitSha,
  RepositoryGitIdentity,
  RepositoryInput,
  RepositoryInputError,
  RepositoryInputFormat,
  RepositoryInputMetadata,
} from "./repository-model"
export type {
  GitHubRepositorySource as GitHubRepositorySourceType,
  RepositoryCommitSha as RepositoryCommitShaType,
  RepositoryGitIdentity as RepositoryGitIdentityType,
  RepositoryInput as RepositoryInputType,
  RepositoryInputMetadata as RepositoryInputMetadataType,
} from "./repository-model"

const inputRef = "refs/heads/rika-input"
const localCommandTimeout = "30 seconds"
const fetchFileLimitBlocks = String(MaximumArchiveBytes / 512)
const executablePath = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
const decoder = new TextDecoder()

interface GitConfigEntry {
  readonly key: string
  readonly value: string
}

interface TreeEntry {
  readonly mode: "100644" | "100755" | "120000"
  readonly path: string
  readonly size: number
}

export interface RepositoryTransportRequest {
  readonly commitSha: string
  readonly directory: string
  readonly source: GitHubRepositorySourceType
}

export interface RepositoryTransportContract {
  readonly fetch: (request: RepositoryTransportRequest) => Effect.Effect<void, RepositoryInputError>
}

export class RepositoryTransport extends Context.Service<RepositoryTransport, RepositoryTransportContract>()(
  "@rika/workspace-input/repository/RepositoryTransport",
) {}

export interface GitHubRepositoryTransportOptions {
  readonly token: Redacted.Redacted<string>
  readonly fetchTimeout?: Duration.Input
}

export interface CaptureRepositoryInputOptions {
  readonly metadata: unknown
}

export interface RestoreRepositoryInputOptions {
  readonly input: unknown
  readonly workspace: string
}

const failure = (kind: RepositoryInputError["kind"], message: string) => RepositoryInputError.make({ kind, message })
const isRepositoryInputError = Schema.is(RepositoryInputError)

const sourceUrl = (source: GitHubRepositorySourceType) => `https://github.com/${source.owner}/${source.name}.git`
const remoteUrl = (metadata: RepositoryInputMetadataType) => sourceUrl(metadata.source)

const baseGitConfig: ReadonlyArray<GitConfigEntry> = [
  { key: "credential.helper", value: "" },
  { key: "credential.interactive", value: "false" },
  { key: "core.hooksPath", value: "/dev/null" },
  { key: "fetch.fsckObjects", value: "true" },
  { key: "fetch.unpackLimit", value: "1" },
  { key: "gc.auto", value: "0" },
  { key: "maintenance.auto", value: "false" },
  { key: "protocol.ext.allow", value: "never" },
  { key: "protocol.file.allow", value: "never" },
  { key: "transfer.fsckObjects", value: "true" },
]

const gitEnvironment = (configuration: ReadonlyArray<GitConfigEntry> = baseGitConfig) => ({
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(configuration.length),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/dev/null",
  LC_ALL: "C",
  PATH: executablePath,
  SSH_ASKPASS: "/bin/false",
  XDG_CONFIG_HOME: "/dev/null",
  ...Object.fromEntries(
    configuration.flatMap((entry, index) => [
      [`GIT_CONFIG_KEY_${index}`, entry.key],
      [`GIT_CONFIG_VALUE_${index}`, entry.value],
    ]),
  ),
})

const parseTreeEntry = (record: string): TreeEntry | RepositoryInputError => {
  const tab = record.indexOf("\t")
  if (tab === -1) return failure("git", "Repository input tree is invalid")
  const header = /^([0-7]{6}) blob ([a-f0-9]{40}) +([0-9]+)$/.exec(record.slice(0, tab))
  const path = record.slice(tab + 1)
  if (header === null || path.length === 0 || path.length > 4_096 || path.includes("\uFFFD"))
    return failure("git", "Repository input tree is invalid")
  const parts = path.split("/")
  if (
    path.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    return failure("git", "Repository input tree contains an unsafe path")
  const mode = header[1]
  if (mode !== "100644" && mode !== "100755" && mode !== "120000")
    return failure("git", "Repository input tree contains an unsupported entry")
  const size = Number(header[3])
  if (!Number.isSafeInteger(size)) return failure("size", "Repository input expands beyond the allowed size")
  return { mode, path, size }
}

const runGit = Effect.fn("RepositoryInput.runGit")(function* (arguments_: ReadonlyArray<string>, message: string) {
  const result = yield* run({
    command: ["git", ...arguments_],
    environment: gitEnvironment(),
    extendEnvironment: false,
    forceKillAfter: "5 seconds",
    maximumStdoutBytes: MaximumArchiveBytes,
  }).pipe(
    Effect.timeout(localCommandTimeout),
    Effect.mapError(() => failure("git", message)),
  )
  if (result.exitCode !== 0) return yield* failure("git", message)
  return decoder.decode(result.stdout).trim()
})

const verifyTree = Effect.fn("RepositoryInput.verifyTree")(function* (
  gitDirectory: string,
  metadata: RepositoryInputMetadataType,
) {
  const output = yield* runGit(
    ["--git-dir", gitDirectory, "ls-tree", "-r", "-z", "--long", metadata.commitSha],
    "Repository input tree could not be inspected",
  )
  const paths = new Set<string>()
  const symlinks: Array<string> = []
  let totalBytes = 0
  for (const record of output.split("\0")) {
    if (record.length === 0) continue
    const entry = parseTreeEntry(record)
    if (isRepositoryInputError(entry)) return yield* entry
    if (paths.has(entry.path)) return yield* failure("git", "Repository input tree contains duplicate paths")
    if (paths.size >= MaximumArchiveEntries) return yield* failure("size", "Repository input contains too many files")
    if (entry.size > MaximumArchiveUncompressedBytes - totalBytes)
      return yield* failure("size", "Repository input expands beyond the allowed size")
    totalBytes += entry.size
    paths.add(entry.path)
    if (entry.mode === "120000") symlinks.push(entry.path)
  }
  return symlinks
})

const verifyRepository = Effect.fn("RepositoryInput.verifyRepository")(function* (
  gitDirectory: string,
  metadata: RepositoryInputMetadataType,
) {
  const head = yield* runGit(
    ["--git-dir", gitDirectory, "rev-parse", "--verify", "HEAD^{commit}"],
    "Repository input HEAD could not be verified",
  )
  const reference = yield* runGit(
    ["--git-dir", gitDirectory, "rev-parse", "--verify", `${inputRef}^{commit}`],
    "Repository input ref could not be verified",
  )
  if (head !== metadata.commitSha || reference !== metadata.commitSha)
    return yield* failure("git", "Repository input does not match the authorized commit")
  yield* runGit(
    ["--git-dir", gitDirectory, "cat-file", "-e", `${metadata.commitSha}^{commit}`],
    "Repository input commit is missing",
  )
  yield* runGit(
    ["--git-dir", gitDirectory, "fsck", "--strict", "--connectivity-only"],
    "Repository input object graph is invalid",
  )
  const history = yield* runGit(
    ["--git-dir", gitDirectory, "rev-list", "--max-count=2", "HEAD"],
    "Repository input history could not be verified",
  )
  if (history !== metadata.commitSha) return yield* failure("git", "Repository input is not a depth-one graph")
  const fileSystem = yield* FileSystem.FileSystem
  const shallow = yield* fileSystem
    .readFileString(`${gitDirectory}/shallow`)
    .pipe(Effect.mapError(() => failure("git", "Repository input shallow boundary is missing")))
  if (shallow !== `${metadata.commitSha}\n`)
    return yield* failure("git", "Repository input shallow boundary is invalid")
  return yield* verifyTree(gitDirectory, metadata)
})

export const layerGitHubRepositoryTransport = (
  options: GitHubRepositoryTransportOptions,
): Layer.Layer<RepositoryTransport, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    RepositoryTransport,
    Effect.gen(function* () {
      const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner
      const fetch: RepositoryTransportContract["fetch"] = Effect.fn("RepositoryTransport.fetch")(function* (request) {
        const token = Redacted.value(options.token)
        if (token.length === 0) return yield* failure("input", "Repository transport credential is invalid")
        const authorization = Encoding.encodeBase64(`x-access-token:${token}`)
        const configuration = [
          ...baseGitConfig,
          { key: "http.extraHeader", value: "" },
          { key: "http.followRedirects", value: "initial" },
          { key: "http.https://github.com/.extraHeader", value: `AUTHORIZATION: basic ${authorization}` },
        ]
        const result = yield* run({
          command: [
            "sh",
            "-c",
            'set -eu; ulimit -f "$1"; shift; exec "$@"',
            "rika-repository-fetch",
            fetchFileLimitBlocks,
            "git",
            "--git-dir",
            request.directory,
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--depth=1",
            "--no-recurse-submodules",
            sourceUrl(request.source),
            `${request.commitSha}:${inputRef}`,
          ],
          environment: gitEnvironment(configuration),
          extendEnvironment: false,
          forceKillAfter: "5 seconds",
          maximumStdoutBytes: MaximumArchiveBytes,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcesses),
          Effect.timeout(options.fetchTimeout ?? "2 minutes"),
          Effect.mapError(() => failure("git", "Repository fetch failed")),
        )
        if (result.exitCode !== 0) return yield* failure("git", "Repository fetch failed")
      })
      return RepositoryTransport.of({ fetch })
    }),
  )

export const captureRepositoryInput = Effect.fn("RepositoryInput.capture")(function* (
  options: CaptureRepositoryInputOptions,
) {
  const metadata = yield* Schema.decodeUnknownEffect(RepositoryInputMetadata)(options.metadata).pipe(
    Effect.mapError(() => failure("input", "Repository input metadata is invalid")),
  )
  const fileSystem = yield* FileSystem.FileSystem
  const transport = yield* RepositoryTransport
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "rika-repository-input-capture-" })
        .pipe(Effect.mapError(() => failure("archive", "Repository input staging could not be created")))
      const bare = `${directory}/source.git`
      const template = `${directory}/template`
      const content = `${directory}/content`
      const snapshot = `${content}/repository`
      yield* fileSystem
        .makeDirectory(template, { mode: 0o700 })
        .pipe(Effect.mapError(() => failure("archive", "Repository input staging could not be prepared")))
      yield* runGit(
        [
          "init",
          "--quiet",
          "--bare",
          "--object-format=sha1",
          "--initial-branch=rika-input",
          `--template=${template}`,
          bare,
        ],
        "Repository input bare repository could not be initialized",
      )
      yield* runGit(
        ["--git-dir", bare, "remote", "add", "origin", remoteUrl(metadata)],
        "Repository input remote could not be configured",
      )
      yield* transport.fetch({ commitSha: metadata.commitSha, directory: bare, source: metadata.source })
      yield* runGit(["--git-dir", bare, "symbolic-ref", "HEAD", inputRef], "Repository input HEAD could not be sealed")
      yield* verifyRepository(bare, metadata)
      yield* writeRepositorySnapshot(bare, snapshot, metadata)
      yield* verifyRepository(snapshot, metadata)
      const archive = yield* createArchive(content).pipe(
        Effect.mapError((error) =>
          failure(error.kind === "size" ? "size" : "archive", "Repository input archive could not be created"),
        ),
      )
      const sealed = `${directory}/sealed`
      yield* restoreArchive(sealed, archive).pipe(
        Effect.mapError((error) =>
          failure(error.kind === "size" ? "size" : "archive", "Repository input archive could not be sealed"),
        ),
      )
      yield* inspectRepositoryArchive(sealed, metadata)
      yield* verifyRepository(`${sealed}/repository`, metadata)
      return RepositoryInput.make({
        format: RepositoryInputFormat,
        metadata,
        archive,
      })
    }),
  )
})

const workspaceIsOccupied = Effect.fn("RepositoryInput.workspaceIsOccupied")(function* (workspace: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (Option.isSome(yield* fileSystem.readLink(workspace).pipe(Effect.option))) return true
  return yield* fileSystem
    .exists(workspace)
    .pipe(Effect.mapError(() => failure("workspace", "Repository workspace could not be inspected")))
})

const configureCheckout = Effect.fn("RepositoryInput.configureCheckout")(function* (
  checkout: string,
  metadata: RepositoryInputMetadataType,
) {
  const config = `${checkout}/.git/config`
  for (const [key, value] of [
    ["core.repositoryFormatVersion", "0"],
    ["core.fileMode", "true"],
    ["core.bare", "false"],
    ["core.logAllRefUpdates", "true"],
    ["remote.origin.url", remoteUrl(metadata)],
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ["user.name", metadata.gitIdentity.name],
    ["user.email", metadata.gitIdentity.email],
  ] as const)
    yield* runGit(["config", "--file", config, key, value], "Repository checkout configuration could not be created")
  const names = yield* runGit(
    ["config", "--file", config, "--name-only", "--get-regexp", ".*"],
    "Repository checkout configuration could not be verified",
  )
  const expected = [
    "core.bare",
    "core.filemode",
    "core.logallrefupdates",
    "core.repositoryformatversion",
    "remote.origin.fetch",
    "remote.origin.url",
    "user.email",
    "user.name",
  ]
  const actual = names.split("\n").toSorted()
  if (actual.length !== expected.length || !actual.every((name, index) => name === expected[index]))
    return yield* failure("git", "Repository checkout configuration is invalid")
})

const inspectCheckoutLinks = Effect.fn("RepositoryInput.inspectCheckoutLinks")(function* (
  checkout: string,
  symlinks: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const gitDirectory = yield* fileSystem
    .realPath(`${checkout}/.git`)
    .pipe(Effect.mapError(() => failure("git", "Repository checkout Git metadata is invalid")))
  for (const relative of symlinks) {
    const linkPath = `${checkout}/${relative}`
    const link = yield* fileSystem
      .readLink(linkPath)
      .pipe(Effect.mapError(() => failure("git", "Repository checkout link is invalid")))
    if (path.isAbsolute(link)) return yield* failure("git", "Repository checkout contains an absolute link")
    const resolved = yield* fileSystem
      .realPath(linkPath)
      .pipe(Effect.mapError(() => failure("git", "Repository checkout link is invalid")))
    if (resolved === gitDirectory || resolved.startsWith(`${gitDirectory}${path.sep}`))
      return yield* failure("git", "Repository checkout link targets Git metadata")
  }
})

const publishFreshWorkspace = Effect.fn("RepositoryInput.publishFreshWorkspace")(function* (
  checkout: string,
  workspace: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem
    .makeDirectory(workspace, { mode: 0o700 })
    .pipe(Effect.mapError(() => failure("workspace", "Repository workspace became occupied before publication")))
  yield* Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(checkout)
    for (const entry of entries) yield* fileSystem.rename(`${checkout}/${entry}`, `${workspace}/${entry}`)
  }).pipe(
    Effect.mapError(() => failure("workspace", "Repository checkout could not be published")),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : fileSystem.remove(workspace, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  )
})

export const restoreRepositoryInput = Effect.fn("RepositoryInput.restore")(function* (
  options: RestoreRepositoryInputOptions,
) {
  const input = yield* Schema.decodeUnknownEffect(RepositoryInput)(options.input).pipe(
    Effect.mapError(() => failure("input", "Repository input descriptor is invalid")),
  )
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const requestedWorkspace = path.resolve(options.workspace)
  const requestedParent = path.dirname(requestedWorkspace)
  const canonicalParent = yield* fileSystem
    .realPath(requestedParent)
    .pipe(Effect.mapError(() => failure("workspace", "Repository workspace parent is unavailable")))
  const workspace = path.join(canonicalParent, path.basename(requestedWorkspace))
  if (yield* workspaceIsOccupied(workspace))
    return yield* failure("workspace", "Repository input requires a fresh workspace")
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fileSystem
        .makeTempDirectoryScoped({ directory: canonicalParent, prefix: ".rika-repository-input-" })
        .pipe(Effect.mapError(() => failure("workspace", "Repository checkout staging could not be created")))
      const unpacked = `${directory}/unpacked`
      const checkout = `${directory}/checkout`
      yield* fileSystem
        .makeDirectory(unpacked, { mode: 0o700 })
        .pipe(Effect.mapError(() => failure("archive", "Repository input staging could not be prepared")))
      yield* restoreArchive(unpacked, input.archive).pipe(
        Effect.mapError((error) =>
          failure(error.kind === "size" ? "size" : "archive", "Repository input archive could not be restored"),
        ),
      )
      yield* inspectRepositoryArchive(unpacked, input.metadata)
      yield* verifyRepository(`${unpacked}/repository`, input.metadata)
      yield* fileSystem
        .makeDirectory(checkout, { mode: 0o700 })
        .pipe(Effect.mapError(() => failure("workspace", "Repository checkout staging could not be prepared")))
      yield* fileSystem
        .rename(`${unpacked}/repository`, `${checkout}/.git`)
        .pipe(Effect.mapError(() => failure("workspace", "Repository Git metadata could not be staged")))
      yield* configureCheckout(checkout, input.metadata)
      const symlinks = yield* verifyRepository(`${checkout}/.git`, input.metadata)
      yield* runGit(
        ["-C", checkout, "checkout", "--quiet", "--detach", "--force", input.metadata.commitSha],
        "Repository commit could not be checked out",
      )
      const head = yield* runGit(["-C", checkout, "rev-parse", "HEAD"], "Repository checkout could not be verified")
      const shallow = yield* runGit(
        ["-C", checkout, "rev-parse", "--is-shallow-repository"],
        "Repository checkout depth could not be verified",
      )
      if (head !== input.metadata.commitSha || shallow !== "true")
        return yield* failure("git", "Repository checkout does not match the authorized commit")
      yield* inspectLinks(checkout).pipe(
        Effect.mapError(() => failure("git", "Repository checkout contains an unsafe link")),
      )
      yield* inspectCheckoutLinks(checkout, symlinks)
      if (yield* workspaceIsOccupied(workspace))
        return yield* failure("workspace", "Repository workspace became occupied before publication")
      yield* publishFreshWorkspace(checkout, workspace)
    }),
  )
})
