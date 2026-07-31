import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Layer, Option, Path, PlatformError, Ref, Schema, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  MediaView,
  ProcessRegistry,
  ReadWebPage,
  Runtime,
  WebSearch,
  WorkspaceIndex,
} from "@rika/coding-tools/coding-tool-catalog"
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
  const runtime = Runtime.layerWithServices(workspace).pipe(
    Layer.provide(ProcessRegistry.layer),
    Layer.provide(index),
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
      for (const failure of [negative, reversed, fractional]) {
        expect(failure).toMatchObject({
          _tag: "ToolError",
          tool: "read",
          category: "invalid_input",
          outcome: "known",
          recovery: "after_change",
        })
        expect(failure.message).toContain("Next action:")
      }
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
      expect(stale).toMatchObject({ category: "conflict", outcome: "known", recovery: "after_change" })
      expect(stale.message).toContain("Reread new/file.txt")
      expect(ambiguous).toMatchObject({ category: "conflict", outcome: "known", recovery: "after_change" })
      expect(ambiguous.message).toContain("more surrounding context")
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

  it.effect("combines process output, reports exits, and bounds output", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const ok = yield* runtime.run({ _tag: "Bash", command: "ok" })
      const bad = yield* runtime.run({ _tag: "Bash", command: "bad" })
      const git = yield* runtime.run({ _tag: "Bash", command: "git --no-optional-locks status --short --branch" })
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
        { command: "/bin/bash", args: ["-lc", "git --no-optional-locks status --short --branch"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "large"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "running"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "stream-failure"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "unicode-boundary"], cwd: workspace },
      ])
    }).pipe(provide(environment.runtime))
  })

  it.effect("preserves direct shell output without spending the output budget on duplicate channel fields", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const failed = yield* runtime.run({ _tag: "Shell", command: "bad", args: [] })
      const large = yield* runtime.run({ _tag: "Shell", command: "large", args: [] })

      expect(failed).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 7 })
      expect(failed).not.toHaveProperty("stdout")
      expect(failed).not.toHaveProperty("stderr")
      expect(large.text).toBe("x".repeat(40_000))
      expect(large.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("maps foreign filesystem and process errors to ToolError", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const read = yield* Effect.flip(runtime.run({ _tag: "Read", path: "missing.txt" }))
      const shell = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "fail-spawn" }))

      expect(read).toMatchObject({ _tag: "ToolError", tool: "read" })
      expect(read).toMatchObject({
        kind: "operation",
        category: "not_found",
        outcome: "known",
        recovery: "after_change",
      })
      expect(read.message).toContain("File not found")
      expect(read.message).toContain("Search for the file")
      expect(shell).toMatchObject({ _tag: "ToolError", tool: "bash" })
      expect(shell).toMatchObject({ category: "access_denied", outcome: "unknown", recovery: "never" })
      expect(shell.message).toContain("Inspect the workspace and process state")
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
        category: "timeout",
        outcome: "unknown",
        recovery: "never",
      })
      expect(failure.message).toContain("after 120000ms")
      expect(failure.message).toContain("must not be repeated unchanged")
    }).pipe(provide(environment.runtime))
  })

  it.effect("times out safe calls with a known outcome and an actionable retry", () => {
    const environment = testEnvironment("success", () => Effect.never)
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(
        runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(failure).toMatchObject({
        category: "timeout",
        outcome: "known",
        recovery: "later",
      })
      expect(failure.message).toContain("after 30000ms")
      expect(failure.message).toContain("Retry once later")
    }).pipe(provide(environment.runtime))
  })

  it.effect("keeps a provider retry inside the original tool deadline", () => {
    let attempts = 0
    const search = WebSearch.make([
      {
        id: "fixture",
        priority: 1,
        capabilities: new Set<WebSearch.Capability>(["web"]),
        search: () => {
          attempts += 1
          return attempts === 1
            ? Effect.fail(WebSearch.ProviderFailure.make({ provider: "fixture", kind: "transport", message: "reset" }))
            : Effect.never
        },
      },
    ])
    const environment = testEnvironment("success", search.search)
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(
        runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(attempts).toBe(2)
      expect(failure).toMatchObject({ category: "timeout", outcome: "known", recovery: "later" })
      expect(failure.message).toContain("after 30000ms")
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

  it.effect("routes status, web page, and media requests and reads outside the workspace", () => {
    const environment = testEnvironment()
    environment.files.set("/outside", "outside content")
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
      const outside = yield* runtime.run({ _tag: "Read", path: "../outside" })
      expect(status).toMatchObject({ _tag: "ToolError", tool: "shell_command_status" })
      expect(pageDefault.text).toBe("page")
      expect(pageOptions.text).toBe("page")
      expect(media.tool).toBe("view_media")
      expect(outside.text).toContain("outside content")
    }).pipe(provide(environment.runtime))
  })

  it.effect("refuses catastrophic commands without offering recovery", () => {
    const environment = testEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const refused = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "rm -rf /" }))
      const allowed = yield* runtime.run({ _tag: "Bash", command: "rm -rf ./build" })
      expect(refused).toMatchObject({ category: "access_denied", outcome: "known", recovery: "never" })
      expect(allowed.text).toContain("out")
    }).pipe(provide(environment.runtime))
  })

  it.effect("classifies unavailable and rate-limited web dependencies with recovery guidance", () =>
    Effect.gen(function* () {
      const unavailable = testEnvironment("success", () =>
        Effect.fail(
          WebSearch.SelectionError.make({ message: "No configured web search provider supports 'web' searches" }),
        ),
      )
      const rateLimited = testEnvironment("success", () =>
        Effect.fail(
          WebSearch.ExecutionError.make({
            message: "All selected web search providers failed",
            outcomes: [
              {
                provider: "fixture",
                error: WebSearch.ProviderFailure.make({ provider: "fixture", kind: "rate-limit", message: "limited" }),
              },
            ],
          }),
        ),
      )
      const unconfiguredPage = testEnvironment(
        "success",
        () => Effect.succeed([]),
        () => Effect.fail(ReadWebPage.HttpError.make({ message: "PARALLEL_API_KEY is not configured" })),
      )
      const request = { _tag: "WebSearch" as const, objective: "docs", searchQueries: ["docs"] }
      const pageRequest = { _tag: "ReadWebPage" as const, url: "https://example.com" }
      const unavailableFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(request))
      }).pipe(provide(unavailable.runtime))
      const rateFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(request))
      }).pipe(provide(rateLimited.runtime))
      const pageFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(pageRequest))
      }).pipe(provide(unconfiguredPage.runtime))

      expect(unavailableFailure).toMatchObject({
        category: "dependency_unavailable",
        recovery: "after_change",
        outcome: "known",
      })
      expect(unavailableFailure.message).toContain("Configure a provider")
      expect(rateFailure).toMatchObject({ category: "rate_limited", recovery: "later", outcome: "known" })
      expect(rateFailure.message).toContain("Retry later")
      expect(pageFailure).toMatchObject({
        category: "dependency_unavailable",
        recovery: "after_change",
        outcome: "known",
      })
      expect(pageFailure.message).toContain("Configure PARALLEL_API_KEY")
    }),
  )
})
