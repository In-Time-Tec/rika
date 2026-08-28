import { createHash } from "node:crypto"
import { Effect, Encoding, FileSystem, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const MaximumArchiveBytes = 64 * 1024 * 1024

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const CommitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/i))

export const RepositoryIdentity = Schema.Struct({
  repositoryId: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  commitSha: CommitSha,
})
export type RepositoryIdentity = typeof RepositoryIdentity.Type

export const SetupCacheKey = Schema.Struct({
  ownerId: Schema.NonEmptyString,
  repository: RepositoryIdentity,
  setupHookDigest: Sha256,
  workspaceSeedDigest: Schema.optionalKey(Sha256),
  templateBuildId: Schema.NonEmptyString,
  environmentDigest: Sha256,
})
export type SetupCacheKey = typeof SetupCacheKey.Type

export interface Archive {
  readonly bytes: Uint8Array
  readonly contentDigest: string
  readonly sizeBytes: number
}

export class WorkspaceArchiveError extends Schema.TaggedError<WorkspaceArchiveError>()("WorkspaceArchiveError", {
  kind: Schema.Literals(["archive", "hook", "secret", "size"]),
  message: Schema.String,
}) {}

const failure = (kind: WorkspaceArchiveError["kind"], message: string) => WorkspaceArchiveError.make({ kind, message })

const secretPattern = new RegExp(
  String.raw`(authorization\s*[:=]\s*(bearer|basic)\s+[a-z0-9._~+/=-]{12,}|(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,}["']?(?![a-z0-9._~+/=-]|\s*\()|\b(sk|ghp|github_pat)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)`,
  "iu",
)

const excluded = [
  ".git",
  ".agents/state",
  ".rika/secrets",
  ".env",
  ".env.*",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
]

const exclusionArguments = excluded.flatMap((path) => {
  if (path === ".env.*") return ["--exclude", ".env.*", "--exclude", "*/.env.*"]
  return ["--exclude", path, "--exclude", `${path}/**`, "--exclude", `*/${path}`, "--exclude", `*/${path}/**`]
})

const isForbiddenArchivePath = (path: string) => {
  const normalized = path.replace(/^\.\//, "")
  const parts = normalized.split("/")
  return (
    normalized.startsWith("/") ||
    parts.includes("..") ||
    parts.some((part) => part === ".git" || part === ".env" || part.startsWith(".env.")) ||
    parts.some(
      (part, index) =>
        (part === ".agents" && parts[index + 1] === "state") || (part === ".rika" && parts[index + 1] === "secrets"),
    ) ||
    [".git-credentials", ".netrc", ".npmrc", ".pypirc"].includes(parts.at(-1) ?? "")
  )
}

interface CommandResult {
  readonly stdout: Uint8Array
  readonly exitCode: number
}

interface TarExecutable {
  readonly command: "gtar" | "tar"
  readonly kind: "gnu" | "bsd"
}

const tarExecutable = Effect.fn("WorkspaceArchive.tarExecutable")(function* () {
  for (const candidate of ["gtar", "tar"] as const) {
    const version = yield* run({ command: [candidate, "--version"] }).pipe(Effect.option)
    if (version._tag === "None" || version.value.exitCode !== 0) continue
    const output = new TextDecoder().decode(version.value.stdout)
    if (output.includes("GNU tar")) return { command: candidate, kind: "gnu" } satisfies TarExecutable
    if (/bsdtar|libarchive/iu.test(output)) return { command: candidate, kind: "bsd" } satisfies TarExecutable
  }
  return yield* failure("archive", "Workspace archiving requires GNU tar or bsdtar")
})

const tarArguments = (arguments_: { readonly gnu: ReadonlyArray<string>; readonly bsd: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const executable = yield* tarExecutable()
    return [executable.command, ...(executable.kind === "gnu" ? arguments_.gnu : arguments_.bsd)]
  })

const run = (input: { readonly command: ReadonlyArray<string>; readonly cwd?: string; readonly stdin?: Uint8Array }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command =
        input.cwd === undefined
          ? ChildProcess.make(input.command[0]!, [...input.command.slice(1)], {
              stdin: input.stdin === undefined ? "ignore" : Stream.fromIterable([input.stdin]),
              stdout: "pipe",
              stderr: "pipe",
            })
          : ChildProcess.make(input.command[0]!, [...input.command.slice(1)], {
              cwd: input.cwd,
              stdin: input.stdin === undefined ? "ignore" : Stream.fromIterable([input.stdin]),
              stdout: "pipe",
              stderr: "pipe",
            })
      const child = yield* spawner
        .spawn(command)
        .pipe(Effect.mapError(() => failure("archive", "Workspace archive command could not start")))
      const [stdout, , exitCode] = yield* Effect.all(
        [
          Stream.runFold(
            child.stdout,
            () => new Uint8Array(),
            (accumulator, chunk) => {
              const output = new Uint8Array(accumulator.byteLength + chunk.byteLength)
              output.set(accumulator)
              output.set(chunk, accumulator.byteLength)
              return output
            },
          ),
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: 3 },
      ).pipe(Effect.mapError(() => failure("archive", "Workspace archive command did not complete")))
      return { stdout, exitCode: Number(exitCode) } satisfies CommandResult
    }),
  )

const command = Effect.fn("WorkspaceArchive.command")(function* (
  input: Parameters<typeof run>[0],
  kind: WorkspaceArchiveError["kind"],
  message: string,
) {
  const result = yield* run(input)
  if (result.exitCode !== 0) return yield* failure(kind, message)
  return result.stdout
})

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const archiveCompression = (bytes: Uint8Array): "gzip" | "zstd" | "none" => {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip"
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return "zstd"
  return "none"
}

const gnuCompressionArguments = (bytes: Uint8Array): ReadonlyArray<string> => {
  const compression = archiveCompression(bytes)
  if (compression === "gzip") return ["--gzip"]
  if (compression === "zstd") return ["--zstd"]
  return []
}

const existingFiles = Effect.fn("WorkspaceArchive.existingFiles")(function* (workspace: string, listed: Uint8Array) {
  const fileSystem = yield* FileSystem.FileSystem
  const encoder = new TextEncoder()
  const paths: Array<string> = []
  for (const path of new TextDecoder().decode(listed).split("\0")) {
    if (path.length === 0) continue
    const exists = yield* fileSystem
      .exists(`${workspace}/${path}`)
      .pipe(Effect.mapError(() => failure("archive", "Workspace files could not be inspected")))
    if (exists) paths.push(path)
  }
  const selected = paths.toSorted().map((path) => encoder.encode(`${path}\0`))
  const files = new Uint8Array(selected.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of selected) {
    files.set(value, offset)
    offset += value.byteLength
  }
  return files
})

const inspectSecretFiles = Effect.fn("WorkspaceArchive.inspectSecretFiles")(function* (
  directory: string,
  listed: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem
  for (const path of new TextDecoder().decode(listed).split("\0")) {
    if (path.length === 0 || isForbiddenArchivePath(path)) continue
    const file = `${directory}/${path}`
    const info = yield* fileSystem
      .stat(file)
      .pipe(Effect.mapError(() => failure("archive", "Workspace files could not be inspected")))
    if (info.type !== "File") continue
    const bytes = yield* fileSystem
      .readFile(file)
      .pipe(Effect.mapError(() => failure("archive", "Workspace files could not be inspected")))
    if (secretPattern.test(new TextDecoder().decode(bytes)))
      return yield* failure("secret", "Workspace changes contain credential material")
  }
})

const inspectGitSecretChanges = Effect.fn("WorkspaceArchive.inspectGitSecretChanges")(function* (
  workspace: string,
  files: Uint8Array,
) {
  const changed = yield* run({
    command: [
      "git",
      "-C",
      workspace,
      "diff",
      "--text",
      "--unified=0",
      "--no-ext-diff",
      "--no-color",
      "HEAD",
      "--",
      ".",
    ],
  })
  const untracked = yield* run({
    command: ["git", "-C", workspace, "ls-files", "--others", "--exclude-standard", "-z", "--", "."],
  })
  if (changed.exitCode !== 0 || untracked.exitCode !== 0) return yield* inspectSecretFiles(workspace, files)
  const additions = new TextDecoder()
    .decode(changed.stdout)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")
  if (secretPattern.test(additions)) return yield* failure("secret", "Workspace changes contain credential material")
  yield* inspectSecretFiles(workspace, yield* existingFiles(workspace, untracked.stdout))
})

const inspectSecretValues = Effect.fn("WorkspaceArchive.inspectSecretValues")(function* (
  directory: string,
  values: ReadonlySet<string>,
) {
  for (const value of values) {
    if (value.length === 0) continue
    const result = yield* run({
      command: [
        "rg",
        "--hidden",
        "--no-ignore",
        "--text",
        "--fixed-strings",
        "--files-with-matches",
        ...excluded.flatMap((path) => ["--glob", `!${path}/**`, "--glob", `!${path}`]),
        "--regexp",
        value,
        ".",
      ],
      cwd: directory,
    })
    if (result.exitCode === 0) return yield* failure("secret", "Workspace contains authorized secret material")
    if (result.exitCode > 1) return yield* failure("archive", "Workspace secret inspection failed")
  }
})

const safeArchiveEntries = Effect.fn("WorkspaceArchive.safeEntries")(function* (bytes: Uint8Array) {
  const tar = yield* tarArguments({
    gnu: [...gnuCompressionArguments(bytes), "--list", "--file", "-"],
    bsd: ["--list", "--file", "-"],
  })
  const output = yield* command({ command: tar, stdin: bytes }, "archive", "Workspace archive is invalid")
  const entries = new TextDecoder()
    .decode(output)
    .split("\n")
    .filter((entry) => entry.length > 0)
  if (entries.some(isForbiddenArchivePath))
    return yield* failure("archive", "Workspace archive contains a forbidden path")
})

const inspectLinks = Effect.fn("WorkspaceArchive.inspectLinks")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem
    .realPath(directory)
    .pipe(Effect.mapError(() => failure("archive", "Workspace filesystem operation failed")))
  const prefix = root.endsWith("/") ? root : `${root}/`
  const visited = new Set([root])
  const walk: (current: string) => Effect.Effect<void, WorkspaceArchiveError> = Effect.fn(
    "WorkspaceArchive.inspectLinks.walk",
  )(function* (current: string) {
    const names = yield* fileSystem
      .readDirectory(current)
      .pipe(Effect.mapError(() => failure("archive", "Workspace archive contains an invalid directory")))
    for (const name of names) {
      const path = `${current}/${name}`
      const resolved = yield* fileSystem
        .realPath(path)
        .pipe(Effect.mapError(() => failure("archive", "Workspace archive contains an invalid link")))
      if (resolved !== root && !resolved.startsWith(prefix))
        return yield* failure("archive", "Workspace archive link escapes the Workspace")
      const info = yield* fileSystem
        .stat(path)
        .pipe(Effect.mapError(() => failure("archive", "Workspace archive contains an invalid entry")))
      if (info.type !== "Directory" || visited.has(resolved)) continue
      visited.add(resolved)
      yield* walk(path)
    }
  })
  yield* walk(directory)
})

const withTemporaryDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const directory = yield* fileSystem
      .makeTempDirectory({ prefix: "rika-workspace-" })
      .pipe(Effect.mapError(() => failure("archive", "Could not create archive staging directory")))
    return yield* use(directory).pipe(
      Effect.ensuring(fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)),
    )
  })

export const createArchive = Effect.fn("WorkspaceArchive.create")(function* (
  workspace: string,
  secretValues: ReadonlySet<string> = new Set(),
) {
  const gitFiles = yield* run({
    command: ["git", "-C", workspace, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
  })
  let files: Uint8Array
  if (gitFiles.exitCode === 0) files = yield* existingFiles(workspace, gitFiles.stdout)
  else {
    const fileSystem = yield* FileSystem.FileSystem
    const ignoreFile = `${workspace}/.rikaignore`
    const arguments_ = ["rg", "--files", "--hidden", "--null"]
    if (
      yield* fileSystem
        .exists(ignoreFile)
        .pipe(Effect.mapError(() => failure("archive", "Workspace ignore rules could not be inspected")))
    )
      arguments_.push("--ignore-file", ignoreFile)
    const listed = yield* run({ command: arguments_, cwd: workspace })
    if (listed.exitCode > 1) return yield* failure("archive", "Workspace files could not be selected")
    files = listed.stdout
  }
  if (gitFiles.exitCode === 0) yield* inspectGitSecretChanges(workspace, files)
  else yield* inspectSecretFiles(workspace, files)
  const executable = yield* tarExecutable()
  const createArguments =
    executable.kind === "gnu"
      ? [
          "--zstd",
          "--create",
          "--file",
          "-",
          "--sort=name",
          "--mtime=@0",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "--directory",
          workspace,
          ...exclusionArguments,
          "--null",
          "--verbatim-files-from",
          "--files-from=-",
        ]
      : [
          "--gzip",
          "--create",
          "--uid",
          "0",
          "--gid",
          "0",
          "--uname",
          "root",
          "--gname",
          "root",
          "--directory",
          workspace,
          ...exclusionArguments,
          "--null",
          "--files-from=-",
        ]
  const bytes =
    executable.kind === "gnu"
      ? yield* command(
          {
            command: [executable.command, ...createArguments],
            stdin: files,
          },
          "archive",
          "Could not create Workspace archive",
        )
      : yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "rika-workspace-archive-" })
              .pipe(Effect.mapError(() => failure("archive", "Could not stage Workspace archive")))
            const archive = `${directory}/workspace.tar.gz`
            yield* command(
              {
                command: [
                  executable.command,
                  ...createArguments.slice(0, 2),
                  "--file",
                  archive,
                  ...createArguments.slice(2),
                ],
                stdin: files,
              },
              "archive",
              "Could not create Workspace archive",
            )
            const stagedBytes = yield* fileSystem
              .readFile(archive)
              .pipe(Effect.mapError(() => failure("archive", "Could not read Workspace archive")))
            if (archiveCompression(stagedBytes) !== "gzip")
              return yield* failure("archive", "Workspace archive compression is invalid")
            stagedBytes.fill(0, 4, 8)
            return stagedBytes
          }),
        )
  if (bytes.byteLength === 0 || bytes.byteLength > MaximumArchiveBytes)
    return yield* failure("size", "Workspace archive exceeds the allowed size")
  return yield* inspectArchive(
    { bytes, contentDigest: digest(bytes), sizeBytes: bytes.byteLength } satisfies Archive,
    secretValues,
  )
})

export const inspectArchive = Effect.fn("WorkspaceArchive.inspect")(function* (
  archive: Archive,
  secretValues: ReadonlySet<string> = new Set(),
) {
  if (
    archive.sizeBytes !== archive.bytes.byteLength ||
    archive.sizeBytes === 0 ||
    archive.sizeBytes > MaximumArchiveBytes
  )
    return yield* failure("size", "Workspace archive byte length is invalid")
  if (digest(archive.bytes) !== archive.contentDigest)
    return yield* failure("archive", "Workspace archive digest is invalid")
  yield* safeArchiveEntries(archive.bytes)
  yield* withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      yield* command(
        {
          command: yield* tarArguments({
            gnu: [
              ...gnuCompressionArguments(archive.bytes),
              "--extract",
              "--file",
              "-",
              "--directory",
              directory,
              "--no-same-owner",
              "--no-same-permissions",
            ],
            bsd: ["--extract", "--file", "-", "--directory", directory, "--no-same-owner", "--no-same-permissions"],
          }),
          stdin: archive.bytes,
        },
        "archive",
        "Workspace archive could not be extracted safely",
      )
      yield* inspectLinks(directory)
      yield* inspectSecretValues(directory, secretValues)
    }),
  )
  return archive
})

export const restoreArchive = Effect.fn("WorkspaceArchive.restore")(function* (
  workspace: string,
  archive: Archive,
  commandPrefix: ReadonlyArray<string> = [],
) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* inspectArchive(archive)
  yield* withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      yield* command(
        {
          command: yield* tarArguments({
            gnu: [
              ...gnuCompressionArguments(archive.bytes),
              "--extract",
              "--file",
              "-",
              "--directory",
              directory,
              "--no-same-owner",
              "--no-same-permissions",
            ],
            bsd: ["--extract", "--file", "-", "--directory", directory, "--no-same-owner", "--no-same-permissions"],
          }),
          stdin: archive.bytes,
        },
        "archive",
        "Workspace archive could not be restored",
      )
      yield* inspectLinks(directory)
      yield* fileSystem
        .chmod(directory, 0o755)
        .pipe(Effect.mapError(() => failure("archive", "Workspace archive staging permissions could not be prepared")))
      yield* command(
        { command: ["chmod", "-R", "a+rX", directory] },
        "archive",
        "Workspace archive staging permissions could not be prepared",
      )
      yield* command(
        {
          command: [
            ...commandPrefix,
            "bash",
            "-c",
            'find "$1" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} + && cp -a "$2"/. "$1"/',
            "rika-restore",
            workspace,
            directory,
          ],
        },
        "archive",
        "Workspace archive could not replace the Workspace",
      )
    }),
  )
})

export const hookDigest = Effect.fn("WorkspaceArchive.hookDigest")(function* (
  workspace: string,
  hook: "setup" | "resume",
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = `${workspace}/.agents/${hook}`
  const exists = yield* fileSystem
    .exists(path)
    .pipe(Effect.mapError(() => failure("hook", `Workspace ${hook} hook could not be inspected`)))
  const bytes = exists
    ? yield* fileSystem
        .readFile(path)
        .pipe(Effect.mapError(() => failure("hook", `Workspace ${hook} hook could not be read`)))
    : new Uint8Array()
  return digest(bytes)
})

export const encodeArchive = (archive: Archive) => ({
  content: Encoding.encodeBase64(archive.bytes),
  contentDigest: archive.contentDigest,
  sizeBytes: archive.sizeBytes,
})

export const decodeArchive = Effect.fn("WorkspaceArchive.decode")(function* (input: {
  readonly content: string
  readonly contentDigest: string
  readonly sizeBytes: number
}) {
  const bytes = yield* Result.match(Encoding.decodeBase64(input.content), {
    onFailure: () => Effect.fail(failure("archive", "Workspace archive encoding is invalid")),
    onSuccess: Effect.succeed,
  })
  return yield* inspectArchive({ bytes, contentDigest: input.contentDigest, sizeBytes: input.sizeBytes })
})
