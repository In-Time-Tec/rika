import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ProcessRegistry from "../../src/tool/process-registry"
import { bytesOf, makeEnvironment, provide, workspace } from "./support"

describe("native workspace runtime", () => {
  it.effect("reads bounded line ranges and rejects invalid ranges", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const defaults = yield* runtime.run({ _tag: "Read", path: "a.txt" })
      const selected = yield* runtime.run({ _tag: "Read", path: "a.txt", readRange: [2, 3] })
      const negative = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [-1, 1] }))
      const reversed = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [2, 1] }))
      const fractional = yield* Effect.flip(runtime.run({ _tag: "Read", path: "a.txt", readRange: [1.5, 2] }))

      expect(defaults.text).toBe("1: zero\n2: needle\n3: last")
      expect(selected.text).toBe("2: needle\n3: last")
      for (const failure of [negative, reversed, fractional])
        expect(failure).toMatchObject({
          _tag: "ToolError",
          tool: "read",
          category: "invalid_input",
          outcome: "known",
          recovery: "after_change",
        })
    }).pipe(provide(environment.runtime))
  })

  it.effect("preserves local path resolution authority and reports typed path failures", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const miscased = yield* runtime.run({ _tag: "Read", path: "SRC/Z.ts", readRange: [1, 1] })
      const outside = yield* runtime.run({ _tag: "Read", path: "../outside.txt" })
      const missing = yield* Effect.flip(runtime.run({ _tag: "Read", path: "src/missing.ts" }))
      const directory = yield* Effect.flip(runtime.run({ _tag: "Read", path: "src" }))

      expect(miscased.text).toBe("1: alpha")
      expect(outside.text).toBe("1: outside content")
      expect(missing).toMatchObject({ tool: "read", category: "not_found", outcome: "known" })
      expect(missing.message).toContain("File not found: src/missing.ts")
      expect(directory).toMatchObject({ tool: "read", category: "invalid_input" })
      expect(directory.message).toContain("src is a directory")
    }).pipe(provide(environment.runtime))
  })

  it.effect("applies exact edit rules, replace-all semantics, and unified diffs", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const edited = yield* runtime.run({ _tag: "Edit", path: "a.txt", oldStr: "needle", newStr: "changed" })
      const stale = yield* Effect.flip(runtime.run({ _tag: "Edit", path: "a.txt", oldStr: "needle", newStr: "again" }))
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
      const empty = yield* Effect.flip(runtime.run({ _tag: "Edit", path: "a.txt", oldStr: "", newStr: "x" }))
      const identical = yield* Effect.flip(runtime.run({ _tag: "Edit", path: "a.txt", oldStr: "zero", newStr: "zero" }))

      expect(edited.text).toBe("Successfully replaced text in a.txt")
      expect(edited.diff).toContain("-needle")
      expect(edited.diff).toContain("+changed")
      expect(environment.files.get("/workspace/a.txt")).toBe("zero\nchanged\nlast")
      expect(stale).toMatchObject({ category: "conflict", outcome: "known", recovery: "after_change" })
      expect(ambiguous.message).toContain("old_str is not unique in the current file: 2 matches at lines 1")
      expect(replacedAll.diff).toContain("+changed changed")
      expect(empty).toMatchObject({ category: "invalid_input", outcome: "known" })
      expect(identical).toMatchObject({ category: "invalid_input", outcome: "known" })
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds read and edit output across all returned fields", () => {
    const environment = makeEnvironment()
    environment.files.set("/workspace/large.txt", `head\n${"x".repeat(110_000)}`)
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const read = yield* runtime.run({ _tag: "Read", path: "large.txt" })
      const edit = yield* runtime.run({ _tag: "Edit", path: "large.txt", oldStr: "x", newStr: "y", replaceAll: true })

      expect(bytesOf(read.text)).toBeLessThanOrEqual(16_384)
      expect(read.text).toContain("[truncated: kept first")
      expect(read.truncated).toBe(true)
      expect(bytesOf(edit.text) + bytesOf(edit.diff ?? "")).toBeLessThanOrEqual(4_000)
      expect(edit.diff).toContain("[truncated: kept first")
      expect(edit.diff).toContain("read a narrower file range")
      expect(edit.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })
})

describe("native process runtime", () => {
  it.effect("drains bounded UTF-8 streams without retaining incomplete characters", () => {
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
      expect(yield* ProcessRegistry.collectBoundedText(Stream.make(encoded.slice(0, 2), encoded.slice(2)), 4)).toEqual({
        text: "🙂",
        truncated: false,
      })
      expect(yield* ProcessRegistry.collectBoundedText(Stream.make(new TextEncoder().encode("x🙂")), 2)).toEqual({
        text: "x",
        truncated: true,
      })
    })
  })

  it.effect("combines output, retains status ids, reports exits, and bounds UTF-8 output", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const ok = yield* runtime.run({ _tag: "Bash", command: "ok" })
      const bad = yield* runtime.run({ _tag: "Bash", command: "bad" })
      const large = yield* runtime.run({ _tag: "Bash", command: "large" })
      const exact = yield* runtime.run({ _tag: "Bash", command: "exact-limit" })
      const multibyte = yield* runtime.run({ _tag: "Bash", command: "multibyte-limit" })
      const running = yield* runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 0 })
      const repeated = yield* runtime.run({
        _tag: "ShellCommandStatus",
        processId: ok.processId ?? "",
        waitMillis: 0,
      })
      const failedStream = yield* runtime.run({ _tag: "Bash", command: "stream-failure" })
      const unicodeBoundary = yield* runtime.run({ _tag: "Bash", command: "unicode-boundary" })

      expect(ok).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 0 })
      expect(bad.text).toBe("outerr\nexit 7")
      expect(bytesOf(large.text)).toBe(16_384)
      expect(large.text).toContain("[truncated: kept first 16308 of 40001 bytes — page or narrow the command]")
      expect(large.truncated).toBe(true)
      expect(exact.text).toBe("x".repeat(16_384))
      expect(exact.truncated).toBe(false)
      expect(bytesOf(multibyte.text)).toBeLessThanOrEqual(16_384)
      expect(multibyte.text).toContain("of 18004 bytes")
      expect(multibyte.text).not.toContain("TAIL")
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(multibyte.text))).toBe(
        multibyte.text,
      )
      expect(running.processId).toBeDefined()
      expect(running.running).toBe(true)
      expect(repeated).toMatchObject({ text: "outerr", running: false, exitCode: 0, processId: ok.processId })
      expect(failedStream).toMatchObject({ running: false, exitCode: 0, truncated: true })
      expect(bytesOf(unicodeBoundary.text)).toBe(16_384)
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(unicodeBoundary.text))).toBe(
        unicodeBoundary.text,
      )
      expect(environment.commands.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
        { command: "/bin/bash", args: ["-lc", "ok"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "bad"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "large"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "exact-limit"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "multibyte-limit"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "running"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "stream-failure"], cwd: workspace },
        { command: "/bin/bash", args: ["-lc", "unicode-boundary"], cwd: workspace },
      ])
    }).pipe(provide(environment.runtime))
  })

  it.effect("supports the private recorded Shell request without advertising it", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const failed = yield* runtime.run({ _tag: "Shell", command: "bad", args: [] })
      const large = yield* runtime.run({ _tag: "Shell", command: "large", args: [] })
      expect(failed).toMatchObject({ text: "outerr", truncated: false, running: false, exitCode: 7 })
      expect(failed).not.toHaveProperty("stdout")
      expect(failed).not.toHaveProperty("stderr")
      expect(bytesOf(large.text)).toBe(16_384)
      expect(large.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("maps foreign failures and unknown process ids to typed ToolError", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const shell = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "fail-spawn" }))
      const status = yield* Effect.flip(runtime.run({ _tag: "ShellCommandStatus", processId: "missing" }))
      expect(shell).toMatchObject({
        _tag: "ToolError",
        tool: "bash",
        category: "access_denied",
        outcome: "unknown",
        recovery: "never",
      })
      expect(status).toMatchObject({
        _tag: "ToolError",
        tool: "shell_command_status",
        category: "not_found",
        outcome: "known",
        recovery: "after_change",
      })
    }).pipe(provide(environment.runtime))
  })

  it.effect("times out unsafe process calls with an unknown outcome", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
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

  it.effect("kills an initially-waiting process when the call is interrupted", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Bash", command: "running", timeoutMillis: 10_000 }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(call)
      expect(environment.killed).toEqual(["running"])
    }).pipe(provide(environment.runtime))
  })

  it.effect("refuses catastrophic commands without offering recovery", () => {
    const environment = makeEnvironment()
    return Effect.gen(function* () {
      const runtime = yield* ToolRuntime.Service
      const root = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "rm -rf /" }))
      const home = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "rm -rf $HOME" }))
      const allowed = yield* runtime.run({ _tag: "Bash", command: "rm -rf ./build" })
      expect(root).toMatchObject({ category: "access_denied", outcome: "known", recovery: "never" })
      expect(home).toMatchObject({ category: "access_denied", outcome: "known", recovery: "never" })
      expect(allowed.text).toContain("out")
    }).pipe(provide(environment.runtime))
  })
})
