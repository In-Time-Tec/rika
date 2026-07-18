import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Option, Path, PlatformError, Schema, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { MediaView, ParallelSearch, ProcessRegistry, ReadWebPage, Runtime } from "../src"
import { provide } from "./test-layer"

const workspace = "/workspace"

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

const processHandle = ({ stdout, stderr, exitCode }: ProcessResult) => {
  const encoder = new TextEncoder()
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.make(encoder.encode(`${stdout}${stderr}`)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

const testEnvironment = (
  git: "success" | "nonzero" | "missing" | "timeout" | "large" = "success",
  search: ParallelSearch.Interface["search"] = () =>
    Effect.succeed([{ url: "https://example.com", title: "Example", publishDate: null, excerpts: ["result"] }]),
  read: ReadWebPage.Interface["read"] = () => Effect.succeed("page"),
) => {
  const files = new Map([
    ["/workspace/a.txt", "zero\nneedle\nlast"],
    ["/workspace/src/z.ts", "alpha\nalpha2"],
    ["/workspace/src/deep/b.ts", "beta\nneedle"],
    ["/workspace/src/unreadable.ts", "secret"],
    ["/workspace/.git/config", "ignored"],
    ["/workspace/node_modules/pkg/index.ts", "ignored"],
    ["/workspace/ambiguous.txt", "same same"],
  ])
  const directories = new Map<string, Array<string>>([
    ["/workspace", ["src", "a.txt", ".git", "node_modules", "socket", "ambiguous.txt"]],
    ["/workspace/src", ["z.ts", "deep", "unreadable.ts"]],
    ["/workspace/src/deep", ["b.ts"]],
  ])
  const commands: Array<ChildProcess.StandardCommand> = []
  const fileSystem = FileSystem.layerNoop({
    realPath: (path) => Effect.succeed(path),
    readDirectory: (path) => Effect.succeed(directories.get(path) ?? []),
    stat: (path) =>
      Effect.succeed(directories.has(path) ? info("Directory") : files.has(path) ? info("File") : info("Socket")),
    readFileString: (path) => {
      if (path === "/workspace/src/unreadable.ts") return Effect.fail(platformError("readFileString", path))
      const content = files.get(path)
      return content === undefined ? Effect.fail(platformError("readFileString", path)) : Effect.succeed(content)
    },
    exists: (path) => Effect.succeed(files.has(path)),
    makeDirectory: () => Effect.void,
    writeFileString: (path, content) => Effect.sync(() => void files.set(path, content)),
  })
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "PipedCommand") return Effect.fail(platformError("spawn", "pipeline"))
      commands.push(command)
      if (command.command === "fail-spawn") return Effect.fail(platformError("spawn", command.command))
      if (command.command === "large")
        return Effect.succeed(processHandle({ stdout: "x".repeat(40_001), stderr: "", exitCode: 0 }))
      if (command.command === "unicode-boundary")
        return Effect.succeed(processHandle({ stdout: `${"x".repeat(39_999)}🙂`, stderr: "", exitCode: 0 }))
      if (command.command === "running") {
        const handle = processHandle({ stdout: "x".repeat(40_001), stderr: "error", exitCode: 0 })
        return Effect.succeed({ ...handle, exitCode: Effect.never })
      }
      if (command.command === "stream-failure") {
        const handle = processHandle({ stdout: "", stderr: "", exitCode: 0 })
        return Effect.succeed({ ...handle, stdout: Stream.fail(platformError("stdout", command.command)) })
      }
      if (command.command === "bad") return Effect.succeed(processHandle({ stdout: "out", stderr: "err", exitCode: 7 }))
      if (command.command === "git") {
        if (git === "missing") return Effect.fail(platformError("spawn", command.command))
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
  const runtime = Runtime.layer(workspace).pipe(
    Layer.provide(dependencies),
    Layer.provide(Layer.merge(ParallelSearch.testLayer(search), ReadWebPage.testLayer(read))),
    Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
  )
  return { files, commands, runtime }
}

describe("Runtime", () => {
  it.effect("drains large streams while retaining only bounded text and complete UTF-8 characters", () => {
    const encoded = new TextEncoder().encode("🙂")
    const stream = Stream.concat(
      Stream.make(new Uint8Array(40_005).fill(120)),
      Stream.make(encoded.slice(0, 2), encoded.slice(2)),
    )
    return Effect.gen(function* () {
      const result = yield* ProcessRegistry.collectBoundedText(stream, 40_004)
      expect(result.text).toHaveLength(40_004)
      expect(result.text.endsWith("🙂")).toBe(false)
      expect(result.truncated).toBe(true)

      const unicode = yield* ProcessRegistry.collectBoundedText(Stream.make(encoded.slice(0, 2), encoded.slice(2)), 4)
      expect(unicode).toEqual({ text: "🙂", truncated: false })
      const truncatedUnicode = yield* ProcessRegistry.collectBoundedText(
        Stream.make(new TextEncoder().encode("x🙂")),
        2,
      )
      expect(truncatedUnicode).toEqual({ text: "x", truncated: true })
    })
  })

  it.effect("discovers recursively, skips ignored and other entries, and greps readable files", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const all = yield* runtime.run({ _tag: "FindFiles", query: "" })
      const filtered = yield* runtime.run({ _tag: "FindFiles", query: ".ts" })
      const literal = yield* runtime.run({ _tag: "Grep", pattern: "needle", regex: false })
      const regex = yield* runtime.run({ _tag: "Grep", pattern: "^alpha", regex: true })

      expect(all.text).toBe("a.txt\nambiguous.txt\nsrc/deep/b.ts\nsrc/unreadable.ts\nsrc/z.ts")
      expect(filtered.text).toBe("src/deep/b.ts\nsrc/unreadable.ts\nsrc/z.ts")
      expect(literal.text).toBe("a.txt:2:needle\nsrc/deep/b.ts:2:needle")
      expect(regex.text).toBe("src/z.ts:1:alpha\nsrc/z.ts:2:alpha2")
    }).pipe(provide(environment.runtime))
  })

  it.effect("reads with default and clamped ranges", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const defaults = yield* runtime.run({ _tag: "ReadFile", path: "a.txt" })
      const low = yield* runtime.run({ _tag: "ReadFile", path: "a.txt", offset: -4, limit: 0 })
      const high = yield* runtime.run({ _tag: "ReadFile", path: "a.txt", offset: 1, limit: 5_000 })

      expect(defaults.text).toBe("1: zero\n2: needle\n3: last")
      expect(low.text).toBe("1: zero")
      expect(high.text).toBe("2: needle\n3: last")
    }).pipe(provide(environment.runtime))
  })

  it.effect("creates and edits files while rejecting existing, stale, and ambiguous changes", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const created = yield* runtime.run({ _tag: "CreateFile", path: "new/file.txt", content: "old" })
      const existing = yield* Effect.flip(
        runtime.run({ _tag: "CreateFile", path: "new/file.txt", content: "duplicate" }),
      )
      const edited = yield* runtime.run({ _tag: "EditFile", path: "new/file.txt", oldText: "old", newText: "new" })
      const stale = yield* Effect.flip(
        runtime.run({ _tag: "EditFile", path: "new/file.txt", oldText: "old", newText: "x" }),
      )
      const ambiguous = yield* Effect.flip(
        runtime.run({ _tag: "EditFile", path: "ambiguous.txt", oldText: "same", newText: "x" }),
      )

      expect(created).toMatchObject({ text: "created new/file.txt", truncated: false })
      expect(created.diff).toContain("+++ b/new/file.txt")
      expect(created.diff).toContain("+old")
      expect(edited.text).toBe("edited new/file.txt")
      expect(edited.diff).toContain("-old")
      expect(edited.diff).toContain("+new")
      expect(environment.files.get("/workspace/new/file.txt")).toBe("new")
      expect(existing).toMatchObject({ _tag: "ToolError", tool: "CreateFile" })
      expect(existing.message).toContain("already exists")
      expect(stale.message).toContain("stale anchor")
      expect(ambiguous.message).toContain("ambiguous anchor")
    }).pipe(provide(environment.runtime))
  })

  it.effect("combines process output, reports exits, invokes git status, and bounds output", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const ok = yield* runtime.run({ _tag: "Shell", command: "ok", args: ["one"] })
      const bad = yield* runtime.run({ _tag: "Shell", command: "bad", args: [] })
      const git = yield* runtime.run({ _tag: "GitStatus" })
      const large = yield* runtime.run({ _tag: "Shell", command: "large", args: [] })
      const running = yield* runtime.run({ _tag: "Shell", command: "running", args: [], waitMillis: 0 })
      const completed = yield* Effect.flip(
        runtime.run({ _tag: "ShellCommandStatus", processId: ok.processId ?? "", waitMillis: 0 }),
      )
      const failedStream = yield* runtime.run({ _tag: "Shell", command: "stream-failure", args: [] })
      const unicodeBoundary = yield* runtime.run({ _tag: "Shell", command: "unicode-boundary", args: [] })

      expect(ok).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 0 })
      expect(bad.text).toBe("outerr\nexit 7")
      expect(git.text).toBe("## main")
      expect(large.text).toHaveLength(40_000)
      expect(large.truncated).toBe(true)
      expect(running.running).toBe(true)
      expect(completed).toMatchObject({ _tag: "ToolError", tool: "ShellCommandStatus" })
      expect(failedStream).toMatchObject({ running: false, exitCode: 0, truncated: true })
      expect(unicodeBoundary).toMatchObject({ text: "x".repeat(39_999), truncated: true })
      expect(environment.commands.map(({ command, args, options }) => ({ command, args, cwd: options.cwd }))).toEqual([
        { command: "ok", args: ["one"], cwd: workspace },
        { command: "bad", args: [], cwd: workspace },
        { command: "git", args: ["status", "--short", "--branch"], cwd: workspace },
        { command: "large", args: [], cwd: workspace },
        { command: "running", args: [], cwd: workspace },
        { command: "stream-failure", args: [], cwd: workspace },
        { command: "unicode-boundary", args: [], cwd: workspace },
      ])
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection for a nonzero exit", () => {
    const environment = testEnvironment("nonzero")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* Effect.flip(runtime.run({ _tag: "GitStatus" }))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "GitStatus" })
      expect(result.message).toContain("fatal: not a git repository")
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection when Git is missing", () => {
    const environment = testEnvironment("missing")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* Effect.flip(runtime.run({ _tag: "GitStatus" }))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "GitStatus" })
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection after its timeout", () => {
    const environment = testEnvironment("timeout")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const timeoutFiber = yield* Effect.forkChild(runtime.run({ _tag: "GitStatus" }))
      yield* TestClock.adjust("10 seconds")
      const result = yield* Effect.flip(Fiber.join(timeoutFiber))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "GitStatus" })
      expect(result.message).toContain("timed out")
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds Git inspection output to its catalog limit", () => {
    const environment = testEnvironment("large")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "GitStatus" })

      expect(result.text).toHaveLength(20_000)
      expect(result.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("maps foreign filesystem and process errors to ToolError", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const read = yield* Effect.flip(runtime.run({ _tag: "ReadFile", path: "missing.txt" }))
      const shell = yield* Effect.flip(runtime.run({ _tag: "Shell", command: "fail-spawn", args: [] }))

      expect(read).toMatchObject({ _tag: "ToolError", tool: "ReadFile" })
      expect(read.message).toContain("foreign failure")
      expect(shell).toMatchObject({ _tag: "ToolError", tool: "Shell" })
      expect(shell.message).toContain("foreign failure")
    }).pipe(provide(environment.runtime))
  })

  it.effect("returns bounded Parallel web search results", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({
        _tag: "WebSearch",
        objective: "Find current documentation",
        searchQueries: ["current documentation"],
      })
      expect(yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(result.text)).toEqual([
        { url: "https://example.com", title: "Example", publishDate: null, excerpts: ["result"] },
      ])
      expect(result.truncated).toBe(false)
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds search serialization and extracted page text at the runtime boundary", () => {
    const environment = testEnvironment(
      "success",
      () =>
        Effect.succeed([
          { url: "https://example.com", title: null, publishDate: null, excerpts: ["s".repeat(40_001)] },
        ]),
      () => Effect.succeed("p".repeat(40_001)),
    )
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const search = yield* runtime.run({
        _tag: "WebSearch",
        objective: "Find bounded text",
        searchQueries: ["bounded text"],
      })
      const page = yield* runtime.run({ _tag: "ReadWebPage", url: "https://example.com" })
      expect(search).toMatchObject({ truncated: true })
      expect(search.text).toHaveLength(40_000)
      expect(page).toEqual({ text: "p".repeat(40_000), truncated: true })
    }).pipe(provide(environment.runtime))
  })

  it.effect("routes patch, status, web page, and media requests and rejects escaped paths", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const patch = yield* runtime.run({
        _tag: "ApplyPatch",
        patchText: "*** Begin Patch\n*** Add File: patched.txt\n+value\n*** End Patch\n",
      })
      const status = yield* Effect.flip(
        runtime.run({ _tag: "ShellCommandStatus", processId: "missing", waitMillis: -1 }),
      )
      const pageDefault = yield* runtime.run({ _tag: "ReadWebPage", url: "https://example.com" })
      const pageOptions = yield* runtime.run({
        _tag: "ReadWebPage",
        url: "https://example.com",
        objective: "docs",
        fullContent: true,
        forceRefetch: true,
      })
      const media = yield* Effect.flip(runtime.run({ _tag: "ViewMedia", path: "missing.png" }))
      const escaped = yield* Effect.flip(runtime.run({ _tag: "ReadFile", path: "../outside" }))
      expect(patch.text).toBe("applied 1 operation")
      expect(status).toMatchObject({ _tag: "ToolError", tool: "ShellCommandStatus" })
      expect(pageDefault.text).toBe("page")
      expect(pageOptions.text).toBe("page")
      expect(media.tool).toBe("ViewMedia")
      expect(escaped.message).toContain("escapes workspace")
    }).pipe(provide(environment.runtime))
  })
})
