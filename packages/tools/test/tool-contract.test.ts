import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { Catalog, ParallelSearch, ProcessRegistry, Runtime } from "../src"
import { provide } from "./test-layer"

describe("tool contracts", () => {
  it("defines permission and output policies for every initial tool", () => {
    expect(Catalog.definitions.length).toBeGreaterThanOrEqual(9)
    expect(Catalog.get("read_file")?.permission).toBe("allow")
    expect(Catalog.get("edit_file")?.permission).toBe("allow")
    expect(Catalog.get("oracle")?.permission).toBe("allow")
    expect(Catalog.get("librarian")?.permission).toBe("allow")
    expect(Catalog.get("painter")?.permission).toBe("allow")
    expect(Catalog.get("task")?.permission).toBe("allow")
    expect(Catalog.get("missing")).toBeUndefined()
    expect(Catalog.definitions.every((definition) => definition.timeoutMillis > 0 && definition.outputLimit > 0)).toBe(
      true,
    )
  })

  it.effect("substitutes the runtime through its test layer", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({ _tag: "GitStatus" })
      expect(result).toEqual({ text: "fixture", truncated: false })
    }).pipe(provide(Runtime.testLayer(() => Effect.succeed({ text: "fixture", truncated: false })))),
  )

  it.effect("substitutes the process registry through its test layer", () =>
    Effect.gen(function* () {
      const registry = yield* ProcessRegistry.Service
      expect(yield* registry.start("command", [], "/workspace")).toBe("fixture")
    }).pipe(
      provide(
        ProcessRegistry.testLayer({
          start: () => Effect.succeed("fixture"),
          poll: () => Effect.die("unused"),
        }),
      ),
    ),
  )

  it.effect("describes web search queries as a homogeneous non-empty array", () =>
    Effect.gen(function* () {
      const schema = Tool.getJsonSchema(Runtime.webSearchTool)
      const searchQueries = (schema.properties as Record<string, unknown>).searchQueries
      expect(searchQueries).toEqual({
        type: "array",
        items: { type: "string" },
        allOf: [{ minItems: 1 }],
      })
      expect(searchQueries).not.toHaveProperty("prefixItems")
      expect(yield* Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)(["current docs"])).toEqual([
        "current docs",
      ])
      yield* Effect.flip(Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)([]))
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ParallelSearch.SearchQueries)({ 0: "current docs", __rest__: ["api"] }),
      )
    }),
  )

  it.effect("routes every model-facing toolkit handler through the runtime contract", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<Runtime.Request>>([])
      const runtimeLayer = Runtime.testLayer((request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as({ text: request._tag, truncated: false }),
        ),
      )
      yield* Effect.gen(function* () {
        const toolkit = yield* Runtime.toolkit
        yield* toolkit.handle("find_files", { query: "src" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("grep", { pattern: "needle", regex: false }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("read_file", { path: "a.ts", offset: 1, limit: 2 }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("read_file", { path: "b.ts" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("create_file", { path: "new.ts", content: "new" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit
          .handle("edit_file", { path: "a.ts", oldText: "old", newText: "new" })
          .pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("apply_patch", { patchText: "patch" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("shell", { command: "echo", args: ["ok"] }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit
          .handle("shell", { command: "echo", args: [], cwd: "src", waitMillis: 1 })
          .pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("shell_command_status", { processId: "1" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit
          .handle("shell_command_status", { processId: "1", waitMillis: 1 })
          .pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("git_status", {}).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit
          .handle("web_search", { objective: "Current docs", searchQueries: ["current docs"] })
          .pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("read_web_page", { url: "https://example.com" }).pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit
          .handle("read_web_page", {
            url: "https://example.com",
            objective: "docs",
            fullContent: true,
            forceRefetch: true,
          })
          .pipe(Effect.flatMap(Stream.runDrain))
        yield* toolkit.handle("view_media", { path: "image.png" }).pipe(Effect.flatMap(Stream.runDrain))
      }).pipe(provide(Runtime.handlerLayer.pipe(Layer.provide(runtimeLayer))))
      expect((yield* Ref.get(requests)).map((request) => request._tag)).toEqual([
        "FindFiles",
        "Grep",
        "ReadFile",
        "ReadFile",
        "CreateFile",
        "EditFile",
        "ApplyPatch",
        "Shell",
        "Shell",
        "ShellCommandStatus",
        "ShellCommandStatus",
        "GitStatus",
        "WebSearch",
        "ReadWebPage",
        "ReadWebPage",
        "ViewMedia",
      ])
    }),
  )
})
