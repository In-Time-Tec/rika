import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Option, Path, PlatformError, Ref, Schema, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { MediaView, ProcessRegistry, ReadWebPage, Runtime, WebSearch } from "../src"
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

const testEnvironment = (
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
  const fileSystem = FileSystem.layerNoop({
    realPath: (path) => Effect.succeed(realPaths.get(path) ?? path),
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
      const executed = command.command === "/bin/bash" ? command.args[1] : command.command
      if (executed === "never-spawn") return Effect.never
      if (executed === "fail-spawn") return Effect.fail(platformError("spawn", executed))
      if (executed === "large")
        return Effect.succeed(processHandle({ stdout: "x".repeat(40_001), stderr: "", exitCode: 0 }))
      if (executed === "unicode-boundary")
        return Effect.succeed(processHandle({ stdout: `${"x".repeat(39_999)}🙂`, stderr: "", exitCode: 0 }))
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
    Layer.provide(Layer.merge(WebSearch.testLayer(search), ReadWebPage.testLayer(read))),
    Layer.provide(MediaView.analyzerTestLayer(() => Effect.succeed("analysis"))),
  )
  return { files, directories, commands, killed, runtime }
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

      expect(all.text).toBe(".hidden.txt\na.txt\nambiguous.txt\nsrc/deep/b.ts\nsrc/unreadable.ts\nsrc/z.ts")
      expect(filtered.text).toBe("src/deep/b.ts\nsrc/unreadable.ts\nsrc/z.ts")
      expect(literal.text).toBe(".hidden.txt:1:hidden needle\na.txt:2:needle\nsrc/deep/b.ts:2:needle")
      expect(regex.text).toBe("src/z.ts:1:alpha\nsrc/z.ts:2:alpha2")
    }).pipe(provide(environment.runtime))
  })

  it.effect("reads with default and maximum-clamped ranges while rejecting invalid values", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const defaults = yield* runtime.run({ _tag: "Read", path: "a.txt" })
      const negative = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [-4, 1] }))
      const reversed = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [2, 1] }))
      const fractional = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [1.5, 2] }))
      const selected = yield* runtime.run({ _tag: "Read", path: "a.txt", readRange: [2, 3] })

      expect(defaults.text).toBe("1: zero\n2: needle\n3: last")
      expect(negative).toMatchObject({ _tag: "ToolError", tool: "read" })
      expect(reversed).toMatchObject({ _tag: "ToolError", tool: "read" })
      expect(fractional).toMatchObject({ _tag: "ToolError", tool: "read" })
      expect(selected.text).toBe("2: needle\n3: last")
    }).pipe(provide(environment.runtime))
  })

  it.effect("rejects invalid regular expressions", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const error = yield* Effect.flip(runtime.run({ _tag: "Grep", pattern: "[", regex: true }))
      expect(error).toMatchObject({ _tag: "ToolError", tool: "grep" })
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds fallback discovery and grep to one thousand results", () => {
    const environment = testEnvironment()
    for (let index = 0; index < 1_005; index += 1) {
      const name = `file-${index.toString().padStart(4, "0")}.txt`
      environment.directories.get("/workspace")?.push(name)
      environment.files.set(`/workspace/${name}`, "match")
    }
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const found = yield* runtime.run({ _tag: "FindFiles", query: "file-" })
      const grep = yield* runtime.run({ _tag: "Grep", pattern: "match", regex: false })
      expect(found.text.split("\n")).toHaveLength(1_000)
      expect(grep.text.split("\n")).toHaveLength(1_000)
      expect(found.text).not.toContain("file-1000.txt")
      expect(grep.text).not.toContain("file-1000.txt")
    }).pipe(provide(environment.runtime))
  })

  it.effect("does not follow directory aliases into cycles or ignored directories", () => {
    const environment = testEnvironment(
      "success",
      undefined,
      undefined,
      new Map([
        ["/workspace/loop", "/workspace"],
        ["/workspace/dependency-alias", "/workspace/node_modules"],
      ]),
    )
    environment.directories.get("/workspace")?.push("loop", "dependency-alias")
    environment.directories.set("/workspace/node_modules", ["leaked.txt"])
    environment.files.set("/workspace/node_modules/leaked.txt", "leaked")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const found = yield* runtime.run({ _tag: "FindFiles", query: "leaked" })
      expect(found.text).toBe("")
    }).pipe(provide(environment.runtime))
  })

  it.effect("creates, overwrites, and edits files with Amp replacement semantics", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const created = yield* runtime.run({ _tag: "Write", path: "new/file.txt", content: "old" })
      const overwritten = yield* runtime.run({ _tag: "Write", path: "new/file.txt", content: "duplicate" })
      const edited = yield* runtime.run({ _tag: "Edit", path: "new/file.txt", oldStr: "duplicate", newStr: "new" })
      const stale = yield* Effect.flip(runtime.run({ _tag: "Edit", path: "new/file.txt", oldStr: "old", newStr: "x" }))
      const ambiguous = yield* Effect.flip(
        runtime.run({ _tag: "Edit", path: "ambiguous.txt", oldStr: "same", newStr: "x" }),
      )
      const replacedAll = yield* runtime.run({
        _tag: "Edit",
        path: "ambiguous.txt",
        oldStr: "same",
        newStr: "changed",
        replaceAll: true,
      })

      expect(created).toMatchObject({ text: "Successfully wrote 3 bytes to new/file.txt", truncated: false })
      expect(created.diff).toContain("+++ b/new/file.txt")
      expect(created.diff).toContain("+old")
      expect(overwritten.diff).toContain("-old")
      expect(overwritten.diff).toContain("+duplicate")
      expect(edited.text).toBe("Successfully replaced text in new/file.txt")
      expect(edited.diff).toContain("-duplicate")
      expect(edited.diff).toContain("+new")
      expect(environment.files.get("/workspace/new/file.txt")).toBe("new")
      expect(stale.message).toContain("old_str was not found")
      expect(ambiguous.message).toContain("old_str is not unique")
      expect(replacedAll.diff).toContain("+changed changed")
    }).pipe(provide(environment.runtime))
  })

  it.effect("enforces each tool output bound across text and diff fields", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "Write", path: "large.txt", content: "x".repeat(110_000) })
      expect(result.text.length + (result.diff?.length ?? 0)).toBe(4_000)
      expect(result.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("combines process output, reports exits, invokes git status, and bounds output", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const ok = yield* runtime.run({ _tag: "Bash", command: "ok" })
      const bad = yield* runtime.run({ _tag: "Bash", command: "bad" })
      const git = yield* runtime.run({ _tag: "GitStatus" })
      const large = yield* runtime.run({ _tag: "Bash", command: "large" })
      const running = yield* runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 0 })
      const completed = yield* Effect.flip(
        runtime.run({ _tag: "ShellCommandStatus", processId: ok.processId ?? "", waitMillis: 0 }),
      )
      const failedStream = yield* runtime.run({ _tag: "Bash", command: "stream-failure" })
      const unicodeBoundary = yield* runtime.run({ _tag: "Bash", command: "unicode-boundary" })

      expect(ok).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 0 })
      expect(bad.text).toBe("outerr\nexit 7")
      expect(git.text).toBe("## main")
      expect(large.text).toHaveLength(40_000)
      expect(large.truncated).toBe(true)
      expect(running.running).toBe(true)
      expect(completed).toMatchObject({ _tag: "ToolError", tool: "shell_command_status" })
      expect(failedStream).toMatchObject({ running: false, exitCode: 0, truncated: true })
      expect(unicodeBoundary).toMatchObject({ text: "x".repeat(39_999), truncated: true })
      expect(environment.commands.map(({ command, args, options }) => ({ command, args, cwd: options.cwd }))).toEqual([
        { command: "/bin/bash", args: ["-lc", "ok"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "bad"], cwd: workspace },
        { command: "git", args: ["--no-optional-locks", "status", "--short", "--branch"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "large"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "running"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "stream-failure"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "unicode-boundary"], cwd: workspace },
      ])
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection for a nonzero exit", () => {
    const environment = testEnvironment("nonzero")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* Effect.flip(runtime.run({ _tag: "GitStatus" }))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "git_status" })
      expect(result.message).toContain("fatal: not a git repository")
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection when Git is missing", () => {
    const environment = testEnvironment("missing")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* Effect.flip(runtime.run({ _tag: "GitStatus" }))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "git_status" })
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails Git inspection after its timeout", () => {
    const environment = testEnvironment("timeout")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const timeoutFiber = yield* Effect.forkChild(runtime.run({ _tag: "GitStatus" }))
      yield* TestClock.adjust("10 seconds")
      const result = yield* Effect.flip(Fiber.join(timeoutFiber))

      expect(result).toMatchObject({ _tag: "ToolError", tool: "git_status" })
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
      const read = yield* Effect.flip(runtime.run({ _tag: "Read", path: "missing.txt" }))
      const shell = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "fail-spawn" }))

      expect(read).toMatchObject({ _tag: "ToolError", tool: "read" })
      expect(read).toMatchObject({ kind: "operation", outcome: "known" })
      expect(read.message).toContain("foreign failure")
      expect(shell).toMatchObject({ _tag: "ToolError", tool: "bash" })
      expect(shell.message).toContain("foreign failure")
    }).pipe(provide(environment.runtime))
  })

  it.effect("times out unsafe process calls with an unknown outcome", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Bash", command: "never-spawn", timeoutMillis: 60_000 }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("120 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(failure).toMatchObject({
        _tag: "ToolError",
        tool: "bash",
        kind: "timeout",
        outcome: "unknown",
      })
    }).pipe(provide(environment.runtime))
  })

  it.effect("interrupts cancelled calls and releases call-scoped resources", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make(false)
      const environment = testEnvironment("success", () =>
        Effect.scoped(
          Effect.acquireRelease(Effect.void, () => Ref.set(released, true)).pipe(Effect.andThen(Effect.never)),
        ),
      )
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const call = yield* Effect.forkChild(
          runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(call)
        expect(yield* Ref.get(released)).toBe(true)
      }).pipe(provide(environment.runtime))
    }),
  )

  it.effect("kills a process whose initial shell call is cancelled before returning its id", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 10_000 }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(call)
      expect(environment.killed).toEqual(["running"])
    }).pipe(provide(environment.runtime))
  })

  it.effect("returns bounded provider-neutral web search outcomes", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({
        _tag: "WebSearch",
        objective: "Find current documentation",
        searchQueries: ["current documentation"],
      })
      expect(yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(result.text)).toEqual([
        {
          provider: "fixture",
          results: [{ url: "https://example.com", title: "Example", publishedAt: null, excerpts: ["result"] }],
        },
      ])
      expect(result.truncated).toBe(false)
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds search serialization and extracted page text at the runtime boundary", () => {
    const environment = testEnvironment(
      "success",
      () =>
        Effect.succeed([
          {
            provider: "fixture",
            results: [{ url: "https://example.com", title: null, publishedAt: null, excerpts: ["s".repeat(40_001)] }],
          },
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

  it.effect("routes status, web page, and media requests and rejects escaped paths", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
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
      const escaped = yield* Effect.flip(runtime.run({ _tag: "Read", path: "../outside" }))
      expect(status).toMatchObject({ _tag: "ToolError", tool: "shell_command_status" })
      expect(pageDefault.text).toBe("page")
      expect(pageOptions.text).toBe("page")
      expect(media.tool).toBe("view_media")
      expect(escaped.message).toContain("escapes workspace")
    }).pipe(provide(environment.runtime))
  })
})
