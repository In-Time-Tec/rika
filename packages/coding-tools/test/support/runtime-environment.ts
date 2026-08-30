import { analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const workspace = "/workspace"
export const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength

const platformError = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "ToolRuntimeTest",
    method,
    description: "foreign failure",
    pathOrDescriptor: path,
  })

const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
})

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const processHandle = ({ stdout, stderr, exitCode }: ProcessResult, onKill: () => void = () => undefined) => {
  const encoder = new TextEncoder()
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(onKill),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.make(encoder.encode(`${stdout}${stderr}`)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

const make = (
  git: "success" | "nonzero" | "missing" | "timeout" | "large" = "success",
  search: WebSearch.Interface["search"] = () =>
    Effect.succeed([
      {
        provider: "fixture",
        results: [{ url: "https://example.com", title: "Example", publishedAt: null, excerpts: ["result"] }],
      },
    ]),
  read: ReadWebPage.Interface["read"] = () => Effect.succeed("page"),
  realPaths: ReadonlyMap<string, string> = new Map(),
) => {
  const files = new Map([
    ["/workspace/a.txt", "zero\nneedle\nlast"],
    ["/workspace/src/z.ts", "alpha\nalpha2"],
    ["/workspace/src/deep/b.ts", "beta\nneedle"],
    ["/workspace/src/unreadable.ts", "secret"],
    ["/workspace/.hidden.txt", "hidden needle"],
    ["/workspace/.git/config", "ignored"],
    ["/workspace/node_modules/pkg/index.ts", "ignored"],
    ["/workspace/ambiguous.txt", "same same"],
  ])
  const directories = new Map<string, Array<string>>([
    ["/workspace", ["src", "a.txt", ".hidden.txt", ".git", "node_modules", "socket", "ambiguous.txt"]],
    ["/workspace/src", ["z.ts", "deep", "unreadable.ts"]],
    ["/workspace/src/deep", ["b.ts"]],
  ])
  const commands: Array<ChildProcess.StandardCommand> = []
  const killed: Array<string> = []
  const grepCalls: Array<{ query: string; options: Parameters<WorkspaceIndex.Interface["grep"]>[1] }> = []
  const fileSystem = FileSystem.layerNoop({
    realPath: (path) => Effect.succeed(realPaths.get(path) ?? path),
    readDirectory: (path) => Effect.succeed(directories.get(path) ?? []),
    stat: (path) => {
      let type: FileSystem.File.Type = "Socket"
      if (directories.has(path)) type = "Directory"
      else if (files.has(path)) type = "File"
      return Effect.succeed(info(type))
    },
    readFileString: (path) => {
      if (path === "/workspace/src/unreadable.ts") return Effect.fail(platformError("readFileString", path))
      const content = files.get(path)
      return content === undefined ? Effect.fail(platformError("readFileString", path)) : Effect.succeed(content)
    },
    exists: (path) => Effect.succeed(files.has(path) || directories.has(path)),
    makeDirectory: () => Effect.void,
    writeFileString: (path, content) => Effect.sync(() => void files.set(path, content)),
  })
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "PipedCommand") return Effect.fail(platformError("spawn", "pipeline"))
      commands.push(command)
      const executed = command.command === "/bin/bash" ? command.args[1] : command.command
      if (executed === "never-spawn") return Effect.never
      if (executed === "fail-spawn") return Effect.fail(platformError("spawn", executed))
      const fixtureOutput = {
        large: "x".repeat(40_001),
        "exact-limit": "x".repeat(16_384),
        "multibyte-limit": `${"日".repeat(6_000)}TAIL`,
        "unicode-boundary": `${"x".repeat(39_999)}🙂`,
      } satisfies Readonly<Record<string, string>>
      const output = Object.entries(fixtureOutput).find(([name]) => name === executed)?.[1]
      if (output !== undefined) return Effect.succeed(processHandle({ stdout: output, stderr: "", exitCode: 0 }))
      if (executed === "running") {
        const handle = processHandle({ stdout: "x".repeat(40_001), stderr: "error", exitCode: 0 }, () =>
          killed.push(executed),
        )
        return Effect.succeed({ ...handle, exitCode: Effect.never })
      }
      if (executed === "stream-failure") {
        const handle = processHandle({ stdout: "", stderr: "", exitCode: 0 })
        return Effect.succeed({ ...handle, stdout: Stream.fail(platformError("stdout", executed)) })
      }
      if (executed === "bad") return Effect.succeed(processHandle({ stdout: "out", stderr: "err", exitCode: 7 }))
      if (executed === "git --no-optional-locks status --short --branch") {
        if (git === "missing") return Effect.fail(platformError("spawn", executed))
        if (git === "nonzero")
          return Effect.succeed(processHandle({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }))
        if (git === "timeout") {
          const handle = processHandle({ stdout: "", stderr: "", exitCode: 0 })
          return Effect.succeed({ ...handle, exitCode: Effect.never })
        }
        if (git === "large")
          return Effect.succeed(processHandle({ stdout: "x".repeat(20_001), stderr: "", exitCode: 0 }))
        return Effect.succeed(processHandle({ stdout: "## main", stderr: "", exitCode: 0 }))
      }
      return Effect.succeed(processHandle({ stdout: "out", stderr: "err", exitCode: 0 }))
    }),
  )
  const dependencies = Layer.mergeAll(fileSystem, Path.layer, spawner)
  const index = WorkspaceIndex.testLayer({
    fileSearch: (query) => {
      const items = Array.from(files.keys())
        .filter((file) => file.includes(query))
        .map((file) => {
          const relativePath = file.slice(`${workspace}/`.length)
          return {
            relativePath,
            fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
          }
        })
      return Effect.succeed({ items, scores: items.map(() => 1), totalMatched: items.length, totalFiles: files.size })
    },
    glob: () => Effect.succeed({ items: [], scores: [], totalMatched: 0, totalFiles: files.size }),
    grep: (query, options) => {
      grepCalls.push({ query, options })
      if (query === "never") return Effect.never
      if (query === "missing-rg")
        return WorkspaceIndex.WorkspaceIndexError.make({
          operation: "grep",
          message: "ripgrep (rg) is not installed or not on PATH: ENOENT",
        })
      if (query === "large-grep") {
        const items = Array.from({ length: 800 }, (_, itemIndex) => ({
          relativePath: `src/file-${itemIndex}.ts`,
          lineNumber: itemIndex + 1,
          lineContent: `HEAD-${"x".repeat(30)}-${itemIndex}`,
        }))
        return Effect.succeed({
          items,
          totalMatched: items.length,
          totalFilesSearched: items.length,
          totalFiles: files.size,
          filteredFileCount: items.length,
          nextCursor: null,
        })
      }
      if (query === "slow")
        return Effect.succeed({
          items: [{ relativePath: "a.txt", lineNumber: 2, lineContent: "needle" }],
          totalMatched: 1,
          totalFilesSearched: 1,
          totalFiles: files.size,
          filteredFileCount: 1,
          nextCursor: null,
          deadlineReached: true,
        })
      if (options?.mode === "regex") {
        try {
          RegExp(query)
        } catch (cause) {
          return Effect.succeed({
            items: [],
            totalMatched: 0,
            totalFilesSearched: 0,
            totalFiles: files.size,
            filteredFileCount: files.size,
            nextCursor: null,
            regexFallbackError: String(cause),
          })
        }
      }
      return Effect.succeed({
        items: [],
        totalMatched: 0,
        totalFilesSearched: files.size,
        totalFiles: files.size,
        filteredFileCount: files.size,
        nextCursor: null,
      })
    },
  })
  const runtime = Runtime.layerWithProcessRegistry(workspace, index).pipe(
    Layer.provide(ProcessRegistry.layer),
    Layer.provide(index),
    Layer.provide(dependencies),
    Layer.provide(Layer.merge(WebSearch.testLayer(search), ReadWebPage.testLayer(read))),
    Layer.provide(analyzerTestLayer(() => Effect.succeed("analysis"))),
  )
  return { files, directories, commands, killed, grepCalls, runtime }
}

export const TestEnvironment = { make }
