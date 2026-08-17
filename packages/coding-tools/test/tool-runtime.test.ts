import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { provide } from "./test-layer"
import { bytesOf, TestEnvironment } from "./tool-runtime-test-environment"

describe("Runtime workspace tools", () => {
  it.effect("reads with default and maximum-clamped ranges while rejecting invalid values", () => {
    const environment = TestEnvironment.make()
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
        expect(failure.message).not.toContain("Next action:")
      }
      expect(selected.text).toBe("2: needle\n3: last")
    }).pipe(provide(environment.runtime))
  })

  it.effect("fails a missing path without returning another file's content", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const failure = yield* Effect.flip(runtime.run({ _tag: "Read", path: "src/z" }))
      expect(failure).toMatchObject({
        _tag: "ToolError",
        tool: "read",
        category: "not_found",
        outcome: "known",
        recovery: "after_change",
      })
      expect(failure.message).toContain("File not found: src/z")
      expect(failure.message).toContain("Did you mean src/z.ts")
      expect(failure.message).not.toContain("alpha")
    }).pipe(provide(environment.runtime))
  })

  it.effect("reports a directory read as a directory instead of a generic failure", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const failure = yield* Effect.flip(runtime.run({ _tag: "Read", path: "src" }))
      expect(failure).toMatchObject({ _tag: "ToolError", tool: "read", category: "invalid_input" })
      expect(failure.message).toContain("src is a directory")
    }).pipe(provide(environment.runtime))
  })

  it.effect("lists an exact workspace directory and rejects files and casing guesses", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const listed = yield* runtime.run({ _tag: "List", path: "src", depth: 2 })
      const file = yield* Effect.flip(runtime.run({ _tag: "List", path: "a.txt" }))
      const wrongCase = yield* Effect.flip(runtime.run({ _tag: "List", path: "SRC" }))

      expect(listed).toMatchObject({
        entries: [
          { name: "deep", kind: "directory", entries: [{ name: "b.ts", kind: "file" }] },
          { name: "unreadable.ts", kind: "file" },
          { name: "z.ts", kind: "file" },
        ],
        truncated: false,
      })
      expect(listed.text).toContain("src/")
      expect(file).toMatchObject({ tool: "list", category: "invalid_input" })
      expect(file.message).toContain("Not a directory: a.txt")
      expect(wrongCase).toMatchObject({ tool: "list", category: "not_found" })
    }).pipe(provide(environment.runtime))
  })

  it.effect("returns partial grep matches with a deadline marker instead of an all-or-nothing timeout", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const partial = yield* runtime.run({ _tag: "Grep", pattern: "slow", regex: false })
      expect(partial.text).toContain("a.txt:2:needle")
      expect(partial.matches).toEqual([{ path: "a.txt", line: 2, text: "needle" }])
      expect(partial.text).toContain("stopped before the 10s tool timeout: 1 match found")
      expect(partial.text).not.toContain("9s")
      expect(partial.text).toContain("search greps file CONTENTS repo-wide")
      expect(partial.text).toContain("scope with path or use workspace.list")
      expect(partial.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("explains the repo-wide content search recovery after the outer timeout", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Grep", pattern: "never", regex: false }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(failure).toMatchObject({ tool: "grep", category: "timeout", outcome: "known" })
      expect(failure.nextAction).toContain("greps file CONTENTS repo-wide")
      expect(failure.nextAction).toContain("scope with path or use workspace.list")
    }).pipe(provide(environment.runtime))
  })

  it.effect("marks capacity-truncated grep output with its kept and total bytes", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "Grep", pattern: "large-grep", regex: false })
      const full = Array.from(
        { length: 800 },
        (_, index) => `src/file-${index}.ts:${index + 1}:HEAD-${"x".repeat(30)}-${index}`,
      ).join("\n")
      expect(result.truncated).toBe(true)
      expect(
        bytesOf(result.text) +
          result.matches!.reduce((total, match) => total + bytesOf(match.path) + bytesOf(match.text) + 16, 0),
      ).toBeLessThanOrEqual(16_384)
      expect(result.text.startsWith("src/file-0.ts:1:HEAD-")).toBe(true)
      expect(result.text).not.toContain("src/file-799.ts")
      expect(result.text).toContain(`of ${bytesOf(full)} bytes`)
      expect(result.text).toContain("narrow the pattern or scope with path")
      expect(result.text.match(/\[truncated:/g)).toHaveLength(1)
      expect(result.matches!.length).toBeGreaterThan(0)
      expect(result.matches!.length).toBeLessThan(800)
      expect(result.matchesTruncation).toEqual({ kept: result.matches!.length, total: 800 })
      expect(result.text).toContain(`structured matches truncated: kept ${result.matches!.length} of 800`)
      for (const [index, match] of result.matches!.entries())
        expect(match).toEqual({
          path: `src/file-${index}.ts`,
          line: index + 1,
          text: `HEAD-${"x".repeat(30)}-${index}`,
        })
    }).pipe(provide(environment.runtime))
  })

  it.effect("passes the grep path filter and deadline to the workspace index", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      yield* runtime.run({ _tag: "Grep", pattern: "needle", regex: false, path: "packages/x/**" })
      expect(environment.grepCalls.at(-1)).toMatchObject({
        query: "needle",
        options: { include: "packages/x/**", deadlineMillis: 9_000 },
      })
    }).pipe(provide(environment.runtime))
  })

  it.effect("names ripgrep when workspace search cannot spawn it", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const error = yield* Effect.flip(runtime.run({ _tag: "Grep", pattern: "missing-rg", regex: false }))
      expect(error).toMatchObject({
        _tag: "ToolError",
        tool: "grep",
        category: "operation",
        outcome: "known",
      })
      expect(error.message).toContain("ripgrep (rg) is not installed or not on PATH: ENOENT")
      expect(error.nextAction).toContain("ripgrep (rg) is installed")
    }).pipe(provide(environment.runtime))
  })

  it.effect("rejects invalid regular expressions", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const error = yield* Effect.flip(runtime.run({ _tag: "Grep", pattern: "[", regex: true }))
      expect(error).toMatchObject({ _tag: "ToolError", tool: "grep" })
      expect(error.message).toContain('The grep pattern "[" is not a valid regular expression')
      expect(error.message).toContain("SyntaxError")
    }).pipe(provide(environment.runtime))
  })

  it.effect("creates, overwrites, and edits files with Amp replacement semantics", () => {
    const environment = TestEnvironment.make()
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
      expect(stale.message).toContain("old_str was not found in the current file")
      expect(ambiguous).toMatchObject({ category: "conflict", outcome: "known", recovery: "after_change" })
      expect(ambiguous.message).toContain("old_str is not unique in the current file: 2 matches at lines 1")
      expect(replacedAll.diff).toContain("+changed changed")
    }).pipe(provide(environment.runtime))
  })

  it.effect("enforces each tool output bound across text and diff fields", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "Write", path: "large.txt", content: "x".repeat(110_000) })
      expect(bytesOf(result.text) + bytesOf(result.diff ?? "")).toBeLessThanOrEqual(4_000)
      expect(result.diff).toContain("[truncated: kept first")
      expect(result.diff).toContain("read a narrower file range")
      expect(result.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })
})
