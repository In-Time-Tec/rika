import { FileSystem, Effect } from "effect"
import {
  archiveCompression,
  command,
  digest,
  exclusionArguments,
  existingFiles,
  failure,
  inspectGitSecretChanges,
  inspectSecretFiles,
  run,
  tarExecutable,
} from "./archive"
import type { Archive } from "./archive"
import { MaximumArchiveBytes, inspectArchive } from "./archive"

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
