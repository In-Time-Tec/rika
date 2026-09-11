import { Crypto, Effect, Encoding, FileSystem, Result, Schema } from "effect"
import {
  Archive,
  EncodedArchive,
  MaximumArchiveBytes,
  MaximumArchiveEntries,
  MaximumArchiveUncompressedBytes,
  WorkspaceArchiveError,
} from "./contract"
import { run, type CommandInput } from "./internal/process"
import { inspectLinks, replaceWorkspace } from "./internal/publication"
import { archiveCompression, inspectTar } from "./internal/tar"

const secretPattern = new RegExp(
  String.raw`(authorization\s*[:=]\s*(bearer|basic)\s+[a-z0-9._~+/=-]{12,}|(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,}["']?(?![a-z0-9._~+/=-]|\s*[<(])|\b(sk|ghp|github_pat)_[a-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)`,
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

interface TarExecutable {
  readonly command: "gtar" | "tar"
  readonly kind: "bsd" | "gnu"
}

const failure = (kind: WorkspaceArchiveError["kind"], message: string) => WorkspaceArchiveError.make({ kind, message })

const command = Effect.fn("WorkspaceInput.command")(function* (
  input: CommandInput,
  kind: WorkspaceArchiveError["kind"],
  message: string,
) {
  const result = yield* run(input).pipe(
    Effect.mapError((error) =>
      error.reason === "output"
        ? failure("size", "Workspace archive exceeds the allowed size")
        : failure(kind, message),
    ),
  )
  if (result.exitCode !== 0) return yield* failure(kind, message)
  return result.stdout
})

const tarExecutable = Effect.fn("WorkspaceInput.tarExecutable")(function* () {
  for (const candidate of ["gtar", "tar"] as const) {
    const version = yield* run({ command: [candidate, "--version"] }).pipe(Effect.option)
    if (version._tag === "None" || version.value.exitCode !== 0) continue
    const output = new TextDecoder().decode(version.value.stdout)
    if (output.includes("GNU tar")) return { command: candidate, kind: "gnu" } satisfies TarExecutable
    if (/bsdtar|libarchive/iu.test(output)) return { command: candidate, kind: "bsd" } satisfies TarExecutable
  }
  return yield* failure("archive", "Workspace archiving requires GNU tar or bsdtar")
})

const tarArguments = (arguments_: { readonly bsd: ReadonlyArray<string>; readonly gnu: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const executable = yield* tarExecutable()
    return [executable.command, ...(executable.kind === "gnu" ? arguments_.gnu : arguments_.bsd)]
  })

const compressionArguments = (bytes: Uint8Array) => {
  const compression = archiveCompression(bytes)
  if (compression === "gzip") return ["--gzip"]
  if (compression === "zstd") return ["--zstd"]
  return []
}

const digest = Effect.fn("WorkspaceInput.digest")(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto
  const value = yield* crypto
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => failure("archive", "Workspace archive digest could not be computed")))
  return `sha256:${Encoding.encodeHex(value)}`
})

const existingFiles = Effect.fn("WorkspaceInput.existingFiles")(function* (workspace: string, listed: Uint8Array) {
  const fileSystem = yield* FileSystem.FileSystem
  const encoder = new TextEncoder()
  const paths: Array<string> = []
  let contentBytes = 0
  for (const path of new TextDecoder().decode(listed).split("\0")) {
    if (path.length === 0) continue
    const exists = yield* fileSystem
      .exists(`${workspace}/${path}`)
      .pipe(Effect.mapError(() => failure("archive", "Workspace files could not be inspected")))
    if (exists) {
      const info = yield* fileSystem
        .stat(`${workspace}/${path}`)
        .pipe(Effect.mapError(() => failure("archive", "Workspace files could not be inspected")))
      if (info.type === "File") {
        const size = Number(info.size)
        if (!Number.isSafeInteger(size) || size > MaximumArchiveUncompressedBytes - contentBytes)
          return yield* failure("size", "Workspace archive expands beyond the allowed size")
        contentBytes += size
      }
      paths.push(path)
    }
    if (paths.length > MaximumArchiveEntries)
      return yield* failure("size", "Workspace archive contains too many entries")
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

const forbiddenListedPath = (path: string) => {
  const normalized = path.replace(/^\.\//u, "")
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

const inspectSecretFiles = Effect.fn("WorkspaceInput.inspectSecretFiles")(function* (
  directory: string,
  listed: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem
  for (const path of new TextDecoder().decode(listed).split("\0")) {
    if (path.length === 0 || forbiddenListedPath(path)) continue
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

const inspectGitSecretChanges = Effect.fn("WorkspaceInput.inspectGitSecretChanges")(function* (
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
    maximumStdoutBytes: MaximumArchiveUncompressedBytes,
  }).pipe(Effect.mapError(() => failure("archive", "Workspace changes could not be inspected")))
  const untracked = yield* run({
    command: ["git", "-C", workspace, "ls-files", "--others", "--exclude-standard", "-z", "--", "."],
    maximumStdoutBytes: MaximumArchiveBytes,
  }).pipe(Effect.mapError(() => failure("archive", "Workspace changes could not be inspected")))
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

const inspectSecretValues = Effect.fn("WorkspaceInput.inspectSecretValues")(function* (
  directory: string,
  values: ReadonlySet<string>,
) {
  if (values.size === 0) return
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem
    .realPath(directory)
    .pipe(Effect.mapError(() => failure("archive", "Workspace secret inspection failed")))
  const visited = new Set([root])
  const walk: (current: string) => Effect.Effect<void, WorkspaceArchiveError> = Effect.fn(
    "WorkspaceInput.inspectSecretValues.walk",
  )(function* (current: string) {
    const names = yield* fileSystem
      .readDirectory(current)
      .pipe(Effect.mapError(() => failure("archive", "Workspace secret inspection failed")))
    for (const name of names) {
      const path = `${current}/${name}`
      const info = yield* fileSystem
        .stat(path)
        .pipe(Effect.mapError(() => failure("archive", "Workspace secret inspection failed")))
      if (info.type === "Directory") {
        const resolved = yield* fileSystem
          .realPath(path)
          .pipe(Effect.mapError(() => failure("archive", "Workspace secret inspection failed")))
        if (!visited.has(resolved)) {
          visited.add(resolved)
          yield* walk(path)
        }
        continue
      }
      if (info.type !== "File") continue
      const content = new TextDecoder().decode(
        yield* fileSystem
          .readFile(path)
          .pipe(Effect.mapError(() => failure("archive", "Workspace secret inspection failed"))),
      )
      for (const value of values)
        if (value.length > 0 && content.includes(value))
          return yield* failure("secret", "Workspace contains authorized secret material")
    }
  })
  yield* walk(directory)
})

const withTemporaryDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const directory = yield* fileSystem
      .makeTempDirectory({ prefix: "rika-workspace-input-" })
      .pipe(Effect.mapError(() => failure("archive", "Could not create archive staging directory")))
    return yield* use(directory).pipe(
      Effect.ensuring(fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)),
    )
  })

const extractArchive = Effect.fn("WorkspaceInput.extractArchive")(function* (directory: string, bytes: Uint8Array) {
  yield* command(
    {
      command: yield* tarArguments({
        gnu: [
          ...compressionArguments(bytes),
          "--extract",
          "--file",
          "-",
          "--directory",
          directory,
          "--no-same-owner",
          "--no-same-permissions",
          "--delay-directory-restore",
        ],
        bsd: [
          "--extract",
          "--file",
          "-",
          "--directory",
          directory,
          "--no-same-owner",
          "--no-same-permissions",
          "--no-mac-metadata",
          "--no-xattrs",
        ],
      }),
      stdin: bytes,
    },
    "archive",
    "Workspace archive could not be extracted safely",
  )
})

export const inspectArchive = Effect.fn("WorkspaceInput.inspectArchive")(function* (
  input: Archive,
  secretValues: ReadonlySet<string> = new Set(),
) {
  const archive = yield* Schema.decodeEffect(Archive)(input).pipe(
    Effect.mapError(() => failure("archive", "Workspace archive descriptor is invalid")),
  )
  if (archive.sizeBytes !== archive.bytes.byteLength)
    return yield* failure("size", "Workspace archive byte length is invalid")
  if ((yield* digest(archive.bytes)) !== archive.contentDigest)
    return yield* failure("archive", "Workspace archive digest is invalid")
  yield* inspectTar(archive.bytes)
  yield* withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      yield* extractArchive(directory, archive.bytes)
      yield* inspectLinks(directory)
      yield* inspectSecretValues(directory, secretValues)
    }),
  )
  return archive
})

export const createArchive = Effect.fn("WorkspaceInput.createArchive")(function* (
  workspace: string,
  secretValues: ReadonlySet<string> = new Set(),
) {
  const gitFiles = yield* run({
    command: ["git", "-C", workspace, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    maximumStdoutBytes: MaximumArchiveBytes,
  }).pipe(Effect.mapError(() => failure("archive", "Workspace files could not be selected")))
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
    const listed = yield* run({
      command: arguments_,
      cwd: workspace,
      maximumStdoutBytes: MaximumArchiveBytes,
    }).pipe(Effect.mapError(() => failure("archive", "Workspace files could not be selected")))
    if (listed.exitCode > 1) return yield* failure("archive", "Workspace files could not be selected")
    files = yield* existingFiles(workspace, listed.stdout)
  }
  if (gitFiles.exitCode === 0) yield* inspectGitSecretChanges(workspace, files)
  else yield* inspectSecretFiles(workspace, files)
  const executable = yield* tarExecutable()
  const createArguments =
    executable.kind === "gnu"
      ? [
          "--use-compress-program=gzip -n",
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
          "--no-mac-metadata",
          "--no-xattrs",
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
            maximumStdoutBytes: MaximumArchiveBytes,
            stdin: files,
          },
          "archive",
          "Could not create Workspace archive",
        )
      : yield* withTemporaryDirectory((directory) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const path = `${directory}/workspace.tar.gz`
            yield* command(
              {
                command: [
                  executable.command,
                  ...createArguments.slice(0, 2),
                  "--file",
                  path,
                  ...createArguments.slice(2),
                ],
                stdin: files,
              },
              "archive",
              "Could not create Workspace archive",
            )
            const info = yield* fileSystem
              .stat(path)
              .pipe(Effect.mapError(() => failure("archive", "Could not inspect Workspace archive")))
            if (Number(info.size) > MaximumArchiveBytes)
              return yield* failure("size", "Workspace archive exceeds the allowed size")
            const staged = yield* fileSystem
              .readFile(path)
              .pipe(Effect.mapError(() => failure("archive", "Could not read Workspace archive")))
            if (archiveCompression(staged) !== "gzip")
              return yield* failure("archive", "Workspace archive compression is invalid")
            staged.fill(0, 4, 8)
            return staged
          }),
        )
  if (bytes.byteLength === 0 || bytes.byteLength > MaximumArchiveBytes)
    return yield* failure("size", "Workspace archive exceeds the allowed size")
  const archive = Archive.make({ bytes, contentDigest: yield* digest(bytes), sizeBytes: bytes.byteLength })
  return yield* inspectArchive(archive, secretValues)
})

export const encodeArchive = (archive: Archive): EncodedArchive =>
  EncodedArchive.make({
    content: Encoding.encodeBase64(archive.bytes),
    contentDigest: archive.contentDigest,
    sizeBytes: archive.sizeBytes,
  })

export const decodeArchive = Effect.fn("WorkspaceInput.decodeArchive")(function* (input: EncodedArchive) {
  const encoded = yield* Schema.decodeEffect(EncodedArchive)(input).pipe(
    Effect.mapError(() => failure("archive", "Workspace archive encoding descriptor is invalid")),
  )
  const bytes = yield* Result.match(Encoding.decodeBase64(encoded.content), {
    onFailure: () => Effect.fail(failure("archive", "Workspace archive encoding is invalid")),
    onSuccess: Effect.succeed,
  })
  return yield* inspectArchive(
    Archive.make({ bytes, contentDigest: encoded.contentDigest, sizeBytes: encoded.sizeBytes }),
  )
})

export const restoreArchive = Effect.fn("WorkspaceInput.restoreArchive")(function* (workspace: string, input: Archive) {
  const archive = yield* inspectArchive(input)
  yield* withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      yield* extractArchive(directory, archive.bytes)
      yield* inspectLinks(directory)
      yield* replaceWorkspace(workspace, directory)
    }),
  )
})
