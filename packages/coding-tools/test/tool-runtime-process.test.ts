import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { provide } from "./test-layer"
import { bytesOf, TestEnvironment, workspace } from "./tool-runtime-test-environment"

describe("Runtime process tools", () => {
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

  it.effect("combines process output, reports exits, and bounds output", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const ok = yield* runtime.run({ _tag: "Bash", command: "ok" })
      const bad = yield* runtime.run({ _tag: "Bash", command: "bad" })
      const git = yield* runtime.run({ _tag: "Bash", command: "git --no-optional-locks status --short --branch" })
      const large = yield* runtime.run({ _tag: "Bash", command: "large" })
      const exact = yield* runtime.run({ _tag: "Bash", command: "exact-limit" })
      const multibyte = yield* runtime.run({ _tag: "Bash", command: "multibyte-limit" })
      const running = yield* runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 0 })
      const completed = yield* Effect.flip(
        runtime.run({ _tag: "ShellCommandStatus", processId: ok.processId ?? "", waitMillis: 0 }),
      )
      const failedStream = yield* runtime.run({ _tag: "Bash", command: "stream-failure" })
      const unicodeBoundary = yield* runtime.run({ _tag: "Bash", command: "unicode-boundary" })

      expect(ok).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 0 })
      expect(bad.text).toBe("outerr\nexit 7")
      expect(git.text).toBe("## main")
      expect(bytesOf(large.text)).toBe(16_384)
      expect(large.text).toContain("[truncated: kept first 16308 of 40001 bytes — page or narrow the command]")
      expect(large.text.startsWith("x".repeat(100))).toBe(true)
      expect(large.text.match(/\[truncated:/g)).toHaveLength(1)
      expect(large.truncated).toBe(true)
      expect(exact.text).toBe("x".repeat(16_384))
      expect(exact.truncated).toBe(false)
      expect(exact.text).not.toContain("[truncated:")
      expect(bytesOf(multibyte.text)).toBeLessThanOrEqual(16_384)
      expect(multibyte.text).toContain("of 18004 bytes")
      expect(multibyte.text).not.toContain("TAIL")
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(multibyte.text))).toBe(
        multibyte.text,
      )
      expect(multibyte.text.match(/\[truncated:/g)).toHaveLength(1)
      expect(multibyte.truncated).toBe(true)
      expect(running.running).toBe(true)
      expect(completed).toMatchObject({
        _tag: "ToolError",
        tool: "shell_command_status",
        category: "conflict",
        recovery: "never",
      })
      expect(completed.message).toContain("Process output already consumed")
      expect(failedStream).toMatchObject({ running: false, exitCode: 0, truncated: true })
      expect(bytesOf(unicodeBoundary.text)).toBe(16_384)
      expect(unicodeBoundary.text).toContain("of 40003 bytes")
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(unicodeBoundary.text))).toBe(
        unicodeBoundary.text,
      )
      expect(unicodeBoundary.text.match(/\[truncated:/g)).toHaveLength(1)
      expect(unicodeBoundary.truncated).toBe(true)
      expect(environment.commands.map(({ command, args, options }) => ({ command, args, cwd: options.cwd }))).toEqual([
        { command: "/bin/bash", args: ["-lc", "ok"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "bad"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "git --no-optional-locks status --short --branch"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "large"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "exact-limit"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "multibyte-limit"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "running"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "stream-failure"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "unicode-boundary"], cwd: workspace },
      ])
    }).pipe(provide(environment.runtime))
  })

  it.effect("preserves direct shell output without spending the output budget on duplicate channel fields", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const failed = yield* runtime.run({ _tag: "Shell", command: "bad", args: [] })
      const large = yield* runtime.run({ _tag: "Shell", command: "large", args: [] })

      expect(failed).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 7 })
      expect(failed).not.toHaveProperty("stdout")
      expect(failed).not.toHaveProperty("stderr")
      expect(bytesOf(large.text)).toBe(16_384)
      expect(large.text).toContain("kept first 16308 of 40001 bytes")
      expect(large.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("maps foreign filesystem and process errors to ToolError", () => {
    const environment = TestEnvironment.make()
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
      expect(read.message).not.toContain("Next action:")
      expect(shell).toMatchObject({ _tag: "ToolError", tool: "bash" })
      expect(shell).toMatchObject({ category: "access_denied", outcome: "unknown", recovery: "never" })
      expect(shell.message).toContain("The operating system denied access")
    }).pipe(provide(environment.runtime))
  })

  it.effect("times out unsafe process calls with an unknown outcome", () => {
    const environment = TestEnvironment.make()
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
      expect(failure.message).toContain("may have changed state")
    }).pipe(provide(environment.runtime))
  })

  it.effect("kills a process whose initial shell call is cancelled before returning its id", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 10_000 }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(call)
      expect(environment.killed).toEqual(["running"])
    }).pipe(provide(environment.runtime))
  })

  it.effect("refuses catastrophic commands without offering recovery", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const refused = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "rm -rf /" }))
      const allowed = yield* runtime.run({ _tag: "Bash", command: "rm -rf ./build" })
      expect(refused).toMatchObject({ category: "access_denied", outcome: "known", recovery: "never" })
      expect(allowed.text).toContain("out")
    }).pipe(provide(environment.runtime))
  })
})
